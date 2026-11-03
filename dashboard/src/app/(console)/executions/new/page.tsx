import { providers } from '@/lib/api/providers';
import { loadResource } from '@/lib/api/load-resource';
import { QuestionForm } from './question-form';
export default async function SubmitPage() {
  const resource = await loadResource(providers);
  return (
    <>
      <header className="page-heading">
        <div>
          <h1>Ask a buyer question</h1>
          <p className="muted">
            See what AI providers recommend, then explore their answers and
            sources.
          </p>
        </div>
      </header>
      {!resource.ok && (
        <p className="notice warning" role="status">
          Provider access could not be loaded. Modes will be resolved when you
          submit.
        </p>
      )}
      <QuestionForm
        compact
        providerStatuses={resource.ok ? resource.data : undefined}
      />
    </>
  );
}
