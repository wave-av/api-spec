# api-spec on Buildkite (shadow mode)

This directory ports api-spec's two **required** GitHub status checks to Buildkite. Each step runs
on a self-hosted agent, in its own disposable, isolated guest, on the `fpc-isolated` queue.

**The GH workflows stay untouched.** Nothing under `.github/` changes in this port, and branch
protection's required contexts are **not** touched. The GH checks remain the required checks until
an operator decides otherwise -- see "Operator steps needed" below. Buildkite statuses are
informational until that decision is made.

## Layout

| path | role |
|---|---|
| `pipeline.yml` | Two parallel command steps. Uploaded by the UI bootstrap step, which runs caps-lint first. |
| `scripts/<step>.sh` | One checked-in script per step. `command:` is only ever a script path. |
| `scripts/lib/common.sh` | Log groups, the gate runner, temp dirs cleaned on exit, an env-credential fence and a fork-PR fence. Trimmed subset of the org's internal Buildkite template (see the script's own header for what was dropped and why -- this pipeline needs no Node and no install credential). |

## What is ported

| step key | script | shadows (GH workflow / job) | required context | needs secret | timeout |
|---|---|---|---|---|---|
| `gate-checks` | `gate-checks.sh` | `.github/workflows/_checks.yml` job `checks` (called by `foundation-gate.yml` with `max_lines: 800`) | `gate / checks` | none | 10 |
| `secrets-content-policy` | `secrets-content-policy.sh` | `.github/workflows/public-repo-guard.yml` job `guard` | `Secrets + content policy` | none | 10 |

Each `command:` is a single checked-in script, so the pipeline is compatible with agent
`no-command-eval`. Both required contexts resolve on Buildkite as
`buildkite/<pipeline-slug>/gate-checks` and `buildkite/<pipeline-slug>/secrets-content-policy`
(pipeline-slug is assigned when the pipeline is created) -- **but only once the GitHub provider
settings below are enabled; see "Operator steps needed"**.

### `gate-checks` (shadows `gate / checks`)

Two gates, copied byte-faithful from `_checks.yml`'s `checks` job: the secret-regex grep (with its
`.github/.secret-allowlist` and inline `# pragma: allowlist secret`-shaped exemptions) and the
file-size gate (`.ts`/`.tsx`/`.js`/`.py`, 800-line ceiling, `.github/.filesize-allowlist` exemptions,
`.types.ts`/`.d.ts` excluded). `_checks.yml`'s other two jobs in this repo's call
(`skill-validate`, `verify-routes`) are not part of the `gate / checks` required context and are not
ported.

**Difference from GH, on purpose:** `_checks.yml`'s secret-scan step echoes the full matched line
(`path:line:match`) into the GH Actions log. This step's `gate_secret_scan` prints only `path:line`,
with the matched text replaced by the same `«match redacted — open this location to view»` marker
`content-policy.sh` already uses -- a matched credential must never be echoed into a build log. The
detection regex, the `--exclude-dir` list and the allowlist files are unchanged. Proven locally: a
planted `AKIA`-prefixed test value fails the gate, and the captured stdout+stderr of the run was
grepped for the literal value afterward -- absent.

### `secrets-content-policy` (shadows `Secrets + content policy`)

The `guard` job's five steps, byte-faithful: gitleaks 8.30.1 installed with the **same pinned
sha256** as the GH workflow, `gitleaks detect --no-git --source . --config .gitleaks.toml --redact
--no-banner --exit-code 1`, the same ripgrep-with-PCRE2 fallback install (pinned sha256), then
`bash scripts/public-repo-guard/content-policy.sh .` and the gate's own fixture self-test
(`scripts/public-repo-guard/tests/body-policy.test.sh`). The workflow's other job, `body-guard`,
scans PR/issue/comment text out of the GitHub event payload; Buildkite has no equivalent trigger for
that, it is not a required context, and it is not ported.

**`GUARD_PRIVATE_REPOS`**, handled exactly as the GH workflow handles it: GH sources it from an
org-level Actions *variable* (`env: GUARD_PRIVATE_REPOS: ${{ vars.GUARD_PRIVATE_REPOS }}`, not a
secret) and `content-policy.sh` treats an unset value as "this one rule is skipped" (its own
documented behavior, unchanged here). This pipeline does the same: the script reads
`GUARD_PRIVATE_REPOS` from its own environment and passes it through unmodified -- it never sets,
defaults, or widens it. On Buildkite, the `secrets-content-policy` step's
`secrets: [GUARD_PRIVATE_REPOS]` attribute in `pipeline.yml` exports the Buildkite cluster secret of
that name (org `wave`, cluster "WAVE self-hosted CI") as the `GUARD_PRIVATE_REPOS` env var for that
step only, and Buildkite redacts the value from build logs if it is ever printed. For parity with GH,
an operator must create that cluster secret with the same value as the GH org variable (see "Operator
steps needed").

### Known pre-existing gap (not introduced here, not fixed here)

`scripts/public-repo-guard/content-policy.sh`'s private-repo rule is entirely configuration-driven:
it only ever checks the names listed in `GUARD_PRIVATE_REPOS`. The GH org variable that name
currently holds lists nine product repos and does not include every org-private repository. This
repo's own CI config (workflow comments, `AGENTS.md`) plaintext-references at least two private
repos and one private npm-scoped package by name in a handful of lines -- none of which the
currently-configured allowlist catches. This is a **pre-existing content-policy gap in this repo**,
not introduced by this PR; full file:line detail and the local proof are in the PR description (not
duplicated here, on purpose, so this file does not itself add a fresh hit once the allowlist is
corrected). **Do not fix it in this PR** -- correcting the allowlist, or the flagged references, is
separate, tightly-scoped follow-up work. This step reproduces `content-policy.sh` exactly as
configured; it does not widen, narrow, or otherwise change what the script checks.

GH's own required-check history for this workflow is not a reliable signal right now: the org's
GitHub Actions billing lock (documented in the org's other shadow-port PRs referenced in this PR's
description) causes most recent runs to complete in ~2 seconds with no steps executed, which is why
this port exists in the first place.

## Guest-image prerequisites

- **linux x86_64.** The pinned gitleaks and ripgrep releases are amd64.
- `bash`, `git`, `grep`, `wc` (gate-checks); `curl`, `tar`, `sha256sum`, `install` (secrets-content-policy, to fetch and verify the pinned tool releases).
- **Egress:** `github.com` releases for the pinned gitleaks/ripgrep downloads. `secrets-content-policy`
  always re-downloads gitleaks -- there is no pre-baked-tool check for it -- and skips only the ripgrep
  download, when an `rg` with PCRE2 support is already on `PATH`. `gate-checks` needs no network at all.
- No secrets, no Node, no npm, no sudo, no services. Both steps run over the checked-out working
  tree only.

## Pipeline settings (Buildkite UI, not YAML)

- **Visibility: private.** The Buildkite *pipeline* stays private even though the GitHub repo is
  public -- the pipeline is operational tooling, not the product.
- **Steps:** only the caps-lint bootstrap, matching the org's standard bootstrap step (lint, then
  `&&`-upload from the host-provisioned, read-only caps-linter install, schema sha256 pinned in the
  UI step), `timeout_in_minutes: 5`, `retry.manual: false`, `agents.queue: fpc-isolated`.
- **GitHub:** trigger on push and pull_request. **Build PRs from forks: off** (the second fence is
  `bk_refuse_fork_build` in `lib/common.sh`, keyed on `BK_REPO_SLUG`).
- **Per-step GitHub commit statuses -- required for the two contexts in "What is ported" to exist
  at all.** Left at Buildkite's defaults, GitHub sees one pipeline-level status, not one per step,
  and neither `buildkite/<pipeline-slug>/gate-checks` nor
  `buildkite/<pipeline-slug>/secrets-content-policy` is ever posted. Per Buildkite's GitHub pipeline
  provider settings (<https://buildkite.com/docs/pipelines/source-control/github> /
  the REST API's `provider_settings`), enable all three, in order:
  - `publish_commit_status` (UI: "Update commit statuses") -- posts any commit status at all.
  - `publish_commit_status_per_step` (UI: "Create a status for each job") -- one status per job
    instead of one for the whole build.
  - `use_step_key_as_commit_status` -- uses each job's `key` (`gate-checks`,
    `secrets-content-policy`) as the GitHub context instead of its emoji label. Requires the two
    settings above to both be `true` first.
- **Cancel intermediate builds** and **skip intermediate builds** on `!main`.
- **`GUARD_PRIVATE_REPOS`** Buildkite cluster secret (org `wave`, cluster "WAVE self-hosted CI"),
  matching the GH org Actions variable of the same name (see above), exported to the
  `secrets-content-policy` step via its `secrets:` attribute in `pipeline.yml`.

## Caps (checked by caps-lint before upload)

- Both steps set `timeout_in_minutes: 10`. The org maximum is 60.
- `retry.automatic` only covers `exit_status: -1` (agent lost) and `255` (guest died), `limit: 1`
  each. A real gate failure is never auto-retried.
- `agents.queue: fpc-isolated` is set at the pipeline level.
- No plugins, no cache plugin, no secret values in `env`, no `cancel_on_build_failing`, no
  `bk pipeline convert`.

## Run locally

From the repo root, on linux x86_64 with `bash`, `git`, `curl`, `tar`, `sha256sum` on PATH:

```sh
.buildkite/scripts/gate-checks.sh
.buildkite/scripts/secrets-content-policy.sh
```

`gate-checks.sh` needs nothing else, runs on any platform, and passes clean on `origin/main`.

`secrets-content-policy.sh`'s gitleaks install step is **not** portable: it always fetches the pinned
linux-x64 tarball with no `command -v gitleaks` bypass, and `TOOLS_DIR` is placed first on `PATH`, so
even a native `gitleaks` already on `PATH` is shadowed once the download completes. Running the full
script therefore requires linux x86_64 (or an emulation layer that can execute that binary) -- it is
not a byte-faithful local repro on macOS or other non-x86_64-linux workstations. The ripgrep install
step, by contrast, does check `command -v rg` first: a native `rg` 14.1.1 (PCRE2 build) already on
PATH is used as-is and its download is skipped. Running `secrets-content-policy.sh` directly (outside
Buildkite) will not have `GUARD_PRIVATE_REPOS` injected by the step's `secrets:` attribute, so export it
by hand to match the GH org variable for parity (unset runs the same as GH's own "variable not
configured" case: that one rule is skipped, loudly, by `content-policy.sh` itself).

## Operator steps needed

This PR is code only. It does not, and cannot from inside a PR, do any of the following -- each is a
separate, operator-gated action:

1. Create the Buildkite pipeline, pointed at this repo, with the settings above.
2. Enable `publish_commit_status`, `publish_commit_status_per_step` and
   `use_step_key_as_commit_status` in the pipeline's GitHub provider settings -- without all three,
   GitHub never sees `gate / checks` or `Secrets + content policy`'s Buildkite counterparts at all,
   only one undifferentiated pipeline-level status.
3. Create the `GUARD_PRIVATE_REPOS` Buildkite cluster secret (org `wave`, cluster "WAVE self-hosted
   CI") to match GH's org Actions variable. The `secrets-content-policy` step already declares
   `secrets: [GUARD_PRIVATE_REPOS]` in `pipeline.yml`, so once the cluster secret exists it is
   exported to that step automatically -- no further pipeline config needed.
4. Watch both steps run green (or identify and fix real failures -- `secrets-content-policy` is
   expected to be red on `main` today; see "Known pre-existing gap" above) for a soak period before
   considering any change to branch protection's required contexts.
5. Any change to `main`'s required status checks, or to `.github/workflows/*`, stays a distinct,
   explicitly operator-approved change. This PR makes neither.
