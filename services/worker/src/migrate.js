'use strict';

// Applies migrations/NNN_*.sql in order, each one at most once.
// Runs as a Job before every rollout (an Argo CD PreSync hook) and as a one-shot service in compose.
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');
const { Client } = require('pg');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
// Any constant works; it only has to be the same for every concurrent run.
const LOCK_ID = 7_001;

function listMigrations(files) {
  return files
    .filter((file) => /^\d+_[\w-]+\.sql$/.test(file))
    .sort()
    .map((file) => ({ version: file.replace(/\.sql$/, ''), file }));
}

// Everything happens in one transaction (DDL is transactional in PostgreSQL): either all pending
// migrations are applied, or none. The advisory lock makes a second run wait instead of racing.
async function migrate(client, dir = MIGRATIONS_DIR, log = console.log) {
  const migrations = listMigrations(fs.readdirSync(dir));
  await client.query('BEGIN');
  try {
    await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_ID]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version    text        PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const { rows } = await client.query('SELECT version FROM schema_migrations');
    const applied = new Set(rows.map((row) => row.version));

    const pending = migrations.filter((m) => !applied.has(m.version));
    for (const { version, file } of pending) {
      log(`applying ${version}`);
      await client.query(fs.readFileSync(path.join(dir, file), 'utf8'));
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
    }
    await client.query('COMMIT');
    return pending.map((m) => m.version);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

// Connection settings come from the standard PG* variables (PGHOST, PGUSER, PGPASSWORD, ...).
// On a fresh cluster the database may still be starting, so connecting is retried for a while.
async function connect(attempts = 30) {
  for (let i = 1; ; i++) {
    const client = new Client({ application_name: 'migrate', connectionTimeoutMillis: 5_000 });
    try {
      await client.connect();
      return client;
    } catch (err) {
      if (i >= attempts) throw err;
      console.log(`database not reachable yet (${err.message}), retrying`);
      await sleep(2_000);
    }
  }
}

async function main() {
  const client = await connect();
  try {
    const applied = await migrate(client);
    console.log(applied.length ? `applied ${applied.join(', ')}` : 'schema is up to date');
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('migration failed:', err);
    process.exit(1);
  });
}

module.exports = { listMigrations, migrate };
