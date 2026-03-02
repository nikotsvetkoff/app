const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const maxAttempts = Math.max(1, Number(process.env.PRISMA_GENERATE_RETRIES || 6));
const retryDelayMs = Math.max(500, Number(process.env.PRISMA_GENERATE_RETRY_DELAY_MS || 2000));
const backendRoot = path.resolve(__dirname, '..');
const prismaBin = path.join(
  backendRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'prisma.cmd' : 'prisma'
);
const prismaClientPackagePath = require.resolve('@prisma/client/package.json', { paths: [backendRoot] });
const prismaClientRuntimeDir = path.resolve(
  path.dirname(prismaClientPackagePath),
  '..',
  '..',
  '.prisma',
  'client'
);
const prismaClientDts = path.resolve(prismaClientRuntimeDir, 'index.d.ts');

const sleep = (ms) => {
  const shared = new SharedArrayBuffer(4);
  const view = new Int32Array(shared);
  Atomics.wait(view, 0, 0, ms);
};

const runPrismaGenerate = (extraArgs = []) => {
  const quotedExtraArgs = extraArgs.join(' ');
  const command = `"${prismaBin}" generate${quotedExtraArgs ? ` ${quotedExtraArgs}` : ''}`;

  const result = spawnSync(command, {
    cwd: backendRoot,
    env: process.env,
    shell: true,
    encoding: 'utf8'
  });

  if (result.error) {
    process.stderr.write(`${result.error.message}\n`);
  }
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }

  const combinedOutput = `${result.stdout || ''}\n${result.stderr || ''}`.toLowerCase();
  return {
    status: result.status ?? 1,
    combinedOutput
  };
};

const looksLikeWindowsEngineLock = (output) =>
  output.includes('eperm') &&
  (output.includes('query_engine-windows.dll.node') ||
    output.includes('query_engine-windows') ||
    output.includes('permission denied'));

const hasPrismaQueryEngineBinary = () => {
  if (!fs.existsSync(prismaClientRuntimeDir)) {
    return false;
  }

  try {
    return fs.readdirSync(prismaClientRuntimeDir).some((entry) => /^(query_engine|libquery_engine)/i.test(entry));
  } catch {
    return false;
  }
};

let lastOutput = '';
for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
  console.log(`[build] prisma generate attempt ${attempt}/${maxAttempts}`);
  const result = runPrismaGenerate();
  lastOutput = result.combinedOutput;
  if (result.status === 0) {
    process.exit(0);
  }

  const lockError = looksLikeWindowsEngineLock(result.combinedOutput);
  const hasGeneratedClient = fs.existsSync(prismaClientDts);

  if (!lockError) {
    process.exit(result.status);
  }

  if (attempt === maxAttempts) {
    if (hasGeneratedClient) {
      if (hasPrismaQueryEngineBinary()) {
        console.warn('[build] prisma generate failed due to Windows file lock, using existing generated client');
        process.exit(0);
      }

      console.error('[build] prisma client exists but query engine binary is missing');
      console.error('[build] stop running backend processes and run: corepack pnpm --filter @iptv/backend exec prisma generate');
      process.exit(1);
    }
    break;
  }

  console.warn(`[build] prisma generate hit Windows file lock, retrying in ${retryDelayMs}ms`);
  sleep(retryDelayMs);
}

console.error('[build] prisma generate failed after retries');
if (lastOutput) {
  console.error(lastOutput);
}
process.exit(1);
