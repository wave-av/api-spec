#!/usr/bin/env node
/**
 * compat-001-check.mjs — GA evidence check for COMPAT-001 ("backward compatibility, versioning,
 * deprecation, and sunset policy are enforced").
 *
 * WHAT THIS CHECKS: does `oasdiff breaking` report zero ERR-level (breaking) changes between the
 * last GA release tag's openapi.yaml (the baseline) and HEAD's openapi.yaml (the candidate)? This
 * is exactly the gate spec's own `runnable_command` for COMPAT-001: `oasdiff breaking
 * baseline/openapi.json candidate/openapi.json`.
 *
 * WHAT THIS DOES NOT CHECK, ON PURPOSE — see the HONESTY note at the bottom of run(). COMPAT-001's
 * full pass_condition is "No unapproved breaking change; versions follow the published policy;
 * deprecated features carry notice, migration path and support window; removals expose
 * Deprecation/Sunset metadata where applicable." This repo has no machine check today for the
 * deprecation-notice / migration-path / support-window half, so that half is always reported
 * `unknown` with an explicit failing_checks entry — never folded into a claimed pass.
 *
 * BASELINE SELECTION: the highest `v*` tag on `origin` by semver sort (`git tag -l 'v*'
 * --sort=-v:refname`). Override with GA_COMPAT_BASE_TAG for local reproduction and the
 * deliberately-broken-input drill (an unknown ref makes the git read fail honestly, exit 2).
 *
 * OASDIFF RESOLUTION (this repo's own contract for a diff tool that a CI runner may not have
 * preinstalled):
 *   1. GA_OASDIFF_CMD, a full shell command line, if set (used by CI and by manual overrides).
 *   2. an `oasdiff` binary already on PATH, if present (the common local-dev case).
 *   3. `go run github.com/oasdiff/oasdiff@<pinned version>` if a `go` toolchain is present — the
 *      exact fallback this repo's brief names for CI. Pinned in OASDIFF_GO_MODULE below so a run
 *      today and a run next year resolve the identical tool.
 *   4. none of the above: the check could not run. Never treated as a pass.
 *
 * EXIT CODES (shared contract with check-CONTRACT-001.sh):
 *   0  ran, and zero breaking changes were found
 *   1  ran, and at least one breaking change was found
 *   2  could not run (no tag, no oasdiff, a git or process failure) — never read as a pass
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..');

// Pinned so `go run` resolves the identical tool on every run, the same reasoning
// registry-cleanroom.yml gives for SHA-pinning every action: an unpinned `@latest` would let the
// gate's behavior change under a PR nobody touched. Matches the oasdiff release this check was
// authored and verified against.
export const OASDIFF_GO_MODULE = 'github.com/oasdiff/oasdiff@v1.29.1';

function git(args, cwd = REPO_ROOT) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

// `cwd` defaults to this repo's root for every real caller; it exists as a parameter (rather than
// only reading the module-level REPO_ROOT) so tests can point it at a disposable scratch git repo
// and exercise "no v* tag" / "one tag" / "highest of several tags" without touching this repo's own
// tags (creating a real tag here would be a destructive, shared-state side effect of a test run).
export function resolveBaseTag(override, cwd = REPO_ROOT) {
  if (override) return override;
  const r = git(['tag', '-l', 'v*', '--sort=-v:refname'], cwd);
  if (r.status !== 0) return null;
  const tags = (r.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
  return tags[0] ?? null;
}

/**
 * Minimal argv tokenizer for GA_OASDIFF_CMD ("a full shell command line" per this override's own
 * doc comment above). Handles single/double quotes and backslash escapes so a quoted path with
 * spaces survives — naive `split(' ')` corrupted exactly that case. This is NOT a shell: no
 * globbing, no variable expansion, no pipes/redirection, and the result is passed to `spawnSync`
 * as an argv array (never through a shell string), so there is no command-injection surface here
 * either way — this only fixes correctness of the split, not a security property.
 */
export function splitShellCommand(input) {
  const parts = [];
  let cur = '';
  let hasCur = false;
  let quote = null;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === '\\' && quote === '"' && (input[i + 1] === '"' || input[i + 1] === '\\')) {
        cur += input[i + 1];
        i += 1;
      } else {
        cur += ch;
      }
      hasCur = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      hasCur = true;
      continue;
    }
    if (ch === '\\' && i + 1 < input.length) {
      cur += input[i + 1];
      i += 1;
      hasCur = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasCur) {
        parts.push(cur);
        cur = '';
        hasCur = false;
      }
      continue;
    }
    cur += ch;
    hasCur = true;
  }
  if (hasCur) parts.push(cur);
  return parts;
}

// Exported for tests, which override PATH (via `env`) to exercise "GA_OASDIFF_CMD set", "oasdiff on
// PATH", "no oasdiff but go on PATH", and "neither" without depending on what happens to be
// installed on the machine actually running the suite.
export function resolveOasdiffCmd(env = process.env) {
  if (env.GA_OASDIFF_CMD) {
    const parts = splitShellCommand(env.GA_OASDIFF_CMD).filter(Boolean);
    return { bin: parts[0], args: parts.slice(1) };
  }
  const which = spawnSync('sh', ['-c', 'command -v oasdiff'], { encoding: 'utf8', env });
  if (which.status === 0 && which.stdout.trim()) {
    return { bin: which.stdout.trim(), args: [] };
  }
  const goWhich = spawnSync('sh', ['-c', 'command -v go'], { encoding: 'utf8', env });
  if (goWhich.status === 0 && goWhich.stdout.trim()) {
    return { bin: 'go', args: ['run', env.GA_OASDIFF_GO_MODULE || OASDIFF_GO_MODULE] };
  }
  return null;
}

function runOasdiff(basePath, candidatePath) {
  const cmd = resolveOasdiffCmd();
  if (!cmd) {
    return { couldNotRun: true, detail: 'oasdiff is not installed and no go toolchain is available to run it via GA_OASDIFF_CMD / go run fallback' };
  }
  // --allow-external-refs=false: oasdiff resolves external $ref values by default. This runs on
  // pull_request against a PR-supplied openapi.yaml, so an unreviewed external $ref must never let
  // the CI runner fetch an attacker-chosen URL (SSRF). Both basePath/candidatePath are local files
  // this process wrote itself; disabling external refs only affects following $refs OUT of them.
  const args = [...cmd.args, 'breaking', '--allow-external-refs=false', '-o', 'ERR', '-f', 'json', basePath, candidatePath];
  const res = spawnSync(cmd.bin, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 180_000 });
  if (res.error) {
    return { couldNotRun: true, detail: `could not execute "${cmd.bin} ${args.join(' ')}": ${res.error.message}` };
  }
  // oasdiff's own contract for `breaking -o ERR`: 0 = no ERR-level finding, 1 = at least one. Any
  // other code (a crash, a bad invocation, a network failure inside `go run`) is a tooling failure.
  if (res.status !== 0 && res.status !== 1) {
    return {
      couldNotRun: true,
      detail: `oasdiff exited ${res.status} (expected 0 or 1): ${(res.stderr || res.stdout || 'no output').slice(0, 500)}`,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(res.stdout || '[]');
  } catch (err) {
    return { couldNotRun: true, detail: `could not parse oasdiff JSON output: ${err.message}` };
  }
  const breaking = parsed.filter((f) => f.level === 3);
  return { couldNotRun: false, breaking, exitStatus: res.status };
}

export async function run(opts = {}) {
  const baseTagOverride = opts.baseTag ?? process.env.GA_COMPAT_BASE_TAG ?? null;
  const tag = resolveBaseTag(baseTagOverride);
  if (!tag) {
    return fail('baseline-tag', 'no v* tag found on origin (git tag -l "v*" --sort=-v:refname returned nothing) and no GA_COMPAT_BASE_TAG override was set');
  }

  const headRev = git(['rev-parse', 'HEAD']);
  if (headRev.status !== 0) return fail('candidate-read', `git rev-parse HEAD failed: ${headRev.stderr}`);
  const head = headRev.stdout.trim();

  const showBase = git(['show', `${tag}:openapi.yaml`]);
  if (showBase.status !== 0) return fail('baseline-tag', `git show ${tag}:openapi.yaml failed: ${(showBase.stderr || '').trim().slice(0, 300)}`);

  const showHead = git(['show', `${head}:openapi.yaml`]);
  if (showHead.status !== 0) return fail('candidate-read', `git show ${head}:openapi.yaml failed: ${(showHead.stderr || '').trim().slice(0, 300)}`);

  const dir = mkdtempSync(join(tmpdir(), 'ga-compat-'));
  const basePath = join(dir, 'base.yaml');
  const candidatePath = join(dir, 'candidate.yaml');
  let oasdiffResult;
  try {
    writeFileSync(basePath, showBase.stdout);
    writeFileSync(candidatePath, showHead.stdout);
    oasdiffResult = runOasdiff(basePath, candidatePath);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  if (oasdiffResult.couldNotRun) return fail('oasdiff-availability', oasdiffResult.detail, tag);

  const { breaking } = oasdiffResult;
  const checks = [
    {
      name: 'breaking-changes',
      ok: breaking.length === 0,
      detail: breaking.length === 0
        ? `zero breaking (ERR-level) changes between ${tag} and HEAD (${head.slice(0, 12)})`
        : `${breaking.length} breaking (ERR-level) change(s) between ${tag} and HEAD: ${breaking.slice(0, 8).map((b) => `${b.id}@${b.operation} ${b.path}`).join('; ')}${breaking.length > 8 ? '; …' : ''}`,
    },
    // HONESTY: never claim the deprecation-notice/migration-path half of COMPAT-001's
    // pass_condition. This repo has no machine check for it today.
    {
      name: 'deprecation-notice',
      ok: 'unknown',
      detail: 'deprecation notice / migration path / support window not machine-verified by this repo',
    },
  ];

  return { couldNotRun: false, checks, tag, head, breakingCount: breaking.length };
}

function fail(name, detail, tag) {
  return { couldNotRun: true, checks: [{ name, ok: null, detail }], tag };
}

async function cli() {
  const result = await run();
  for (const c of result.checks) {
    const label = c.ok === null || c.ok === 'unknown' ? 'UNKNOWN' : c.ok ? 'PASS' : 'FAIL';
    process.stdout.write(`${label} COMPAT-001/${c.name}: ${c.detail}\n`);
  }
  if (result.couldNotRun) {
    process.exitCode = 2;
    return;
  }
  const hasFail = result.checks.some((c) => c.ok === false);
  process.exitCode = hasFail ? 1 : 0;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  cli().catch((err) => {
    process.stderr.write(`compat-001-check could not run: ${err?.stack || err}\n`);
    process.exit(2);
  });
}
