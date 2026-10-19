# Changelog

All notable changes to Studio are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). While the version is 0.x, minor versions may contain
breaking changes; they are called out under **Changed** or **Removed**.

## [Unreleased]

### Added

- **A music video from your song**: *＋ New sequence → From a song…* (also ⌘K, or drop an audio file on the
  Sequences list) makes a sequence cut to an audio file of your own. The song is copied into the sequence's folder
  (`Ljud/`), its vocals are separated on this Mac (free) and its lyrics transcribed with the time of every word (priced
  first, the budget applies), then it is split into clips of about the length you choose, at its lines and phrases on
  the beat. The *song strip* above the clips shows the waveform, the beat and each clip's place in the song: drag a
  boundary (it snaps to the beat, ⌥ for anywhere), split at the playhead, merge with the next, and correct a lyric
  line by clicking it. A clip shows its place and the words sung there, and what it hears of the song: *Vocals – lip
  sync* (its window of the vocals is sent as the clip's audio reference, and the References legend says who sings
  which words), *Music – mood and rhythm*, or *No song*. When a take finishes, Studio measures where its singing sits
  against the song and starts it there in the cut (*In sync (+0.32 s)*, or *No singing found*), with ±1 frame /
  ±0.1 s to nudge it. The preview and the export play the song over the whole film, frame-exact, instead of the
  clips' own sound; the *Song* chip in the header replaces or removes it. Kept in the sequence's defaults and
  `.studio/song-sync.json`, no schema change. Agents: `create_sequence_from_song`, `suggest_song_sections`,
  `set_song_sections`, `edit_song_lyrics` and `request_song_lyrics` (asks for approval: the transcription is paid);
  `get_sequence` shows the song, each clip's place, words and sync, `update_segment` takes `song: {part, singer}` and
  `update_sequence` `song: null`. 96 tools in all (37 read, 49 write, 10 ask for approval).
- **A sequence's cast**: *Cast* in the sequence's header chooses the characters, outfits (and who wears them),
  environments, products and poses once for the whole sequence instead of per clip – add (at the end, a character with
  its default outfit and voice), remove, move, swap for another asset, a voice on or off, who wears an outfit. New clips
  start with the cast as their references (a clip continuing in reference mode carries them from the clip before), and
  every clip whose references are exactly the cast's *follows* it: changing the cast changes those clips in the same
  step, their prompts kept on the same pictures – an addition keeps every number, a removal takes its tokens out, a
  reorder renumbers, a swap keeps every number and the name in front follows. The clip editor says *Follows the cast*,
  *Carries the cast from clip N* or *Own references* with *Use the cast*. Kept in the sequence's defaults, no schema
  change. Agents: `update_sequence` takes `cast` (asset items like `set_references`', `outfit_wearers`) and
  `swap_cast_asset`, `get_sequence` shows the `cast` and each clip's `follows_cast`, `add_segment` starts a new shot
  from the cast unless `references` are given, and `update_segment` takes `use_cast: true`.
- **Spending and a budget** (*Settings → Spending*): what Studio has paid Venice for today, this month and per day
  over the last 30 days (a small chart, with a table view), and this month by kind (videos, images, Editor jobs,
  voices, transcripts), by place (Generate, each sequence, storyboard and edit) and by who asked (you, or the agent
  whose request you approved). Finished videos count at their price, failed ones not at all; work still rendering is
  *on its way*, not spent. An optional daily and monthly budget, per profile: anything paid that would take the
  spending past one – a video and its variants, a clip, a transition, *Create image…*, the Editor's paid cards and
  *Continue*, *Design a voice with AI…*, and *Generate missing* with the run's total – asks first (*Over your budget:
  This costs $0.56 and takes today’s spending past your budget of $5.00 ($4.80 spent). Send it anyway?*). An agent's
  request past the budget says so in its approval dialog, and approving it is the yes. Agents: `get_spending` (the
  same numbers, the caps and the room left), and a paid request's answer carries `over_budget` and a `budget_note`;
  only you set the budget.
- **⌘K: search everywhere and go there**: one field, from any view (a text field too) or the search button by the
  wordmark (also in the rail), that finds the views, Media's tabs, Settings' sections, *Activity* and the agent, the
  actions (*New sequence*, *New storyboard*, *New edit*, *New character* … – the same as the list's *＋ New*, the
  sidebar's toggle) and everything in the library: characters, environments, products, outfits and poses by name and
  description, saved prompts by title, text and tags (*Use in Generate*), sequences by name and their clips by notes
  and prompt, storyboards with their boards' notes and transitions' prompts, edits, clips (newest first), images by
  their prompt and exported films. Letter case and accents don't matter (*cafe* finds *Café*), every word must start a
  word, and the matches are marked; results come grouped, the best group first, with a picture where there is one.
  ↑ / ↓ and Enter or the mouse open it where the rest of Studio does (a clip's drawer in Media, a sequence on that
  clip, a board or transition, an edit); Esc closes. Agents already find all of this with their list and get tools.
- **Several variants at once**: *×1 ×2 ×3 ×4* beside *Generate*, a sequence clip's *Generate take* and a storyboard
  transition's *Generate* sends that many takes of the same settings at once – each its own generation, with its own
  seed, at the full price. The button shows the total (*Generate ×3 · $3.09*), ⌘ + Enter sends as many, and each
  place remembers its choice (×1 to begin with). In a clip or transition every variant becomes a take, and the first to
  finish is chosen only when there was no usable take. The whole amount is checked against the budget before anything
  is sent; a consent Venice asks for comes before the first variant, and if a later one can't be sent the error says
  how many were. Agents: `request_generation`, `request_segment_generation` and `request_transition_generation` take
  `count` (1–4); the approval dialog shows *3 variants · $3.09*, approving sends them all, and `get_approval` returns
  every `generation_id`.
- **Check an agent's request against its references**: in the approval dialog, hovering (or tabbing to) an `@ImageN`
  or `@AudioN` token in the prompt or the References legend shows a card with the picture large enough to recognise –
  the asset, *foto 2 av 3*, *skickas inte* past the model's limit – or the voice with its window and a play button for
  exactly the part that is sent; misspelled tokens say what is wrong. Tokens and the reference tiles or voice rows
  they name light up together, and hovering a tile, a start or end image, a neighbour's frame, a storyboard board or
  an edit's frame shows it larger the same way. Nothing opens on a click (a request is looked at there, not changed),
  and Esc closes a card before the dialog. A finished clip's drawer shows the same cards on its prompt's tokens.
- **Look at and swap a reference without losing the prompt**: hovering a reference thumbnail in Generera, a
  sequence clip or *Skapa bild…* (or tabbing to it) shows it larger with what it is – `@Image2 · Anna · foto 2 av 3`,
  *skickas inte* past the model's limit. A click on it (not a drag, which still reorders) swaps it: a library photo
  gives every place of its asset to the asset you pick (its own kind first), and one character for another brings
  everything that belongs to it along – its outfit goes to the new character's default outfit (or stays, worn by the
  new character, when it has none), its voice to the new one's, and the poses (*gäller*) and products (*hålls av*)
  that applied to it apply to the new one. *Välj en enskild bild i stället…*, a picture of its own, a start or end
  image and *Skapa bild…*'s references swap just that place, for a library photo, a saved picture or a file. No
  `@ImageN` or `@AudioN` number changes, and the name written right before a fully swapped group follows
  (`Anna (@Image1)` → `Bo (@Image1)`), as do the description switch and who wears which outfit; clips that carry the
  references keep their tokens. Agents: `swap_reference` (`image`, `with`, `whole_asset` – which for a character
  hands over its outfit too –, for the form or a clip), 90 tools in all (35 read, 46 write, 9 ask for approval).
- **The prompt says who wears the clothes**: with *Ta med beskrivningar* on, the References legend names the
  character wearing each outfit – `Röd klänning (@Image3), worn by Anna (@Image1, @Image2): …` (`bärs av` in
  Swedish) – also for an outfit without a description, so the model can't take the clothes for anyone else's. The
  outfit chip's *bärs av* decides it (by default the character whose default outfit it is, else the only character);
  *Läggs till i prompten* shows the wearer on the outfit's row. Agents: `set_form`, `add_segment` and
  `update_segment` take `outfit_wearers`, and `description_entries` report `worn_by`.
- **Mediabank**, first under *Bibliotek* in the sidebar: everything you've made in one place, in three tabs.
  *Videor* is the full clip feed – every generation, take, own film and version, with the filters, *Kort* / *Tabell*,
  *Importera egna klipp…* and the detail drawer; *Använd igen* there fills Generera's form. *Bilder* holds every
  picture, filtered by *Källa* and *Plats*, each opened large. *Filmer* lists the exported films: play one, open it
  in Redigera or go to its sequence or storyboard. Agents open it with `open_in_studio({view: "media", tab,
  generation_id | still_id | export_id})`, and `get_workspace` says which tab is on screen (`media_tab`).
- **Export och import** under Inställningar: the whole library – a consistent copy of the database and every file,
  without caches, settings, the API key or the agent token – packed into one zip (streamed, Zip64, progress and
  *Avbryt*), and such a zip imported in another Studio (also from the first screen on a new Mac): checked, unpacked
  into a new folder and opened as the library, the previous one left where it is. Agents can't do either.
- **Continuations keep their references** (*Startbild från föregående klipp*): a clip that continues from the
  previous one is now sent in reference mode by default (*Med referensbilder*) – the reference photos and voices it
  carries (its own, or those of the clip it continues from) plus the previous clip's last frame as one more
  reference, with an instruction to start on it – so characters stay themselves across clips, also after leaving the
  picture. *Exakt startbild* keeps the exact image-to-video start. When the references change in the clip they come
  from, the clips that carry them keep their `@` tokens on the same pictures and voices. An older continuation, stored
  without a format, takes that clip's format. Agents choose it with `continue_mode` on `add_segment` /
  `update_segment`; `get_sequence` shows `carried_references`, and `request_generate_all` measures the carried voices
  before it asks.
- **One-command install**: `install.sh` checks the Mac, installs ffmpeg with Homebrew if needed, downloads the newest
  `Studio-mac-arm64.zip` from GitHub Releases into Applications and opens it. A release workflow builds the ZIP and a
  DMG on an Apple Silicon runner when a version tag is pushed.
- **A short README** with screenshots (taken by `npm run screenshots` from an empty throwaway library); the detailed
  feature guide moved to `docs/GUIDE.md`.
- **AI-assisted contributions** in CONTRIBUTING.md: AI tools are welcome, the person submitting is the author and
  responsible, AI help is disclosed with an `Assisted-by:` trailer, and a tool is never listed as a co-author.
- **Deleting from the lists**: a sequence can be deleted from its ⋯ menu (*Radera sekvensen…*) as well as with the ✕
  in the list, an edit with the ✕ on its card or row in Redigera – always after a question that says what stays
  (takes in Generera, exported films, versions in use) and what goes to the Trash.
- **Redigeringar as a table**: the same *Kort / Tabell* switch as Generera's clip feed (remembered), with poster,
  name and where it came from, versions, length, cost, what is running or new and when it last changed; the column
  headers sort.
- **Writing help in every prompt field** (Generera, Sekvenser, storyboard transitions, *Skapa bild…*, Redigera, Prompter,
  *Undvik*, descriptions): larger, airier text in a clearly framed field that grows with what you write; **fokusläge**
  (*⤢ Större* or ⌘⇧F) opens the same field large, with the references and checks still under it; and
  **byggstenar** – type **/** (or click a chip under the field) for ready-made phrases with Swedish labels that insert
  English text: a scene template, framing, camera, light, style, motion and sound, things to avoid in negative
  prompts, music and sound effects in Redigera, plus your saved prompts and learnings. Agents read the same list with
  the new `get_prompt_blocks`.
- **Produkter**, a fifth kind of asset next to characters, environments, outfits and poses: a specific item to show
  in the film — a package, a bottle, a gadget — with its packshots (the front with the label first) and a description
  (brand, model, colours, material, size, what the packaging says) that is appended to the prompt like the others.
  It has its own view in Bibliotek with square photo tiles, its own folder `Produkter/<name>/`, an orange colour and a
  box icon, a *＋ Produkt* reference button and picker tab, and a packshot can be a clip's start or end image. In the
  form a product chip can be held by one of the characters (*Hålls av*, nobody by default), and the prompt then says
  `Anna (@Image1) holding Kaffeburken (@Image4)` (`håller` in Swedish).
- **Click a take to use it.** In Sekvenser and in a storyboard's transition editor the takes are a strip of thumbnails
  right under the player (newest first, each keeping its place when it finishes). A click makes a take the clip's or
  transition's take and plays it from its kept start, with sound; clicking it again starts it over. ← / → and Home / End
  choose takes at once (paused; Studio saves the choice once you stop), ⌥-click or *Förhandsvisa utan att välja* plays a
  take without choosing it (*Välj den* / *Visa vald*, Esc goes back), hovering scrubs a silent preview, and each tile
  shows *Vald*, *Ny*, *I kö* / *Genererar 40 %*, *Misslyckades*, *Filen saknas*, *Egen* / *Redigerad* or *Tidigare
  bild*. One line under the strip tells the take's time, length, price, model and prompt (*Annan prompt än nu* with
  *Använd prompt*); it stays on the take while the pointer moves down to its buttons. The menu (right-click or ⋯) has
  the preview, *Använd tagningens prompt*, *Redigera tagningen…*, *Visa i Finder* and *Radera tagningen…* (or *Ta bort
  från klippet…* for a film Redigera keeps), with ⌫ as a shortcut. Own films can be dropped on the strip or added from
  its dashed tile, and show as *Importerar 30 %* with ✕ while they come in.
- **Each take keeps its own trims**: trim take A, choose B, choose A again, and A's trims are back (agents selecting a
  take get the same).
- **Pågår och klart** (in progress and done): what runs and what has finished that you haven't looked at yet, wherever
  you started it. Every sidebar view shows a spinner with the number of things running there and a dot for new
  results (red for a failure), with the details in its tooltip; so do the rows of Sekvenser, Storyboards, Redigera and
  the asset lists, the feed's cards (*Ny*) and table, the timeline cards (*Genererar 40 %*, *Ny tagning*), the take
  strip, the transitions (*Klart · ny tagning*), board pictures, versions (*Ny version*) and designed voices. The new
  row at the bottom of the sidebar opens a panel with everything running (grouped by place, with progress, *≈ 1 min
  kvar* or *brukar ta ~3 min*, and the agent it was done for), what is ready to watch and what failed; a click goes
  there, and agent requests waiting for you can be reviewed from it. A video or a sound counts as seen once it has
  played for a second (or you chose it, rated it, opened it in Redigera …); a picture or a failure once it has been on
  screen for a moment (a picture made for no board or clip is listed in Generera, a voice design that failed in the
  character's *Röst*). *Markera alla som sedda* (in the panel, the lists and the ⋯ menus) can be undone for 10
  seconds (*Ångra*). The feed gets a *Nya* filter and a *◌ n pågår* chip, a running export and its *Filmen är klar –
  Visa i Finder · Redigera* banner now stay when you leave the view, and Studio's Dock icon shows the number of new and
  failed results.
- **A grouped sidebar that folds away**: *Skapa* (Generera, Sekvenser, Storyboards, Redigera) and *Bibliotek*
  (Karaktärer, Miljöer, Produkter, Kläder, Poser, Prompter) with one 16 px icon set; the button next to the wordmark,
  or ⌃⌘S, folds it to a 72 px icon rail whose icons keep their status as badges and explain themselves in tooltips.
  The choice is remembered; the views use the room it frees.
- **Agents work like you.** They create assets of every kind and add photos (`add_asset_images`) and sound
  (`add_asset_audio`) from files they send, from stills, other assets' photos, frames of clips or a clip's sound, and
  reorder them; update prompts (`update_prompt`); change a sequence's name, defaults and *Exportformat*
  (`update_sequence`), trim takes (`update_segment` `trim_start` / `trim_end`) and export films (`export_film`); stop a
  *Generera saknade* run (`stop_generation_run`); import pictures as stills (`import_still`) and their own films as own
  clips (`import_own_clips`, `get_import`, `cancel_import`); add sound to an edit (`add_edit_audio`), stop a paid job
  (`cancel_edit_job`) and ask to continue a stopped one (`request_edit_operation` with `resume_job_id`); and see what
  runs and what is new (`get_work_status`; `list_generations` filters `unseen_only` and says `seen_by_user`).
  `set_form` takes an end image, and pictures for the form, references, keyframes and boards can be uploads; agents'
  photos and sound clips say who added them (*Tillagd av …*, with the host a file came from). 89 tools in all (35
  read, 45 write, 9 ask for approval).
- **Files from agents as uploads**: `begin_upload` with a URL Studio fetches (public addresses only, plus the agent's
  own machine), with the file's size for a raw `PUT` to the agent port (`curl -T <file> -H "Authorization: Bearer
  <token>" <put_url>`) or inline for files under 700 KB; `get_upload` and `discard_upload`. Pictures (JPG, PNG, WebP,
  HEIC made JPEG; 30 MB, 16 384 px a side, 80 megapixels), sound (MP3, WAV, AIFF, FLAC, OGG, M4A, AAC; 100 MB) and video
  (MP4, MOV, M4V, WebM, MKV; 4 GB), recognised by their bytes and checked like your own files. Uploads show in *Pågår
  och klart* while they come in and live two hours; at most 16 at a time, 8 GB in all and 2 GB left free on the disk,
  also while URLs download. A URL given straight to a content tool is fetched for that call and thrown away after it.
  A `PUT` that stalls for 60 s or takes over 30 minutes is answered `408` and can be sent again (or discarded and
  fetched by URL); one that would leave too little disk is answered `507`.
- **Removals by approval**: `request_delete` asks to remove up to 50 things at once — assets, photos, sound clips,
  prompts, agents' reviews and learnings, sequences, clips, storyboards, boards, a board move that would drop a
  transition with a prompt or takes, videos, takes, stills, edits, versions, *Rensa versioner* — with a dry run first.
  The approval dialog lists them grouped, with pictures and what else changes, checks the request again every 2
  seconds (a request where something changed since the agent asked expires, and the agent can ask again), asks a
  second time when a whole asset, sequence, storyboard or edit or more than 5 things go, plays a sound clip that would
  go, and shows each item's outcome afterwards. No clip, board, take or video of a sequence or storyboard where
  *Generera saknade* runs can be asked for.

- **The agent's presence**: while a connected agent works, the sidebar reads *Agenten arbetar…* with a pulsing dot
  and what it just did, and a small pill at the bottom of the window shows its latest steps; click to open the
  activity drawer.
- **Redigera**, an editor for any finished film (sidebar, after Storyboards): open a clip from the feed (*Redigera…*
  on its card or in its drawer), a take (*Redigera tagningen…*), a sequence's or storyboard's export (*Redigera
  senaste exporten*, *Från en export…*) or your own film (*Öppna en egen film…*, or drop it on the list). Every
  change is a new **version** in `Redigeringar/<name>/` (*v1 Original*, *v2* …, a tree you can step back and forth
  in with ⌘Z / ⌘⇧Z, compare with *Jämför ⇄* and send to a sequence as a new clip or a take); the original is never
  touched. A player with *Markera in / ut*, *Spela markeringen*, frame steps and J/K/L; a timeline with the
  picture and its cut markers (*Klippgränser*), the sound's waveform, added sound layers and the transcript.
  - **Free:** *Behåll bara markeringen*, *Klipp bort markeringen*, *Tona in / ut*, *Volym* (the film, the marked
    range, or only the voice or the background), *Tysta markeringen*, *Ta bort rösten* / *Bara rösten*, *Ta bort
    brus*, *Jämna ut ljudnivån* (−14 / −16 / −23 LUFS), *Lägg till ljud…* (from the library, earlier results or a
    file) and changing or removing a sound layer.
  - **Paid, with the price on the button:** *Transkribera* (editable lines, *Spara undertexter (.srt)*), *Byt röst*
    (speech to speech; shown when Venice lists a voice changer), *Läs in repliker på nytt* and *Ny replik* (a preset
    voice or a character's cloned voice, fitted to the old line with up to 15 % tempo), *Skapa musik* and *Skapa
    ljudeffekt* (on their own layer, music lowered under speech), *Gör om avsnittet* (a range regenerated between
    the frame before and the frame after it), *Ändra med prompt* (Seedance, Gemini, Wan or HappyHorse
    video-to-video), *Förläng* (after the end) and *Uppskala* (2× / 4×, Topaz). Plans are free and show the price
    (`$0.51`, as everywhere in Studio), per-minute billing and Venice's unknown prices before anything is sent; above
    $5, with an unknown price or with a part Venice doesn't price (*≈ $0.45 +*) a second question asks first, and
    after Venice's consent dialog the price you confirmed stays the ceiling. Long voices are cut into as few billed
    minutes as possible and put back sample-exactly; *Byt röst* on chosen lines changes only those lines, also when a
    part spans a line between them. A paid job interrupted by quitting Studio never sends its remaining parts by
    itself: parts already sent are fetched, and the rest waits for *Fortsätt* at a fresh price (the button shows what
    is checked; a price that rose, or a voice clone that has to be made again since the price was shown, is refused
    once and shown). A paid AI take whose finish failed (a full disk) is put into the film again for free with
    *Fortsätt*; one that would fail the same way again is not offered it, and its row can be hidden.
  - *Radera versionen*, *Rensa versioner…* (says how many and how big first) and *Radera redigeringen* keep every
    version a sequence or another edit still uses, hand a transcript to the versions built on it, and keep files in
    the edit's folder that a clip still uses (moved to `Referensbilder/`). *Rensa versioner…* also leaves a version a
    stopped, partly paid job builds on, and *Radera versionen* says what such a job has paid. *Radera* in the clip feed
    follows the same rules (nothing a running or partly paid operation works on, no edit's original), and on a clip's
    or a storyboard transition's takes a film Redigera keeps shows *Ta bort* and only leaves the clip. Versions are named readably in Finder (`Strand v3 – Klippte bort 0m00.5s–0m09s.mp4`). *Jämför* on the
    original compares with the newest version made from it, version rows are buttons (Space and Enter show them when
    reached with the keyboard; after a click, Space still plays), and the *Åtgärder* tabs follow ← → when reached with
    the keyboard.
- **Own clips** (*Egna klipp*): bring your own films into the library and continue them with AI clips. *Lägg till
  klipp* in Sekvenser gets a *Fler sätt* menu (*Eget klipp från fil…*, *Från klippflödet…*, *Från Redigera…*; also on
  the `+` between clips), video files can be dropped between clips, on a clip's takes (*Lägg till tagning från fil…*)
  and on the clip feed (*Importera egna klipp…*). Files are copied into `Egna klipp/<day>/` as an APFS clone where the
  disk allows (APFS only: on exFAT, FAT or HFS+ the space check and the large-copy question count a full copy); HDR,
  10-bit, 4K, variable frame rate, rotated, ProRes, spatial-audio and anamorphic films and films whose sound and
  picture start apart get an H.264 SDR working copy next to the untouched original (mono sound on both sides at full
  level), with progress and *Avbryt* per file. A film already imported is reused. A film of
  another shape than the sequence is fitted with borders or cropped (*Fyll bilden*); the first film in a new, empty
  sequence takes the place of its empty first clip (unless something was put in it while the film was imported). An own clip's card shows *Egen*
  and its title, its clip editor shows what it is (*0:31 · 1080p · 30 bilder/s · ljud · arbetskopia av 4K HDR*) with
  the AI form folded away, and the next clip continues from its last frame (*Fortsätter från sista bildrutan i ditt
  klipp*).
- **Exportformat** per sequence (⋯ in the header): *Automatiskt* (the first clip's size) or 480p / 720p / 1080p.
  Every sequence and storyboard export records where its clips meet (on the film's own frame grid, also when clips
  of different frame rates are mixed), which Redigera shows as cut markers.
- **New voices:** *Skapa röst med AI…* under a character's *Röst* designs a voice from a description and a sample
  text (about $0.35) and adds it as a new clip, marked *Ny*. *Får klonas för nya repliker* on a voice clip allows
  Redigera to clone it for new lines (your consent, per clip; withdrawn, no further line is said in that voice).
- **Voice separation** on the Mac with macOS's own sound isolation, through a small Swift helper built from source
  (`npm run build:helpers`; run first by `dev`, `build` and `app`). *Inställningar* shows whether it is available. A
  separation checks the disk for its scratch files first and is stopped by a watchdog if the helper stalls.
- **The clip feed** gets a *Källa* filter (*Genererade*, *Egna klipp*, *Redigerade*), *Egen* / *Redigerad* /
  *Redigering* badges, titles instead of empty prompts for own clips and versions, and the drawer shows an import's
  original file or the version and edit a film came from (*Öppna i Redigera*).
- **Agent tools for Redigera, own clips and voices** (13 new, 73 tools in all): `list_edits`, `get_edit`,
  `get_transcript`, `plan_edit_operation` (with the frames a picture operation works from),
  `list_audio_models`, `create_edit`, `apply_edit` (free operations), `set_current_version`, `rename_edit`,
  `update_transcript`, `send_edit_to_sequence` and the paid `request_edit_operation` and `request_voice_design`,
  approved in the app (the dialog shows the version, the frames, old → new lines or the lines a change of voice
  changes, the parts and the price — `≈ $X +` when a part has none — and asks for clone consent when it is missing
  and for a second OK above $5 or for an unknown or partial price). `get_edit` and `get_generation` list every
  version's sound layers. `list_generations` filters by `source` and
  returns titles, `get_generation` the recipe and original file, `add_segment` takes `from_generation_id`,
  `get_sequence` marks own clips and shows the *Exportformat*, `list_exports` returns `cuts`, assets show each voice
  clip's `clone_consent`, `review_generation` takes `audio_start`, and `open_in_studio` / `get_workspace` know
  Redigera. The guide has sections on editing films and on own clips. Agents give no clone consent.

- **Descriptions in the prompt.** The descriptions of the characters, places, outfits and poses whose photos or
  voices a generation sends are appended to its prompt automatically when it is sent, as a *References* legend
  with each asset's tokens (`- Anna (@Image1, @Image2; voice @Audio1): …`; `Referenser:` and `röst` with the
  Swedish prompt language). It is composed at send time from the descriptions as they are in the library then, so
  an edited description applies to the next generation, and it is never written into the prompt you edit (*Använd
  igen* can't add it twice). The box **Läggs till i prompten** under the prompt, in Generera and in the clip
  editor, lists the entries live with the asset, its tokens and an excerpt, a switch per asset, *Ta med
  beskrivningar* to switch them all off, *Ändra beskrivning* to open the asset, and the composed length against the
  model's prompt limit; descriptions that would make the prompt too long are shortened at word boundaries
  (*förkortad*), and if not even the names fit, none are appended. Sequence takes, *Generera saknade* and approved
  agent requests compose the same way; continuation and keyframe clips send no references and get no legend.
- **Skickad prompt** in the clip feed's detail drawer: the prompt exactly as Venice got it, the legend set apart,
  with a *Kopiera* button, shown when it differs from the prompt you wrote.
- **Reorder references by drag and drop.** Drag a reference thumbnail, or a voice or sound chip, to another place
  (an insertion marker shows where; every badge shows the number it will get), or focus it and press ⌥← / ⌥→. Its
  `@ImageN` / `@AudioN` changes, and every token in the prompt and the negative prompt is renumbered in the same
  step so it keeps pointing at the same picture or clip: [A, B, C] with `@Image1 hugs @Image3`, C dragged to the
  front, gives [C, A, B] with `@Image2 hugs @Image1`. A picture past the model's limit dragged forward is sent
  instead of the last one, shown live while you drag. Works in Generera and in the sequence clip editor. The tokens
  also follow when an agent reorders a clip's references while you type in its prompt, when *Ångra* brings back text
  an agent replaced, and when *Använd prompt* brings back an earlier take's prompt; near misses such as
  `@Image1-2` or `@Image3rd` keep naming the same pictures in their suggested fixes.
- **Agent tools for descriptions and reordering** (1 new, 47 tools in all): `reorder_references` reorders the
  form's or a clip's references by token, photo or clip id or asset id and renumbers the prompt's tokens.
  `get_workspace`, `validate_prompt` and `get_sequence` return `composed_prompt` and `description_entries`;
  `set_form`, `add_segment`, `update_segment` and `validate_prompt` take `include_descriptions` and
  `excluded_description_asset_ids`; `get_generation` and `review_generation` return `sent_prompt`; `get_workspace`
  lists the pictures past the model's limit (`not_sent`). The approval dialog shows the legend a request appends,
  set apart under the prompt, and a request lapses when a description it appends changes before you approve (the
  dialog says so first, for *Generera saknade* too); an approved request sends exactly the prompt you approved. The
  guide says not to repeat the descriptions in the prompt, but to write the action, camera and mood.
- **Storyboards**, a view of their own next to Sekvenser: mock up a film's milestones as pictures, one per board,
  and generate the clips between them. A storyboard has a name, a format (16:9, 9:16, 1:1, 4:3, 3:4 or 21:9) and a
  row of large boards, each with one picture and a note (*Vad visar bilden?*). A board's picture is made with
  *Skapa bild…* or taken from the library, the storyboard's earlier pictures (which open full size, to be used or
  deleted), an uploaded or dropped file or a frame of any clip (*Bildruta ur ett klipp…*, with ffmpeg); a picture in
  another shape than the storyboard's is marked *Annat format*.
  Boards are reordered by dragging or with ⌥← / ⌥→ and added with **+** before, between or after them (pictures
  dropped on *Ny ruta* become one board each). Between every two neighbouring boards there is a **transition**: the
  clip from the first picture to the second (Seedance image-to-video, 5 s, 480p by default), with *Vad händer?* (and
  *Föreslå*, which fills in a plain template from the two notes), length, resolution, sound, a model that can end on
  a picture, the price, *Generera* and its takes (and a negative prompt an agent set, which can be removed there).
  Moving, inserting or removing a board re-pairs the transitions, asking first when a transition with a prompt or
  takes would go; the takes of transitions that go are kept as ordinary generations. A take made before a board got
  another picture is marked *Tidigare bild* until a take made from the pictures there now is done and takes its
  place; deleting the selected take selects another finished one. The header has *Generera saknade* (every missing
  transition, with the total price once all of them can be made; nothing is paid for while one of them can't be,
  and no take is sent without both of its pictures), *Förhandsvisa*, *Exportera* (one film in `Storyboards/<name>/`, the
  board two transitions share shown once) and, under ⋯, *Gör om till sekvens* (an ordinary sequence with one clip
  and a copy of the selected take per transition), *Öppna mappen i Finder* and *Radera storyboarden*. Files live
  in `Storyboards/<name>/`: `Övergångar/` for the takes, `Bilder/` for the pictures.
- **Skapa bild…**: pictures from Venice's image models — text-to-image, or combining up to the model's limit of
  references (characters, outfits, places, poses, stills; the first is the base picture) — with model, format,
  resolution and quality, a live price on the button (about $0.06 with the default Seedream models) and Swedish
  messages for a low balance, refused content and other errors. For a storyboard board, *Använd föregående bild som
  referens* (on by default) puts the previous board's picture first, for continuity, and the finished picture goes
  onto the board (never over a picture put there meanwhile). Every result is saved as a still of its storyboard
  (`Storyboards/<name>/Bilder/`) or sequence (`Sekvenser/<sequence>/Storyboard/`). Deleting a storyboard moves its
  pictures that nothing else uses to the Trash, as its confirmation says.
- **Bildruta ur ett klipp…**: scrub any finished video in the library, searchable by prompt, and save the exact
  frame as a picture.
- **Säkert läge för bilder** (Inställningar → Bilder, on by default, also switchable in the *Skapa bild…*
  dialog): Venice blurs adult content in the pictures it makes.
- **Slutbild från nästa klipp** (`end_from_next`): a clip can end on the next clip's first frame after its start
  trim, extracted automatically and sent as `end_image_url`, mirroring *Startbild från föregående klipp*. Turning
  it on switches the clip to a model that takes an end image, with the durations and resolutions that model
  offers. The clip editor shows live previews of both frames.
- **Gör om mellan grannarna**, on the timeline cards and in the clip editor: sets a clip up to start exactly on the
  previous clip's last frame and end exactly on the next clip's first frame, with an image-to-video model that takes
  an end image, keeping its prompt, length and sound — so a bad clip in the middle can be redone without touching its
  neighbours. The old take stays selected until you pick the new one (a click in the take strip) and stays among
  the takes. A take picked that was made from a neighbour's frame starts
  untrimmed at that end, so an old trim can't cut the matched frame away, and a neighbour that continued from the
  old take isn't flagged as out of date: the cut counts as seamless when either side was made from the other.
- **Agent tools for storyboards** (13 new, 60 tools in all): `list_storyboards`, `get_storyboard`,
  `preview_transition` (both pictures and the price), `create_storyboard` (with one note per board),
  `update_storyboard`, `add_board`, `update_board`, `move_board`, `delete_board`, `update_transition`,
  `convert_storyboard_to_sequence` and the paid `request_transition_generation` and `request_generate_storyboard`
  (approved in the app; the dialog shows the two board pictures side by side, the prompt and the price).
  `request_image_generation` takes `assign_to: {board_id}`, `previous_board_as_reference` and `storyboard_id`;
  `list_stills`, `get_still`, `save_frame_as_still` and `list_exports` take storyboards; `get_generation`,
  `review_generation` and `review_export` know transitions and storyboard films; `write_video_prompt` takes
  `transition_id`; `open_in_studio` opens a storyboard and `get_workspace` says which one is open. The guide has a
  Storyboards section: plan the milestones as boards, make each picture with references (and the previous board's
  picture for continuity), write each transition as the motion from picture A to picture B, review, regenerate.
- **Agent tools for keyframes and stills** (7 new, 46 tools in all): `list_image_models`, `list_stills`,
  `get_still`, `preview_segment_frames`, `save_frame_as_still`, `bridge_segment` and the paid
  `request_image_generation` (approved in the app like a video; the dialog shows the references and the finished
  picture). `get_sequence`, `add_segment` and `update_segment` know notes, start and end images and
  `end_from_next`; `update_segment` can select a take; `list_image_models` says whether *Säkert läge för bilder* is
  on. The guide has a section on replacing a clip between its neighbours.
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

- A new app icon: a camera aperture of six blades in sunset colours (pink, coral, orange) in a lens ring, on the dark
  background (`build/icon.svg`, with `icon.png` and `icon.icns` rendered from it).
- The whole interface is now in English (it was Swedish). Library folder names on disk are unchanged; prompts can
  still be sent in Swedish (Settings → Generation → Prompt language).
- **One list on the left, the same everywhere, and Redigera has it too**: Karaktärer, Miljöer, Produkter, Kläder,
  Poser, Sekvenser, Storyboards and Redigera share one side list (`SideList`) – the view's name with *＋ Ny …*, a
  search field that is always there (⌘F; names, plus the descriptions in the library kinds and where a film came
  from in Redigera; *Inga träffar för ”…”* with *Rensa sökningen*), rows of one height with the picture, the name,
  one line and what runs or is new, ↑ / ↓ between the rows and Enter to open one. ✕ on a row (hover or keyboard
  focus) asks in the row – *Radera ”Anna”?*, one line on what goes and what stays, *Radera* / *Avbryt* – and shows an
  error there; the open item gives way to the row that takes its place, and a search stays as it was. Sekvenser's ✕
  no longer asks twice. In Redigera the edits are always listed on the left: one opens beside the list, and with
  none open (*‹ Redigeringar*, or deleting the open one) the overview *Alla redigeringar* is there, with *Kort* /
  *Tabell* as before (the table keeps poster, name, length and status in a narrow window); *＋ Ny redigering* offers
  an own film, a clip from the feed or an export, and *Markera alla som sedda* moved under the list's heading. The
  workspace's right column narrows to 320 px in a small window so the player keeps room.
- **"Nämns inte" only for references without an automatic description**: a reference whose description (or, for an
  outfit, wearer) the legend appends is no longer warned about when the prompt doesn't name it; the reference list
  marks it *beskrivs*. The same goes for the agents' `issues` and the approval dialog.
- **The outfit chip's *bärs av* is saved** with the form, a sequence clip and the generation (`outfitWearers` in the
  params), so *Använd igen* and the clip editor bring it back; *Byt kläder* carries it to the new outfit.
- **Generera lists this session**: the right side of Generera shows what was made there since Studio started (and
  clips that were still being made when it started); closing the window keeps the session, quitting ends it. Everything older is in the
  Mediabank. *Pågår och klart* counts Generera's clips from an earlier session, and pictures that belong to no
  sequence or storyboard, under the Mediabank. Agents: `list_generations({session: true})` lists exactly Generera's
  list (with `session_started`), `get_work_status` takes `view: "media"`, and `open_in_studio` opens a clip that
  isn't in Generera's list in the Mediabank instead (`shown: "media"`). Removal requests say that the takes of a
  removed sequence, clip, storyboard or board become ordinary clips in the Mediabank.
- **Ratings are tumme ner or one to three stars** (was 1–5), for your own rating and agents' reviews: 👎 ★★★ on
  cards, in the table and the drawer (click the set grade to clear it; arrow keys, 1–3, − and Delete work too). The
  *Betyg* filter offers ★★★, ★★ eller mer, ★ eller mer, *Tumme ner* and *Ej betygsatt*; sorting by rating puts tumme
  ner after one star. The library database is migrated to version 13, which converts existing ratings (1–2 → tumme
  ner, 3 → ★, 4 → ★★, 5 → ★★★) and adds the clips' continuation mode. Agents: `add_review` takes `rating` -1 or 1–3;
  `list_generations` and `list_reviews` take `min_rating` 1–3 and a new `thumbs_down`.
- **A tidier sidebar bottom and Inställningar**: Pågår och klart and the agent connection are two slim status rows
  above a divider, with Inställningar last; Inställningar is split into sections (Venice, Generering, Bibliotek,
  Export och import, Agentanslutning, Verktyg, Om Studio) with a navigation that follows the scroll; an agent whose
  MCP client only calls itself "mcp" is shown as *Agenten* in the log, the dialogs, notifications, reviews and Pågår
  och klart.
- The library database is migrated to version 12: `unseen` (finished work you haven't looked at; empty at first, so
  an existing library starts with everything seen), `take_trims` (each take's own trims) and an `origin` on asset
  photos and sound clips. From this version `Produkter` belongs to the library; an older library whose base folder
  already holds a folder of your own named *Produkter* is not opened until it is renamed, and an older Studio refuses
  a migrated library.
- Sekvenser's clip pane is the chosen take's player (smaller, so the strip fits under it), the take strip, then the
  trims; the take grid with its players and *Välj* buttons and the take list at the bottom of the transition editor
  are gone. *Ingen tagning är vald. Klicka på en tagning för att använda den i sekvensen.*
- The pulsing "running" dots in the lists, the timeline and the headers are spinners; *Generera saknade* says how far
  it got (*Klipp 2 av 5*). Redigera's list shows the job (*Skapa musik 40 %*), free renders included.
- The headers of Sekvenser, Storyboards and Redigera adapt to the width of the content area rather than the window,
  so a folded sidebar gives them their wide layout sooner. The agent drawer and the status panel open next to the
  sidebar at its current width, one at a time, and the agent's pill hides while either is open.
- What agents may do (the guide, the tool descriptions and *Inställningar → Agentanslutning* say so): everything in
  the library and the views except settings, the library folder, consents, approving, marking things seen, your own
  ratings and learnings and saving files through a dialog; every removal by approval. `add_board` between two boards
  whose transition has a prompt, a negative prompt or takes is refused (add it last and ask for the move), and so is
  a `move_board` that would drop one; Studio itself refuses such a change from an agent too. `open_in_studio` opens a
  clip's drawer, a transition, a version, an asset or the prompt library without marking anything seen;
  `get_workspace` knows Produkter; `get_approval` reports a removal's outcomes.
- Handlers that take file paths accept only files an agent uploaded or files the library records when an agent
  calls them (photos and sound for assets, own clips, edit audio, stills, keyframes and board pictures).
- The agent server has no overall request timeout any more (uploads of large videos take long); an `/mcp` body must
  arrive within 60 seconds.

- The sidebar says *Agent ansluten* (or *2 agenter anslutna*) instead of the client's own name, which can be
  something technical like "mcp"; the name is in the tooltip and the activity drawer.
- The library database is migrated to version 11: generations get a `source` (existing ones are `generated`), a
  title, a parent version, an edit, a recipe and an original file; new tables hold edits, their audio, paid jobs
  and their steps, transcripts and voice clones; voice clips get a clone consent, exports their cut times and
  sequences an *Exportformat*. From this version `Egna klipp` and `Redigeringar` belong to the library; an older
  library whose base folder already holds a folder of your own by either name is not opened until it is renamed.
- *Städa upp* follows a file home rule: own clips stay in `Egna klipp/<day>/` (also when they are takes), versions
  and AI takes of an edit in its `Redigeringar/` folder; neither is ever renamed "… Utan prompt" or moved into a
  sequence's `Tagningar/`. Deleting an own clip also moves its original to the Trash, unless a copy in another clip
  still uses it.
- *Använd igen* (feed) and *Använd prompt* (takes) are hidden for own clips and versions, which have no prompt.
- `npm run dev`, `dev:real`, `build` and `app` build the voice separation helper first (skipped when up to date or
  without the Swift compiler); CI builds and probes it.
- `media://` also serves `.m4v` and `.mkv` films.
- Contributing: a new `editor` commit scope covers Redigera.

- **Storyboards moved out of Sekvenser** into their own view, as a workflow of their own (milestone pictures with
  the clips between them generated; see *Added*). Sekvenser no longer has the *Tidslinje / Storyboard* switch, the
  panel grid or the stills strip; its timeline, clip editor, notes and keyframe controls (*Startbild från
  föregående klipp*, *Slutbild från nästa klipp*, *Gör om mellan grannarna*) stay. Sequences and storyboards are
  separate lists, in the app and for agents (`list_sequences` and `get_sequence` leave storyboards out and point to
  the storyboard tools). Agents' `tools/storyboard.ts` is now `tools/stills.ts`.
- The clip feed marks every take as *Tagning* (the filter is *Tagningar*): the badge opens the sequence clip or
  storyboard transition it belongs to, and the detail drawer names it (*Klipp 3 i …*, *Övergång 2 i …*).
- The library database is migrated to version 10: sequences get a `kind` (existing ones stay sequences) and
  storyboards an aspect ratio, `storyboard_boards` holds the boards and clips can belong to a storyboard as its
  transitions. From this version `Storyboards` belongs to the library; an older library whose base folder already
  holds a folder of your own named *Storyboards* is not opened until it is renamed.
- The library database is migrated to version 9: `generations.sent_prompt` keeps the prompt as it was sent (with
  the descriptions legend); `prompt` stays the text you wrote.
- Reference images past the model's limit are marked *skickas inte* in the reference strip instead of getting an
  `@ImageN` that would not be sent; the strip only lights up as a drop target for drags that carry files, and only
  while there is room (files dropped never push out pictures already there); a thumbnail's ✕ can be reached with
  the keyboard.
- `set_references` (agents): its description says that replacing the references doesn't renumber the prompt and
  points to `reorder_references`, which does.
- The library database is migrated to version 8 (`end_from_next` and `notes` on clips, `stills`). Stills follow
  sequence renames, library moves and *Städa upp*; deleting a sequence keeps the stills other clips or generations
  still use (in `Referensbilder`) and moves the rest to the Trash.
- *Generera saknade* makes the clips in the order their frames allow (a clip that ends on the next clip after that
  clip) and stops before paying for anything when two clips wait on each other; agents' *generate all* requests
  list the clips in that order.
- A new clip no longer copies the previous clip's start and end image.
- The clip editor's *Fortsätt från föregående klipp* switch is now *Startbild från föregående klipp*, next to
  *Slutbild från nästa klipp*, both with a live preview of the frame.
- An end image is only sent to models known to take one (`supportsEndImage`): Seedance image-to-video, Kling V3/O3
  image-to-video, first-last-frame and transition models. The Generate form shows the end image for those.
- The library database was migrated to version 7 (`asset_audio`, `generation_reviews`, `learnings`). From this version
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
  capability, and for a CHANGELOG entry; a new `images` commit scope covers stills and the image models. The
  development guide shows how to test voices, reviews, pictures and the exact request body without spending money,
  and how to check frames exactly.

### Fixed

- The model lists follow Venice while Studio stays open: a window kept its first list of video and image models
  until it was closed, so models Venice added or retired never showed up. Both lists are now fetched again once
  they are ten minutes old (when a view opens, or the window comes back to the front); if Venice can't be reached
  meanwhile, the last list stays.
- Full screen from a clip card's player (Generera, the Mediabank) no longer closes at once: the card kept its player
  only while the pointer was over it, and going full screen counts as leaving.
- The agent's presence pill no longer re-renders in a loop while an agent works.
- A picture that failed after its *Skapa bild…* dialog was closed is no longer lost: it shows in *Pågår och klart*
  and on its board.
- A free render in Redigera now shows the edit as running.
- An agent's `add_board` between two boards no longer drops the transition between them, with its prompt or takes,
  without your OK.
- A *Generera saknade* run (of a sequence or a storyboard) that stopped on a problem is no longer silent once its view
  is closed: the problem stays in *Pågår och klart* and on the sequence.
- Choosing another take and then the first one again no longer changes the first one's trims.

- Pictures sent to Venice (start and end images, references) are turned upright by their EXIF orientation, as
  Studio shows them, so a portrait phone photo no longer gives a sideways (or rotated) clip; WebP pictures are
  decoded and sized like the others.
- The export drops a frame at a cut only where a take was actually made from its neighbour's frame; a clip whose
  take was made otherwise (continuation switched on afterwards, an old take kept) keeps its first and last frames.
- Exports no longer show a frame twice after cuts whose trims fall between two frames (trims come in 0.1 s steps):
  each clip's sound is now cut to exactly the frames its picture keeps, so sound and picture stay together across
  every cut.
- Search fields in popovers (asset, outfit, prompt and sequence pickers) get the focus when the popover opens.

### Removed

- The agent tools `delete_segment`, `delete_board`, `delete_review` and `delete_learning`: every removal by an agent
  goes through `request_delete` and your approval.

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
