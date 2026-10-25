'use strict';

const list = (value) => value.split(',').map((s) => s.trim()).filter(Boolean);

module.exports = {
  port: Number(process.env.PORT || 8080),
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  mongoUrl: process.env.MONGO_URL || 'mongodb://localhost:27017/?directConnection=true',
  mongoDb: process.env.MONGO_DB || 'voting',
  voteOptions: list(process.env.VOTE_OPTIONS || 'cat,dog'),
  cloudName: process.env.CLOUD_NAME || 'local',
  appVersion: process.env.APP_VERSION || 'dev',
};
