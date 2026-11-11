CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT);
INSERT OR IGNORE INTO app_settings(key,value) VALUES('watermark','{"on":1,"opacity":0.3,"size":0.22,"v":1}');
