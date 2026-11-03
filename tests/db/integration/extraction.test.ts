import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config/index.js';
import { createDatabase } from '../../../src/db/connection.js';
import {
  createExtractionRepository,
  mongoExtractionStorage,
} from '../../../src/db/extraction-repository.js';
import { extractionFixture } from '../../extraction/storage-fixture.js';
describe.skipIf(
  process.env.RUN_INTEGRATION !== '1' || !process.env.MONGODB_URI,
)('current extraction Mongo lookup (isolated opt-in)', () => {
  it('uses a unique id index and an IXSCAN for current-version reads', async () => {
    const config = loadConfig();
    const uri = new URL(config.MONGODB_URI);
    uri.pathname =
      '/crowdreply_extraction_test_' + randomUUID().replaceAll('-', '');
    const database = createDatabase({ ...config, MONGODB_URI: uri.toString() });
    try {
      await database.ensureIndexes();
      const { execution } = extractionFixture();
      await database
        .getDb()
        .collection('executions')
        .insertOne({ ...execution });
      const repository = createExtractionRepository(
        mongoExtractionStorage(database.getDb()),
      );
      const requested = await repository.request(execution);
      const versions = database.getDb().collection('extractions');
      const plan = await versions
        .find({ id: requested.extraction.id })
        .explain('executionStats');
      expect(JSON.stringify(plan.queryPlanner.winningPlan)).toContain('IXSCAN');
      expect(plan.executionStats.totalDocsExamined).toBe(1);
      expect(
        (await versions.indexes()).some(
          (index) => index.key.id === 1 && index.unique,
        ),
      ).toBe(true);
      expect((await repository.detail(execution.id)).current?.id).toBe(
        requested.extraction.id,
      );
    } finally {
      await database.getDb().dropDatabase();
      await database.close();
    }
  });
});
