'use client';
import Link from 'next/link';
import { useActionState, useEffect, useRef, useState } from 'react';
import type { ApiProviderStatus, ProviderId } from '@contracts';
import { formatCount, providerNames } from '@/lib/format/values';
import { ExecutionStatusChip } from '@/components/execution-status-chip';
import { IntegrationChip } from '@/components/integration-chip';
import { useActionNotice } from '@/lib/forms/use-action-notice';
import { useUnsavedChanges } from '@/lib/forms/use-unsaved-changes';
import { submitQuestion, type SubmitState } from './actions';
const providers: ProviderId[] = [
  'openai',
  'perplexity',
  'gemini',
  'anthropic',
  'google_ai',
];
const exampleQuestion = 'What is the best CRM for a 10-person B2B startup?';
export function QuestionForm({
  providerStatuses = [],
  compact = false,
}: {
  providerStatuses?: ApiProviderStatus[];
  compact?: boolean;
}) {
  const notice = useActionNotice();
  const [questionText, setQuestionText] = useState('');
  const [questionError, setQuestionError] = useState<string>();
  const [providerError, setProviderError] = useState(false);
  const [forceRun, setForceRun] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [selected, setSelected] = useState<ProviderId[]>(providers);
  const dialog = useRef<HTMLDialogElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const question = useRef<HTMLTextAreaElement>(null);
  const submitButton = useRef<HTMLButtonElement>(null);
  const resultsRef = useRef<HTMLElement>(null);
  const providerChoices = useRef<HTMLDetailsElement>(null);
  const firstProvider = useRef<HTMLInputElement>(null);
  const [state, action, pending] = useActionState(
    async (previous: SubmitState, data: FormData) => {
      const handle = notice.begin('Asking providers…');
      let result: SubmitState;
      try {
        result = await submitQuestion(previous, data);
      } catch {
        result = {
          error:
            'Submission could not be confirmed. Check your answers before trying again; a forced retry can create another paid execution.',
        };
      }
      notice.finish(handle, {
        title: result.error ? 'Question needs attention' : 'Question submitted',
        description:
          result.error ?? 'Open a provider answer to follow its progress.',
        error: Boolean(result.error),
      });
      setConfirmed(false);
      if (!result.error) {
        setDirty(false);
        setQuestionText('');
        setForceRun(false);
      }
      return result;
    },
    {},
  );
  useUnsavedChanges(dirty && !pending);
  useEffect(() => {
    if (state.results?.length) {
      resultsRef.current?.focus();
      resultsRef.current?.scrollIntoView?.({ block: 'nearest' });
    }
  }, [state.results]);
  const mockCount = selected.filter((provider) =>
    providerStatuses.some(
      (item) => item.provider === provider && item.mode === 'mock',
    ),
  ).length;
  const liveCount = selected.filter((provider) =>
    providerStatuses.some(
      (item) => item.provider === provider && item.mode === 'live',
    ),
  ).length;
  const unknownCount = selected.length - mockCount - liveCount;
  return (
    <>
      <form
        ref={formRef}
        action={action}
        noValidate
        // React resets forms after action returns, including errors. State owns
        // the reset so failed or partial submissions retain the operator input.
        onReset={(event) => event.preventDefault()}
        className={`form-stack question-form question-composer${compact ? ' question-composer-compact' : ''}`}
        onChange={() => {
          setDirty(true);
          setConfirmed(false);
        }}
        onSubmit={(event) => {
          if (!questionText.trim() || questionText.length > 2000) {
            event.preventDefault();
            setQuestionError(
              !questionText.trim()
                ? 'Enter a buyer question to continue.'
                : 'Keep your question under 2,001 characters.',
            );
            question.current?.focus();
            return;
          }
          if (!selected.length) {
            event.preventDefault();
            setProviderError(true);
            if (providerChoices.current) providerChoices.current.open = true;
            firstProvider.current?.focus();
            return;
          }
          if (forceRun && !confirmed) {
            event.preventDefault();
            dialog.current?.showModal();
          }
        }}
      >
        <section className="form-section" aria-labelledby="question-label">
          <label id="question-label" htmlFor="buyer-question">
            Your question <small>Up to 2,000 characters</small>
          </label>
          <textarea
            ref={question}
            id="buyer-question"
            name="questionText"
            value={questionText}
            onChange={(event) => {
              setQuestionText(event.target.value);
              setQuestionError(undefined);
            }}
            required
            maxLength={2000}
            disabled={pending}
            aria-describedby={
              questionError ? 'question-help question-error' : 'question-help'
            }
            aria-invalid={Boolean(questionError)}
            placeholder="What is the best CRM for a 10-person B2B startup?"
          />
          {questionError && (
            <p id="question-error" className="error" role="alert">
              {questionError}
            </p>
          )}
          <p id="question-help" className="muted">
            Ask about a product or service your customers might be looking for.
          </p>
          <button
            type="button"
            className="example-prompt"
            disabled={pending}
            onClick={() => {
              setQuestionText(exampleQuestion);
              setQuestionError(undefined);
              question.current?.focus();
              setDirty(true);
              setConfirmed(false);
            }}
          >
            <span>Try an example</span>
            <span>{exampleQuestion}</span>
          </button>
        </section>
        <div className="composer-mode-summary" aria-live="polite">
          <p>
            {selected.length === 0
              ? 'No providers selected'
              : mockCount === selected.length
                ? `All ${formatCount(selected.length)} selected providers use Mock`
                : `${formatCount(mockCount)} Mock · ${formatCount(liveCount)} Live${unknownCount ? ` · ${formatCount(unknownCount)} unknown` : ''}`}
          </p>
          <p className="muted">
            Mock answers are samples for testing. Paid provider calls are
            currently blocked.
          </p>
        </div>
        {state.error && (
          <p role="alert" className="error">
            {state.error}
          </p>
        )}
        <div className="form-actions">
          <p className="muted" aria-live="polite">
            {selected.length
              ? `${formatCount(selected.length)} providers selected`
              : 'Select at least one provider to continue.'}
          </p>
          <button
            ref={submitButton}
            className="primary"
            disabled={pending || selected.length === 0}
          >
            {pending ? 'Submitting…' : 'Ask question'}
          </button>
        </div>
        <details className="provider-choices" open={compact ? undefined : true}>
          <summary>
            Choose providers{' '}
            <span className="muted">
              · {formatCount(selected.length)} selected
            </span>
          </summary>
          <fieldset
            className="form-section"
            disabled={pending}
            aria-describedby={
              providerError ? 'provider-help provider-error' : 'provider-help'
            }
          >
            <legend>Providers to ask</legend>
            <p id="provider-help" className="muted">
              Get a separate answer from each selected provider. Mock answers do
              not contact the provider or incur provider spend.
            </p>
            {providerError && (
              <p id="provider-error" className="error" role="alert">
                Select at least one provider to continue.
              </p>
            )}
            <div className="provider-options">
              {providers.map((provider) => {
                const status = providerStatuses.find(
                  (item) => item.provider === provider,
                );
                return (
                  <label
                    key={provider}
                    className="provider-option"
                    data-selected={selected.includes(provider)}
                  >
                    <input
                      ref={provider === 'openai' ? firstProvider : undefined}
                      type="checkbox"
                      name="providers"
                      value={provider}
                      checked={selected.includes(provider)}
                      onChange={(event) => {
                        setProviderError(false);
                        setSelected((current) =>
                          event.target.checked
                            ? [...current, provider]
                            : current.filter((item) => item !== provider),
                        );
                      }}
                    />
                    <span className="provider-option-copy">
                      <span>{providerNames[provider]}</span>
                      <small>
                        {provider === 'google_ai'
                          ? 'Mock only · separate from Gemini'
                          : status?.mode === 'live'
                            ? 'Key configured · paid calls currently blocked'
                            : status?.mode === 'mock'
                              ? 'Mock · no provider key configured'
                              : 'Access status unavailable'}
                      </small>
                    </span>
                    {status ? (
                      <IntegrationChip value={status.mode} />
                    ) : (
                      <span className="muted">Mode unknown</span>
                    )}
                  </label>
                );
              })}
            </div>
            <p className="muted">
              Modes are checked again when the execution starts.{' '}
              <Link href="/providers">Review provider access</Link>
            </p>
          </fieldset>
        </details>
        <details className="advanced-options">
          <summary>Run options · duplicates and reruns</summary>
          <p className="muted">
            Run date is today in UTC. Submitting the same question and provider
            again returns its existing execution for today.
          </p>
          <label className="inline">
            <input
              type="checkbox"
              name="force"
              checked={forceRun}
              disabled={pending}
              onChange={(event) => setForceRun(event.target.checked)}
            />
            Force a new run today
          </label>
          <p className="muted">
            A forced rerun creates a new execution and requires confirmation
            before any paid call.
          </p>
        </details>
        <input
          type="hidden"
          name="forceConfirmed"
          value={confirmed ? 'yes' : 'no'}
        />
        {!!state.results?.length && (
          <section
            ref={resultsRef}
            tabIndex={-1}
            className="submission-results"
            aria-live="polite"
            aria-labelledby="submission-results-title"
          >
            <h2 id="submission-results-title">Your provider results</h2>
            <p className="muted">
              Open a provider to follow progress or read its saved answer.
            </p>
            <ul>
              {state.results.map(({ item, created }) => (
                <li key={item.id} className="submission-result">
                  <div>
                    <strong>{providerNames[item.provider]}</strong>
                    <span className="subline">
                      {created ? 'New run' : 'Already run today'}
                    </span>
                  </div>
                  <div className="chips">
                    <ExecutionStatusChip value={item.status} />
                    <IntegrationChip value={item.integration} />
                  </div>
                  <Link
                    href={`/executions/${item.id}`}
                    aria-label={`${item.status === 'succeeded' ? 'View answer' : 'View progress'} for ${providerNames[item.provider]}`}
                  >
                    {item.status === 'succeeded'
                      ? 'View answer'
                      : 'View progress'}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
      </form>
      <dialog
        ref={dialog}
        aria-labelledby="force-title"
        onClose={() => submitButton.current?.focus()}
      >
        <h2 id="force-title">Create a new execution?</h2>
        <p>
          This reruns the entered question for your selected providers. Live
          providers make a new paid call that counts against the spend cap. A
          completed paid call cannot be undone.
        </p>
        <div className="inline">
          <button onClick={() => dialog.current?.close()}>Cancel</button>
          <button
            className="primary"
            onClick={() => {
              setConfirmed(true);
              dialog.current?.close();
              window.setTimeout(() => formRef.current?.requestSubmit(), 0);
            }}
          >
            Confirm paid rerun
          </button>
        </div>
      </dialog>
    </>
  );
}
