import { closePool, dbEnabled, healthCheck } from '../src/db/client.js';

async function main() {
  if (!dbEnabled) {
    console.log('DATABASE_URL not set — running in local-only mode, nothing to test.');
    return;
  }
  const result = await healthCheck();
  if (!result.ok) throw new Error(result.error);
  console.log('Connected OK.');
  await closePool();
}

main().catch((err) => {
  console.error('Connection failed:', err.message);
  process.exit(1);
});
