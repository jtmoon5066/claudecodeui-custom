import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { collectDevProfileViolations, isDevProfileRequested } from '@/modules/dev-profile/dev-profile.service.js';

type Fixture = {
  root: string;
  outside: string;
  environment: NodeJS.ProcessEnv;
  runtime: { homeDirectory: string; temporaryDirectory: string };
  cleanup: () => void;
};

function createFixture(): Fixture {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ccui-dev-profile-')));
  const root = path.join(base, 'test-root');
  const outside = path.join(base, 'outside');
  const home = path.join(root, 'home');
  const tmp = path.join(root, 'tmp');
  const workspaces = path.join(root, 'workspaces');
  for (const directory of [home, tmp, workspaces, outside]) fs.mkdirSync(directory, { recursive: true });

  return {
    root,
    outside,
    environment: {
      CCUI_DEV_PROFILE: '1',
      CCUI_TEST_WORK_ROOT: root,
      SERVER_PORT: '3101',
      PORT: '3101',
      HOST: '127.0.0.1',
      HOME: home,
      USERPROFILE: home,
      TEMP: tmp,
      TMP: tmp,
      DATABASE_PATH: path.join(home, '.cloudcli', 'auth.db'),
      WORKSPACES_ROOT: workspaces,
    },
    runtime: { homeDirectory: home, temporaryDirectory: tmp },
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}

test('isDevProfileRequested only accepts the explicit flag', () => {
  assert.equal(isDevProfileRequested({ CCUI_DEV_PROFILE: '1' }), true);
  assert.equal(isDevProfileRequested({ CCUI_DEV_PROFILE: 'true' }), false);
  assert.equal(isDevProfileRequested({}), false);
});

test('a profile fully inside the test root has no violations', () => {
  const fixture = createFixture();
  try {
    assert.deepEqual(collectDevProfileViolations(fixture.environment, fixture.runtime), []);
  } finally {
    fixture.cleanup();
  }
});

test('missing data locations are violations, never defaults', () => {
  const fixture = createFixture();
  try {
    delete fixture.environment.DATABASE_PATH;
    delete fixture.environment.WORKSPACES_ROOT;
    const violations = collectDevProfileViolations(fixture.environment, fixture.runtime);
    assert.ok(violations.some((entry) => entry.startsWith('DATABASE_PATH is not set')));
    assert.ok(violations.some((entry) => entry.startsWith('WORKSPACES_ROOT is not set')));

    assert.deepEqual(collectDevProfileViolations({ CCUI_DEV_PROFILE: '1' }, fixture.runtime), [
      'CCUI_TEST_WORK_ROOT must be set to an absolute path',
    ]);
  } finally {
    fixture.cleanup();
  }
});

test('locations outside the test root are reported', () => {
  const fixture = createFixture();
  try {
    const violations = collectDevProfileViolations(
      {
        ...fixture.environment,
        DATABASE_PATH: path.join(fixture.outside, 'auth.db'),
        WORKSPACES_ROOT: fixture.outside,
        CODEX_HOME: fixture.outside,
        TEMP: fixture.outside,
      },
      { homeDirectory: fixture.outside, temporaryDirectory: fixture.outside },
    );
    for (const label of ['os.homedir()', 'os.tmpdir()', 'DATABASE_PATH', 'WORKSPACES_ROOT', 'CODEX_HOME', 'TEMP']) {
      assert.ok(violations.some((entry) => entry.startsWith(`${label} resolves outside the test root`)), label);
    }
  } finally {
    fixture.cleanup();
  }
});

test('the port and host contract is enforced', () => {
  const fixture = createFixture();
  try {
    const violations = collectDevProfileViolations(
      { ...fixture.environment, SERVER_PORT: '3001', PORT: '3001', HOST: '0.0.0.0' },
      fixture.runtime,
    );
    assert.equal(violations.length, 3);
    assert.ok(violations.some((entry) => entry.startsWith('SERVER_PORT must be 3101')));
    assert.ok(violations.some((entry) => entry.startsWith('PORT must be 3101')));
    assert.ok(violations.some((entry) => entry.startsWith('HOST must be 127.0.0.1')));
  } finally {
    fixture.cleanup();
  }
});

test('forwarded real-user credentials are rejected', () => {
  const fixture = createFixture();
  try {
    const violations = collectDevProfileViolations(
      { ...fixture.environment, ANTHROPIC_API_KEY: 'x', OPENAI_API_KEY: 'x', CLAUDE_CODE_OAUTH_TOKEN: 'x', JWT_SECRET: 'x' },
      fixture.runtime,
    );
    assert.equal(violations.length, 4);
  } finally {
    fixture.cleanup();
  }
});

test('a link inside the test root cannot redirect a data path outside it', () => {
  const fixture = createFixture();
  try {
    // 'junction' needs no elevation on Windows and is an ordinary directory symlink elsewhere.
    fs.symlinkSync(fixture.outside, path.join(fixture.root, 'home', 'escape'), 'junction');
    const violations = collectDevProfileViolations(
      { ...fixture.environment, DATABASE_PATH: path.join(fixture.root, 'home', 'escape', 'new-dir', 'auth.db') },
      fixture.runtime,
    );
    assert.ok(violations.some((entry) => entry.startsWith('DATABASE_PATH resolves outside the test root')));
  } finally {
    fixture.cleanup();
  }
});

test('a test root that is itself a link is rejected', () => {
  const fixture = createFixture();
  try {
    const linkedRoot = path.join(path.dirname(fixture.root), 'linked-root');
    fs.symlinkSync(fixture.root, linkedRoot, 'junction');
    const violations = collectDevProfileViolations({ ...fixture.environment, CCUI_TEST_WORK_ROOT: linkedRoot }, fixture.runtime);
    assert.ok(violations.some((entry) => entry.startsWith('CCUI_TEST_WORK_ROOT resolves elsewhere')));
  } finally {
    fixture.cleanup();
  }
});
