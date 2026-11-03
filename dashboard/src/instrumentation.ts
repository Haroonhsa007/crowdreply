export async function register() {
  // Build workers have no runtime credentials; actual server startup must validate them.
  if (
    process.env.NEXT_RUNTIME === 'nodejs' &&
    process.env.NEXT_PHASE !== 'phase-production-build'
  ) {
    const { env } = await import('./lib/env');
    env();
  }
}
