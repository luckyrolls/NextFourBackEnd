/**
 * Smoke test — the whole test surface for this slice.
 *
 * 1. Starts the compiled server on a scratch port with placeholder env.
 * 2. Asserts GET /health returns 200 and a body matching the documented shape.
 * 3. Asserts the server refuses to start when required env vars are absent.
 *
 * Pure Node, no shell operators, no test framework. Run: npm run smoke
 */
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = resolve(ROOT, 'dist', 'index.js');
const PORT = 3999;

// /health never touches Supabase, so placeholders are enough to satisfy the env contract.
const PLACEHOLDER_ENV = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SECRET_KEY: 'sb_secret_placeholder_for_smoke_test',
};

function startServer(extraEnv) {
  // `dotenv/config` would load a developer's real .env; DOTENV_CONFIG_PATH points it at
  // a file that does not exist so the smoke test always runs against known values.
  const child = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env: {
      ...process.env,
      ...PLACEHOLDER_ENV,
      ...extraEnv,
      DOTENV_CONFIG_PATH: resolve(ROOT, '.env.smoke-nonexistent'),
      PORT: String(PORT),
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));

  return { child, getOutput: () => output };
}

async function waitForHealth(url, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {
      // Server not listening yet.
    }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${url}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

function assert(condition, message) {
  if (!condition) {
    console.error(`  FAIL  ${message}`);
    process.exitCode = 1;
    return false;
  }
  console.log(`  pass  ${message}`);
  return true;
}

async function testHealthEndpoint() {
  console.log('\n[smoke] GET /health');
  const { child } = startServer({});
  try {
    const response = await waitForHealth(`http://127.0.0.1:${PORT}/health`);
    assert(response.status === 200, 'responds 200');
    assert(
      (response.headers.get('content-type') ?? '').includes('application/json'),
      'content-type is JSON',
    );

    const body = await response.json();
    assert(body.status === 'ok', `status is "ok" (got ${JSON.stringify(body.status)})`);
    assert(
      typeof body.timestamp === 'string' && !Number.isNaN(Date.parse(body.timestamp)),
      'timestamp is an ISO-8601 string',
    );
    assert(
      typeof body.version === 'string' && body.version.length > 0,
      `version is present (got ${JSON.stringify(body.version)})`,
    );
  } finally {
    child.kill();
  }
}

async function testFailsFastWithoutEnv() {
  console.log('\n[smoke] startup with missing env vars');
  const { child, getOutput } = startServer({ SUPABASE_URL: '', SUPABASE_SECRET_KEY: '' });

  const code = await new Promise((resolveExit) => child.on('exit', resolveExit));
  const output = getOutput();

  assert(code !== 0, `exits non-zero (got ${code})`);
  assert(
    output.includes('Invalid environment configuration'),
    'explains that the environment is invalid',
  );
  assert(output.includes('SUPABASE_URL'), 'names SUPABASE_URL');
  assert(output.includes('SUPABASE_SECRET_KEY'), 'names SUPABASE_SECRET_KEY');
}

await testHealthEndpoint();
await testFailsFastWithoutEnv();

console.log(process.exitCode ? '\n[smoke] FAILED\n' : '\n[smoke] All checks passed.\n');
