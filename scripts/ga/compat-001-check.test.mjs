#!/usr/bin/env node
/**
 * compat-001-check.test.mjs — hermetic, offline, zero network, zero mutation of this repo's own
 * git tags. Covers the pure/parameterized surfaces named by review: splitShellCommand's quoting
 * (gitar, cubic P3 x2), resolveBaseTag's tag-selection edge cases against a disposable scratch git
 * repo (cubic P3), and resolveOasdiffCmd's resolution order via a PATH-scoped env override
 * (gitar/cubic quality asks for unit coverage on these scripts).
 *
 * Run: node --test scripts/ga/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { resolveBaseTag, resolveOasdiffCmd, splitShellCommand } from './compat-001-check.mjs';

// ── splitShellCommand ───────────────────────────────────────────────────────────────────────────

test('splitShellCommand: plain space-separated words', () => {
  assert.deepEqual(splitShellCommand('oasdiff breaking -o ERR'), ['oasdiff', 'breaking', '-o', 'ERR']);
});

test('splitShellCommand: double-quoted argument with a space survives as one token', () => {
  assert.deepEqual(
    splitShellCommand('docker run --rm -v "/path with spaces:/data" oasdiff'),
    ['docker', 'run', '--rm', '-v', '/path with spaces:/data', 'oasdiff'],
  );
});

test('splitShellCommand: single-quoted argument with a space survives as one token', () => {
  assert.deepEqual(splitShellCommand("bin '/a b/c'"), ['bin', '/a b/c']);
});

test('splitShellCommand: escaped quote and backslash inside double quotes', () => {
  assert.deepEqual(splitShellCommand('bin "a\\"b" "c\\\\d"'), ['bin', 'a"b', 'c\\d']);
});

test('splitShellCommand: backslash-escaped space outside quotes joins into one token', () => {
  assert.deepEqual(splitShellCommand('bin /path\\ with\\ space'), ['bin', '/path with space']);
});

test('splitShellCommand: collapses repeated whitespace and trims', () => {
  assert.deepEqual(splitShellCommand('  bin   arg1    arg2  '), ['bin', 'arg1', 'arg2']);
});

test('splitShellCommand: empty string yields no tokens', () => {
  assert.deepEqual(splitShellCommand(''), []);
});

// Hermetic git for the scratch repos: ignore the developer's global/system git config. A global
// trace2 target (e.g. a local git-ai daemon) can write into the scratch .git asynchronously after
// each git call, which raced rmSync and failed tests with ENOTEMPTY. Child git processes spawned by
// resolveBaseTag inherit this env too.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
for (const k of Object.keys(process.env)) if (k.startsWith('GIT_TRACE2')) delete process.env[k];

// Robust temp-dir removal, retrying transient ENOTEMPTY/EBUSY instead of failing the test.
function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

// ── resolveBaseTag ──────────────────────────────────────────────────────────────────────────────

function scratchGitRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'ga-compat-test-'));
  const run = (args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  run(['init', '-q']);
  run(['config', 'user.email', 'test@example.com']);
  run(['config', 'user.name', 'test']);
  // No background git writers inside the scratch repo, so cleanup never races them.
  run(['config', 'core.fsmonitor', 'false']);
  run(['config', 'gc.auto', '0']);
  run(['config', 'maintenance.auto', 'false']);
  writeFileSync(join(dir, 'f.txt'), 'x');
  run(['add', '.']);
  run(['commit', '-q', '-m', 'init']);
  return dir;
}

test('resolveBaseTag: an explicit override short-circuits without touching git', () => {
  // A cwd that does not exist would make any git call fail; the override path must never reach it.
  assert.equal(resolveBaseTag('v9.9.9', '/nonexistent/path/for/this/test'), 'v9.9.9');
});

test('resolveBaseTag: no v* tags on the repo returns null', () => {
  const dir = scratchGitRepo();
  try {
    assert.equal(resolveBaseTag(null, dir), null);
  } finally {
    cleanup(dir);
  }
});

test('resolveBaseTag: a single v* tag is returned', () => {
  const dir = scratchGitRepo();
  try {
    spawnSync('git', ['tag', 'v1.0.0'], { cwd: dir });
    assert.equal(resolveBaseTag(null, dir), 'v1.0.0');
  } finally {
    cleanup(dir);
  }
});

test('resolveBaseTag: the highest semver v* tag wins over lexical order', () => {
  const dir = scratchGitRepo();
  try {
    for (const t of ['v1.2.0', 'v1.10.0', 'v1.9.0']) spawnSync('git', ['tag', t], { cwd: dir });
    assert.equal(resolveBaseTag(null, dir), 'v1.10.0', 'v1.10.0 > v1.9.0 in semver even though "1.10" < "1.9" lexically');
  } finally {
    cleanup(dir);
  }
});

test('resolveBaseTag: non-v-prefixed tags are ignored', () => {
  const dir = scratchGitRepo();
  try {
    spawnSync('git', ['tag', 'release-1'], { cwd: dir });
    assert.equal(resolveBaseTag(null, dir), null);
  } finally {
    cleanup(dir);
  }
});

// ── resolveOasdiffCmd ───────────────────────────────────────────────────────────────────────────

function scratchBinDir(names) {
  const dir = mkdtempSync(join(tmpdir(), 'ga-compat-bin-'));
  for (const name of names) {
    const p = join(dir, name);
    writeFileSync(p, '#!/bin/sh\necho fake\n');
    chmodSync(p, 0o755);
  }
  return dir;
}

test('resolveOasdiffCmd: GA_OASDIFF_CMD override wins even when PATH has neither tool, and is parsed with quoting', () => {
  const emptyBin = scratchBinDir([]);
  try {
    const env = { PATH: emptyBin, GA_OASDIFF_CMD: 'docker run --rm -v "/p a/x:/data" oasdiff' };
    assert.deepEqual(resolveOasdiffCmd(env), { bin: 'docker', args: ['run', '--rm', '-v', '/p a/x:/data', 'oasdiff'] });
  } finally {
    cleanup(emptyBin);
  }
});

// `resolveOasdiffCmd` shells out via `sh -c 'command -v ...'`, and spawnSync's `env` option
// REPLACES the child's whole environment — so `sh` itself must still be resolvable. Every PATH
// below appends the real `/bin` (where `sh` lives on both macOS and the ubuntu-latest runner) AFTER
// the scratch bin dir, so the scratch dir takes precedence for oasdiff/go while `sh` keeps working.
// `/bin` alone (no /usr/local/bin, no /opt/homebrew/bin) is deliberately narrow so a real oasdiff or
// go installed elsewhere on the dev/CI machine cannot leak into the "neither present" case.
const REAL_SH_DIR = '/bin';

test('resolveOasdiffCmd: neither GA_OASDIFF_CMD nor oasdiff nor go on PATH returns null', () => {
  const emptyBin = scratchBinDir([]);
  try {
    assert.equal(resolveOasdiffCmd({ PATH: `${emptyBin}:${REAL_SH_DIR}` }), null);
  } finally {
    cleanup(emptyBin);
  }
});

test('resolveOasdiffCmd: oasdiff present on PATH is preferred with no extra args', () => {
  const bin = scratchBinDir(['oasdiff']);
  try {
    const result = resolveOasdiffCmd({ PATH: `${bin}:${REAL_SH_DIR}` });
    assert.equal(result.bin, join(bin, 'oasdiff'));
    assert.deepEqual(result.args, []);
  } finally {
    cleanup(bin);
  }
});

test('resolveOasdiffCmd: falls back to "go run <pinned module>" when only go is on PATH', () => {
  const bin = scratchBinDir(['go']);
  try {
    const result = resolveOasdiffCmd({ PATH: `${bin}:${REAL_SH_DIR}` });
    assert.equal(result.bin, 'go');
    assert.deepEqual(result.args, ['run', 'github.com/oasdiff/oasdiff@v1.29.1']);
  } finally {
    cleanup(bin);
  }
});

test('resolveOasdiffCmd: GA_OASDIFF_GO_MODULE overrides the pinned go module', () => {
  const bin = scratchBinDir(['go']);
  try {
    const result = resolveOasdiffCmd({ PATH: `${bin}:${REAL_SH_DIR}`, GA_OASDIFF_GO_MODULE: 'example.com/other@v9' });
    assert.deepEqual(result.args, ['run', 'example.com/other@v9']);
  } finally {
    cleanup(bin);
  }
});
