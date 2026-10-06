import type { PromptLanguage } from '@shared/types'

// What an agent needs to know to work well in Studio, written for an LLM: how Studio is put together and how
// to write prompts for Seedance-class video models. Served as the get_studio_guide tool, the
// write_video_prompt prompt and the studio://guide resource.

const LANGUAGE_NAMES: Record<PromptLanguage, string> = { en: 'English', sv: 'Swedish' }

/** Short version for the MCP initialize result, which clients usually put into the agent's system prompt. */
export function serverInstructions(lang: PromptLanguage): string {
  return [
    "Studio is a desktop video studio on the user's Mac. It generates short video clips with Venice.ai's video",
    'models (Seedance 2.5 reference-to-video by default) from prompts and reference photos of characters,',
    'environments and outfits, and chains clips into longer sequences.',
    'Call get_studio_guide once before you start: it explains @ImageN references and how to write prompts that',
    'work. Everything is free to prepare (references, prompts, the Generate form, sequences), but every',
    'generation costs the user real money: request_generation, request_segment_generation and request_generate_all only',
    "ask for the user's approval in Studio, and nothing is generated until they say yes. Talk to them in Swedish; write",
    `video prompts in ${LANGUAGE_NAMES[lang]}. Error messages from Studio are in Swedish.`
  ].join(' ')
}

/** The prompt-writing part of the guide (also what write_video_prompt starts from). */
export function promptWritingGuide(lang: PromptLanguage): string {
  const wearing = lang === 'sv' ? 'i' : 'wearing'
  return `## Writing video prompts (Seedance-class models)

**Language:** write every video prompt in ${LANGUAGE_NAMES[lang]} (the user's setting "Promptspråk"), even though you talk to the user in Swedish.

**One clip is one continuous shot.** A clip is 4–15 seconds of a single camera take. Describe one shot – no cuts, no "then later", no montage, no list of unrelated actions. One main action (two or three closely linked ones at most) that fits the clip's duration.

**Order the prompt like a shot description:**
1. **Subject** – who or what is in the shot, each with its @ImageN reference right after the name, plus one or two distinctive visual traits.
2. **Action** – what happens during the clip, in order, with concrete verbs of motion and pacing ("slowly turns her head", "breaks into a run halfway through").
3. **Camera / shot** – shot size and angle (close-up, medium shot, wide shot, low angle, over-the-shoulder) and camera movement (static, slow dolly-in, tracking shot alongside, handheld, crane up, orbit).
4. **Lighting and mood** – time of day, light quality and direction, colour palette, atmosphere (golden hour backlight, overcast soft light, neon reflections on wet asphalt).
5. **Style** – photorealistic / cinematic 35 mm film / documentary handheld / anime / claymation …, plus texture details (shallow depth of field, film grain).

**Reference people, outfits and places by their tokens, right next to their names.** Put all photos of one asset together in one parenthesis:
\`Anna (@Image1, @Image2) ${wearing} the red dress (@Image3) walks along the beach promenade (@Image4) …\`
- Use the token map Studio gives you (set_references, get_workspace, get_sequence, validate_prompt). Never guess numbers: @Image3 is whatever the third reference image is, and a wrong token sends the wrong picture in a paid generation.
- Mention every reference image somewhere in the prompt; an unmentioned image still influences the result in unpredictable ways.
- Tokens only exist in reference-to-video mode. Text-to-video and image-to-video prompts must not contain any @ tokens.
- The photos carry identity (face, exact garment, the place). Use the text for what the photos can't say: action, expression, camera, light. Keep any appearance you do mention consistent with the asset's description and photos – never contradict them (no "blonde" for a dark-haired character).

**Describe motion over time.** Say how the clip starts, what changes and how it ends: "She stands at the railing looking out to sea, then turns towards the camera and smiles as the wind lifts her hair." Video models follow verbs and timing; static descriptions give static clips.

**Be concrete and visual.** Describe what the camera sees, not intentions ("make it epic", "a beautiful moment"). Avoid contradictions (sunny and rainy, night and midday sun), more than three characters, small legible text, and complicated hand interactions.

**Length:** usually 40–120 words. Respect the model's prompt_character_limit (list_models).

**Audio:** when audio is on, the model also makes sound. You may describe ambience and sounds ("waves crashing, gulls in the distance") and short spoken lines in quotes with who says them: \`Erik says: "Kom, vi går."\` Keep dialogue short – a line or two per clip.

**Negative prompt:** a short comma-separated list of things to avoid, e.g. \`blurry, distorted faces, extra fingers, text, watermark, flicker\`. Leave it empty unless there is a recurring problem. Don't put negations ("no people") into the main prompt – they tend to summon what they name; use the negative prompt instead.

**Continuation clips (sequences):** a clip with continue_from_previous starts from the last frame of the previous clip's selected take and is generated image-to-video, without reference images and without @ tokens. Write only what happens next, starting exactly where the previous clip ended – same people, same place, same light, same position – and describe them in words (names and looks) instead of tokens: "The woman keeps walking along the promenade, then stops and looks back over her shoulder; the camera slowly pushes in." Don't re-introduce the scene as if it were new, and don't change the location or time of day abruptly.

**A good reference-to-video prompt:**
\`Erik (@Image1, @Image2) ${wearing} the dark green rain jacket (@Image3) walks along the wet harbour pier (@Image4) at dusk, hands in his pockets, then stops and looks out over the water as a ferry passes in the background. Medium tracking shot alongside him at walking pace, ending in a slow push-in on his face. Cold blue twilight with warm lamp reflections on the planks, light drizzle. Cinematic, photorealistic, shallow depth of field, subtle film grain.\`
`
}

/** The whole guide (get_studio_guide and studio://guide). */
export function studioGuide(lang: PromptLanguage): string {
  return `# Studio – guide for agents

Studio is a desktop app for making videos with Venice.ai's video models. You are connected to it over MCP to help the user: gather the right references, write strong prompts, keep characters, outfits and places consistent across clips, build sequences, and prepare generations. The user talks to you in Swedish; video prompts are written in ${LANGUAGE_NAMES[lang]}.

**Money:** every generation costs the user real money (Studio tells you the price as price_usd before anything is generated). Preparing is free. Paid steps only ever create an approval request that the user answers in Studio – see "Approvals" below. Never try to get around that, and don't ask again for something they declined unless they ask you to.

## The library: characters, environments and outfits
Studio keeps three kinds of **assets**, each with a name, a description written by the user and ordered photos (photo 1 is the cover):
- **character** (karaktär) – who is in the shot. A character can have a **default outfit** (default_outfit_id).
- **environment** (miljö) – where the shot takes place.
- **outfit** (klädsel) – what a character wears.

Use list_assets to see them and get_asset to look at the photos (you get the images). Read the descriptions: they say what the user cares about (age, hair, style, the mood of a place). You can create assets and edit names, descriptions and default outfits, but photos can only be added by the user in Studio.

## Modes (model kinds)
- **reference-to-video** (default, \`seedance-2-5-reference-to-video-basic\`): the model gets up to N reference images (9 for Seedance, see max_reference_images in list_models) and the prompt refers to them as @Image1 … @ImageN. Best for putting the user's characters in their outfits and places.
- **image-to-video**: a start image becomes the first frame and the prompt describes what happens from there. No reference images, no tokens. Good when the opening frame must be exact (e.g. a photo of an environment).
- **text-to-video**: prompt only.
Each model has its own durations, resolutions, aspect ratios and audio option (list_models). Defaults: 8s, 480p, 16:9, audio on.

## References and @ImageN tokens
- The Generate form – and every clip of a sequence – has an ordered list of reference images. The first image is @Image1, the second @Image2, and so on. Write tokens exactly like \`@Image3\` (no space, no leading zero).
- set_references adds whole assets (all their photos, or the image_ids you pick) in order and answers with the token map: \`{token: "@Image1", asset_name: "Anna", kind: "character", photo_number: 1}\`. Build the prompt from that map.
- The image budget is small: usually 1–3 photos per character (clear face, different angles), 1–2 per outfit (the whole garment), 1–2 per environment. Choose the clearest photos with get_asset and pass their image_ids.
- **Default outfits are not added automatically by set_references** (Studio's own picker does add them). If a character should wear its default outfit, add that outfit too; if the scene needs other clothes, add the other outfit instead – never both.
- Studio refuses to generate when a token points at no picture, past the model's limit, is malformed ("@Image 3", "@img3") or appears in a mode without references. validate_prompt shows those problems (Swedish messages) before anything is paid for; warnings mean a reference is never mentioned.

${promptWritingGuide(lang)}
## The Generate form and the workspace
- get_workspace shows what the user is looking at (view, open sequence and clip) and the Generate form: mode, model, settings, prompt, the reference token map, validation issues and the price.
- set_form changes the form (mode, model, duration, resolution, aspect ratio, audio, prompt, negative prompt, start image) and switches Studio to the Generate view; set_references sets its reference images. The user sees every change live in Studio, so tell them what you changed.
- open_in_studio brings the Generate view or a sequence clip to the front.
- save_prompt stores a prompt in the user's prompt library (list_prompts reads it; it may hold prompts they like).

## Sequences: films longer than one clip
- A **sequence** is an ordered list of **clips** (segments). Each clip has its own prompt, references and settings, and any number of **takes** (generations); one take per clip is selected for the cut, and Studio exports the selected takes as one film.
- **continue_from_previous**: the clip starts from the last frame of the previous clip's selected take (image-to-video, no references, no tokens). Use it for one continuous action across clips. The first clip can't continue.
- A clip that doesn't continue is a new shot (new angle, new place, a cut): give it its own references so the characters stay recognisable, and keep their descriptions consistent with the other clips.
- Plan the film as a short shot list first, then add_segment per clip, check with get_sequence (it validates each clip), and ask for request_generate_all – Studio generates the missing clips in order, waiting for each one, so continuation clips get the frame they need.
- While "Generera saknade" (generate all) runs for a sequence, its clips can't be changed (generate_all_running in get_sequence); wait until it is done.

## Approvals (paid generations)
- request_generation (the Generate form), request_segment_generation (one clip) and request_generate_all (every clip without a finished take) check everything first and then create an **approval request** with the price. Studio shows the user a dialog with the prompt, references and price; nothing is generated before they approve.
- They answer at once with \`{approval_id, status: "pending", price_usd}\`. Tell the user briefly what is waiting (in Swedish), then poll get_approval every 15–30 seconds: \`pending\` → \`approved\` (with generation_ids) / \`declined\` (maybe with their reason) / \`expired\` (after 30 minutes) / \`failed\` (with the error).
- Asking again for exactly the same thing while it is pending returns the same request. A new request for the same clip replaces the older pending one.
- After approval, generation takes a few minutes. Follow it with get_generation (or get_sequence) until it is completed or failed, then look at the result (get_generation gives you the poster frame, and \`frames\` gives more frames) and suggest improvements.

## Working together with the user
- The user sees Studio while you work. Keep them informed in short Swedish messages: what you prepared, which references you chose and why, the price.
- Prefer improving the current form or clip over starting from scratch, and keep what they wrote unless they ask you to replace it.
- Error messages from Studio are Swedish and written for the user – relay or act on them.

## A typical workflow
1. get_workspace and list_assets (get_asset for the photos of the assets you might use).
2. set_form({mode: "reference-to-video"}), then set_references with the chosen character(s), outfit(s) and environment.
3. Write the prompt from the returned token map; set_form({prompt, negative_prompt}).
4. validate_prompt({use_form: true}) and fix every error.
5. request_generation({note: "…why…"}), tell the user it is waiting for their OK, poll get_approval.
6. get_generation to review the result; iterate.
`
}
