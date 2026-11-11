#!/usr/bin/env bash
# Fixture tests for content-policy.sh.
#
# Deliberately fixture-only: the gate is NEVER proved by writing a real leak into
# this public tree. BLOCK strings here are synthetic (a 32-hex Cloudflare-shaped
# account_id that matches the rule, not a live identifier).
#
# The load-bearing cases are the .rgignore / .ignore bypasses. --no-ignore-vcs
# disables gitignore only; ripgrep still honors those two files, so a PR that
# adds `*` there would otherwise print "content policy OK" over a planted leak.
# .guardignore remains the documented, reviewed exclude surface and must keep
# working after --no-ignore.
set -uo pipefail

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/content-policy.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Synthetic BLOCK: 32 lowercase hex after `account_id:` — matches cf-account-id,
# assembled so this file does not itself look like a live identifier to other
# scanners that are not IGNORE-exempt.
CF_ID="0123456789abcdef0123456789abcdef"
LEAK_LINE="account_id: \"${CF_ID}\""

PASS=0
FAIL=0

# expect <exit-code> <name> <setup-fn>
# setup-fn is a bash function that populates $TREE.
expect() {
  local want="$1" name="$2" setup="$3" tree out rc
  tree="$(mktemp -d "$TMP/tree.XXXXXX")"
  TREE="$tree" "$setup"
  out="$(bash "$SCRIPT" "$tree" 2>&1)"; rc=$?
  if [[ "$rc" == "$want" ]]; then
    PASS=$((PASS+1)); printf '  ok   %s\n' "$name"
  else
    FAIL=$((FAIL+1)); printf '  FAIL %s — want exit %s, got %s\n%s\n' "$name" "$want" "$rc" "$out"
  fi
  # The annotation is world-readable; a hit must never echo the matched text.
  if [[ "$rc" == 1 ]] && printf '%s' "$out" | grep -qF "$CF_ID"; then
    FAIL=$((FAIL+1)); printf '  FAIL %s — LEAKED the matched identifier into the annotation\n' "$name"
  fi
}

plant_leak() {
  printf '%s\n' "$LEAK_LINE" > "$TREE/notes.txt"
}

plant_leak_and_rgignore() {
  plant_leak
  printf '*\n' > "$TREE/.rgignore"
}

plant_leak_and_ignore() {
  plant_leak
  printf '*\n' > "$TREE/.ignore"
}

plant_leak_and_fdignore() {
  plant_leak
  printf '*\n' > "$TREE/.fdignore"
}

plant_leak_under_guardignore() {
  mkdir -p "$TREE/docs"
  printf '%s\n' "$LEAK_LINE" > "$TREE/docs/example.txt"
  printf 'docs/example.txt\n' > "$TREE/.guardignore"
}

plant_clean() {
  printf 'ordinary documentation, no identifiers\n' > "$TREE/README.md"
}

echo "content-policy fixtures"

expect 1 'synthetic Cloudflare account_id blocks' plant_leak
expect 1 '.rgignore star cannot empty the tree' plant_leak_and_rgignore
expect 1 '.ignore star cannot empty the tree' plant_leak_and_ignore
expect 1 '.fdignore is not a ripgrep ignore file' plant_leak_and_fdignore
expect 0 'documented .guardignore still excludes a named path' plant_leak_under_guardignore
expect 0 'clean tree is clean' plant_clean

echo "  ---"
if (( FAIL > 0 )); then
  echo "  $PASS passed, $FAIL FAILED"; exit 1
fi
echo "  $PASS passed, 0 failed"
