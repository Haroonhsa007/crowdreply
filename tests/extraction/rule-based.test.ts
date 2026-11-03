import { describe, expect, it } from 'vitest';
import { ExtractionSchema } from '../../src/contracts/extraction.js';
import { extractRuleBased } from '../../src/extraction/rule-based.js';
import { assessmentRaw, context } from './fixtures.js';

const extract = (outputText: string, raw = assessmentRaw) =>
  extractRuleBased({ ...context, raw: { ...raw, outputText } });

describe('rule-based extraction using synthetic raw answers', () => {
  it('extracts all five ranked CRM brands, merges aliases and preserves all six domains', () => {
    const snapshot = structuredClone(assessmentRaw);
    const result = extractRuleBased({ ...context, raw: assessmentRaw });
    expect(ExtractionSchema.parse(result)).toEqual(result);
    expect(result.mentions.map((m) => [m.brand, m.position])).toEqual([
      ['HubSpot', 1],
      ['Pipedrive', 2],
      ['Attio', 3],
      ['Close', 4],
      ['Salesforce Starter Suite', 5],
    ]);
    expect(result.mentions[0]).toMatchObject({
      alias: 'HubSpot CRM',
      mentionCount: 3,
      ambiguous: false,
    });
    expect(result.citedDomains).toEqual([
      'hubspot.com',
      'pipedrive.com',
      'attio.com',
      'softwarecompare.net',
      'close.com',
      'salesforce.com',
    ]);
    expect(result.mentions.map((m) => m.citationIndexes)).toEqual([
      [0],
      [1],
      [2],
      [4],
      [5],
    ]);
    expect(assessmentRaw).toEqual(snapshot);
    for (const m of result.mentions)
      expect(
        assessmentRaw.outputText.slice(
          m.sourceSpan.startIndex,
          m.sourceSpan.endIndex,
        ),
      ).toBe(m.sourceSpan.text);
  });
  it('keeps Salesforce Starter Suite distinct and prevents overlapping alias double counts', () => {
    const result = extract(
      '1. Salesforce Starter Suite — sales CRM.\n2. Salesforce — enterprise CRM.\nHubSpot CRM and HubSpot.',
    );
    expect(
      result.mentions.find((m) => m.brand === 'Salesforce Starter Suite')
        ?.mentionCount,
    ).toBe(1);
    expect(
      result.mentions.find((m) => m.brand === 'Salesforce')?.mentionCount,
    ).toBe(1);
    expect(
      result.mentions.find((m) => m.brand === 'HubSpot')?.mentionCount,
    ).toBe(2);
  });
  it('discovers unknown numbered, bulleted, bold and linked names without treating headings as brands', () => {
    const result = extract(
      '**Recommendations**\n1. **Copper** — useful for sales.\n- Freshsales: a CRM option.\n**Nimble** works for relationship teams.\n[Capsule](https://capsulecrm.com/) is another CRM.\n**Key features**\n# **Sales pipeline**',
    );
    expect(result.mentions.map((m) => m.brand)).toEqual([
      'Copper',
      'Freshsales',
      'Nimble',
      'Capsule',
    ]);
    expect(result.mentions.map((m) => m.position)).toEqual([1, 1, null, null]);
  });
  it('flags ordinary close as ambiguous while preserving clear ranked CRM usage separately', () => {
    const result = extract(
      'Close the window before you leave.\n1. Close — an outbound sales CRM.\nTeams can close deals faster.',
    );
    expect(result.mentions.filter((m) => m.brand === 'Close')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          position: 1,
          mentionCount: 1,
          ambiguous: false,
        }),
        expect.objectContaining({
          position: null,
          mentionCount: 2,
          ambiguous: true,
          ambiguityReason: expect.any(String),
        }),
      ]),
    );
  });
  it('uses document CRM context for a ranked Close recommendation without converting an ordinary verb', () => {
    const result = extract(
      'CRM recommendations:\n1. **Close** — built-in calling and email.\n2. Close the window before you leave.',
    );
    expect(result.mentions.filter((m) => m.brand === 'Close')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ position: 1, ambiguous: false }),
        expect.objectContaining({ ambiguous: true }),
      ]),
    );
  });
  it('preserves Unicode UTF-16 source spans and leaves prose recommendations unranked', () => {
    const text =
      '😀 Café teams consider **Élan CRM** for sales. Attio is another option.';
    const result = extract(text);
    expect(result.mentions.map((m) => [m.brand, m.position])).toEqual([
      ['Élan CRM', null],
      ['Attio', null],
    ]);
    for (const m of result.mentions)
      expect(text.slice(m.sourceSpan.startIndex, m.sourceSpan.endIndex)).toBe(
        m.alias,
      );
  });
  it('links a discovered brand only through a valid, explicitly identified citation span', () => {
    const outputText = '😀 **Copper** is useful. **Nimble** is another option.';
    const start = outputText.indexOf('Copper');
    const result = extract(outputText, {
      ...assessmentRaw,
      body: {
        metadata: {
          citationOffsetUnit: 'utf16-code-units',
          citationOffsetBasis: 'joined-answer',
        },
      },
      citations: [
        {
          url: 'https://softwarecompare.net/',
          domain: 'softwarecompare.net',
          startIndex: start,
          endIndex: start + 6,
        },
      ],
    });
    expect(result.mentions.map((m) => m.citationIndexes)).toEqual([[0], []]);
  });
  it('translates verified UTF-8 citation spans and rejects unspecified or malformed offset units', () => {
    const outputText = '😀 **Copper** for CRM.';
    const start = Buffer.byteLength(
      outputText.slice(0, outputText.indexOf('Copper')),
    );
    const raw = {
      ...assessmentRaw,
      body: {
        metadata: {
          citationOffsetUnit: 'utf8-bytes',
          citationOffsetBasis: 'joined-answer',
        },
      },
      citations: [
        {
          url: 'https://softwarecompare.net/',
          domain: 'softwarecompare.net',
          startIndex: start,
          endIndex: start + 6,
        },
      ],
    };
    expect(extract(outputText, raw).mentions[0]?.citationIndexes).toEqual([0]);
    expect(
      extract(outputText, { ...raw, body: {} }).mentions[0]?.citationIndexes,
    ).toEqual([]);
    expect(
      extract(outputText, {
        ...raw,
        citations: [{ ...raw.citations[0]!, startIndex: 1, endIndex: 3 }],
      }).mentions[0]?.citationIndexes,
    ).toEqual([]);
  });
  it('handles missing citations and empty answers honestly', () => {
    const result = extract('Attio is an option.', {
      ...assessmentRaw,
      citations: [],
    });
    expect(result.mentions[0]?.citationIndexes).toEqual([]);
    expect(result.citedDomains).toEqual([]);
    expect(extract('').mentions).toEqual([]);
  });
  it('is deterministic for a stored raw answer and requested extractor version', () => {
    const input = {
      ...context,
      raw: assessmentRaw,
      extractorVersion: 'requested-v2',
    };
    expect(extractRuleBased(input)).toEqual(extractRuleBased(input));
    expect(extractRuleBased(input).extractorVersion).toBe('requested-v2');
    expect(extractRuleBased(input).algorithmVersion).toBe('rule-based-v1');
  });
});

describe('open discovery follow-up regressions', () => {
  it('discovers unfamiliar standalone bold recommendations with CRM descriptions but not generic headings', () => {
    const result = extract(
      '**Recommendations**\nCRM tools worth considering:\n\n**Copper**\nA CRM for relationship-driven teams.\n\n**Nimble**\nCRM software for sales teams.\n\n**Key features**\nUseful features for CRM teams.',
    );
    expect(result.mentions.map((m) => [m.brand, m.position])).toEqual([
      ['Copper', null],
      ['Nimble', null],
    ]);
  });
  it('keeps nested feature bullets out of brand discovery and recommendation ordinals', () => {
    const result = extract(
      '- **Copper** — CRM for sales.\n  - Easy setup\n  - Low price\n- **Nimble** — relationship CRM.',
    );
    expect(result.mentions.map((m) => [m.brand, m.position])).toEqual([
      ['Copper', 1],
      ['Nimble', 2],
    ]);
  });
  it('assigns a numbered recommendation only to the subject rather than incidental compared brands', () => {
    const result = extract(
      '1. **Copper** — simpler than **HubSpot**.\n2. Nimble — an alternative to **Attio** for sales.',
    );
    expect(result.mentions.map((m) => [m.brand, m.position])).toEqual([
      ['Copper', 1],
      ['HubSpot', null],
      ['Nimble', 2],
      ['Attio', null],
    ]);
  });
  it.each([
    'Our CRM helps teams close more deals.',
    'Our CRM helps teams close many deals.',
    'Use CRM software to close new accounts.',
    'Close more deals with our CRM.',
    'Close new accounts with this platform.',
    'CRM tools can close deals more quickly.',
  ])('keeps ordinary verb occurrence ambiguous: %s', (text) => {
    const result = extract(text);
    expect(result.mentions).toEqual([
      expect.objectContaining({
        brand: 'Close',
        ambiguous: true,
        confidence: 0.25,
        citationIndexes: [],
      }),
    ]);
    expect(result.mentions.filter((m) => !m.ambiguous)).toEqual([]);
  });
  it('requires occurrence-local brand evidence even when CRM occurs elsewhere on the line', () => {
    const result = extract(
      'Our CRM helps teams close faster; Close is a CRM with calling tools.',
    );
    expect(result.mentions.filter((m) => m.brand === 'Close')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          alias: 'close',
          ambiguous: true,
          mentionCount: 1,
        }),
        expect.objectContaining({
          alias: 'Close',
          ambiguous: false,
          mentionCount: 1,
        }),
      ]),
    );
  });
});
