'use strict';

const crypto = require('node:crypto');

const CLIENT_ID = /^[\w-]{8,64}$/;

function parseVote(body, options) {
  const option = typeof body?.option === 'string' ? body.option.trim().toLowerCase() : '';
  if (!options.includes(option)) {
    return { error: `option must be one of: ${options.join(', ')}` };
  }
  return { option };
}

// The UI sends a random per-browser id. Without it we fall back to the client IP,
// but only keep a hash of it.
function clientIdFrom(req) {
  const header = req.get('x-client-id');
  if (header && CLIENT_ID.test(header)) return header;
  return crypto.createHash('sha256').update(req.ip || 'unknown').digest('hex').slice(0, 32);
}

function buildEvent(option, clientId, now = new Date()) {
  return { voteId: crypto.randomUUID(), option, clientId, ts: now.toISOString() };
}

module.exports = { parseVote, clientIdFrom, buildEvent };
