import type { ProviderId } from '../contracts/index.js';
import { liveCostEstimate } from '../providers/pricing.js';

export const LIVE_BUDGET_LEDGER_KEY = '__live_budget_gate__';

/** Recovery runs without worker dependencies; read the same validated runtime setting.
 * Unknown model pricing stays genuinely unknown rather than becoming free spending.
 */
export function worstCaseReservation(
  provider: ProviderId,
  model: string,
  minimum = Number(process.env.LIVE_CALL_RESERVE_USD ?? '0.05'),
): number | null {
  const estimate = liveCostEstimate(provider, model);
  return Number.isFinite(minimum) && minimum > 0 && estimate !== null
    ? Math.max(minimum, estimate)
    : null;
}
