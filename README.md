# IRG CRM

Worker (`src/index.js`) + static UI (`public/index.html`) + D1 database.

## Run locally
    npm install
    npx wrangler d1 execute irg-crm --local --command "select 1"   # creates local DB
    cp ../irg_crm.db .wrangler/state/v3/d1/miniflare-D1DatabaseObject/<the .sqlite file, not metadata>
    npx wrangler dev --local

## Deploy (needs your Cloudflare login)
    npx wrangler d1 create irg-crm            # put the id in wrangler.toml
    npx wrangler d1 execute irg-crm --remote --file schema.sql
    # load data: export irg_crm.db to SQL in chunks (see load_remote.py, next step) 
    npx wrangler deploy
    # then protect the whole site with Cloudflare Access (Zero Trust) – the API trusts its login header.
