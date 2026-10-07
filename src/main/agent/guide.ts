import type { Learning, PromptLanguage } from '@shared/types'

// What an agent needs to know to work well in Studio, written for an LLM: how Studio is put together, how to
// write prompts for Seedance-class video models (with reference photos, voices and poses), and how to learn from
// what generations actually became. Served as the get_studio_guide tool, the write_video_prompt prompt and the
// studio://guide resource.

const LANGUAGE_NAMES: Record<PromptLanguage, string> = { en: 'English', sv: 'Swedish' }

/** Short version for the MCP initialize result, which clients usually put into the agent's system prompt. */
export function serverInstructions(lang: PromptLanguage): string {
  return [
    "Studio is a desktop video studio on the user's Mac. It generates short video clips with Venice.ai's video",
    'models (Seedance 2.5 reference-to-video by default) from prompts and references – photos of characters,',
    'environments, outfits and poses, and characters\' voices – and chains clips into longer sequences.',
    'Call get_studio_guide once before you start: it explains @ImageN / @AudioN references, how to write prompts that',
    'work, and ends with the learnings earlier sessions recorded – follow them. Everything is free to prepare',
    '(references, prompts, the Generate form, sequences), but every generation costs the user real money:',
    'request_generation, request_segment_generation and request_generate_all only ask for the user\'s approval in',
    'Studio, and nothing is generated until they say yes. When a generation is done, look at what it became',
    '(review_generation), record an honest review (add_review) and save what generalises (save_learning), so the',
    `next prompt is better. Talk to the user in Swedish; write video prompts in ${LANGUAGE_NAMES[lang]}. Error`,
    'messages from Studio are in Swedish.'
  ].join(' ')
}

/** The prompt-writing part of the guide (also what write_video_prompt starts from). */
export function promptWritingGuide(lang: PromptLanguage): string {
  const sv = lang === 'sv'
  const wearing = sv ? 'i' : 'wearing'
  const voice = sv ? 'röst' : 'voice'
  const sound = sv ? 'ljud' : 'sound'
  const posedAs = sv ? 'i posen' : 'posed as in'
  const and = sv ? 'och' : 'and'
  return `## Writing video prompts (Seedance-class models)

**Language:** write every video prompt in ${LANGUAGE_NAMES[lang]} (the user's setting "Promptspråk"), even though you talk to the user in Swedish.

**One clip is one continuous shot.** A clip is 4–15 seconds of a single camera take. Describe one shot – no cuts, no "then later", no montage, no list of unrelated actions. One main action (two or three closely linked ones at most) that fits the clip's duration.

**Order the prompt like a shot description:**
1. **Subject** – who or what is in the shot, each with its references right after the name, plus one or two distinctive visual traits.
2. **Action** – what happens during the clip, in order, with concrete verbs of motion and pacing ("slowly turns her head", "breaks into a run halfway through").
3. **Camera / shot** – shot size and angle (close-up, medium shot, wide shot, low angle, over-the-shoulder) and camera movement (static, slow dolly-in, tracking shot alongside, handheld, crane up, orbit).
4. **Lighting and mood** – time of day, light quality and direction, colour palette, atmosphere (golden hour backlight, overcast soft light, neon reflections on wet asphalt).
5. **Style** – photorealistic / cinematic 35 mm film / documentary handheld / anime / claymation …, plus texture details (shallow depth of field, film grain).

**Reference people, outfits, places, poses and voices by their tokens, right next to their names.** Put all references of one asset together in one parenthesis – its photos first, then its voice:
\`Anna (@Image1, @Image2, ${voice} @Audio1) ${wearing} the red dress (@Image3) walks along the beach promenade (@Image4) …\`
- Use the token maps Studio gives you (set_references, get_workspace, get_sequence, validate_prompt). Never guess numbers: @Image3 is whatever the third reference image is and @Audio1 whatever the first reference audio clip is; a wrong token sends the wrong picture or voice in a paid generation.
- Mention every reference image and every reference audio clip somewhere in the prompt; an unmentioned one still influences the result in unpredictable ways.
- Tokens only exist in reference-to-video mode. Text-to-video and image-to-video prompts must not contain any @ tokens.
- The photos carry identity (face, exact garment, the place, the body positions of a pose) and the audio carries the voice. Use the text for what they can't say: action, expression, camera, light. Keep any appearance you do mention consistent with the asset's description and photos – never contradict them (no "blonde" for a dark-haired character).

**Voices (@AudioN).** With a model that takes reference audio (audio_input in list_models) a character's voice clip steers the timbre, tone and pacing of how they sound – a style guide, not an exact clone. Keep the clip's token inside the character's parenthesis and attribute spoken lines to the character by name: \`Anna (@Image1, ${voice} @Audio1) says: "…"\`. An environment's sound clip goes with the place: \`the harbour pier (@Image4, ${sound} @Audio2)\`. Keep audio on (set_form audio: true) – without generated sound a voice reference has nothing to shape.

**Poses.** A pose asset is a photo or sketch of how people stand, sit or hold each other and where they are relative to each other and the camera. Its photo carries only the positions – the identities come from the characters' own photos. Name the characters that take the pose, then the pose with its token: \`Anna (@Image1) ${and} Erik (@Image3) ${posedAs} Kram (@Image5)\`, and say the pose in words too ("standing face to face, her arms around his neck"). Use one pose per clip and keep the camera angle close to the pose photo's.

**Describe motion over time.** Say how the clip starts, what changes and how it ends: "She stands at the railing looking out to sea, then turns towards the camera and smiles as the wind lifts her hair." Video models follow verbs and timing; static descriptions give static clips.

**Be concrete and visual.** Describe what the camera sees, not intentions ("make it epic", "a beautiful moment"). Avoid contradictions (sunny and rainy, night and midday sun), more than three characters, small legible text, and complicated hand interactions.

**Length:** usually 40–120 words. Respect the model's prompt_character_limit (list_models).

**Audio:** when audio is on, the model also makes sound. You may describe ambience and sounds ("waves crashing, gulls in the distance") and short spoken lines in quotes with who says them: \`Erik says: "Kom, vi går."\` Keep dialogue short – a line or two per clip.

**Negative prompt:** a short comma-separated list of things to avoid, e.g. \`blurry, distorted faces, extra fingers, text, watermark, flicker\`. Leave it empty unless there is a recurring problem. Don't put negations ("no people") into the main prompt – they tend to summon what they name; use the negative prompt instead.

**Continuation clips (sequences):** a clip with continue_from_previous starts from the last frame of the previous clip's selected take and is generated image-to-video, without references and without @ tokens. Write only what happens next, starting exactly where the previous clip ended – same people, same place, same light, same position – and describe them in words (names and looks) instead of tokens: "The woman keeps walking along the promenade, then stops and looks back over her shoulder; the camera slowly pushes in." Don't re-introduce the scene as if it were new, and don't change the location or time of day abruptly.

**Learnings first:** before you write, check the learnings (the end of get_studio_guide, list_learnings, list_learnings({model}) for the model you use) and apply them – they are what earlier results taught.

**A good reference-to-video prompt:**
\`Erik (@Image1, @Image2, ${voice} @Audio1) ${wearing} the dark green rain jacket (@Image3) walks along the wet harbour pier (@Image4) at dusk, hands in his pockets, then stops, looks out over the water as a ferry passes in the background and says quietly: "${sv ? 'Där är den.' : 'There she is.'}" Medium tracking shot alongside him at walking pace, ending in a slow push-in on his face. Cold blue twilight with warm lamp reflections on the planks, light drizzle. Cinematic, photorealistic, shallow depth of field, subtle film grain.\`
`
}

/** How long a learning's insight is shown in the guide; the full text is in list_learnings. */
const GUIDE_INSIGHT_CHARS = 600

/** The learnings section at the end of the guide: pinned ones and the most recent, titles and insights. */
export function learningsSection(learnings: readonly Learning[]): string {
  if (!learnings.length) {
    return `## Learnings so far
None yet. When you have reviewed results (see "Learning from results"), save what generalises with save_learning – it will appear here for every later session.
`
  }
  const lines = learnings.map((l) => {
    const insight = l.insight.length > GUIDE_INSIGHT_CHARS ? `${l.insight.slice(0, GUIDE_INSIGHT_CHARS - 1)}…` : l.insight
    const meta = [l.pinned ? 'pinned' : undefined, l.model ? `model ${l.model}` : 'all models', `by ${l.author}`]
      .filter(Boolean)
      .join(', ')
    return `- **${l.title}** (${meta}) – ${insight.replace(/\s*\n\s*/g, ' ')}`
  })
  return `## Learnings so far
What earlier reviews taught – pinned ones first (the user chose them), then the most recent. Follow them when you write prompts; list_learnings has them all, with their evidence.
${lines.join('\n')}
`
}

/** The whole guide (get_studio_guide and studio://guide), ending with the learnings recorded so far. */
export function studioGuide(lang: PromptLanguage, learnings: readonly Learning[] = []): string {
  return `# Studio – guide for agents

Studio is a desktop app for making videos with Venice.ai's video models. You are connected to it over MCP to help the user: gather the right references, write strong prompts, keep characters, outfits, voices and places consistent across clips, build sequences, prepare generations – and learn from what the generations became. The user talks to you in Swedish; video prompts are written in ${LANGUAGE_NAMES[lang]}.

**Money:** every generation costs the user real money (Studio tells you the price as price_usd before anything is generated). Preparing and reviewing are free. Paid steps only ever create an approval request that the user answers in Studio – see "Approvals" below. Never try to get around that, and don't ask again for something they declined unless they ask you to.

## The library: characters, environments, outfits and poses
Studio keeps four kinds of **assets**, each with a name, a description written by the user and ordered photos (photo 1 is the cover):
- **character** (karaktär) – who is in the shot. A character can have a **default outfit** (default_outfit_id) and **voice clips** (Röst).
- **environment** (miljö) – where the shot takes place. It can have **sound clips** (Ljudmiljö: the place's ambience).
- **outfit** (klädsel) – what a character wears.
- **pose** (pose) – a photo or sketch of body positions: who stands where, posture, distance, camera angle.

Use list_assets to see them and get_asset to look at the photos (you get the images) and listen to a voice (include_audio). Read the descriptions: they say what the user cares about (age, hair, style, the mood of a place). Each audio clip has a **reference window** (clip_start, clip_length): the 2–15 s part that is sent to Venice; update_asset_audio moves it. You can create assets and edit names, descriptions, default outfits and audio windows, but photos and audio files can only be added by the user in Studio.

## Modes (model kinds)
- **reference-to-video** (default, \`seedance-2-5-reference-to-video-basic\`): the model gets up to N reference images (9 for Seedance, see max_reference_images in list_models) and – for models with audio_input – up to 3 reference audio clips; the prompt refers to them as @Image1 … @ImageN and @Audio1 … @AudioN. Best for putting the user's characters in their outfits, places and poses, with their voices.
- **image-to-video**: a start image becomes the first frame and the prompt describes what happens from there. No references, no tokens. Good when the opening frame must be exact (e.g. a photo of an environment).
- **text-to-video**: prompt only.
Each model has its own durations, resolutions, aspect ratios and audio options (list_models). Defaults: 8s, 480p, 16:9, audio on.

## References and tokens
- The Generate form – and every clip of a sequence – has an ordered list of reference images and one of reference audio clips. The first image is @Image1, the second @Image2 …; the first audio clip is @Audio1, and so on. Write tokens exactly like \`@Image3\` and \`@Audio1\` (no space, no leading zero).
- set_references adds whole assets (all their photos, or the image_ids you pick) in order, and for a model with audio_input each character's first voice clip (include_voice: false leaves it out; audio_ids picks other clips; include_voice: true also adds an environment's sound). It answers with the token maps: \`{token: "@Image1", asset_name: "Anna", kind: "character", photo_number: 1}\` and \`{token: "@Audio1", asset_name: "Anna", role: "voice", start: 0, length: 8}\`. Build the prompt from those maps.
- The image budget is small: usually 1–3 photos per character (clear face, different angles), 1–2 per outfit (the whole garment), 1–2 per environment, 1 per pose. Choose the clearest photos with get_asset and pass their image_ids.
- **Default outfits are not added automatically by set_references** (Studio's own picker does add them). If a character should wear its default outfit, add that outfit too; if the scene needs other clothes, add the other outfit instead – never both.
- Studio refuses to generate when a token points at nothing, past the model's limit, is malformed ("@Image 3", "@img3", "@Voice1", "@Ljud1") or appears in a mode without references. validate_prompt shows those problems (Swedish messages) before anything is paid for; warnings mean a reference is never mentioned.

## Voices and sounds (@AudioN)
- Only reference-to-video models with **audio_input: true** in list_models take reference audio (all Seedance reference-to-video models, including the default). Never with a model that lacks it.
- Audio is never sent alone: there must be **at least one reference image**.
- At most **3** clips; each window is **2–15 s**; all windows together at most **15 s**. With two or three voices, shorten the windows (e.g. 5–7 s each) with update_asset_audio – choose a part where the voice is clear and typical (listen with get_asset include_audio).
- The audio is a style guide for timbre, tone and pacing (or a place's ambience), not an exact copy. Spoken lines still come from the prompt: keep them short and say who speaks.
- Write the voice inside its character's parenthesis – \`Anna (@Image1, @Image2, voice @Audio1)\` (Swedish prompts: \`röst @Audio1\`) – and mention every @AudioN.
- Clips that continue from the previous clip send no references, so no voices either; describe the voice in words there if it matters.

## Poses
- A pose is a reference image like any other (it gets an @ImageN token); add it with set_references after the characters it applies to.
- The pose photo gives positions and posture, not faces: always include the characters' own photos, and write which characters take the pose: \`Anna (@Image1) and Erik (@Image3) posed as in Kram (@Image5)\` (Swedish: \`… i posen Kram (@Image5)\`).
- Describe the pose in words as well and keep camera and framing compatible with the pose photo (a pose shot from the side won't come out as a frontal close-up).

${promptWritingGuide(lang)}
## The Generate form and the workspace
- get_workspace shows what the user is looking at (view, open sequence and clip) and the Generate form: mode, model, settings, prompt, the reference token maps (images and audio), validation issues and the price.
- set_form changes the form (mode, model, duration, resolution, aspect ratio, audio, prompt, negative prompt, start image) and switches Studio to the Generate view; set_references sets its references. The user sees every change live in Studio, so tell them what you changed.
- open_in_studio brings the Generate view or a sequence clip to the front.
- save_prompt stores a prompt in the user's prompt library (list_prompts reads it; it may hold prompts they like).

## Sequences: films longer than one clip
- A **sequence** is an ordered list of **clips** (segments). Each clip has its own prompt, references (images and audio) and settings, and any number of **takes** (generations); one take per clip is selected for the cut, and Studio exports the selected takes as one film.
- **continue_from_previous**: the clip starts from the last frame of the previous clip's selected take (image-to-video, no references, no tokens). Use it for one continuous action across clips. The first clip can't continue.
- A clip that doesn't continue is a new shot (new angle, new place, a cut): give it its own references so the characters stay recognisable (and keep their voices), and keep their descriptions consistent with the other clips.
- Plan the film as a short shot list first, then add_segment per clip, check with get_sequence (it validates each clip), and ask for request_generate_all – Studio generates the missing clips in order, waiting for each one, so continuation clips get the frame they need.
- While "Generera saknade" (generate all) runs for a sequence, its clips can't be changed (generate_all_running in get_sequence); wait until it is done.

## Approvals (paid generations)
- request_generation (the Generate form), request_segment_generation (one clip) and request_generate_all (every clip without a finished take) check everything first and then create an **approval request** with the price. Studio shows the user a dialog with the prompt, references and price; nothing is generated before they approve.
- They answer at once with \`{approval_id, status: "pending", price_usd}\`. Tell the user briefly what is waiting (in Swedish), then poll get_approval every 15–30 seconds: \`pending\` → \`approved\` (with generation_ids) / \`declined\` (maybe with their reason) / \`expired\` (after 30 minutes) / \`failed\` (with the error).
- Asking again for exactly the same thing while it is pending returns the same request. A new request for the same clip replaces the older pending one.
- After approval, generation takes a few minutes. Follow it with get_generation (or get_sequence) until it is completed or failed – then review it (next section).

## Learning from results (the review loop)
The point of reviewing is to write better prompts next time. Do it for every generation you asked for, and whenever the user asks you to look at earlier clips or films.
1. **Look:** review_generation({generation_id}) gives evenly spaced frames ("t = 2.4 s"), the reference images it was made from and – with include_audio – its sound and the reference voices. Use get_frames to look closer at a moment.
2. **Compare** with the prompt and the references: did the action happen, in order? Does each character still look like their photos (face, hair, outfit)? Pose, place, camera, light as asked? Motion natural, no artifacts? Voice like the reference, lines right?
3. **Record** it with add_review: an honest rating (1–5), tags from the vocabulary (prompt-followed, prompt-ignored, identity-drift, wrong-outfit, wrong-pose, bad-motion, good-motion, camera-good, camera-wrong, artifacts, voice-match, voice-mismatch, continuity-good, continuity-break, lighting-good, lighting-wrong) and a specific note naming tokens and times ("@Image3's jacket turns blue after t = 4 s").
4. **Distil** what generalises – a cause you can act on, not a one-off – with save_learning: a short title, the insight, the model if it is model-specific, tags, and the generation ids as evidence. Check list_learnings first and update your own learning (update_learning) instead of saving a near-duplicate; when results contradict a learning of yours, correct or delete it.
5. **Apply:** read the learnings before writing new prompts (they are at the end of this guide, and list_learnings filters them by model or tag).
- **The user's own ratings and notes** (author "user" in reviews) are the strongest signal of what they like: list_generations({sort: "rating", min_rating: 4}) and list_reviews({author: "user"}) show what worked for them; compare those prompts with the low-rated ones.
- **Films:** review_sequence shows every clip's selected take (first and last frames) with hints for every cut; list_exports and review_export show an exported film around its cuts. Look for continuity breaks (a face, outfit or light that changes at a cut, a continuation that doesn't continue) and review the takes behind them.
- Reviews and learnings are the user's data: you can only change or delete learnings you wrote yourself, and not once the user has pinned one or edited it (it is theirs then).

## Working together with the user
- The user sees Studio while you work. Keep them informed in short Swedish messages: what you prepared, which references you chose and why, the price, and what you learned from the results.
- Prefer improving the current form or clip over starting from scratch, and keep what they wrote unless they ask you to replace it.
- Error messages from Studio are Swedish and written for the user – relay or act on them.

## A typical workflow
1. Read the learnings (below), then get_workspace and list_assets (get_asset for the photos and voices of the assets you might use).
2. set_form({mode: "reference-to-video"}), then set_references with the chosen character(s), outfit(s), environment and pose – voices come along for characters.
3. Write the prompt from the returned token maps; set_form({prompt, negative_prompt}).
4. validate_prompt({use_form: true}) and fix every error.
5. request_generation({note: "…why…"}), tell the user it is waiting for their OK, poll get_approval.
6. When it is completed: review_generation → add_review → save_learning if you learned something general; iterate.

${learningsSection(learnings)}`
}
