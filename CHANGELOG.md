# Changelog

All notable changes to Studio are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the version is 0.x, minor versions may contain
breaking changes; they are called out under **Changed** or **Removed**.

## [Unreleased]

### Added

- **Voices and soundscapes.** Characters get a *Röst* (voice) section and environments a *Ljudmiljö* (soundscape)
  section in the library: drop or pick MP3, WAV, M4A, AAC, AIFF, FLAC or OGG files (copied into the asset's folder),
  play them, reorder them, and choose each clip's 2–15 s **reference window** on a timeline. Files without sound or
  shorter than a second are refused; long recordings get advice to pick their best part.
- **`@AudioN` references.** With models that take reference audio (`constraints.audio_input`, e.g. Seedance's
  reference-to-video models), the Generate form and sequence clips send up to 3 audio clips, each window cut out with
  ffmpeg as mono 44.1 kHz MP3 and sent as `reference_audio_urls`. Adding a character with a voice adds its first
  voice clip (*Ta med rösten* on the chip). A *Röster och ljud* section in the form shows the clips with players and
  the 15 s budget. The prompt editor colours, checks and fixes `@Audio1`, `@Audio2` … like `@ImageN`: near misses
  such as `@Ljud1` or `@Voice1`, tokens past the clips, models without audio input, clips under 2 s or over 15 s,
  more than 15 s in all, audio without a reference image and unmentioned clips. The same rules guard every paid
  submission in the main process, which measures each clip before the price is quoted.
- **Poses** (*Poser*): a new kind of asset — photos or sketches of how people stand relative to each other — with its
  own folder `Poser/<name>/`, a sidebar entry and a *＋ Pose* reference button. A pose chip applies to chosen
  characters (all of them by default): `Anna (@Image1) and Erik (@Image3) posed as in Hug (@Image5)`.
- **A clip feed for many clips** in Generera: *Kort* (cards) or *Tabell* (a windowed table with sortable columns and
  keyboard navigation), search, filters (status, model, the asset whose photos or voice were used, rating, unrated
  or reviewed, time, standalone or in a sequence) shown as removable chips, sorting by newest, oldest, rating, cost
  or length (the view and the sort are remembered), a summary of the filtered clips, and a detail drawer with the
  player, highlighted tokens, the references and voices that were sent, the settings and actions. Cards show only a
  poster until hovered, so hundreds of clips stay fast.
- **Ratings, notes and reviews**: rate a clip 1–5 stars on its card, in the table or in the drawer, add a note and
  tags; agents' reviews are listed next to yours.
- **Lärdomar** (learnings), a tab in Prompter: short insights about prompting, by you or your agents, with a model,
  tags, pinning and the clips they are based on. An agent's learning that you edit becomes yours, and one you pin
  can no longer be changed or deleted by agents.
- **Agent tools for the new features** (13 new, 39 tools in all): assets list their audio clips and the pose kind,
  `get_asset` can return a voice's reference window as MCP audio, `update_asset_audio` moves a window,
  `set_references` takes `audio_ids` / `include_voice`, token maps include `@AudioN`, `list_models` says which
  models take reference audio, and `list_generations` filters, sorts and pages like the clip feed.
- **A review and learning loop for agents**: `review_generation` (frames next to the reference images, the clip's
  sound and the voice windows), `get_frames`, `list_exports`, `review_export` (frames at every cut of an exported
  film), `review_sequence`, `add_review`, `list_reviews`, `delete_review`, `save_learning`, `update_learning`,
  `list_learnings` and `delete_learning`. The guide explains voices, poses and the loop, and ends with the pinned and
  most recent learnings, so every new session starts from what earlier ones found out.
- The approval dialog lists the voices and sounds a request would send, with players, and colours `@AudioN` in the
  prompt.

### Changed

- The library database is migrated to version 7 (`asset_audio`, `generation_reviews`, `learnings`). From this version
  `Poser` belongs to the library; an older library whose base folder already holds a folder of your own named
  *Poser* is not opened until it is renamed. A library that a newer Studio has migrated is no longer opened by an
  older one (it says to update the app instead). Version 0.1.0 has no such check, so once a library is migrated, don't
  open it with 0.1.0: renaming or deleting a character there would lose track of its voices.
- `set_references`: an empty `image_ids` list now means none of the asset's photos (e.g. only its voice); leaving it
  out still means all of them.
- `list_generations` returns 20 generations by default (was 10) and takes `offset` for paging.
- `get_generation` also returns the user's rating and every review; `write_video_prompt` and the `studio://guide`
  resource include the learnings.
- `request_generation`, `request_segment_generation` and `request_generate_all` measure their audio clips before the
  approval request is made, so a voice window that can't be sent is refused at once; Generera does the same before
  the price quote.
- Deleting a generation now tells every view (`generation:delete`), so the clip feed drops a take deleted in the
  sequence editor.
- `media://` serves audio files with their proper content types.
- ffmpeg is now also needed for voice and sound clips (measuring them and cutting out the part that is sent) and
  for the frames agents review; generating without voices still works without it.
- Contributing: the pull request checklist asks for matching agent tools and guide text for every new user-facing
  capability, and for a CHANGELOG entry. The development guide shows how to test voices, reviews and the exact
  request body without spending money.

### Fixed

- Search fields in popovers (asset, outfit, prompt and sequence pickers) get the focus when the popover opens.

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
