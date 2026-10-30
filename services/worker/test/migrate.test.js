'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { listMigrations, migrate } = require('../src/migrate');

test('listMigrations orders by number and skips other files', () => {
  assert.deepEqual(
    listMigrations(['002_b.sql', 'README.md', '001_a.sql', 'notes.sql']).map((m) => m.version),
    ['001_a', '002_b'],
  );
});

test('the shipped migrations are found', () => {
  const dir = path.join(__dirname, '..', 'migrations');
  assert.ok(listMigrations(fs.readdirSync(dir)).length > 0);
});

// A fake client that remembers the statements and knows which versions are already applied.
function fakeClient(applied, failOn = null) {
  const statements = [];
  return {
    statements,
    query: async (sql) => {
      statements.push(sql.trim().split('\n')[0]);
      if (sql === failOn) throw new Error('syntax error');
      return { rows: sql.startsWith('SELECT version') ? applied.map((version) => ({ version })) : [] };
    },
  };
}

test('migrate applies only pending migrations, in one transaction under a lock', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrations-'));
  fs.writeFileSync(path.join(dir, '001_a.sql'), 'CREATE TABLE a ();');
  fs.writeFileSync(path.join(dir, '002_b.sql'), 'CREATE TABLE b ();');

  const client = fakeClient(['001_a']);
  assert.deepEqual(await migrate(client, dir, () => {}), ['002_b']);
  assert.equal(client.statements[0], 'BEGIN');
  assert.match(client.statements[1], /pg_advisory_xact_lock/);
  assert.ok(client.statements.includes('CREATE TABLE b ();'));
  assert.ok(!client.statements.includes('CREATE TABLE a ();'));
  assert.equal(client.statements.at(-1), 'COMMIT');
});

test('migrate rolls back when a migration fails', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrations-'));
  fs.writeFileSync(path.join(dir, '001_a.sql'), 'BROKEN');
  const client = fakeClient([], 'BROKEN');
  await assert.rejects(migrate(client, dir, () => {}), /syntax error/);
  assert.equal(client.statements.at(-1), 'ROLLBACK');
});
