-- One row per vote. The primary key on vote_id (unique, set by vote-api) is what makes a redelivered
-- Kafka message harmless: the worker inserts with ON CONFLICT (vote_id) DO NOTHING.
CREATE TABLE votes (
  vote_id   uuid        PRIMARY KEY,
  option    text        NOT NULL,
  client_id text        NOT NULL,
  ts        timestamptz NOT NULL,
  stored_at timestamptz NOT NULL DEFAULT now()
);

-- Running totals, bumped in the same statement that inserts the vote.
CREATE TABLE tallies (
  option text   PRIMARY KEY,
  count  bigint NOT NULL
);
