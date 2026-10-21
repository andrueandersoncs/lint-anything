import { startDevServer } from '@aws-blocks/blocks/scripts';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const role = process.env.BLOCKS_ROLE ?? 'guest';
const stage = process.env.STAGE ?? 'dev';
const isCi = process.env.CI === 'true';
if (
  !isCi &&
  !(role === 'admin' ||
    (role === 'developer' && stage !== 'prod') ||
    (role === 'tester' && stage === 'dev' && Number(process.env.PORT) >= 3000))
) {
  console.error(`Role "${role}" is not allowed to start the server on stage "${stage}".`);
  process.exit(1);
}

startDevServer({
  backendPath: join(__dirname, '..', 'index.ts'),
  // The launcher (run-e2e.sh / CI) picks a free port and passes it via PORT so
  // the server and the e2e client agree on it without a hardcoded literal.
  // 3001 stays the fallback for a plain `npx tsx server.ts`.
  port: Number(process.env.PORT) || 3001
});
