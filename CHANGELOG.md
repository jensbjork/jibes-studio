# Changelog

All notable changes to Studio are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the version is 0.x, minor versions may contain
breaking changes; they are called out under **Changed** or **Removed**.

## [Unreleased]

Nothing yet.

## [0.1.0] - 2026-10-06

The first version, published as open source.

### Added

- **Generation** with Venice.ai's video models in three modes — text-to-video, image-to-video (start and optional
  end image) and reference-to-video (up to 9 reference photos for Seedance) — with Seedance 2.5 as the default
  (8 s, 480p, 16:9, audio on), per-model options from Venice's model list, and a price quote before generating.
- A feed of generations with status, rendering time, poster frame and duration; *Använd igen* (use again), reveal
  in Finder and delete to the Trash. Pending jobs resume after a restart, and network outages are retried for over
  an hour because the job is already paid for.
- Venice's provider consent flow (`409 needs_consent`) with a consent dialog; accepted consents are remembered per
  policy version.
- A **reference-aware prompt editor**: `@ImageN` tokens coloured like the asset they point at, photo previews on
  hover, an `@` menu, a reference list that marks unmentioned photos, Swedish issue messages with quick fixes, and
  checks of the negative prompt. The same rules (`src/shared/prompt-refs.ts`) guard every paid submission in the
  main process.
- **Promptspråk** (prompt language) setting: English (default) or Swedish wording when the editor inserts
  references.
- A **library** of characters (*Karaktärer*), environments (*Miljöer*) and outfits (*Kläder*): a name, a
  description and ordered reference photos in a folder per asset with `Beskrivning.txt`; a default outfit per
  character; start and end images picked from the library.
- A **prompt library** with titles, tags, favourites, a negative prompt, filters and usage counts.
- **Sequences**: clips with their own prompt, references and settings; takes, a selected take and start/end trims;
  clips that continue from the previous clip's trimmed last frame; a timeline and preview player; *Generera
  saknade* (generate missing clips in order, stoppable); export of the cut to H.264/AAC mp4 with ffmpeg, with
  progress.
- A **base folder** chosen on first launch, with human-readable Swedish folders and file names, database paths
  stored relative to it, switching, moving or opening another library, *Städa upp* (tidy up the folder structure),
  conversion of libraries in the earlier layout, protection against a base folder that vanishes while Studio runs,
  and a warning for cloud-synced folders.
- A separate **Studio Dev** profile for `npm run dev`, `npm run dev:real` for the real profile, and
  `STUDIO_PROFILE_DIR` for throwaway profiles.
- Packaging as `Studio.app` for Apple Silicon (ad-hoc signed) with `npm run app` and `npm run app:install`.
- An **agent connection**: an MCP server over Streamable HTTP, off by default, bound to `127.0.0.1` and the
  Tailscale interface, protected by a bearer token. 26 tools to read the library, set references, fill in the
  Generate form, validate prompts and build sequences; the `write_video_prompt` prompt and the `studio://guide`
  resource; paid generations only as approval requests that the user approves or declines in an in-app dialog;
  an activity drawer, a sidebar indicator, ready-made configurations for OpenClaw and Hermes Agent, and token and
  port management in Settings.
- Documentation (README, architecture, agent setup, development guide), contribution guidelines with Conventional
  Commits, a security policy, a code of conduct, the MIT license, issue and pull request templates, Dependabot and
  a CI workflow that typechecks and builds every pull request.
