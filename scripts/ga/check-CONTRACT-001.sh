#!/usr/bin/env bash
# check-CONTRACT-001.sh — GA evidence check for CONTRACT-001. Thin wrapper: the actual comparison
# lives in contract-001-check.mjs (which reuses this repo's own published-contract-drift
# comparator) so the shell entrypoint, the ga-evidence.mjs producer, and a human running this by
# hand all exercise the identical code path.
#
# OUTPUT: one `PASS|FAIL|UNKNOWN <check-name>: <detail>` line per sub-check on stdout.
# EXIT CODES: 0 all sub-checks passed / 1 a sub-check failed / 2 could not run (never a pass).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$HERE/contract-001-check.mjs"
