#!/usr/bin/env node
// Single entry point for the isolated development profile.
//
//   node scripts/dev-safe.mjs [start]            launch the built server on 127.0.0.1:3101
//   node scripts/dev-safe.mjs check              prove the profile resolves inside the test root
//   node scripts/dev-safe.mjs reset-db           delete the disposable test auth.db
//   node scripts/dev-safe.mjs exec -- <cmd...>   run any command under the same profile
// All commands accept `--test-root <dir>` (default: $CCUI_TEST_WORK_ROOT, else
// the `claudecodeui-custom-test` directory next to the checkout).
//
// The profile:
// - Port is fixed to 3101 and never falls back to another port; 3001 is refused.
// - The child gets an allow-listed environment, not a copy of the caller's: only
//   OS essentials pass through, so inherited DATABASE_PATH, CODEX_HOME,
//   CLAUDE_*, ANTHROPIC_*, GIT_* and similar cannot point at the real profile.
// - HOME/USERPROFILE/APPDATA/LOCALAPPDATA/TEMP/TMP, DATABASE_PATH and
//   WORKSPACES_ROOT are all forced into the test root. Every provider store
//   (~/.claude, ~/.codex, ~/.cursor, ...) and ~/.cloudcli resolves from
//   os.homedir(), so redirecting the home redirects them too.
// - The server re-verifies this from inside the process (server/load-env.ts) and
//   exits instead of falling back to a default location.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import crossSpawn from 'cross-spawn';

const DEV_PORT = 3101;
const PROTECTED_PORT = 3001;
const DEV_HOST = '127.0.0.1';
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const IS_WINDOWS = process.platform === 'win32';

// Only these caller variables reach the dev process (matched case-insensitively,
// as Windows treats names). Everything else is dropped. Extra names can be added
// per run with CCUI_DEV_ENV_PASSTHROUGH=NAME1,NAME2 (e.g. proxy settings).
const PASSTHROUGH_ENV = [
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'COMSPEC', 'OS',
  'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER', 'PROCESSOR_LEVEL', 'PROCESSOR_REVISION',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'PROGRAMDATA', 'COMMONPROGRAMFILES', 'COMMONPROGRAMFILES(X86)',
  'COMMONPROGRAMW6432', 'ALLUSERSPROFILE', 'PUBLIC', 'COMPUTERNAME', 'USERNAME', 'USERDOMAIN',
  'LANG', 'LC_ALL', 'TZ', 'TERM', 'COLORTERM', 'FORCE_COLOR', 'NO_COLOR', 'CI', 'NODE_ENV', 'SHELL', 'USER', 'LOGNAME',
];

function fail(message) {
  console.error(`dev-safe: ${message}`);
  process.exit(1);
}

const comparable = (value) => (IS_WINDOWS ? path.resolve(value).toLowerCase() : path.resolve(value));

function isInside(root, candidate) {
  const relative = path.relative(comparable(root), comparable(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

// Resolves links for the deepest existing part of the path, so a directory that
// does not exist yet is judged by where it would really be created.
function resolveThroughExistingAncestor(target) {
  let existing = path.resolve(target);
  const remainder = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    remainder.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(fs.realpathSync.native(existing), ...remainder);
}

function parseArguments(argv) {
  const rest = [...argv];
  let command = 'start';
  if (rest[0] && !rest[0].startsWith('-')) command = rest.shift();
  let testRootFlag;
  let execCommand = [];
  while (rest.length > 0) {
    const argument = rest.shift();
    if (argument === '--test-root') {
      testRootFlag = rest.shift();
      if (!testRootFlag) fail('--test-root needs a value.');
    } else if (argument === '--') {
      execCommand = rest.splice(0);
    } else {
      fail(`unknown argument: ${argument}`);
    }
  }
  if (!['start', 'check', 'reset-db', 'exec'].includes(command)) fail(`unknown command: ${command}`);
  if (command === 'exec' && execCommand.length === 0) fail('exec needs a command after `--`.');
  return { command, testRootFlag, execCommand };
}

function buildProfile(testRootFlag) {
  const requestedRoot = testRootFlag
    || process.env.CCUI_TEST_WORK_ROOT
    || path.join(path.dirname(APP_ROOT), 'claudecodeui-custom-test');
  if (!path.isAbsolute(requestedRoot) && !testRootFlag) fail('CCUI_TEST_WORK_ROOT must be an absolute path.');
  const testRoot = path.resolve(requestedRoot);

  // Judge the root before creating anything, so no directory is made through a link.
  const landing = resolveThroughExistingAncestor(testRoot);
  if (comparable(landing) !== comparable(testRoot)) {
    fail(`test root resolves elsewhere (${landing}); a link, junction, or symlinked parent is refused.`);
  }
  if (isInside(APP_ROOT, testRoot) || isInside(testRoot, APP_ROOT)) {
    fail('test root and the source checkout must not contain each other.');
  }
  // os.userInfo() reads the account database, not the environment, so this is the
  // real profile even when HOME/USERPROFILE were already redirected.
  const realHome = os.userInfo().homedir;
  if (isInside(testRoot, realHome)) fail('test root must not contain the real user home.');
  if (isInside(realHome, testRoot)) {
    const firstSegment = path.relative(realHome, testRoot).split(path.sep)[0];
    if (firstSegment.startsWith('.')) fail(`test root must not live inside a real user data directory (${firstSegment}).`);
  }

  const home = path.join(testRoot, 'home');
  const profile = {
    testRoot,
    home,
    appData: path.join(home, 'AppData', 'Roaming'),
    localAppData: path.join(home, 'AppData', 'Local'),
    tmp: path.join(testRoot, 'tmp'),
    workspaces: path.join(testRoot, 'workspaces'),
    databasePath: path.join(home, '.cloudcli', 'auth.db'),
  };
  for (const directory of [profile.home, profile.appData, profile.localAppData, profile.tmp, profile.workspaces, path.dirname(profile.databasePath)]) {
    fs.mkdirSync(directory, { recursive: true });
    if (comparable(fs.realpathSync.native(directory)) !== comparable(directory)) {
      fail(`${directory} resolves elsewhere (${fs.realpathSync.native(directory)}); refusing.`);
    }
  }
  return profile;
}

function buildEnvironment(profile) {
  const allowed = new Set([
    ...PASSTHROUGH_ENV,
    ...(process.env.CCUI_DEV_ENV_PASSTHROUGH || '').split(',').map((name) => name.trim().toUpperCase()).filter(Boolean),
  ]);
  const env = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && allowed.has(name.toUpperCase())) env[name] = value;
  }
  const set = (name, value) => {
    for (const existing of Object.keys(env)) if (existing.toUpperCase() === name.toUpperCase()) delete env[existing];
    env[name] = value;
  };
  set('CCUI_DEV_PROFILE', '1');
  set('CCUI_TEST_WORK_ROOT', profile.testRoot);
  set('SERVER_PORT', String(DEV_PORT));
  set('PORT', String(DEV_PORT));
  set('HOST', DEV_HOST);
  set('HOME', profile.home);
  set('USERPROFILE', profile.home);
  set('TEMP', profile.tmp);
  set('TMP', profile.tmp);
  set('TMPDIR', profile.tmp);
  set('DATABASE_PATH', profile.databasePath);
  set('WORKSPACES_ROOT', profile.workspaces);
  // npm would otherwise contact the registry for a version check on every run.
  set('NPM_CONFIG_UPDATE_NOTIFIER', 'false');
  if (IS_WINDOWS) {
    const drive = path.parse(profile.home).root.replace(/\\$/, '');
    set('HOMEDRIVE', drive);
    set('HOMEPATH', profile.home.slice(drive.length));
    set('APPDATA', profile.appData);
    set('LOCALAPPDATA', profile.localAppData);
  }
  if (Number(env.SERVER_PORT) === PROTECTED_PORT) fail('refusing to use the protected port.');
  return env;
}

function isPortInUse(port) {
  return new Promise((resolve) => {
    const probe = net.connect({ port, host: DEV_HOST });
    probe.once('connect', () => { probe.destroy(); resolve(true); });
    probe.once('error', () => resolve(false));
  });
}

async function requireFreeDevPort() {
  if (await isPortInUse(DEV_PORT)) {
    fail(`DEV_PORT_3101_CONFLICT: port ${DEV_PORT} is already in use; not choosing another port.`);
  }
}

// Runs inside a child process with the dev environment and reports what that
// process really sees, plus the server-side guard when the server is built.
const PROBE_SOURCE = `
import os from 'node:os';
import fs from 'node:fs';
const guard = process.argv[1];
const report = { homedir: os.homedir(), tmpdir: os.tmpdir(), guard: 'SKIPPED (the built server has no dev-profile guard; run npm run build)' };
if (fs.existsSync(guard)) {
  const { assertDevProfileIsolation } = await import(process.argv[2]);
  try {
    assertDevProfileIsolation(process.env, { homeDirectory: report.homedir, temporaryDirectory: report.tmpdir });
    report.guard = 'PASS';
  } catch (error) {
    report.guard = 'FAIL: ' + error.message;
  }
}
console.log(JSON.stringify(report));
`;

async function runCheck(profile, env) {
  const guardFile = path.join(APP_ROOT, 'dist-server', 'server', 'modules', 'dev-profile', 'index.js');
  const probe = spawnSync(process.execPath, ['--input-type=module', '-e', PROBE_SOURCE, guardFile, pathToFileURL(guardFile).href], {
    env,
    cwd: APP_ROOT,
    encoding: 'utf8',
  });
  if (probe.status !== 0) fail(`probe process failed: ${probe.stderr || probe.status}`);
  const seen = JSON.parse(probe.stdout.trim().split('\n').pop());

  const rows = [
    ['os.homedir() (child process)', seen.homedir],
    ['os.tmpdir() (child process)', seen.tmpdir],
    ['DATABASE_PATH', env.DATABASE_PATH],
    ['WORKSPACES_ROOT', env.WORKSPACES_ROOT],
  ];
  let ok = true;
  console.log(`dev-safe check: test root ${profile.testRoot}`);
  console.log(`dev-safe check: real user home ${os.userInfo().homedir} (never used by the profile)`);
  for (const [label, value] of rows) {
    const landing = resolveThroughExistingAncestor(value);
    const inside = isInside(profile.testRoot, landing);
    ok &&= inside;
    console.log(`  ${inside ? 'OK  ' : 'FAIL'} ${label}: ${value}`);
  }
  console.log(`  ${seen.guard === 'PASS' || seen.guard.startsWith('SKIPPED') ? 'OK  ' : 'FAIL'} server guard: ${seen.guard}`);
  ok &&= seen.guard === 'PASS' || seen.guard.startsWith('SKIPPED');
  console.log(`  port ${DEV_PORT}: ${(await isPortInUse(DEV_PORT)) ? 'in use' : 'free'}`);
  process.exit(ok ? 0 : 1);
}

async function runResetDatabase(profile) {
  await requireFreeDevPort();
  let removed = 0;
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const file = profile.databasePath + suffix;
    let stat;
    try {
      stat = fs.lstatSync(file);
    } catch {
      continue;
    }
    // Recheck right before deleting; only a plain file inside the test root goes.
    if (!stat.isFile() || !isInside(profile.testRoot, fs.realpathSync.native(file))) {
      fail(`refusing to delete ${file}: not a plain file inside the test root.`);
    }
    fs.unlinkSync(file);
    removed += 1;
  }
  console.log(`dev-safe: removed ${removed} test database file(s) under ${path.dirname(profile.databasePath)}`);
}

function runExec(profile, env, command) {
  const child = crossSpawn(command[0], command.slice(1), { cwd: APP_ROOT, env, stdio: 'inherit' });
  child.on('error', (error) => fail(`could not run ${command[0]}: ${error.message}`));
  child.on('exit', (code) => process.exit(code ?? 1));
  console.error(`dev-safe: running under profile ${profile.testRoot}`);
}

async function runStart(profile, env) {
  const entry = path.join(APP_ROOT, 'dist-server', 'server', 'index.js');
  if (!fs.existsSync(entry)) fail('dist-server is missing; run `npm run build` first.');
  await requireFreeDevPort();
  console.log(`dev-safe: port ${DEV_PORT}, home ${profile.home}, database ${profile.databasePath}`);
  const child = spawn(process.execPath, [entry], { cwd: APP_ROOT, env, stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('exit', (code) => process.exit(code ?? 0));
}

const { command, testRootFlag, execCommand } = parseArguments(process.argv.slice(2));
const profile = buildProfile(testRootFlag);
const env = buildEnvironment(profile);

if (command === 'check') await runCheck(profile, env);
else if (command === 'reset-db') await runResetDatabase(profile);
else if (command === 'exec') runExec(profile, env, execCommand);
else await runStart(profile, env);
