'use strict';

const list = (value) => value.split(',').map((s) => s.trim()).filter(Boolean);

module.exports = {
  port: Number(process.env.PORT || 8080),
  kafkaBrokers: list(process.env.KAFKA_BROKERS || 'localhost:9092'),
  kafkaTopic: process.env.KAFKA_TOPIC || 'votes',
  dlqTopic: process.env.KAFKA_DLQ_TOPIC || 'votes-dlq',
  groupId: process.env.KAFKA_GROUP_ID || 'vote-workers',
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  mongoUrl: process.env.MONGO_URL || 'mongodb://localhost:27017/?directConnection=true',
  mongoDb: process.env.MONGO_DB || 'voting',
  voteOptions: list(process.env.VOTE_OPTIONS || 'cat,dog'),
  // Artificial per-message delay; lets a load test build up consumer lag for the KEDA demo.
  processingDelayMs: Number(process.env.PROCESSING_DELAY_MS || 0),
};
