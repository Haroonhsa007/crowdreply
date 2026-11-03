import {
  createExecutionRepository,
  type CollectionPort,
  type Row,
} from '../../src/db/execution-repository.js';

function matches(row: Row, filter: Row): boolean {
  return Object.entries(filter).every(([key, value]) => {
    if (key === '$or')
      return (value as Row[]).some((part) => matches(row, part));
    if (key === '$and')
      return (value as Row[]).every((part) => matches(row, part));
    const actual = row[key];
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      !(value instanceof Date)
    ) {
      return Object.entries(value).every(([op, expected]) => {
        if (op === '$exists') return (actual !== undefined) === expected;
        if (op === '$size')
          return Array.isArray(actual) && actual.length === expected;
        if (op === '$ne') return actual !== expected;
        if (op === '$nin') return !(expected as unknown[]).includes(actual);
        if (op === '$lte')
          return actual !== undefined && String(actual) <= String(expected);
        if (op === '$lt')
          return actual !== undefined && String(actual) < String(expected);
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
function apply(row: Row, update: Row, insert = false): void {
  Object.assign(row, insert ? update.$setOnInsert : {}, update.$set);
  for (const [key, value] of Object.entries((update.$inc ?? {}) as Row))
    row[key] = Number(row[key] ?? 0) + Number(value);
  for (const key of Object.keys((update.$unset ?? {}) as Row)) delete row[key];
  for (const [key, value] of Object.entries((update.$push ?? {}) as Row)) {
    const list = row[key];
    if (Array.isArray(list)) list.push(structuredClone(value));
    else row[key] = [structuredClone(value)];
  }
}
export class FakeCollection implements CollectionPort {
  rows: Row[] = [];
  constructor(readonly unique: string[]) {}
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
    return { acknowledged: true };
  }
  async updateOne(filter: Row, update: Row, options?: { upsert?: boolean }) {
    const row = this.rows.find((item) => matches(item, filter));
    if (row) {
      apply(row, update);
      return { matchedCount: 1 };
    }
    if (options?.upsert) {
      const created = { ...filter };
      apply(created, update, true);
      await this.insertOne(created);
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
          toArray: async () => {
            const rows = this.rows
              .filter((row) => matches(row, filter))
              .sort((a, b) => {
                for (const [key, direction] of Object.entries(sort)) {
                  if (a[key] === undefined && b[key] !== undefined)
                    return -direction;
                  if (a[key] !== undefined && b[key] === undefined)
                    return direction;
                  const comparison = String(a[key]).localeCompare(
                    String(b[key]),
                  );
                  if (comparison) return comparison * direction;
                }
                return 0;
              });
            return structuredClone(rows.slice(0, limit));
          },
        }),
      }),
    };
  }
  aggregate(pipeline: Row[]) {
    return {
      toArray: async () => {
        const rows = this.rows.filter((row) =>
          matches(row, (pipeline[0]?.$match ?? {}) as Row),
        );
        return rows.length
          ? [
              {
                total: rows.reduce(
                  (sum, row) =>
                    sum +
                    (typeof row.amountUsd === 'number' ? row.amountUsd : 0),
                  0,
                ),
                unknown: rows.filter(
                  (row) =>
                    typeof row.amountUsd !== 'number' ||
                    !Number.isFinite(row.amountUsd) ||
                    row.amountUsd < 0,
                ).length,
              },
            ]
          : [];
      },
    };
  }
}
export function repositoryFixture(clock: () => Date = () => new Date()) {
  const storage = {
    executions: new FakeCollection(['executionKey']),
    raw: new FakeCollection(['executionId']),
    spend: new FakeCollection(['idempotencyKey']),
    questions: new FakeCollection(['questionId', 'questionVersion']),
  };
  return { repository: createExecutionRepository(storage, clock), storage };
}
