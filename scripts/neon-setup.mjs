#!/usr/bin/env node
// Applies SQL to a Neon database over WebSocket/HTTPS (port 443), so it
// works even where outbound 5432 is blocked.
//
//   DATABASE_URL=postgresql://neondb_owner:...@ep-xxx.neon.tech/neondb?sslmode=require \
//   AUTHENTICATOR_PASSWORD=... AUTH_ADMIN_PASSWORD=... STORAGE_ADMIN_PASSWORD=... \
//   node scripts/neon-setup.mjs bootstrap
//
//   DATABASE_URL=... node scripts/neon-setup.mjs migrate
//
// `bootstrap` runs infra/neon/bootstrap.sql (roles, schemas, publication).
// `realtime-tenant` makes Supabase Realtime's tenant connection work on
//             Neon (see realtimeTenant below). Needs REALTIME_DB_ENC_KEY.
// `migrate`   runs every supabase/migrations/*.sql not yet recorded in
//             public._wacrm_migrations, in filename order, each file in
//             its own transaction. Run it AFTER the auth and storage
//             services have booted once (they create auth.* / storage.*).
import { Pool, neonConfig } from '@neondatabase/serverless';
import ws from 'ws';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

neonConfig.webSocketConstructor = ws;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required (use the database owner role).');
  process.exit(1);
}

const pool = new Pool({ connectionString: url });
const client = await pool.connect();

async function bootstrap() {
  let sql = fs.readFileSync(
    path.join(root, 'infra/neon/bootstrap.sql'),
    'utf8'
  );
  for (const key of [
    'AUTHENTICATOR_PASSWORD',
    'AUTH_ADMIN_PASSWORD',
    'STORAGE_ADMIN_PASSWORD',
  ]) {
    const value = process.env[key];
    if (!value || !/^[A-Za-z0-9_-]{16,}$/.test(value)) {
      throw new Error(
        `${key} must be set (16+ chars, letters/digits/-/_ only)`
      );
    }
    sql = sql.replaceAll(`__${key}__`, value);
  }
  await client.query(sql);
  console.log('bootstrap: OK');
}

async function migrate() {
  const missing = await client.query(
    "SELECT to_regclass('auth.users') AS users, to_regclass('storage.objects') AS objects"
  );
  const { users, objects } = missing.rows[0];
  if (!users || !objects) {
    throw new Error(
      'auth.users / storage.objects not found. Boot the auth and storage services first ' +
        '(they create those schemas), then re-run migrate.'
    );
  }
  await client.query(
    'CREATE TABLE IF NOT EXISTS public._wacrm_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())'
  );
  await client.query(
    'REVOKE ALL ON public._wacrm_migrations FROM anon, authenticated'
  );
  const done = new Set(
    (await client.query('SELECT name FROM public._wacrm_migrations')).rows.map(
      (r) => r.name
    )
  );
  const dir = path.join(root, 'supabase/migrations');
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    if (done.has(file)) continue;
    // Neon has no `postgres` superuser; the database owner (BYPASSRLS,
    // owns every table) takes that role for SECURITY DEFINER functions.
    const sql = fs
      .readFileSync(path.join(dir, file), 'utf8')
      .replace(/OWNER TO postgres\b/gi, 'OWNER TO CURRENT_USER');
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query(
        'INSERT INTO public._wacrm_migrations (name) VALUES ($1)',
        [file]
      );
      await client.query('COMMIT');
      console.log(`migrate: ${file} OK`);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      console.error(
        `migrate: ${file} FAILED: ${err.message}${err.where ? `\n  ${err.where}` : ''}`
      );
      throw err;
    }
  }
  // PostgREST caches the schema; ask it to reload.
  await client.query("NOTIFY pgrst, 'reload schema'");
  console.log('migrate: done');
}

// Supabase Realtime opens its per-tenant Postgres connection with TLS but
// without SNI, and Neon needs SNI to know which endpoint to route to. Neon's
// documented fallback is to put the endpoint in the password:
// `endpoint=<endpoint-id>$<password>`. Realtime's own (SNI-capable)
// connection must keep the plain password, so only the seeded tenant's
// stored password is rewritten. It is AES-128-ECB encrypted with DB_ENC_KEY
// (Realtime's legacy cipher, used while DB_ENC_KEY_GCM is unset).
async function realtimeTenant() {
  const key = process.env.REALTIME_DB_ENC_KEY;
  if (!key || Buffer.byteLength(key) !== 16) {
    throw new Error(
      'REALTIME_DB_ENC_KEY must be the 16-char DB_ENC_KEY of the realtime service'
    );
  }
  const parsed = new URL(url);
  const endpointId = parsed.hostname.split('.')[0].replace(/-pooler$/, '');
  const password = decodeURIComponent(parsed.password);
  const cipher = crypto.createCipheriv('aes-128-ecb', Buffer.from(key), null);
  const encrypted = Buffer.concat([
    cipher.update('endpoint=' + endpointId + '$' + password, 'utf8'),
    cipher.final(),
  ]).toString('base64');
  const res = await client.query(
    `UPDATE _realtime.extensions
        SET settings = jsonb_set(settings::jsonb, '{db_password}', to_jsonb($1::text))
      WHERE type = 'postgres_cdc_rls'
      RETURNING tenant_external_id`,
    [encrypted]
  );
  if (res.rowCount === 0) {
    throw new Error(
      'No realtime tenant found. Boot the realtime service once (SEED_SELF_HOST=true) first.'
    );
  }
  console.log(
    `realtime-tenant: updated ${res.rows.map((r) => r.tenant_external_id).join(', ')}; restart the realtime service`
  );
}

const cmd = process.argv[2];
try {
  if (cmd === 'bootstrap') await bootstrap();
  else if (cmd === 'migrate') await migrate();
  else if (cmd === 'realtime-tenant') await realtimeTenant();
  else {
    console.error(
      'usage: node scripts/neon-setup.mjs <bootstrap|migrate|realtime-tenant>'
    );
    process.exitCode = 1;
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
