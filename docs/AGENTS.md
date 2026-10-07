# Connecting your own agent (MCP)

Studio can run a [Model Context Protocol](https://modelcontextprotocol.io) server so that AI agents you run
yourself — for example OpenClaw, Hermes Agent, Claude Desktop or Claude Code — can work in the app alongside you.
An agent can read the library, look at its photos and listen to its voices, choose reference images and voice clips,
write and validate prompts, fill in the Generate form, build sequences — notes per clip, start and end images
(keyframes), stills — and set a bad clip up to be redone between its neighbours, and plan films as storyboards:
the milestones as boards with notes and pictures, and the prompts of the transitions generated between them. It can
also look back at what the generations became — frames of finished clips and exported films next to the references
they were made from, and their sound — record reviews, and save *learnings* (*Lärdomar*) that every later session
reads before it writes a prompt. Everything an agent prepares, reviews or records is free.

**An agent can never spend money on its own.** The six paid tools only create an *approval request*. Studio
shows it to you with the prompt, the reference images, the voices and the price, and nothing is sent to Venice
until you click *Godkänn och generera* (approve and generate) — or *Godkänn och skapa* for a picture.

- [Enabling the server](#enabling-the-server)
- [Addresses and token](#addresses-and-token)
- [Client configuration](#client-configuration)
- [Tools](#tools)
- [The approval flow](#the-approval-flow)
- [Prompt-writing guidance](#prompt-writing-guidance)
- [Reviews and learnings](#reviews-and-learnings)
- [Troubleshooting](#troubleshooting)

## Enabling the server

1. Open **Inställningar → Agentanslutning** (Settings → Agent connection).
2. Switch on **Tillåt agenter att ansluta** (allow agents to connect). It is **off by default**, and the setting is
   per profile: Studio Dev and Studio.app each have their own switch, port and token.
3. The status line shows where Studio listens. The indicator at the bottom of the sidebar shows whether an agent is
   connected; click it to open the activity drawer with every tool call and the pending requests.

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

Studio offers **60 tools** — 26 that read, 28 that write (free) and 6 paid ones that only ask for approval — plus
one prompt and one resource. Tool errors come back as readable tool errors; their messages are in Swedish, like the
app's UI. Tools that touch the library fail with an explanation until a library is open, and the tools that read or
fill the Generate form need the Studio window to be open.

| Area | Read | Write | Paid |
| --- | --- | --- | --- |
| Guide and library (`tools/library.ts`) | `get_studio_guide`, `list_assets`, `get_asset`, `list_models`, `list_prompts`, `list_generations`, `get_generation` | `create_asset`, `update_asset`, `update_asset_audio`, `save_prompt` | |
| Generate form (`tools/form.ts`) | `get_workspace`, `validate_prompt` | `set_form`, `set_references`, `reorder_references`, `open_in_studio` | |
| Sequences (`tools/sequences.ts`) | `list_sequences`, `get_sequence` | `create_sequence`, `add_segment`, `update_segment`, `delete_segment`, `move_segment` | |
| Stills and keyframes (`tools/stills.ts`) | `list_image_models`, `list_stills`, `get_still`, `preview_segment_frames` | `save_frame_as_still`, `bridge_segment` | |
| Storyboards (`tools/storyboards.ts`) | `list_storyboards`, `get_storyboard`, `preview_transition` | `create_storyboard`, `update_storyboard`, `add_board`, `update_board`, `move_board`, `delete_board`, `update_transition`, `convert_storyboard_to_sequence` | |
| Approvals (`tools/paid.ts`) | `get_approval` | | `request_generation`, `request_segment_generation`, `request_generate_all`, `request_transition_generation`, `request_generate_storyboard`, `request_image_generation` |
| Reviews and learnings (`tools/review.ts`) | `review_generation`, `get_frames`, `list_exports`, `review_export`, `review_sequence`, `list_reviews`, `list_learnings` | `add_review`, `delete_review`, `save_learning`, `update_learning`, `delete_learning` | |
| **Total (60)** | **26** | **28** | **6** |

**Images and sound.** Tools that return media send pictures as MCP image content (JPEG) and sound as MCP **audio
content** (MP3, mono), each preceded by a text label that says what it is (`Reference @Audio1 = Anna's voice
(window 0–8 s)`, `t = 2.4 s – frame 3 of 6`). Sound is only sent when asked for — `include_audio` on `get_asset`,
`review_generation` and `review_export`, or `audio_id` on `get_asset` — because it is large. Audio content arrived
with MCP protocol version 2025-03-26: Studio reads the version from the client's `initialize` request (and the
`MCP-Protocol-Version` header), and a client on an older version gets a one-line note that the sound was left out
instead of content it would reject. Whether an agent can actually listen depends on its client and model; the
frames, reference images and text work without it.

### Read (26 tools; change nothing)

| Tool | What it does |
| --- | --- |
| `get_studio_guide` | How Studio works and how to write video prompts for it (voices, poses and the review loop included), ending with the learnings recorded so far. Read once at the start of a session. |
| `get_workspace` | What the user is looking at (view, open sequence and clip, or open storyboard) and the Generate form: mode, model, settings, prompt, reference token maps (`@ImageN` and `@AudioN`), pictures past the model's limit (`not_sent`), `composed_prompt` (the prompt as it is sent, with the References legend of the referenced assets' descriptions) and `description_entries`, validation issues, price. |
| `list_assets` | Characters, environments, outfits and poses with ids, descriptions, photo ids, default outfits and — for characters and environments — their audio clips (`audio_id`, role `voice` or `soundscape`, duration, reference window `clip_start` / `clip_length`); optional `kind` and `query` filters. |
| `get_asset` | One asset with its photos as images (JPEG, at most 768 px; `max_images` 1–12, default 4), each labelled with its photo number and `image_id`; for an outfit, the characters wearing it by default. With `include_audio` (the first clip, or the one named by `audio_id`) also a clip's reference window as MP3 audio, exactly as Venice would get it. |
| `list_models` | Venice's usable video models (optionally one `kind`) with mode, durations, resolutions, aspect ratios, reference image limit, whether they take reference audio (`audio_input`, `max_reference_audios`), audio and prompt length limit; the default model is marked. |
| `list_prompts` | The prompt library, favourites first. |
| `list_generations` | Generations filtered and sorted like Studio's clip feed (`query`, `status`, `model`, `asset_id`, `min_rating`, `unrated`, `since_days`, `placement`, `has_reviews`, `sort`, `limit` 1–50 default 20, `offset`), each with status, prompt, settings, price, the user's rating, review count and a reference summary, plus totals for the filtered set. |
| `get_generation` | One generation with its token maps, `sent_prompt` (what Venice got, when descriptions were appended), the sequence clip or storyboard transition it is a take of (with the boards it goes between), the user's rating and every review, its poster frame and optionally up to 6 `frames` from the video. |
| `list_sequences` | Sequences with clip count and the length of the current cut. Storyboards are not listed (a note points to `list_storyboards`). |
| `get_sequence` | One sequence (a storyboard's id is refused with a pointer to `get_storyboard`) with its clips and its number of stills; each clip with its `notes`, token maps, `composed_prompt` and `description_entries`, `start_image` / `end_image` (`{kind: "previous" \| "next", from_clip}`, `{kind: "image", still_id \| asset_image_id, path}` or null), `continue_from_previous`, `end_from_next`, `supports_end_image`, validation issues, `frame_problems` (why its neighbours' frames can't be had yet) and selected take; poster frames with `include_thumbnails` (default true). |
| `validate_prompt` | Checks a prompt's `@ImageN` and `@AudioN` tokens (and the audio windows) against the form's references or a given set — the same check Studio applies before every paid generation — and answers with `composed_prompt` and `description_entries` (`include_descriptions` / `excluded_description_asset_ids` try other switches), measured against the model's `prompt_character_limit`. |
| `get_approval` | The state of an approval request: `pending`, `approved` (with `generation_ids`, or for an image request the `still_id` and whether it was put into its clip), `declined`, `expired` or `failed`. |
| `list_image_models` | Venice's image models for `request_image_generation`, with the price of one picture: text-to-image models (prompt only) and models that combine up to `max_input_images` references; the Seedream defaults are marked. Also says whether *Säkert läge för bilder* is on (`safe_mode`: Venice blurs adult content; only you can switch it, under Inställningar → Bilder). |
| `list_stills` | The stills of a sequence or a storyboard (`sequence_id` or `storyboard_id`; or all), newest first: generated pictures, uploaded pictures and saved frames, each with its prompt, model, references and `used_by` (the sequence clips using it as start or end image and the storyboard boards showing it); small thumbnails with `include_thumbnails` (default true). |
| `get_still` | One still as an image, with its settings and the clips and boards that use it; with `include_references` also the pictures it was made from (the base first). |
| `preview_segment_frames` | The start and end image a clip would be generated from right now — the previous clip's last frame and the next clip's first frame (with the time in that take), or the clip's own keyframes — as images, plus why it can't be generated yet. |
| `list_storyboards` | Storyboards, most recently changed first, with their number of boards and transitions and how many transitions have a finished take. |
| `get_storyboard` | One storyboard: its format, the boards in order with their notes ("Vad visar bilden?") and pictures (a still or a library photo; `aspect_mismatch` when its shape differs from the storyboard's), and the transitions between them with the boards they join, prompt, settings, `ready` / `problems`, takes and the selected take (`made_from_earlier_pictures` when a board's picture changed since). With `include_images` (default true) the board pictures and the selected takes' poster frames come as images. |
| `preview_transition` | The two pictures a transition goes between — the first board's (its start) and the next board's (its end) — as images, with the boards' notes, the transition's prompt and settings, whether it is ready and its price. |
| `review_generation` | What a finished generation became: prompt, settings, token maps, price, the user's rating and all reviews, `frames` frames evenly spaced from the first to the last (1–12, default 6; JPEG 512 px wide, captioned "t = 2.4 s"), the reference images (or start and end image — for a storyboard transition the two board pictures) it was made from (`include_references`, default true), and with `include_audio` its sound and the reference voice windows as MP3. Ends with a review checklist (for a transition also whether it starts on the first picture and ends on the second) and the suggested tags. |
| `get_frames` | Frames of a generation (`generation_id`) or an exported film (`export_id`) at up to 12 given times (times past the end give the last frame), `width` 256–768 px (default 512). |
| `list_exports` | Exported films of sequences and storyboards, newest first (optionally of one `sequence_id` or `storyboard_id`; `limit` default 20), with the sequence or storyboard, file, date, length and whether the file still exists. |
| `review_export` | A whole exported film (of a sequence or a storyboard): when it still matches its sequence or storyboard, the clips (a storyboard's transitions) with their place in the film, `frames_per_clip` frames inside each clip (1–4, default 2) and the last frame before and first frame after every cut (`include_cut_frames`), at most 24 frames; otherwise evenly spread frames and a note why the cuts are unknown. With `include_audio`, up to 30 s of its sound from `audio_start`. |
| `review_sequence` | A sequence clip by clip: prompt, references, continuation, the selected take's rating and review count, and `frames_per_clip` frames of it (2–6, default 3; first and last frame included, within the trims; at most 30 frames in all), plus continuity hints for every cut. |
| `list_reviews` | Reviews by the user (author `user`) and agents, most recently changed first (for one generation: the user's first), filtered by `generation_id`, `author`, `tag` or `min_rating`; outside a single generation each comes with that generation's prompt and model. |
| `list_learnings` | The learnings so far, pinned first, then the most recently changed; filters `query` (every word in the title, insight, model or tags), `model` (that model's plus the general ones), `tag`, `author`; `limit` default 50. Also tells the agent the name its own reviews and learnings are recorded under (`your_name`). |

### Write (28 tools; free, change the library or the form)

| Tool | What it does |
| --- | --- |
| `set_form` | Fills in the Generate form (mode, model, duration, resolution, aspect ratio, audio, prompt, negative prompt, start image, and which descriptions are appended: `include_descriptions`, `excluded_description_asset_ids`) and shows the Generate view. All or nothing: invalid values change nothing. |
| `set_references` | Sets the form's reference images and audio from assets, in order (`replace` or `append`): all photos or chosen `image_ids` (`[]` for none, e.g. only a voice); with a model that takes reference audio, a character's first voice clip unless `include_voice` is false, an environment's first sound clip with `include_voice: true`, or chosen `audio_ids`. Switches the form to reference-to-video if needed and returns the token maps (`references`, `audio_references`) to write the prompt with. Photos and clips over the model's limits (9 images for Seedance; 3 clips, 15 s of audio in all) are listed in `not_added` / `not_added_audio`, and so is a default voice under 2 s (no model takes it). Replacing the references doesn't renumber the prompt's tokens; `reorder_references` does. |
| `reorder_references` | Changes the order of the form's (`target: "form"`, default) or a clip's (`target: {segment_id}`) reference images (`images`) and/or audio clips (`audios`), like dragging a thumbnail in Studio, and renumbers every `@ImageN` / `@AudioN` in the prompt and negative prompt so each keeps pointing at the same picture or clip: references [A, B, C] with "@Image1 hugs @Image3", `images: ["@Image3"]` → [C, A, B] and "@Image2 hugs @Image1". References are named by token, `image_id` / `audio_id` or `asset_id` (all of that asset's photos or clips); the named ones come first, the rest keep their order. Answers with the new token maps, `moved` (old → new token), the prompt, `composed_prompt` and the pictures past the model's limit (`not_sent`; moving one forward sends it). Not for a clip that sends no references. |
| `open_in_studio` | Brings the Generate view, a sequence (optionally one clip) or a storyboard to the front. |
| `create_asset` | Creates a character, environment, outfit or pose with a name and description. Photos and audio clips can only be added by the user in Studio. |
| `update_asset` | Changes an asset's name, description or (characters) default outfit. Renaming also renames its folder. The description is appended to every later prompt that sends the asset's photos or voice. |
| `update_asset_audio` | Moves or resizes an audio clip's reference window (`clip_start`, `clip_length`); Studio keeps it 2–15 s inside the file and says when it adjusted it. |
| `save_prompt` | Saves a prompt to the prompt library. |
| `create_sequence` | Creates an empty sequence with the default settings. |
| `add_segment` | Adds a clip (`notes`, prompt, references with the same items as `set_references`, model and options, `include_descriptions` / `excluded_description_asset_ids` (by default those of the clip before), `continue_from_previous`, `end_from_next`, `start_image` / `end_image`), validated like a generation. A clip that continues from the previous one, or has a start or end image, is image-to-video and takes no references, so no voices either. |
| `update_segment` | Changes a clip; only the fields passed change (`references` replaces its photos and audio; `include_descriptions` / `excluded_description_asset_ids` choose the descriptions appended to its prompt). `start_image` / `end_image` take `{still_id}`, `{asset_image_id}`, `{generation_id, time}` (a frame, saved as a still), `"previous"` / `"next"` or `null`; a picture makes the clip image-to-video (with a model that takes an end image when it has one), drops its references and takes the `@` tokens out of a prompt the agent didn't rewrite. `selected_take_id` chooses which of its finished takes is in the cut. Existing takes are kept. |
| `delete_segment` | Removes a clip (marked destructive). Its takes are kept as ordinary generations. |
| `move_segment` | Moves a clip to another position (`to_clip_number`, 1-based). |
| `save_frame_as_still` | Saves a frame of a finished clip (`generation_id`, `time` in seconds) as a still of a sequence or a storyboard (`sequence_id` / `storyboard_id`; by default the clip's own), to use as a board's picture, a keyframe or a reference. The frame is the first one at or after `time`, as `review_generation` and `get_frames` show it, so a time from their `frame_times` / `times` (given to the millisecond, like the captions) saves exactly the frame the agent looked at. |
| `bridge_segment` | *Gör om mellan grannarna*: sets a clip to start on the previous clip's last frame and end on the next clip's first frame (only the one that exists for the first or last clip) with its family's image-to-video model that takes an end image, keeping duration, prompt and audio but dropping its references (image-to-video can't take them; their `@` tokens go from the prompt too). Answers with both frames, any problems, notes and the price. Generating the new take is still `request_segment_generation`; the clip's old takes are kept. |
| `create_storyboard` | Creates a storyboard (`name`, `aspect_ratio`: 16:9 by default, or 9:16, 1:1, 4:3, 3:4, 21:9) with its folder; `board_notes` creates one board per note (at least two boards), with the transitions between them. |
| `update_storyboard` | Renames a storyboard (its folder follows) or changes its format. |
| `add_board` | Adds a board at the end, or after / before another one, with a `note` and optionally a picture: `{still_id}`, `{asset_image_id}` (a library photo, used where it is) or `{generation_id, time}` (a frame of a finished clip, saved as a still of the storyboard). The transitions follow: one between every two neighbouring boards. |
| `update_board` | Changes a board's note and/or picture (`image: null` empties it). The transitions to and from it get the new picture; their takes stay (a selected one is then `made_from_earlier_pictures`, until a take made from the new picture is done and becomes the selected one). |
| `move_board` | Moves a board to another place (`to_board_number`, 1-based). Transitions between boards that are no longer neighbours are removed — their takes stay as ordinary generations — and new neighbours get new transitions with empty prompts; the answer lists what was removed. |
| `delete_board` | Removes a board (marked destructive); its two transitions are replaced by one between its neighbours, their takes stay as ordinary generations, and its picture stays among the stills. |
| `update_transition` | Changes a transition's `prompt` (the motion from the first picture to the second; no `@` tokens), `negative_prompt`, `duration`, `resolution`, `audio`, `model` (only image-to-video models that take an end image) or `selected_take_id` (one of its finished takes). |
| `convert_storyboard_to_sequence` | Makes an ordinary sequence, "<storyboard> (sekvens)", with one clip per transition and a copy of each transition's selected take, so the film can be edited further in Sekvenser. The storyboard stays as it is. |
| `add_review` | Records the agent's review of a generation (rating 1–5, up to 12 tags, a note) under its own name; each call adds a new review. |
| `delete_review` | Deletes one of the agent's own reviews (marked destructive). |
| `save_learning` | Records a learning: title, insight, optional model (left out: every model), tags and evidence (up to 50 generation ids, which must exist). |
| `update_learning` | Changes one of the agent's own learnings; only the fields passed change (`model: null` makes it general, `evidence` replaces the list). Not one the user has pinned or edited. |
| `delete_learning` | Deletes one of the agent's own learnings (marked destructive). Not one the user has pinned or edited. |

While *Generera saknade* runs for a sequence or a storyboard, agents cannot change its clips, boards or transitions.

### Paid (6 tools; create an approval request, nothing is generated until the user approves)

| Tool | What it asks for |
| --- | --- |
| `request_generation` | Generating the Generate form as it is now (captured at request time). |
| `request_segment_generation` | A new take of one sequence clip. Lapses if the clip changes before approval — for a clip that takes frames from its neighbours, also if a neighbour's take or trim changes. |
| `request_generate_all` | Every clip of a sequence without a finished selected take, in the order their frames allow (a clip that ends on the next clip after that clip); the price is the sum. Lapses if the clips change. |
| `request_transition_generation` | A new take of one storyboard transition: from the first board's picture to the next board's, with the transition's prompt and settings. Both boards need pictures and the prompt must be written. Lapses if a board's picture, the transition or the pair of boards changes before approval. |
| `request_generate_storyboard` | Every transition of a storyboard without a finished selected take (and none rendering); they are independent of each other, so the order doesn't matter. Refused, naming the transition, unless all of them are ready; the price is the sum. Lapses if the boards' pictures or the transitions change. |
| `request_image_generation` | One still (about $0.06 with the default Seedream models), typically a board's picture or a keyframe: an English prompt, optionally references (`reference_still_ids`, `reference_image_ids` for library photos, `reference_asset_ids` for assets' cover photos, sent in that order — after the previous board's picture with `previous_board_as_reference`; the first is the base picture), model, aspect ratio (default the storyboard's or sequence's, or the clip's with `assign_to` a clip), resolution, quality, a negative prompt (text-to-image models only), the storyboard or sequence it belongs to (`storyboard_id` / `sequence_id`), and `assign_to` a board (`{board_id}`) or a clip's start or end slot (`{segment_id, slot}`). Checked and priced exactly like *Skapa bild…* in the window; the answer also says whether *Säkert läge för bilder* is on (`safe_mode`). Saved as a still of the storyboard or sequence once approved (with neither: in `Referensbilder`), and made the board's picture or put into the slot when `assign_to` names one. Refused while *Generera saknade* runs there; lapses if the board moves, is removed or gets another picture, or the clip moves or its slot starts or stops taking a neighbour's frame, before approval. A picture the user puts onto the board while the image is being made stays: the new still is kept, not put in, and the answer's `notice` says so. |

Each takes an optional `note` (up to 500 characters) that is shown to the user in the approval dialog.

### Prompt and resource

| Name | Kind | What it is |
| --- | --- | --- |
| `write_video_prompt` | MCP prompt | Starts a prompt-writing task (optional `idea`, optional `segment_id` or `transition_id`) with the actual reference token maps (photos and voices) — or, for a clip with a start or end image, what it starts and ends on; for a storyboard transition, the two boards with their notes — the clip's notes, the learnings that apply to the model and the prompt-writing guide. |
| `studio://guide` | MCP resource (Markdown) | The same guide as `get_studio_guide`, with the learnings so far. |

### What agents cannot do

Agents cannot add or remove photos, add, remove or reorder an asset's audio clips (only move a clip's reference
window; the order of a form's or clip's *references* is theirs to change with `reorder_references`), upload pictures
or delete stills (they can save frames and ask for generated pictures), delete assets, prompts, generations,
sequences or storyboards, rename sequences, export films, change settings (*Säkert läge för bilder* included),
switch the library, or approve anything. They cannot set the user's own rating, note or tags, pin learnings, or
change or delete reviews and learnings written by the user or by other agents; their own reviews can be deleted but
not edited. Their own learnings stop being theirs to change once the user pins one (it can no longer be updated or
deleted by agents) or edits it (it becomes the user's). Every change goes through the same services as the window,
with the same validation.

## The approval flow

1. The agent prepares the form or a clip and calls a paid tool. Studio validates it first (prompt, start image or
   references, `@ImageN` and `@AudioN` tokens, and for a clip the neighbours' frames it takes; for a picture the
   model, the number of references, the files and the format, exactly as *Skapa bild…* checks them); a problem
   comes back as an error and no request is made. The audio files are also measured (for `request_generate_all`,
   those of every clip that doesn't continue from the one before), so a window that is under 2 s, past the end of
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
5. The agent polls `get_approval` (every 15–30 seconds is plenty) and then follows the result with `get_generation`,
   `get_sequence` or `get_storyboard` — or, for a picture, `get_still`. A picture is made while the dialog waits
   (*Skapar bilden…*, usually 10–30 seconds), and the dialog then shows it to you too; if it couldn't be put into
   its clip or onto its board, `get_approval` says why in `notice` (the picture is saved among the stills either
   way).

A request **expires** after 30 minutes without an answer, and immediately when the token is replaced, the library
is switched or the agent connection is switched off.

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
- `include_descriptions: false` (on `set_form`, `add_segment`, `update_segment`, `validate_prompt`) sends the prompt
  alone; `excluded_description_asset_ids` leaves out chosen assets (`[]` appends all again). A new clip starts with
  the switches of the clip before it.
- `reorder_references` changes the order of a form's or clip's references and renumbers every `@ImageN` /
  `@AudioN` in the prompt and the negative prompt with it, the same way dragging a thumbnail in Studio does; the
  legend follows the new numbers. `set_references` with `mode: "replace"` does not renumber anything.

## Prompt-writing guidance

The server's `initialize` instructions ask agents to start with `get_studio_guide` and to review what their
generations became. The guide (also available as the `studio://guide` resource) explains assets, the three modes,
`@ImageN` and `@AudioN` references, voices and poses, sequences and continuation clips, keyframes and stills,
storyboards (plan the milestones as boards with notes; make each board's picture with `request_image_generation`
from the characters, outfits, environment and pose, with the previous board's picture as the base for continuity;
write each transition's prompt as the motion from picture A to picture B; generate, review, regenerate), making
pictures, replacing a clip between its neighbours (review → `bridge_segment` → look at the frames →
`request_segment_generation` → review again), approvals, the review loop, and how to write prompts for
Seedance-class video models, for transitions and for pictures, and it ends with the learnings recorded so far (the
pinned ones and the ten most recently changed). The `write_video_prompt` prompt starts from the prompt-writing part
of the guide, with the clip's actual references (or, for an image-to-video clip, the prompts of the neighbours it
starts and ends on; for a transition, its two boards and their notes), its notes and the learnings for its model.
Agents are asked to talk to the user in Swedish and to write video prompts in the language chosen under
**Inställningar → Promptspråk** (English by default). The guide tells them that the descriptions of the referenced
assets are appended automatically as a References legend — so they write the action, camera and mood instead of
repeating them — and the `write_video_prompt` context lists the descriptions that will be appended. Image prompts
are always English: one still frame — subject, composition and framing, place, light and style — referring to the
references as "image 1", "image 2" … in the order they are sent, never with `@` tokens.

## Reviews and learnings

The point of the review tools is better prompts: an agent looks at what earlier prompts actually produced, writes
down what it saw, and turns what generalises into *learnings* that every later session reads first. The guide and
the server instructions ask agents to close the loop after every generation they requested, and whenever you ask
them to look at earlier clips or films:

1. **Find** — `list_generations` with the clip feed's filters, e.g. the clips you rated highest
   (`{sort: "rating", min_rating: 4}`), the clips of one character (`asset_id`), or finished clips nobody has
   reviewed yet (`{status: "completed", has_reviews: false}`); `list_exports` for exported films.
2. **Look** — `review_generation` returns the frames next to the reference images the clip was made from (and, with
   `include_audio`, its sound next to the reference voices); `get_frames` looks closer at a moment. For a film,
   `review_sequence` shows every clip's selected take with hints for each cut, and `review_export` shows an exported
   film around its cuts.
3. **Record** — `add_review`: an honest rating, tags from the suggested vocabulary (`prompt-followed`,
   `prompt-ignored`, `identity-drift`, `wrong-outfit`, `wrong-pose`, `bad-motion`, `good-motion`, `camera-good`,
   `camera-wrong`, `artifacts`, `voice-match`, `voice-mismatch`, `continuity-good`, `continuity-break`,
   `lighting-good`, `lighting-wrong`; other tags are allowed) and a specific note that names tokens and moments.
4. **Distil** — `save_learning` for whatever generalises ("Seedance 2.5: naming the outfit right after the
   character's tokens keeps it"), with the model and the generation ids it is based on as evidence;
   `update_learning` when later results refine it, `delete_learning` when they prove it wrong.
5. **Apply** — the learnings come at the end of `get_studio_guide`, the `studio://guide` resource and the
   `write_video_prompt` prompt (the pinned ones and the ten most recently changed; the prompt only those for its
   model and the general ones), and `list_learnings` has them all.

Reviews and learnings are stored in the library's database, so they move with the library and every agent sees the
same ones. In Studio, reviews appear in the clip's detail drawer next to your own rating, note and tags (you can
delete any review there), and learnings in **Prompter → Lärdomar**, where you can write your own and pin, edit or
delete any of them; pinned learnings come first for every agent. Your own rating (author `user`) is what
`list_generations({min_rating})` and `list_reviews({author: "user"})` read, so rating clips is the clearest way to
show agents what you like.

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

**HTTP 404 Not found** means the path is not `/mcp`. A JSON-RPC error *Session not found* (also 404) means Studio
was restarted or the session was closed; a well-behaved client starts a new session automatically.

**HTTP 413** means the request body was larger than 1 MB.

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
