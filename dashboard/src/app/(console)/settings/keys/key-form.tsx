'use client';
import { useActionState, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { flushSync } from 'react-dom';
import type { ApiProviderStatus } from '@contracts';
import { saveKey, type KeyState } from './actions';
import { useUnsavedChanges } from '@/lib/forms/use-unsaved-changes';
import { useActionNotice } from '@/lib/forms/use-action-notice';
export function KeyForm({
  provider,
}: {
  provider: ApiProviderStatus['provider'];
}) {
  const form = useRef<HTMLFormElement>(null);
  const [dirty, setDirty] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const notice = useActionNotice();
  const [state, action, pending] = useActionState(
    async (previous: KeyState, data: FormData) => {
      const handle = notice.begin('Updating provider access…');
      // Clear the controlled secret before the action transition can suspend.
      flushSync(() => {
        setApiKey('');
        setDirty(false);
      });
      form.current?.reset();
      try {
        const result = await saveKey(previous, data);
        notice.finish(handle, {
          title: result.error
            ? 'Provider access needs attention'
            : 'Provider access updated',
          description:
            result.error ??
            result.message ??
            'Your provider setting was updated.',
          error: Boolean(result.error),
        });
        return result;
      } catch {
        const error =
          'Provider access could not be updated. Check its status before trying again.';
        notice.finish(handle, {
          title: 'Provider access needs attention',
          description: error,
          error: true,
        });
        return { error };
      } finally {
        data.delete('apiKey');
      }
    },
    {},
  );
  useUnsavedChanges(dirty && !pending);
  return (
    <form ref={form} action={action} className="form-stack">
      <input name="provider" type="hidden" value={provider} />
      <label htmlFor={`key-${provider}`}>
        Temporary API key
        <input
          id={`key-${provider}`}
          name="apiKey"
          type="password"
          autoComplete="off"
          disabled={pending}
          minLength={8}
          maxLength={512}
          required
          aria-describedby={`key-help-${provider}`}
          value={apiKey}
          onChange={(event) => {
            setApiKey(event.target.value);
            setDirty(true);
          }}
        />
      </label>
      <small id={`key-help-${provider}`}>
        Encrypted on the server. Expires in at most one hour. Never returned to
        this browser.
      </small>
      <div className="inline">
        <button name="operation" value="save" disabled={pending}>
          {pending ? 'Updating…' : 'Save temporary key'}
        </button>
        <button
          name="operation"
          value="remove"
          formNoValidate
          disabled={pending}
        >
          Remove
        </button>
      </div>
      {state.error && (
        <p className="error" role="alert">
          {state.error}
        </p>
      )}
      {state.message && <p role="status">{state.message}</p>}
    </form>
  );
}
export function KeyExpiry({
  value,
  initialNow,
}: {
  value: string;
  initialNow: number;
}) {
  const router = useRouter();
  const [now, setNow] = useState(initialNow);
  const expiry = Date.parse(value);
  useEffect(() => {
    const timer = window.setInterval(() => {
      const time = Date.now();
      setNow(time);
      if (time >= expiry) {
        window.clearInterval(timer);
        router.refresh();
      }
    }, 5000);
    return () => window.clearInterval(timer);
  }, [expiry, router]);
  return (
    <span className="num">
      {now >= expiry
        ? 'Expired · refreshing status'
        : `Using your key, expires in ${Math.ceil((expiry - now) / 60000)}m`}
    </span>
  );
}
