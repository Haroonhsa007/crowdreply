import { MongoClient } from 'mongodb';
import type { Config } from '../config/index.js';

export function createDatabase(config: Config) {
  const client = new MongoClient(config.MONGODB_URI, {
    serverSelectionTimeoutMS: 1000,
    connectTimeoutMS: 1000,
  });
  const db = client.db();
  return {
    getDb: () => db,
    close: () => client.close(),
    async ensureIndexes() {
      await Promise.all([
        db
          .collection('executions')
          .createIndex({ executionKey: 1 }, { unique: true }),
        db.collection('executions').createIndex({ id: 1 }, { unique: true }),
        db
          .collection('executions')
          .createIndex({ lastRecoveryTouch: 1, createdAt: 1, _id: 1 }),
        db
          .collection('executions')
          .createIndex({ completionPending: 1, leaseUntil: 1 }),
        db.collection('executions').createIndex({
          status: 1,
          extractionStatus: 1,
          extractionRepairTouch: 1,
          createdAt: 1,
        }),
        db.collection('executions').createIndex({
          status: 1,
          extractionStatus: 1,
          extractionId: 1,
          createdAt: 1,
        }),
        db.collection('extractions').createIndex({ id: 1 }, { unique: true }),
        db
          .collection('extractions')
          .createIndex(
            { executionId: 1, extractorVersion: 1 },
            { unique: true },
          ),
        db
          .collection('extractions')
          .createIndex({ status: 1, retryAt: 1, leaseUntil: 1, createdAt: 1 }),
        db
          .collection('extractions')
          .createIndex({ executionId: 1, revision: -1 }),
        db
          .collection('extractions')
          .createIndex({ status: 1, lastRecoveryTouch: 1, createdAt: 1 }),
        db
          .collection('brand_mentions')
          .createIndex(
            { extractionId: 1, claimToken: 1, ordinal: 1 },
            { unique: true },
          ),
        db
          .collection('brand_mentions')
          .createIndex({ provider: 1, brand: 1, runDate: 1 }),
        db.collection('brand_mentions').createIndex({ executionId: 1 }),
        db
          .collection('brand_aliases')
          .createIndex({ alias: 1 }, { unique: true }),
        db.collection('executions').createIndex({ status: 1, leaseUntil: 1 }),
        db.collection('executions').createIndex({ status: 1, retryAt: 1 }),
        db.collection('executions').createIndex({ createdAt: -1, _id: -1 }),
        db
          .collection('raw_responses')
          .createIndex({ executionId: 1 }, { unique: true }),
        db
          .collection('raw_responses')
          .createIndex({ createdAt: 1 }, { expireAfterSeconds: 30 * 86400 }),
        db
          .collection('spend_ledger')
          .createIndex({ idempotencyKey: 1 }, { unique: true }),
        db.collection('spend_ledger').createIndex({
          integration: 1,
          stage: 1,
          amountUsd: 1,
          lastRecoveryTouch: 1,
          idempotencyKey: 1,
        }),
        db
          .collection('questions')
          .createIndex({ questionId: 1, questionVersion: 1 }, { unique: true }),
      ]);
    },
  };
}
