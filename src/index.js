// IRG CRM API. Auth: put the whole site behind Cloudflare Access; the worker trusts its header.
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'content-type': 'application/json' } });
const PROP_FIELDS = ['reference','status','status_reason','sold','visible_on_website','block_export','exclusive','pre_off_market','business_type','property_type','typology','condition','price','price_to','price_visible','bedrooms','bathrooms','area_house','area_land','area_gross','country','district','city','locality','zone','zipcode','address','latitude','longitude','year_built','year_renovated','floors','imi_value','condo_fee','energy_rating','energy_cert_number','habitation_licence','registry_number','contract_number','contract_start','contract_end','commission','internal_name','key_notes','internal_notes','broker_user_id'];
const CONTACT_FIELDS = ['name','country','origin','assigned_user_id','language','active','gdpr_consent','gdpr_consent_date','is_seller','is_buyer','next_event'];
const now = () => new Date().toISOString().slice(0, 16);
const pick = (o, keys) => Object.fromEntries(keys.filter(k => k in o).map(k => [k, o[k] === '' ? null : o[k]]));

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/public/')) {
      try { return await publicApi(req, env, url); } catch (e) { return json({ error: String(e.message || e) }, 500); }
    }
    const email = await accessEmail(req, env, url);
    if (!email) return json({ error: 'unauthorised' }, 401);
    if (email.startsWith('__setup__')) return json({ setup: 'Set ACCESS_AUD to this value, then redeploy', ACCESS_AUD: email.slice(9) });
    try { return await route(req, env, url, email); }
    catch (e) { return json({ error: String(e.message || e) }, 500); }
  },
};

async function route(req, env, url, email) {
  const db = env.DB, m = req.method, p = url.pathname.replace(/^\/api/, '');
  const q = (s, ...a) => db.prepare(s).bind(...a);
  const all = async (s, ...a) => (await q(s, ...a).all()).results;
  const one = (s, ...a) => q(s, ...a).first();
  const body = async () => (m === 'GET' ? {} : await req.json());
  let r;
  const upd = (table, id, data) => {
    const k = Object.keys(data);
    if (!k.length) return null;
    return q(`UPDATE ${table} SET ${k.map(x => x + '=?').join(',')} WHERE id=?`, ...k.map(x => data[x]), id);
  };

  if (p === '/me') return json({ email });

  if (p === '/dashboard') {
    const [c, pr, act, rec] = await Promise.all([
      one('SELECT COUNT(*) n, SUM(is_seller) sellers FROM contacts'),
      one("SELECT COUNT(*) n, SUM(status='active') active, SUM(visible_on_website) online FROM properties"),
      all("SELECT origin, COUNT(*) n FROM contacts WHERE origin IS NOT NULL GROUP BY origin ORDER BY n DESC LIMIT 8"),
      all('SELECT id,name,origin,created_at FROM contacts ORDER BY id DESC LIMIT 8'),
    ]);
    return json({ contacts: c, properties: pr, origins: act, recent: rec });
  }

  if (p === '/lookups') {
    const rows = await all('SELECT kind,code,label FROM lookups ORDER BY kind,sort,label');
    const o = {}; rows.forEach(x => (o[x.kind] ||= []).push(x));
    o.users = await all('SELECT id,name FROM users WHERE active=1 ORDER BY name');
    return json(o);
  }
  if (p === '/lookups' && m === 'POST') {}
  if ((r = p.match(/^\/lookups\/(\w+)$/)) && m === 'POST') {
    const b = await body(); await q('INSERT OR IGNORE INTO lookups(kind,code,label) VALUES(?,?,?)', r[1], b.label, b.label).run(); return json({ ok: 1 });
  }
  if ((r = p.match(/^\/lookups\/(\w+)\/(.+)$/)) && m === 'DELETE') {
    await q('DELETE FROM lookups WHERE kind=? AND code=?', r[1], decodeURIComponent(r[2])).run(); return json({ ok: 1 });
  }

  // ---------- contacts ----------
  if (p === '/contacts' && m === 'GET') {
    const s = url.searchParams, page = +(s.get('page') || 1), per = 50;
    const w = [], a = [];
    const term = (s.get('q') || '').trim();
    if (term) {
      const like = '%' + term + '%';
      const dig = term.replace(/[^\d]/g, '');
      w.push('(c.name LIKE ? OR c.id IN (SELECT contact_id FROM contact_emails WHERE email LIKE ?) OR c.id = ?' + (dig.length >= 5 ? ' OR c.id IN (SELECT contact_id FROM contact_phones WHERE phone LIKE ?)' : '') + ')');
      a.push(like, like, +term || -1); if (dig.length >= 5) a.push('%' + dig + '%');
    }
    if (s.get('origin')) { w.push('c.origin=?'); a.push(s.get('origin')); }
    if (s.get('user')) { w.push('c.assigned_user_id=?'); a.push(+s.get('user')); }
    if (s.get('seller')) w.push('c.is_seller=1');
    if (s.get('buyer')) w.push('c.is_buyer=1');
    const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
    const total = await one(`SELECT COUNT(*) n FROM contacts c ${where}`, ...a);
    const rows = await all(`SELECT c.id,c.name,c.country,c.origin,c.is_seller,c.is_buyer,c.created_at,c.active,u.name AS user,
      (SELECT email FROM contact_emails WHERE contact_id=c.id ORDER BY is_primary DESC LIMIT 1) email,
      (SELECT phone FROM contact_phones WHERE contact_id=c.id ORDER BY is_primary DESC LIMIT 1) phone
      FROM contacts c LEFT JOIN users u ON u.id=c.assigned_user_id ${where} ORDER BY c.id DESC LIMIT ? OFFSET ?`, ...a, per, (page - 1) * per);
    return json({ total: total.n, page, per, rows });
  }
  if (p === '/contacts' && m === 'POST') {
    const b = await body();
    const d = pick(b, CONTACT_FIELDS); d.created_at = now(); d.created_reliable = 1;
    const id = (await one('SELECT COALESCE(MAX(id),0)+1 n FROM contacts')).n;
    const k = ['id', ...Object.keys(d)];
    const st = [q(`INSERT INTO contacts(${k.join(',')}) VALUES(${k.map(() => '?').join(',')})`, id, ...Object.values(d))];
    (b.emails || []).forEach((e, i) => e && st.push(q('INSERT INTO contact_emails(contact_id,email,is_primary) VALUES(?,?,?)', id, e.toLowerCase(), i ? 0 : 1)));
    (b.phones || []).forEach((e, i) => e && st.push(q('INSERT INTO contact_phones(contact_id,phone,phone_raw,is_primary) VALUES(?,?,?,?)', id, e, e, i ? 0 : 1)));
    await db.batch(st); return json({ id });
  }
  if ((r = p.match(/^\/contacts\/(\d+)$/))) {
    const id = +r[1];
    if (m === 'GET') {
      const c = await one('SELECT * FROM contacts WHERE id=?', id);
      if (!c) return json({ error: 'not found' }, 404);
      delete c.proppy_notes_raw;
      const [emails, phones, notes, owned, searches, events] = await Promise.all([
        all('SELECT id,email,is_primary FROM contact_emails WHERE contact_id=? ORDER BY is_primary DESC,id', id),
        all('SELECT id,phone,kind,is_primary FROM contact_phones WHERE contact_id=? ORDER BY is_primary DESC,id', id),
        all('SELECT n.*,u.name user FROM notes n LEFT JOIN users u ON u.id=n.user_id WHERE contact_id=? ORDER BY created_at DESC,id DESC', id),
        all('SELECT p.id,p.reference,p.status,p.sold,p.property_type,p.city,p.locality,p.price FROM property_owners o JOIN properties p ON p.id=o.property_id WHERE o.contact_id=?', id),
        all('SELECT * FROM searches WHERE contact_id=? ORDER BY id DESC', id),
        all('SELECT * FROM events WHERE contact_id=? ORDER BY COALESCE(due_at,"") DESC', id),
      ]);
      const dups = await all('SELECT DISTINCT c.id,c.name FROM contact_emails e JOIN contact_emails f ON f.email=e.email AND f.contact_id<>e.contact_id JOIN contacts c ON c.id=f.contact_id WHERE e.contact_id=?', id);
      return json({ ...c, emails, phones, notes, owned, searches, events, duplicates: dups });
    }
    if (m === 'PUT') {
      const b = await body(), st = [];
      const u = upd('contacts', id, pick(b, CONTACT_FIELDS)); if (u) st.push(u);
      if (b.emails) { st.push(q('DELETE FROM contact_emails WHERE contact_id=?', id)); b.emails.filter(Boolean).forEach((e, i) => st.push(q('INSERT INTO contact_emails(contact_id,email,is_primary) VALUES(?,?,?)', id, e.trim().toLowerCase(), i ? 0 : 1))); }
      if (b.phones) { st.push(q('DELETE FROM contact_phones WHERE contact_id=?', id)); b.phones.filter(Boolean).forEach((e, i) => st.push(q('INSERT INTO contact_phones(contact_id,phone,phone_raw,is_primary) VALUES(?,?,?,?)', id, e.trim(), e.trim(), i ? 0 : 1))); }
      if (st.length) await db.batch(st); return json({ ok: 1 });
    }
    if (m === 'DELETE') { await q('DELETE FROM contacts WHERE id=?', id).run(); return json({ ok: 1 }); }
  }
  if ((r = p.match(/^\/contacts\/(\d+)\/notes$/)) && m === 'POST') {
    const b = await body();
    await q('INSERT INTO notes(contact_id,property_id,body,source,created_at,user_id) VALUES(?,?,?,?,?,(SELECT id FROM users WHERE email=?))', +r[1], b.property_id || null, b.body, 'crm', now(), email).run();
    return json({ ok: 1 });
  }
  if ((r = p.match(/^\/notes\/(\d+)$/)) && m === 'DELETE') { await q('DELETE FROM notes WHERE id=?', +r[1]).run(); return json({ ok: 1 }); }
  if ((r = p.match(/^\/contacts\/(\d+)\/searches$/)) && m === 'POST') {
    const b = await body();
    await q('INSERT INTO searches(contact_id,price_min,price_max,bedrooms_min,locations,property_types,notes,created_at) VALUES(?,?,?,?,?,?,?,?)', +r[1], b.price_min || null, b.price_max || null, b.bedrooms_min || null, b.locations || null, b.property_types || null, b.notes || null, now()).run();
    return json({ ok: 1 });
  }
  if ((r = p.match(/^\/searches\/(\d+)$/)) && m === 'DELETE') { await q('DELETE FROM searches WHERE id=?', +r[1]).run(); return json({ ok: 1 }); }
  if ((r = p.match(/^\/searches\/(\d+)\/matches$/))) {
    const s = await one('SELECT * FROM searches WHERE id=?', +r[1]);
    const w = ["status='active'", 'sold=0'], a = [];
    if (s.price_min) { w.push('price>=?'); a.push(s.price_min); }
    if (s.price_max) { w.push('price<=?'); a.push(s.price_max); }
    if (s.bedrooms_min) { w.push('bedrooms>=?'); a.push(s.bedrooms_min); }
    const locs = (s.locations || '').split(',').map(x => x.trim()).filter(Boolean);
    if (locs.length) { w.push('(' + locs.map(() => '(locality LIKE ? OR city LIKE ? OR zone LIKE ?)').join(' OR ') + ')'); locs.forEach(l => a.push('%' + l + '%', '%' + l + '%', '%' + l + '%')); }
    const types = (s.property_types || '').split(',').map(x => x.trim()).filter(Boolean);
    if (types.length) { w.push('property_type IN (' + types.map(() => '?').join(',') + ')'); a.push(...types); }
    return json(await all(`SELECT id,reference,property_type,city,locality,bedrooms,price FROM properties WHERE ${w.join(' AND ')} ORDER BY price LIMIT 50`, ...a));
  }
  if (p === '/events' && m === 'POST') {
    const b = await body();
    await q('INSERT INTO events(contact_id,property_id,kind,title,due_at,notes,user_id) VALUES(?,?,?,?,?,?,(SELECT id FROM users WHERE email=?))', b.contact_id, b.property_id || null, b.kind || 'task', b.title, b.due_at || null, b.notes || null, email).run();
    return json({ ok: 1 });
  }
  if ((r = p.match(/^\/events\/(\d+)\/done$/)) && m === 'POST') { await q('UPDATE events SET done_at=? WHERE id=?', now(), +r[1]).run(); return json({ ok: 1 }); }
  if (p === '/events' && m === 'GET') {
    return json(await all('SELECT e.*,c.name contact FROM events e LEFT JOIN contacts c ON c.id=e.contact_id WHERE done_at IS NULL ORDER BY COALESCE(due_at,"9") LIMIT 100'));
  }

  // ---------- properties ----------
  if (p === '/properties' && m === 'GET') {
    const s = url.searchParams, page = +(s.get('page') || 1), per = 50, w = [], a = [];
    const term = (s.get('q') || '').trim();
    if (term) { w.push('(reference LIKE ? OR city LIKE ? OR locality LIKE ? OR zone LIKE ? OR internal_name LIKE ? OR id=?)'); const l = '%' + term + '%'; a.push(l, l, l, l, l, +term || -1); }
    const st = s.get('status');
    if (st === 'sold') w.push('sold=1'); else if (st) { w.push('status=?', 'sold=0'); a.push(st); }
    if (s.get('online')) w.push('visible_on_website=1');
    if (s.get('type')) { w.push('property_type=?'); a.push(s.get('type')); }
    const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
    const total = await one(`SELECT COUNT(*) n FROM properties ${where}`, ...a);
    const rows = await all(`SELECT p.id,p.reference,p.status,p.sold,p.visible_on_website,p.property_type,p.typology,p.city,p.locality,p.zone,p.price,p.bedrooms,p.created_at,
      (SELECT source_url FROM photos WHERE property_id=p.id AND visible=1 ORDER BY position LIMIT 1) photo,
      (SELECT GROUP_CONCAT(c.name, ', ') FROM property_owners o JOIN contacts c ON c.id=o.contact_id WHERE o.property_id=p.id) owners
      FROM properties p ${where} ORDER BY CAST(reference AS INTEGER) DESC, id DESC LIMIT ? OFFSET ?`, ...a, per, (page - 1) * per);
    return json({ total: total.n, page, per, rows });
  }
  if (p === '/properties' && m === 'POST') {
    const b = await body(), d = pick(b, PROP_FIELDS); d.created_at = now(); d.status ||= 'pending';
    const id = (await one('SELECT COALESCE(MAX(id),0)+1 n FROM properties')).n;
    if (!d.reference) d.reference = String(((await one('SELECT MAX(CAST(reference AS INTEGER)) n FROM properties')).n || 0) + 1);
    const k = ['id', ...Object.keys(d)];
    await q(`INSERT INTO properties(${k.join(',')}) VALUES(${k.map(() => '?').join(',')})`, id, ...Object.values(d)).run();
    return json({ id });
  }
  if ((r = p.match(/^\/properties\/(\d+)$/))) {
    const id = +r[1];
    if (m === 'GET') {
      const pr = await one('SELECT * FROM properties WHERE id=?', id);
      if (!pr) return json({ error: 'not found' }, 404);
      delete pr.raw_json;
      const [texts, features, photos, owners, notes] = await Promise.all([
        all('SELECT * FROM property_texts WHERE property_id=?', id),
        all('SELECT feature_id,value FROM property_features WHERE property_id=?', id),
        all('SELECT id,position,visible,source_url,r2_key FROM photos WHERE property_id=? ORDER BY position', id),
        all('SELECT o.contact_id id,c.name FROM property_owners o LEFT JOIN contacts c ON c.id=o.contact_id WHERE o.property_id=?', id),
        all('SELECT n.*,u.name user FROM notes n LEFT JOIN users u ON u.id=n.user_id WHERE property_id=? ORDER BY created_at DESC', id),
      ]);
      return json({ ...pr, texts, features, photos, owners, notes });
    }
    if (m === 'PUT') {
      const b = await body(), st = [];
      const u = upd('properties', id, pick(b, PROP_FIELDS)); if (u) st.push(u);
      if (b.features) {
        st.push(q('DELETE FROM property_features WHERE property_id=?', id));
        b.features.forEach(f => st.push(q('INSERT OR IGNORE INTO property_features VALUES(?,?,?)', id, f.feature_id, f.value ?? null)));
      }
      if (b.texts) b.texts.forEach(t => st.push(q('INSERT INTO property_texts(property_id,lang,title,short_description,full_description) VALUES(?,?,?,?,?) ON CONFLICT(property_id,lang) DO UPDATE SET title=excluded.title,short_description=excluded.short_description,full_description=excluded.full_description', id, t.lang, t.title || null, t.short_description || null, t.full_description || null)));
      if (b.owners) { st.push(q('DELETE FROM property_owners WHERE property_id=?', id)); b.owners.forEach(o => st.push(q('INSERT OR IGNORE INTO property_owners VALUES(?,?,?)', id, o, null))); st.push(q('UPDATE contacts SET is_seller=1 WHERE id IN (' + (b.owners.length ? b.owners.map(() => '?').join(',') : 'NULL') + ')', ...b.owners)); }
      if (b.photos) b.photos.forEach((ph, i) => st.push(q('UPDATE photos SET position=?,visible=? WHERE id=? AND property_id=?', i + 1, ph.visible ? 1 : 0, ph.id, id)));
      if (st.length) await db.batch(st); return json({ ok: 1 });
    }
  }

  // ---------- photo migration: copy from Proppy's CDN into R2 ----------
  if (p === '/admin/photos/status') {
    const r = await one('SELECT COUNT(*) total, SUM(r2_key IS NOT NULL) done FROM photos');
    return json({ total: r.total, done: r.done || 0, r2: !!env.PHOTOS });
  }
  if (p === '/admin/photos/migrate' && m === 'POST') {
    if (!env.PHOTOS) return json({ error: 'R2 bucket not bound' }, 400);
    const b = await body(), limit = Math.min(+b.limit || 8, 15), width = +b.width || 2000;
    const rows = await all('SELECT id,property_id,source_url FROM photos WHERE r2_key IS NULL AND source_url IS NOT NULL ORDER BY property_id,position LIMIT ?', limit);
    const fails = []; let bytes = 0;
    const results = await Promise.all(rows.map(async (ph) => {
      try {
        const clean = ph.source_url.split('?')[0];
        let res = await fetch(`${clean}?width=${width}`);
        if (!res.ok) res = await fetch(clean);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const key = `p/${ph.property_id}/${ph.id}.jpg`;
        const obj = await env.PHOTOS.put(key, res.body, { httpMetadata: { contentType: res.headers.get('content-type') || 'image/jpeg' } });
        bytes += obj.size || 0;
        return q('UPDATE photos SET r2_key=? WHERE id=?', key, ph.id);
      } catch (e) { fails.push({ id: ph.id, error: String(e.message || e) }); return null; }
    }));
    const st = results.filter(Boolean);
    if (st.length) await db.batch(st);
    // only count what is left when this batch came back short (avoids re-scanning the table every call: D1 free tier = 5M row reads/day)
    const remaining = rows.length < limit ? 0 : 1;
    return json({ copied: st.length, failed: fails, remaining, bytes });
  }

  // ---------- features (custom ones allowed) ----------
  if (p === '/features' && m === 'GET') return json(await all('SELECT f.*,(SELECT COUNT(*) FROM property_features WHERE feature_id=f.id) used FROM feature_defs f ORDER BY grp,sort,label_pt'));
  if (p === '/features' && m === 'POST') {
    const b = await body();
    const id = (await one('SELECT MAX(MAX(id),100000)+1 n FROM feature_defs')).n;
    await q('INSERT INTO feature_defs(id,kind,label_pt,label_en,grp,custom) VALUES(?,?,?,?,?,1)', id, b.kind || 'bit', b.label_pt || b.label_en, b.label_en || null, b.grp || 'general').run();
    return json({ id });
  }
  if ((r = p.match(/^\/features\/(\d+)$/))) {
    if (m === 'PUT') { const b = await body(); await q('UPDATE feature_defs SET label_pt=COALESCE(?,label_pt),label_en=COALESCE(?,label_en),grp=COALESCE(?,grp),active=COALESCE(?,active) WHERE id=?', b.label_pt ?? null, b.label_en ?? null, b.grp ?? null, b.active ?? null, +r[1]).run(); return json({ ok: 1 }); }
    if (m === 'DELETE') { await db.batch([q('DELETE FROM property_features WHERE feature_id=?', +r[1]), q('DELETE FROM feature_defs WHERE id=?', +r[1])]); return json({ ok: 1 }); }
  }
  if (p === '/users' && m === 'POST') { const b = await body(); await q('INSERT INTO users(name,email,role) VALUES(?,?,?)', b.name, b.email || null, b.role || 'agent').run(); return json({ ok: 1 }); }

  return json({ error: 'not found' }, 404);
}

// ---------- public API for the website (bypass Cloudflare Access for /api/public/*, protected by SITE_KEY) ----------
const TYPE_EN = { 'Moradia': 'Villa', 'Moradia Duplex': 'Villa', 'Quinta': 'Villa', 'Moradia Geminada': 'Townhouse', 'Moradia em Banda': 'Townhouse', 'Apartamento': 'Apartment', 'Penthouse': 'Apartment', 'Andar moradia': 'Apartment', 'Terreno': 'Land', 'Terreno urbano': 'Land', 'Terreno rústico': 'Land', 'Loja / comércio': 'Commercial', 'Armazém': 'Commercial', 'Restaurante / snack': 'Commercial', 'Hotel': 'Commercial', 'Prédio': 'Building', 'Empreendimento': 'Development', 'Ruína': 'Ruin' };
const COND_EN = { 'Novo': 'New', 'Usado': 'Used', 'Renovado': 'Renovated', 'Em construção': 'Under construction', 'Para recuperar': 'To renovate', 'Para renovar': 'To renovate', 'Em planta': 'Off plan', 'Bom': 'Good' };
const KNOWN_AREAS = ['Quinta do Lago', 'Vale do Lobo', 'Vilamoura', 'São Lourenço', 'Quarteira', 'Almancil'];
const tidy = (s) => (s || '').replace(/\s*\(.*\)\s*/, '').trim();

async function publicApi(req, env, url) {
  if (url.pathname.startsWith('/api/public/img/') && req.method === 'GET') {
    const k = decodeURIComponent(url.pathname.slice('/api/public/img/'.length));
    if (!env.PHOTOS || !/^[\w\/.\-]+$/.test(k)) return new Response('not found', { status: 404 });
    const o = await env.PHOTOS.get(k);
    if (!o) return new Response('not found', { status: 404 });
    return new Response(o.body, { headers: { 'content-type': o.httpMetadata?.contentType || 'image/jpeg', 'cache-control': 'public, max-age=31536000, immutable', etag: o.httpEtag } });
  }
  const key = req.headers.get('x-site-key');
  if (!env.SITE_KEY || key !== env.SITE_KEY) return json({ error: 'unauthorised' }, 401);
  const db = env.DB, p = url.pathname.replace('/api/public', '');
  const all = async (s, ...a) => (await db.prepare(s).bind(...a).all()).results;

  if (p === '/listings' && req.method === 'GET') {
    const props = await all("SELECT * FROM properties WHERE status='active' AND sold=0 AND visible_on_website=1");
    const ids = props.map(x => x.id);
    if (!ids.length) return json([]);
    const ph = ids.map(() => '?').join(',');
    const [texts, photos, feats, users] = await Promise.all([
      all(`SELECT * FROM property_texts WHERE lang='en' AND property_id IN (${ph})`, ...ids),
      all(`SELECT property_id,source_url,r2_key FROM photos WHERE visible=1 AND property_id IN (${ph}) ORDER BY property_id,position`, ...ids),
      all(`SELECT pf.property_id,pf.value,f.id,f.kind,f.grp,f.label_en,f.label_pt FROM property_features pf JOIN feature_defs f ON f.id=pf.feature_id WHERE f.active=1 AND pf.property_id IN (${ph})`, ...ids),
      all('SELECT id,name,email FROM users'),
    ]);
    const by = (rows) => rows.reduce((m, r) => ((m[r.property_id] ||= []).push(r), m), {});
    const T = Object.fromEntries(texts.map(t => [t.property_id, t])), PH = by(photos), FE = by(feats), U = Object.fromEntries(users.map(u => [u.id, u]));
    const CATS = { general: 'Features', view: 'Views', orientation: 'Orientation', proximity: 'Nearby' };
    const out = props.map(r => {
      const t = T[r.id] || {}, type = TYPE_EN[r.property_type] || r.property_type || 'Property';
      const area = KNOWN_AREAS.includes(r.zone) ? r.zone : tidy(r.locality) || tidy(r.city);
      const fs = FE[r.id] || [];
      const categories = {};
      fs.filter(f => f.kind === 'bit' || f.kind === 'list').forEach(f => (categories[CATS[f.grp] || 'Features'] ||= []).push(f.label_en || f.label_pt));
      const glance = [];
      const has = (id) => fs.some(f => f.id === id);
      if (has(2)) glance.push(['Pool', 'Yes']); if (has(11)) glance.push(['Parking', 'Garage']); if (has(74)) glance.push(['Cooling', 'Air conditioning']);
      const title = t.title || `${r.bedrooms ? r.bedrooms + '-bedroom ' : ''}${type.toLowerCase()} in ${area}`;
      const published = r.published_at || r.created_at;
      return {
        id: r.id, reference: r.reference || String(r.id), title, status: 'active', badge: null, type, typology: r.typology || '',
        price: r.price_visible ? r.price : null, bedrooms: r.bedrooms, bathrooms: r.bathrooms,
        livingArea: r.area_house || null, plotArea: r.area_land || null, totalArea: r.area_gross || null,
        constructionYear: r.year_built, condition: COND_EN[r.condition] || r.condition || '', energyRating: r.energy_rating || '',
        location: { area, city: tidy(r.city), region: 'Algarve', lat: r.latitude || null, lng: r.longitude || null },
        description: (t.full_description || t.short_description || '').split(/\n+/).map(x => x.trim()).filter(Boolean),
        glance, features: Object.entries(categories).map(([category, items]) => ({ category, items })), featuresFlat: fs.map(f => f.label_en || f.label_pt),
        photos: (PH[r.id] || []).map((x, i) => ({ url: x.r2_key ? `${url.origin}/api/public/img/${x.r2_key}` : x.source_url, alt: `${title}, photo ${i + 1}`, category: '' })),
        video: null, floorplan: null, agent: null, featured: false,
        publishedAt: published, updatedAt: null,
      };
    });
    return json(out);
  }

  if (p === '/leads' && req.method === 'POST') {
    const b = await req.json();
    if (!b.email) return json({ error: 'email required' }, 400);
    const email = String(b.email).trim().toLowerCase().slice(0, 160);
    const name = String(b.name || email).slice(0, 120), phone = String(b.phone || '').slice(0, 30), msg = String(b.message || '').slice(0, 3000);
    let c = await db.prepare('SELECT contact_id id FROM contact_emails WHERE email=? LIMIT 1').bind(email).first();
    const nowIso = new Date().toISOString().slice(0, 16);
    let id;
    if (c) id = c.id;
    else {
      id = (await db.prepare('SELECT COALESCE(MAX(id),0)+1 n FROM contacts').first()).n;
      const st = [db.prepare("INSERT INTO contacts(id,name,origin,created_at,created_reliable,gdpr_consent,gdpr_consent_date) VALUES(?,?, 'Website',?,1,1,?)").bind(id, name, nowIso, nowIso),
        db.prepare('INSERT INTO contact_emails(contact_id,email,is_primary) VALUES(?,?,1)').bind(id, email)];
      if (phone) st.push(db.prepare('INSERT INTO contact_phones(contact_id,phone,phone_raw,is_primary) VALUES(?,?,?,1)').bind(id, phone, phone));
      await db.batch(st);
    }
    let pid = null;
    if (b.reference) pid = (await db.prepare('SELECT id FROM properties WHERE reference=? LIMIT 1').bind(String(b.reference)).first())?.id || null;
    const title = b.title || (b.reference ? `Enquiry ${b.reference}` : 'Website enquiry');
    await db.batch([
      db.prepare("INSERT INTO notes(contact_id,property_id,body,source,created_at) VALUES(?,?,?,'website',?)").bind(id, pid, `${title}\n${msg}`.trim(), nowIso),
      db.prepare('INSERT INTO events(contact_id,property_id,kind,title,due_at) VALUES(?,?,?,?,?)').bind(id, pid, 'lead', `Reply: ${title}`, nowIso.slice(0, 10)),
    ]);
    return json({ ok: 1, contact: id });
  }
  return json({ error: 'not found' }, 404);
}

// ---------- Cloudflare Access JWT verification (fail closed; localhost dev bypass only) ----------
let certCache = { at: 0, keys: null };
const b64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
async function accessEmail(req, env, url) {
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return 'dev@local';
  const token = req.headers.get('cf-access-jwt-assertion');
  if (!token || !env.ACCESS_TEAM_DOMAIN) return null;
  try {
    const [h, p, sig] = token.split('.');
    const header = JSON.parse(new TextDecoder().decode(b64u(h))), payload = JSON.parse(new TextDecoder().decode(b64u(p)));
    if (payload.exp * 1000 < Date.now()) return null;
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (payload.iss !== `https://${env.ACCESS_TEAM_DOMAIN}` || (env.ACCESS_AUD && !aud.includes(env.ACCESS_AUD))) return null;
    if (!certCache.keys || Date.now() - certCache.at > 3600e3) {
      const r = await fetch(`https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`);
      certCache = { at: Date.now(), keys: (await r.json()).keys };
    }
    const jwk = certCache.keys.find((k) => k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64u(sig), new TextEncoder().encode(`${h}.${p}`));
    if (!ok) return null;
    if (!env.ACCESS_AUD) return '__setup__' + aud.join(',');   // setup mode: show the AUD to a signed-in user so it can be saved
    return payload.email || null;
  } catch { return null; }
}
