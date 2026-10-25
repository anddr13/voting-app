'use strict';

const list = (value) => value.split(',').map((s) => s.trim()).filter(Boolean);

module.exports = {
  port: Number(process.env.PORT || 8080),
  kafkaBrokers: list(process.env.KAFKA_BROKERS || 'localhost:9092'),
  kafkaTopic: process.env.KAFKA_TOPIC || 'votes',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  voteOptions: list(process.env.VOTE_OPTIONS || 'cat,dog'),
  rateLimitSeconds: Number(process.env.RATE_LIMIT_SECONDS || 3),
};
