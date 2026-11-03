import { createHash } from 'node:crypto';
import { z } from 'zod';

const nonempty = z.string().trim().min(1);
const timestamp = z.string().datetime();
const count = z.number().int().nonnegative().nullable();
const money = z.number().finite().nonnegative().nullable();
const runDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, 'Expected a real UTC calendar date YYYY-MM-DD');

/** CODEX-02/03/04/06 validate the five distinct provider identities. */
export const ProviderIdSchema = z.enum(['openai', 'perplexity', 'gemini', 'anthropic', 'google_ai']);
/** CODEX-02/03/04/06 share provider identities. */
export type ProviderId = z.infer<typeof ProviderIdSchema>;
/** CODEX-04/06 distinguish declared live, mock and unavailable integrations. */
export const IntegrationStatusSchema = z.enum(['live', 'mock', 'not_integrated']);
/** CODEX-04/06 consume integration labels, not proof of an implemented adapter. */
export type IntegrationStatus = z.infer<typeof IntegrationStatusSchema>;
/** CODEX-03/04/06 consume capability, never a static execution mode; Google AI remains mock-only. */
export const PROVIDER_LIVE_SUPPORT: Readonly<Record<ProviderId, boolean>> = Object.freeze({
  openai: true, perplexity: true, gemini: true, anthropic: true, google_ai: false,
});
/** CODEX-03/04/06 persist actual mode per attempt and execution. */
export const ProviderModeSchema = z.enum(['live', 'mock']);
/** CODEX-03/04/06 consume actual execution mode. */
export type ProviderMode = z.infer<typeof ProviderModeSchema>;

/** CODEX-02/03 persist provider lifecycle independently of extraction; dead is Mongo state. */
export const ExecutionStatusSchema = z.enum(['queued', 'running', 'retry_wait', 'succeeded', 'dead', 'unknown_outcome']);
/** CODEX-02/03 never automatically retry unknown_outcome or completed success. */
export type ExecutionStatus = z.infer<typeof ExecutionStatusSchema>;
/** CODEX-02/03 and later extraction tasks track raw-response processing separately. */
export const ExtractionStatusSchema = z.enum(['not_applicable', 'pending', 'extracting', 'extracted', 'extraction_failed']);
/** CODEX-02/03 consume independent extraction state. */
export type ExtractionStatus = z.infer<typeof ExtractionStatusSchema>;

/** CODEX-02/03/06 validate stable execution identity, including deliberate reruns. */
export const ExecutionKeyInputSchema = z.object({
  questionId: nonempty, questionVersion: z.number().int().positive(), provider: ProviderIdSchema,
  modelSettingsVersion: nonempty, runDate: runDateSchema, runSeq: z.number().int().nonnegative().default(0),
}).strict();
/** CODEX-03/06 may omit runSeq, which defaults to zero. */
export type ExecutionKeyInput = z.input<typeof ExecutionKeyInputSchema>;
/** CODEX-02/03/06 use length-safe JSON-joined fields before SHA-256; Mongo enforces uniqueness. */
export function buildExecutionKey(input: ExecutionKeyInput): string {
  const v = ExecutionKeyInputSchema.parse(input);
  return createHash('sha256').update(JSON.stringify([
    v.questionId, v.questionVersion, v.provider, v.modelSettingsVersion, v.runDate, v.runSeq,
  ])).digest('hex');
}
/** CODEX-03/06 derive run dates from UTC, never host-local calendar time. */
export function utcRunDate(date: Date): string {
  if (!Number.isFinite(date.getTime())) throw new RangeError('Invalid run date');
  return date.toISOString().slice(0, 10);
}

/** CODEX-04 and extraction consumers receive a typed URL error without echoing input. */
export class InvalidCitationUrlError extends Error {
  constructor() { super('Invalid HTTP(S) citation URL'); this.name = 'InvalidCitationUrlError'; }
}
/** CODEX-04 and extraction consumers normalize citation hosts without ports or www. */
export function normalizeDomain(value: string): string {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
      throw new InvalidCitationUrlError();
    }
    return url.hostname.toLowerCase().replace(/^www\./, '');
  } catch { throw new InvalidCitationUrlError(); }
}
const citationUrl = z.string().refine(value => {
  try { normalizeDomain(value); return true; } catch { return false; }
}, 'Expected an HTTP(S) citation URL without credentials');
/** CODEX-04 preserves provider citations; extraction/API consumers retain source offsets. */
export const CitationSchema = z.object({
  url: citationUrl, domain: nonempty, title: z.string().optional(),
  startIndex: z.number().int().nonnegative().optional(), endIndex: z.number().int().nonnegative().optional(),
}).refine(v => v.startIndex === undefined || v.endIndex === undefined || v.endIndex >= v.startIndex,
  'Citation offsets are reversed');
/** CODEX-02/04/06 store and expose citations without inventing absent sources. */
export type Citation = z.infer<typeof CitationSchema>;
/** CODEX-04 must supply every usage field; unknown values remain null. */
export const UsageSchema = z.object({ inputTokens: count, outputTokens: count, toolCalls: count });
/** CODEX-02/03/04/06 preserve unknown usage rather than zero-fill it. */
export type Usage = z.infer<typeof UsageSchema>;
/** CODEX-04 cost estimates include tokens and tools, with explicit unknowns. */
export const CostBreakdownSchema = z.object({ tokensUsd: money, toolsUsd: money, totalUsd: money });
/** CODEX-02/03/04/06 retain separate token/tool cost estimates. */
export type CostBreakdown = z.infer<typeof CostBreakdownSchema>;
/** CODEX-03 passes bounded execution settings to CODEX-04 adapters. */
export const ProviderRequestSchema = z.object({
  questionText: nonempty, questionId: nonempty, executionKey: z.string().regex(/^[a-f0-9]{64}$/),
  provider: ProviderIdSchema, model: nonempty, settings: z.object({ webSearch: z.boolean() }),
  timeoutMs: z.number().int().positive(),
});
/** CODEX-03/04 share the provider call input. */
export type ProviderRequest = z.infer<typeof ProviderRequestSchema>;
/** CODEX-04 preserves untouched rawPayload; CODEX-02/03 persist it before success. Mock payloads contain {mock:true}, null usage and zero total cost; they never count toward live spend. */
export const ProviderResultSchema = z.object({
  provider: ProviderIdSchema, integration: ProviderModeSchema, model: nonempty, rawPayload: z.unknown(), answerText: z.string(),
  citations: z.array(CitationSchema), citationsAvailable: z.enum(['yes', 'no', 'unknown']),
  usage: UsageSchema, cost: CostBreakdownSchema, latencyMs: z.number().finite().nonnegative(),
  requestId: z.string().nullable(), startedAt: timestamp, completedAt: timestamp,
});
/** CODEX-02/03/04 share successful provider output; citation absence is not request failure. */
export type ProviderResult = z.infer<typeof ProviderResultSchema>;
/** CODEX-03/04 classify failures without conflating provider/extraction outcomes. */
export const ProviderErrorCategorySchema = z.enum(['rate_limit', 'timeout', 'server', 'auth', 'invalid_request', 'unknown']);
/** CODEX-03/04 consume normalized provider error categories. */
export type ProviderErrorCategory = z.infer<typeof ProviderErrorCategorySchema>;
/** CODEX-03/04 permit bounded retries only for transient categories. */
export function isRetryable(category: ProviderErrorCategory): boolean {
  return category === 'rate_limit' || category === 'timeout' || category === 'server';
}
/** CODEX-03/04 validate normalized error metadata; never pass upstream secret messages. */
export const ProviderErrorSchema = z.object({
  category: ProviderErrorCategorySchema, httpStatus: z.number().int().min(100).max(599).optional(),
  retryable: z.boolean(), retryAfterMs: z.number().finite().nonnegative().optional(), message: nonempty,
});
/** CODEX-02/03/04 store sanitized provider error details. */
export type ProviderErrorDetails = z.infer<typeof ProviderErrorSchema>;
/** CODEX-04 throws this safe error; CODEX-03 consumes category, status and retry guidance. */
export class ProviderError extends Error {
  readonly category: ProviderErrorCategory;
  readonly httpStatus?: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  constructor(details: ProviderErrorDetails) {
    const parsed = ProviderErrorSchema.parse(details);
    // Fixed messages intentionally discard potentially secret upstream text.
    super(`Provider request failed (${parsed.category})`);
    this.name = 'ProviderError';
    this.category = parsed.category; this.httpStatus = parsed.httpStatus;
    this.retryable = isRetryable(parsed.category) && parsed.retryable;
    this.retryAfterMs = parsed.retryAfterMs;
  }
}
/** CODEX-04 implements adapters; CODEX-03 executes them with a cancellation signal. */
export interface ProviderAdapter {
  readonly id: ProviderId;
  readonly integration: IntegrationStatus;
  execute(request: ProviderRequest, signal: AbortSignal): Promise<ProviderResult>;
}
/** CODEX-02/03 persist per-attempt metadata without raw error text. */
export const AttemptSchema = z.object({
  n: z.number().int().positive(), integration: ProviderModeSchema, startedAt: timestamp, endedAt: timestamp.optional(),
  reservationUsd: money.optional(),
  errorCategory: ProviderErrorCategorySchema.optional(),
  httpStatus: z.number().int().min(100).max(599).optional(), retryable: z.boolean().optional(),
});
/** CODEX-02/03 retain attempt history independently from execution identity. */
export type Attempt = z.infer<typeof AttemptSchema>;
/** CODEX-02 stores raw body untouched before CODEX-03 can mark provider success. */
export const RawResponseSchema = z.object({
  executionId: nonempty, body: z.unknown(), outputText: z.string(), citations: z.array(CitationSchema),
  providerResponseId: z.string().nullable(), createdAt: timestamp,
});
/** CODEX-02/03 and extraction consumers reference durable raw provider data. */
export type RawResponse = z.infer<typeof RawResponseSchema>;
/** CODEX-02 persists execution authority; CODEX-03/06 consume separate provider/extraction state. */
export const ExecutionSchema = z.object({
  id: nonempty, executionKey: z.string().regex(/^[a-f0-9]{64}$/), questionId: nonempty,
  questionText: nonempty, questionVersion: z.number().int().positive(), provider: ProviderIdSchema,
  model: nonempty, modelSettingsVersion: nonempty, runDate: runDateSchema,
  runSeq: z.number().int().nonnegative(), settings: z.object({ webSearch: z.boolean() }),
  status: ExecutionStatusSchema, integration: ProviderModeSchema.optional(), extractionStatus: ExtractionStatusSchema, attempts: z.array(AttemptSchema),
  retryAt: timestamp.optional(), lastErrorCategory: ProviderErrorCategorySchema.optional(),
  leaseUntil: timestamp.optional(), citationsAvailable: z.enum(['yes', 'no', 'unknown']),
  claimToken: nonempty.optional(), dispatchCount: z.number().int().nonnegative().optional(),
  claimAttemptRecorded: z.boolean().optional(),
  lastRecoveryTouch: timestamp.optional(), completionPending: z.boolean().optional(),
  extractionId: nonempty.optional(),
  rawResponseId: nonempty.optional(), usage: UsageSchema.optional(), cost: CostBreakdownSchema.optional(),
  latencyMs: z.number().finite().nonnegative().optional(),
  createdAt: timestamp, updatedAt: timestamp, startedAt: timestamp.optional(), completedAt: timestamp.optional(),
}).refine(v => v.status !== 'succeeded' || Boolean(v.rawResponseId),
  'Succeeded executions require a stored raw response reference');
/** CODEX-02/03/06 share string IDs and ISO UTC timestamps, converted explicitly at DB boundaries. */
export type Execution = z.infer<typeof ExecutionSchema>;
/** CODEX-03 transports only IDs; MongoDB remains the source of truth. */
export const QueueJobPayloadSchema = z.object({ executionId: nonempty, executionKey: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
/** CODEX-03/06 enqueue references instead of mutable execution snapshots. */
export type QueueJobPayload = z.infer<typeof QueueJobPayloadSchema>;
/** CODEX-02/03 account for provider and extraction spend with deduplicated entries. */
export const SpendRecordSchema = z.object({
  idempotencyKey: nonempty, executionId: nonempty, stage: z.enum(['provider', 'extraction']), amountUsd: money,
});
/** CODEX-02/03 must preserve unknown spend and enforce the Director's build-wide cap later. */
export type SpendRecord = z.infer<typeof SpendRecordSchema>;
/** Compare-and-set ownership; recovery includes the exact lease it observed. */
export interface ClaimFence { claimToken?: string; leaseUntil?: string; }
/** CODEX-02 implements Mongo authority; CODEX-03/06 consume these frozen persistence operations. */
export interface ExecutionRepository {
  /** CODEX-02 atomically inserts queued work, deriving executionKey; a unique index decides concurrent duplicates. */
  createQueuedIfAbsent(input: CreateExecutionInput): Promise<{ execution: Execution; created: boolean }>;
  /** CODEX-02 implements; CODEX-06 reads a single execution. */
  getById(executionId: string): Promise<Execution | null>;
  /** CODEX-02 implements; CODEX-06 exposes only the safe raw projection. */
  getRawResponse(executionId: string): Promise<RawResponse | null>;
  /** CODEX-02 implements newest-first bounded pagination (limit 1–100); CODEX-06 consumes. */
  listRecent(query: { limit: number; before?: string; provider?: ProviderId; status?: ExecutionStatus }): Promise<Execution[]>;
  /** CODEX-02 persists retry_wait, ISO retryAt and category; CODEX-03 schedules transport. */
  scheduleRetry(executionId: string, retryAt: Date, errorCategory: ProviderErrorCategory, fence?: ClaimFence): Promise<void>;
  /** Expected budget-gate waiting refunds this claim's dispatch count atomically. */
  deferForBudget?(executionId: string, retryAt: Date, fence: ClaimFence): Promise<void>;
  /** Final pre-call ownership check; an expired/revoked lease may not dispatch. */
  assertDispatch?(executionId: string, fence: ClaimFence): Promise<void>;
  /** CODEX-02 returns queued, due retry_wait and expired running leases, never terminal states; CODEX-03 reconciles before re-enqueue after restart/Redis loss. */
  listRecoverable(now: Date, limit: number): Promise<Execution[]>;
  /** Recovery rotates a bounded batch even when transport fails or stays paused. */
  touchRecovery?(executionId: string, now: Date): Promise<void>;
  /** Reconcile a persisted response without calling its provider again. */
  reconcileCompletion?(executionId: string, fence?: ClaimFence): Promise<boolean>;
  /** Recover the single global budget owner, including terminal and pre-attempt crashes. */
  recoverBudgetGate?(now: Date): Promise<void>;
  /** CODEX-02 atomically claims eligible queued/due retry work; returns null for success/dead/unknown or active leases. Expired possibly-paid calls require reconciliation, never blind retry. */
  claim(executionKey: string, leaseMs: number): Promise<Execution | null>;
  /** CODEX-02 persists attempts; CODEX-03 calls before a provider request. */
  recordAttempt(executionId: string, attempt: Attempt, fence?: ClaimFence): Promise<void>;
  /** Stage complete response evidence before any settlement; never provider-replay a staged result. */
  stageProviderResult?(executionId: string, raw: RawResponse, result: ProviderResult, settlementUsd: number | null, fence?: ClaimFence): Promise<void>;
  /** CODEX-02 durably upserts raw first, then conditionally marks success; CODEX-03 never repeats a successful paid request for extraction failure. */
  /** Preserve incomplete paid evidence without declaring provider success. */
  savePartialRaw?(executionId: string, raw: RawResponse, fence?: ClaimFence): Promise<void>;
  saveRawAndComplete(executionId: string, raw: RawResponse, result: ProviderResult, fence?: ClaimFence): Promise<Execution>;
  /** CODEX-02 persists terminal dead-letter state; CODEX-03 supplies sanitized details. */
  markDead(executionId: string, error: ProviderErrorDetails, fence?: ClaimFence): Promise<void>;
  /** CODEX-02 persists ambiguity after a possibly paid call; CODEX-03 must not auto-retry. */
  markUnknownOutcome(executionId: string, fence?: ClaimFence): Promise<void>;
  /** CODEX-02 deduplicates by idempotencyKey; CODEX-03 includes retries/extraction. This records spend, not a budget reservation. */
  recordSpend(record: SpendRecord): Promise<void>;
  /** CODEX-02 returns build-wide actual total, null if any amount is unknown; CODEX-03 must fail closed for budget decisions. */
  getSpendTotal(): Promise<number | null>;
}

/** CODEX-02/06 validate creation independently of persistence-managed state. */
export const CreateExecutionInputSchema = z.object({
  questionId: nonempty, questionText: nonempty, questionVersion: z.number().int().positive(),
  provider: ProviderIdSchema, model: nonempty, modelSettingsVersion: nonempty,
  runDate: runDateSchema, runSeq: z.number().int().nonnegative().default(0),
  settings: z.object({ webSearch: z.boolean() }).strict(),
}).strict();
/** CODEX-02/06 consume parsed creation input (runSeq defaults to zero). */
export type CreateExecutionInput = z.infer<typeof CreateExecutionInputSchema>;
/** CODEX-03 implements idempotent executionKey enqueue; CODEX-06 consumes. */
export interface ExecutionEnqueuer { enqueue(payload: QueueJobPayload): Promise<void>; }
/** CODEX-06 returns and CODEX-07 renders a strict projection; mode is stored execution mode, absent before first attempt. */
export const ApiExecutionViewSchema = z.object({
  id: nonempty, executionKey: z.string().regex(/^[a-f0-9]{64}$/), questionText: nonempty,
  provider: ProviderIdSchema, integration: ProviderModeSchema.optional(), model: nonempty,
  status: ExecutionStatusSchema, extractionStatus: ExtractionStatusSchema,
  extraction: z.object({ id: nonempty, extractorVersion: nonempty, method: z.enum(['rule_based', 'llm']), status: ExtractionStatusSchema, mentionCount: z.number().int().nonnegative(), createdAt: timestamp }).strict().optional(),
  citationsAvailable: z.enum(['yes', 'no', 'unknown']), attemptCount: z.number().int().nonnegative(),
  retryAt: timestamp.optional(), lastErrorCategory: ProviderErrorCategorySchema.optional(),
  latencyMs: z.number().nonnegative().optional(), usage: UsageSchema.optional(), cost: CostBreakdownSchema.optional(),
  createdAt: timestamp, completedAt: timestamp.optional(),
  raw: z.object({ outputText: z.string(), citations: z.array(CitationSchema), providerResponseId: z.string().nullable() }).strict().optional(),
}).strict();
/** CODEX-06/07 consume a safe execution view, never raw provider payloads. */
export type ApiExecutionView = z.infer<typeof ApiExecutionViewSchema>;
/** CODEX-06/07 share bounded cursor pages. */
export const ApiExecutionListResponseSchema = z.object({ items: z.array(ApiExecutionViewSchema), nextBefore: nonempty.optional() }).strict();
/** CODEX-06/07 consume bounded execution pages. */
export type ApiExecutionListResponse = z.infer<typeof ApiExecutionListResponseSchema>;
/** CODEX-06 validates submission; CODEX-07 validates forms using the same defaults. */
export const ApiSubmitRequestSchema = z.object({
  questionText: z.string().trim().min(1).max(2000), questionId: nonempty.optional(),
  provider: ProviderIdSchema.default('openai'), webSearch: z.boolean().default(true), force: z.boolean().default(false),
}).strict();
/** CODEX-06/07 consume validated submit inputs. */
export type ApiSubmitRequest = z.infer<typeof ApiSubmitRequestSchema>;
/** Keys task and CODEX-03/06 distinguish temporary user keys from server configuration. */
export const KeySourceSchema = z.enum(['user', 'env', 'none']);
/** Keys task and CODEX-03/06 consume key provenance without exposing credentials. */
export type KeySource = z.infer<typeof KeySourceSchema>;
/** Keys task resolves access only inside the server; CODEX-03/04 consumes it. */
export const ResolvedProviderAccessSchema = z.object({
  provider: ProviderIdSchema, mode: ProviderModeSchema, keySource: KeySourceSchema,
  /** Secret: never log, serialize to a client, or persist this decrypted value. */
  apiKey: z.string().min(8).max(512).optional(),
}).strict().refine(v => v.mode === 'live'
  ? PROVIDER_LIVE_SUPPORT[v.provider] && v.keySource !== 'none' && Boolean(v.apiKey)
  : v.apiKey === undefined && v.keySource === 'none', 'Inconsistent provider access');
/** Keys task returns this server-internal secret-bearing value to CODEX-03/04 only. */
export type ResolvedProviderAccess = z.infer<typeof ResolvedProviderAccessSchema>;
/** CODEX-03/04 logs only this explicit safe projection, never the access object. */
export function toSafeLog(access: ResolvedProviderAccess): Omit<ResolvedProviderAccess, 'apiKey'> {
  return { provider: access.provider, mode: access.mode, keySource: access.keySource };
}
/** Keys task implements user → env → mock resolution; Google AI is mock-only until supported. */
export interface ProviderKeyResolver { resolve(provider: ProviderId): Promise<ResolvedProviderAccess>; }
/** Keys task and CODEX-06 expose configuration status without credentials. */
export const ProviderKeyStatusSchema = z.object({
  provider: ProviderIdSchema, configured: z.boolean(), source: KeySourceSchema, expiresAt: timestamp.optional(),
}).strict();
/** Keys task/CODEX-06 consume credential-free status. */
export type ProviderKeyStatus = z.infer<typeof ProviderKeyStatusSchema>;
/** Keys task implements encrypted Redis storage; plaintext reads are server-internal only. */
export interface ProviderKeyStore {
  set(provider: ProviderId, apiKey: string, ttlSeconds: number): Promise<{ expiresAt: string }>;
  /** Server-internal only; decrypted keys never reach logs, clients or disk. */
  getDecrypted(provider: ProviderId): Promise<string | null>;
  status(provider: ProviderId): Promise<ProviderKeyStatus>;
  remove(provider: ProviderId): Promise<void>;
}
/** CODEX-06/07 exchange strict provider capability and access status, never keys. */
export const ApiProviderStatusSchema = z.object({
  provider: ProviderIdSchema, liveSupported: z.boolean(), mode: ProviderModeSchema,
  keySource: KeySourceSchema, expiresAt: timestamp.optional(),
}).strict();
/** CODEX-06/07 consume safe provider status. */
export type ApiProviderStatus = z.infer<typeof ApiProviderStatusSchema>;
/** CODEX-06 accepts transient keys; Google AI cannot accept keys while unsupported. */
export const ApiSetProviderKeyRequestSchema = z.object({
  provider: ProviderIdSchema.refine(v => PROVIDER_LIVE_SUPPORT[v], 'Provider is mock-only'),
  apiKey: z.string().min(8).max(512).regex(/^[^\s\x00-\x1f\x7f]+$/),
}).strict();
/** CODEX-06 validates key writes; never serialize this request back to clients. */
export type ApiSetProviderKeyRequest = z.infer<typeof ApiSetProviderKeyRequestSchema>;
/** CODEX-06/07 share a credential-free provider list. */
export const ApiProviderStatusListResponseSchema = z.object({ items: z.array(ApiProviderStatusSchema) }).strict();
/** CODEX-06/07 consume provider list responses. */
export type ApiProviderStatusListResponse = z.infer<typeof ApiProviderStatusListResponseSchema>;
/** Keys task enforces one-hour TTL; mock raw payloads carry {mock:true}, null usage and zero total cost; mock executions never count toward live spend. */
export const USER_KEY_TTL_SECONDS_MAX = 3600;
