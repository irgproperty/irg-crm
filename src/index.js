import { getWm, clearWm, stamp } from './photos.js';
import { feedApi } from './feeds.js';
import { parseLead } from './inbound.js';
import PostalMime from 'postal-mime';
// IRG CRM API. Auth: put the whole site behind Cloudflare Access; the worker trusts its header.
const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { 'content-type': 'application/json' } });
const PROP_FIELDS = ['reference','status','status_reason','sold','visible_on_website','block_export','exclusive','featured','pre_off_market','business_type','property_type','typology','condition','price','price_to','price_visible','bedrooms','bathrooms','area_house','area_land','area_gross','country','district','city','locality','zone','zipcode','address','latitude','longitude','year_built','year_renovated','floors','imi_value','condo_fee','energy_rating','energy_cert_number','habitation_licence','registry_number','contract_number','contract_start','contract_end','commission','internal_name','key_notes','internal_notes','broker_user_id'];
const CONTACT_FIELDS = ['name','country','origin','assigned_user_id','language','active','gdpr_consent','gdpr_consent_date','is_seller','is_buyer','next_event'];
const now = () => new Date().toISOString().slice(0, 16);
const pick = (o, keys) => Object.fromEntries(keys.filter(k => k in o).map(k => [k, o[k] === '' ? null : o[k]]));


// ---------- D1 read budget (free tier: 5M rows read / day). Track, show, and stop before the cap. ----------
const READ_SOFT = 3_000_000, READ_HARD = 4_200_000;
const memo = {};                                   // per-isolate memory cache
const memoGet = (k, ttl, fn) => { const m = memo[k]; if (m && Date.now() - m.t < ttl * 1000) return m.v; return (memo[k] = { t: Date.now(), v: fn() }).v; };
const today = () => new Date().toISOString().slice(0, 10);
let usageSeen = { day: '', reads: 0, at: 0 };
async function currentReads(db) {
  if (usageSeen.day === today() && Date.now() - usageSeen.at < 30000) return usageSeen.reads;
  const r = await db.prepare('SELECT reads FROM usage WHERE day=?').bind(today()).all();
  usageSeen = { day: today(), reads: r.results[0]?.reads || 0, at: Date.now() };
  return usageSeen.reads;
}
async function addReads(db, n) {
  if (!n) return;
  usageSeen.reads += n;
  await db.prepare('INSERT INTO usage(day,reads) VALUES(?,?) ON CONFLICT(day) DO UPDATE SET reads=reads+?').bind(today(), n, n).run();
}

export default {
  // Portal enquiry emails routed here by Cloudflare Email Routing
  async email(message, env, ctx) {
    const raw = await new Response(message.raw).arrayBuffer();
    const m = await PostalMime.parse(raw);
    const lead = parseLead({ from: m.from?.address || message.from, replyTo: m.replyTo?.[0]?.address || '', subject: m.subject, text: m.text || '' });
    if (!lead) { if (env.FALLBACK_EMAIL) await message.forward(env.FALLBACK_EMAIL); return; }
    await recordLead(env.DB, { ...lead, title: lead.reference ? `Enquiry ${lead.reference}` : lead.subject, source: 'portal-email' });
  },
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/feed/') || url.pathname.startsWith('/api/public/feed/')) {
      try { return await feedApi(req, env, url, addReads); } catch (e) { return json({ error: String(e.message || e) }, 500); }
    }
    if (url.pathname.startsWith('/api/public/')) {
      try { return await publicApi(req, env, url); } catch (e) { return json({ error: String(e.message || e) }, 500); }
    }
    const email = await accessEmail(req, env, url);
    if (!email) return json({ error: 'unauthorised' }, 401);
    if (email.startsWith('__setup__')) return json({ setup: 'Set ACCESS_AUD to this value, then redeploy', ACCESS_AUD: email.slice(9) });
    try { return await route(req, env, url, email, ctx); }
    catch (e) { return json({ error: String(e.message || e) }, 500); }
  },
};

async function route(req, env, url, email, ctx) {
  const db = env.DB, m = req.method, p = url.pathname.replace(/^\/api/, '');
  let reads = 0;
  const q = (s, ...a) => db.prepare(s).bind(...a);
  const run = async (st) => { const r = await st.all(); reads += r.meta?.rows_read || 0; return r.results; };
  const all = (s, ...a) => run(q(s, ...a));
  const one = async (s, ...a) => (await run(q(s, ...a)))[0] ?? null;
  const deleteProperty = async (id) => {
    const keys = (await all("SELECT r2_key FROM photos WHERE property_id=? AND r2_key IS NOT NULL AND r2_key!='missing'", id)).map(x => x.r2_key);
    await batch([q('UPDATE events SET property_id=NULL WHERE property_id=?', id), q('DELETE FROM properties WHERE id=?', id)]);
    if (env.PHOTOS && keys.length) { try { await env.PHOTOS.delete(keys); } catch (e) {} }
  };
  const batch = async (sts) => { const rs = await db.batch(sts); rs.forEach((r) => (reads += r.meta?.rows_read || 0)); return rs; };
  if (p !== '/usage' && (await currentReads(db)) > READ_HARD) return json({ error: 'Daily database read budget reached (protecting the free limit). It resets at 00:00 UTC.' }, 429);
  const res = await handle();
  if (reads) ctx.waitUntil(addReads(db, reads));
  res.headers.set('x-d1-rows-read', String(reads));
  return res;
  async function handle() {
  const body = async () => (m === 'GET' ? {} : await req.json());
  let r;
  const upd = (table, id, data) => {
    const k = Object.keys(data);
    if (!k.length) return null;
    return q(`UPDATE ${table} SET ${k.map(x => x + '=?').join(',')} WHERE id=?`, ...k.map(x => data[x]), id);
  };

  const stat = async (key, ttl, fn) => {
    const r = await one('SELECT value,updated_at FROM stats WHERE key=?', key);
    if (r && Date.now() - Date.parse(r.updated_at) < ttl * 1000) return JSON.parse(r.value);
    const v = await fn();
    await q('INSERT INTO stats(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at', key, JSON.stringify(v), new Date().toISOString()).run();
    return v;
  };

  if (p === '/me') return json({ email });
  if (p === '/usage') { const n = await currentReads(db); return json({ reads: n, soft: READ_SOFT, hard: READ_HARD, limit: 5_000_000 }); }

  if (p === '/dashboard') {
    const base = await stat('dashboard', 3600, async () => {
      const [c, pr, origins] = await Promise.all([
        one('SELECT COUNT(*) n, SUM(is_seller) sellers FROM contacts'),
        one("SELECT COUNT(*) n, SUM(status='active') active, SUM(visible_on_website) online FROM properties"),
        all("SELECT origin, COUNT(*) n FROM contacts WHERE origin IS NOT NULL GROUP BY origin ORDER BY n DESC LIMIT 8"),
      ]);
      return { contacts: c, properties: pr, origins };
    });
    const recent = await all('SELECT id,name,origin,created_at FROM contacts ORDER BY id DESC LIMIT 8');
    return json({ ...base, recent, cached: true });
  }

  if (p === '/lookups' && m === 'GET') {
    const o = await stat('lookups', 600, async () => {
      const rows = await all('SELECT kind,code,label FROM lookups ORDER BY kind,sort,label');
      const o = {}; rows.forEach(x => (o[x.kind] ||= []).push(x));
      o.users = await all('SELECT id,name FROM users WHERE active=1 ORDER BY name');
      return o;
    });
    return json(o);
  }
  if (p === '/lookups' && m === 'POST') {}
  if ((r = p.match(/^\/lookups\/(\w+)$/)) && m === 'POST') {
    const b = await body(); await q('INSERT OR IGNORE INTO lookups(kind,code,label) VALUES(?,?,?)', r[1], b.label, b.label).run(); await q("DELETE FROM stats WHERE key='lookups'").run(); return json({ ok: 1 });
  }
  if ((r = p.match(/^\/lookups\/(\w+)\/(.+)$/)) && m === 'DELETE') {
    await q('DELETE FROM lookups WHERE kind=? AND code=?', r[1], decodeURIComponent(r[2])).run(); await q("DELETE FROM stats WHERE key='lookups'").run(); return json({ ok: 1 });
  }

  // ---------- contacts ----------
  if (p === '/contacts' && m === 'GET') {
    const s = url.searchParams, page = +(s.get('page') || 1), per = 50;
    const w = [], a = [];
    const term = (s.get('q') || '').trim();
    if (term) {
      const like = '%' + term + '%';
      const dig = term.replace(/[^\d]/g, '');
      w.push('(c.name LIKE ? OR c.id IN (SELECT contact_id FROM contact_emails WHERE email LIKE ?) OR c.id = ?' + (dig.length >= 5 ? ' OR c.id IN (SELECT contact_id FROM contact_phones WHERE phone LIKE ?)' : '') + ' OR c.id IN (SELECT contact_id FROM contact_refs WHERE reference=?) OR c.id IN (SELECT o.contact_id FROM property_owners o JOIN properties p ON p.id=o.property_id WHERE p.reference=?))');
      a.push(like, like, +term || -1); if (dig.length >= 5) a.push('%' + dig + '%'); a.push(term.toUpperCase(), term);
    }
    if (s.get('origin')) { w.push('c.origin=?'); a.push(s.get('origin')); }
    if (s.get('user')) { w.push('c.assigned_user_id=?'); a.push(+s.get('user')); }
    { const k = s.get('kind'); if (k === 'both') w.push('c.is_seller=1 AND c.is_buyer=1'); else if (k === 'either') w.push('(c.is_seller=1 OR c.is_buyer=1)'); else if (k === 'seller') w.push('c.is_seller=1'); else if (k === 'buyer') w.push('c.is_buyer=1'); }
    const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
    const rows0 = await all(`SELECT c.id,c.name,c.country,c.origin,c.is_seller,c.is_buyer,c.created_at,c.active,u.name AS user,
      (SELECT email FROM contact_emails WHERE contact_id=c.id ORDER BY is_primary DESC LIMIT 1) email,
      (SELECT phone FROM contact_phones WHERE contact_id=c.id ORDER BY is_primary DESC LIMIT 1) phone,
      (SELECT GROUP_CONCAT(p.reference, ',') FROM property_owners o JOIN properties p ON p.id=o.property_id WHERE o.contact_id=c.id) owned_refs,
      (SELECT GROUP_CONCAT(reference, ',') FROM contact_refs WHERE contact_id=c.id) enq_refs
      FROM contacts c LEFT JOIN users u ON u.id=c.assigned_user_id ${where} ORDER BY c.id DESC LIMIT ? OFFSET ?`, ...a, per + 1, (page - 1) * per);
    const total = where ? null : (await stat('contacts_total', 3600, async () => (await one('SELECT COUNT(*) n FROM contacts')).n));
    return json({ total, hasMore: rows0.length > per, page, per, rows: rows0.slice(0, per) });
  }
  if (p === '/contacts/bulk' && m === 'POST') {
    const b = await body(), ids = (b.ids || []).map(Number).filter(Boolean).slice(0, 200);
    const ph = ids.map(() => '?').join(','), set = { buyer: 'is_buyer=1', notbuyer: 'is_buyer=0', seller: 'is_seller=1', notseller: 'is_seller=0' }[b.action];
    if (!ids.length || (b.action !== 'delete' && !set)) return json({ error: 'bad request' }, 400);
    if (set) await q(`UPDATE contacts SET ${set} WHERE id IN (${ph})`, ...ids).run(); else await q(`DELETE FROM contacts WHERE id IN (${ph})`, ...ids).run();
    return json({ ok: ids.length });
  }
  if (p === '/contacts/export.csv' && m === 'GET') {
    const s = url.searchParams, w = ['EXISTS (SELECT 1 FROM contact_emails e WHERE e.contact_id=c.id)'], a = [];
    if (s.get('origin')) { w.push('c.origin=?'); a.push(s.get('origin')); }
    if (s.get('user')) { w.push('c.assigned_user_id=?'); a.push(+s.get('user')); }
    { const k = s.get('kind'); if (k === 'both') w.push('c.is_seller=1 AND c.is_buyer=1'); else if (k === 'either') w.push('(c.is_seller=1 OR c.is_buyer=1)'); else if (k === 'seller') w.push('c.is_seller=1'); else if (k === 'buyer') w.push('c.is_buyer=1'); }
    if (s.get('q')) { w.push('c.name LIKE ?'); a.push('%' + s.get('q') + '%'); }
    const rows = await all(`SELECT c.name,c.country,c.origin,c.is_seller,c.is_buyer,c.created_at,
      (SELECT email FROM contact_emails WHERE contact_id=c.id ORDER BY is_primary DESC LIMIT 1) email,
      (SELECT phone FROM contact_phones WHERE contact_id=c.id ORDER BY is_primary DESC LIMIT 1) phone
      FROM contacts c WHERE ${w.join(' AND ')} ORDER BY c.id`, ...a);
    const cell = v => { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    const out = ['Email Address,First Name,Last Name,Phone,Country,Source,Type,Added'];
    for (const r of rows) { const parts = (r.name || '').trim().split(/\s+/), first = parts.shift() || '', last = parts.join(' '); out.push([r.email, first, last, r.phone, r.country, r.origin, [r.is_buyer ? 'Buyer' : '', r.is_seller ? 'Seller' : ''].filter(Boolean).join('/'), (r.created_at || '').slice(0, 10)].map(cell).join(',')); }
    return new Response('\ufeff' + out.join('\r\n'), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="irg-contacts-' + new Date().toISOString().slice(0, 10) + '.csv"' } });
  }
  if (p === '/contacts' && m === 'POST') {
    const b = await body();
    const d = pick(b, CONTACT_FIELDS); d.created_at = now(); d.created_reliable = 1;
    const id = (await one('SELECT COALESCE(MAX(id),0)+1 n FROM contacts')).n;
    const k = ['id', ...Object.keys(d)];
    const st = [q(`INSERT INTO contacts(${k.join(',')}) VALUES(${k.map(() => '?').join(',')})`, id, ...Object.values(d))];
    (b.emails || []).forEach((e, i) => e && st.push(q('INSERT INTO contact_emails(contact_id,email,is_primary) VALUES(?,?,?)', id, e.toLowerCase(), i ? 0 : 1)));
    (b.phones || []).forEach((e, i) => e && st.push(q('INSERT INTO contact_phones(contact_id,phone,phone_raw,is_primary) VALUES(?,?,?,?)', id, e, e, i ? 0 : 1)));
    await batch(st); return json({ id });
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
      const enq = await all('SELECT r.reference,(SELECT id FROM properties WHERE reference=r.reference LIMIT 1) property_id FROM contact_refs r WHERE r.contact_id=?', id);
      const dups = await all('SELECT DISTINCT c.id,c.name FROM contact_emails e JOIN contact_emails f ON f.email=e.email AND f.contact_id<>e.contact_id JOIN contacts c ON c.id=f.contact_id WHERE e.contact_id=?', id);
      return json({ ...c, emails, phones, notes, owned, enquired: enq, searches, events, duplicates: dups });
    }
    if (m === 'PUT') {
      const b = await body(), st = [];
      const u = upd('contacts', id, pick(b, CONTACT_FIELDS)); if (u) st.push(u);
      if (b.emails) { st.push(q('DELETE FROM contact_emails WHERE contact_id=?', id)); b.emails.filter(Boolean).forEach((e, i) => st.push(q('INSERT INTO contact_emails(contact_id,email,is_primary) VALUES(?,?,?)', id, e.trim().toLowerCase(), i ? 0 : 1))); }
      if (b.phones) { st.push(q('DELETE FROM contact_phones WHERE contact_id=?', id)); b.phones.filter(Boolean).forEach((e, i) => st.push(q('INSERT INTO contact_phones(contact_id,phone,phone_raw,is_primary) VALUES(?,?,?,?)', id, e.trim(), e.trim(), i ? 0 : 1))); }
      if (st.length) await batch(st); return json({ ok: 1 });
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
    if (st === 'live') w.push("status='active'", 'sold=0', 'visible_on_website=1');
    else if (st === 'sold') w.push('sold=1'); else if (st) { w.push('status=?', 'sold=0'); a.push(st); }
    if (s.get('online')) w.push('visible_on_website=1');
    if (s.get('featured')) w.push('featured=1');
    if (s.get('type')) { w.push('property_type=?'); a.push(s.get('type')); }
    if (s.get('label')) { w.push('id IN (SELECT property_id FROM property_labels WHERE label_id=?)'); a.push(+s.get('label')); }
    const where = w.length ? 'WHERE ' + w.join(' AND ') : '';
    const rows0 = await all(`SELECT p.id,p.reference,p.status,p.sold,p.visible_on_website,p.featured,p.property_type,p.typology,p.city,p.locality,p.zone,p.price,p.bedrooms,p.created_at,
      (SELECT source_url FROM photos WHERE property_id=p.id AND visible=1 ORDER BY position LIMIT 1) photo,
      (SELECT GROUP_CONCAT(c.name, ', ') FROM property_owners o JOIN contacts c ON c.id=o.contact_id WHERE o.property_id=p.id) owners,
      (SELECT GROUP_CONCAT(l.name||'~'||l.public||'~'||COALESCE(l.color,''), '|') FROM property_labels pl JOIN label_defs l ON l.id=pl.label_id WHERE pl.property_id=p.id) labels
      FROM properties p ${where} ORDER BY CAST(reference AS INTEGER) DESC, id DESC LIMIT ? OFFSET ?`, ...a, per + 1, (page - 1) * per);
    return json({ total: null, hasMore: rows0.length > per, page, per, rows: rows0.slice(0, per) });
  }
  if (p === '/properties' && m === 'POST') {
    const b = await body(), d = pick(b, PROP_FIELDS); d.created_at = now(); d.status ||= 'pending';
    const id = (await one('SELECT COALESCE(MAX(id),0)+1 n FROM properties')).n;
    if (!d.reference) d.reference = String(((await one('SELECT MAX(CAST(reference AS INTEGER)) n FROM properties')).n || 0) + 1);
    const k = ['id', ...Object.keys(d)];
    await q(`INSERT INTO properties(${k.join(',')}) VALUES(${k.map(() => '?').join(',')})`, id, ...Object.values(d)).run();
    return json({ id });
  }
  if (p === '/properties/bulk' && m === 'POST') {
    const b = await body(), ids = (b.ids || []).map(Number).filter(Boolean).slice(0, 200);
    if (!ids.length) return json({ error: 'nothing selected' }, 400);
    const ph = ids.map(() => '?').join(',');
    if (b.action === 'delete') { for (const id of ids) await deleteProperty(id); }
    else {
      const set = { inactive: "status='inactive'", active: "status='active',sold=0", sold: "sold=1,visible_on_website=0", hide: 'visible_on_website=0', show: 'visible_on_website=1', noexport: 'block_export=1', export: 'block_export=0', feature: 'featured=1', unfeature: 'featured=0' }[b.action];
      if (!set) return json({ error: 'unknown action' }, 400);
      await q(`UPDATE properties SET ${set} WHERE id IN (${ph})`, ...ids).run();
    }
    await q("DELETE FROM stats WHERE key LIKE 'photo%'").run();
    return json({ ok: ids.length });
  }
  if ((r = p.match(/^\/photos\/(\d+)\/file$/)) && m === 'GET') {          // original (default), stamped (?wm=1) or download (?dl=1)
    const ph = await one('SELECT p.*,pr.reference FROM photos p JOIN properties pr ON pr.id=p.property_id WHERE p.id=?', +r[1]);
    if (!ph) return json({ error: 'not found' }, 404);
    let src;
    if (ph.r2_key && ph.r2_key !== 'missing') { const o = await env.PHOTOS.get(ph.r2_key); src = o && o.body; }
    else if (ph.source_url) { const f = await fetch(ph.source_url.split('?')[0]); src = f.ok ? f.body : null; }
    if (!src) return json({ error: 'file not available' }, 404);
    const want = url.searchParams.get('wm') === '1';
    let body = src, type = 'image/jpeg';
    if (want) { const out = await stamp(env, url.origin, src, 1600, { ...(await getWm(env)), on: 1 }); if (!out) return json({ error: 'watermark not available' }, 500); body = out; }
    const h = { 'content-type': type, 'cache-control': 'private, max-age=600' };
    if (url.searchParams.get('dl')) h['content-disposition'] = `attachment; filename="IRG-${ph.reference}-${ph.position}${want ? '' : '-original'}.jpg"`;
    return new Response(body, { headers: h });
  }
  if ((r = p.match(/^\/photos\/(\d+)$/)) && m === 'DELETE') {
    const ph = await one('SELECT r2_key FROM photos WHERE id=?', +r[1]);
    await q('DELETE FROM photos WHERE id=?', +r[1]).run();
    if (ph && ph.r2_key && ph.r2_key !== 'missing' && env.PHOTOS) { try { await env.PHOTOS.delete(ph.r2_key); } catch (e) {} }
    return json({ ok: 1 });
  }
  if ((r = p.match(/^\/properties\/(\d+)\/photos$/)) && m === 'POST') {       // one resized JPEG per request
    const id = +r[1]; if (!env.PHOTOS) return json({ error: 'R2 bucket not bound' }, 400);
    const buf = await req.arrayBuffer(); if (!buf.byteLength || buf.byteLength > 12e6) return json({ error: 'photo missing or over 12 MB' }, 400);
    const pos = ((await one('SELECT COALESCE(MAX(position),0) n FROM photos WHERE property_id=?', id)).n) + 1;
    const nid = ((await one('SELECT COALESCE(MAX(id),0)+1 n FROM photos')).n);
    const key = `p/${id}/${nid}.jpg`;
    await env.PHOTOS.put(key, buf, { httpMetadata: { contentType: 'image/jpeg' } });
    await q('INSERT INTO photos(id,property_id,position,visible,r2_key) VALUES(?,?,?,1,?)', nid, id, pos, key).run();
    return json({ id: nid });
  }
  if (p === '/settings/watermark' && m === 'GET') return json({ ...(await getWm(env)), hasLogo: !!(env.PHOTOS && await env.PHOTOS.head('settings/wm.png')), images: !!env.IMAGES });
  if (p === '/settings/watermark' && m === 'PUT') {
    const b = await body(), cur = await getWm(env);
    const v = { on: b.on ? 1 : 0, opacity: Math.min(0.9, Math.max(0.05, +b.opacity || cur.opacity)), size: Math.min(0.6, Math.max(0.08, +b.size || cur.size)), v: Date.now() };
    await q("INSERT INTO app_settings(key,value) VALUES('watermark',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", JSON.stringify(v)).run(); clearWm();
    return json(v);
  }
  if (p === '/settings/watermark/logo' && m === 'GET') { const o = env.PHOTOS && await env.PHOTOS.get('settings/wm.png'); return o ? new Response(o.body, { headers: { 'content-type': 'image/png', 'cache-control': 'no-cache' } }) : new Response('none', { status: 404 }); }
  if (p === '/settings/watermark/logo' && m === 'POST') {
    if (!env.PHOTOS) return json({ error: 'R2 bucket not bound' }, 400);
    const buf = await req.arrayBuffer(); if (!buf.byteLength || buf.byteLength > 4e6) return json({ error: 'logo missing or over 4 MB' }, 400);
    await env.PHOTOS.put('settings/wm.png', buf, { httpMetadata: { contentType: 'image/png' } });
    const cur = await getWm(env); await q("UPDATE app_settings SET value=? WHERE key='watermark'", JSON.stringify({ ...cur, v: Date.now() })).run(); clearWm();
    return json({ ok: 1 });
  }
  if (p === '/labels' && m === 'GET') return json(await all('SELECT l.*,(SELECT COUNT(*) FROM property_labels WHERE label_id=l.id) used FROM label_defs l ORDER BY public DESC,sort,name'));
  if (p === '/labels' && m === 'POST') { const b = await body(); if (!b.name?.trim()) return json({ error: 'name required' }, 400); await q('INSERT OR IGNORE INTO label_defs(name,public,sort,color) VALUES(?,?,50,?)', b.name.trim(), b.public ? 1 : 0, /^#[0-9a-f]{6}$/i.test(b.color || '') ? b.color : '#C9A96E').run(); return json(await one('SELECT * FROM label_defs WHERE name=?', b.name.trim())); }
  if ((r = p.match(/^\/labels\/(\d+)$/))) {
    if (m === 'PUT') { const b = await body(); await q('UPDATE label_defs SET name=COALESCE(?,name),public=COALESCE(?,public),color=COALESCE(?,color) WHERE id=?', b.name || null, b.public ?? null, /^#[0-9a-f]{6}$/i.test(b.color || '') ? b.color : null, +r[1]).run(); return json({ ok: 1 }); }
    if (m === 'DELETE') { await q('DELETE FROM label_defs WHERE id=?', +r[1]).run(); return json({ ok: 1 }); }
  }
  if ((r = p.match(/^\/properties\/(\d+)$/))) {
    const id = +r[1];
    if (m === 'DELETE') { await deleteProperty(id); return json({ ok: 1 }); }
    if (m === 'GET') {
      const pr = await one('SELECT * FROM properties WHERE id=?', id);
      if (!pr) return json({ error: 'not found' }, 404);
      delete pr.raw_json;
      const [texts, features, photos, owners, notes, labels] = await Promise.all([
        all('SELECT * FROM property_texts WHERE property_id=?', id),
        all('SELECT feature_id,value FROM property_features WHERE property_id=?', id),
        all('SELECT id,position,visible,source_url,r2_key FROM photos WHERE property_id=? ORDER BY position', id),
        all('SELECT o.contact_id id,c.name FROM property_owners o LEFT JOIN contacts c ON c.id=o.contact_id WHERE o.property_id=?', id),
        all('SELECT n.*,u.name user FROM notes n LEFT JOIN users u ON u.id=n.user_id WHERE property_id=? ORDER BY created_at DESC', id),
        all('SELECT label_id FROM property_labels WHERE property_id=?', id),
      ]);
      return json({ ...pr, texts, features, photos, owners, notes, labels: labels.map(x => x.label_id) });
    }
    if (m === 'PUT') {
      const b = await body(), st = [];
      const u = upd('properties', id, pick(b, PROP_FIELDS)); if (u) st.push(u);
      if (b.features) {
        st.push(q('DELETE FROM property_features WHERE property_id=?', id));
        b.features.forEach(f => st.push(q('INSERT OR IGNORE INTO property_features VALUES(?,?,?)', id, f.feature_id, f.value ?? null)));
      }
      if (b.labels) { st.push(q('DELETE FROM property_labels WHERE property_id=?', id)); b.labels.forEach(l => st.push(q('INSERT OR IGNORE INTO property_labels VALUES(?,?)', id, +l))); }
      if (b.texts) b.texts.forEach(t => st.push(q('INSERT INTO property_texts(property_id,lang,title,short_description,full_description) VALUES(?,?,?,?,?) ON CONFLICT(property_id,lang) DO UPDATE SET title=excluded.title,short_description=excluded.short_description,full_description=excluded.full_description', id, t.lang, t.title || null, t.short_description || null, t.full_description || null)));
      if (b.owners) { st.push(q('DELETE FROM property_owners WHERE property_id=?', id)); b.owners.forEach(o => st.push(q('INSERT OR IGNORE INTO property_owners VALUES(?,?,?)', id, o, null))); st.push(q('UPDATE contacts SET is_seller=1 WHERE id IN (' + (b.owners.length ? b.owners.map(() => '?').join(',') : 'NULL') + ')', ...b.owners)); }
      if (b.photos) b.photos.forEach((ph, i) => st.push(q('UPDATE photos SET position=?,visible=? WHERE id=? AND property_id=?', i + 1, ph.visible ? 1 : 0, ph.id, id)));
      if (st.length) await batch(st); return json({ ok: 1 });
    }
  }

  // ---------- photo migration: copy from Proppy's CDN into R2 ----------
  if (p === '/admin/photos/status') {
    const r = await stat('photo_status', 120, () => one("SELECT COUNT(*) total, SUM(r2_key IS NOT NULL AND r2_key!='missing') done, SUM(r2_key='missing') missing FROM photos"));
    const miss = r.missing ? await all("SELECT p.id,p.property_id,pr.reference,p.position,p.visible FROM photos p JOIN properties pr ON pr.id=p.property_id WHERE p.r2_key='missing' ORDER BY p.property_id,p.position LIMIT 50") : [];
    const lv = await stat('photo_live', 60, () => one("SELECT COUNT(*) total, SUM(r2_key IS NOT NULL AND r2_key!='missing') done, SUM(r2_key='missing') missing FROM photos WHERE visible=1 AND property_id IN (SELECT id FROM properties WHERE status='active' AND sold=0 AND visible_on_website=1)"));
    return json({ total: r.total, done: r.done || 0, missing: r.missing || 0, missingList: miss, r2: !!env.PHOTOS, live: lv });
  }
  if (p === '/admin/photos/migrate' && m === 'POST') {
    if (!env.PHOTOS) return json({ error: 'R2 bucket not bound' }, 400);
    const b = await body(), limit = Math.min(+b.limit || 8, 15), width = +b.width || 2000;
    // live (active, unsold, on-website) properties first, so the watermark reaches the public photos before the archive
    if (!memo.liveIds || Date.now() - memo.liveIds.t > 600000) memo.liveIds = { t: Date.now(), v: (await all("SELECT id FROM properties WHERE status='active' AND sold=0 AND visible_on_website=1")).map(x => x.id) };
    const live = memo.liveIds.v;
    let rows = live.length ? await all(`SELECT id,property_id,source_url FROM photos WHERE r2_key IS NULL AND source_url IS NOT NULL AND visible=1 AND property_id IN (${live.map(() => '?').join(',')}) ORDER BY property_id,position LIMIT ?`, ...live, limit) : [];
    if (!rows.length) rows = await all('SELECT id,property_id,source_url FROM photos WHERE r2_key IS NULL AND source_url IS NOT NULL ORDER BY property_id,position LIMIT ?', limit);
    const fails = [], gone = []; let bytes = 0;
    const results = await Promise.all(rows.map(async (ph) => {
      try {
        const clean = ph.source_url.split('?')[0];
        let res = await fetch(`${clean}?width=${width}`);
        if (!res.ok) res = await fetch(clean);
        if (res.status === 404) { gone.push(ph.id); return q("UPDATE photos SET r2_key='missing' WHERE id=?", ph.id); }
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const key = `p/${ph.property_id}/${ph.id}.jpg`;
        let data = res.body;                                   // same size as uploads: 1600 x 1200, compressed
        if (env.IMAGES) { try { data = (await env.IMAGES.input(res.body).transform({ width: 1600, height: 1200, fit: 'cover' }).output({ format: 'image/jpeg', quality: 82 })).image(); } catch (e) { fails.push({ id: ph.id, error: 'resize: ' + e }); return null; } }
        const obj = await env.PHOTOS.put(key, data, { httpMetadata: { contentType: 'image/jpeg' } });
        bytes += obj.size || 0;
        return q('UPDATE photos SET r2_key=? WHERE id=?', key, ph.id);
      } catch (e) { fails.push({ id: ph.id, error: String(e.message || e) }); return null; }
    }));
    const st = results.filter(Boolean);
    if (st.length) await batch(st);
    // only count what is left when this batch came back short (avoids re-scanning the table every call: D1 free tier = 5M row reads/day)
    return json({ copied: st.length - gone.length, missing: gone.length, failed: fails, remaining: rows.length < limit && !gone.length ? 0 : 1, bytes });
  }

  // ---------- features (custom ones allowed) ----------
  if (p === '/features' && m === 'GET') {
    const f = await all('SELECT * FROM feature_defs ORDER BY grp,sort,label_pt');
    if (url.searchParams.get('usage')) { const u = Object.fromEntries((await all('SELECT feature_id,COUNT(*) n FROM property_features GROUP BY feature_id')).map(x => [x.feature_id, x.n])); f.forEach(x => (x.used = u[x.id] || 0)); }
    return json(f);
  }
  if (p === '/features' && m === 'POST') {
    const b = await body();
    const id = (await one('SELECT MAX(MAX(id),100000)+1 n FROM feature_defs')).n;
    await q('INSERT INTO feature_defs(id,kind,label_pt,label_en,grp,custom) VALUES(?,?,?,?,?,1)', id, b.kind || 'bit', b.label_pt || b.label_en, b.label_en || null, b.grp || 'general').run();
    return json({ id });
  }
  if ((r = p.match(/^\/features\/(\d+)$/))) {
    if (m === 'PUT') { const b = await body(); await q('UPDATE feature_defs SET label_pt=COALESCE(?,label_pt),label_en=COALESCE(?,label_en),grp=COALESCE(?,grp),active=COALESCE(?,active) WHERE id=?', b.label_pt ?? null, b.label_en ?? null, b.grp ?? null, b.active ?? null, +r[1]).run(); return json({ ok: 1 }); }
    if (m === 'DELETE') { await batch([q('DELETE FROM property_features WHERE feature_id=?', +r[1]), q('DELETE FROM feature_defs WHERE id=?', +r[1])]); return json({ ok: 1 }); }
  }
  if (p === '/users' && m === 'POST') { const b = await body(); await q('INSERT INTO users(name,email,role) VALUES(?,?,?)', b.name, b.email || null, b.role || 'agent').run(); await q("DELETE FROM stats WHERE key='lookups'").run(); return json({ ok: 1 }); }

  return json({ error: 'not found' }, 404);
  }
}

// ---------- public API for the website (bypass Cloudflare Access for /api/public/*, protected by SITE_KEY) ----------
const TYPE_EN = { 'Moradia': 'Villa', 'Moradia Duplex': 'Villa', 'Quinta': 'Villa', 'Moradia Geminada': 'Townhouse', 'Moradia em Banda': 'Townhouse', 'Apartamento': 'Apartment', 'Penthouse': 'Apartment', 'Andar moradia': 'Apartment', 'Terreno': 'Land', 'Terreno urbano': 'Land', 'Terreno rústico': 'Land', 'Loja / comércio': 'Commercial', 'Armazém': 'Commercial', 'Restaurante / snack': 'Commercial', 'Hotel': 'Commercial', 'Prédio': 'Building', 'Empreendimento': 'Development', 'Ruína': 'Ruin' };
const COND_EN = { 'Novo': 'New', 'Usado': 'Used', 'Renovado': 'Renovated', 'Em construção': 'Under construction', 'Para recuperar': 'To renovate', 'Para renovar': 'To renovate', 'Em planta': 'Off plan', 'Bom': 'Good' };
const KNOWN_AREAS = ['Quinta do Lago', 'Vale do Lobo', 'Vilamoura', 'São Lourenço', 'Quarteira', 'Almancil'];
const tidy = (s) => (s || '').replace(/\s*\(.*\)\s*/, '').trim();


// Shared by the website form and the portal-email intake: match contact by email, else create; add note + follow-up task.
async function recordLead(db, b) {
  const email = String(b.email).trim().toLowerCase().slice(0, 160);
  const name = String(b.name || email).slice(0, 120), msg = String(b.message || '').slice(0, 3000);
  let phone = String(b.phone || '').replace(/[^\d+]/g, '').slice(0, 30);
  if (/^351\d{9}$/.test(phone)) phone = '+' + phone;
  const origin = b.origin || 'Website', src = b.source || 'website';
  const nowIso = new Date().toISOString().slice(0, 16);
  let reads = 0, created = false;
  const c = await db.prepare('SELECT contact_id id FROM contact_emails WHERE email=? LIMIT 1').bind(email).first();
  let id;
  if (c) { id = c.id; await db.prepare('UPDATE contacts SET is_buyer=1 WHERE id=? AND is_seller=0 AND is_buyer=0').bind(id).run(); }
  else {
    id = (await db.prepare('SELECT COALESCE(MAX(id),0)+1 n FROM contacts').first()).n; created = true;
    const st = [db.prepare("INSERT INTO contacts(id,name,origin,created_at,created_reliable,gdpr_consent,gdpr_consent_date,is_buyer) VALUES(?,?,?,?,1,1,?,1)").bind(id, name, origin, nowIso, nowIso),
      db.prepare('INSERT INTO contact_emails(contact_id,email,is_primary) VALUES(?,?,1)').bind(id, email)];
    if (phone) st.push(db.prepare('INSERT INTO contact_phones(contact_id,phone,phone_raw,is_primary) VALUES(?,?,?,1)').bind(id, phone, phone));
    await db.batch(st);
  }
  let pid = null;
  if (b.reference) pid = (await db.prepare('SELECT id FROM properties WHERE reference=? LIMIT 1').bind(String(b.reference)).first())?.id || null;
  if (b.reference) await db.prepare('INSERT OR IGNORE INTO contact_refs(contact_id,reference) VALUES(?,?)').bind(id, String(b.reference).toUpperCase().slice(0, 24)).run();
  const title = b.title || (b.reference ? `Enquiry ${b.reference}` : `${origin} enquiry`);
  const extra = [b.url, b.portalRef && !b.url ? `Portal ref ${b.portalRef}` : ''].filter(Boolean).join('\n');
  await db.batch([
    db.prepare('INSERT INTO notes(contact_id,property_id,body,source,created_at) VALUES(?,?,?,?,?)').bind(id, pid, `[${origin}] ${title}\n${msg}${extra ? '\n' + extra : ''}${b.reference && !pid ? `\n(Property ref ${b.reference} not found in CRM)` : ''}`.trim(), src, nowIso),
    db.prepare('INSERT INTO events(contact_id,property_id,kind,title,due_at) VALUES(?,?,?,?,?)').bind(id, pid, 'lead', `Reply: ${title}`, nowIso.slice(0, 10)),
  ]);
  return { id, created, reads };
}

const textOn = (hex) => { const m = /^#([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return '#ffffff'; const n = parseInt(m[1], 16), l = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)); return l > 175 ? '#2A2A2A' : '#ffffff'; };
async function publicApi(req, env, url) {
  if (url.pathname.startsWith('/api/public/img/') && req.method === 'GET') {
    const k = decodeURIComponent(url.pathname.slice('/api/public/img/'.length));
    if (!env.PHOTOS || !/^[\w\/.\-]+$/.test(k)) return new Response('not found', { status: 404 });
    const o = await env.PHOTOS.get(k);
    if (!o) return new Response('not found', { status: 404 });
    const hdr = { 'cache-control': 'public, max-age=31536000, immutable' };
    const wm = await getWm(env);
    if (wm.on && env.IMAGES) {
      const ck = new Request(url.origin + '/__wm/' + wm.v + '/' + k), cache = caches.default;
      const hit = await cache.match(ck); if (hit) return hit;
      try {
        const out = await stamp(env, url.origin, o.body, 1600, wm);
        const res = new Response(out, { headers: { 'content-type': 'image/jpeg', ...hdr } });
        await cache.put(ck, res.clone()); return res;
      } catch (e) { console.log('watermark failed', k, String(e)); const o2 = await env.PHOTOS.get(k); return new Response(o2.body, { headers: { 'content-type': o2.httpMetadata?.contentType || 'image/jpeg', 'cache-control': 'public, max-age=300' } }); }
    }
    return new Response(o.body, { headers: { 'content-type': o.httpMetadata?.contentType || 'image/jpeg', etag: o.httpEtag, ...hdr } });
  }
  const key = req.headers.get('x-site-key');
  if (!env.SITE_KEY || key !== env.SITE_KEY) return json({ error: 'unauthorised' }, 401);
  const db = env.DB, p = url.pathname.replace('/api/public', '');
  let reads = 0;
  const all = async (s, ...a) => { const r = await db.prepare(s).bind(...a).all(); reads += r.meta?.rows_read || 0; return r.results; };

  if (p === '/listings' && req.method === 'GET') {
    const memoKey = 'listings:' + url.origin;
    if (memo[memoKey] && Date.now() - memo[memoKey].t < 300000) return json(memo[memoKey].v);
    const props = await all("SELECT * FROM properties WHERE status='active' AND sold=0 AND visible_on_website=1");
    const ids = props.map(x => x.id);
    if (!ids.length) { await addReads(db, reads); return json([]); }
    const ph = ids.map(() => '?').join(',');
    const [texts, photos, feats, users, lbls] = await Promise.all([
      all(`SELECT * FROM property_texts WHERE lang='en' AND property_id IN (${ph})`, ...ids),
      all(`SELECT property_id,source_url,r2_key FROM photos WHERE visible=1 AND (r2_key IS NULL OR r2_key!='missing') AND property_id IN (${ph}) ORDER BY property_id,position`, ...ids),
      all(`SELECT pf.property_id,pf.value,f.id,f.kind,f.grp,f.label_en,f.label_pt FROM property_features pf JOIN feature_defs f ON f.id=pf.feature_id WHERE f.active=1 AND pf.property_id IN (${ph})`, ...ids),
      all('SELECT id,name,email FROM users'),
      all(`SELECT pl.property_id,l.name,l.color FROM property_labels pl JOIN label_defs l ON l.id=pl.label_id WHERE l.public=1 AND pl.property_id IN (${ph}) ORDER BY l.sort`, ...ids),
    ]);
    const wmv = (await getWm(env)).v;
    const by = (rows) => rows.reduce((m, r) => ((m[r.property_id] ||= []).push(r), m), {});
    const T = Object.fromEntries(texts.map(t => [t.property_id, t])), PH = by(photos), FE = by(feats), LB = by(lbls), U = Object.fromEntries(users.map(u => [u.id, u]));
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
        id: r.id, reference: r.reference || String(r.id), title, status: 'active', badge: (LB[r.id] || [])[0]?.name || null, badgeColor: (LB[r.id] || [])[0]?.color || null, badgeText: textOn((LB[r.id] || [])[0]?.color), type, typology: r.typology || '',
        price: r.price_visible ? r.price : null, bedrooms: r.bedrooms, bathrooms: r.bathrooms,
        livingArea: r.area_house || null, plotArea: r.area_land || null, totalArea: r.area_gross || null,
        constructionYear: r.year_built, condition: COND_EN[r.condition] || r.condition || '', energyRating: r.energy_rating || '',
        location: { area, city: tidy(r.city), region: 'Algarve', lat: r.latitude || null, lng: r.longitude || null },
        description: (t.full_description || t.short_description || '').split(/\n+/).map(x => x.trim()).filter(Boolean),
        glance, features: Object.entries(categories).map(([category, items]) => ({ category, items })), featuresFlat: fs.map(f => f.label_en || f.label_pt),
        photos: (PH[r.id] || []).map((x, i) => ({ url: x.r2_key ? `${url.origin}/api/public/img/${x.r2_key}?v=${wmv}` : x.source_url, alt: `${title}, photo ${i + 1}`, category: '' })),
        labels: (LB[r.id] || []).map(x => x.name),
        video: null, floorplan: null, agent: null, featured: !!r.featured,
        publishedAt: published, updatedAt: null,
      };
    });
    memo[memoKey] = { t: Date.now(), v: out };
    await addReads(db, reads);
    return json(out);
  }

  if (p === '/inbound' && req.method === 'POST') {          // portal enquiry emails posted by the Gmail script
    const b = await req.json();
    const lead = parseLead({ from: b.from, replyTo: b.replyTo, subject: b.subject, text: b.text });
    if (!lead) return json({ ok: 1, skipped: 'not a recognised portal email' });
    const r = await recordLead(db, { ...lead, title: lead.reference ? `Enquiry ${lead.reference}` : lead.subject, source: 'portal-email' });
    reads += r.reads; await addReads(db, reads);
    return json({ ok: 1, contact: r.id, created: r.created, origin: lead.origin });
  }
  if (p === '/leads' && req.method === 'POST') {
    const b = await req.json();
    if (!b.email) return json({ error: 'email required' }, 400);
    const r = await recordLead(db, { origin: 'Website', name: b.name, email: b.email, phone: b.phone, message: b.message, reference: b.reference, title: b.title, source: 'website' });
    reads += r.reads;
    await addReads(db, reads);
    return json({ ok: 1, contact: r.id });
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
