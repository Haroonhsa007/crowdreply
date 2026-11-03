'use server';
import { requireSession } from '@/lib/auth/require-session';
import { removeProviderKey, setProviderKey } from '@/lib/api/providers';
import { revalidatePath } from 'next/cache';
export interface KeyState {
  error?: string;
  message?: string;
}
export async function saveKey(
  _previous: KeyState,
  form: FormData,
): Promise<KeyState> {
  await requireSession();
  try {
    if (form.get('operation') === 'remove')
      await removeProviderKey(form.get('provider'));
    else
      await setProviderKey({
        provider: form.get('provider'),
        apiKey: form.get('apiKey'),
      });
    revalidatePath('/settings/keys');
    revalidatePath('/providers');
    return {
      message:
        form.get('operation') === 'remove'
          ? 'Temporary key removed.'
          : 'Temporary key saved for up to one hour.',
    };
  } catch {
    return {
      error: 'Could not update the key. Check the value and try again.',
    };
  } finally {
    form.delete('apiKey');
  }
}
