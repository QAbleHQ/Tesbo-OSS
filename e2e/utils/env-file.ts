import fs from "node:fs";
import path from "node:path";

/*
 * Per-environment configuration files, so a run can be aimed at a deployment without depending on
 * anything outside e2e/.
 *
 * The problem this solves. utils/env.ts reads the repo-root `.env` as a last resort, which is the
 * local docker stack's own configuration — the right answer on a developer's machine and the wrong
 * one everywhere else. A CI job has no reason to have that file, and if it does, its values describe
 * a stack the job is not testing. So "point the suite at staging" meant exporting a handful of
 * variables in the job definition and hoping none were missed; a missing DATABASE_URL in particular
 * fails silently, by skipping 46 spec files while still reporting success.
 *
 * The shape instead: one file per environment under e2e/environments/, named for the environment,
 * selected with E2E_ENV.
 *
 *     E2E_ENV=stage scripts/e2e-ci.sh          # reads e2e/environments/stage.env
 *     E2E_ENV_FILE=/secrets/qa.env …           # or name the file outright
 *
 * PRECEDENCE, and it matters: anything already in process.env WINS over the file. That is what makes
 * a CI job independent of the checkout — Jenkins injects credentials as environment variables, those
 * take priority, and the committed file supplies only the non-secret remainder (the two base URLs,
 * the fixture names). It also means a developer can override one value for a single run without
 * editing anything.
 *
 * Real files are gitignored (`*.env`); each environment ships a committed `.env.example` describing
 * what it needs. Never commit a connection string or a password here.
 */

const ENVIRONMENTS_DIR = path.resolve(__dirname, "../environments");

/**
 * Parses a KEY=VALUE file the way a `.env` file is actually written.
 *
 * Deliberately NOT `source`d and not eval'd: a value with a space in it ("Testing Stagging 105070")
 * would be read as a command, and a backtick in a password would be executed. scripts/e2e-stage.sh
 * learned this the same way. Blank lines and `#` comments are skipped; one layer of surrounding
 * quotes is stripped; everything after the first `=` is the value, so a connection string's own `=`
 * characters survive.
 */
export function parseEnvFile(file: string): Record<string, string> {
  const values: Record<string, string> = {};
  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch {
    return values;
  }

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
    if (!match) continue;

    let value = match[2].trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values[match[1]] = value;
  }
  return values;
}

export type LoadedEnvironment = {
  /** The E2E_ENV name, or null when none was requested. */
  name: string | null;
  /** The file actually read, or null when none was requested or it was absent. */
  file: string | null;
  /** Keys taken from the file (i.e. not already set in process.env). */
  applied: string[];
};

let loaded: LoadedEnvironment | null = null;

/**
 * Loads the selected environment file into process.env, without overwriting existing values.
 *
 * Called once, at the top of utils/env.ts, before any value is read — every consumer in the suite
 * resolves its configuration through that module, so this is the one place that has to run first.
 * Idempotent, because Playwright imports the module once per worker process.
 *
 * With neither E2E_ENV nor E2E_ENV_FILE set this does nothing at all, which keeps every existing
 * local invocation behaving exactly as it did before this file existed.
 */
export function loadEnvironmentFile(): LoadedEnvironment {
  if (loaded) return loaded;

  const explicit = process.env.E2E_ENV_FILE;
  const name = process.env.E2E_ENV ?? null;

  if (!explicit && !name) {
    loaded = { name: null, file: null, applied: [] };
    return loaded;
  }

  const file = explicit ?? path.join(ENVIRONMENTS_DIR, `${name}.env`);

  if (!fs.existsSync(file)) {
    /*
     * Named but missing is a mistake worth being loud about, not a reason to fall through to
     * localhost defaults and quietly test the wrong thing — or, worse, to test nothing while
     * reporting success. Whoever set E2E_ENV meant it.
     */
    throw new Error(
      `E2E_ENV${explicit ? "_FILE" : ""} names "${explicit ?? name}" but ${file} does not exist. ` +
        `Copy the matching ${path.basename(file)}.example and fill it in, or pass the values as ` +
        "environment variables instead — process.env always takes precedence over the file.",
    );
  }

  const applied: string[] = [];
  for (const [key, value] of Object.entries(parseEnvFile(file))) {
    // process.env wins: injected CI credentials must beat anything in the checkout.
    if (process.env[key] !== undefined) continue;
    process.env[key] = value;
    applied.push(key);
  }

  loaded = { name, file, applied };
  return loaded;
}
