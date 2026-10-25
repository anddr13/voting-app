'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeTallies } = require('../src/results');

const options = ['cat', 'dog'];

test('normalizeTallies reads a RESP2 object reply', () => {
  assert.deepEqual(normalizeTallies({ cat: '3', dog: '5' }, options), { cat: 3, dog: 5 });
});

test('normalizeTallies reads a RESP3 Map reply', () => {
  assert.deepEqual(normalizeTallies(new Map([['cat', '7']]), options), { cat: 7, dog: 0 });
});

test('normalizeTallies fills missing options and drops unknown ones', () => {
  assert.deepEqual(normalizeTallies({ parrot: '9' }, options), { cat: 0, dog: 0 });
  assert.deepEqual(normalizeTallies(null, options), { cat: 0, dog: 0 });
});
