'use strict';

const list = (value) => value.split(',').map((s) => s.trim()).filter(Boolean);

module.exports = {
  port: Number(process.env.PORT || 8080),
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  // PostgreSQL is configured with the standard PG* variables, read by the pg driver itself.
  // In Kubernetes PGHOST points at the read-only replicas: results may lag the primary slightly.
  pgPoolMax: Number(process.env.PG_POOL_MAX || 5),
  voteOptions: list(process.env.VOTE_OPTIONS || 'cat,dog'),
  cloudName: process.env.CLOUD_NAME || 'local',
  appVersion: process.env.APP_VERSION || 'dev',
};
