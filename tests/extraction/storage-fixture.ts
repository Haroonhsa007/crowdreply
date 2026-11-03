import { ExecutionSchema } from '../../src/contracts/index.js';
import { createExtractionRepository } from '../../src/db/extraction-repository.js';
import type { CollectionPort, Row } from '../../src/db/execution-repository.js';

function matches(row: Row, filter: Row): boolean {
  return Object.entries(filter).every(([key, value]) => {
    if (key === '$or')
      return (value as Row[]).some((part) => matches(row, part));
    const actual = row[key];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return Object.entries(value).every(([op, expected]) => {
        if (op === '$exists') return (actual !== undefined) === expected;
        if (op === '$in') return (expected as unknown[]).includes(actual);
        if (op === '$lt')
          return actual !== undefined && String(actual) < String(expected);
        if (op === '$lte')
          return actual !== undefined && String(actual) <= String(expected);
        if (op === '$gte')
          return actual !== undefined && String(actual) >= String(expected);
        if (op === '$gt')
          return actual !== undefined && String(actual) > String(expected);
        return false;
      });
    }
    return actual === value;
  });
}
function apply(row: Row, update: Row, inserted = false) {
  Object.assign(row, inserted ? update.$setOnInsert : {}, update.$set);
  for (const [key, value] of Object.entries((update.$inc ?? {}) as Row))
    row[key] = Number(row[key] ?? 0) + Number(value);
  for (const key of Object.keys((update.$unset ?? {}) as Row)) delete row[key];
}
export class ExtractionMemoryCollection implements CollectionPort {
  rows: Row[] = [];
  pipeline: Row[] = [];
  aggregateResult: Row[] = [];
  constructor(private unique: string[]) {}
  async findOne(filter: Row) {
    return structuredClone(
      this.rows.find((row) => matches(row, filter)) ?? null,
    );
  }
  async insertOne(row: Row) {
    if (
      this.rows.some((existing) =>
        this.unique.every((key) => existing[key] === row[key]),
      )
    )
      throw Object.assign(new Error('Synthetic duplicate'), { code: 11000 });
    this.rows.push(structuredClone(row));
  }
  async updateOne(filter: Row, update: Row, options?: { upsert?: boolean }) {
    const row = this.rows.find((item) => matches(item, filter));
    if (row) {
      apply(row, update);
      return { matchedCount: 1 };
    }
    if (options?.upsert) {
      const inserted = { ...filter };
      apply(inserted, update, true);
      await this.insertOne(inserted);
    }
    return { matchedCount: 0 };
  }
  async findOneAndUpdate(filter: Row, update: Row) {
    const row = this.rows.find((item) => matches(item, filter));
    if (!row) return null;
    apply(row, update);
    return structuredClone(row);
  }
  find(filter: Row) {
    return {
      sort: (sort: Record<string, 1 | -1>) => ({
        limit: (limit: number) => ({
          toArray: async () =>
            structuredClone(
              this.rows
                .filter((row) => matches(row, filter))
                .sort((a, b) => {
                  for (const [key, direction] of Object.entries(sort)) {
                    if (a[key] === undefined && b[key] !== undefined)
                      return -direction;
                    if (a[key] !== undefined && b[key] === undefined)
                      return direction;
                    const difference =
                      typeof a[key] === 'number' && typeof b[key] === 'number'
                        ? Number(a[key]) - Number(b[key])
                        : String(a[key]).localeCompare(String(b[key]));
                    if (difference) return difference * direction;
                  }
                  return 0;
                })
                .slice(0, limit),
            ),
        }),
      }),
    };
  }
  aggregate(pipeline: Row[]) {
    this.pipeline = pipeline;
    return { toArray: async () => structuredClone(this.aggregateResult) };
  }
}
export function extractionFixture() {
  let time = Date.parse('2026-11-02T00:00:00.000Z');
  const storage = {
    executions: new ExtractionMemoryCollection(['id']),
    extractions: new ExtractionMemoryCollection([
      'executionId',
      'extractorVersion',
    ]),
    mentions: new ExtractionMemoryCollection([
      'extractionId',
      'claimToken',
      'ordinal',
    ]),
    aliases: new ExtractionMemoryCollection(['alias']),
  };
  const execution = ExecutionSchema.parse({
    id: 'synthetic-extraction',
    executionKey: 'a'.repeat(64),
    questionId: 'synthetic-question',
    questionText: 'Best CRM?',
    questionVersion: 1,
    provider: 'openai',
    integration: 'mock',
    model: 'synthetic-model',
    modelSettingsVersion: 'v1',
    runDate: '2026-11-02',
    runSeq: 0,
    settings: { webSearch: true },
    status: 'succeeded',
    extractionStatus: 'pending',
    attempts: [],
    citationsAvailable: 'yes',
    rawResponseId: 'synthetic-raw',
    createdAt: new Date(time).toISOString(),
    updatedAt: new Date(time).toISOString(),
  });
  storage.executions.rows.push({ ...execution });
  return {
    storage,
    execution,
    repository: createExtractionRepository(storage, () => new Date(time)),
    advance: (milliseconds: number) => {
      time += milliseconds;
    },
  };
}
