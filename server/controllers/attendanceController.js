const supabase = require('../db/supabase');
const { getClientIP, getClientMAC } = require('../middleware/deviceCheck');

// ─────────────────────────────────────────────────────────────────
// POST /api/attendance/clock-in
// ─────────────────────────────────────────────────────────────────
async function clockIn(req, res) {
  try {
    const studentId = req.user.id;
    const { clock_in_id, qr_token, fingerprint, latitude, longitude, accuracy } = req.body;
    const clientIP = req.clientIP;
    const clientMAC = req.clientMAC;
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

    // 1. Verify clock_in_id matches the authenticated student
    const { data: student, error: studentErr } = await supabase
      .from('students')
      .select('id, full_name, clock_in_id')
      .eq('id', studentId)
      .single();

    if (studentErr || !student) {
      return res.status(404).json({ error: 'Student not found' });
    }

    if (student.clock_in_id !== clock_in_id) {
      return res.status(400).json({ error: 'Invalid Clock-In ID' });
    }

    // 2. Check for duplicate clock-in today (use maybeSingle to avoid error on 0 rows)
    const { data: existing, error: existingErr } = await supabase
      .from('attendance')
      .select('id, clock_in_time, clock_out_time')
      .eq('student_id', studentId)
      .eq('date', today)
      .maybeSingle();

    if (existingErr) {
      console.error('Duplicate check error:', existingErr);
      return res.status(500).json({ error: 'Failed to check existing attendance' });
    }

    if (existing && existing.clock_in_time) {
      return res.status(409).json({
        error: 'You have already clocked in today.',
        clock_in_time: existing.clock_in_time,
        code: 'ALREADY_CLOCKED_IN'
      });
    }

    // 3. Validate QR token if provided
    let locationId = null;
    if (qr_token) {
      const { data: qr, error: qrErr } = await supabase
        .from('qr_codes')
        .select('id, location_id, expires_at, is_active')
        .eq('token', qr_token)
        .eq('valid_date', today)
        .single();

      if (qrErr || !qr || !qr.is_active) {
        return res.status(400).json({ error: 'Invalid or expired QR code', code: 'INVALID_QR' });
      }

      if (new Date(qr.expires_at) < new Date()) {
        return res.status(400).json({ error: 'This QR code has expired', code: 'QR_EXPIRED' });
      }

      locationId = qr.location_id;
    } else {
      // Get the active location for today if no QR
      const { data: activeQR } = await supabase
        .from('qr_codes')
        .select('location_id')
        .eq('valid_date', today)
        .eq('is_active', true)
        .single();

      if (activeQR) locationId = activeQR.location_id;
    }

    // 4. Determine status (late if after 9:00 AM)
    const now = new Date();
    const cutoffHour = 9;
    const status = now.getHours() >= cutoffHour ? 'late' : 'present';

    // 5. Record attendance
    const { data: record, error: insertErr } = await supabase
      .from('attendance')
      .insert({
        student_id: studentId,
        location_id: locationId,
        clock_in_time: now.toISOString(),
        ip_address: clientIP,
        mac_address: clientMAC,
        device_fingerprint: fingerprint || null,
        latitude: Number.isFinite(latitude) ? latitude : null,
        longitude: Number.isFinite(longitude) ? longitude : null,
        location_accuracy: Number.isFinite(accuracy) ? accuracy : null,
        date: today,
        qr_used: !!qr_token,
        status
      })
      .select()
      .single();

    if (insertErr) {
      console.error('Clock-in insert error:', insertErr);
      return res.status(500).json({ error: 'Failed to record attendance' });
    }

    return res.status(201).json({
      message: `Clocked in successfully! Status: ${status}`,
      attendance: record
    });
  } catch (err) {
    console.error('clockIn error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// ─────────────────────────────────────────────────────────────────
// POST /api/attendance/clock-out
// ─────────────────────────────────────────────────────────────────
async function clockOut(req, res) {
  try {
    const studentId = req.user.id;
    const today = new Date().toISOString().split('T')[0];

    // Find today's attendance record (use maybeSingle to avoid error on 0 rows)
    const { data: record, error } = await supabase
      .from('attendance')
      .select('id, clock_in_time, clock_out_time')
      .eq('student_id', studentId)
      .eq('date', today)
      .maybeSingle();

    if (error) {
      console.error('clockOut fetch error:', error);
      return res.status(500).json({ error: 'Failed to fetch today\'s attendance' });
    }

    if (!record) {
      return res.status(404).json({ error: 'No clock-in found for today. Please clock in first.' });
    }

    if (record.clock_out_time) {
      return res.status(409).json({
        error: 'You have already clocked out today.',
        clock_out_time: record.clock_out_time
      });
    }

    const now = new Date().toISOString();

    const { data: updated, error: updateErr } = await supabase
      .from('attendance')
      .update({ clock_out_time: now })
      .eq('id', record.id)
      .select()
      .single();

    if (updateErr) {
      console.error('clockOut update error:', updateErr);
      return res.status(500).json({ error: 'Failed to record clock-out' });
    }

    // Calculate hours worked
    const duration = new Date(now) - new Date(record.clock_in_time);
    const hours = Math.floor(duration / 3600000);
    const minutes = Math.floor((duration % 3600000) / 60000);

    return res.json({
      message: `Clocked out successfully! You worked ${hours}h ${minutes}m today.`,
      attendance: updated
    });
  } catch (err) {
    console.error('clockOut error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// ─────────────────────────────────────────────────────────────────
// GET /api/attendance/my  — Student's own attendance history
// ─────────────────────────────────────────────────────────────────
async function getMyAttendance(req, res) {
  try {
    const studentId = req.user.id;
    const { month, year } = req.query;

    let query = supabase
      .from('attendance')
      .select(`
        id, date, clock_in_time, clock_out_time, status, qr_used,
        locations (name, address)
      `)
      .eq('student_id', studentId)
      .order('date', { ascending: false });

    if (month && year) {
      const start = `${year}-${String(month).padStart(2, '0')}-01`;
      const end = new Date(year, month, 0).toISOString().split('T')[0];
      query = query.gte('date', start).lte('date', end);
    }

    const { data, error } = await query;

    if (error) {
      return res.status(500).json({ error: 'Failed to fetch attendance' });
    }

    return res.json({ attendance: data || [] });
  } catch (err) {
    console.error('getMyAttendance error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// ─────────────────────────────────────────────────────────────────
// GET /api/attendance/today  — Admin: today's full attendance list
// ─────────────────────────────────────────────────────────────────
async function getTodayAttendance(req, res) {
  try {
    const today = new Date().toISOString().split('T')[0];

    const { data, error } = await supabase
      .from('attendance')
      .select(`
        id, date, clock_in_time, clock_out_time, status, qr_used, ip_address, mac_address, device_fingerprint, latitude, longitude, location_accuracy,
        students (id, full_name, student_number, clock_in_id),
        locations (name)
      `)
      .eq('date', today)
      .order('clock_in_time', { ascending: true });

    if (error) {
      return res.status(500).json({ error: 'Failed to fetch attendance' });
    }

    return res.json({ date: today, count: data.length, attendance: data || [] });
  } catch (err) {
    console.error('getTodayAttendance error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// ─────────────────────────────────────────────────────────────────
// GET /api/attendance/all  — Admin: all attendance with filters
// ─────────────────────────────────────────────────────────────────
async function getAllAttendance(req, res) {
  try {
    const { date, student_id, month, year, page = 1, limit = 50 } = req.query;
    const offset = (page - 1) * limit;

    let query = supabase
      .from('attendance')
      .select(`
        id, date, clock_in_time, clock_out_time, status, qr_used, ip_address, mac_address, device_fingerprint, latitude, longitude, location_accuracy,
        students (id, full_name, student_number, clock_in_id),
        locations (name)
      `, { count: 'exact' })
      .order('date', { ascending: false })
      .order('clock_in_time', { ascending: false })
      .range(offset, offset + limit - 1);

    if (date) query = query.eq('date', date);
    if (student_id) query = query.eq('student_id', student_id);
    if (month && year) {
      const start = `${year}-${String(month).padStart(2, '0')}-01`;
      const end = new Date(year, month, 0).toISOString().split('T')[0];
      query = query.gte('date', start).lte('date', end);
    }

    const { data, error, count } = await query;

    if (error) {
      return res.status(500).json({ error: 'Failed to fetch attendance' });
    }

    return res.json({ total: count, page: Number(page), limit: Number(limit), attendance: data || [] });
  } catch (err) {
    console.error('getAllAttendance error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// ─────────────────────────────────────────────────────────────────
// PATCH /api/attendance/:id  — Admin: override attendance record
// ─────────────────────────────────────────────────────────────────
async function overrideAttendance(req, res) {
  try {
    const { id } = req.params;
    const { clock_in_time, clock_out_time, status } = req.body;

    const updates = {};
    if (clock_in_time) updates.clock_in_time = clock_in_time;
    if (clock_out_time) updates.clock_out_time = clock_out_time;
    if (status) updates.status = status;

    const { data, error } = await supabase
      .from('attendance')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: 'Failed to update attendance record' });
    }

    return res.json({ message: 'Attendance record updated', attendance: data });
  } catch (err) {
    console.error('overrideAttendance error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// ─────────────────────────────────────────────────────────────────
// GET /api/attendance/stats/:studentId  — Attendance summary stats
// Correctly calculates absent days using the working_days config.
// ─────────────────────────────────────────────────────────────────
async function getStats(req, res) {
  try {
    const studentId = req.params.studentId || req.user.id;

    // Only admins can view other students' stats
    if (req.user.role !== 'admin' && studentId !== req.user.id) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // 1. Fetch all attendance records for this student
    const { data: records, error: attErr } = await supabase
      .from('attendance')
      .select('date, status, clock_in_time, clock_out_time')
      .eq('student_id', studentId)
      .order('date', { ascending: false });

    if (attErr) return res.status(500).json({ error: 'Failed to fetch stats' });

    // 2. Fetch working days config — fall back to Mon–Fri if table is empty
    const { data: workingDays } = await supabase
      .from('working_days')
      .select('day_of_week, is_working');

    // Default Mon–Fri (1–5) if the table has no rows
    const DEFAULT_WORKING_DAYS = new Set([1, 2, 3, 4, 5]);
    const workingDaySet = (workingDays && workingDays.length > 0)
      ? new Set(workingDays.filter(d => d.is_working).map(d => d.day_of_week))
      : DEFAULT_WORKING_DAYS;

    // 3. Calculate stats from attendance records
    const present    = records.filter(r => r.status === 'present').length;
    const late       = records.filter(r => r.status === 'late').length;
    const attendedDates = new Set(records.map(r => r.date));

    // 4. Count absent: every past working day since the student's first record
    //    that has no attendance entry.
    let absent = 0;
    if (records.length > 0) {
      const firstDate = new Date(records[records.length - 1].date + 'T00:00:00');
      const todayStr  = new Date().toISOString().split('T')[0];
      const cursor    = new Date(firstDate);

      while (true) {
        const dateStr = cursor.toISOString().split('T')[0];
        if (dateStr >= todayStr) break; // don't count today or future

        const dow = cursor.getDay(); // 0=Sun … 6=Sat
        if (workingDaySet.has(dow) && !attendedDates.has(dateStr)) {
          absent++;
        }
        cursor.setDate(cursor.getDate() + 1);
      }
    }

    // 5. Calculate current attendance streak (consecutive working days present/late)
    let streak = 0;
    {
      const today   = new Date();
      const cursor  = new Date(today);
      cursor.setDate(cursor.getDate() - 1); // start from yesterday

      // Walk backward through the last 365 days max
      for (let i = 0; i < 365; i++) {
        const dateStr = cursor.toISOString().split('T')[0];
        const dow     = cursor.getDay();

        if (!workingDaySet.has(dow)) {
          // Skip weekends/non-working days — don't break the streak
          cursor.setDate(cursor.getDate() - 1);
          continue;
        }

        if (attendedDates.has(dateStr)) {
          streak++;
        } else {
          break; // streak broken
        }

        cursor.setDate(cursor.getDate() - 1);
      }
    }

    return res.json({
      total_days: records.length,
      present,
      late,
      absent,
      streak,          // consecutive working days attended
      records
    });
  } catch (err) {
    console.error('getStats error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

// ─────────────────────────────────────────────────────────────────
// POST /api/attendance/punch  — No prior auth needed.
// Student submits clock_in_id + fingerprint.
// We authenticate, then clock-in or clock-out in one single request.
// Returns: { action: 'clocked_in'|'clocked_out', student, attendance, token }
// ─────────────────────────────────────────────────────────────────
async function clockPunch(req, res) {
  try {
    const { clock_in_id, fingerprint, qr_token, latitude, longitude, accuracy } = req.body;
    const clientIP = getClientIP(req);
    const clientMAC = getClientMAC(req);

    if (!clock_in_id) {
      return res.status(400).json({ error: 'Clock-In ID is required' });
    }

    // 1. Find student by clock_in_id
    const { data: student, error: studentErr } = await supabase
      .from('students')
      .select('id, full_name, email, student_number, clock_in_id, registered_ip, registered_mac, device_fingerprint, is_active')
      .eq('clock_in_id', clock_in_id.trim().toUpperCase())
      .single();

    if (studentErr || !student) {
      return res.status(401).json({ error: 'This ID is not registered. Please check your Tracking ID and try again.' });
    }
    if (!student.is_active) {
      return res.status(403).json({ error: 'Your account is deactivated. Contact admin.' });
    }

    // 2. Device check — register device on first punch, strict check in production
    if (!student.registered_ip && !student.registered_mac && !student.device_fingerprint) {
      // First time — bind this device
      await supabase.from('students')
        .update({ registered_ip: clientIP, registered_mac: clientMAC, device_fingerprint: fingerprint || null })
        .eq('id', student.id);
    } else {
      const ipMatch = student.registered_ip === clientIP;
      const macMatch = student.registered_mac && clientMAC
        ? student.registered_mac === clientMAC
        : false;
      const fpMatch = student.device_fingerprint && fingerprint
        ? student.device_fingerprint === fingerprint : false;
      const deviceMatch = student.registered_mac ? macMatch : ipMatch || fpMatch;
      if (!deviceMatch) {
        return res.status(403).json({
          error: 'This device is already registered to another student. Log in from the registered device.',
          code: 'DEVICE_ALREADY_REGISTERED'
        });
      }
    }

    // 3. Issue a short-lived token so we can return it to the client
    const { signToken } = require('../utils/tokenHelper');
    const token = signToken({ id: student.id, email: student.email, role: 'student' });

    const today = new Date().toISOString().split('T')[0];

    // 4. Check today's attendance
    const { data: existing } = await supabase
      .from('attendance')
      .select('id, clock_in_time, clock_out_time, status, location_id')
      .eq('student_id', student.id)
      .eq('date', today)
      .maybeSingle();

    // 5. Decide: clock-in or clock-out
    if (!existing || !existing.clock_in_time) {
      // ── CLOCK IN ──
      let locationId = null;
      if (qr_token) {
        const { data: qr } = await supabase
          .from('qr_codes')
          .select('location_id, expires_at, is_active')
          .eq('token', qr_token)
          .eq('valid_date', today)
          .single();
        if (qr?.is_active && new Date(qr.expires_at) > new Date()) locationId = qr.location_id;
      } else {
        const { data: activeQR } = await supabase
          .from('qr_codes').select('location_id')
          .eq('valid_date', today).eq('is_active', true).maybeSingle();
        if (activeQR) locationId = activeQR.location_id;
      }

      const now    = new Date();
      const status = now.getHours() >= 9 ? 'late' : 'present';

      const { data: record, error: insertErr } = await supabase
        .from('attendance')
        .insert({
          student_id: student.id, location_id: locationId,
          clock_in_time:  now.toISOString(),
          clock_out_time: now.toISOString(), // auto clock-out at same time as clock-in
          ip_address: clientIP,
          mac_address: clientMAC,
          device_fingerprint: fingerprint || null,
          latitude: Number.isFinite(latitude) ? latitude : null,
          longitude: Number.isFinite(longitude) ? longitude : null,
          location_accuracy: Number.isFinite(accuracy) ? accuracy : null,
          date: today, qr_used: !!qr_token, status
        })
        .select('*, locations(name)').single();

      if (insertErr) {
        console.error('clockPunch insert error:', insertErr);
        return res.status(500).json({ error: 'Failed to record clock-in' });
      }

      return res.status(201).json({
        action: 'clocked_in',
        message: `Attendance recorded for ${student.full_name}. Status: ${status}`,
        student: { id: student.id, full_name: student.full_name, clock_in_id: student.clock_in_id, role: 'student' },
        attendance: record,
        token
      });

    } else if (!existing.clock_out_time) {
      // ── CLOCK OUT (manual, legacy path) ──
      const now      = new Date().toISOString();
      const { data: updated, error: updateErr } = await supabase
        .from('attendance')
        .update({ clock_out_time: now })
        .eq('id', existing.id)
        .select('*, locations(name)').single();

      if (updateErr) {
        console.error('clockPunch clock-out error:', updateErr);
        return res.status(500).json({ error: 'Failed to record clock-out' });
      }

      const ms   = new Date(now) - new Date(existing.clock_in_time);
      const hrs  = Math.floor(ms / 3600000);
      const mins = Math.floor((ms % 3600000) / 60000);

      return res.json({
        action: 'clocked_out',
        message: `Clocked out! You worked ${hrs}h ${mins}m today.`,
        student: { id: student.id, full_name: student.full_name, clock_in_id: student.clock_in_id, role: 'student' },
        attendance: updated,
        token
      });

    } else {
      // Already clocked in and out
      const ci = new Date(existing.clock_in_time).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
      const co = new Date(existing.clock_out_time).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
      return res.status(409).json({
        action: 'already_complete',
        error: `You have already completed attendance today (${ci} → ${co}).`,
        code: 'ALREADY_COMPLETE',
        attendance: existing,
        token
      });
    }

  } catch (err) {
    console.error('clockPunch error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = {
  clockIn,
  clockOut,
  clockPunch,
  getMyAttendance,
  getTodayAttendance,
  getAllAttendance,
  overrideAttendance,
  getStats
};
