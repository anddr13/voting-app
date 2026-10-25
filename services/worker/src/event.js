'use strict';

// Returns a normalized vote event, or null when the message can never be processed.
function parseEvent(value, options) {
  if (!value) return null;

  let raw;
  try {
    raw = JSON.parse(value.toString());
  } catch {
    return null;
  }
  if (!raw || typeof raw.voteId !== 'string' || !options.includes(raw.option)) return null;

  const ts = new Date(raw.ts);
  return {
    voteId: raw.voteId,
    option: raw.option,
    clientId: String(raw.clientId ?? ''),
    ts: Number.isNaN(ts.getTime()) ? new Date() : ts,
  };
}

module.exports = { parseEvent };
