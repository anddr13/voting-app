'use strict';

const express = require('express');
const Redis = require('ioredis');
const { Kafka, logLevel } = require('@confluentinc/kafka-javascript').KafkaJS;
const config = require('./config');
const { parseVote, clientIdFrom, buildEvent } = require('./vote');

const redis = new Redis(config.redisUrl);
const kafka = new Kafka({
  kafkaJS: { clientId: 'vote-api', brokers: config.kafkaBrokers, logLevel: logLevel.WARN },
});
// Idempotent producer: acks=all and the broker drops duplicates caused by retries.
const producer = kafka.producer({ kafkaJS: { idempotent: true } });

let producerReady = false;

const app = express();
app.set('trust proxy', true);
app.use(express.json({ limit: '1kb' }));

app.get('/healthz', (_req, res) => res.send('ok'));

app.get('/readyz', (_req, res) => {
  const ready = producerReady && redis.status === 'ready';
  res.status(ready ? 200 : 503).send(ready ? 'ready' : 'not ready');
});

app.post('/api/vote', async (req, res) => {
  const vote = parseVote(req.body, config.voteOptions);
  if (vote.error) return res.status(400).json({ error: vote.error });

  const clientId = clientIdFrom(req);
  // SET NX EX is atomic, so only the first vote inside the window gets through.
  const allowed = await redis.set(`ratelimit:${clientId}`, '1', 'EX', config.rateLimitSeconds, 'NX');
  if (!allowed) {
    return res.status(429).json({ error: `one vote per ${config.rateLimitSeconds}s` });
  }

  const event = buildEvent(vote.option, clientId);
  // Keyed by client, so votes of one client stay ordered within a partition.
  await producer.send({
    topic: config.kafkaTopic,
    messages: [{ key: clientId, value: JSON.stringify(event) }],
  });
  return res.status(202).json({ voteId: event.voteId });
});

app.use((err, _req, res, _next) => {
  const status = err.status ?? 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'internal error' : err.message });
});

async function main() {
  await producer.connect();
  producerReady = true;
  const server = app.listen(config.port, () => console.log(`vote-api listening on :${config.port}`));

  const shutdown = async () => {
    producerReady = false;
    server.close();
    await producer.disconnect().catch(() => {});
    redis.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('vote-api failed to start:', err);
  process.exit(1);
});
