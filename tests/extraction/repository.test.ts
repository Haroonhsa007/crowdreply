import { describe, expect, it, vi } from 'vitest';
import { extractRuleBased } from '../../src/extraction/rule-based.js';
import { INITIAL_EXTRACTION_VERSION } from '../../src/db/extraction-repository.js';
import { extractionFixture } from './storage-fixture.js';
import { assessmentRaw } from './fixtures.js';
const payload = {
  executionId: assessmentRaw.executionId,
  extractorVersion: INITIAL_EXTRACTION_VERSION,
};
function result(
  work: NonNullable<
    Awaited<
      ReturnType<ReturnType<typeof extractionFixture>['repository']['claim']>
    >
  >,
) {
  return extractRuleBased({ ...work, raw: assessmentRaw });
}
describe('durable extraction versions and fenced publication', () => {
  it('deduplicates concurrent requests, claims once, and keeps terminal results immutable', async () => {
    const fixture = extractionFixture();
    const { repository, execution, storage } = fixture;
    const insert = storage.extractions.insertOne.bind(storage.extractions);
    vi.spyOn(storage.extractions, 'insertOne').mockImplementation(
      async (row) => {
        row._id = 'synthetic-driver-generated-id';
        await insert(row);
      },
    );
    const requested = await Promise.all([
      repository.request(execution),
      repository.request(execution),
    ]);
    expect(requested.filter((item) => item.created)).toHaveLength(1);
    expect(JSON.stringify(requested)).not.toContain(
      'synthetic-driver-generated-id',
    );
    const claims = await Promise.all([
      repository.claim(payload),
      repository.claim(payload),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const claim = claims.find((item) => item !== null)!;
    expect(await repository.complete(claim, result(claim))).toBe(true);
    const terminal = await repository.detail(execution.id);
    expect(terminal.current?.mentions.map((item) => item.brand)).toEqual([
      'HubSpot',
      'Pipedrive',
      'Attio',
      'Close',
      'Salesforce Starter Suite',
    ]);
    expect(await repository.claim(payload)).toBeNull();
    expect(await repository.fail(claim, 'extraction_error')).toBe(false);
    expect((await repository.detail(execution.id)).current).toEqual(
      terminal.current,
    );
    expect(storage.mentions.rows).toHaveLength(5);
    expect(storage.executions.rows[0]).toMatchObject({
      status: 'succeeded',
      extractionStatus: 'extracted',
      rawResponseId: 'synthetic-raw',
    });
  });
  it('rejects stale completion after lease expiry and never regresses a newer current version', async () => {
    const { repository, execution, advance, storage } = extractionFixture();
    await repository.request(execution);
    const stale = (await repository.claim(payload, 1000))!;
    advance(1001);
    const current = (await repository.claim(payload))!;
    expect(current.claimToken).not.toBe(stale.claimToken);
    expect(await repository.complete(stale, result(stale))).toBe(false);
    expect(await repository.complete(current, result(current))).toBe(true);
    const first = (await repository.detail(execution.id)).current!;
    await repository.request(execution, 'rules-v1-reprocess-new');
    await repository.complete(current, result(current));
    const detail = await repository.detail(execution.id);
    expect(detail.current?.extractorVersion).toBe('rules-v1-reprocess-new');
    expect(detail.current?.status).toBe('pending');
    expect(detail.history.find((item) => item.id === first.id)).toEqual(first);
    expect(storage.executions.rows[0]?.status).toBe('succeeded');
  });
  it('recovers pointer/status crashes and exhausts bounded expired claims fairly', async () => {
    const { repository, execution, storage, advance } = extractionFixture();
    await repository.request(execution);
    delete storage.executions.rows[0]!.extractionId;
    await repository.recover();
    expect(storage.executions.rows[0]?.extractionId).toBeDefined();
    for (let attempt = 0; attempt < 3; attempt++) {
      expect(await repository.claim(payload, 1000)).not.toBeNull();
      advance(1001);
    }
    expect(await repository.recover()).toEqual([]);
    expect((await repository.detail(execution.id)).current).toMatchObject({
      status: 'extraction_failed',
      error: { code: 'attempts_exhausted' },
    });
    expect(storage.executions.rows[0]).toMatchObject({
      status: 'succeeded',
      extractionStatus: 'extraction_failed',
    });
    const history = await repository.detail(execution.id);
    expect(history.history).toHaveLength(1);
  });
  it('uses a Mongo aggregation restricted to current completed live versions by default', async () => {
    const { repository, storage } = extractionFixture();
    const query = { from: '2026-11-01', to: '2026-11-02', includeMock: false };
    expect(await repository.visibility(query)).toMatchObject({
      includeMock: false,
      includesMock: false,
      executionCounts: { live: 0, mock: 0 },
      items: [],
    });
    expect(storage.extractions.pipeline[0]).toEqual({
      $match: {
        status: 'extracted',
        runDate: { $gte: query.from, $lte: query.to },
        integration: 'live',
      },
    });
    expect(JSON.stringify(storage.extractions.pipeline)).toContain(
      '$execution.extractionId',
    );
    expect(JSON.stringify(storage.extractions.pipeline)).toContain(
      '"mentions.ambiguous":false',
    );
    expect(JSON.stringify(storage.extractions.pipeline)).toContain(
      '$setWindowFields',
    );
    storage.extractions.aggregateResult = [
      {
        counts: [{ _id: 'mock', count: 1 }],
        items: [
          {
            provider: 'openai',
            integration: 'mock',
            brand: 'HubSpot',
            mentionCount: 2,
            averagePosition: 1,
            share: 1,
          },
        ],
      },
    ];
    expect(
      await repository.visibility({ ...query, includeMock: true }),
    ).toMatchObject({ includesMock: true, executionCounts: { mock: 1 } });
  });
});
