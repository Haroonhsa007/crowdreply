import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LoginForm } from '../src/app/login/login-form';
import { Navigation } from '../src/components/nav';

const { login, route } = vi.hoisted(() => ({
  login: vi.fn<
    (
      previous: { error?: string },
      form: FormData,
    ) => Promise<{
      error?: string;
      retryAfterSeconds?: number;
    }>
  >(),
  route: { pathname: '/' },
}));
vi.mock('../src/app/login/actions', () => ({ login }));
vi.mock('next/navigation', () => ({ usePathname: () => route.pathname }));

beforeEach(() => {
  login.mockReset();
  login.mockResolvedValue({
    error: 'Unable to sign in. Check your username and password.',
  });
  route.pathname = '/';
});

describe('operator sign-in', () => {
  it('supports password visibility, clears the password before the server action, and keeps the username', async () => {
    const user = userEvent.setup();
    render(<LoginForm next="/executions" />);
    const username = screen.getByLabelText('Username') as HTMLInputElement;
    const password = screen.getByLabelText('Password') as HTMLInputElement;
    await user.type(username, 'fixture-operator');
    await user.type(password, 'placeholder-password');
    await user.click(screen.getByRole('button', { name: 'Show password' }));
    expect(password.type).toBe('text');
    expect(
      screen
        .getByRole('button', { name: 'Hide password' })
        .getAttribute('aria-pressed'),
    ).toBe('true');
    login.mockImplementationOnce(async (_previous, form) => {
      expect(password.value).toBe('');
      expect(form.get('password')).toBe('placeholder-password');
      expect(form.get('next')).toBe('/executions');
      return { error: 'Unable to sign in. Check your username and password.' };
    });
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByRole('alert');
    expect(login).toHaveBeenCalledTimes(1);
    expect(username.value).toBe('fixture-operator');
    expect(password.value).toBe('');
    expect(password.type).toBe('password');
    expect(login.mock.calls[0]?.[1].has('password')).toBe(false);
    expect(username.autocomplete).toBe('username');
    expect(password.autocomplete).toBe('current-password');
  });

  it('preserves a reentered password across visibility changes after a failed sign-in resets the form', async () => {
    const user = userEvent.setup();
    render(<LoginForm next="/" />);
    const username = screen.getByLabelText('Username') as HTMLInputElement;
    const password = screen.getByLabelText('Password') as HTMLInputElement;
    await user.type(username, 'fixture-operator');
    await user.type(password, 'placeholder-incorrect-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    await screen.findByRole('alert');
    expect(password.value).toBe('');
    act(() => password.form!.reset());
    await user.type(password, 'placeholder-corrected-password');
    expect(password.value).toBe('placeholder-corrected-password');
    await user.click(screen.getByRole('button', { name: 'Show password' }));
    expect(password.type).toBe('text');
    expect(password.value).toBe('placeholder-corrected-password');
    await user.click(screen.getByRole('button', { name: 'Hide password' }));
    expect(password.type).toBe('password');
    expect(password.value).toBe('placeholder-corrected-password');
    login.mockImplementationOnce(async (_previous, form) => {
      expect(form.get('password')).toBe('placeholder-corrected-password');
      expect(password.value).toBe('');
      return { error: 'Unable to sign in. Check your username and password.' };
    });
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(login).toHaveBeenCalledTimes(2);
    expect(password.value).toBe('');
    expect(login.mock.calls[1]?.[1].has('password')).toBe(false);
  });

  it('disables submission during the returned cooldown and makes it available after expiry', async () => {
    const user = userEvent.setup();
    login.mockResolvedValueOnce({
      error:
        'Too many sign-in attempts. Wait for the cooldown, then try again.',
      retryAfterSeconds: 2,
    });
    render(<LoginForm next="/" />);
    await user.type(screen.getByLabelText('Username'), 'fixture-operator');
    await user.type(screen.getByLabelText('Password'), 'placeholder-password');
    vi.useFakeTimers();
    await act(async () => {
      fireEvent.submit(
        screen.getByRole('button', { name: 'Sign in' }).closest('form')!,
      );
    });
    expect(
      (screen.getByRole('button', { name: 'Please wait' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(screen.getByText(/Sign in available in/).textContent).toContain(
      '2 seconds',
    );
    act(() => vi.advanceTimersByTime(2100));
    expect(
      (screen.getByRole('button', { name: 'Sign in' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });
});

describe('workspace navigation', () => {
  it('marks executions active on an execution detail and reserves submit for its own route', () => {
    route.pathname = '/executions/fixture-execution';
    const view = render(<Navigation />);
    expect(
      screen
        .getByRole('link', { name: 'Answers' })
        .getAttribute('aria-current'),
    ).toBe('page');
    expect(
      screen
        .getByRole('link', { name: /Ask a question/ })
        .getAttribute('aria-current'),
    ).toBeNull();
    route.pathname = '/executions/new';
    view.rerender(<Navigation />);
    expect(
      screen
        .getByRole('link', { name: /Ask a question/ })
        .getAttribute('aria-current'),
    ).toBe('page');
    expect(
      screen
        .getByRole('link', { name: 'Answers' })
        .getAttribute('aria-current'),
    ).toBeNull();
  });

  it('exposes menu state, closes on route selection and restores focus on Escape', async () => {
    const user = userEvent.setup();
    render(<Navigation footer={<button>Sign out</button>} />);
    const menu = screen.getByRole('button', { name: 'Menu' });
    expect(menu.getAttribute('aria-expanded')).toBe('false');
    expect(
      document.getElementById(menu.getAttribute('aria-controls')!),
    ).not.toBeNull();
    await user.click(menu);
    expect(menu.getAttribute('aria-expanded')).toBe('true');
    const executions = screen.getByRole('link', { name: 'Answers' });
    executions.addEventListener('click', (event) => event.preventDefault());
    await user.click(executions);
    expect(menu.getAttribute('aria-expanded')).toBe('false');
    await user.click(menu);
    screen.getByRole('button', { name: 'Sign out' }).focus();
    await user.keyboard('{Escape}');
    expect(menu.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(menu);
  });

  it('closes on Escape while focus remains on the Menu button', async () => {
    const user = userEvent.setup();
    render(<Navigation />);
    const menu = screen.getByRole('button', { name: 'Menu' });
    await user.click(menu);
    expect(document.activeElement).toBe(menu);
    expect(menu.getAttribute('aria-expanded')).toBe('true');
    await user.keyboard('{Escape}');
    expect(menu.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(menu);
  });

  it.each([
    ['/', 'Overview'],
    ['/executions/new', 'Ask a question'],
  ])(
    'returns focus to Menu when selecting the current route %s',
    async (pathname, label) => {
      route.pathname = pathname;
      const user = userEvent.setup();
      render(<Navigation />);
      const menu = screen.getByRole('button', { name: 'Menu' });
      await user.click(menu);
      const current = screen.getByRole('link', { name: label });
      current.addEventListener('click', (event) => event.preventDefault());
      await user.click(current);
      expect(menu.getAttribute('aria-expanded')).toBe('false');
      expect(document.activeElement).toBe(menu);
    },
  );

  it('keeps focus on the current navigation link when Menu is hidden on desktop', async () => {
    const user = userEvent.setup();
    render(<Navigation />);
    const menu = screen.getByRole('button', { name: 'Menu' });
    await user.click(menu);
    menu.style.display = 'none';
    const overview = screen.getByRole('link', { name: 'Overview' });
    overview.addEventListener('click', (event) => event.preventDefault());
    await user.click(overview);
    expect(menu.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(overview);
  });
});
