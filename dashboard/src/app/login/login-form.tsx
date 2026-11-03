'use client';
import { useActionState, useEffect, useRef, useState } from 'react';
import { login } from './actions';

type LoginState = { error?: string; retryAfterSeconds?: number };

export function LoginForm({ next }: { next: string }) {
  const password = useRef<HTMLInputElement>(null);
  const cooldownDeadline = useRef(0);
  const [username, setUsername] = useState('');
  const [passwordValue, setPasswordValue] = useState('');
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [remainingSeconds, setRemainingSeconds] = useState(0);
  const coolingDown = remainingSeconds > 0;
  const [state, action, pending] = useActionState(
    async (previous: LoginState, form: FormData): Promise<LoginState> => {
      if (password.current) password.current.value = '';
      setPasswordValue('');
      setPasswordVisible(false);
      try {
        const result = await login(previous, form);
        const seconds = result.retryAfterSeconds ?? 0;
        cooldownDeadline.current = Date.now() + seconds * 1000;
        setRemainingSeconds(seconds);
        return result;
      } finally {
        form.delete('password');
      }
    },
    {},
  );

  useEffect(() => {
    if (!coolingDown) return;
    const timer = window.setInterval(() => {
      setRemainingSeconds(
        Math.max(0, Math.ceil((cooldownDeadline.current - Date.now()) / 1000)),
      );
    }, 1000);
    return () => window.clearInterval(timer);
  }, [coolingDown]);

  return (
    <form action={action} className="login-form" aria-busy={pending}>
      <input type="hidden" name="next" value={next} />
      <div className="login-field">
        <label htmlFor="operator-username">Username</label>
        <input
          id="operator-username"
          name="username"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          required
        />
      </div>
      <div className="login-field">
        <label htmlFor="operator-password">Password</label>
        <div className="password-control">
          <input
            ref={password}
            id="operator-password"
            name="password"
            type={passwordVisible ? 'text' : 'password'}
            autoComplete="current-password"
            value={passwordValue}
            onChange={(event) => setPasswordValue(event.target.value)}
            required
          />
          <button
            className="password-toggle"
            type="button"
            aria-controls="operator-password"
            aria-label={passwordVisible ? 'Hide password' : 'Show password'}
            aria-pressed={passwordVisible}
            onClick={() => setPasswordVisible((visible) => !visible)}
          >
            {passwordVisible ? 'Hide' : 'Show'}
          </button>
        </div>
      </div>
      {state.error && (
        <div className="login-feedback">
          <p className="error" role="alert">
            {state.error}
          </p>
          {coolingDown && (
            <p className="muted" aria-live="off">
              Sign in available in{' '}
              <span className="numeric">{remainingSeconds}</span> seconds.
            </p>
          )}
        </div>
      )}
      <button className="primary" disabled={pending || coolingDown}>
        {pending ? 'Signing in…' : coolingDown ? 'Please wait' : 'Sign in'}
      </button>
    </form>
  );
}
