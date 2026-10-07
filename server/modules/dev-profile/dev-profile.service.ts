import fs from 'node:fs';
import path from 'node:path';

/**
 * Isolated development profile guard.
 *
 * `scripts/dev-safe.mjs` launches the server with `CCUI_DEV_PROFILE=1` and an
 * environment that points every data location into one disposable test root.
 * This module re-checks that contract from inside the server process, using the
 * values the process will really use (`os.homedir()`, `os.tmpdir()`, the
 * resolved environment after `.env` was merged), so an inherited variable, a
 * `.env` entry, or a link planted in the path cannot send development data to
 * the real user profile. It never creates or defaults anything: a missing
 * value is a violation, not a reason to fall back to a production location.
 */

const DEV_PROFILE_FLAG = 'CCUI_DEV_PROFILE';
const DEV_PORT = '3101';
const DEV_HOST = '127.0.0.1';

/** Variables that redirect a provider's data directory; allowed only inside the test root. */
const PROVIDER_LOCATION_VARIABLES = ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME'];

/** Real-user credentials must not reach a development instance. */
const CREDENTIAL_VARIABLE_PATTERN = /^(ANTHROPIC_|OPENAI_|CLAUDE_CODE_OAUTH_TOKEN$|API_KEY$|JWT_SECRET$)/;

const isWindows = process.platform === 'win32';

function comparable(value: string): string {
  const resolved = path.resolve(value);
  return isWindows ? resolved.toLowerCase() : resolved;
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(comparable(root), comparable(candidate));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/**
 * Resolves links for the deepest part of `target` that already exists and
 * appends the not-yet-created remainder, so a path that will be created later
 * is judged by where it would really land.
 */
function resolveThroughExistingAncestor(target: string): string {
  let existing = path.resolve(target);
  const remainder: string[] = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    remainder.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(fs.realpathSync.native(existing), ...remainder);
}

/**
 * Reports whether the process was started as an isolated development profile.
 *
 * Consumed by `server/load-env.ts`, which decides between enforcing the profile
 * and applying the normal production defaults.
 */
export function isDevProfileRequested(environment: NodeJS.ProcessEnv): boolean {
  return environment[DEV_PROFILE_FLAG] === '1';
}

/**
 * Lists every way the current process would leave the test root or the 3101
 * development contract. An empty list means the profile is intact.
 *
 * Consumed by the dev-profile tests; `assertDevProfileIsolation` is the runtime entry.
 */
export function collectDevProfileViolations(
  environment: NodeJS.ProcessEnv,
  runtime: { homeDirectory: string; temporaryDirectory: string },
): string[] {
  const violations: string[] = [];

  const configuredRoot = environment.CCUI_TEST_WORK_ROOT;
  if (!configuredRoot || !path.isAbsolute(configuredRoot)) {
    return ['CCUI_TEST_WORK_ROOT must be set to an absolute path'];
  }
  let testRoot: string;
  try {
    testRoot = fs.realpathSync.native(configuredRoot);
  } catch {
    return [`CCUI_TEST_WORK_ROOT does not exist: ${configuredRoot}`];
  }
  if (comparable(testRoot) !== comparable(configuredRoot)) {
    violations.push(`CCUI_TEST_WORK_ROOT resolves elsewhere (${testRoot})`);
  }

  const requireInside = (label: string, value: string | undefined) => {
    if (!value) {
      violations.push(`${label} is not set; the dev profile never falls back to a default location`);
      return;
    }
    if (!path.isAbsolute(value)) {
      violations.push(`${label} must be an absolute path (${value})`);
      return;
    }
    let landing: string;
    try {
      landing = resolveThroughExistingAncestor(value);
    } catch {
      violations.push(`${label} could not be resolved (${value})`);
      return;
    }
    if (!isInside(testRoot, landing)) {
      violations.push(`${label} resolves outside the test root (${landing})`);
    }
  };

  if (environment.SERVER_PORT !== DEV_PORT) {
    violations.push(`SERVER_PORT must be ${DEV_PORT} (got ${environment.SERVER_PORT ?? 'unset'})`);
  }
  if (environment.PORT !== undefined && environment.PORT !== DEV_PORT) {
    violations.push(`PORT must be ${DEV_PORT} when set (got ${environment.PORT})`);
  }
  if (environment.HOST !== DEV_HOST) {
    violations.push(`HOST must be ${DEV_HOST} (got ${environment.HOST ?? 'unset'})`);
  }

  requireInside('os.homedir()', runtime.homeDirectory);
  requireInside('os.tmpdir()', runtime.temporaryDirectory);
  requireInside('DATABASE_PATH', environment.DATABASE_PATH);
  requireInside('WORKSPACES_ROOT', environment.WORKSPACES_ROOT);

  for (const name of ['HOME', 'USERPROFILE', 'TEMP', 'TMP', 'TMPDIR', ...PROVIDER_LOCATION_VARIABLES]) {
    if (environment[name]) requireInside(name, environment[name]);
  }

  for (const name of Object.keys(environment)) {
    if (CREDENTIAL_VARIABLE_PATTERN.test(name)) {
      violations.push(`${name} must not be forwarded into a dev profile`);
    }
  }

  return violations;
}

/**
 * Throws, naming every violation, unless the process is fully contained in the
 * test root. Called once from `server/load-env.ts` before any data path is read.
 *
 * Consumed by: server/load-env.ts (server and CLI bootstrap).
 */
export function assertDevProfileIsolation(
  environment: NodeJS.ProcessEnv,
  runtime: { homeDirectory: string; temporaryDirectory: string },
): void {
  const violations = collectDevProfileViolations(environment, runtime);
  if (violations.length > 0) {
    throw new Error(`Dev profile isolation violated:\n  - ${violations.join('\n  - ')}`);
  }
}
