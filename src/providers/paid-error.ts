import {
  ProviderError,
  type Citation,
  type CostBreakdown,
  type Usage,
} from '../contracts/index.js';

/** Completed provider responses are durable evidence even if a later turn fails.
 * Deliberately omit httpStatus: a later HTTP error cannot make earlier paid work free.
 */
export class PaidProviderError extends ProviderError {
  constructor(
    category: ProviderError['category'],
    readonly partial: {
      rawPayload: unknown;
      answerText: string;
      citations: Citation[];
      usage: Usage;
      cost: CostBreakdown;
      requestId: string | null;
      completedAt: string;
    },
  ) {
    super({
      category,
      retryable: false,
      message: 'Paid provider work requires reconciliation',
    });
  }
}
