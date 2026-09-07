-- ═══════════════════════════════════════════════════════════════
--  Oasis TimeMark — Supabase PostgreSQL Schema
--  Run this in your Supabase SQL Editor to set up all tables
-- ═══════════════════════════════════════════════════════════════

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ───────────────────────────────────────────────────────────────
-- TABLE: admins
-- ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admins (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  full_name     VARCHAR(255) NOT NULL,
  email         VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  is_active     BOOLEAN DEFAULT true,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

-- ───────────────────────────────────────────────────────────────
-- TABLE: students
-- ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS students (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  full_name           VARCHAR(255) NOT NULL,
  student_number      VARCHAR(100) UNIQUE NOT NULL,
  email               VARCHAR(255) UNIQUE NOT NULL,
  phone               VARCHAR(50),
  password_hash       VARCHAR(255),            -- NULL for students (they use Clock-In ID)
  clock_in_id         VARCHAR(20) UNIQUE NOT NULL,
  registered_ip       VARCHAR(100),
  registered_mac      VARCHAR(17),
  device_fingerprint  TEXT,
  device_address     TEXT,
  is_active           BOOLEAN DEFAULT true,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- ───────────────────────────────────────────────────────────────
-- TABLE: locations
-- ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS locations (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        VARCHAR(255) NOT NULL,
  address     TEXT,
  latitude    DECIMAL(10, 7),
  longitude   DECIMAL(10, 7),
  created_by  UUID REFERENCES admins(id),
  is_active   BOOLEAN DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ───────────────────────────────────────────────────────────────
-- TABLE: qr_codes
-- ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS qr_codes (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  location_id UUID REFERENCES locations(id),
  token       VARCHAR(255) UNIQUE NOT NULL,
  valid_date  DATE NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_by  UUID REFERENCES admins(id),
  is_active   BOOLEAN DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ───────────────────────────────────────────────────────────────
-- TABLE: attendance
-- ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS attendance (
  id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  student_id          UUID REFERENCES students(id) ON DELETE CASCADE,
  location_id         UUID REFERENCES locations(id),
  clock_in_time       TIMESTAMPTZ,
  clock_out_time      TIMESTAMPTZ,
  ip_address          VARCHAR(100),
  mac_address         VARCHAR(17),
  device_fingerprint  TEXT,
  latitude            DECIMAL(10, 7),
  longitude           DECIMAL(10, 7),
  location_accuracy   DECIMAL(10, 2),
  date                DATE NOT NULL,
  qr_used             BOOLEAN DEFAULT false,
  status              VARCHAR(20) DEFAULT 'present' CHECK (status IN ('present', 'late', 'absent')),
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- Safe upgrades for databases created from an older schema.
ALTER TABLE students ADD COLUMN IF NOT EXISTS registered_mac VARCHAR(17);
ALTER TABLE students ADD COLUMN IF NOT EXISTS device_address TEXT;
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS mac_address VARCHAR(17);
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS latitude DECIMAL(10, 7);
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS longitude DECIMAL(10, 7);
ALTER TABLE attendance ADD COLUMN IF NOT EXISTS location_accuracy DECIMAL(10, 2);

-- ───────────────────────────────────────────────────────────────
-- TABLE: working_days (admin configures which days are work days)
-- ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS working_days (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  day_of_week SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6), -- 0=Sun,1=Mon...6=Sat
  is_working  BOOLEAN DEFAULT true,
  UNIQUE(day_of_week)
);

-- Insert default working days (Mon–Fri)
INSERT INTO working_days (day_of_week, is_working) VALUES
  (0, false), -- Sunday
  (1, true),  -- Monday
  (2, true),  -- Tuesday
  (3, true),  -- Wednesday
  (4, true),  -- Thursday
  (5, true),  -- Friday
  (6, false)  -- Saturday
ON CONFLICT (day_of_week) DO NOTHING;

-- ───────────────────────────────────────────────────────────────
-- INDEXES for performance
-- ───────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_attendance_student_date ON attendance(student_id, date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_one_clock_in_per_day
  ON attendance(student_id, date) WHERE clock_in_time IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance(date);
CREATE INDEX IF NOT EXISTS idx_qr_codes_valid_date ON qr_codes(valid_date);
CREATE INDEX IF NOT EXISTS idx_students_clock_in_id ON students(clock_in_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_students_device_fingerprint
  ON students(device_fingerprint)
  WHERE device_fingerprint IS NOT NULL AND device_fingerprint <> '';

-- ───────────────────────────────────────────────────────────────
-- FUNCTION: auto-update updated_at on locations
-- ───────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql';

DROP TRIGGER IF EXISTS update_locations_updated_at ON locations;
CREATE TRIGGER update_locations_updated_at
  BEFORE UPDATE ON locations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ───────────────────────────────────────────────────────────────
-- ROW LEVEL SECURITY (RLS) — enable for production
-- ───────────────────────────────────────────────────────────────
-- We use service_role key on the backend, so RLS is bypassed server-side.
-- Enable RLS to prevent direct client DB access:
ALTER TABLE admins       ENABLE ROW LEVEL SECURITY;
ALTER TABLE students     ENABLE ROW LEVEL SECURITY;
ALTER TABLE locations    ENABLE ROW LEVEL SECURITY;
ALTER TABLE qr_codes     ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance   ENABLE ROW LEVEL SECURITY;
ALTER TABLE working_days ENABLE ROW LEVEL SECURITY;

-- Allow service_role full access (backend uses this)
-- All other access goes through our Express API only.
