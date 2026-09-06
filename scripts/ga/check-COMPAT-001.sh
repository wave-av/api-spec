#!/usr/bin/env bash
# check-COMPAT-001.sh — GA evidence check for COMPAT-001. Thin wrapper: the actual diff lives in
# compat-001-check.mjs (which shells out to oasdiff — see that file for how it is resolved) so the
# shell entrypoint, the ga-evidence.mjs producer, and a human running this by hand all exercise the
# identical code path.
#
# OUTPUT: one `PASS|FAIL|UNKNOWN <check-name>: <detail>` line per sub-check on stdout.
# EXIT CODES: 0 no breaking changes / 1 a breaking change was found / 2 could not run (never a
# pass) — for example no v* tag or no oasdiff/go toolchain available.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$HERE/compat-001-check.mjs"
