#!/usr/bin/env bash
# Step `secrets-content-policy`: shadow port of the required GH check "Secrets + content policy" --
# the `guard` job in .github/workflows/public-repo-guard.yml. (The workflow's other job, `body-guard`,
# scans PR/issue/comment BODIES via the GitHub event payload, which Buildkite has no equivalent
# trigger for; it is not required and is out of scope for this port.)
#
# Every sub-check below is copied BYTE-FAITHFUL from the `guard` job: the same gitleaks version and
# sha256, the same ripgrep fallback-install logic, and the same script invocations. Wrapped in
# bk_gate so every failure is reported in one build (see lib/common.sh: DIFFERENCE FROM GH, on
# purpose -- a GH Actions job stops at its first failing step).
#
# GUARD_PRIVATE_REPOS is handled exactly as the GH workflow handles it: read from the environment
# (GH: `env: GUARD_PRIVATE_REPOS: ${{ vars.GUARD_PRIVATE_REPOS }}`, an org Actions *variable*, not a
# secret) and passed through to content-policy.sh unmodified. This script does not set, default, or
# widen it. An operator must configure a Buildkite pipeline (or org) environment variable of the same
# name, with the same value as the GH org variable, for this rule to run with parity. Left unset,
# content-policy.sh's own documented behavior applies: the private-repo rule is skipped (see
# scripts/public-repo-guard/content-policy.sh, "Unset locally -> this check is skipped").
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${here}/lib/common.sh"

cd "$BK_REPO_ROOT"
bk_preflight
bk_require_tools curl tar sha256sum

TOOLS_DIR=""
bk_mktemp_dir TOOLS_DIR
export PATH="${TOOLS_DIR}:${PATH}"

# --- Install gitleaks (pinned + checksum-verified) -----------------------------------------------
# Byte-faithful copy of public-repo-guard.yml's "Install gitleaks (pinned + checksum-verified)" step.
gate_install_gitleaks() {
  local GITLEAKS_VERSION="8.30.1"
  local GITLEAKS_SHA256="551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"
  local workdir=""
  bk_mktemp_dir workdir
  (
    cd "$workdir"
    curl -fsSL --proto '=https' --tlsv1.2 -o gitleaks.tar.gz \
      "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"
    echo "${GITLEAKS_SHA256}  gitleaks.tar.gz" | sha256sum -c -
    tar -xzf gitleaks.tar.gz gitleaks
    install -m 0755 gitleaks "${TOOLS_DIR}/gitleaks"
  )
  gitleaks version
}

# --- gitleaks (secret scan — published tree) ------------------------------------------------------
# Byte-faithful copy of public-repo-guard.yml's "gitleaks (secret scan — published tree)" step.
gate_gitleaks_scan() {
  gitleaks detect --no-git --source . --config .gitleaks.toml --redact --no-banner --exit-code 1
}

# --- Install ripgrep (PCRE2 build required) ---------------------------------------------------
# Byte-faithful copy of public-repo-guard.yml's "Install ripgrep (PCRE2 build required)" step
# (identical in both the `guard` and `body-guard` jobs).
gate_install_ripgrep() {
  local RIPGREP_VERSION="14.1.1"
  local RIPGREP_SHA256="4cf9f2741e6c465ffdb7c26f38056a59e2a2544b51f7cc128ef28337eeae4d8e"
  if ! command -v rg >/dev/null || ! rg --pcre2-version >/dev/null 2>&1; then
    local workdir=""
    bk_mktemp_dir workdir
    (
      cd "$workdir"
      curl -fsSL --proto '=https' --tlsv1.2 -o ripgrep.tar.gz \
        "https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_VERSION}/ripgrep-${RIPGREP_VERSION}-x86_64-unknown-linux-musl.tar.gz"
      echo "${RIPGREP_SHA256}  ripgrep.tar.gz" | sha256sum -c -
      tar -xzf ripgrep.tar.gz --strip-components=1 "ripgrep-${RIPGREP_VERSION}-x86_64-unknown-linux-musl/rg"
      install -m 0755 rg "${TOOLS_DIR}/rg"
    )
    hash -r
  fi
  rg --pcre2-version
}

# --- content policy (WAVE trade-secret / internal-leak gate) -------------------------------------
# Byte-faithful invocation from public-repo-guard.yml's "content policy" step. GUARD_PRIVATE_REPOS
# flows through from this job's own environment (see header comment above); never set here.
gate_content_policy() {
  GUARD_PRIVATE_REPOS="${GUARD_PRIVATE_REPOS:-}" bash scripts/public-repo-guard/content-policy.sh .
}

# --- body policy self-test (fixtures) -------------------------------------------------------------
# Byte-faithful invocation from public-repo-guard.yml's "body policy self-test (fixtures)" step.
# This runs the gate's own fixture suite, not a scan of this build's PR/issue body (Buildkite has no
# equivalent event payload for that -- see header comment above).
gate_body_policy_selftest() {
  bash scripts/public-repo-guard/tests/body-policy.test.sh
}

bk_gate "install gitleaks 8.30.1 (pinned + checksum-verified)" gate_install_gitleaks
bk_gate "gitleaks (secret scan — published tree)" gate_gitleaks_scan
bk_gate "install ripgrep (PCRE2 build required)" gate_install_ripgrep
bk_gate "content policy (WAVE trade-secret / internal-leak gate)" gate_content_policy
bk_gate "body policy self-test (fixtures)" gate_body_policy_selftest

bk_gates_summary
