'use strict';

// Turns an HGETALL reply (a plain object over RESP2, a Map over RESP3)
// into { option: count } with every configured option present.
function normalizeTallies(raw, options) {
  const result = Object.fromEntries(options.map((option) => [option, 0]));
  const entries = raw instanceof Map ? raw.entries() : Object.entries(raw ?? {});
  for (const [key, value] of entries) {
    const option = String(key);
    if (option in result) result[option] = Number(value) || 0;
  }
  return result;
}

module.exports = { normalizeTallies };
