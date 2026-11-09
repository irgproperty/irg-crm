// Parse portal enquiry emails into a lead. Pure functions (no I/O) so they can be tested with plain text.
const clean = (s) => String(s ?? '').replace(/ /g, ' ').replace(/[ \t]+/g, ' ').trim();
const grab = (text, re) => { const m = text.match(re); return m ? clean(m[1]) : ''; };
const addr = (s) => { const m = String(s || '').match(/<([^>]+)>/); return (m ? m[1] : String(s || '')).trim().toLowerCase(); };
const nameOf = (s) => clean(String(s || '').replace(/<[^>]*>/g, '').replace(/["']/g, ''));
const phoneClean = (p) => { p = clean(p).replace(/<tel:[^>]*>/g, '').trim(); return p; };
const stripLinks = (t) => t.replace(/<(?:https?|mailto|tel):[^>]*>/g, '');

const PORTALS = [
  { origin: 'A Place in the Sun', match: (f) => /aplaceinthesun\.com$/.test(f) },
  { origin: 'Idealista', match: (f) => /idealista\.(pt|com)$/.test(f) },
  { origin: 'Rightmove', match: (f) => /rightmove\.co\.uk$/.test(f) },
  { origin: 'Kyero', match: (f) => /kyero\.com$/.test(f) },
  { origin: 'Imovirtual', match: (f) => /imovirtual\.com$/.test(f) },
  { origin: 'Greenacres', match: (f) => /green-acres\.(com|pt|fr)$/.test(f) },
  { origin: 'Zoopla', match: (f) => /zoopla\.co\.uk$/.test(f) },
  { origin: 'James Edition', match: (f) => /jamesedition\.com$/.test(f) },
];

// in: { from, replyTo, subject, text }  out: lead object, or null if not a portal enquiry
export function parseLead({ from, replyTo, subject, text }) {
  const f = addr(from), domain = f.split('@')[1] || '';
  const portal = PORTALS.find((p) => p.match(domain));
  if (!portal) return null;
  const t = stripLinks(String(text || '')).replace(/\r/g, '');
  const lead = { origin: portal.origin, name: '', email: '', phone: '', message: '', reference: '', portalRef: '', url: '', subject: clean(subject) };
  const reply = addr(replyTo);

  if (portal.origin === 'A Place in the Sun') {
    lead.name = grab(t, /^Name:\s*(.+)$/m);
    lead.email = (grab(t, /^Email:\s*(\S+@\S+)/m) || reply).toLowerCase();
    lead.phone = phoneClean(grab(t, /^Telephone:\s*(.+)$/m));
    lead.message = grab(t, /^Comments:\s*([\s\S]*?)\n\s*\n/m);
    lead.reference = grab(t, /^Your Reference:\s*(\S+)/m);
    lead.portalRef = grab(t, /^APITS Reference:\s*(\S+)/m);
    lead.url = (String(text).match(/https:\/\/www\.aplaceinthesun\.com\/property\/details\/\w+/) || [''])[0];
    const when = grab(t, /^When do you intend to buy\?:\s*(.+)$/m);
    if (when) lead.message += `\n(Intends to buy: ${when})`;
  } else if (portal.origin === 'Idealista') {
    const subj = clean(subject);
    lead.name = (subj.match(/mensagem de (.+?) sobre/i) || [])[1] || '';
    lead.email = reply || (t.match(/^(\S+@\S+)\s*$/m) || [])[1] || '';
    // body: after the avatar line: name, phone, email, message, then "Responder a partir"
    const body = (t.split(/empty_avatar\.png/)[1] || t);
    const lines = body.split('\n').map(clean).filter(Boolean);
    const iEmail = lines.findIndex((l) => /^\S+@\S+$/.test(l));
    if (iEmail >= 0) {
      lead.email = lead.email || lines[iEmail];
      lead.phone = lines.slice(0, iEmail).reverse().find((l) => /^\+?[\d\s().-]{7,}$/.test(l)) || '';
      const end = lines.findIndex((l, i) => i > iEmail && /^Responder a partir/i.test(l));
      lead.message = lines.slice(iEmail + 1, end > 0 ? end : iEmail + 6).join('\n');
    }
    lead.reference = (subj.match(/ref:\s*([\w-]+)/i) || [])[1] || grab(t, /^Ref\.\s*(\S+)/m);
    lead.portalRef = grab(t, /Código do anúncio:\s*(\d+)/);
    lead.url = lead.portalRef ? `https://www.idealista.pt/${lead.portalRef}` : '';
  } else if (portal.origin === 'Rightmove') {
    lead.name = grab(t, /^Name:\s*(.+)$/m);
    lead.email = (grab(t, /^Email:\s*(\S+@\S+)/m) || reply).toLowerCase();
    lead.phone = phoneClean(grab(t, /^Phone:\s*(.+)$/m));
    lead.message = grab(t, /^Comments\s*\n([\s\S]*?)\n\s*\n\s*Property\s*$/m) || grab(t, /^Comments\s*\n([\s\S]*?)\n\s*\n/m);
    lead.portalRef = grab(t, /^Reference:\s*(\S+)/m);
    lead.url = (String(text).match(/https:\/\/www\.rightmove\.co\.uk\/properties\/\d+/) || [''])[0];
    const extra = ['Address', 'Price', 'Bedrooms', 'Type'].map((k) => [k, grab(t, new RegExp(`^${k}:\\s*(.+)$`, 'm'))]).filter((x) => x[1]).map((x) => `${x[0]}: ${x[1]}`).join(', ');
    if (extra) lead.message += `\n(Listing: ${extra})`;
  } else {
    // generic fallback for portals we have no sample of yet: keep the whole text so nothing is lost
    lead.name = nameOf(from); lead.email = reply; lead.message = clean(t).slice(0, 2000);
  }
  lead.name = lead.name || nameOf(replyTo) || lead.email;
  lead.message = lead.message.replace(/[ \t]+\n/g, '\n').trim();
  if (!lead.email) return null;
  return lead;
}
