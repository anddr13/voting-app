'use strict';

// vote-api sets voteId with crypto.randomUUID(); the votes table stores it as uuid.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Returns a normalized vote event, or null when the message can never be processed.
function parseEvent(value, options) {
  if (!value) return null;

  let raw;
  try {
    raw = JSON.parse(value.toString());
  } catch {
    return null;
  }
  if (!raw || !UUID.test(raw.voteId) || !options.includes(raw.option)) return null;

  const ts = new Date(raw.ts);
  return {
    voteId: raw.voteId,
    option: raw.option,
    clientId: String(raw.clientId ?? ''),
    ts: Number.isNaN(ts.getTime()) ? new Date() : ts,
  };
}

module.exports = { parseEvent };
