import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const applicationRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const launcher = path.join(applicationRoot, 'scripts', 'dev-safe.mjs');

function createRoots() {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccui-dev-safe-')));
  const testRoot = path.join(base, 'test-root');
  const sentinel = path.join(base, 'sentinel.txt');
  fs.writeFileSync(sentinel, 'untouched');
  return { base, testRoot, sentinel, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

function runLauncher(args: string[], extraEnvironment: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [launcher, ...args], {
    cwd: applicationRoot,
    env: { ...process.env, ...extraEnvironment },
    encoding: 'utf8',
  });
}

test('exec drops inherited real-profile variables and forces every location into the test root', () => {
  const roots = createRoots();
  try {
    const realProfile = path.join(roots.base, 'real-profile');
    const result = runLauncher(
      [
        'exec', '--test-root', roots.testRoot, '--',
        process.execPath, '-e',
        'const os=require("node:os");console.log(JSON.stringify({home:os.homedir(),tmp:os.tmpdir(),env:process.env}))',
      ],
      {
        DATABASE_PATH: path.join(realProfile, 'auth.db'),
        WORKSPACES_ROOT: realProfile,
        CODEX_HOME: realProfile,
        CLAUDE_CONFIG_DIR: realProfile,
        ANTHROPIC_API_KEY: 'secret',
        SERVER_PORT: '3001',
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const seen = JSON.parse(result.stdout.trim().split('\n').pop() as string);

    assert.equal(seen.home, path.join(roots.testRoot, 'home'));
    assert.equal(seen.tmp, path.join(roots.testRoot, 'tmp'));
    assert.equal(seen.env.DATABASE_PATH, path.join(roots.testRoot, 'home', '.cloudcli', 'auth.db'));
    assert.equal(seen.env.WORKSPACES_ROOT, path.join(roots.testRoot, 'workspaces'));
    assert.equal(seen.env.SERVER_PORT, '3101');
    assert.equal(seen.env.HOST, '127.0.0.1');
    assert.equal(seen.env.CCUI_DEV_PROFILE, '1');
    for (const leaked of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY']) {
      assert.equal(seen.env[leaked], undefined, `${leaked} must not reach the dev process`);
    }
  } finally {
    roots.cleanup();
  }
});

test('check proves the child process resolves inside the test root', () => {
  const roots = createRoots();
  try {
    const result = runLauncher(['check', '--test-root', roots.testRoot]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /OK\s+os\.homedir\(\) \(child process\)/);
    assert.doesNotMatch(result.stdout, /FAIL/);
  } finally {
    roots.cleanup();
  }
});

test('reset-db removes only the test database files and leaves outside files alone', () => {
  const roots = createRoots();
  try {
    const databaseDirectory = path.join(roots.testRoot, 'home', '.cloudcli');
    fs.mkdirSync(databaseDirectory, { recursive: true });
    for (const name of ['auth.db', 'auth.db-wal', 'auth.db-shm']) fs.writeFileSync(path.join(databaseDirectory, name), 'x');
    fs.writeFileSync(path.join(databaseDirectory, 'keep.txt'), 'x');

    const result = runLauncher(['reset-db', '--test-root', roots.testRoot]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(fs.readdirSync(databaseDirectory), ['keep.txt']);
    assert.equal(fs.readFileSync(roots.sentinel, 'utf8'), 'untouched');
  } finally {
    roots.cleanup();
  }
});

test('a test root reached through a link is refused before anything is created', () => {
  const roots = createRoots();
  try {
    const target = path.join(roots.base, 'elsewhere');
    fs.mkdirSync(target);
    const linkedRoot = path.join(roots.base, 'linked-root');
    fs.symlinkSync(target, linkedRoot, 'junction');

    const result = runLauncher(['check', '--test-root', path.join(linkedRoot, 'nested')]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /resolves elsewhere/);
    assert.deepEqual(fs.readdirSync(target), []);
  } finally {
    roots.cleanup();
  }
});

test('a test root that contains the real user home or the checkout is refused', () => {
  // The drive root contains the real home on every platform; depending on where
  // the checkout lives, either containment rule may fire first.
  const result = runLauncher(['check', '--test-root', path.parse(os.userInfo().homedir).root]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must not contain/);
});
