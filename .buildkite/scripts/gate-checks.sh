#!/usr/bin/env bash
# Step `gate-checks`: shadow port of the required GH check "gate / checks" -- the `checks` job in
# .github/workflows/_checks.yml, called by foundation-gate.yml as `jobs: gate: uses: ./.github/workflows/_checks.yml`
# with `max_lines: 800`.
#
# Only the `checks` job is ported here (the required context is "gate / checks", i.e. outer job
# "gate" + inner job "checks"). foundation-gate.yml's other jobs (skill-validate, verify-routes,
# spec-lint, sdk-types, breaking-change, skills-index-coverage) are separate, non-required jobs and
# are out of scope for this port.
#
# The two gates below are copied BYTE-FAITHFUL (same regex, same commands, same allowlist files) from
# _checks.yml's `checks` job. They are wrapped in shell functions instead of inline `run:` blocks so
# bk_gate can run both and report every failure (see lib/common.sh: DIFFERENCE FROM GH, on purpose --
# a GH Actions job stops at its first failing step; every gate here still runs).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${here}/lib/common.sh"

cd "$BK_REPO_ROOT"
bk_preflight

# Mirrors _checks.yml's `inputs.max_lines` (default 800), which foundation-gate.yml pins to 800.
MAX="${MAX:-800}"

# --- Secret scan (fail-closed, allowlist-aware) -------------------------------------------------
# Byte-faithful copy of _checks.yml's "Secret scan (fail-closed, allowlist-aware)" step.
gate_secret_scan() {
  local hits
  hits=$(grep -rIEn '(sk-[A-Za-z0-9]{20}|sk_(live|test)_[A-Za-z0-9]{20}|npm_[A-Za-z0-9]{30}|sbp_[a-f0-9]{40}|github_pat_[A-Za-z0-9_]{40}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30}|AIzaSy[A-Za-z0-9_-]{20}|xai-[A-Za-z0-9]{40}|xoxb-[A-Za-z0-9-]+|-----BEGIN [A-Z ]*PRIVATE KEY)' \
    --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=dist . | grep -v 'allowlist secret' \
    | { [ -f .github/.secret-allowlist ] && grep -vFf .github/.secret-allowlist || cat; } || true)
  if [ -n "$hits" ]; then
    echo "::error::secret-like pattern found — do not commit credentials"
    echo "$hits"
    return 1
  fi
  echo "secret-scan clean"
}

# --- File-size gate ------------------------------------------------------------------------------
# Byte-faithful copy of _checks.yml's "File-size gate" step. MAX takes the place of `${{ inputs.max_lines }}`.
gate_file_size() {
  local fail=0 f n
  while IFS= read -r f; do
    grep -qxF "$f" .github/.filesize-allowlist 2>/dev/null && continue # justified exception
    n=$(wc -l < "$f")
    if [ "$n" -gt "$MAX" ]; then echo "::error::$f has $n lines (> $MAX)"; fail=1; fi
  done < <(git ls-files '*.ts' '*.tsx' '*.js' '*.py' | grep -vE '\.(types|d)\.ts$')
  if [ "$fail" = 0 ]; then echo "file-size gate passed (all <= $MAX lines)"; fi
  return "$fail"
}

bk_gate "secret scan (fail-closed, allowlist-aware)" gate_secret_scan
bk_gate "file-size gate (max ${MAX} lines)" gate_file_size

bk_gates_summary
