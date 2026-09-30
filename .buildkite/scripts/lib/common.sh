#!/usr/bin/env bash
# api-spec Buildkite shadow port: shared step helpers. SOURCED by every .buildkite/scripts/<step>.sh,
# never run directly.
#
# VENDORED, trimmed subset of the org's private platform-foundation repo's Buildkite template v0
# `lib/common.sh` (queue fpc-isolated). api-spec is PUBLIC and that template lives in a PRIVATE repo,
# so GitHub Actions' "public repo cannot consume a private reusable workflow" rule applies to any
# cross-repo reference too -- the helpers are copied in, not referenced, same reasoning
# .github/workflows/foundation-gate.yml already documents for _checks.yml.
#
# Trimmed vs. the upstream template: this pipeline's two steps need no Node, no npm/pnpm install and
# no GitHub Packages credential (gate-checks is grep/wc; secrets-content-policy is gitleaks/ripgrep
# over the working tree), so bk_assert_node_major, the npm/pnpm install helpers and the NODE_AUTH_TOKEN
# handling were dropped. bk_refuse_env_names, bk_refuse_fork_build, bk_gate/bk_gates_summary,
# bk_section/bk_err/bk_mktemp_dir/bk_require_tools are kept, unchanged in behavior.
#
# Contract every step script inherits from here:
#   - `set -euo pipefail`, and never `set -x` (xtrace would print expanded values into the build log).
#   - Never print an environment variable's VALUE. Errors name the variable, never its contents.
#   - Temp dirs are job-local and removed on exit, so a disposable guest has nothing left to leak.
#
# Per-repo parameters (plain, non-secret values in the pipeline's top-level `env:`):
#   BK_REPO_SLUG            "wave-av/api-spec". REQUIRED by bk_refuse_fork_build.
#   BK_EXTRA_DENY_ENV_NAMES optional, space-separated names added to the bk_refuse_env_names list.
set -euo pipefail

_bk_lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -z "${BK_REPO_ROOT:-}" ]]; then
  if ! BK_REPO_ROOT="$(git -C "$_bk_lib_dir" rev-parse --show-toplevel 2>/dev/null)"; then
    printf 'error: %s\n' "cannot resolve the repo root from ${_bk_lib_dir} (not a git checkout); set BK_REPO_ROOT" >&2
    exit 1
  fi
fi
export BK_REPO_ROOT

_bk_cleanup_paths=()
_bk_failed_gates=()

# Credentials no CI step on a shared queue may hold, even though neither step in this pipeline needs
# one -- this is defence in depth against a misconfigured agent environment hook.
BK_DEFAULT_DENY_ENV_NAMES=(
  DOPPLER_TOKEN DOPPLER_SERVICE_TOKEN
  CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_KEY CF_API_TOKEN CF_ACCOUNT_ID CF_API_KEY
  WAVE_GATEWAY_SECRET
  GH_TOKEN GITHUB_TOKEN GH_ENTERPRISE_TOKEN NPM_TOKEN NODE_AUTH_TOKEN
  AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN
  SUPABASE_ACCESS_TOKEN SUPABASE_SERVICE_ROLE_KEY SUPABASE_DB_PASSWORD
  ANTHROPIC_API_KEY OPENAI_API_KEY
  BUILDKITE_AGENT_TOKEN BUILDKITE_API_TOKEN
)

bk_cleanup_on_exit() {
  local p
  for p in "${_bk_cleanup_paths[@]+"${_bk_cleanup_paths[@]}"}"; do
    rm -rf -- "$p"
  done
}
trap bk_cleanup_on_exit EXIT

# Buildkite log group. `---` is collapsed; bk_gate expands the group again when its gate fails.
bk_section() {
  printf -- '--- %s\n' "$*"
}

bk_err() {
  printf 'error: %s\n' "$*" >&2
}

# bk_mktemp_dir <var>: create a job-local temp dir, register it for cleanup and store its path in
# <var>. It sets a variable instead of printing the path, because a $(...) subshell would lose the
# cleanup registration.
bk_mktemp_dir() {
  local __dir
  __dir="$(mktemp -d "${TMPDIR:-/tmp}/bk.XXXXXX")"
  _bk_cleanup_paths+=("$__dir")
  printf -v "$1" '%s' "$__dir"
}

bk_require_tools() {
  local tool missing=0
  for tool in "$@"; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      bk_err "required tool '$tool' is not on PATH (guest-image prerequisite, see .buildkite/README.md)"
      missing=1
    fi
  done
  return "$missing"
}

# bk_require_param <NAME> [<ERE>]: a per-repo parameter must be set, non-empty and (optionally) match
# <ERE>. Parameters are plain values, so a mismatch may show the value; secrets are never parameters.
bk_require_param() {
  local name="$1" re="${2:-}"
  if [[ -z "${!name:-}" ]]; then
    bk_err "$name is not set. It is a required per-repo parameter of this pipeline; set it in .buildkite/pipeline.yml's top-level env"
    return 1
  fi
  if [[ -n "$re" && ! "${!name}" =~ $re ]]; then
    bk_err "$name='${!name}' does not match ${re}"
    return 1
  fi
}

# bk_refuse_env_names [NAME...]: fail when any denied credential name is present in the environment,
# even if empty. The pipeline never sets one; this refuses to run if the agent environment leaked one
# in. The list is the default set plus BK_EXTRA_DENY_ENV_NAMES plus the arguments; it only grows.
# shellcheck disable=SC2120 # the arguments are optional extra names
bk_refuse_env_names() {
  local name leaked=0
  local -a names=("${BK_DEFAULT_DENY_ENV_NAMES[@]}")
  if [[ -n "${BK_EXTRA_DENY_ENV_NAMES:-}" ]]; then
    local -a extra
    read -r -a extra <<<"$BK_EXTRA_DENY_ENV_NAMES"
    names+=("${extra[@]}")
  fi
  names+=("$@")
  for name in "${names[@]}"; do
    if [[ ! "$name" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
      bk_err "deny list entry is not a valid environment variable name; refusing to run"
      return 1
    fi
    if [[ -n "${!name+x}" ]]; then
      bk_err "$name is set in this job's environment; CI steps must not hold this credential. Remove it from the agent environment hook."
      leaked=1
    fi
  done
  return "$leaked"
}

# bk_refuse_fork_build: on a PR build, the head repo must be BK_REPO_SLUG. The primary fence is the
# pipeline setting "Build PRs from forks: off"; this catches a misconfiguration. It cannot stop a
# hostile fork on its own, because a fork PR controls its own copy of this file.
bk_refuse_fork_build() {
  bk_require_param BK_REPO_SLUG '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' || return 1
  if [[ "${BUILDKITE_PULL_REQUEST:-false}" == "false" ]]; then
    return 0
  fi
  local slug_re="${BK_REPO_SLUG//./\\.}"
  local re="^(https://|git://|ssh://git@|git@)github\\.com[:/]${slug_re}(\\.git)?$"
  if [[ ! "${BUILDKITE_PULL_REQUEST_REPO:-}" =~ $re ]]; then
    bk_err "BUILDKITE_PULL_REQUEST_REPO is not ${BK_REPO_SLUG}; refusing to build a PR from another repository"
    return 1
  fi
}

# bk_preflight: the checks every step runs first, in one call.
bk_preflight() {
  local rc=0
  # shellcheck disable=SC2119 # the default list plus BK_EXTRA_DENY_ENV_NAMES; no extra arguments here
  bk_refuse_env_names || rc=1
  bk_refuse_fork_build || rc=1
  return "$rc"
}

# bk_gate <name> <command...>: run one gate in its own log group and record a failure without
# stopping, so a single build reports every failing gate. Each gate is one external command (or shell
# function), because errexit is suspended inside `||` and a multi-command body would hide an early
# failure.
#
# DIFFERENCE FROM GH, on purpose: a GH Actions job stops at its first failing step. Here every gate
# still runs, and bk_gates_summary lists every failure at once -- the same convention the fleet's other
# shadow ports use (it surfaces more in one build instead of a red/fix/red/fix loop).
bk_gate() {
  local name="$1"
  shift
  bk_section "$name"
  local rc=0
  "$@" || rc=$?
  if ((rc != 0)); then
    printf '^^^ +++\n'
    bk_err "gate failed: ${name} (exit ${rc})"
    _bk_failed_gates+=("${name} (exit ${rc})")
  fi
}

# Last call of a gate-running script: exits non-zero when any bk_gate failed, listing each one.
bk_gates_summary() {
  if ((${#_bk_failed_gates[@]} > 0)); then
    printf '+++ %s gate(s) failed\n' "${#_bk_failed_gates[@]}"
    printf '  - %s\n' "${_bk_failed_gates[@]}"
    return 1
  fi
  printf '+++ all gates passed\n'
}
