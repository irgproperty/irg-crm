// Watermark settings + stamping. Originals in R2 are never changed; the logo is drawn when a photo is served or downloaded.
const memo = {};
export async function getWm(env) {
  if (memo.wm && Date.now() - memo.wm.t < 60000) return memo.wm.v;
  let v = { on: 1, opacity: 0.3, size: 0.22, v: 1 };
  try { const r = await env.DB.prepare("SELECT value FROM app_settings WHERE key='watermark'").first(); if (r) v = { ...v, ...JSON.parse(r.value) }; } catch (e) {}
  memo.wm = { t: Date.now(), v }; return v;
}
export const clearWm = () => { delete memo.wm; };
async function logo(env, origin) {
  const o = env.PHOTOS && await env.PHOTOS.get('settings/wm.png');
  if (o) return o.body;
  return (await env.ASSETS.fetch(new Request(origin + '/wm.png'))).body;
}
// returns a ReadableStream of the stamped JPEG, or null when stamping is off / unavailable
export async function stamp(env, origin, stream, width, wm) {
  wm = wm || await getWm(env);
  if (!wm.on || !env.IMAGES) return null;
  const out = await env.IMAGES.input(stream).transform({ width }).draw(await logo(env, origin), { opacity: wm.opacity, width: Math.round(width * wm.size) }).output({ format: 'image/jpeg', quality: 85 });
  return out.image();
}
