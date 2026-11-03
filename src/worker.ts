import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { ConfigError } from './config/index.js';
import { createRuntime, bindHost, handleShutdown } from './server.js';
import {
  createProviderWorkers,
  processExecution,
} from './workers/provider-worker.js';
import { recoverExecutions } from './workers/recovery.js';
import { modelForProvider } from './providers/index.js';
import { ProviderIdSchema, utcRunDate } from './contracts/index.js';
import { runLiveCheck } from './providers/live-check.js';
import { workerReady } from './workers/worker-health.js';
import { createExtractionWorker } from './workers/extraction-worker.js';
import { recoverExtractions } from './workers/extraction-recovery.js';
import { runRecoveryPass } from './workers/recovery-pass.js';

async function main(): Promise<void> {
  const runtime = await createRuntime();
  const dependencies = {
    repository: runtime.repository,
    resolver: runtime.resolver,
    adapters: runtime.adapters,
    config: runtime.config,
    logger: runtime.logger,
    budgetGate: runtime.budgetGate,
    pause: runtime.queue.pause,
  };
  if (process.argv.includes('--live-check')) {
    try {
      const provider = ProviderIdSchema.parse(
        process.env.LIVE_PROVIDER ?? 'openai',
      );
      await runLiveCheck({
        provider,
        resolver: runtime.resolver,
        repository: runtime.repository,
        runOnce: async () => {
          const { execution } = await runtime.repository.createQueuedIfAbsent({
            questionId: 'live-check-' + randomUUID(),
            questionText: 'What is the best CRM for a 10-person B2B startup?',
            questionVersion: 1,
            provider,
            model: modelForProvider(runtime.config, provider),
            modelSettingsVersion: 'live-check-v1',
            runDate: utcRunDate(new Date()),
            runSeq: 0,
            settings: { webSearch: true },
          });
          await processExecution(
            { executionId: execution.id, executionKey: execution.executionKey },
            { ...dependencies, schedule: async () => {} },
          );
          return execution.id;
        },
      });
    } finally {
      await runtime.close();
    }
    return;
  }
  const workers = createProviderWorkers(runtime.transport, dependencies);
  const extractionWorker = createExtractionWorker(runtime.transport, {
    repository: runtime.repository,
    extractions: runtime.extractions,
    logger: runtime.logger,
  });
  const readiness = {
    draining: false,
    recovered: false,
    isRunning: () => workers.isRunning() && extractionWorker.isRunning(),
  };
  let recovering = false;
  const recover = async () => {
    if (recovering || readiness.draining) return;
    recovering = true;
    try {
      readiness.recovered = await runRecoveryPass(
        {
          provider: () =>
            recoverExecutions(runtime.repository, runtime.queue.enqueuer),
          extraction: () =>
            recoverExtractions(runtime.extractions, runtime.extractionService),
        },
        runtime.logger,
      );
    } catch {
      readiness.recovered = false;
      runtime.logger.error(
        { stage: 'recovery.failed' },
        'Recovery needs attention',
      );
    } finally {
      recovering = false;
    }
  };
  await recover();
  const timer = setInterval(() => {
    void recover();
  }, 5000);
  const health = createServer((req, res) => {
    if (req.url !== '/health') {
      res.writeHead(404).end();
      return;
    }
    res.setHeader('content-type', 'application/json');
    void workerReady(readiness, runtime.checks).then((ready) => {
      res.statusCode = ready ? 200 : 503;
      res.end(JSON.stringify({ status: ready ? 'ready' : 'not_ready' }));
    });
  });
  health.listen(3002, bindHost(runtime.config.HOST));
  health.on('error', () =>
    runtime.logger.error(
      { stage: 'worker.health_error' },
      'Worker health endpoint failed',
    ),
  );
  handleShutdown(async () => {
    readiness.draining = true;
    clearInterval(timer);
    await Promise.all([workers.close(), extractionWorker.close()]);
    await new Promise<void>((resolve) => health.close(() => resolve()));
    await runtime.close();
  }, runtime.logger);
  runtime.logger.info(
    { stage: 'workers.started' },
    'Provider workers and recovery loop started',
  );
}
// Refuse before constructing clients, connecting to services or making a paid request.
if (process.argv.includes('--live-check') && process.env.ALLOW_LIVE !== '1') {
  process.stderr.write('Live verification requires ALLOW_LIVE=1.\n');
  process.exitCode = 1;
} else
  main().catch((error: unknown) => {
    process.stderr.write(
      error instanceof ConfigError
        ? error.message + '\n'
        : 'Worker startup failed; check configuration and dependencies.\n',
    );
    process.exitCode = 1;
  });
