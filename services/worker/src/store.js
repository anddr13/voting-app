'use strict';

const { MongoClient } = require('mongodb');

const DUPLICATE_KEY = 11000;

async function connectStore(url, dbName) {
  const client = new MongoClient(url);
  await client.connect();
  const db = client.db(dbName);

  // Collections are created up front so the transaction below never has to create them.
  for (const name of ['votes', 'tallies']) {
    await db.createCollection(name).catch((err) => {
      if (err.codeName !== 'NamespaceExists') throw err;
    });
  }
  await db.collection('votes').createIndex({ option: 1, ts: -1 });
  return { client, db };
}

// Stores the vote and bumps its tally in one transaction.
// Returns the new tally, or null when the vote was already stored (Kafka redelivery).
async function recordVote({ client, db }, event) {
  const session = client.startSession();
  try {
    let count = null;
    await session.withTransaction(async () => {
      await db.collection('votes').insertOne(
        { _id: event.voteId, option: event.option, clientId: event.clientId, ts: event.ts },
        { session },
      );
      const tally = await db.collection('tallies').findOneAndUpdate(
        { _id: event.option },
        { $inc: { count: 1 } },
        { upsert: true, returnDocument: 'after', session },
      );
      count = tally.count;
    });
    return count;
  } catch (err) {
    if (err.code === DUPLICATE_KEY) return null;
    throw err;
  } finally {
    await session.endSession();
  }
}

module.exports = { connectStore, recordVote };
