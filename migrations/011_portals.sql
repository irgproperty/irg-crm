-- Which portals each property is sent to. format 'kyero' = a Kyero v3 XML feed is built for that portal; 'none' = list only (no feed yet).
CREATE TABLE IF NOT EXISTS portals (slug TEXT PRIMARY KEY, name TEXT NOT NULL, format TEXT NOT NULL DEFAULT 'none', sort INTEGER DEFAULT 50);
CREATE TABLE IF NOT EXISTS property_portals (property_id INTEGER NOT NULL REFERENCES properties(id) ON DELETE CASCADE, portal_slug TEXT NOT NULL, PRIMARY KEY(property_id,portal_slug));
CREATE INDEX IF NOT EXISTS idx_pp_portal ON property_portals(portal_slug);
INSERT OR IGNORE INTO portals(slug,name,format,sort) VALUES
 ('kyero','Kyero','kyero',1),('idealista','Idealista','none',2),('rightmove','Rightmove','none',3),('zoopla','Zoopla','none',4),
 ('green-acres','Green-Acres','none',5),('imovirtual','Imovirtual','none',6),('a-place-in-the-sun','A Place in the Sun','none',7),
 ('james-edition','James Edition','none',8),('supercasa','Supercasa','none',9);
-- keep the current Kyero feed exactly as it is: every property it already contains stays selected
INSERT OR IGNORE INTO property_portals SELECT id,'kyero' FROM properties WHERE status='active' AND sold=0 AND visible_on_website=1 AND block_export=0 AND business_type='Venda';
