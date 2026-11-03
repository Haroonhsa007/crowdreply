import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SubmitState } from '../src/app/(console)/executions/new/actions';
import { ApiExecutionViewSchema } from '@contracts';
import { QuestionForm } from '../src/app/(console)/executions/new/question-form';
const { submitQuestion, beginNotice, finishNotice } = vi.hoisted(() => ({
  beginNotice: vi.fn(() => null),
  finishNotice: vi.fn(),
  submitQuestion:
    vi.fn<(previous: SubmitState, data: FormData) => Promise<SubmitState>>(),
}));
vi.mock('../src/lib/forms/use-action-notice', () => ({
  useActionNotice: () => ({ begin: beginNotice, finish: finishNotice }),
}));
vi.mock('../src/app/(console)/executions/new/actions', () => ({
  submitQuestion,
}));
beforeEach(() => {
  beginNotice.mockClear();
  finishNotice.mockClear();
  submitQuestion.mockReset();
  submitQuestion.mockResolvedValue({ results: [] });
  HTMLDialogElement.prototype.showModal = function () {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function () {
    this.open = false;
  };
});
describe('question workspace', () => {
  it('fills the example without submitting and warns before losing it', async () => {
    const user = userEvent.setup();
    render(<QuestionForm />);
    await user.click(screen.getByRole('button', { name: /Try an example/ }));
    const input = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(input.value).toBe(
      'What is the best CRM for a 10-person B2B startup?',
    );
    expect(document.activeElement).toBe(input);
    expect(submitQuestion).not.toHaveBeenCalled();
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
  it('shows configured modes and leaves unavailable modes unknown', () => {
    render(
      <QuestionForm
        providerStatuses={[
          {
            provider: 'openai',
            mode: 'live',
            keySource: 'env',
            liveSupported: true,
          },
          {
            provider: 'perplexity',
            mode: 'mock',
            keySource: 'none',
            liveSupported: true,
          },
        ]}
      />,
    );
    expect(screen.getByText('Live')).not.toBeNull();
    expect(
      screen.getByText('Key configured · paid calls currently blocked'),
    ).not.toBeNull();
    expect(screen.getByText('Mock')).not.toBeNull();
    expect(screen.getAllByText('Mode unknown')).toHaveLength(3);
  });
  it('keeps selection styling and submission availability in sync', async () => {
    const user = userEvent.setup();
    render(<QuestionForm />);
    const checkboxes = within(
      screen.getByRole('group', { name: 'Providers to ask' }),
    ).getAllByRole('checkbox');
    for (const input of checkboxes) {
      await user.click(input);
      expect(input.closest('label')?.getAttribute('data-selected')).toBe(
        'false',
      );
    }
    expect(
      (
        screen.getByRole('button', {
          name: 'Ask question',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      screen.getByText('Select at least one provider to continue.'),
    ).not.toBeNull();
    const firstProvider = checkboxes[0];
    if (!firstProvider) throw new Error('Provider selection is missing');
    await user.click(firstProvider);
    expect(firstProvider.closest('label')?.getAttribute('data-selected')).toBe(
      'true',
    );
    expect(
      (
        screen.getByRole('button', {
          name: 'Ask question',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });
  it('requires paid confirmation for a rerun after using the example', async () => {
    HTMLDialogElement.prototype.showModal = function () {
      this.open = true;
    };
    const user = userEvent.setup();
    render(<QuestionForm />);
    await user.click(screen.getByRole('button', { name: /Try an example/ }));
    await user.click(screen.getByText('Run options · duplicates and reruns'));
    await user.click(screen.getByLabelText('Force a new run today'));
    fireEvent.submit(
      screen.getByRole('button', { name: 'Ask question' }).closest('form')!,
    );
    expect(screen.getByRole('dialog').textContent).toContain(
      'counts against the spend cap',
    );
    expect(submitQuestion).not.toHaveBeenCalled();
  });
  it.each([
    'Submission could not be confirmed.',
    'Some submissions were accepted. Check Executions before trying again.',
  ])(
    'preserves question and forced rerun after an action error: %s',
    async (error) => {
      submitQuestion.mockResolvedValueOnce({ error });
      const user = userEvent.setup();
      render(<QuestionForm />);
      await user.type(screen.getByRole('textbox'), 'Best CRM for our startup?');
      await user.click(screen.getByText('Run options · duplicates and reruns'));
      await user.click(screen.getByLabelText('Force a new run today'));
      await user.click(screen.getByRole('button', { name: 'Ask question' }));
      await user.click(
        screen.getByRole('button', { name: 'Confirm paid rerun' }),
      );
      expect(await screen.findByRole('alert')).toHaveProperty(
        'textContent',
        error,
      );
      expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(
        'Best CRM for our startup?',
      );
      expect(
        (screen.getByLabelText('Force a new run today') as HTMLInputElement)
          .checked,
      ).toBe(true);
      expect(submitQuestion).toHaveBeenCalledTimes(1);
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    },
  );
  it('clears the question and forced rerun after a successful submission', async () => {
    const user = userEvent.setup();
    render(<QuestionForm />);
    await user.type(screen.getByRole('textbox'), 'Best CRM?');
    await user.click(screen.getByText('Run options · duplicates and reruns'));
    await user.click(screen.getByLabelText('Force a new run today'));
    await user.click(screen.getByRole('button', { name: 'Ask question' }));
    await user.click(
      screen.getByRole('button', { name: 'Confirm paid rerun' }),
    );
    await waitFor(() => expect(submitQuestion).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(
        '',
      ),
    );
    expect(
      (screen.getByLabelText('Force a new run today') as HTMLInputElement)
        .checked,
    ).toBe(false);
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
  it('requires confirmation again when the question changes after a confirmed rerun', async () => {
    submitQuestion.mockResolvedValueOnce({
      error: 'Check Executions before trying again.',
    });
    const user = userEvent.setup();
    render(<QuestionForm />);
    await user.type(screen.getByRole('textbox'), 'Best CRM?');
    await user.click(screen.getByText('Run options · duplicates and reruns'));
    await user.click(screen.getByLabelText('Force a new run today'));
    await user.click(screen.getByRole('button', { name: 'Ask question' }));
    await user.click(
      screen.getByRole('button', { name: 'Confirm paid rerun' }),
    );
    await screen.findByRole('alert');
    await user.type(screen.getByRole('textbox'), ' For a small team.');
    await user.click(screen.getByRole('button', { name: 'Ask question' }));
    expect(screen.getByRole('dialog').textContent).toContain(
      'counts against the spend cap',
    );
    expect(submitQuestion).toHaveBeenCalledTimes(1);
  });
  it('invalidates confirmation when input changes before deferred submission', async () => {
    const user = userEvent.setup();
    render(<QuestionForm />);
    await user.type(screen.getByRole('textbox'), 'Best CRM?');
    await user.click(screen.getByText('Run options · duplicates and reruns'));
    await user.click(screen.getByLabelText('Force a new run today'));
    const submit = screen.getByRole('button', { name: 'Ask question' });
    const form = submit.closest('form');
    if (!form) throw new Error('Question form is missing');
    const requestSubmit = form.requestSubmit.bind(form);
    const deferredSubmit = vi
      .spyOn(form, 'requestSubmit')
      .mockImplementation(() => {});
    await user.click(submit);
    await user.click(
      screen.getByRole('button', { name: 'Confirm paid rerun' }),
    );
    await waitFor(() => expect(deferredSubmit).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(submitQuestion).not.toHaveBeenCalled();
    await user.type(screen.getByRole('textbox'), ' For a small team.');
    deferredSubmit.mockRestore();
    act(() => requestSubmit());
    expect(screen.getByRole('dialog').textContent).toContain(
      'counts against the spend cap',
    );
    expect(submitQuestion).not.toHaveBeenCalled();
  });
  it('submits the default five providers from the compact composer without expanding choices', async () => {
    const user = userEvent.setup();
    const providers = [
      'openai',
      'perplexity',
      'gemini',
      'anthropic',
      'google_ai',
    ] as const;
    render(
      <QuestionForm
        compact
        providerStatuses={providers.map((provider) => ({
          provider,
          mode: 'mock',
          keySource: 'none',
          liveSupported: provider !== 'google_ai',
        }))}
      />,
    );
    const choices = screen.getByText('Choose providers').closest('details');
    expect(choices?.open).toBe(false);
    expect(
      screen.getByText('All 5 selected providers use Mock'),
    ).not.toBeNull();
    expect(
      screen.getByText(
        'Mock answers are samples for testing. Paid provider calls are currently blocked.',
      ),
    ).not.toBeNull();
    await user.type(screen.getByRole('textbox'), 'Best CRM?');
    await user.click(screen.getByRole('button', { name: 'Ask question' }));
    await waitFor(() => expect(submitQuestion).toHaveBeenCalledTimes(1));
    const data = submitQuestion.mock.calls[0]?.[1];
    expect(data?.get('questionText')).toBe('Best CRM?');
    expect(data?.getAll('providers')).toEqual(providers);
    expect(data?.get('forceConfirmed')).toBe('no');
  });
  it.each(['queued', 'succeeded'] as const)(
    'focuses real %s results with an honest next step',
    async (status) => {
      const item = ApiExecutionViewSchema.parse({
        id: 'synthetic-result',
        executionKey: 'a'.repeat(64),
        questionText: 'Best CRM?',
        provider: 'openai',
        integration: 'mock',
        model: 'synthetic-model',
        status,
        extractionStatus: 'pending',
        citationsAvailable: 'unknown',
        attemptCount: 0,
        createdAt: '2026-11-02T00:00:00.000Z',
      });
      submitQuestion.mockResolvedValueOnce({
        results: [{ item, created: true }],
      });
      const user = userEvent.setup();
      render(<QuestionForm compact />);
      await user.type(screen.getByRole('textbox'), 'Best CRM?');
      await user.click(screen.getByRole('button', { name: 'Ask question' }));
      const heading = await screen.findByRole('heading', {
        name: 'Your provider results',
      });
      await waitFor(() =>
        expect(document.activeElement).toBe(heading.closest('section')),
      );
      const link = screen.getByRole('link', {
        name:
          status === 'succeeded'
            ? 'View answer for ChatGPT / OpenAI'
            : 'View progress for ChatGPT / OpenAI',
      });
      expect(link.getAttribute('href')).toBe('/executions/synthetic-result');
      expect(
        screen.getByText(status === 'succeeded' ? 'Succeeded' : 'Queued'),
      ).not.toBeNull();
    },
  );
  it('keeps entered text and accepted result links after a partial submission', async () => {
    const item = ApiExecutionViewSchema.parse({
      id: 'synthetic-partial',
      executionKey: 'b'.repeat(64),
      questionText: 'Best CRM?',
      provider: 'openai',
      integration: 'mock',
      model: 'synthetic-model',
      status: 'queued',
      extractionStatus: 'pending',
      citationsAvailable: 'unknown',
      attemptCount: 0,
      createdAt: '2026-11-02T00:00:00.000Z',
    });
    const error =
      'Some submissions were accepted. Check Executions before trying again.';
    submitQuestion.mockResolvedValueOnce({
      error,
      results: [{ item, created: true }],
    });
    const user = userEvent.setup();
    render(<QuestionForm compact />);
    await user.type(screen.getByRole('textbox'), 'Best CRM?');
    await user.click(screen.getByRole('button', { name: 'Ask question' }));
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      error,
    );
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(
      'Best CRM?',
    );
    expect(
      screen
        .getByRole('link', { name: 'View progress for ChatGPT / OpenAI' })
        .getAttribute('href'),
    ).toBe('/executions/synthetic-partial');
  });
  it.each(['', '   '])(
    'validates an empty or whitespace-only question inline before any submission',
    async (value) => {
      const user = userEvent.setup();
      render(<QuestionForm compact />);
      const input = screen.getByRole('textbox');
      if (value) await user.type(input, value);
      await user.click(screen.getByRole('button', { name: 'Ask question' }));
      expect(screen.getByRole('alert').textContent).toBe(
        'Enter a buyer question to continue.',
      );
      expect(input.getAttribute('aria-invalid')).toBe('true');
      expect(document.activeElement).toBe(input);
      expect(submitQuestion).not.toHaveBeenCalled();
      expect(beginNotice).not.toHaveBeenCalled();
    },
  );
  it('validates missing selections and focuses the first provider before submission', async () => {
    const user = userEvent.setup();
    render(<QuestionForm compact />);
    await user.type(screen.getByRole('textbox'), 'Best CRM?');
    await user.click(screen.getByText('Choose providers'));
    const options = within(
      screen.getByRole('group', { name: 'Providers to ask' }),
    ).getAllByRole('checkbox');
    for (const option of options) await user.click(option);
    fireEvent.submit(
      screen.getByRole('button', { name: 'Ask question' }).closest('form')!,
    );
    expect(screen.getByRole('alert').textContent).toBe(
      'Select at least one provider to continue.',
    );
    expect(document.activeElement).toBe(options[0]);
    expect(submitQuestion).not.toHaveBeenCalled();
    expect(beginNotice).not.toHaveBeenCalled();
  });
  it('updates the loading notice on successful submission', async () => {
    const user = userEvent.setup();
    render(<QuestionForm compact />);
    await user.type(screen.getByRole('textbox'), 'Best CRM?');
    await user.click(screen.getByRole('button', { name: 'Ask question' }));
    await waitFor(() =>
      expect(finishNotice).toHaveBeenCalledWith(null, {
        title: 'Question submitted',
        description: 'Open a provider answer to follow its progress.',
        error: false,
      }),
    );
    expect(beginNotice).toHaveBeenCalledWith('Asking providers…');
    expect(submitQuestion).toHaveBeenCalledTimes(1);
  });
  it('preserves input and reports an uncertain action failure without exposing exception details', async () => {
    submitQuestion.mockRejectedValueOnce(
      new Error('synthetic-private-transport-details'),
    );
    const user = userEvent.setup();
    render(<QuestionForm compact />);
    await user.type(screen.getByRole('textbox'), 'Best CRM?');
    await user.click(screen.getByRole('button', { name: 'Ask question' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Submission could not be confirmed.');
    expect(alert.textContent).toContain(
      'a forced retry can create another paid execution',
    );
    expect(alert.textContent).not.toContain(
      'synthetic-private-transport-details',
    );
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(
      'Best CRM?',
    );
    expect(finishNotice).toHaveBeenCalledWith(null, {
      title: 'Question needs attention',
      description: alert.textContent,
      error: true,
    });
    expect(submitQuestion).toHaveBeenCalledTimes(1);
  });
});
