'use strict';

const { Counter, collectDefaultMetrics, register } = require('@prometheus-io/client');

collectDefaultMetrics();

// stored + duplicate = every vote message the worker has processed. Duplicates are Kafka
// redeliveries (a worker died or a rebalance happened before the offset was committed)
// that ON CONFLICT turned into no-ops.
const votes = new Counter({
  name: 'worker_votes_total',
  help: 'Vote messages processed, by outcome: stored, duplicate (redelivery, skipped) or dlq (poison).',
  labelNames: ['outcome'],
});
// Export zeros from the start, so rate() and increase() work before the first duplicate or poison message.
for (const outcome of ['stored', 'duplicate', 'dlq']) votes.labels(outcome).inc(0);

module.exports = { votes, register };
