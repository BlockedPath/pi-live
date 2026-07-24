# AGENTS.md — pi-live

Context for coding agents (e.g. pi) working in this repo. Read this first.

## What this repo is

`pi-live` is a live playground for [pi](https://github.com/earendil-works/pi-coding-agent),
the coding agent harness. It holds community files, a pi extension skeleton, CI,
and GitHub Projects v2 automation. Repo: <https://github.com/BlockedPath/pi-live>
(public, MIT, default branch `main`, owner `BlockedPath`).

## Layout

```
.
├── AGENTS.md                          # this file
├── README.md
├── CONTRIBUTING.md                     # dev workflow + code style
├── CODE_OF_CONDUCT.md
├── LICENSE                            # MIT
├── .github/
│   ├── ISSUE_TEMPLATE/                # bug_report.md, feature_request.md, config.yml
│   ├── PULL_REQUEST_TEMPLATE.md
│   ├── dependabot.yml                 # weekly npm (extensions/pi-live) + github-actions
│   └── workflows/
│       ├── ci.yml                     # `ci` job: npm install + tsc --noEmit in extensions/pi-live
│       ├── dependabot-auto-merge.yml  # auto-approve+merge patch/minor; leave major for review
│       └── project-triage.yml         # add issues to project board + sync Priority field
├── extensions/
│   └── pi-live/                       # pi extension skeleton (see its README.md)
│       ├── package.json               # `pi.extensions` entrypoint; deps via npm
│       ├── package-lock.json          # committed
│       ├── tsconfig.json
│       └── src/index.ts               # hello tool, session_start hook, /hello command
└── scripts/
    └── project-triage.mjs            # GraphQL helper run by .github/workflows/project-triage.yml
```

## Development

```bash
cd extensions/pi-live
npm install
npm run typecheck        # tsc --noEmit  (this is what CI runs)
```

pi loads the extension via [jiti](https://github.com/unjs/jiti) — no build step.
Quick test: `pi -e ./extensions/pi-live/src/index.ts`. For auto-discovery, symlink
the dir into `.pi/extensions/pi-live` and use `/reload`.

Code style in the extension: `defineTool` + `ExtensionAPI` from
`@earendil-works/pi-coding-agent`; `Type` from `@earendil-works/pi-ai`; tabs.

## CI & branch protection

- CI job name is **`ci`** (required by branch protection). Fails the PR if
  `npm run typecheck` fails under `extensions/pi-live/`.
- `main` protection: required status check `ci` (strict — branch must be up to
  date), required linear history, no force pushes, `allow_auto_merge` on.
- `enforce_admins` is **false** — the owner can push `main` directly; external
  PRs are still gated by `ci`.
- Dependabot auto-merges patch/minor bumps; **major bumps are left for review**
  (merge them manually or via the PR UI).

## GitHub Projects v2 board

- Project: **"@BlockedPath's Pi live"**, owner `BlockedPath`, number **`6`**
  (<https://github.com/users/BlockedPath/projects/6>)
- Configured single-select fields: `Status` (Backlog/Ready/In progress/In
  review/Done), `Priority` (P0/P1/P2), `Size` (XS..XL).

### Priority ↔ label automation

The `project-triage` workflow (`scripts/project-triage.mjs`) runs on issue
`opened`/`reopened`/`labeled`/`unlabeled`:

1. Adds the issue to project #6 (idempotent — skips if already present).
2. Sets the `Priority` field from the issue's `P0`/`P1`/`P2` label
   (highest wins if multiple; removing all P-labels clears the field).

### `PROJECT_TOKEN` secret (required)

The default `GITHUB_TOKEN` **cannot** write to user-owned Projects v2, so the
workflow uses the repo secret **`PROJECT_TOKEN`** (a classic PAT with `repo` +
`project` scopes, or a fine-grained token with Projects:RW + Issues:R). If the
secret is missing the workflow no-ops.

```bash
# rotate / set the secret
gh secret set PROJECT_TOKEN --body "ghp_..."

# test the automation by relabeling an issue
gh issue edit <number> --remove-label P1 --add-label P0
gh run list --workflow=project-triage.yml
```

> Note: the secret was initially seeded with a `gh` CLI OAuth token just to
> verify the loop; it should be replaced with a dedicated, revocable PAT.

## Labels

Repo labels include `bug`, `enhancement`, `documentation`, plus priority labels
`P0` (red, critical), `P1` (orange, high), `P2` (yellow, backlog). Issue
templates prompt contributors to check a priority; maintainers apply the label.

## Common tasks

- **Run typecheck locally** (mirror CI): `cd extensions/pi-live && npm run typecheck`
- **Open/merge a Dependabot major PR**: review then `gh pr merge <n> --squash --delete-branch`
  (auto-merge only handles patch/minor).
- **Triage an issue's priority**: change its P0/P1/P2 label — the workflow syncs
  the project's `Priority` field automatically.
- **Check alerts**: `gh api repos/BlockedPath/pi-live/dependabot/alerts`

## Conventions

- Keep commits focused; one logical change per PR.
- Never commit `node_modules/` or `dist/` (gitignored).
- When adding a new pi tool/hook, note it in `extensions/pi-live/README.md`.
- When changing CI, remember the job is named `ci` — branch protection requires
  that exact context name.
