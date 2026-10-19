# Contributing to Studio

Thanks for your interest in Studio! This is an early, personal project that is now open source, so the process is
light — but a few conventions keep the history readable and the app safe for the people who use it with a paid
API key.

By participating you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

- [Proposing changes](#proposing-changes)
- [Development setup](#development-setup)
- [Branches](#branches)
- [Commit messages](#commit-messages)
- [Pull requests](#pull-requests)
- [Code style](#code-style)
- [Reporting bugs](#reporting-bugs)
- [License](#license)

## Proposing changes

- **Small fixes** (typos, obvious bugs, docs): open a pull request directly.
- **Larger changes** (new features, new agent tools, schema changes, new dependencies, anything that changes how
  money is spent): open an issue first with the *Feature request* form, so we can agree on the approach before
  you invest time.
- **Security issues**: never in a public issue — see [SECURITY.md](SECURITY.md).

The workflow is the usual GitHub one: fork, create a branch from `main`, commit, push and open a pull request
against `main`. Pull requests are **squash-merged**, so each one becomes a single commit on `main` whose message is
the pull request's title.

## Development setup

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md). In short: Node from `.nvmrc`, `brew install ffmpeg`, the Xcode Command
Line Tools for the voice separation helper (optional), `npm install`, `npm run dev`. `npm run dev` runs the separate
**Studio Dev** profile; please develop and test there (or in a throwaway `STUDIO_PROFILE_DIR` profile), never against
a library you care about, and **don't trigger real Venice generations while testing** — the guide shows how to test
without spending money.

## Branches

Name branches `<type>/<short-description>` in kebab-case, using the same types as commit messages, optionally with
the issue number:

```
feat/export-crossfades
fix/123-trim-audio-sync
docs/agent-setup
refactor/sequence-store
```

Keep a branch focused on one change; rebase on `main` rather than merging `main` into it.

## Commit messages

Studio follows [Conventional Commits 1.0](https://www.conventionalcommits.org/en/v1.0.0/). CI checks every commit
in a pull request, and the pull request title, with commitlint (`commitlint.config.mjs`).

```
<type>(<scope>): <subject>

<body>

<footer>
```

A commit template with the same rules ships in the repository; enable it once per clone:

```bash
git config commit.template .gitmessage
```

### Type

| Type | Use for |
| --- | --- |
| `feat` | A new feature for users. |
| `fix` | A bug fix. |
| `docs` | Documentation only. |
| `refactor` | A code change that neither fixes a bug nor adds a feature. |
| `perf` | A performance improvement. |
| `test` | Adding or fixing tests. |
| `build` | The build system, packaging (electron-builder) or dependencies. |
| `ci` | GitHub Actions and other CI configuration. |
| `chore` | Maintenance that doesn't touch `src/` or the shipped app. |
| `revert` | Reverting an earlier commit. |

### Scope

Optional, but please use one when a change clearly belongs to an area. Pick the closest:

| Scope | Area | Mainly |
| --- | --- | --- |
| `generate` | The Generate view, its list of this session's clips and the job queue | `GenerateView.tsx`, `ParamsForm.tsx`, `jobs.ts`, `venice.ts`, `shared/session.ts` |
| `media` | Media: every video (the clip feed), picture and exported film | `components/media/`, `components/feed/` |
| `prompt` | The prompt editor and `@ImageN` / `@AudioN` reference checks | `components/prompt/`, `shared/prompt-refs.ts` |
| `library` | Characters, environments, products, outfits and poses, the prompt library, reviews and learnings | `components/assets/`, `components/prompts/`, `library.ts`, `reviews.ts` |
| `assets` | Reference images, audio clips and asset folders on disk | `assets.ts`, `references.ts` |
| `sequences` | Sequences and storyboards: clips, boards, transitions, takes, trims, preview, keyframes, own clips | `components/sequences/`, `components/storyboards/`, `components/takes/`, `sequences.ts`, `storyboards.ts`, `sequence-store.ts`, `imports.ts` |
| `editor` | The Editor: edits, versions, the free and paid operations, voices, transcripts and voice separation | `components/editor/`, `edits.ts`, `edit-ops.ts`, `edit-store.ts`, `edit-mix.ts`, `venice-audio.ts`, `voice-separation.ts`, `shared/edit-plan.ts`, `native/` |
| `images` | Stills and Venice's image models (*Create image…*, frames saved from takes) | `components/images/`, `images.ts`, `stills.ts` |
| `export` | ffmpeg export of sequences and storyboards | `sequence-export.ts`, `ffmpeg.ts` |
| `agent` | Agent connection: approvals, activity, the agent guide | `agent/approvals.ts`, `agent/guide.ts`, `components/agent/` |
| `mcp` | The MCP server, its tools, transport and agents' uploads | `agent/server.ts`, `agent/network.ts`, `agent/uploads.ts`, `agent/fetch-url.ts`, `agent/tools/` |
| `db` | SQLite schema and migrations | `db.ts` |
| `ui` | Shared UI components, layout and styling, the sidebar and *Activity* | `components/pickers/`, `Sidebar.tsx`, `components/work/`, `lib/work.ts`, `work.ts`, `styles.css` |
| `settings` | The Settings view, the base folder and profiles | `SettingsView.tsx`, `components/library/`, `settings.ts`, `library-root.ts`, `paths.ts` |
| `build` | electron-vite, electron-builder and packaging | `electron.vite.config.ts`, `electron-builder.yml` |
| `deps` | Dependency updates | `package.json`, `package-lock.json` |
| `docs` | README, `docs/` and other documentation | `*.md` |

An unknown scope only produces a warning, so a new area never blocks a pull request.

### Subject

- Imperative mood, lower case, no full stop: `add trim handles to takes`, not `Added trim handles.`
- At most **72 characters** for the whole header (commitlint's hard limit is 100).

### Body

Optional for small changes. Explain **what changed and why**, not how — the diff shows how. Wrap at 72 characters
and separate it from the header with a blank line.

### Footer

Reference issues (`Closes #123`, `Refs #45`) and flag breaking changes with a `BREAKING CHANGE:` footer that says
what breaks and how to migrate. A `!` after the type or scope marks a breaking change too. In Studio, breaking
changes include anything that renames or removes an MCP tool or argument, changes the library layout, or needs
users to act after updating.

An AI-assisted change carries an `Assisted-by:` trailer, never `Co-authored-by:` (see
[AI-assisted contributions](#ai-assisted-contributions)).

### Examples

```
feat(sequences): continue a clip from the trimmed last frame

fix(export): keep audio in sync when a take is trimmed

The audio stream was trimmed from the start of the file while the video
used the trim point, so every trimmed clip drifted at the cut.

Closes #42

feat(mcp)!: rename list_assets to list_library

BREAKING CHANGE: agents must call list_library instead of list_assets.

build(deps): bump electron from 44.5.1 to 44.6.0
```

To check your commits locally before pushing:

```bash
npm install --global @commitlint/cli@19 @commitlint/config-conventional@19
commitlint --from origin/main --to HEAD --verbose
```

## AI-assisted contributions

Using AI coding tools is welcome; Studio itself is largely written with them. What matters is that a person stands
behind every change:

- **You are the author and you are responsible.** Read, understand and test everything you submit, as if you had
  written it by hand. Check that nothing in it is copied from code under an incompatible licence.
- **Say that you used AI**, with an `Assisted-by:` trailer in the commit message that names the tool and model,
  for example:

  ```text
  feat(editor): add a table view of edits

  Assisted-by: Claude Code (Claude Opus 5.5)
  ```

  Mention it in the pull request description as well. Leave out ordinary tools (editors, compilers, linters).
- **Never list an AI as an author.** No `Co-authored-by:` or `Signed-off-by:` for a tool: an AI can't take
  responsibility for a change or agree to the licence, and GitHub would show it as a contributor.

This follows the practice of projects such as the Linux kernel, Fedora and OpenSSL.

## Pull requests

Write the title as a Conventional Commit (it becomes the commit on `main`), fill in the template and keep the pull
request focused. Before asking for review, check that:

- [ ] `npm run check` (typecheck + build) passes.
- [ ] You tested in the dev profile (`npm run dev`, "Studio Dev") or a throwaway profile — not against a real
      library — and said in the description whether any paid Venice generations were used.
- [ ] **No secrets or personal data**: no API keys, tokens, real names, personal paths, e-mail addresses or
      private library content in code, comments, commits, screenshots or logs. Never commit media files (videos,
      photos) or a `studio.db`.
- [ ] **Docs are updated** when behaviour, settings, scripts or agent tools change (README, `docs/` incl. the guide,
      `CHANGELOG.md` under *Unreleased*).
- [ ] **UI copy is in English**: short, plain and friendly, sentence case for buttons and headings; user-facing
      error messages from the main process too. Library folder names on disk stay Swedish (they are data). Code,
      comments, logs and docs are in English.
- [ ] **Migrations are append-only**: schema changes are a new entry at the end of the `migrations` array in
      `src/main/db.ts`, tested on a copy of a library (see
      [DEVELOPMENT.md](docs/DEVELOPMENT.md#database-migrations)).
- [ ] **Money stays guarded**: every new path that sends a generation goes through `JobManager.submit` (and its
      `@ImageN` / `@AudioN` check), every paid audio or edit request through the Editor's plan and its price check
      (`expectedPriceUsd`), nothing paid is ever sent again or by itself after a restart, and anything an agent
      triggers that costs money still needs approval in the app.
- [ ] **Agents keep up**: a new user-facing capability gets matching agent tools and guide text in
      `src/main/agent/` (and a row in [docs/AGENTS.md](docs/AGENTS.md)).
- [ ] **The agent connection stays local**: changes to the MCP server keep it bound to `127.0.0.1` and the
      Tailscale interface, behind the bearer token, off by default.
- [ ] **AI help is disclosed**: commits made with an AI tool carry an `Assisted-by:` trailer (never
      `Co-authored-by:` for a tool), and the description says so.

## Code style

There is no formatter configuration beyond `.editorconfig`; match the code around you:

- **TypeScript strict**, no `any` where a real type is possible. Types that cross processes live in
  `src/shared/types.ts`; logic shared by main and renderer lives in `src/shared/` and stays pure (no Node or DOM).
- **Formatting**: 2-space indentation, single quotes, no semicolons, no trailing commas, lines up to about 120
  characters.
- **React**: function components and hooks; state that must outlive a view lives in a small store under
  `renderer/src/lib/` (see `generateStore.ts`).
- **Styling**: Tailwind CSS utility classes with the theme tokens from `styles.css` (`bg-bg`, `bg-panel`,
  `bg-raised`, `border-line`, `text-muted`, `text-text`, `text-accent`) rather than ad-hoc colours.
- **Comments in English that explain why**, not what: the constraints, the race being avoided, the user-visible
  consequence. Doc comments (`/** … */`) on exported functions and non-obvious fields.
- **Main process**: all side effects (files, database, network, ffmpeg) happen in main; the renderer only calls
  `window.studio`. Validate IPC input, and keep file names Finder-friendly with the helpers in `paths.ts`.
- **Dependencies**: avoid new runtime dependencies; discuss them in an issue first.

## Reporting bugs

Use the *Bug report* issue form. Include the Studio version (or commit), how you run it, the macOS or Windows
version, the exact message you saw, and steps to reproduce. Redact API keys, the agent token and personal paths from
logs and screenshots. Vulnerabilities go through [SECURITY.md](SECURITY.md), not public issues.

## License

Studio is released under the [MIT License](LICENSE). By contributing, you agree that your contributions are
licensed under the same license.
