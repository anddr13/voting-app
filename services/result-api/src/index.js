'use strict';

const path = require('node:path');
const express = require('express');
const Redis = require('ioredis');
const { Pool } = require('pg');
const config = require('./config');
const { normalizeTallies } = require('./results');

const redis = new Redis(config.redisUrl);
const subscriber = redis.duplicate();
const pool = new Pool({ max: config.pgPoolMax, application_name: 'result-api', connectionTimeoutMillis: 5_000 });
const streams = new Set();
let dbReady = false;

async function loadResults() {
  const cached = normalizeTallies(await redis.hgetall('tallies'), config.voteOptions);
  if (Object.values(cached).some((count) => count > 0)) return cached;

  // Cold cache (fresh or restarted Redis): rebuild it from PostgreSQL, the source of truth.
  const { rows } = await pool.query('SELECT option, count FROM tallies');
  const fromDb = normalizeTallies(
    Object.fromEntries(rows.map((row) => [row.option, row.count])),
    config.voteOptions,
  );
  if (rows.length > 0) await redis.hset('tallies', fromDb);
  return fromDb;
}

// Under load the worker publishes hundreds of updates per second;
// send connected browsers at most one snapshot per 250 ms.
let broadcastTimer = null;
function scheduleBroadcast() {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(async () => {
    broadcastTimer = null;
    try {
      const payload = `data: ${JSON.stringify(await loadResults())}\n\n`;
      for (const res of streams) res.write(payload);
    } catch (err) {
      console.error('broadcast failed:', err.message);
    }
  }, 250);
}
subscriber.on('message', scheduleBroadcast);

// Comment lines keep idle SSE connections from being cut by load balancers.
setInterval(() => {
  for (const res of streams) res.write(': ping\n\n');
}, 15_000).unref();

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/healthz', (_req, res) => res.send('ok'));

app.get('/readyz', (_req, res) => {
  const ready = dbReady && redis.status === 'ready' && subscriber.status === 'ready';
  res.status(ready ? 200 : 503).send(ready ? 'ready' : 'not ready');
});

app.get('/api/info', (_req, res) => {
  res.json({ cloud: config.cloudName, version: config.appVersion, options: config.voteOptions });
});

app.get('/api/results', async (_req, res) => {
  res.json(await loadResults());
});

app.get('/api/stream', async (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  res.flushHeaders();
  res.write(`data: ${JSON.stringify(await loadResults())}\n\n`);
  streams.add(res);
  req.on('close', () => streams.delete(res));
});

app.use((err, _req, res, _next) => {
  console.error(err);
  if (!res.headersSent) res.status(500).json({ error: 'internal error' });
});

async function main() {
  await pool.query('SELECT 1');
  dbReady = true;
  await subscriber.subscribe('tallies:updates');
  const server = app.listen(config.port, () => console.log(`result-api listening on :${config.port}`));

  const shutdown = async () => {
    for (const res of streams) res.end();
    server.close();
    await pool.end().catch(() => {});
    subscriber.disconnect();
    redis.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('result-api failed to start:', err);
  process.exit(1);
});
