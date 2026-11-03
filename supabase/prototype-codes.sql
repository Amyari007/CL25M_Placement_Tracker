-- =====================================================================
-- DEMO ACCESS CODES - for local development and tests only.
-- These are made-up values, not the codes used by any real deployment.
-- In a real deployment, issue random codes from
-- Admin -> Settings -> Student access codes.
-- Run once in the Supabase SQL editor (server side). Codes are stored
-- only as bcrypt hashes; this file never ships to the browser.
-- =====================================================================
select public.set_student_code(s.id, c.code, true)
  from public.students s
  join (values
    ('CL25M001', '3732'), ('CL25M002', '4176'), ('CL25M003', '4328'),
    ('CL25M004', '4335'), ('CL25M005', '4590'), ('CL25M006', '8077'),
    ('CL25M007', '8041'), ('CL25M008', '9684'), ('CL25M009', '4094'),
    ('CL25M010', '3447'), ('CL25M011', '7331'), ('CL25M012', '5080'),
    ('CL25M013', '7339'), ('CL25M015', '9059'), ('CL25M016', '8577')
  ) as c (roll, code) on c.roll = s.roll_number;
