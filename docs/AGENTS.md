# Connecting your own agent (MCP)

Studio can run a [Model Context Protocol](https://modelcontextprotocol.io) server so that AI agents you run
yourself — for example OpenClaw, Hermes Agent, Claude Desktop or Claude Code — can work in the app alongside you,
doing nearly everything you can. An agent can read the library, look at its photos and listen to its voices,
create characters, environments, **products**, outfits and poses and give them photos and sound, write and save
prompts, choose reference images and voice clips, fill in the Generate form, build sequences — notes per clip, start
and end images (keyframes), stills, trims, the *Exportformat* — and export them, set a bad clip up to be redone
between its neighbours, and plan films as storyboards: the milestones as boards with notes and pictures, and the
prompts of the transitions generated between them. Files reach Studio as **uploads**: a URL Studio fetches, a raw
`PUT` of the file, or a small file inline — never as a path on your Mac. An agent can also look back at what the
generations became — frames of finished clips and exported films next to the references they were made from, and
their sound — record reviews, and save *learnings* (*Lärdomar*) that every later session reads before it writes a
prompt. It can change a finished film in **Redigera** — a clip, a take, an exported film or footage it imported —
into new versions: free cuts, fades and sound fixes right away, and paid voice, music and picture operations once
you approve them. It can see what Studio is working on and what you haven't looked at yet (*Pågår och klart*).
Everything an agent prepares, plans, uploads, reviews or records is free.

**An agent can never spend money or remove anything on its own.** The eight paid tools and `request_delete` only
create an *approval request*. Studio shows it to you — with the prompt, the reference images, the voices and the
price, or with everything that would be removed and what depends on it — and nothing is sent to Venice or removed
until you click *Godkänn och generera* (approve and generate) — *Godkänn och skapa* for a picture or a voice,
*Godkänn och kör* for an edit, *Godkänn och ta bort* for a removal.

- [Enabling the server](#enabling-the-server)
- [Addresses and token](#addresses-and-token)
- [Client configuration](#client-configuration)
- [Tools](#tools)
- [Sending files to Studio](#sending-files-to-studio)
- [Deleting](#deleting)
- [What is running and what is new](#what-is-running-and-what-is-new)
- [The approval flow](#the-approval-flow)
- [Prompt-writing guidance](#prompt-writing-guidance)
- [Reviews and learnings](#reviews-and-learnings)
- [Troubleshooting](#troubleshooting)

## Enabling the server

1. Open **Inställningar → Agentanslutning** (Settings → Agent connection).
2. Switch on **Tillåt agenter att ansluta** (allow agents to connect). It is **off by default**, and the setting is
   per profile: Studio Dev and Studio.app each have their own switch, port and token.
3. The status line shows where Studio listens. The agent row at the bottom of the sidebar reads *Agent ansluten*
   when an agent is connected (a client that only calls itself "mcp" is shown as *Agenten*; its technical name is in
   the drawer as "via MCP · klient: …"). While the agent works — a tool call within the last 12 seconds — it reads
   *Agenten arbetar* (or the agent's own name) with a pulsing dot and the latest step, and a small pill at the bottom
   of the window shows the same. Click either to open the activity drawer with every tool call and the pending
   requests.

The first time Studio listens on the Tailscale address, the macOS firewall may ask whether to allow incoming
connections — answer *Allow*.

## Addresses and token

The server speaks **MCP over Streamable HTTP** at the path `/mcp`, on port **8770** unless you choose another one
(1024–65535) in the same section. It listens on exactly these addresses and never on your LAN or `0.0.0.0`:

| Address | For |
| --- | --- |
| `http://127.0.0.1:8770/mcp` | Agents running on the same Mac. |
| `http://100.x.y.z:8770/mcp` | Agents on other devices in your [Tailscale](https://tailscale.com) tailnet (this Mac's Tailscale IPv4). |
| `http://<your-mac>.<tailnet>.ts.net:8770/mcp` | The same, by MagicDNS name, when Studio can resolve it. |

Settings shows the actual addresses with copy buttons. Traffic is plain HTTP: loopback never leaves the Mac, and
Tailscale traffic is encrypted by WireGuard.

Every request needs Studio's token:

```
Authorization: Bearer <token>
```

The token is a random 256-bit value, stored encrypted in the macOS Keychain. Show, copy or replace it in the
**Token** field. Replacing it (*Byt token…*) disconnects every connected agent and expires their pending requests.

Optionally, send `X-Studio-Agent-Name: <name>` to choose the name Studio shows in the activity log and the approval
dialog (otherwise it uses the name the MCP client reports, which may be generic).

## Client configuration

Settings → Agentanslutning shows ready-made snippets for OpenClaw and Hermes Agent with your address, and its copy
buttons include the real token. The examples below use placeholders: replace `<token>` and the URL. Treat the token
like a password and keep it out of files you commit or share.

### OpenClaw

Merge into OpenClaw's configuration under `mcp.servers`:

```json
{
  "mcp": {
    "servers": {
      "studio": {
        "url": "http://100.x.y.z:8770/mcp",
        "transport": "streamable-http",
        "headers": {
          "Authorization": "Bearer <token>",
          "X-Studio-Agent-Name": "OpenClaw"
        }
      }
    }
  }
}
```

### Hermes Agent

Hermes Agent connects over HTTP as well. Add the server to its configuration (YAML); check Hermes's documentation
for the exact key, which may differ between versions:

```yaml
mcp_servers:
  studio:
    url: "http://100.x.y.z:8770/mcp"
    headers:
      Authorization: "Bearer <token>"
      X-Studio-Agent-Name: "Hermes"
```

### Claude Code

Claude Code supports remote HTTP servers with headers directly:

```bash
claude mcp add --transport http studio http://127.0.0.1:8770/mcp \
  --header "Authorization: Bearer <token>" \
  --header "X-Studio-Agent-Name: Claude Code"
```

Or in a project's `.mcp.json`, reading the token from the environment so it is never committed:

```json
{
  "mcpServers": {
    "studio": {
      "type": "http",
      "url": "http://127.0.0.1:8770/mcp",
      "headers": {
        "Authorization": "Bearer ${STUDIO_MCP_TOKEN}",
        "X-Studio-Agent-Name": "Claude Code"
      }
    }
  }
}
```

### Claude Desktop

Claude Desktop's configuration file starts local (stdio) servers, so bridge to Studio with
[`mcp-remote`](https://www.npmjs.com/package/mcp-remote). In
`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "studio": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "http://127.0.0.1:8770/mcp",
        "--transport", "http-only",
        "--header", "Authorization:${STUDIO_AUTH}",
        "--header", "X-Studio-Agent-Name:Claude"
      ],
      "env": { "STUDIO_AUTH": "Bearer <token>" }
    }
  }
}
```

`mcp-remote` only allows plain `http://` for `localhost`/`127.0.0.1`; to reach Studio over Tailscale from another
Mac, use the `100.x.y.z` or `.ts.net` URL and add `--allow-http`. Restart Claude Desktop after editing the file.

### Any other MCP client

Any client that supports **Streamable HTTP** with custom headers works: point it at the URL and send the
`Authorization` header. Clients that only support stdio can use `mcp-remote` as above. Browser-based clients cannot
connect (see [Troubleshooting](#troubleshooting)).

## Tools

Studio offers **89 tools** — 35 that read, 45 that write (free) and 9 that only ask for your approval (8 paid ones
and `request_delete`) — plus one prompt and one resource. Tool errors come back as readable tool errors; their
messages are in Swedish, like the app's UI. Tools that touch the library fail with an explanation until a library is
open, and the tools that read or fill the Generate form need the Studio window to be open. No tool takes a file path:
files come as uploads (see [Sending files to Studio](#sending-files-to-studio)) or as ids of what the library holds.

| Area | Read | Write | Asks for approval |
| --- | --- | --- | --- |
| Guide and library (`tools/library.ts`) | `get_studio_guide`, `get_prompt_blocks`, `list_assets`, `get_asset`, `list_models`, `list_prompts`, `list_generations`, `get_generation` | `create_asset`, `update_asset`, `update_asset_audio`, `add_asset_images`, `reorder_asset_images`, `add_asset_audio`, `reorder_asset_audio`, `save_prompt`, `update_prompt` | |
| Generate form (`tools/form.ts`) | `get_workspace`, `validate_prompt` | `set_form`, `set_references`, `reorder_references`, `open_in_studio` | |
| Sequences (`tools/sequences.ts`) | `list_sequences`, `get_sequence` | `create_sequence`, `update_sequence`, `add_segment`, `update_segment`, `move_segment`, `export_film`, `stop_generation_run` | |
| Stills and keyframes (`tools/stills.ts`) | `list_image_models`, `list_stills`, `get_still`, `preview_segment_frames` | `save_frame_as_still`, `bridge_segment`, `import_still` | |
| Storyboards (`tools/storyboards.ts`) | `list_storyboards`, `get_storyboard`, `preview_transition` | `create_storyboard`, `update_storyboard`, `add_board`, `update_board`, `move_board`, `update_transition`, `convert_storyboard_to_sequence` | |
| Approvals (`tools/paid.ts`) | `get_approval` | | `request_generation`, `request_segment_generation`, `request_generate_all`, `request_transition_generation`, `request_generate_storyboard`, `request_image_generation` |
| Redigera (`tools/editor.ts`, `tools/editor-paid.ts`, operations in `tools/edit-input.ts`) | `list_edits`, `get_edit`, `get_transcript`, `plan_edit_operation`, `list_audio_models` | `create_edit`, `apply_edit`, `set_current_version`, `rename_edit`, `update_transcript`, `send_edit_to_sequence`, `add_edit_audio`, `cancel_edit_job` | `request_edit_operation`, `request_voice_design` |
| Reviews and learnings (`tools/review.ts`) | `review_generation`, `get_frames`, `list_exports`, `review_export`, `review_sequence`, `list_reviews`, `list_learnings` | `add_review`, `save_learning`, `update_learning` | |
| Uploads (`tools/uploads.ts`) | `get_upload` | `begin_upload`, `discard_upload` | |
| Own clips (`tools/imports.ts`) | `get_import` | `import_own_clips`, `cancel_import` | |
| Removing things (`tools/delete.ts`) | | | `request_delete` |
| Status (`tools/work.ts`) | `get_work_status` | | |
| **Total (89)** | **35** | **45** | **9** |

**Images and sound.** Tools that return media send pictures as MCP image content (JPEG) and sound as MCP **audio
content** (MP3, mono), each preceded by a text label that says what it is (`Reference @Audio1 = Anna's voice
(window 0–8 s)`, `t = 2.4 s – frame 3 of 6`). Sound is only sent when asked for — `include_audio` on `get_asset`,
`review_generation` and `review_export` (up to 30 s, from `audio_start` on the last two), or `audio_id` on
`get_asset` — because it is large. Audio content arrived
with MCP protocol version 2025-03-26: Studio reads the version from the client's `initialize` request (and the
`MCP-Protocol-Version` header), and a client on an older version gets a one-line note that the sound was left out
instead of content it would reject. Whether an agent can actually listen depends on its client and model; the
frames, reference images and text work without it.

### Read (35 tools; change nothing)

| Tool | What it does |
| --- | --- |
| `get_studio_guide` | How Studio works and how to write video prompts for it (voices, poses and the review loop included), ending with the learnings recorded so far. Read once at the start of a session. |
| `get_prompt_blocks` | The building blocks the user inserts into prompts with **/** and the chips under every prompt field: a scene template, framing, camera, light, style, motion and sound (video), framing, light and style (pictures), things to avoid (negative prompts), music and sound effects. Swedish label + the English text it inserts; `context` filters by field. Use the same wording in prompts you write. |
| `get_workspace` | What the user is looking at (view — `generate`, `sequences`, `storyboards`, `editor`, `prompts`, `settings` or a library view: `characters`, `environments`, `products`, `outfits`, `poses` —, open sequence and clip, open storyboard, or the edit open in Redigera: view `editor`, `edit_id`, `edit_name`) and the Generate form: mode, model, settings, prompt, reference token maps (`@ImageN` and `@AudioN`), pictures past the model's limit (`not_sent`), `composed_prompt` (the prompt as it is sent, with the References legend of the referenced assets' descriptions) and `description_entries`, validation issues, price. |
| `list_assets` | Characters, environments, products, outfits and poses with ids, descriptions, photo ids, default outfits and — for characters and environments — their audio clips (`audio_id`, role `voice` or `soundscape`, duration, reference window `clip_start` / `clip_length`; for a character's voice `clone_consent`, whether you allow cloning it for new lines); optional `kind` and `query` filters. `get_asset` shows the same per clip. Photos and clips an agent added carry `added_by` (`{agent, host?}`). |
| `get_asset` | One asset with its photos as images (JPEG, at most 768 px; `max_images` 1–12, default 4), each labelled with its photo number and `image_id` (and `added_by` when an agent added it); for an outfit, the characters wearing it by default. With `include_audio` (the first clip, or the one named by `audio_id`) also a clip's reference window as MP3 audio, exactly as Venice would get it. |
| `list_models` | Venice's usable video models (optionally one `kind`) with mode, durations, resolutions, aspect ratios, reference image limit, whether they take reference audio (`audio_input`, `max_reference_audios`), audio and prompt length limit, and for image-to-video models whether they take an end image (`supports_end_image`); the default model is marked. |
| `list_prompts` | The prompt library, favourites first. |
| `list_generations` | Generations filtered and sorted like Studio's clip feed (`query`, `status`, `model`, `asset_id`, `min_rating` (1–3 stars; tumme ner never passes), `thumbs_down`, `unrated`, `since_days`, `placement`, `has_reviews`, `source` — *Källa*: `generated`, `import` (own clips, and copies of exported films opened in Redigera, marked `recipe.export`) or `edit` — `sort`, `limit` 1–50 default 20, `offset`), each with its `source`, `title` (an own clip's file name, a version's "<redigering> v3"), `parent_id` and `edit_id` where they apply, status, prompt, settings, price, the user's rating (-1 = tumme ner, 1–3 stars), review count, a reference summary and — for finished and failed rows — `seen_by_user` (whether you have played or opened it yet; `unseen_only` lists only the new ones), plus totals for the filtered set. |
| `get_generation` | One generation with its source fields, the `recipe` of an own clip or a version (how it was made: the operation, its base version, its cost, its added sound `layers`; for an import the file name and why a working copy was made; for a copy of an exported film `export`) and `original_path` (an import's untouched original next to its working copy), its token maps, `sent_prompt` (what Venice got, when descriptions were appended), the sequence clip or storyboard transition it is a take of (with the boards it goes between), the user's rating and every review, `seen_by_user`, its poster frame and optionally up to 6 `frames` from the video. |
| `list_sequences` | Sequences with clip count and the length of the current cut. Storyboards are not listed (a note points to `list_storyboards`). |
| `get_sequence` | One sequence (a storyboard's id is refused with a pointer to `get_storyboard`) with its clips, its number of stills, its `defaults` (what new clips start from) and its `export_height` (the *Exportformat*, null = the first clip's own size; `update_sequence` changes both); each clip with its `notes`, token maps, `composed_prompt` and `description_entries`, `start_image` / `end_image` (`{kind: "previous" \| "next", from_clip}`, `{kind: "image", still_id \| asset_image_id, path}` or null), `continue_from_previous`, `end_from_next` — a continuing clip also has `continue_mode` (`references` or `exact`), `sent_as` (how its take goes now; `continue_mode_note` says why it differs or doesn't apply) and, in reference mode, `carried_references` (`from_clip`, `inherited`, the `references` / `audio_references` it sends and `start_frame_token`, the previous clip's last frame sent after them; `not_sent` when a reference gives way for it); its `composed_prompt` includes the instruction to start on the frame —, `supports_end_image`, validation issues, `frame_problems` (why its neighbours' frames can't be had yet) and selected take (with its `source`; `own_clip: true` when it is your own film or a version from Redigera); poster frames with `include_thumbnails` (default true). |
| `validate_prompt` | Checks a prompt's `@ImageN` and `@AudioN` tokens (and the audio windows) against the form's references or a given set — the same check Studio applies before every paid generation — and answers with `composed_prompt` and `description_entries` (`include_descriptions` / `excluded_description_asset_ids` try other switches), measured against the model's `prompt_character_limit`. |
| `get_approval` | The state of an approval request: `pending`, `approved` (with `generation_ids`, or for an image request the `still_id` and whether it was put into its clip; for an edit the edit, base version, operation — or the `resume_job_id` it continues —, the job's progress and then `result_version`; for a designed voice the new clip's `audio_id`; for `request_delete` every item with its outcome, `deleted`, `gone` or `failed` with the error), `declined`, `expired` (also: something in a removal changed before you answered) or `failed` (a removal where nothing could be removed keeps its items' outcomes). |
| `list_image_models` | Venice's image models for `request_image_generation`, with the price of one picture: text-to-image models (prompt only) and models that combine up to `max_input_images` references; the Seedream defaults are marked. Also says whether *Säkert läge för bilder* is on (`safe_mode`: Venice blurs adult content; only you can switch it, under Inställningar → Generering → Bilder). |
| `list_stills` | The stills of a sequence or a storyboard (`sequence_id` or `storyboard_id`; or all), newest first: generated pictures, uploaded pictures and saved frames, each with its prompt, model, references and `used_by` (the sequence clips using it as start or end image and the storyboard boards showing it); small thumbnails with `include_thumbnails` (default true). |
| `get_still` | One still as an image, with its settings and the clips and boards that use it; with `include_references` also the pictures it was made from (the base first). |
| `preview_segment_frames` | The start and end image a clip would be generated from right now — the previous clip's last frame and the next clip's first frame (with the time in that take), or the clip's own keyframes — as images, plus why it can't be generated yet. |
| `list_storyboards` | Storyboards, most recently changed first, with their number of boards and transitions and how many transitions have a finished take. |
| `get_storyboard` | One storyboard: its format, the boards in order with their notes ("Vad visar bilden?") and pictures (a still or a library photo; `aspect_mismatch` when its shape differs from the storyboard's), and the transitions between them with the boards they join, prompt, settings, `ready` / `problems`, takes and the selected take (`made_from_earlier_pictures` when a board's picture changed since). With `include_images` (default true) the board pictures and the selected takes' poster frames come as images. |
| `preview_transition` | The two pictures a transition goes between — the first board's (its start) and the next board's (its end) — as images, with the boards' notes, the transition's prompt and settings, whether it is ready and its price. |
| `review_generation` | What a finished generation (or an own clip, or a version from Redigera) became: prompt (or source, title and recipe), settings, token maps, price, the user's rating and all reviews, `frames` frames evenly spaced from the first to the last (1–12, default 6; JPEG 512 px wide, captioned "t = 2.4 s"), the reference images (or start and end image — for a storyboard transition the two board pictures) it was made from (`include_references`, default true), and with `include_audio` its sound (up to 30 s from `audio_start`) and the reference voice windows as MP3. Ends with a review checklist (for a transition also whether it starts on the first picture and ends on the second) and the suggested tags. |
| `get_frames` | Frames of a generation (`generation_id`) or an exported film (`export_id`) at up to 12 given times (times past the end give the last frame), `width` 256–768 px (default 512). |
| `list_exports` | Exported films of sequences and storyboards, newest first (optionally of one `sequence_id` or `storyboard_id`; `limit` default 20), with the sequence or storyboard, file, date, length, `cuts` (where the clips meet, recorded at export; older films have none) and whether the file still exists. |
| `review_export` | A whole exported film (of a sequence or a storyboard): when it still matches its sequence or storyboard, the clips (a storyboard's transitions) with their place in the film, `frames_per_clip` frames inside each clip (1–4, default 2) and the last frame before and first frame after every cut (`include_cut_frames`), at most 24 frames; otherwise evenly spread frames and a note why the cuts are unknown. With `include_audio`, up to 30 s of its sound from `audio_start`. |
| `review_sequence` | A sequence clip by clip: prompt, references, continuation, the selected take's rating and review count, and `frames_per_clip` frames of it (2–6, default 3; first and last frame included, within the trims; at most 30 frames in all), plus continuity hints for every cut. |
| `list_reviews` | Reviews by the user (author `user`) and agents, most recently changed first (for one generation: the user's first), filtered by `generation_id`, `author`, `tag`, `min_rating` (1–3) or `thumbs_down`; outside a single generation each comes with that generation's prompt and model. |
| `list_edits` | The edits in Redigera, newest first: origin (a clip from the feed, a take, an export or an own film), current version, number of versions, length, whether a paid job runs and the cost so far. |
| `get_edit` | One edit: the version tree (`version_id`, `parent_version_id`, the operation, its cost, which sequence clips use it, its added sound `layers` with `layer_id`), the current version, the paid jobs (progress, errors), AI takes, the edit's audio media (`media_id`), and for the current version its cut markers (*Klippgränser*), its layers and muted spans as the timeline draws them and a transcript summary; whether this Mac separates voice and background and whether Venice lists a voice changer; poster frames with `include_thumbnails`. |
| `get_transcript` | A version's (or any generation's) transcript lines (`segment_id`, start, end, text) as JSON, or as SubRip with `format: "srt"`; an inherited one names `inherited_from`. |
| `plan_edit_operation` | Checks an operation on a version exactly as Redigera's cards do and says what it would do and cost, without doing it: the normalized operation (range snapped, defaults filled), `paid`, `price_usd`, `partial_price` / `price_note`, the parts, notes, warnings and problems — and for picture operations the frames it works from as images (`regenerate`: the frame before and after the range, or the film's first frame for a range at 0; `extend`: the film's last frame; `prompt_edit`: the first and last frame of the range; `upscale`: none). Free (it may ask Venice for free quotes). |
| `list_audio_models` | Venice's speech, music, effect, transcription, voice-changer and voice-design models with voices, limits and prices, the default models, and whether this Mac can separate voice and background. |
| `list_learnings` | The learnings so far, pinned first, then the most recently changed; filters `query` (every word in the title, insight, model or tags), `model` (that model's plus the general ones), `tag`, `author`; `limit` default 50. Also tells the agent the name its own reviews and learnings are recorded under (`your_name`). |
| `get_upload` | One upload: status (`receiving` — waiting for the agent's `PUT`, with `error` when the last one broke off or was stopped —, `downloading`, `checking`, `ready`, `failed` with the error), kind, `mime` (what the bytes are), file name, size, bytes received, SHA-256, a picture's width and height, a sound's duration, a video's duration, size, fps and `working_copy_reasons`, `from_host` for a fetched file, and `expires_at`; a ready picture (or a video's frame) as a small image unless `include_preview: false`. |
| `get_import` | How an `import_own_clips` import is going: `running`, `done` or `failed`, each file's progress and error, and once done the `generation_ids`, `segment_ids` and errors. Kept for two hours. |
| `get_work_status` | What Studio is doing right now and what has finished that the user hasn't looked at yet — the window's *Pågår och klart*: `running` (videos at Venice with progress and `eta_seconds` or `usually_takes_seconds`, takes being sent, *Generera saknade* runs, pictures being made, Redigera jobs and renders, exports, imports, approved requests being carried out and uploads; each with its label, phase, start, `via` — the agent it was done for — and ids), `unseen` (finished and failed videos, versions, pictures, exports and voices nobody has looked at, newest first) and `counts` (in all and per view). `view` narrows it to one view, `include_finished: false` leaves the finished ones out. Ids only, never file paths (an error that quoted one — ffmpeg names files by their paths — keeps only the file name). |

### Write (45 tools; free, change the library or the form)

| Tool | What it does |
| --- | --- |
| `set_form` | Fills in the Generate form (mode, model, duration, resolution, aspect ratio, audio, prompt, negative prompt, start and end image — `{asset_id, image_id?}`, `{still_id}` or `{upload_id}`, `null` clears; an end image only with a model that takes one —, and which descriptions are appended: `include_descriptions`, `excluded_description_asset_ids`) and shows the Generate view. An upload is first imported as a still in `Referensbilder`, so the form never points at a scratch file. All or nothing: invalid values change nothing. |
| `set_references` | Sets the form's reference images and audio from assets, in order (`replace` or `append`): all photos or chosen `image_ids` (`[]` for none, e.g. only a voice); with a model that takes reference audio, a character's first voice clip unless `include_voice` is false, an environment's first sound clip with `include_voice: true`, or chosen `audio_ids`. An item can also be a loose picture, `{still_id}` or `{upload_id}` (made a still in `Referensbilder` first), with no description to append. Switches the form to reference-to-video if needed and returns the token maps (`references`, `audio_references`) to write the prompt with. Photos and clips over the model's limits (9 images for Seedance; 3 clips, 15 s of audio in all) are listed in `not_added` / `not_added_audio`, and so is a default voice under 2 s (no model takes it). Replacing the references doesn't renumber the prompt's tokens; `reorder_references` does. |
| `reorder_references` | Changes the order of the form's (`target: "form"`, default) or a clip's (`target: {segment_id}`) reference images (`images`) and/or audio clips (`audios`), like dragging a thumbnail in Studio, and renumbers every `@ImageN` / `@AudioN` in the prompt and negative prompt so each keeps pointing at the same picture or clip: references [A, B, C] with "@Image1 hugs @Image3", `images: ["@Image3"]` → [C, A, B] and "@Image2 hugs @Image1". References are named by token, `image_id` / `audio_id` or `asset_id` (all of that asset's photos or clips); the named ones come first, the rest keep their order. Answers with the new token maps, `moved` (old → new token), the prompt, `composed_prompt` and the pictures past the model's limit (`not_sent`; moving one forward sends it). For a continuing clip only its own references (one that carries another clip's says where to reorder them); not for a clip that sends no references. |
| `open_in_studio` | Brings a place to the front: the Generate view (with `generation_id`, that clip in its drawer), a sequence (optionally one clip), a storyboard (with `transition_id`, that transition in the transition editor), an edit in Redigera (`view: "editor"`, `edit_id`, with `version_id` that version in the player; without either the list), an asset in its library view (`view: "asset"`, `asset_id`) or the prompt library (`view: "prompts"`). Opening something never counts as the user having seen it. |
| `create_asset` | Creates a character, environment, product, outfit or pose with a name and description. Add photos with `add_asset_images` and, for characters and environments, sound with `add_asset_audio`. |
| `update_asset` | Changes an asset's name, description or (characters) default outfit. Renaming also renames its folder. The description is appended to every later prompt that sends the asset's photos or voice. |
| `update_asset_audio` | Moves or resizes an audio clip's reference window (`clip_start`, `clip_length`); Studio keeps it 2–15 s inside the file and says when it adjusted it. |
| `add_asset_images` | Adds photos to an asset of any kind, after its photos: `sources` (1–12, in order) are `{upload_id}`, `{url}` (fetched like `begin_upload`; the call waits at most 45 s for its URLs), `{still_id}`, `{asset_image_id}` (another asset's photo) or `{generation_id, time}` (a frame of a finished clip). Copied into the asset's folder under the file's own name; all or nothing. Answers with the added photos (`image_id`, `photo_number`) as images. The user sees who added them (*Tillagd av …*). |
| `reorder_asset_images` | Changes the order of an asset's photos: the named `image_ids` first, the rest after. Photo 1 is the cover and what a reference sends first. |
| `add_asset_audio` | Adds sound to a character (*Röst*) or an environment (*Ljudmiljö*): `sources` (1–6) are `{upload_id}`, `{url}`, `{generation_id, start?, end?}` (a finished clip's sound, cut out as its own file) or `{edit_media_id}` (audio of an edit). Each clip must be at least 1 s; all or nothing. Answers with the new clips and their reference windows. |
| `reorder_asset_audio` | Changes the order of an asset's audio clips: the named `audio_ids` first. Clip 1 comes along by default when the asset is a reference. |
| `save_prompt` | Saves a prompt to the prompt library. |
| `update_prompt` | Changes a saved prompt: only the fields passed (`title`, `body`, `negative_prompt` — `null` clears it —, `tags`, `favorite`); merged with the stored prompt, tokens canonicalised as `save_prompt` does. |
| `create_sequence` | Creates an empty sequence with the default settings. |
| `update_sequence` | Changes a sequence's name (its folder follows), its `defaults` (model, duration, resolution, aspect ratio, audio — checked against the model like the window does) and its *Exportformat* (`export_height` 480, 720 or 1080, `null` for the first clip's own size). |
| `add_segment` | Adds a clip — or, with `from_generation_id`, a clip whose selected take is a finished video that already exists (your own clip, a version from Redigera; only `notes` go along, it doesn't continue from the clip before) — (`notes`, prompt, references with the same items as `set_references`, model and options, `include_descriptions` / `excluded_description_asset_ids` (by default those of the clip before), `continue_from_previous`, `continue_mode`, `end_from_next`, `start_image` / `end_image`), validated like a generation. A clip that continues in reference mode (`continue_mode: "references"`, the default) is sent reference-to-video with the references it carries — its own, or else those of the clip it continues from — and the previous clip's last frame as the last reference image; one that continues exactly (`"exact"`), ends on the next clip or has a start or end image is image-to-video and takes no references, so no voices either. |
| `update_segment` | Changes a clip; only the fields passed change (`references` replaces its photos and audio — items may also be `{still_id}` or `{upload_id}`, loose pictures; `include_descriptions` / `excluded_description_asset_ids` choose the descriptions appended to its prompt). `start_image` / `end_image` take `{still_id}`, `{asset_image_id}`, `{generation_id, time}` (a frame, saved as a still), `{upload_id}` or `{url}` (copied in as a still of the sequence), `"previous"` / `"next"` or `null`; `continue_mode` switches a continuing clip between `references` and `exact` (exact drops its references and their tokens); new `references` (or `reorder_references`) on a clip also renumber the tokens of the later clips that inherit them, so they keep naming the same pictures, voices and frame; a picture makes the clip image-to-video (with a model that takes an end image when it has one), drops its references and takes the `@` tokens out of a prompt the agent didn't rewrite. `selected_take_id` chooses which of its finished takes is in the cut — a take chosen again gets back the trims it last had —, and `trim_start` / `trim_end` trim it (in seconds; Studio keeps at least 0.2 s and says when it adjusted them). Existing takes are kept. |
| `move_segment` | Moves a clip to another position (`to_clip_number`, 1-based). |
| `export_film` | Exports a sequence (`sequence_id`) or a storyboard (`storyboard_id`) as one film — the selected takes, trimmed, at its *Exportformat* — into its folder, exactly as *Exportera* does. Free and local. Waits up to `wait_seconds` (default 30) and answers `{status: "done", export_id, duration, cuts}`, else `{status: "running", progress}` (follow it with `get_work_status` or `list_exports`); an export already running for it answers `running`. |
| `stop_generation_run` | Stops *Generera saknade* for a sequence or a storyboard: no further clips are sent; takes already at Venice still land. |
| `save_frame_as_still` | Saves a frame of a finished clip (`generation_id`, `time` in seconds) as a still of a sequence or a storyboard (`sequence_id` / `storyboard_id`; by default the clip's own), to use as a board's picture, a keyframe or a reference. The frame is the first one at or after `time`, as `review_generation` and `get_frames` show it, so a time from their `frame_times` / `times` (given to the millisecond, like the captions) saves exactly the frame the agent looked at. |
| `import_still` | Copies a picture into Studio as a still — of a sequence or a storyboard, or with neither among the loose pictures in `Referensbilder` — from `{upload_id}` or `{url}`, to use as a board's picture, a keyframe or a reference. The same picture imported again into the same place gives the same still. |
| `bridge_segment` | *Gör om mellan grannarna*: sets a clip to start on the previous clip's last frame and end on the next clip's first frame (only the one that exists for the first or last clip) with its family's image-to-video model that takes an end image, keeping duration, prompt and audio but dropping its references (image-to-video can't take them; their `@` tokens go from the prompt too). Answers with both frames, any problems, notes and the price. Generating the new take is still `request_segment_generation`; the clip's old takes are kept. |
| `create_storyboard` | Creates a storyboard (`name`, `aspect_ratio`: 16:9 by default, or 9:16, 1:1, 4:3, 3:4, 21:9) with its folder; `board_notes` creates one board per note (at least two boards), with the transitions between them. |
| `update_storyboard` | Renames a storyboard (its folder follows) or changes its format. |
| `add_board` | Adds a board at the end, or after / before another one, with a `note` and optionally a picture: `{still_id}`, `{asset_image_id}` (a library photo, used where it is), `{generation_id, time}` (a frame of a finished clip, saved as a still of the storyboard), `{upload_id}` or `{url}` (copied in as a still of the storyboard). The transitions follow: one between every two neighbouring boards. Adding at the end never removes anything; a board put between two boards whose transition has a prompt, a negative prompt or takes is refused and nothing is added — add it last and ask to move it there with `request_delete` (`board_move`). An empty transition is simply replaced. |
| `update_board` | Changes a board's note and/or picture (the same kinds as `add_board`; `image: null` empties it). The transitions to and from it get the new picture; their takes stay (a selected one is then `made_from_earlier_pictures`, until a take made from the new picture is done and becomes the selected one). |
| `move_board` | Moves a board to another place (`to_board_number`, 1-based). Transitions between boards that are no longer neighbours go — their takes stay as ordinary generations — and new neighbours get new transitions with empty prompts; the answer lists what was removed. A move that would remove a transition with a prompt, a negative prompt or takes is refused with a pointer to `request_delete` (`board_move`). |
| `update_transition` | Changes a transition's `prompt` (the motion from the first picture to the second; no `@` tokens), `negative_prompt`, `duration`, `resolution`, `audio`, `model` (only image-to-video models that take an end image) or `selected_take_id` (one of its finished takes). |
| `convert_storyboard_to_sequence` | Makes an ordinary sequence, "<storyboard> (sekvens)", with one clip per transition and a copy of each transition's selected take, so the film can be edited further in Sekvenser. The storyboard stays as it is. |
| `create_edit` | Opens a finished film in Redigera as a new edit: `generation_id` (a feed clip, a take, an own clip, another edit's version) or `export_id` (copied in as v1); optional `name`. The answer names other edits of the same film. A film the agent has as a file is imported first (`import_own_clips` with `target: {feed: true}`). |
| `apply_edit` | Makes a free operation (see [Edit operations](#edit-operations)) on a version — the current one unless `base_version_id` — and saves the result as a new version, rendered on your Mac. Paid operations are refused with a pointer to `request_edit_operation`. |
| `set_current_version` | Makes a version the edit's current one (an undo is choosing the parent). |
| `rename_edit` | Renames an edit; its folder and its versions' titles follow. |
| `update_transcript` | Corrects the text of transcript lines (`segment_id`, `text`); an inherited transcript is copied to the version first. |
| `send_edit_to_sequence` | Puts a version into a sequence: as a new, selected take of a clip (`segment_id`) or as a new clip (`sequence_id`, `after_segment_id`). Not into storyboards. |
| `add_edit_audio` | Adds sound to an edit's audio (Redigera's media) so `apply_edit` can lay it on a version (`{op: "add_audio", media_id}`): `sources` (1–6) are `{upload_id}`, `{url}` or `{asset_audio_id}`. Any sound longer than 0.05 s, a click or a whoosh too. Answers with each `media_id`, its label and length. |
| `cancel_edit_job` | Stops a running paid job in Redigera like the user's *Avbryt*: no further parts are sent, parts already sent finish and are kept. A picture operation can't be stopped once its take is at Venice. |
| `add_review` | Records the agent's review of a generation (rating -1 = tumme ner or 1–3 stars, up to 12 tags, a note) under its own name; each call adds a new review. |
| `save_learning` | Records a learning: title, insight, optional model (left out: every model), tags and evidence (up to 50 generation ids, which must exist). |
| `update_learning` | Changes one of the agent's own learnings; only the fields passed change (`model: null` makes it general, `evidence` replaces the list). Not one the user has pinned or edited. |
| `begin_upload` | Sends Studio a file — a picture, a sound or a video — by `url` (Studio fetches it), `bytes` (Studio answers a `put_url` for the raw file) or `data_base64` (files under 700 KB); see [Sending files to Studio](#sending-files-to-studio). Answers the `upload_id`, its status and `expires_at`. |
| `discard_upload` | Throws an upload away now (a transfer in progress stops). Only the scratch file goes; what was made from it stays. |
| `import_own_clips` | Imports video uploads (1–10) as own clips (*Egna klipp*), as the user's own drop does: `target` `{feed: true}`, `{sequence_id, after_segment_id?, fit?}` (one new clip per file) or `{segment_id, fit?}` (each as a take of that clip, the last one selected); not into storyboards. Every file is checked first (`working_copy_reasons`); a file imported before is used again. Answers when done within `wait_seconds` (default 30) with `generation_ids`, `segment_ids` and per-file errors, else `{status: "running", import_id}`. |
| `cancel_import` | Stops an import that is still running, like the ✕ on a file card: files not imported yet are stopped or skipped; files already in the library stay. |

While *Generera saknade* runs for a sequence or a storyboard, agents cannot change its clips, boards or transitions;
`stop_generation_run` stops it.

### Approval (9 tools; create an approval request, nothing is generated or removed until the user approves)

| Tool | What it asks for |
| --- | --- |
| `request_generation` | Generating the Generate form as it is now (captured at request time). |
| `request_segment_generation` | A new take of one sequence clip. A continuation in reference mode is shown with the previous clip's last frame as its last reference image and the instruction in front of the prompt. Lapses if the clip changes before approval — for a clip that takes frames from its neighbours, also if a neighbour's take or trim changes; for a continuation in reference mode, also if a clip it carries references from changes. |
| `request_generate_all` | Every clip of a sequence without a finished selected take, in the order their frames allow (a clip that ends on the next clip after that clip); the price is the sum. Lapses if the clips (or a clip whose references a continuation carries) change. |
| `request_transition_generation` | A new take of one storyboard transition: from the first board's picture to the next board's, with the transition's prompt and settings. Both boards need pictures and the prompt must be written. Lapses if a board's picture, the transition or the pair of boards changes before approval. |
| `request_generate_storyboard` | Every transition of a storyboard without a finished selected take (and none rendering); they are independent of each other, so the order doesn't matter. Refused, naming the transition, unless all of them are ready; the price is the sum. Lapses if the boards' pictures or the transitions change. |
| `request_image_generation` | One still (about $0.06 with the default Seedream models), typically a board's picture or a keyframe: an English prompt, optionally references (`reference_still_ids`, `reference_image_ids` for library photos, `reference_asset_ids` for assets' cover photos, sent in that order — after the previous board's picture with `previous_board_as_reference`; the first is the base picture), model, aspect ratio (default the storyboard's or sequence's, or the clip's with `assign_to` a clip), resolution, quality, a negative prompt (text-to-image models only), the storyboard or sequence it belongs to (`storyboard_id` / `sequence_id`), and `assign_to` a board (`{board_id}`) or a clip's start or end slot (`{segment_id, slot}`). Checked and priced exactly like *Skapa bild…* in the window; the answer also says whether *Säkert läge för bilder* is on (`safe_mode`). Saved as a still of the storyboard or sequence once approved (with neither: in `Referensbilder`), and made the board's picture or put into the slot when `assign_to` names one. Refused while *Generera saknade* runs there; lapses if the board moves, is removed or gets another picture, or the clip moves or its slot starts or stops taking a neighbour's frame, before approval. A picture the user puts onto the board while the image is being made stays: the new still is kept, not put in, and the answer's `notice` says so. |
| `request_edit_operation` | A paid operation on a version of an edit (`transcribe`, `change_voice`, `speak_lines`, `music`, `effect`, `regenerate`, `prompt_edit`, `extend`, `upscale`; the same `operation` input as `plan_edit_operation`, which the agent calls first) — or, with `resume_job_id` instead of `operation`, continuing a stopped paid job (*Fortsätt*: its unsent and failed parts at the job's fresh price; lapses if the job can no longer continue or the price rises by more than a cent). Planned exactly as Redigera's cards plan it; problems come back as an error and free operations are refused. Lapses if the version's file, the plan (range, prompt, model, voice, lines) or the transcript lines it uses change, or Venice's price rises by more than a cent, before approval; a newer request for the same operation on the same version replaces a pending older one, and so does the same request at another price (the same at the same price returns the pending one). The answer has `partial_price` when a part (a voice clone) has no price. Once approved it runs as a job, and its result becomes a new version by itself. |
| `request_voice_design` | A new voice for a character (*Skapa röst med AI*, about $0.35): an English description of the voice and a sample text. Once approved and made, it is added as a new *Röst* clip of the character (a recording the agent already has goes in with `add_asset_audio`, free). One design per character waits at a time: a newer request for the same character replaces a pending one. |
| `request_delete` | Removing things (free, but never without you): 1–50 items in one request — see [Deleting](#deleting). `dry_run: true` answers the plan without asking. |

Each takes an optional `note` (up to 500 characters) that is shown to the user in the approval dialog.

### Edit operations

`plan_edit_operation`, `apply_edit` and `request_edit_operation` take one `operation`, chosen by `op` (snake_case,
like every field). Ranges are `{start, end}` in seconds of the base version; the plan snaps them to frames, cut
markers, transcript lines and what the model allows. Fields left out get the defaults Redigera's cards start from.

| `op` | Fields | Cost |
| --- | --- | --- |
| `trim` / `cut` | `keep` / `range` | free |
| `fade` | `in_seconds`, `out_seconds` | free |
| `volume` | `gain_db`, `range?`, `target?` (`all`, `voice`, `background`) | free |
| `mute` | `range?`, `target` (`voice` removes the voice, `background` keeps only the voice) | free |
| `denoise` / `loudness` | `strength` (`mild`, `strong`) / `lufs` (−14, −16, −23) | free |
| `add_audio` | `media_id` (audio already in the edit) or `asset_audio_id` (a library clip), `at`, `gain_db?`, `duck?`, `loop?`, `length?`, fades, `replace_bed?` | free |
| `layer` | `layer_id` (a layer of the base version: `get_edit` lists every version's), `gain_db?`, `at?`, `remove?` | free |
| `transcribe` | `model?` (Scribe v2), `language?` | paid |
| `change_voice` | `model?` (a listed voice changer), `voice` (`{preset}` or `{voice_id}`), `range?` or `segment_ids?` (only those lines get the new voice), `background?`, `remove_noise?` | paid, per started minute per part |
| `speak_lines` | `model?`, `voice` (`{preset}`, `{voice_id}` or `{clone_audio_id}`), `lines` (`{segment_id, text}` replaces a line, `{at, text}` adds one; at most 200), `background?`, `fit?`, `style?`, `language?` | paid, per line |
| `music` / `effect` | `model?`, `prompt`, `range?` / `at` + `seconds`, gain and ducking | paid |
| `regenerate` | `range` (whole seconds), `prompt`, `model?`, `resolution?`, `audio?` (`keep`, `model`) | paid |
| `prompt_edit` | `range`, `prompt` (the one change), `model?`, `resolution?`, `reference_image_ids?`, `audio?` | paid |
| `extend` | `seconds` (4–15), `prompt`, `model?`, `resolution?`, `audio?` (`model`, `silence`) | paid |
| `upscale` | `factor` (2 or 4) | paid |

Voice separation (needed for the `voice` / `background` targets, and to keep music and effects under a new voice)
uses macOS's built-in sound isolation; `get_edit` and `list_audio_models` say whether this Mac has it. A
character's *Röst* clip can be cloned for new lines only once you have ticked *Får klonas för nya repliker* for it
(`clone_consent`); the approval dialog asks for it when it is missing. Withdrawn, no further line is said in that
voice: lines not yet sent are refused, and the clip's clone handles are forgotten.

### Prompt and resource

| Name | Kind | What it is |
| --- | --- | --- |
| `write_video_prompt` | MCP prompt | Starts a prompt-writing task (optional `idea`, optional `segment_id` or `transition_id`) with the actual reference token maps (photos and voices) — for a continuation in reference mode the references it carries and the frame's token; for a clip with a start or end image, what it starts and ends on; for a storyboard transition, the two boards with their notes — the clip's notes, the learnings that apply to the model and the prompt-writing guide. |
| `studio://guide` | MCP resource (Markdown) | The same guide as `get_studio_guide`, with the learnings so far. |

### What agents cannot do

Agents can create and change nearly everything you can, but some things stay yours:

- **Removing anything** — an asset, a photo or sound clip, a prompt, a review or a learning, a sequence or a clip, a
  storyboard or a board, a video or a take, a still, an edit or a version, *Rensa versioner* — only happens once you
  approve their `request_delete`; so does a board move that would drop a transition with a prompt or takes.
- **Spending money** only happens once you approve a paid request.
- **Settings**: the API key, the prompt language, *Säkert läge för bilder* and the agent connection itself.
- **The library folder**: switching or moving it, *Städa upp*, exporting or importing the whole library (*Export och
  import*) and revealing folders in Finder.
- **Consents**: Venice's terms and the consent to clone a voice (*Får klonas för nya repliker*).
- **Approving** anything, and **marking things seen** (they can read what you have seen).
- **Your own judgement**: your rating, note and tags, and learnings you wrote, edited or pinned (agents can't even ask
  to remove those, nor your own review). Agents change only their own learnings, and not once you have pinned or
  edited one (it becomes yours); their own reviews can't be edited.
- **Files on your Mac**: no tool takes a path; files come as uploads, and saving subtitles to a file goes through
  your save dialog (agents read them with `get_transcript`).
- The window layout (the sidebar, the panels).

Every change goes through the same services as the window, with the same validation. The handlers that take files
check them themselves too: an agent's call may only hand over a file it uploaded or one the library already records.

## Sending files to Studio

Agents usually run on another machine than Studio, so no tool takes a local path. A file reaches Studio as an
**upload**: `begin_upload({kind: "image" | "audio" | "video", file_name, …})` with exactly one of

1. **`url`** — Studio fetches it in the background. Only public addresses are fetched, plus the agent's own machine
   (the address its session connects from; any loopback address for an agent on the same Mac), on any port but
   Studio's own. `begin_upload` waits up to 20 s and then answers `status: "downloading"`; follow it with
   `get_upload`. The content tools also take `{url}` directly and fetch it the same way, waiting at most 45 s in
   all; every address is checked before the first is fetched. When a file is still on its way they fail without
   changing anything and name the `upload_id`s (the finished ones too), so the agent can wait with `get_upload` and
   use those. Otherwise what a tool fetched is its own and goes once the call has answered, so `{url}` sources never
   fill the upload limits. A file fetched by URL is named after the URL's last path segment only when that looks like
   a file name (`IMG_2041.jpg`, with the kind's extension); anything else — an id, a token — is named *bild*, *ljud*
   or *film*, since the name ends up in the library.
2. **`bytes`** — the file's exact size (optionally its `sha256`). Studio answers a `put_url`, and the agent sends the
   raw file there with its token:

   ```bash
   curl -T <file> -H "Authorization: Bearer <token>" <put_url>
   ```

   `put_url` is `http://<address>:<port>/uploads/<upload_id>`, on the address the agent reached Studio at. When
   Studio can't tell which one that was it answers only `put_path` (`/uploads/<upload_id>`): use the address the
   agent connects to `/mcp` with. Only the machine that began the upload may send it, `Content-Length` must equal
   `bytes` (no chunked bodies), and the file is checked before Studio answers `201` with
   `{upload_id, status, bytes, sha256}` — or `422 {error}` when it isn't what it should be. A transfer that breaks
   off can be sent again; one that sends nothing for 60 seconds or takes longer than 30 minutes in all is stopped
   with `408` (a slow link: `discard_upload` it and let Studio fetch the file by `url` instead). The upload stays
   `receiving`, and `get_upload` says why in `error`.
3. **`data_base64`** — the file inline, only for files under 700 KB; checked at once.

| Kind | Types | At most |
| --- | --- | --- |
| Picture | JPG, PNG, WebP, HEIC (converted to JPEG with macOS's `sips`) | 30 MB, 16 384 px a side, 80 megapixels |
| Sound | MP3, WAV, AIFF, FLAC, OGG, M4A, AAC | 100 MB |
| Video | MP4, MOV, M4V, WebM, MKV | 4 GB |

What a file is comes from its bytes, never its name, extension or `Content-Type`, and it is checked the way Studio
checks its own files: a picture must decode, a sound must have sound (longer than 0.05 s), a video must pass the
own-clip check (`get_upload` says why a working copy would be made). A sound for an asset must also be at least 1 s;
edit audio may be a short effect.

A ready upload lives two hours and can feed several tools; a transfer with no bytes for 30 minutes fails. At most
16 uploads can be live and 8 GB staged in all, and 2 GB must stay free on the library's disk — counting what
transfers under way still have to write (a `PUT`'s size while it is being sent, and for five minutes after
`begin_upload` until the first one is), checked again before a `PUT` is read and while a URL downloads (one that
would pass a limit stops with the same refusal). The refusals at the live limit and for disk space name the agent's
own uploads that hold the room. Uploads are staged in
the open library (`.studio/tmp/agent-uploads/`, so `begin_upload` needs a library) and go away when the token is
replaced, the library is switched or moved, the connection is turned off or Studio quits. `discard_upload` throws one
away sooner — do that with a large video once `import_own_clips` is done.

| Tool | Takes |
| --- | --- |
| `add_asset_images` | `{upload_id}`, `{url}`, `{still_id}`, `{asset_image_id}`, `{generation_id, time}` |
| `add_asset_audio` | `{upload_id}`, `{url}`, `{generation_id, start?, end?}`, `{edit_media_id}` |
| `import_still` | `{upload_id}`, `{url}` |
| `add_segment`, `update_segment` (start and end image), `add_board`, `update_board` (picture) | also `{upload_id}`, `{url}` (copied in as a still) |
| `set_form` (start and end image), `set_references`, clip `references` | also `{upload_id}` (imported as a still in `Referensbilder` first) |
| `import_own_clips` | video `upload_id`s |
| `add_edit_audio` | `{upload_id}`, `{url}`, `{asset_audio_id}` |

An upload used as a form image or a reference is first made a still, because a scratch file must never end up in a
generation's settings (`.studio/tmp` is cleared when a library opens). While an upload comes in, *Pågår och klart*
shows it (*"<agent> laddar upp IMG_2041.jpg · 34 %"*). Photos and sound clips an agent added carry `added_by` in the
tools and a tooltip on their tile in Studio — *Tillagd av <agent> 9 okt 14:02 · från example.com* — with the host a
file was fetched from, never its URL (which may carry a token).

## Deleting

An agent can't delete anything itself. To remove something it calls `request_delete` with every item in one request
(1–50) and a short note why:

| Item | Removes |
| --- | --- |
| `{asset_id}`, `{asset_image_id}`, `{asset_audio_id}` | An asset with its folder, one of its photos, one of its sound clips (files clips still use are kept in `Referensbilder`) |
| `{prompt_id}`, `{learning_id}`, `{review_id}` | A saved prompt; a learning or a review by an agent (any agent's — the dialog names the author) |
| `{sequence_id}`, `{segment_id}` | A sequence, or one of its clips (its takes become ordinary clips in Generera) |
| `{storyboard_id}`, `{board_id}` | A storyboard, or one of its boards (a storyboard's transitions go with their boards) |
| `{board_move: {board_id, to_board_number}}` | A board move that would drop a transition with a prompt or takes (one per storyboard per request) |
| `{generation_id}`, `{take: {generation_id, segment_id}}` | A video and its file; or a take taken off its clip or transition (the video stays) |
| `{still_id}` | A still |
| `{edit_id}`, `{version_id}`, `{prune_versions_of: edit_id}` | An edit, a version, or Redigera's *Rensa versioner* |

Studio plans every item first: its label, what else changes (photos kept for the clips that use them, characters
that lose their default outfit, takes that become ordinary clips, transitions lost with their prompts, a clip left
without its selected take, versions kept because sequences use them) and what goes to the Trash. An item another one
in the request removes anyway (a photo of an asset that goes, a clip of a sequence that goes, a take of a video that
goes) is folded into it. If any item can't be removed now — an unknown id, a running *Generera saknade* (also for a
take or video of a clip in it, or one that is a selected take there: the run would make the clip again), a busy or
partly paid Redigera job, an edit's original, a pending video, an item already waiting in another request, your own
review, a learning you wrote, edited or pinned, a transition named as a clip, two board moves for one storyboard, a
move that removes nothing — the whole call fails with every reason and nothing is asked. `dry_run: true` answers the
plan without asking. Otherwise the answer is `{approval_id, status: "pending", items}`.

You see the request in the approval dialog (below). Nothing is removed until you approve it, all or nothing; if
anything in it changes before you answer, the request lapses (`expired`, as soon as the dialog, `get_approval` or a
new request for the same things notices) and the agent has to ask again. The agent polls
`get_approval`: each item ends `deleted`, `gone` (it was already removed) or `failed` with its error. A bad take can
simply stay unselected — the guide asks agents to prefer that to deleting.

## What is running and what is new

`get_work_status` reads the same summary as the window's *Pågår och klart* panel: what runs right now (videos at
Venice with their progress and estimate, takes on their way, *Generera saknade* runs, pictures, Redigera jobs and
renders, exports, imports, approved requests being carried out and uploads, each with `via` when an agent asked for
it) and what has finished — or failed — that you haven't looked at yet. An agent uses it after an approval instead of
polling every generation. `list_generations` and `get_generation` say `seen_by_user`, and `unseen_only` lists the new
ones. Studio marks things seen when you play a video for a second, open it, choose it as a take, rate it or open it
in Redigera; agents can read that but never mark anything seen, and opening a place for you with `open_in_studio`
doesn't count.

## The approval flow

1. The agent prepares the form or a clip and calls a paid tool. Studio validates it first (prompt, start image or
   references, `@ImageN` and `@AudioN` tokens, and for a clip the neighbours' frames it takes; for a picture the
   model, the number of references, the files and the format, exactly as *Skapa bild…* checks them); a problem
   comes back as an error and no request is made. The audio files are also measured (for `request_generate_all`,
   those of every clip that takes no frame from a neighbour), so a window that is under 2 s, past the end of
   the file or over 15 s in all is refused now rather than after you approve. Each take's audio is measured again
   right before it is sent, as for every generation.
2. Studio asks Venice for the price and creates the request. The tool answers at once with
   `{approval_id, status: "pending", price_usd, expires}`. Asking again for exactly the same thing returns the same
   request; a new request for the same clip replaces an older pending one. At most 10 requests can wait at a time.
3. Studio shows the approval dialog with the prompt (tokens coloured) and, set apart below it, the References legend
   that is appended to it (the descriptions of the referenced assets, as they were when the agent asked, with the
   length that is sent), the reference images, the voices and sounds with their windows and play buttons, the
   price and the agent's note. A clip that starts or ends on its neighbours' frames shows both frames, live, and
   can't be approved while they are being fetched: if a neighbour's take or trim changes after the request was
   made, the request lapses (approving it says why) and the agent has to ask again, so a frame the user never saw
   is never paid for. A storyboard transition shows the two board pictures side by side with an arrow between them,
   each board's number and note, then *Vad händer?* (the prompt), the settings and the price; *generate all* for a
   storyboard lists its missing transitions. An image request shows the prompt, the references in the order they are
   sent (the base first), the model and format, which clip and slot — or which board, with its note and the picture
   it replaces — the picture goes to (it can't be approved once that clip or board has moved, or the board has got
   another picture) and whether *Säkert läge för bilder* is on. If Studio is
   not in front, its Dock icon bounces once. Pending requests are also listed in the activity drawer.
4. You approve or decline (optionally with a reason). On approval Studio re-checks that the clips, the image and
   audio files and the composed prompt are still exactly what was shown — a description edited or switched off, or
   the prompt language changed, since the request makes it lapse, and the dialog says so before you click (the
   Generate form was captured when the request was made, so later edits to the form don't change it) — then
   submits through the normal generation path, sending exactly the composed prompt that was checked. If Venice first needs you to accept a model's terms, the consent
   dialog appears; accepting it submits the request, and until then the request stays pending.

   **Edits in Redigera** (`request_edit_operation`) show the version's poster, for a picture operation the frames
   it works from (captioned: the frame before or after the range, the film's first or last frame, the range's first
   and last frame), what changes (the prompt; old → new lines; for `change_voice` with `segment_ids` the lines that
   get the new voice; the voice, with a play button for a cloned one), the parts with their prices and the price
   note (billed per started minute, a voice clone Venice doesn't price), and the plan's warnings (lip sync, real
   people …), planned again live while the dialog is open. A price with an unpriced part is shown as *≈ $X +*.
   Continuing a stopped job (`resume_job_id`) shows *Fortsätt jobbet ”…” · $x*, how far the job got, what is already
   paid and its error.
   Above $5, with an unknown price or with a part that has none, a second step asks *Det här kostar … Fortsätt?*. A cloned voice whose clip you haven't allowed to be cloned shows a required
   checkbox, *Jag har rätt att använda den här rösten*; ticking it and approving saves that consent on the clip.
   On approval Studio checks that the version still exists and is the very same file (device, inode, size and
   modification time), plans the operation again and requires the same plan and a price no more than $0.01 above
   the approved one, that the transcript lines it uses are unchanged, and that the clone consent is there — then runs
   it through Redigera's own service with the approved price as its ceiling. *Skapa röst* requests
   (`request_voice_design`) show the character, the description, the sample text and the price; with an unknown
   price (or one above $5) they too ask once more before approving.

   **Removals** (`request_delete`) show *"<agent> vill ta bort"*, the agent's note and the items grouped by kind
   (*Karaktärer, Produkter, Foton, Ljudklipp, Prompter, Lärdomar, Omdömen, Sekvenser, Klipp, Storyboards, Rutor,
   Flyttar, Videor, Tagningar, Stillbilder, Redigeringar, Versioner …*), each with its picture (an asset's cover
   ringed in its kind's colour, the photo, a poster, the still, the board's picture) or a text excerpt, its label and
   what else changes, and that files go to the Trash and can't be brought back in Studio. While the dialog is open,
   Studio checks the request again every 2 seconds and whenever the window gets focus; if something changed since
   the agent asked, it says *"Ändrats sedan agenten frågade – kan inte godkännas: …"* and *Godkänn och ta bort*
   stays disabled. When a container (an asset, a sequence, a storyboard, an edit) or more than 5 items go, a second
   step asks *"Det här tar bort … Fortsätt?"* (*Ja, ta bort* / *Tillbaka*). On approval every item is checked once
   more and removed through the window's own handlers, with your authority, in an order where nothing goes before
   what depends on it (photos, sound clips and reviews; takes, videos and stills; clips, board moves and boards;
   versions; assets, prompts and learnings; sequences, storyboards and edits). The dialog then shows each item's
   outcome (*"Borttaget: 2 av 3 – 1 gick inte: …"*).
5. The agent polls `get_approval` (every 15–30 seconds is plenty) and then follows the result with `get_generation`,
   `get_sequence` or `get_storyboard` — or, for a picture, `get_still`; for an edit, `get_approval` itself follows
   the job until the new version is there (then `review_generation`), for a designed voice it names the new clip, and
   for a removal it lists each item's outcome. `get_work_status` shows what the approved work is doing meanwhile.
   A picture is made while the dialog waits (*Skapar bilden…*, usually 10–30 seconds), and the dialog then shows it
   to you too; if it couldn't be put into its clip or onto its board, `get_approval` says why in `notice` (the
   picture is saved among the stills either way).

A request **expires** after 30 minutes without an answer, and immediately when the token is replaced, the library
is switched or the agent connection is switched off. While an approved request is being carried out (a batch of
removals, say), the library can't be switched or moved.

## Descriptions in the prompt and the order of references

When a generation is sent, Studio appends the descriptions of the assets whose photos or voices it sends to the
prompt, as a References legend (in the prompt language: `Referenser:` and `röst` in Swedish):

```
<the prompt>

References:
- Anna (@Image1, @Image2; voice @Audio1): <Anna's description>
- Beach promenade (@Image3): <its description>
```

- Only assets with a description, and only those whose pictures or clips are actually sent (within the model's
  limits, in reference mode); the entries are ordered by their first token. A description is written as it is in
  the library at the moment of sending, on one line and without `@`, so an `update_asset` applies to the next
  generation (and makes a pending approval that uses the asset lapse).
- The prompt agents write (and `prompt` in every answer) never contains the legend. `composed_prompt` in
  `get_workspace`, `validate_prompt`, `get_sequence` and `reorder_references` is the text that would be sent, with
  `description_entries` (asset, tokens, description, `included` = switched on, `sent` = in `composed_prompt` right
  now, `shortened`), `composed_characters` against
  `prompt_character_limit`, and a `descriptions_note` when descriptions were shortened to fit the model's limit,
  dropped because not even the names fit, or not appended because the prompt is empty. `get_generation` and
  `review_generation` return `sent_prompt` when it differs from the prompt.
- A sequence clip that continues in reference mode is sent with `Start exactly on @Image{N+1} (the last frame of the
  previous shot) and continue the action from there.` (Swedish: `Börja exakt på @Image{N+1} (sista bildrutan i
  föregående klipp) och fortsätt handlingen därifrån.`) in front of the prompt, @Image{N+1} being the previous clip's
  last frame, sent after the references it carries. Agents don't write it; `composed_prompt` shows it.
- `include_descriptions: false` (on `set_form`, `add_segment`, `update_segment`, `validate_prompt`) sends the prompt
  alone; `excluded_description_asset_ids` leaves out chosen assets (`[]` appends all again). A new clip starts with
  the switches of the clip before it.
- `reorder_references` changes the order of a form's or clip's references and renumbers every `@ImageN` /
  `@AudioN` in the prompt and the negative prompt with it, the same way dragging a thumbnail in Studio does; the
  legend follows the new numbers. `set_references` with `mode: "replace"` does not renumber anything.

## Prompt-writing guidance

The server's `initialize` instructions ask agents to start with `get_studio_guide` and to review what their
generations became, never to pass file paths, and that paid generations and removals go through approval. The guide
(also available as the `studio://guide` resource) explains assets (products among them: write the product next to
its tokens and describe what the character does with it), sending files, deleting, the status summary, the three modes,
`@ImageN` and `@AudioN` references, voices and poses, sequences and continuation clips, keyframes and stills,
storyboards (plan the milestones as boards with notes; make each board's picture with `request_image_generation`
from the characters, outfits, environment and pose, with the previous board's picture as the base for continuity;
write each transition's prompt as the motion from picture A to picture B; generate, review, regenerate), making
pictures, replacing a clip between its neighbours (review → `bridge_segment` → look at the frames →
`request_segment_generation` → review again), approvals, the review loop, and how to write prompts for
Seedance-class video models, for transitions and for pictures, your own clips (*Egna klipp*) and editing films in
Redigera (always plan first; which operation for which problem — a broken stretch → `regenerate`, a visual change →
`prompt_edit`, one change per run on the shortest range, a whole film's voice → `change_voice` when Venice lists one,
else `transcribe` + `speak_lines`; spoken lines don't move lips; Seedance often refuses real people; prefer the free
operations; review every version), designed and cloned voices, and it ends with the learnings recorded so far (the
pinned ones and the ten most recently changed). The `write_video_prompt` prompt starts from the prompt-writing part
of the guide, with the clip's actual references (for a continuation in reference mode the references it carries and
the frame's token; for an image-to-video clip, the prompts of the neighbours it starts and ends on; for a
transition, its two boards and their notes), its notes and the learnings for its model.
Agents are asked to talk to the user in Swedish and to write video prompts in the language chosen under
**Inställningar → Generering → Promptspråk** (English by default). The guide tells them that the descriptions of the
referenced assets are appended automatically as a References legend — so they write the action, camera and mood
instead of repeating them — and the `write_video_prompt` context lists the descriptions that will be appended. Image
prompts are always English: one still frame — subject, composition and framing, place, light and style — referring to
the references as "image 1", "image 2" … in the order they are sent, never with `@` tokens.

## Reviews and learnings

The point of the review tools is better prompts: an agent looks at what earlier prompts actually produced, writes
down what it saw, and turns what generalises into *learnings* that every later session reads first. The guide and
the server instructions ask agents to close the loop after every generation they requested, and whenever you ask
them to look at earlier clips or films:

1. **Find** — `list_generations` with the clip feed's filters, e.g. the clips you rated highest
   (`{sort: "rating", min_rating: 2}`) and the ones you gave tumme ner (`{thumbs_down: true}`), the clips of one
   character (`asset_id`), or finished clips nobody has reviewed yet (`{status: "completed", has_reviews: false}`);
   `list_exports` for exported films.
2. **Look** — `review_generation` returns the frames next to the reference images the clip was made from (and, with
   `include_audio`, its sound next to the reference voices); `get_frames` looks closer at a moment. For a film,
   `review_sequence` shows every clip's selected take with hints for each cut, and `review_export` shows an exported
   film around its cuts.
3. **Record** — `add_review`: an honest grade (-1 tumme ner, or 1–3 stars: 1 usable with clear flaws, 2 good, 3
   exactly what was asked), tags from the suggested vocabulary (`prompt-followed`,
   `prompt-ignored`, `identity-drift`, `wrong-outfit`, `wrong-pose`, `bad-motion`, `good-motion`, `camera-good`,
   `camera-wrong`, `artifacts`, `voice-match`, `voice-mismatch`, `continuity-good`, `continuity-break`,
   `lighting-good`, `lighting-wrong`; other tags are allowed) and a specific note that names tokens and moments.
4. **Distil** — `save_learning` for whatever generalises ("Seedance 2.5: naming the outfit right after the
   character's tokens keeps it"), with the model and the generation ids it is based on as evidence;
   `update_learning` when later results refine it, and `request_delete` (`{learning_id}`) when they prove it wrong.
5. **Apply** — the learnings come at the end of `get_studio_guide`, the `studio://guide` resource and the
   `write_video_prompt` prompt (the pinned ones and the ten most recently changed; the prompt only those for its
   model and the general ones), and `list_learnings` has them all.

Reviews and learnings are stored in the library's database, so they move with the library and every agent sees the
same ones. In Studio, reviews appear in the clip's detail drawer next to your own rating, note and tags (you can
delete any review there), and learnings in **Prompter → Lärdomar**, where you can write your own and pin, edit or
delete any of them; pinned learnings come first for every agent. Your own rating (author `user`) — tumme ner or
one to three stars — is what `list_generations({min_rating})`, `list_generations({thumbs_down: true})` and
`list_reviews({author: "user"})` read, so rating clips is the clearest way to show agents what you like.

## Troubleshooting

**Tailscale is not found.** Studio looks for Tailscale's tunnel interface (a `utun` interface with a single
`100.64.0.0/10` IPv4 address next to an `fd7a:115c:a1e0::/48` IPv6 address); other VPNs or networks that happen to
use `100.x` addresses are deliberately ignored. Make sure Tailscale is running and connected, then press
*Sök igen* (search again) in Agentanslutning — Studio also re-checks every 30 seconds. Until then only agents on the
same Mac can connect.

**The port is in use.** Studio reports that the port is used by another program. Choose another port in
Agentanslutning and update your agents' URLs. Note that Studio.app and Studio Dev both default to 8770, so give one
of them another port if both have the connection switched on. To see what holds the port:
`lsof -nP -iTCP:8770 -sTCP:LISTEN`.

**Studio could not listen on the Tailscale address.** The connection still works on `127.0.0.1`; the status line
explains the error. Check the macOS firewall (System Settings → Network → Firewall) and allow Studio.

**HTTP 401 Unauthorized.** The `Authorization: Bearer <token>` header is missing or the token is wrong — typically
after *Byt token…*. Copy the current token from Agentanslutning.

**HTTP 403 Forbidden.** The request came from an address that isn't allowed on the socket it reached: the
loopback address only serves this Mac, and the Tailscale address only serves tailnet peers (not devices on a LAN
that happens to use `100.x` addresses). Use one of the addresses listed in Settings.

**HTTP 403 "Browser access is not allowed".** The request carried an `Origin` header. Web pages and browser-based
clients are refused by design; use a native MCP client or `mcp-remote`.

**HTTP 404 Not found** means the path is neither `/mcp` nor `/uploads/<upload_id>`. A JSON-RPC error *Session not
found* (also 404) means Studio was restarted or the session was closed; a well-behaved client starts a new session
automatically.

**HTTP 413** on `/mcp` means the request body was larger than 1 MB — send files as uploads, not inline.

**An upload's `PUT` is refused.** The connection is closed after the answer, so a refused body is never read. A
missing token (`401`), an address that may not connect or a browser's `Origin` (`403`) get the same plain answers as
`/mcp`; the upload's own refusals are JSON with a Swedish `error`: `403` from another machine than the one that began
the upload, `404` for an unknown or expired upload, `409` when it isn't waiting for a file (already received, fetched
from a URL, or another `PUT` is still sending it), `411` without `Content-Length` or with a chunked body, `400` when
the length differs from `bytes`, `413` when more bytes came than declared, `408` after 60 seconds without data or
30 minutes in all (send it again; `get_upload` keeps the reason in `error`), `422` when the file isn't what it
should be (a wrong `sha256`, a picture that doesn't decode) and `507` when it would leave less than 2 GB free on the
library's disk.

**"Studio-fönstret svarar inte – är det öppet?"** ("the Studio window doesn't answer — is it open?"): the form
tools need the window. On macOS, closing the window keeps Studio running; click its Dock icon to open it again.

**"Studio har inget bibliotek öppet"** (Studio has no library open): choose a base folder in Studio first.

To test the connection by hand, an `initialize` request should return `200` and an `mcp-session-id` header:

```bash
curl -i http://127.0.0.1:8770/mcp \
  -H "Authorization: Bearer $STUDIO_MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```
