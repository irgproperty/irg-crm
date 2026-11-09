-- Run once on the live database (small: creates two tiny tables and three indexes)
CREATE INDEX IF NOT EXISTS idx_photos_todo ON photos(property_id, position) WHERE r2_key IS NULL AND source_url IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pf_feature ON property_features(feature_id);
CREATE INDEX IF NOT EXISTS idx_prop_web ON properties(visible_on_website, status, sold);
CREATE TABLE IF NOT EXISTS stats (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
CREATE TABLE IF NOT EXISTS usage (day TEXT PRIMARY KEY, reads INTEGER DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_notes_property ON notes(property_id);
CREATE INDEX IF NOT EXISTS idx_owners_contact ON property_owners(contact_id);
CREATE INDEX IF NOT EXISTS idx_prop_refnum ON properties(CAST(reference AS INTEGER) DESC, id DESC);
