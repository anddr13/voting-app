'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseVote, clientIdFrom, buildEvent } = require('../src/vote');

const options = ['cat', 'dog'];

test('parseVote accepts a known option, case-insensitively', () => {
  assert.deepEqual(parseVote({ option: ' Cat ' }, options), { option: 'cat' });
});

test('parseVote rejects unknown or missing options', () => {
  assert.ok(parseVote({ option: 'parrot' }, options).error);
  assert.ok(parseVote({}, options).error);
  assert.ok(parseVote(undefined, options).error);
});

test('clientIdFrom prefers a well-formed X-Client-Id header', () => {
  const req = { get: () => 'client-12345678', ip: '10.0.0.1' };
  assert.equal(clientIdFrom(req), 'client-12345678');
});

test('clientIdFrom falls back to a stable hash of the IP', () => {
  const req = { get: () => 'bad id!', ip: '10.0.0.1' };
  const id = clientIdFrom(req);
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.equal(id, clientIdFrom(req));
});

test('buildEvent gives every vote its own id', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const a = buildEvent('cat', 'c1', now);
  const b = buildEvent('cat', 'c1', now);
  assert.notEqual(a.voteId, b.voteId);
  assert.equal(a.ts, '2026-01-01T00:00:00.000Z');
});
