# revala-app/.github

Organisation profile and the tooling every Revala repository shares.

- `profile/README.md`: the organisation's public profile.
- `.github/pull_request_template.md`: the default pull request template of every repository without its own; it asks
  for the evidence a reviewer reads instead of the diff.
- `actions/setup`: the Node setup every repository's jobs run after checkout — pnpm from
  `packageManager`, Node from `.node-version`, a check that `engines` and `@types/node` name the same
  major, a frozen install, and (with `packages-token`) GitHub Packages auth for `@revala-app/*`.
  `working-directory` (default `.`) points it at a package in a subdirectory, such as revala-ops
  `workers/backup`; revala-ops adopts it once this input is merged. Reference it by commit SHA like
  any third-party action.
- `vendor/`: copies files one repository owns into another with recorded provenance (decision
  0015 in revala-core). A source repository lists its exports in `vendor.json` and calls
  `.github/workflows/vendor-sync.yml`; each target receives a pull request with the files, a
  `.vendor/<source>.json` lock and `.vendor/check.mjs`, which its CI runs to fail on a hand edit.
  `.github/workflows/vendor-freshness.yml`, run by the source on a schedule, fails while a target's
  main branch still lacks what the source exports.
- `.github/workflows/actionlint.yml`: the workflow lint every repository runs, this one included.
  It owns the actionlint version and the action's commit, so neither is copied into a caller.
- `.github/workflows/merge-on-green.yml` and `merge/`: squash-merges a pull request labelled
  `automerge` once every check on its head commit is green (decision 0232 in revala-core).

## Vendor sync

A source repository's `vendor.json` maps each target repository to `{ "from", "to" }` pairs, and its
caller workflow pins the reusable workflow by commit SHA:

```yaml
jobs:
  sync:
    uses: revala-app/.github/.github/workflows/vendor-sync.yml@<sha> # main
    with:
      app-client-id: ${{ vars.APP_CLIENT_ID }}
      tooling-ref: <sha> # the same commit as the line above
    secrets:
      APP_PRIVATE_KEY: ${{ secrets.APP_PRIVATE_KEY }}
```

- **Targets come from `vendor.json`.** The workflow's first job reads the keys of `targets` and the
  sync runs once per key. There is no `targets` input: a caller that still passes one fails to start.
- **`tooling-ref` is the pinned commit.** A reusable workflow cannot read its own commit (its
  `github` context is the caller's), so the caller passes it. The run fails unless it is a full
  40-character SHA and the caller's workflow file pins `vendor-sync.yml` at that same SHA;
  `vendor/sync.mjs` and `vendor/check.mjs` are then checked out at it rather than at `main`. Move
  both lines together.
- **Trigger paths are checked against `vendor.json`.** A trigger cannot be computed, so the caller's
  `on.push.paths` restates the `from` entries by hand. The first job runs `vendor/trigger-paths.mjs`
  on the caller's workflow file and fails, naming them, when a `from` path is not covered: a file
  must match the filter, and a directory must match at any depth (`exports/**`, not `exports/*`).
  Patterns are read as GitHub reads them, later `!` exclusions included. A caller without a push
  trigger, or with a push trigger and no `paths`, passes.
- **The lock.** `.vendor/<source>.json` records `source`, `commit` and `files` (path to SHA-256,
  sorted), plus `tooling`, the SHA-256 of the `.vendor/check.mjs` that sync installed. The check
  fails on an edited or missing vendored file, and on a `.vendor/check.mjs` that no lock records.
  One matching lock is enough, because two sources may pin different commits of this repository.
  A lock written before `tooling` existed keeps passing and gains the key at its source's next sync.
- **One lock per vendored path.** Before writing, a sync reads the target's other locks. A lock of
  the same repository under a longer name (`revala-core.shared-tests.json`, left by a hand run of
  `sync.mjs` before the workflow targeted that repository) gives up the paths the sync now records
  and is deleted once it records none; otherwise it would keep the old hashes and fail the check at
  the next change. A lock of another repository naming a path the sync would write is two owners for
  one file: the sync fails, naming both, and changes nothing.
- **Exports are read in one place.** `vendor/exports.mjs` turns `vendor.json` into the files a target
  receives; `sync.mjs` copies them and `freshness.mjs` compares them, so the two cannot disagree.

## Vendor freshness

`check.mjs` proves a target matches the commit its lock names; it cannot see a sync pull request
left unmerged while the source moves on. A source repository therefore also calls the reusable
`vendor-freshness.yml` on a schedule, from its own `.github/workflows/vendor-freshness.yml`:

```yaml
on:
  schedule:
    - cron: "17 21 * * *" # daily, early morning in Australia
  workflow_dispatch:

permissions:
  contents: read

jobs:
  freshness:
    uses: revala-app/.github/.github/workflows/vendor-freshness.yml@<sha> # main
    with:
      app-client-id: ${{ vars.APP_CLIENT_ID }}
      tooling-ref: <sha> # the same commit as the line above
    secrets:
      APP_PRIVATE_KEY: ${{ secrets.APP_PRIVATE_KEY }}
```

- **Per target, by content.** For each key of `vendor.json` `targets`, `vendor/freshness.mjs` hashes
  what the source exports at the scheduled commit and compares it with the `files` of the target's
  `.vendor/<source>.json` on its default branch. A lock naming an older commit with the same files
  is fresh. A changed, added or removed file, or a missing lock, fails the job, which then names the
  open `vendor/<source>` pull request to merge (or, with none open, says to run the sync).
- **Read-only.** The release bot's token is cut down to reading one target's contents and pull
  requests. A failed scheduled run reaches the owner as GitHub's workflow-failure mail.
- **In the source, not here.** This repository is public, so its run logs would list the private
  repositories' files, and the release bot's key is a secret of the sources only. `tooling-ref` is
  checked against the caller's pin as in the sync.

## Workflow lint

A repository calls the reusable workflow from its own `.github/workflows/actionlint.yml`, pinned by
commit SHA, and keeps its triggers, permissions and concurrency there:

```yaml
jobs:
  actionlint:
    uses: revala-app/.github/.github/workflows/actionlint.yml@<sha> # main
```

- **One owner for the versions.** The actionlint version and the `raven-actions/actionlint` commit
  are written in the reusable workflow only. Dependabot moves the action here; a caller moves its
  pin.
- **`runs-on`** is a JSON array of runner labels and defaults to `["ubicloud-standard-2"]`, the
  private repositories' runner (the job holds a read-only token). This repository is public and
  passes `'["ubuntu-latest"]'` from `ci.yml`, which calls the workflow by its local path.
- **Runner labels stay with the caller.** The job checks out the calling repository, so its
  `.github/actionlint.yaml` applies: each repository declares there the labels its own workflows
  use and actionlint does not know (`ubicloud-standard-2`; `xcode-27` in revala-ios).
- **Check name.** GitHub names a called job `<caller job id> / <called job name>`: with the job id
  `actionlint` the check is `actionlint / Lint workflows`.

## Merge on green

The free organisation enforces no required checks on private repositories, so GitHub's auto-merge
would merge at once. A repository adds a workflow named exactly `Merge on green`, pinned by commit
SHA, and an `automerge` label; a pull request carrying the label is squash-merged by the release bot
once it is green:

```yaml
name: Merge on green

on:
  workflow_run:
    workflows: [CI, PR title] # every workflow a pull request runs
    types: [completed]
  pull_request_target:
    types: [labeled]

permissions:
  actions: read
  checks: read
  contents: read
  pull-requests: read

concurrency:
  group: merge-on-green-${{ github.event.workflow_run.head_sha || github.event.pull_request.head.sha }}

jobs:
  merge:
    uses: revala-app/.github/.github/workflows/merge-on-green.yml@<sha> # main
    with:
      app-client-id: ${{ vars.APP_CLIENT_ID }}
      tooling-ref: <sha> # the same commit as the line above
      required-checks: '["Check", "Test", "pr-title / pr-title"]'
    secrets:
      APP_PRIVATE_KEY: ${{ secrets.APP_PRIVATE_KEY }}
```

- **Green means all of it.** `merge/decide.mjs` waits while any workflow run or check run on the
  head commit is unfinished, stops at any that failed or was cancelled (a later run of the same
  workflow, or of the same check in the same workflow, supersedes it), and merges only once every
  entry of `required-checks` succeeded. `skipped` and `neutral` do not block a merge, but they do not
  satisfy a required entry: that needs `success`. `required-checks` must name the checks that always
  run: a path-filtered workflow may not exist yet when the others finish.
- **Required entries.** A string is a check run name, met only when every check run of that name
  succeeded. `{"check": "Check", "workflow": "ci.yml"}` is met only by that workflow file's check.
  Use the second form for a job name that more than one workflow uses: otherwise, before CI's run
  exists, another workflow's check of the same name meets the entry.
- **Check runs only.** Legacy commit statuses (`/commits/{sha}/status`) are not read and are not part
  of the gate: a failing or pending status does not hold a merge back.
- **Who may ask.** On the `labeled` event, its sender; on `workflow_run` and on a re-run, the actor of
  the last `labeled` event for `automerge` among the pull request's events. A user needs write access
  or more (`maintain` included, `triage` not); a bot needs its login in `allowed-bots`
  (`'["name[bot]"]'`, empty by default). With no such event, or more than 500 events to search,
  nothing is merged. A refusal is a warning on the run: someone with access removes the label and adds
  it again.
- **Token.** The `permissions` block above is enough: the pull request's events need
  `pull-requests: read` (or `issues: read`), the collaborator permission needs metadata read, which
  every `GITHUB_TOKEN` has, and the base ref and comparison need `contents: read`.
- **Up to date, on request.** With `require-up-to-date: true` a head that does not contain the base's
  tip waits, naming the base commit. Nothing updates the branch: its author does, CI runs on the new
  head, and that run merges it. Off by default.
- **The head it judged.** The merge passes the commit it checked as `sha`, so a push after the
  decision makes GitHub refuse the merge, and the next run judges the new commit.
- **Never a release.** A pull request with an `autorelease:` label is left for a person.
- **No pull request code runs.** Both triggers run from the default branch; only `merge/` at
  `tooling-ref` executes.

### What it does not prevent

This is not branch protection: it only decides what the workflow itself merges.

- **A hand merge of a red pull request.** The merge button and `gh pr merge` work whatever the checks
  say.
- **A direct push to `main`,** a force-push included. No check runs before it lands.
- **A same-named check standing in for a plain required entry.** While CI's own run does not exist
  yet, another workflow's successful check of that name meets `"Check"`. Only the
  `{"check": "Check", "workflow": "ci.yml"}` form closes this.
- **What a required job does.** `pull_request` workflows run from the pull request's own workflow
  files, so its author decides what a required job runs: a green `Check` proves no more than the
  workflow in that branch. Read a change under `.github/workflows` before labelling it.
- **A push after the label.** The label's author is judged, not the commits pushed after it was added:
  they merge once green.
- **A base that moves during the merge.** GitHub's merge call guards the head, not the base. Even with
  `require-up-to-date`, another merge that lands between the read of the base and the merge call (two
  pull requests turning green within seconds) is not seen.

## Node setup

```yaml
steps:
  - uses: actions/checkout@<sha> # vX
  - uses: revala-app/.github/actions/setup@<sha> # main
    with:
      packages-token: ${{ secrets.GITHUB_TOKEN }} # only where @revala-app packages are installed
      working-directory: workers/backup # only where the package is not at the root
```

- **`packages-token`** is the job's own `GITHUB_TOKEN`, as revala-core's and revala-brand's
  `publish.yml` pass it; setup-node writes a user-level `.npmrc` for `npm.pkg.github.com` and the
  token stays exported as `NODE_AUTH_TOKEN` for the rest of the job.
- **`working-directory`** is the package's directory, relative to the repository root. Its
  `package.json` gives `packageManager` and `engines`, its `pnpm-lock.yaml` keys the cache, and the
  install runs there. `.node-version` is the one in that directory or the nearest above it, up to the
  repository root (`find-node-version.sh`), so one root file serves several packages. The default,
  `.`, is the repository root, and an empty value means the same. revala-ops' Worker jobs
  (`workers/backup`, `workers/monitor`) move to this input after it is merged.
- **`install: false`** skips `pnpm install --frozen-lockfile`.

## Node major check

`actions/setup/check-node-version.mjs` compares `.node-version` with the `package.json` in the
working directory (`engines.node` and `@types/node`) and with `@types/node` in every workspace
package. The packages are the `packages:` entries of that directory's `pnpm-workspace.yaml` (names,
`*`, `**` and `!` exclusions); a package without that list has only its own `package.json` checked.

## Checks

`.github/workflows/ci.yml` runs on pull requests and on `main`:

```sh
node --test                          # vendor/, merge/ and actions/setup, on the Node in .node-version
actionlint .github/workflows/*.yml   # the reusable actionlint.yml, called locally
```

The tests run the scripts as processes on temporary directories and need no install. The
`Setup action` jobs run `uses: ./actions/setup` end to end three ways: with its defaults and with an
empty `working-directory` (the fixture copied to the root), and with `working-directory` set to
`actions/setup/test/fixtures/package`, a package with no dependencies whose `.node-version` is the
root one. The install there fetches nothing beyond pnpm itself.

| Repository | Owns |
|---|---|
| `revala-core` | `@revala-app/shared`, the API and ingest Worker, the site at revala.app (`packages/web`) and the owner console (`packages/console`, both since its decision 0217), the OpenAPI contract, catalogue assets (fuel brand logos, car images, map outlines), decisions |
| `revala-brand` | `@revala-app/design-tokens`, the app icon and mark, the design system spec |
| `revala-ios` | the SwiftUI app |
| `revala-ops` | account configuration and secret distribution as OpenTofu stacks (decision 0074 in revala-core), the backup and monitor Workers, the fuel relays, runbooks |
| `revala-android` | the Android app; paused and archived (decision 0214 in revala-core): no vendor target, nothing writes to it |
