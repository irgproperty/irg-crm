# Deploy to Cloudflare

Run these on any computer with Node 20+ (`git clone https://github.com/irgproperty/irg-crm`, then `npm install`).

1. `npx wrangler login`  (opens the browser, sign in to Cloudflare)
2. `npx wrangler d1 create irg-crm`  -> copy the `database_id` into `wrangler.toml`
3. `npx wrangler d1 execute irg-crm --remote --file schema.sql`
4. `python tools/make_sql.py <path to irg_crm.db from Dropbox> sql_out`
5. `bash tools/load.sh sql_out --remote`   (about 40 files, a few minutes)
6. `npx wrangler secret put SITE_KEY`   (any long random string; the website uses the same value as CRM_SITE_KEY)
7. `npx wrangler deploy`   -> gives https://irg-crm.<account>.workers.dev
8. Zero Trust > Access > Applications > Add self-hosted: the worker URL, policy = allow your emails.
   Add a second application for path `/api/public/*` with a Bypass policy (everyone).
   Then `npx wrangler secret put ACCESS_TEAM_DOMAIN` (e.g. yourteam.cloudflareaccess.com) and
   `npx wrangler secret put ACCESS_AUD` (the Application Audience tag of the first application).
Until step 8 is done the CRM refuses all requests except /api/public/* (it fails closed).

## Portal feeds (pull)
- Kyero v3: `https://irg-crm.irgproperty-crm.workers.dev/api/feed/kyero.xml?key=<FEED_KEY>`
- Needs secret `FEED_KEY` (`npx wrangler secret put FEED_KEY`) and the Cloudflare Access bypass policy to include path `/api/feed/*` (same as `/api/public/*`).
- Includes only: active, not sold, visible on website, not "block export", sale. (Local data: 36 of the 59 website listings; the other 23 have block_export=1.)
- Rebuilt at most every 30 min (memory cache), ~4.5k D1 reads per rebuild.

## Portal enquiry emails -> CRM
Parsers in `src/inbound.js` (A Place in the Sun, Idealista, Rightmove tested on real samples in `samples/`; other portals fall back to a generic parser). Worker `email()` handler creates/matches the contact by email, adds a note and a follow-up task, and links the property by your own reference. Run `node test_inbound.mjs` to re-test parsers.
Needs a Cloudflare Email Routing address on a domain whose DNS is on Cloudflare, pointing at Worker `irg-crm`; Hostinger mailbox portugal@ auto-forwards to it.
