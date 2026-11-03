import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import KeysPage from '../src/app/(console)/settings/keys/page';
import ProvidersPage from '../src/app/(console)/providers/page';
const { providers, saveKey } = vi.hoisted(() => ({
  providers: vi.fn(),
  saveKey: vi.fn(async () => ({ message: 'Configured access saved' })),
}));
vi.mock('../src/lib/api/providers', () => ({ providers }));
vi.mock('../src/app/(console)/settings/keys/actions', () => ({ saveKey }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
const notice =
  'Paid provider execution is currently blocked pending verified billing limits. Saving a key configures access but does not enable paid calls.';
beforeEach(() => {
  providers.mockReset();
  providers.mockResolvedValue([
    { provider: 'openai', mode: 'live', keySource: 'env', liveSupported: true },
    {
      provider: 'google_ai',
      mode: 'mock',
      keySource: 'none',
      liveSupported: false,
    },
  ]);
});
describe('configured access and paid execution boundary', () => {
  it('shows the execution block on Providers while retaining configured mode and key navigation', async () => {
    render(await ProvidersPage());
    expect(screen.getByText(notice)).not.toBeNull();
    expect(screen.getByText('Live')).not.toBeNull();
    expect(
      screen.getByRole('link', { name: 'Manage keys' }).getAttribute('href'),
    ).toBe('/settings/keys');
  });
  it('retains the key form flow and notice without echoing the saved placeholder key', async () => {
    const user = userEvent.setup();
    const view = render(await KeysPage());
    expect(screen.getByText(notice)).not.toBeNull();
    const input = screen.getByLabelText(
      'Temporary API key',
    ) as HTMLInputElement;
    await user.type(input, 'placeholder-provider-key-never-render');
    await user.click(
      screen.getByRole('button', { name: 'Save temporary key' }),
    );
    expect(await screen.findByText('Configured access saved')).not.toBeNull();
    expect(saveKey).toHaveBeenCalledTimes(1);
    expect(input.value).toBe('');
    expect(view.container.innerHTML).not.toContain(
      'placeholder-provider-key-never-render',
    );
    expect(screen.getByText(notice)).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Remove' })).not.toBeNull();
  });
  it.each([
    ['Providers', ProvidersPage],
    ['Provider keys', KeysPage],
  ])(
    'keeps the paid block visible when %s data cannot load',
    async (_name, page) => {
      providers.mockRejectedValueOnce(
        new Error('placeholder-upstream-details'),
      );
      const view = render(await page());
      expect(screen.getByText(notice)).not.toBeNull();
      expect(
        screen.getByRole('heading', { name: 'Could not load this data' }),
      ).not.toBeNull();
      expect(view.container.textContent).not.toContain(
        'placeholder-upstream-details',
      );
    },
  );
});
