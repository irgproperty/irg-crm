-- IRG CRM schema (SQLite / Cloudflare D1), modelled on Proppy
PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  email TEXT,
  role TEXT DEFAULT 'agent',
  active INTEGER DEFAULT 1
);

-- lookup tables (editable lists, like Proppy's dropdowns)
CREATE TABLE lookups (
  kind TEXT NOT NULL,            -- origin, property_type, typology, condition, business_type, status_reason, country, energy_rating
  code TEXT NOT NULL,
  label TEXT NOT NULL,
  sort INTEGER DEFAULT 0,
  PRIMARY KEY (kind, code)
);

CREATE TABLE contacts (
  id INTEGER PRIMARY KEY,                -- = Proppy EntityID
  name TEXT,
  country TEXT,
  origin TEXT,                           -- lookups.kind='origin'
  assigned_user_id INTEGER REFERENCES users(id),
  language TEXT,
  active INTEGER DEFAULT 1,
  gdpr_consent INTEGER,                  -- NULL = unknown
  gdpr_consent_date TEXT,
  created_at TEXT,                       -- Proppy value (2018 bulk date unreliable)
  created_reliable INTEGER DEFAULT 1,
  last_event TEXT,
  next_event TEXT,
  is_seller INTEGER DEFAULT 0,
  is_buyer INTEGER DEFAULT 0,
  proppy_notes_raw TEXT,                 -- original HTML notes, kept for audit
  import_flags TEXT                      -- comma list: multi_email, masked_phone, dup_email ...
);
CREATE INDEX idx_contacts_name ON contacts(name);
CREATE INDEX idx_contacts_origin ON contacts(origin);

CREATE TABLE contact_emails (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  email TEXT NOT NULL COLLATE NOCASE,
  is_primary INTEGER DEFAULT 0
);
CREATE INDEX idx_emails_email ON contact_emails(email);
CREATE INDEX idx_emails_contact ON contact_emails(contact_id);

CREATE TABLE contact_phones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  phone TEXT NOT NULL,                   -- normalised E.164 where possible
  phone_raw TEXT,
  kind TEXT DEFAULT 'mobile',            -- mobile / phone
  is_primary INTEGER DEFAULT 0
);
CREATE INDEX idx_phones_phone ON contact_phones(phone);
CREATE INDEX idx_phones_contact ON contact_phones(contact_id);

CREATE TABLE notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
  property_id INTEGER REFERENCES properties(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id),
  body TEXT NOT NULL,                    -- plain text
  source TEXT DEFAULT 'proppy_import',
  created_at TEXT
);
CREATE INDEX idx_notes_contact ON notes(contact_id);

-- buyer requirements (not exported by Proppy; ready to fill / customise)
CREATE TABLE searches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  price_min INTEGER, price_max INTEGER,
  bedrooms_min INTEGER,
  locations TEXT, property_types TEXT, features TEXT,
  notes TEXT,
  active INTEGER DEFAULT 1,
  created_at TEXT
);

CREATE TABLE events (                    -- calls, viewings, follow-ups
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_id INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
  property_id INTEGER REFERENCES properties(id),
  user_id INTEGER REFERENCES users(id),
  kind TEXT, title TEXT, due_at TEXT, done_at TEXT, notes TEXT
);

CREATE TABLE properties (
  id INTEGER PRIMARY KEY,                -- = Proppy PropertyID (keeps /property-detail/-/<id> URLs)
  reference TEXT,
  status TEXT,                           -- active / inactive / pending
  status_reason TEXT,
  sold INTEGER DEFAULT 0,
  visible_on_website INTEGER DEFAULT 0,
  block_export INTEGER DEFAULT 0,
  exclusive INTEGER DEFAULT 0,
  pre_off_market INTEGER DEFAULT 0,
  business_type TEXT,
  property_type TEXT,
  typology TEXT,
  condition TEXT,
  price REAL, price_to REAL, price_prefix TEXT, price_visible INTEGER DEFAULT 1,
  bedrooms INTEGER, bathrooms INTEGER,
  area_house REAL, area_land REAL, area_gross REAL,   -- m2
  country TEXT, district TEXT, city TEXT, locality TEXT, zone TEXT,
  zipcode TEXT, address TEXT,
  latitude REAL, longitude REAL,
  year_built INTEGER, year_renovated INTEGER, floors INTEGER,
  imi_value REAL, condo_fee REAL,
  energy_rating TEXT, energy_cert_number TEXT,
  habitation_licence TEXT, registry_number TEXT,
  contract_number TEXT, contract_start TEXT, contract_end TEXT,
  commission TEXT,
  internal_name TEXT, key_notes TEXT, internal_notes TEXT,
  broker_user_id INTEGER REFERENCES users(id),
  created_at TEXT, published_at TEXT,
  raw_json TEXT                          -- full Proppy detail dump, nothing lost
);
CREATE INDEX idx_prop_ref ON properties(reference);
CREATE INDEX idx_prop_status ON properties(status, sold);

CREATE TABLE property_texts (
  property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  lang TEXT NOT NULL,
  title TEXT, meta TEXT, short_description TEXT, full_description TEXT,
  html_description TEXT, print_description TEXT, keywords TEXT,
  PRIMARY KEY (property_id, lang)
);

CREATE TABLE feature_defs (              -- Proppy option dictionary
  id INTEGER PRIMARY KEY,                -- Proppy option id
  kind TEXT NOT NULL,                    -- bit / list / text
  label_pt TEXT NOT NULL,
  label_en TEXT,
  grp TEXT,                              -- view, proximity, orientation, general
  custom INTEGER DEFAULT 0,              -- 1 = added by us (Proppy can't do this)
  active INTEGER DEFAULT 1,
  sort INTEGER DEFAULT 0
);

CREATE TABLE property_features (
  property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  feature_id INTEGER NOT NULL REFERENCES feature_defs(id),
  value TEXT,                            -- for text options
  PRIMARY KEY (property_id, feature_id)
);

CREATE TABLE photos (
  id INTEGER PRIMARY KEY,                -- Proppy photo id
  property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  visible INTEGER DEFAULT 1,
  source_url TEXT,                       -- cdn.proppy.app original
  r2_key TEXT,                           -- filled after re-hosting
  local_file TEXT                        -- file inside proppy_photos_online_61.zip, if downloaded
);
CREATE INDEX idx_photos_prop ON photos(property_id, position);

CREATE TABLE property_owners (
  property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  contact_id INTEGER NOT NULL,           -- not FK: some owner ids may be missing from export
  owner_name TEXT,
  PRIMARY KEY (property_id, contact_id)
);

CREATE TABLE import_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT, entity TEXT, ref TEXT, message TEXT
);
