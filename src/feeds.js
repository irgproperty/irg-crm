// Portal XML feeds (pull model). Built from D1 in a handful of queries, memoised per isolate.
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const cd = (s) => `<![CDATA[${String(s ?? '').replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
const KYERO_TYPE = {
  'Moradia': 'villa', 'Moradia Duplex': 'villa', 'Quinta': 'country-house', 'Moradia Geminada': 'townhouse', 'Moradia em Banda': 'townhouse',
  'Apartamento': 'apartment', 'Penthouse': 'penthouse', 'Andar moradia': 'apartment', 'Terreno': 'plot', 'Terreno urbano': 'plot', 'Terreno rústico': 'plot',
  'Loja / comércio': 'commercial', 'Armazém': 'commercial', 'Restaurante / snack': 'commercial', 'Hotel': 'commercial', 'Prédio': 'building', 'Empreendimento': 'building', 'Ruína': 'ruin',
};
const LANGS = ['en', 'pt', 'fr', 'de', 'es', 'nl', 'it', 'ru', 'sv', 'no', 'da', 'fi'];
const memo = {};

// Everything the feeds need, in 5 queries (no per-property queries).
async function load(env, origin, siteUrl) {
  const db = env.DB; let reads = 0;
  const all = async (s, ...a) => { const r = await db.prepare(s).bind(...a).all(); reads += r.meta?.rows_read || 0; return r.results; };
  const props = await all("SELECT * FROM properties WHERE status='active' AND sold=0 AND visible_on_website=1 AND block_export=0 AND business_type='Venda' ORDER BY id");
  const ids = props.map((x) => x.id);
  if (!ids.length) return { props: [], reads };
  const ph = ids.map(() => '?').join(',');
  const [texts, photos, feats] = await Promise.all([
    all(`SELECT property_id,lang,title,full_description,short_description FROM property_texts WHERE property_id IN (${ph})`, ...ids),
    all(`SELECT property_id,r2_key,source_url FROM photos WHERE visible=1 AND (r2_key IS NULL OR r2_key!='missing') AND property_id IN (${ph}) ORDER BY property_id,position`, ...ids),
    all(`SELECT pf.property_id,pf.feature_id,f.label_en,f.label_pt FROM property_features pf JOIN feature_defs f ON f.id=pf.feature_id WHERE f.active=1 AND f.kind IN ('bit','list') AND pf.property_id IN (${ph})`, ...ids),
  ]);
  const by = (rows) => rows.reduce((m, r) => ((m[r.property_id] ||= []).push(r), m), {});
  const T = by(texts), P = by(photos), F = by(feats);
  return {
    reads,
    props: props.map((r) => ({
      r, texts: T[r.id] || [], feats: F[r.id] || [],
      photos: (P[r.id] || []).map((x) => (x.r2_key ? `${origin}/api/public/img/${x.r2_key}` : x.source_url)).filter(Boolean),
      url: `${siteUrl}/properties/${encodeURIComponent(r.reference || r.id)}`,
    })),
  };
}

export function kyeroXml(props, now = new Date()) {
  const date = (s) => (s || now.toISOString()).replace('T', ' ').slice(0, 19).padEnd(19, ':00').slice(0, 19);
  const out = ['<?xml version="1.0" encoding="UTF-8"?>', '<root>', '<kyero><feed_version>3</feed_version></kyero>'];
  for (const { r, texts, feats, photos, url } of props) {
    const has = (id) => feats.some((f) => f.feature_id === id);
    const desc = {}; for (const t of texts) { const d = t.full_description || t.short_description; if (d && LANGS.includes(t.lang) && !desc[t.lang]) desc[t.lang] = d; }
    if (!desc.en) continue;                                    // Kyero requires English
    const type = KYERO_TYPE[r.property_type] || 'villa';
    out.push('<property>',
      `<id>${esc(r.reference || r.id)}</id>`,
      `<date>${date(r.published_at || r.created_at)}</date>`,
      `<ref>${esc(r.reference || r.id)}</ref>`,
      r.price_visible && r.price ? `<price>${Math.round(r.price)}</price>` : '<price>0</price><price_on_request>1</price_on_request>',
      '<currency>EUR</currency><price_freq>sale</price_freq><part_ownership>0</part_ownership><leasehold>0</leasehold>',
      `<new_build>${r.condition === 'Novo' || r.condition === 'Em construção' || r.condition === 'Em planta' ? 1 : 0}</new_build>`,
      `<type>${type}</type>`,
      `<town>${esc((r.locality || r.city || '').replace(/\s*\(.*\)\s*/, ''))}</town>`,
      `<province>${esc(r.district || 'Algarve')}</province>`,
      r.zone ? `<location_detail>${esc(r.zone)}</location_detail>` : '',
      r.latitude && r.longitude ? `<location><latitude>${r.latitude}</latitude><longitude>${r.longitude}</longitude></location>` : '',
      `<beds>${r.bedrooms || 0}</beds><baths>${r.bathrooms || 0}</baths>`,
      `<pool>${has(2) ? 1 : 0}</pool>`,
      `<surface_area><built>${Math.round(r.area_house || r.area_gross || 0)}</built><plot>${Math.round(r.area_land || 0)}</plot></surface_area>`,
      /^[A-G]$/i.test(r.energy_rating || '') ? `<energy_rating><consumption>${r.energy_rating.toUpperCase()}</consumption></energy_rating>` : '',
      '<url>' + Object.keys(desc).map((l) => `<${l}>${esc(url)}</${l}>`).join('') + '</url>',
      '<desc>' + Object.entries(desc).map(([l, d]) => `<${l}>${cd(d)}</${l}>`).join('') + '</desc>',
      feats.length ? '<features>' + [...new Set(feats.map((f) => f.label_en || f.label_pt))].map((f) => `<feature>${esc(f)}</feature>`).join('') + '</features>' : '',
      '<images>' + photos.slice(0, 50).map((u, i) => `<image id="${i + 1}"><url>${esc(u)}</url></image>`).join('') + '</images>',
      '</property>');
  }
  out.push('</root>');
  return out.filter(Boolean).join('\n');
}

// GET /api/feed/kyero.xml?key=FEED_KEY
export async function feedApi(req, env, url, addReads) {
  const name = url.pathname.replace('/api/feed/', '');
  if (!env.FEED_KEY || url.searchParams.get('key') !== env.FEED_KEY) return new Response('unauthorised', { status: 401 });
  const builders = { 'kyero.xml': kyeroXml };
  if (!builders[name]) return new Response('not found', { status: 404 });
  const mk = name + url.origin;
  if (!memo[mk] || Date.now() - memo[mk].t > 1800e3) {       // rebuilt at most every 30 min however often portals poll
    const siteUrl = env.SITE_URL || 'https://www.irgproperty.com';
    const { props, reads } = await load(env, url.origin, siteUrl);
    await addReads(env.DB, reads);
    memo[mk] = { t: Date.now(), xml: builders[name](props) };
  }
  return new Response(memo[mk].xml, { headers: { 'content-type': 'application/xml; charset=utf-8', 'cache-control': 'public, max-age=1800' } });
}
