#!/usr/bin/env node
// Launches the built server in an isolated development profile.
//
// - Port is fixed to 3101; the production instance on 3001 is never used.
// - os.homedir() is redirected into the test root, so every provider/session
//   store (~/.claude, ~/.codex, ~/.cursor, ...) and ~/.cloudcli (auth.db,
//   local-server.json) resolves inside it instead of the real user profile.
//
// Usage: node scripts/dev-safe.mjs [--test-root <dir>]   (run `npm run build` first)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEV_PORT = 3101;
const PROTECTED_PORT = 3001;
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fail(message) {
  console.error(`dev-safe: ${message}`);
  process.exit(1);
}

const rootFlag = process.argv.indexOf('--test-root');
const requestedRoot = rootFlag > -1
  ? process.argv[rootFlag + 1]
  : process.env.CCUI_TEST_WORK_ROOT || path.join(path.dirname(APP_ROOT), 'claudecodeui-custom-test');
if (!requestedRoot) fail('--test-root needs a value.');

const testRoot = path.resolve(requestedRoot);
fs.mkdirSync(testRoot, { recursive: true });

// A link, junction, or symlinked parent would send "test" data somewhere else.
if (fs.realpathSync.native(testRoot).toLowerCase() !== testRoot.toLowerCase()) {
  fail(`test root resolves elsewhere (${fs.realpathSync.native(testRoot)}); refusing.`);
}
const relativeToApp = path.relative(APP_ROOT, testRoot);
if (!relativeToApp.startsWith('..') && !path.isAbsolute(relativeToApp)) {
  fail('test root must live outside the source checkout.');
}

const home = path.join(testRoot, 'home');
const workspaces = path.join(testRoot, 'workspaces');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(workspaces, { recursive: true });

const entry = path.join(APP_ROOT, 'dist-server', 'server', 'index.js');
if (!fs.existsSync(entry)) fail('dist-server is missing; run `npm run build` first.');

const portInUse = await new Promise((resolve) => {
  const probe = net.connect({ port: DEV_PORT, host: '127.0.0.1' });
  probe.once('connect', () => { probe.destroy(); resolve(true); });
  probe.once('error', () => resolve(false));
});
if (portInUse) fail(`DEV_PORT_3101_CONFLICT: port ${DEV_PORT} is already in use; not choosing another port.`);

// Do not forward credentials of the real user into the dev instance.
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/^(ANTHROPIC_|CLAUDE_CODE_OAUTH_TOKEN|OPENAI_|API_KEY$|JWT_SECRET$)/.test(key)) delete env[key];
}
Object.assign(env, {
  SERVER_PORT: String(DEV_PORT),
  PORT: String(DEV_PORT),
  HOST: '127.0.0.1',
  HOME: home,
  USERPROFILE: home,
  DATABASE_PATH: path.join(home, '.cloudcli', 'auth.db'),
  WORKSPACES_ROOT: workspaces,
  CCUI_TEST_WORK_ROOT: testRoot,
});
if (process.platform === 'win32') {
  env.HOMEDRIVE = path.parse(home).root.replace(/\\$/, '');
  env.HOMEPATH = home.slice(env.HOMEDRIVE.length);
}
if (Number(env.SERVER_PORT) === PROTECTED_PORT) fail('refusing to use the protected port.');

console.log(`dev-safe: port ${DEV_PORT}, home ${home}`);
const child = spawn(process.execPath, [entry], { cwd: APP_ROOT, env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('exit', (code) => process.exit(code ?? 0));
