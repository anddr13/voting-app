'use strict';

const http = require('node:http');
const { setTimeout: sleep } = require('node:timers/promises');
const Redis = require('ioredis');
const { Kafka, logLevel } = require('@confluentinc/kafka-javascript').KafkaJS;
const config = require('./config');
const { parseEvent } = require('./event');
const { connectStore, recordVote } = require('./store');

const redis = new Redis(config.redisUrl);
const kafka = new Kafka({
  kafkaJS: { clientId: 'worker', brokers: config.kafkaBrokers, logLevel: logLevel.WARN },
});
// A brand-new consumer group starts from the earliest offset, so no vote is skipped.
// librdkafka re-reads topic metadata every 5 min by default; poll faster so a topic
// created after the worker started is picked up quickly.
const consumer = kafka.consumer({
  kafkaJS: { groupId: config.groupId, fromBeginning: true },
  'topic.metadata.refresh.interval.ms': 10_000,
});
const dlq = kafka.producer();

let consuming = false;

const health = http.createServer((req, res) => {
  const ok = req.url === '/healthz' || (req.url === '/readyz' && consuming);
  res.writeHead(ok ? 200 : 503).end(ok ? 'ok' : 'not ready');
});

async function handle(store, message) {
  const event = parseEvent(message.value, config.voteOptions);
  if (!event) {
    // Poison message: park it in the DLQ instead of blocking the partition forever.
    await dlq.send({ topic: config.dlqTopic, messages: [{ key: message.key, value: message.value }] });
    return;
  }
  if (config.processingDelayMs > 0) await sleep(config.processingDelayMs);

  const count = await recordVote(store, event);
  if (count === null) return;

  // Mongo is the source of truth. Redis gets the absolute value, so replays are harmless.
  await redis
    .multi()
    .hset('tallies', event.option, count)
    .publish('tallies:updates', JSON.stringify({ option: event.option, count }))
    .exec();
}

async function main() {
  health.listen(config.port, () => console.log(`worker health on :${config.port}`));

  const store = await connectStore(config.mongoUrl, config.mongoDb);
  await dlq.connect();
  await consumer.connect();
  await consumer.subscribe({ topics: [config.kafkaTopic] });
  await consumer.run({ eachMessage: ({ message }) => handle(store, message) });
  consuming = true;
  console.log(`worker consuming ${config.kafkaTopic} as ${config.groupId}`);

  const shutdown = async () => {
    consuming = false;
    await consumer.disconnect().catch(() => {});
    await dlq.disconnect().catch(() => {});
    await store.client.close().catch(() => {});
    redis.disconnect();
    health.close();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('worker failed to start:', err);
  process.exit(1);
});
