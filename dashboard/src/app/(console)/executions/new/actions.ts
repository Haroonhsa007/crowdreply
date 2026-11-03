'use server';
import { revalidatePath } from 'next/cache';
import {
  ApiSubmitRequestSchema,
  ProviderIdSchema,
  type ApiExecutionView,
  type ApiSubmitRequest,
} from '@contracts';
import { requireSession } from '@/lib/auth/require-session';
import { submitExecution } from '@/lib/api/executions';
import { ApiError } from '@/lib/api/client';
export interface SubmitState {
  error?: string;
  results?: { item: ApiExecutionView; created: boolean }[];
}
function refreshSubmittedViews(results: NonNullable<SubmitState['results']>) {
  if (!results.length) return;
  revalidatePath('/');
  revalidatePath('/executions');
}
export async function submitQuestion(
  _previous: SubmitState,
  form: FormData,
): Promise<SubmitState> {
  await requireSession();
  const selected = form.getAll('providers');
  const force = form.get('force') === 'on';
  if (
    !selected.length ||
    selected.length > 5 ||
    (force && form.get('forceConfirmed') !== 'yes')
  )
    return {
      error: 'Select at least one provider and confirm a forced rerun.',
    };
  const results: NonNullable<SubmitState['results']> = [];
  const requests: ApiSubmitRequest[] = [];
  for (const provider of new Set(selected)) {
    const parsed = ApiSubmitRequestSchema.safeParse({
      questionText: form.get('questionText'),
      provider: ProviderIdSchema.safeParse(provider).data,
      force,
    });
    if (!ProviderIdSchema.safeParse(provider).success || !parsed.success)
      return {
        error:
          'Enter a question of 1–2,000 characters and select valid providers.',
      };
    requests.push(parsed.data);
  }
  for (const request of requests) {
    try {
      const result = await submitExecution(request);
      results.push({ item: result.data, created: result.created });
    } catch (error) {
      refreshSubmittedViews(results);
      return {
        results,
        error:
          `${results.length ? 'Some submissions were accepted. ' : ''}` +
          'Submission could not be confirmed for every provider. Check Executions before trying again; a forced retry can create another paid execution.' +
          (error instanceof ApiError && error.requestId
            ? ` Request ${error.requestId}.`
            : ''),
      };
    }
  }
  refreshSubmittedViews(results);
  return { results };
}
