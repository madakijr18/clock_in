const bcrypt = require('bcryptjs');
const supabase = require('../db/supabase');
const { signToken, generateClockInId } = require('../utils/tokenHelper');
const { getClientIP, getClientMAC } = require('../middleware/deviceCheck');

// ─────────────────────────────────────────────────────────────────
// POST /api/auth/register  — Student self-registration
// Captures IP + fingerprint at registration time.
// These become the permanent registered device for this student.
// ─────────────────────────────────────────────────────────────────
async function registerStudent(req, res) {
  try {
    const { full_name, student_number, email, phone, address, fingerprint } = req.body;

    // Password is no longer required for students — Clock-In ID IS their credential
    if (!full_name || !student_number || !email) {
      return res.status(400).json({ error: 'full_name, student_number, and email are required' });
    }

    // Check duplicates
    const { data: existing } = await supabase
      .from('students')
      .select('id')
      .or(`email.eq.${email},student_number.eq.${student_number}`)
      .limit(1);

    if (existing && existing.length > 0) {
      return res.status(409).json({ error: 'A student with this email or student number already exists' });
    }

    if (fingerprint) {
      const { data: registeredDevice, error: deviceError } = await supabase
        .from('students')
        .select('id, full_name')
        .eq('device_fingerprint', fingerprint)
        .limit(1)
        .maybeSingle();

      if (deviceError) {
        console.error('Device registration check error:', deviceError);
        return res.status(500).json({ error: 'Could not verify this device. Please try again.' });
      }
      if (registeredDevice) {
        return res.status(409).json({
          error: 'This device is already registered to a student. One device can only have one student account.',
          code: 'DEVICE_ALREADY_REGISTERED'
        });
      }
    }

    const clock_in_id  = generateClockInId();
    const clientIP     = getClientIP(req);
    const clientMAC    = getClientMAC(req);

    // We store an empty hash as placeholder — students don't use passwords
    // Use bcrypt hash of a random value so schema NOT NULL is satisfied
    // even if the ALTER TABLE hasn't been run yet
    const password_hash = await bcrypt.hash(clock_in_id + Date.now(), 10);

    const { data: student, error } = await supabase
      .from('students')
      .insert({
        full_name,
        student_number,
        email:              email.toLowerCase().trim(),
        phone:              phone || null,
        device_address:     address || null,
        password_hash,          // placeholder — never used for login
        clock_in_id,
        registered_ip:      clientIP,
        registered_mac:     clientMAC,
        device_fingerprint: fingerprint || null
      })
      .select('id, full_name, email, student_number, clock_in_id, device_address, created_at')
      .single();

    if (error) {
      console.error('Register error:', error);
      return res.status(500).json({ error: 'Registration failed. Please try again.' });
    }

    const token = signToken({ id: student.id, email: student.email, role: 'student' });

    return res.status(201).json({
      message: 'Registration successful! Your Clock-In ID is your login key. Keep it safe.',
      student: {
        id:             student.id,
        full_name:      student.full_name,
        email:          student.email,
        student_number: student.student_number,
        clock_in_id:    student.clock_in_id,
        device_address: student.device_address,
        created_at:     student.created_at,
        role:           'student'
      },
      token
    });
  } catch (err) {
    console.error('registerStudent error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// ─────────────────────────────────────────────────────────────────
// POST /api/auth/student/login  — Student login via Clock-In ID + device
//
// Students do NOT use a password. Their Clock-In ID is their identity.
// Their registered IP + browser fingerprint is their "password" —
// it proves they are on their own device.
//
// Flow:
//  1. Find student by clock_in_id
//  2. Validate device (IP and/or fingerprint)
//  3. If device matches (or not yet registered) → issue JWT
// ─────────────────────────────────────────────────────────────────
async function loginStudent(req, res) {
  try {
    const { fingerprint } = req.body;
    const clock_in_id = req.body.clock_in_id || req.body.tracking_id;
    const clientIP = getClientIP(req);
    const clientMAC = getClientMAC(req);

    if (!clock_in_id) {
      return res.status(400).json({ error: 'Tracking ID is required' });
    }
    if (req.body.password || req.body.username) {
      return res.status(400).json({ error: 'Students sign in with Tracking ID only — not username or password.' });
    }

    // 1. Find the student
    const { data: student, error } = await supabase
      .from('students')
      .select('id, full_name, email, student_number, clock_in_id, registered_ip, registered_mac, device_fingerprint, is_active, created_at')
      .eq('clock_in_id', clock_in_id.trim().toUpperCase())
      .single();

    if (error || !student) {
      return res.status(401).json({ error: 'This ID is not registered. Please check your Tracking ID and try again.' });
    }

    if (!student.is_active) {
      return res.status(403).json({ error: 'Your account has been deactivated. Contact your admin.' });
    }

    // 2. Device validation
    // If no device registered yet (brand-new account) → register this device now
    if (!student.registered_ip && !student.registered_mac && !student.device_fingerprint) {
      await supabase
        .from('students')
        .update({ registered_ip: clientIP, registered_mac: getClientMAC(req), device_fingerprint: fingerprint || null })
        .eq('id', student.id);

      console.log(`[Auth] First login for ${student.full_name} — device registered: IP=${clientIP}`);
    } else {
      // Strict device check in production
      if (process.env.NODE_ENV === 'production') {
        const ipMatch = student.registered_ip === clientIP;
        const macMatch = student.registered_mac && clientMAC
          ? student.registered_mac === clientMAC
          : false;
        const fpMatch = student.device_fingerprint && fingerprint
          ? student.device_fingerprint === fingerprint
          : false;
        const deviceMatch = student.registered_mac ? macMatch : ipMatch || fpMatch;

        if (!deviceMatch) {
          console.warn(`[Auth] BLOCKED login for ${student.full_name}: IP mismatch (got ${clientIP}, expected ${student.registered_ip})`);
          return res.status(403).json({
            error: 'This Tracking ID is registered to a different device. You must log in from your registered device.',
            code:  'DEVICE_MISMATCH'
          });
        }
      } else {
        // Dev mode — allow any device, just log it
        console.log(`[Auth] DEV login for ${student.full_name} from IP=${clientIP} (device check skipped)`);
      }
    }

    // 3. Issue token
    const token = signToken({ id: student.id, email: student.email, role: 'student' });

    return res.json({
      message: `Welcome back, ${student.full_name}!`,
      user: {
        id:             student.id,
        full_name:      student.full_name,
        email:          student.email,
        student_number: student.student_number,
        clock_in_id:    student.clock_in_id,
        role:           'student'
      },
      token
    });
  } catch (err) {
    console.error('loginStudent error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// ─────────────────────────────────────────────────────────────────
// POST /api/auth/admin/login  — Admin login (username + password only)
// Students cannot use this endpoint. Username may be the admin email.
// ─────────────────────────────────────────────────────────────────
async function loginAdmin(req, res) {
  try {
    const username = (req.body.username || req.body.email || '').trim();
    const { password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    // Tracking IDs belong to students — never treat them as admin usernames
    if (/^OT-/i.test(username)) {
      return res.status(401).json({ error: 'Admins must sign in with username and password, not a Tracking ID.' });
    }

    const lookup = username.toLowerCase();
    const { data: admin, error } = await supabase
      .from('admins')
      .select('id, full_name, email, password_hash, is_active')
      .eq('email', lookup)
      .single();

    if (error || !admin) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    if (!admin.is_active) {
      return res.status(403).json({ error: 'Your account has been deactivated.' });
    }

    const valid = await bcrypt.compare(password, admin.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const token = signToken({ id: admin.id, email: admin.email, role: 'admin' });
    const { password_hash, ...safeAdmin } = admin;

    return res.json({
      message: `Welcome back, ${admin.full_name}!`,
      user:    { ...safeAdmin, role: 'admin' },
      token
    });
  } catch (err) {
    console.error('loginAdmin error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// ─────────────────────────────────────────────────────────────────
// GET /api/auth/me  — Get current user info from JWT
// ─────────────────────────────────────────────────────────────────
async function getMe(req, res) {
  try {
    const { id, role } = req.user;
    const table = role === 'admin' ? 'admins' : 'students';
    const fields = role === 'admin'
      ? 'id, full_name, email, is_active, created_at'
      : 'id, full_name, email, student_number, clock_in_id, is_active, created_at';

    const { data: user, error } = await supabase
      .from(table).select(fields).eq('id', id).single();

    if (error || !user) return res.status(404).json({ error: 'User not found' });

    return res.json({ user: { ...user, role } });
  } catch (err) {
    console.error('getMe error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// ─────────────────────────────────────────────────────────────────
// POST /api/auth/admin/register  — Create admin (one-time setup)
// ─────────────────────────────────────────────────────────────────
async function registerAdmin(req, res) {
  try {
    const { full_name, email, password, setup_key } = req.body;

    if (setup_key !== process.env.ADMIN_SETUP_KEY) {
      return res.status(403).json({ error: 'Invalid setup key' });
    }
    if (!full_name || !email || !password) {
      return res.status(400).json({ error: 'full_name, email, and password are required' });
    }

    const { data: existing } = await supabase
      .from('admins').select('id').eq('email', email.toLowerCase().trim()).single();

    if (existing) {
      return res.status(409).json({ error: 'Admin with this email already exists' });
    }

    const password_hash = await bcrypt.hash(password, 12);

    const { data: admin, error } = await supabase
      .from('admins')
      .insert({ full_name, email: email.toLowerCase().trim(), password_hash })
      .select('id, full_name, email, created_at')
      .single();

    if (error) return res.status(500).json({ error: 'Failed to create admin' });

    const token = signToken({ id: admin.id, email: admin.email, role: 'admin' });
    return res.status(201).json({ message: 'Admin created successfully', admin, token });
  } catch (err) {
    console.error('registerAdmin error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = { registerStudent, loginStudent, loginAdmin, getMe, registerAdmin };
