'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { recordVote } = require('../src/store');

const event = {
  voteId: '0b6f3c1e-5d2a-4f7e-9c8b-1a2b3c4d5e6f',
  option: 'cat',
  clientId: 'c1',
  ts: new Date('2026-01-01T00:00:00Z'),
};

const poolReturning = (rows) => {
  const calls = [];
  return { calls, query: async (sql, params) => (calls.push({ sql, params }), { rows }) };
};

test('recordVote returns the new tally as a number', async () => {
  // pg returns bigint as a string.
  const pool = poolReturning([{ count: '42' }]);
  assert.equal(await recordVote(pool, event), 42);
  assert.deepEqual(pool.calls[0].params, [event.voteId, 'cat', 'c1', event.ts]);
});

test('recordVote returns null for a vote that is already stored', async () => {
  assert.equal(await recordVote(poolReturning([]), event), null);
});

test('recordVote inserts idempotently and bumps the tally in the same statement', async () => {
  const pool = poolReturning([]);
  await recordVote(pool, event);
  const sql = pool.calls[0].sql.replace(/\s+/g, ' ');
  assert.match(sql, /ON CONFLICT \(vote_id\) DO NOTHING/);
  assert.match(sql, /INSERT INTO tallies .* SELECT option, 1 FROM inserted/);
});
