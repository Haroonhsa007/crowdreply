import { createHash } from 'node:crypto';
import {
  ExtractionSchema,
  type BrandMention,
  type Extraction,
} from '../contracts/extraction.js';
import {
  normalizeDomain,
  type ProviderId,
  type ProviderMode,
  type RawResponse,
  type Citation,
} from '../contracts/index.js';
import { BRAND_ALIASES, type BrandAlias } from './aliases.js';

export const RULE_BASED_VERSION = 'rule-based-v1';
export interface RuleBasedInput {
  executionId: string;
  provider: ProviderId;
  integration: ProviderMode;
  runDate: string;
  raw: RawResponse;
  extractorVersion?: string;
  id?: string;
  createdAt?: string;
}
interface Candidate extends BrandAlias {
  rankedSpans: { start: number; end: number; position: number }[];
  linkedUrls: string[];
}
interface Occurrence {
  candidate: Candidate;
  start: number;
  end: number;
  written: string;
  position: number | null;
  ambiguous: boolean;
}
const genericHeading =
  /^(?:recommendations?|best(?:\s+crm)?(?:\s+software)?|key\s+features|features?|overview|pricing|pros(?:\s+and\s+cons)?|cons|conclusion|summary|sales\s+pipeline|crm(?:\s+options)?|options?|alternatives?|comparison|sources?|references?|benefits?|why\s+choose\b.*)$/iu;
const word = /[\p{L}\p{N}_]/u;
const escapeRegex = (value: string) =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** Deterministic, local heuristics only. Confidence is an ordinal heuristic, not a calibrated probability. */
export function extractRuleBased(input: RuleBasedInput): Extraction {
  if (input.executionId !== input.raw.executionId)
    throw new Error('Raw response execution identity mismatch');
  const text = input.raw.outputText;
  const candidates: Candidate[] = BRAND_ALIASES.map((alias) => ({
    ...alias,
    rankedSpans: [],
    linkedUrls: [],
  }));
  discover(text, candidates);
  const occurrences = findOccurrences(text, candidates);
  const mentions = aggregate(text, occurrences, input.raw);
  const extractorVersion = input.extractorVersion ?? RULE_BASED_VERSION;
  const createdAt = input.createdAt ?? input.raw.createdAt;
  return ExtractionSchema.parse({
    id:
      input.id ??
      createHash('sha256')
        .update(JSON.stringify([input.executionId, extractorVersion]))
        .digest('hex'),
    executionId: input.executionId,
    extractorVersion,
    algorithmVersion: RULE_BASED_VERSION,
    method: 'rule_based',
    status: 'extracted',
    provider: input.provider,
    integration: input.integration,
    runDate: input.runDate,
    createdAt,
    completedAt: createdAt,
    mentions,
    citedDomains: [
      ...new Set(input.raw.citations.map((citation) => citation.domain)),
    ],
  });
}

function discover(text: string, candidates: Candidate[]): void {
  const lines = text.split('\n');
  const entries = lines.map((line) =>
    /^([ \t]*)(?:(\d+)[.)]|([-*•]))\s+/.exec(line),
  );
  const indentation = (prefix: string) =>
    prefix.replaceAll('\t', '    ').length;
  const baseIndent = Math.min(
    ...entries.flatMap((entry) => (entry ? [indentation(entry[1]!)] : [])),
  );
  let offset = 0;
  let bulletPosition = 0;
  for (const [lineIndex, line] of lines.entries()) {
    const entry = entries[lineIndex];
    // Nested lists usually describe features of their parent recommendation.
    // They neither discover new brands nor consume recommendation ordinals.
    if (
      (entry && indentation(entry[1]!) !== baseIndent) ||
      /^\s*#/.test(line)
    ) {
      offset += line.length + 1;
      continue;
    }
    const prefix = entry?.[0] ?? '';
    const body = line.slice(prefix.length);
    const numberedPosition = entry?.[2] ? Number(entry[2]) || null : null;
    const position = entry ? (numberedPosition ?? bulletPosition + 1) : null;
    const formatted = [
      ...body.matchAll(
        /\*\*([^*\n]+)\*\*|__([^_\n]+)__|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/gu,
      ),
    ];
    let subjectFound = false;
    for (const match of formatted) {
      const name = match[1] ?? match[2] ?? match[3] ?? '';
      const localStart = (match.index ?? 0) + (match[3] ? 1 : 2);
      const standalone = !prefix && body.trim() === match[0];
      if (standalone && !known(name, candidates)) {
        const following =
          lines.slice(lineIndex + 1).find((next) => next.trim().length > 0) ??
          '';
        // An unfamiliar product heading needs a following descriptive paragraph;
        // a generic heading or another list/heading is not supporting evidence.
        if (
          /^\s*(?:#|[-*•]\s|\d+[.)]\s|\*\*|__)/u.test(following) ||
          !/\b(?:crm|software|platform|customer relationship)\b/iu.test(
            following,
          )
        )
          continue;
      }
      const isSubject = Boolean(entry) && match.index === 0;
      const added = addCandidate(
        name,
        offset + prefix.length + localStart,
        isSubject ? position : null,
        candidates,
        match[4],
      );
      subjectFound ||= isSubject && added !== undefined;
    }
    if (entry && !formatted.some((match) => match.index === 0)) {
      const leading = body.match(
        /^([\p{Lu}\p{N}][\p{L}\p{N}&+.'’]*(?:\s+[\p{Lu}\p{N}][\p{L}\p{N}&+.'’]*){0,5})/u,
      )?.[1];
      if (leading) {
        const tail = body.slice(leading.length);
        // Avoid interpreting imperative list text ("Close more deals") as a
        // named recommendation merely because it begins with a capital letter.
        const subjectSyntax =
          /^\s*(?:[:—–-]|$|(?:is|offers|provides|has|works|can|lets|helps)\b)/iu.test(
            tail,
          );
        if (subjectSyntax)
          subjectFound ||=
            addCandidate(
              leading,
              offset + prefix.length,
              position,
              candidates,
            ) !== undefined;
      }
    }
    if (entry?.[3] && subjectFound) bulletPosition++;
    offset += line.length + 1;
  }
}
function known(name: string, candidates: Candidate[]): Candidate | undefined {
  return candidates.find((candidate) =>
    candidate.aliases.some(
      (alias) =>
        alias.toLocaleLowerCase('en-US') === name.toLocaleLowerCase('en-US'),
    ),
  );
}
function addCandidate(
  name: string,
  start: number,
  position: number | null,
  candidates: Candidate[],
  url?: string,
): Candidate | undefined {
  if (
    name !== name.trim() ||
    name.length > 80 ||
    genericHeading.test(name) ||
    !/^[\p{Lu}\p{N}][\p{L}\p{N}\s&+.'’/-]*$/u.test(name)
  )
    return;
  let candidate = known(name, candidates);
  if (!candidate) {
    candidate = {
      brand: name,
      aliases: [name],
      domains: [],
      rankedSpans: [],
      linkedUrls: [],
    };
    candidates.push(candidate);
  }
  if (position !== null)
    candidate.rankedSpans.push({ start, end: start + name.length, position });
  if (url) candidate.linkedUrls.push(url);
  return candidate;
}
function findOccurrences(text: string, candidates: Candidate[]): Occurrence[] {
  const found: Occurrence[] = [];
  for (const candidate of candidates)
    for (const alias of candidate.aliases) {
      for (const match of text.matchAll(
        new RegExp(escapeRegex(alias), 'giu'),
      )) {
        const start = match.index;
        const end = start + match[0].length;
        if (
          (start > 0 && word.test(text[start - 1]!)) ||
          (end < text.length && word.test(text[end]!))
        )
          continue;
        const ranked = candidate.rankedSpans.find(
          (span) => span.start === start && span.end === end,
        );
        const clearClose =
          candidate.brand !== 'Close' ||
          closeBrandEvidence(text, start, end, ranked !== undefined);
        found.push({
          candidate,
          start,
          end,
          written: match[0],
          position: ranked?.position ?? null,
          ambiguous: !clearClose,
        });
      }
    }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const nonoverlapping: Occurrence[] = [];
  for (const occurrence of found)
    if (occurrence.start >= (nonoverlapping.at(-1)?.end ?? 0))
      nonoverlapping.push(occurrence);
  return nonoverlapping;
}
/** Common-word aliases require evidence attached to this occurrence, not a
 * distant CRM/sales word on the same line. Otherwise preserve ambiguity.
 */
function closeBrandEvidence(
  text: string,
  start: number,
  end: number,
  ranked: boolean,
): boolean {
  const after = text.slice(end);
  const suffix = after.replace(/^(?:\*\*|__|\])/, '');
  const ordinaryVerb =
    /^\s+(?:(?:the|a|an|this|that|your|our|it)\b|(?:(?:more|many|new|additional|those|these|some|all|better|larger|small|big)\s+)*(?:deals?|windows?|doors?|tickets?|accounts?|sales?|leads?)\b)/iu.test(
      suffix,
    );
  if (ordinaryVerb || text.slice(start, end) !== 'Close') return false;
  if (ranked) return /\bcrm\b/iu.test(text);
  // "Close is a CRM", "Close CRM", and explicitly formatted product names
  // with a following CRM description provide local brand evidence.
  if (
    /^\s*(?:(?:is|offers|provides)\s+(?:(?:a|an|the)\s+)?(?:[\p{L}-]+\s+){0,3})?(?:crm|sales software|sales platform)\b/iu.test(
      suffix,
    )
  )
    return true;
  const before = text.slice(0, start);
  const formatted =
    /(?:\*\*|__|\[)$/.test(before) && /^(?:\*\*|__|\])/.test(after);
  return (
    formatted &&
    /^(?:[ \t]*[-—–:][ \t]*|[ \t]*\n[ \t]*)(?:(?:an?|the)\s+)?(?:[\p{L}-]+\s+){0,5}(?:crm|software|platform)\b/iu.test(
      suffix,
    )
  );
}
function aggregate(
  text: string,
  occurrences: Occurrence[],
  raw: RawResponse,
): BrandMention[] {
  const groups = new Map<string, Occurrence[]>();
  for (const occurrence of occurrences) {
    const key = JSON.stringify([
      occurrence.candidate.brand,
      occurrence.ambiguous,
    ]);
    const group = groups.get(key) ?? [];
    group.push(occurrence);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const first = group[0]!;
    const ranked = group.find((occurrence) => occurrence.position !== null);
    const citationIndexes = raw.citations.flatMap((citation, index) =>
      supports(group, citation, raw, text) ? [index] : [],
    );
    return {
      brand: first.candidate.brand,
      alias: first.written,
      position: ranked?.position ?? null,
      mentionCount: group.length,
      ambiguous: first.ambiguous,
      ambiguityReason: first.ambiguous
        ? 'Close can be an ordinary verb; this occurrence lacks clear brand context.'
        : null,
      sourceSpan: {
        startIndex: first.start,
        endIndex: first.end,
        text: text.slice(first.start, first.end),
      },
      confidence: first.ambiguous
        ? 0.25
        : first.candidate.domains.length
          ? 0.95
          : ranked
            ? 0.8
            : 0.65,
      citationIndexes,
    };
  });
}
function supports(
  group: Occurrence[],
  citation: Citation,
  raw: RawResponse,
  text: string,
): boolean {
  if (group[0]!.ambiguous) return false;
  const candidate = group[0]!.candidate;
  // Trusted seed domains and directly linked names provide evidence without projecting unknown units.
  let domain: string;
  try {
    domain = normalizeDomain(citation.url);
  } catch {
    return false;
  }
  if (
    candidate.domains.some(
      (knownDomain) =>
        domain === knownDomain || domain.endsWith(`.${knownDomain}`),
    ) ||
    candidate.linkedUrls.includes(citation.url)
  )
    return true;
  const metadata = record(record(raw.body).metadata);
  if (metadata.citationOffsetBasis !== 'joined-answer') return false;
  let start = citation.startIndex;
  let end = citation.endIndex;
  if (start === undefined || end === undefined || start > end) return false;
  if (metadata.citationOffsetUnit === 'utf8-bytes') {
    const bytes = Buffer.from(text, 'utf8');
    if (end > bytes.length) return false;
    const prefix = bytes.subarray(0, start).toString('utf8');
    const segment = bytes.subarray(start, end).toString('utf8');
    if (
      Buffer.byteLength(prefix) !== start ||
      Buffer.byteLength(segment) !== end - start
    )
      return false;
    start = prefix.length;
    end = start + segment.length;
  } else if (metadata.citationOffsetUnit !== 'utf16-code-units') return false;
  if (end > text.length) return false;
  return group.some(
    (occurrence) => start < occurrence.end && end > occurrence.start,
  );
}
