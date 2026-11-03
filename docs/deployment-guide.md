# Deployment guide

Target: a Supabase project (database, Auth, Edge Functions) and a Netlify site. Both free tiers are enough.

## 1. Supabase project

1. Create a project; choose a region near users.
2. In **SQL Editor**, run each file in `supabase/migrations/` in name order.
3. Create the administrator in **Authentication → Users** (email + password, auto-confirm), then run:
   ```sql
   insert into public.admins (user_id)
   select id from auth.users where email = 'admin@example.org';
   ```
4. **Authentication → Sign In / Providers:** turn off "Allow new users to sign up". Students and team members are created by the server functions.

## 2. Edge Functions

Deploy `student-login`, `staff-login`, `admin-export`, `admin-credentials`, `admin-team` and `coordinator-api`.

- **CLI:** `supabase functions deploy <name>` for each.
- **Dashboard editor:** `npm run bundle:functions`, then paste each file from `deploy/functions/` into a function of the same name.

Turn **off** "Verify JWT with legacy secret" for all six; each function verifies its caller itself (`supabase/config.toml`). Optional secret: `ALLOWED_ORIGINS` = your site address, to restrict CORS.

## 3. Website

```bash
cp .env.example .env     # VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY (publishable key only)
npm install
npm run build:web
node scripts/security-headers.mjs dist-web https://YOUR-PROJECT.supabase.co
```

Upload the `dist-web/` folder to Netlify (drag and drop on the site's **Deploys** page). It contains `index.html`, `_headers` and `_redirects`. Rebuild and re-run the headers script after any change: the CSP pins the exact script hash.

## 4. Before real use

- Issue random student codes: **Settings → Student access codes → reset all**. Do not use `supabase/prototype-codes.sql` outside testing.
- Turn on the administrator's two-step verification (**Settings**).
- Export the Excel file regularly as a backup.

## 5. Updating a live project

- Apply only new migration files; every migration from `20261027000000` on is written to be safe to run twice and deletes no data.
- Never re-run the first migrations on a project that already has data.
- Deploy changed functions, then the rebuilt website, in the same sitting.
