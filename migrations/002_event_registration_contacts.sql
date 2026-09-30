ALTER TABLE registrations
  ADD COLUMN attendee_name text CHECK (attendee_name IS NULL OR (char_length(btrim(attendee_name)) BETWEEN 1 AND 60)),
  ADD COLUMN phone_number text CHECK (phone_number IS NULL OR phone_number ~ '^\+861[3-9][0-9]{9}$');
