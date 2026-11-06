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
