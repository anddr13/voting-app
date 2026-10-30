'use strict';

const { Pool } = require('pg');

// Connection settings come from the standard PG* variables (PGHOST, PGUSER, PGPASSWORD, ...).
function createPool(max) {
  return new Pool({ max, application_name: 'worker', connectionTimeoutMillis: 5_000 });
}

// One statement, so one implicit transaction: the vote is stored and its tally bumped together.
// A redelivered vote hits ON CONFLICT, inserts nothing, and therefore bumps nothing.
const RECORD_VOTE = `
  WITH inserted AS (
    INSERT INTO votes (vote_id, option, client_id, ts)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT (vote_id) DO NOTHING
    RETURNING option
  )
  INSERT INTO tallies (option, count)
  SELECT option, 1 FROM inserted
  ON CONFLICT (option) DO UPDATE SET count = tallies.count + 1
  RETURNING count`;

// Returns the new tally, or null when the vote was already stored (Kafka redelivery).
async function recordVote(pool, event) {
  const { rows } = await pool.query(RECORD_VOTE, [event.voteId, event.option, event.clientId, event.ts]);
  return rows.length ? Number(rows[0].count) : null;
}

module.exports = { createPool, recordVote };
