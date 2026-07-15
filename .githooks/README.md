# Git hooks (`.githooks/`)

Tracked git hooks for Project Steersman, activated via `core.hooksPath` (so they live in the
repo and are shared, unlike the default `.git/hooks/`).

## One-time setup (run BOTH)

```bash
git config core.hooksPath .githooks     # run the hook on every commit
git config push.followTags true         # make `git push` also send annotated tags
```

Until you run the first command, the hooks here do nothing. The second makes a plain `git push`
carry the release tag the hook creates — that's the whole point of the no-push design below.
(Both are per-clone local git settings; they are not stored in the repo.)

## The workflow

```
git commit        # hook builds the VSIX, installs it, and tags v<version> LOCALLY
git push          # you send the commit + tag to origin (tag rides along via push.followTags)
```

## `post-commit` — release on version bump

After **every** commit, the hook checks whether `package.json`'s `version` changed compared to
the previous commit. `package.json` is the **sole source of truth** — there is no VERSION file.
It is a **silent no-op on normal commits** — it only acts when the version string changes to a
new value.

The hook also **skips on a detached HEAD** (mid-rebase, detached checkout) — automation only runs
on a real branch, so a rebase replay can't mint a spurious release.

When the version changes (e.g. `0.2.1` → `0.3.0`) it does, in order:

1. **Builds** the VSIX — `npx --yes @vscode/vsce package --out project-steersman-<version>.vsix`.
   `*.vsix` is gitignored, so the artifact never pollutes git.
2. **Installs** the freshly built VSIX via the `code` CLI (`code --install-extension ... --force`).
3. **Tags** `v<version>` (annotated) **locally**. **The hook does NOT push.**

**Build must succeed to tag.** If the build is **attempted and fails** (npx/vsce present but
`package` errors out), the hook prints `PACKAGE FAILED … skipping install/tag` and **does NOT
create the tag** — a `v<version>` tag must never mark a release whose VSIX did not actually build.
Fix the build, then re-commit or tag manually. (A build that was never *attempted* — e.g. a GUI
commit with no `npx` on `PATH`, see below — is a different case and still tags.)

Then it prints a summary and reminds you to **`git push`** — that one manual step sends the
commit and (via `push.followTags`) the tag to origin.

If the `v<version>` tag already exists, the hook assumes the release already happened and stops
immediately — nothing is rebuilt, reinstalled, or retagged.

Every step is independently guarded: a failure in one prints a clear message (with the manual
command to finish it) but never aborts the commit or crashes your terminal. A post-commit hook's
exit code is ignored by git anyway — the commit has already happened.

### Commit from a WSL shell, not the VS Code GUI

The VS Code **Source Control GUI**'s environment often lacks `npm`/`code` on `PATH`. If you
commit a version bump from there, the hook **gracefully skips build + install** (printing a
hint) but **still tags** `v<version>` locally (tagging only needs git). To get the full
build + install + tag flow, run `git commit` from a **WSL shell** where `npm`/`code` are on
`PATH`. Either way you then `git push` manually.

### Robustness / graceful degradation

- **Detached HEAD** (mid-rebase, detached checkout) → **no release**; automation only runs on a
  real branch.
- **Ambiguous version state** (initial commit with no parent, `package.json` missing/unreadable
  in the parent, invalid JSON) → treated as "can't confirm a change" → **no release**.
- **`npm`/`vsce` not available** (e.g. VS Code GUI env) → build + install *not attempted*; tag
  still created (tagging only needs git).
- **Build attempted and FAILED** (npx/vsce present but `package` errors) → install AND tag skipped;
  no `v<version>` tag is created for a VSIX that didn't build.
- **`code` CLI not on PATH** → install skipped; hook prints the manual
  `code --install-extension ... --force`. (It resolves `code` from PATH, or the newest
  `~/.vscode-server/bin/*/bin/remote-cli/code` shim — it never hardcodes the version hash.)

### No commit loop

The hook creates a **tag** (and builds/installs) but **never creates a commit**, so it cannot
re-trigger `post-commit`. No recursion.

## `pre-commit` — lockfile version sync

`package.json` is the sole source of truth for the version. This hook's ONE job is to keep
`package-lock.json`'s top-level `version` from drifting behind it. Before **every** commit, if the
lockfile's version differs from `package.json`'s, it rewrites the lockfile's first two `"version"`
strings (the root version and `packages[""].version`; dependency versions are left untouched) to
match, then `git add`s the lockfile so the fix rides along in the same commit. It is a **silent
no-op when they already agree**.

- It **never touches `package.json`** — that is the source of truth, edited only by a human (or
  `npm version`). There is no VERSION file.
- Never blocks a commit: every failure path exits 0 and leaves the lockfile unchanged.
- Unlike `post-commit`, this hook **is** skipped by `git commit --no-verify` (that flag skips
  `pre-commit`/`commit-msg`). `STEERSMAN_SKIP_HOOK=1` skips it too.

## Bypassing / disabling

- **Skip a single commit:** set `STEERSMAN_SKIP_HOOK` to any non-empty value —

  ```bash
  STEERSMAN_SKIP_HOOK=1 git commit -m "wip"
  ```

  The hook exits immediately (no build / install / tag).
- `git commit --no-verify` does **not** skip `post-commit` (`--no-verify` only skips
  `pre-commit` / `commit-msg`) — use `STEERSMAN_SKIP_HOOK=1` instead.
- **Disable ALL hooks in this dir:**

  ```bash
  git config --unset core.hooksPath
  ```

  Re-enable later with `git config core.hooksPath .githooks`.
- The release only fires on a version change anyway, so ordinary commits are unaffected.
