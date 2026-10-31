'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseEvent } = require('../src/event');

const options = ['cat', 'dog'];
const encode = (obj) => Buffer.from(JSON.stringify(obj));
const ID = '0b6f3c1e-5d2a-4f7e-9c8b-1a2b3c4d5e6f';

test('parseEvent returns a normalized event', () => {
  const event = parseEvent(
    encode({ voteId: ID, option: 'dog', clientId: 'c1', ts: '2026-01-01T00:00:00Z' }),
    options,
  );
  assert.equal(event.voteId, ID);
  assert.equal(event.option, 'dog');
  assert.equal(event.ts.toISOString(), '2026-01-01T00:00:00.000Z');
});

test('parseEvent rejects poison messages', () => {
  assert.equal(parseEvent(null, options), null);
  assert.equal(parseEvent(Buffer.from('not json'), options), null);
  assert.equal(parseEvent(encode({ option: 'cat' }), options), null);
  assert.equal(parseEvent(encode({ voteId: ID, option: 'parrot' }), options), null);
  // Would fail the uuid column and block the partition, so it goes to the DLQ instead.
  assert.equal(parseEvent(encode({ voteId: 'v1', option: 'cat' }), options), null);
});

test('parseEvent tolerates a broken timestamp', () => {
  const event = parseEvent(encode({ voteId: ID, option: 'cat', ts: 'yesterday' }), options);
  assert.ok(event.ts instanceof Date);
  assert.ok(!Number.isNaN(event.ts.getTime()));
});
