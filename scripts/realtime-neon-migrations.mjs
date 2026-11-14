#!/usr/bin/env node
// Finishes Supabase Realtime's tenant migrations on Neon.
//
// Realtime migrates the tenant database (schema `realtime`) itself, the first
// time a client connects. A few of those migrations create functions with
// `SET log_min_messages TO 'fatal'`, which only a superuser may do, and Neon
// has none. They fail, and every migration after them never runs.
//
// This script loops: it nudges Realtime to migrate (by joining a channel),
// reads how far `realtime.schema_migrations` got, and when the next pending
// migration is one of the superuser-only ones, applies it itself with the
// `SET log_min_messages` clause removed and records it as done. Repeat until
// nothing is pending.
//
//   DATABASE_URL=postgresql://neondb_owner:...@ep-xxx.neon.tech/neondb?sslmode=require \
//   SUPABASE_URL=https://<gateway domain> ANON_KEY=... REALTIME_VERSION=v2.148.3 \
//   node scripts/realtime-neon-migrations.mjs
//
// Migration sources are read from github.com/supabase/realtime at
// REALTIME_VERSION (must match the image tag of the realtime service).
import { Pool, neonConfig } from '@neondatabase/serverless';
import { createClient } from '@supabase/supabase-js';
import ws from 'ws';

neonConfig.webSocketConstructor = ws;

const { DATABASE_URL, SUPABASE_URL, ANON_KEY } = process.env;
const VERSION = process.env.REALTIME_VERSION || 'v2.148.3';
if (!DATABASE_URL || !SUPABASE_URL || !ANON_KEY) {
  console.error('DATABASE_URL, SUPABASE_URL and ANON_KEY are required.');
  process.exit(1);
}

const RAW = `https://raw.githubusercontent.com/supabase/realtime/${VERSION}/lib/realtime/tenants`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
  return res.text();
}

// [{ version: '20230328144023', module: 'CreateListChangesFunction' }, ...]
async function listMigrations() {
  const src = await fetchText(`${RAW}/migrations.ex`);
  return [
    ...src.matchAll(/\{([0-9_]{14,}), Migrations\.([A-Za-z0-9]+)\}/g),
  ].map((m) => ({ version: m[1].replaceAll('_', ''), module: m[2] }));
}

// The migration file names are not derivable from the module names in every
// case, so find the file by searching candidates.
async function fetchMigrationSource({ version, module }) {
  const snake = module
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
  const candidates = [
    snake,
    `${snake}_`,
    snake.replace(/re_add/, 'readd'),
    snake.replace(/([a-z])(\d)/g, '$1_$2'),
  ];
  for (const name of candidates) {
    const res = await fetch(`${RAW}/repo/migrations/${version}_${name}.ex`);
    if (res.ok) return res.text();
  }
  throw new Error(`source for ${version} ${module} not found`);
}

// Elixir `execute("""...""")` / `execute(~S"""...""")` / `execute("...")`
// bodies -> SQL, minus the superuser-only clause.
function toSql(src) {
  const out = [];
  const re = /execute\(\s*(~S)?("""\n([\s\S]*?)\n\s*"""|"((?:[^"\\]|\\.)*)")/g;
  for (const m of src.matchAll(re)) {
    let body = m[3] ?? m[4];
    if (body.includes('#{'))
      throw new Error('string interpolation is not supported');
    if (!m[1]) body = body.replace(/\\\\/g, '\\').replace(/\\"/g, '"');
    body = body.replace(/^\s*set log_min_messages to 'fatal'\s*$/gim, '');
    out.push(body.trim().replace(/;\s*$/, ''));
  }
  if (!out.length) throw new Error('no execute() calls found');
  return out.join(';\n') + ';';
}

async function nudgeRealtime() {
  const sb = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false },
  });
  await new Promise((resolve) => {
    const ch = sb.channel(`migrate-${Date.now()}`).subscribe(() => {});
    setTimeout(() => {
      sb.removeChannel(ch).finally(resolve);
    }, 8000);
  });
}

const pool = new Pool({ connectionString: DATABASE_URL });
const client = await pool.connect();
try {
  const migrations = await listMigrations();
  for (let round = 0; round < 20; round++) {
    await nudgeRealtime();
    await sleep(3000);
    const done = new Set(
      (
        await client.query(
          'SELECT version::text AS v FROM realtime.schema_migrations'
        )
      ).rows.map((r) => r.v)
    );
    const next = migrations.find((m) => !done.has(m.version));
    if (!next) {
      console.log(
        `realtime: all ${migrations.length} tenant migrations applied`
      );
      break;
    }
    const src = await fetchMigrationSource(next).catch(() => '');
    if (!/log_min_messages/i.test(src)) {
      console.log(
        `realtime: waiting on ${next.version} ${next.module} (applied by Realtime itself)`
      );
      await sleep(5000);
      continue;
    }
    console.log(
      `realtime: applying ${next.version} ${next.module} without SET log_min_messages`
    );
    await client.query('BEGIN');
    try {
      await client.query(toSql(src));
      await client.query(
        'INSERT INTO realtime.schema_migrations (version, inserted_at) VALUES ($1, now()) ON CONFLICT DO NOTHING',
        [next.version]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    }
  }
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
  process.exit();
}
