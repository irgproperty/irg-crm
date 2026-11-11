-- Property labels: public ones show on website thumbnails, internal ones are CRM-only. Searchable.
CREATE TABLE IF NOT EXISTS label_defs (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, public INTEGER NOT NULL DEFAULT 1, sort INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS property_labels (property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE, label_id INTEGER NOT NULL REFERENCES label_defs(id) ON DELETE CASCADE, PRIMARY KEY(property_id,label_id));
CREATE INDEX IF NOT EXISTS idx_pl_label ON property_labels(label_id);
INSERT OR IGNORE INTO label_defs(name,public,sort) VALUES
 ('New Construction',1,1),('IRG Top Pick',1,2),('Investment Property',1,3),('Property with Views',1,4),('Golden Triangle',1,5),
 ('Direct',0,10),('Partner',0,11),('Exclusive',0,12);
INSERT OR IGNORE INTO property_labels SELECT p.id,(SELECT id FROM label_defs WHERE name='Exclusive') FROM properties p WHERE p.exclusive=1;
