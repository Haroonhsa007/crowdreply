import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { KeyForm } from '../src/app/(console)/settings/keys/key-form';
import type { KeyState } from '../src/app/(console)/settings/keys/actions';

const { saveKey, begin, finish, handle } = vi.hoisted(() => ({
  saveKey: vi.fn<(previous: KeyState, data: FormData) => Promise<KeyState>>(),
  begin: vi.fn(),
  finish: vi.fn(),
  handle: { id: 'fixture-notice' },
}));
vi.mock('../src/app/(console)/settings/keys/actions', () => ({ saveKey }));
vi.mock('../src/lib/forms/use-action-notice', () => ({
  useActionNotice: () => ({ begin, finish }),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

beforeEach(() => {
  saveKey.mockReset();
  begin.mockReset();
  finish.mockReset();
  begin.mockReturnValue(handle);
});

describe('provider key pending input protection', () => {
  it.each(['success', 'failure', 'rejection'] as const)(
    'clears the submitted key and prevents new input until delayed %s settles',
    async (outcome) => {
      let resolve!: (value: KeyState) => void;
      let reject!: (reason: Error) => void;
      const pending = new Promise<KeyState>((resolvePending, rejectPending) => {
        resolve = resolvePending;
        reject = rejectPending;
      });
      let submitted: FormData | undefined;
      saveKey.mockImplementationOnce((_previous, data) => {
        submitted = data;
        expect(data.get('apiKey')).toBe('placeholder-submitted-provider-key');
        return pending;
      });
      const user = userEvent.setup();
      render(<KeyForm provider="openai" />);
      const input = screen.getByLabelText(
        'Temporary API key',
      ) as HTMLInputElement;
      await user.type(input, 'placeholder-submitted-provider-key');
      await user.click(
        screen.getByRole('button', { name: 'Save temporary key' }),
      );
      expect(saveKey).toHaveBeenCalledTimes(1);
      expect(input.value).toBe('');
      expect(input.disabled).toBe(true);
      expect(
        (screen.getByRole('button', { name: 'Updating…' }) as HTMLButtonElement)
          .disabled,
      ).toBe(true);
      expect(
        (screen.getByRole('button', { name: 'Remove' }) as HTMLButtonElement)
          .disabled,
      ).toBe(true);
      await user.type(input, 'placeholder-should-not-be-entered');
      expect(input.value).toBe('');
      expect(finish).not.toHaveBeenCalled();
      const message =
        outcome === 'success'
          ? 'Temporary key saved for up to one hour.'
          : outcome === 'failure'
            ? 'Could not update the key. Check the value and try again.'
            : 'Provider access could not be updated. Check its status before trying again.';
      await act(async () => {
        if (outcome === 'rejection')
          reject(new Error('placeholder-upstream-failure'));
        else resolve(outcome === 'success' ? { message } : { error: message });
      });
      expect(input.disabled).toBe(false);
      expect(input.value).toBe('');
      expect(
        screen.getByRole(outcome === 'success' ? 'status' : 'alert')
          .textContent,
      ).toBe(message);
      expect(finish).toHaveBeenCalledWith(handle, {
        title:
          outcome === 'success'
            ? 'Provider access updated'
            : 'Provider access needs attention',
        description: message,
        error: outcome !== 'success',
      });
      expect(submitted?.has('apiKey')).toBe(false);
      await user.type(input, 'placeholder-next-provider-key');
      expect(input.value).toBe('placeholder-next-provider-key');
    },
  );
});
