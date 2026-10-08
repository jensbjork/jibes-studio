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
    'environments, outfits and poses, and characters\' voices – and chains clips into longer sequences. A film can',
    'also be planned as a storyboard: one picture per milestone, with the clips generated between the pictures, and',
    'any finished film – a clip, an exported film or the user\'s own footage – can be changed in Redigera, where every',
    'change becomes a new version (cut, sound, voices, music, AI picture fixes). Call get_studio_guide once before you',
    'start: it explains @ImageN / @AudioN references, how to write prompts that work, storyboards, replacing a clip',
    'between its neighbours, the user\'s own clips and editing films, and ends with the learnings earlier sessions',
    'recorded – follow them. Studio appends the descriptions of the referenced assets to every prompt it sends (a',
    'References legend), so prompts describe the action, camera and mood rather than repeating them. Everything is',
    'free to prepare (references, prompts, the Generate form, sequences, storyboards, plans and free edits), but every',
    'generation or paid edit costs the user real money: request_generation, request_segment_generation,',
    'request_generate_all, request_transition_generation, request_generate_storyboard, request_image_generation,',
    'request_edit_operation and request_voice_design only ask for the user\'s approval in Studio, and nothing is',
    'generated or sent to Venice until they say yes. Always plan an edit (plan_edit_operation, free) before asking',
    'for it. When a generation or a new version is done, look at what it became',
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
  const references = sv ? 'Referenser:' : 'References:'
  return `## Writing video prompts (Seedance-class models)

**Language:** write every video prompt in ${LANGUAGE_NAMES[lang]} (the user's setting "Promptspråk"), even though you talk to the user in Swedish.

**One clip is one continuous shot.** A clip is 4–15 seconds of a single camera take. Describe one shot – no cuts, no "then later", no montage, no list of unrelated actions. One main action (two or three closely linked ones at most) that fits the clip's duration.

**Order the prompt like a shot description:**
1. **Subject** – who or what is in the shot, each with its references right after the name (their looks come from the photos and the appended descriptions – see below).
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

**Descriptions of referenced assets are appended automatically as a References legend – don't repeat them in the prompt; write the action, camera and mood.** When Studio sends a prompt it adds one line per referenced asset that has a description, built from the user's library at that moment:
\`\`\`
<your prompt>

${references}
- Anna (@Image1, @Image2; ${voice} @Audio1): <Anna's description>
- <the place> (@Image4): <its description>
\`\`\`
- The legend is never part of the prompt text you write or read back (\`prompt\`); \`composed_prompt\` (get_workspace, validate_prompt, get_sequence) shows the whole text that is sent and \`description_entries\` which descriptions go along (\`sent\`; \`included\` only says it is switched on – an empty prompt, or a legend that doesn't fit the model's limit, sends none: see \`descriptions_note\`). It follows the tokens, so it stays right when references are reordered.
- It counts towards the model's prompt_character_limit: Studio shortens the descriptions (or, if even the names don't fit, leaves the legend out – descriptions_note says so) rather than refusing. Keep your own prompt lean so they fit.
- A description that is missing, vague or wrong for this shot: improve it with update_asset (it then applies to every later prompt), or switch that asset's description off for this form or clip with excluded_description_asset_ids (set_form, add_segment, update_segment; include_descriptions: false switches all of them off) – e.g. when the scene deliberately shows a character differently from the description.

**Voices (@AudioN).** With a model that takes reference audio (audio_input in list_models) a character's voice clip steers the timbre, tone and pacing of how they sound – a style guide, not an exact clone. Keep the clip's token inside the character's parenthesis and attribute spoken lines to the character by name: \`Anna (@Image1, ${voice} @Audio1) says: "…"\`. An environment's sound clip goes with the place: \`the harbour pier (@Image4, ${sound} @Audio2)\`. Keep audio on (set_form audio: true) – without generated sound a voice reference has nothing to shape.

**Poses.** A pose asset is a photo or sketch of how people stand, sit or hold each other and where they are relative to each other and the camera. Its photo carries only the positions – the identities come from the characters' own photos. Name the characters that take the pose, then the pose with its token: \`Anna (@Image1) ${and} Erik (@Image3) ${posedAs} Kram (@Image5)\`, and say the pose in words too ("standing face to face, her arms around his neck"). Use one pose per clip and keep the camera angle close to the pose photo's.

**Describe motion over time.** Say how the clip starts, what changes and how it ends: "She stands at the railing looking out to sea, then turns towards the camera and smiles as the wind lifts her hair." Video models follow verbs and timing; static descriptions give static clips.

**Be concrete and visual.** Describe what the camera sees, not intentions ("make it epic", "a beautiful moment"). Avoid contradictions (sunny and rainy, night and midday sun), more than three characters, small legible text, and complicated hand interactions.

**Length:** usually 40–120 words of your own; the References legend comes on top. Respect the model's prompt_character_limit (list_models) – composed_characters in get_workspace / validate_prompt is the length that is sent.

**Audio:** when audio is on, the model also makes sound. You may describe ambience and sounds ("waves crashing, gulls in the distance") and short spoken lines in quotes with who says them: \`Erik says: "Kom, vi går."\` Keep dialogue short – a line or two per clip.

**Negative prompt:** a short comma-separated list of things to avoid, e.g. \`blurry, distorted faces, extra fingers, text, watermark, flicker\`. Leave it empty unless there is a recurring problem. Don't put negations ("no people") into the main prompt – they tend to summon what they name; use the negative prompt instead.

**Continuation clips (sequences):** a clip with continue_from_previous starts from the last frame of the previous clip's selected take and is generated image-to-video, without references and without @ tokens. Write only what happens next, starting exactly where the previous clip ended – same people, same place, same light, same position – and describe them in words (names and looks) instead of tokens: "The woman keeps walking along the promenade, then stops and looks back over her shoulder; the camera slowly pushes in." Don't re-introduce the scene as if it were new, and don't change the location or time of day abruptly.

**Clips with a start and/or end image (keyframes):** they are generated image-to-video too, without references and without @ tokens: the look of the people, clothes, place and light comes from the images. Describe the motion that leads from the start picture to the end picture within the clip's duration – who moves where, how fast, what the camera does – and name the people in words. Don't describe a different place or outfit than the images show. With an end image, the clip must arrive at exactly that picture: "She walks from the railing towards the camera and stops in a medium close-up, smiling, as the camera eases back."

**Storyboard transitions:** a transition is generated from two pictures – the start is one board's picture, the end the next board's – so it is image-to-video with an end image: no references, no @ tokens. Look at both pictures first (preview_transition) and describe how the first becomes the second within the duration, as one continuous shot: what moves (people walk, turn, sit down; a door opens; the light fades), how the camera travels to get from the first framing to the second (push in, pull back, pan, orbit, crane), and the pacing. Name people in words, and describe only what the pictures show – the model has to arrive at exactly the second picture. The further apart the two pictures are (another place, another time of day), the more the motion has to carry: when no plausible single shot leads from one to the other, tell the user that a board in between would help.

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

Use list_assets to see them and get_asset to look at the photos (you get the images) and listen to a voice (include_audio). Read the descriptions: they say what the user cares about (age, hair, style, the mood of a place) – and Studio appends them to every prompt that uses the asset's photos or voice (see "Descriptions in the prompt"), so a good description is concrete and visual and says what the photos alone can't. Each audio clip has a **reference window** (clip_start, clip_length): the 2–15 s part that is sent to Venice; update_asset_audio moves it. You can create assets and edit names, descriptions, default outfits and audio windows, but photos and audio files can only be added by the user in Studio.

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
- **Reordering:** reorder_references changes the order of the form's (or a clip's: target {segment_id}) reference images or audio clips, the way the user drags a thumbnail in Studio, and renumbers every token in the prompt and negative prompt so each still points at the same picture or clip – with references [A, B, C] and "@Image1 hugs @Image3", moving C first gives [C, A, B] and "@Image2 hugs @Image1". Name references by token, image_id / audio_id or asset_id; the ones you name come first, the rest keep their order. Use it whenever only the order should change (e.g. to bring a picture within the model's limit of max_reference_images, or to make a character @Image1): set_references with mode "replace" sets the list anew and does not renumber the tokens already in the prompt.

## Descriptions in the prompt (the References legend)
- Studio appends the descriptions of the assets whose photos or voices are sent to the prompt, as a References legend after it (see "Writing video prompts"). It is composed when the generation is sent, from the descriptions as they are then: a description the user (or you, with update_asset) improves applies to the next generation.
- The user can switch it off for a form or clip ("Ta med beskrivningar": include_descriptions) or per asset (excluded_description_asset_ids). Respect what they switched off; change it only when asked or clearly needed, and tell them.
- Don't paste descriptions into the prompt yourself – they would be sent twice. Check composed_prompt (get_workspace, validate_prompt, get_sequence) to see exactly what is sent.
- The approval dialog shows the user the whole composed prompt with the legend; if a description changes before they approve, the request lapses and you need to ask again.

## Voices and sounds (@AudioN)
- Only reference-to-video models with **audio_input: true** in list_models take reference audio (all Seedance reference-to-video models, including the default). Never with a model that lacks it.
- Audio is never sent alone: there must be **at least one reference image**.
- At most **3** clips; each window is **2–15 s**; all windows together at most **15 s**. With two or three voices, shorten the windows (e.g. 5–7 s each) with update_asset_audio – choose a part where the voice is clear and typical (listen with get_asset include_audio).
- The audio is a style guide for timbre, tone and pacing (or a place's ambience), not an exact copy. Spoken lines still come from the prompt: keep them short and say who speaks.
- Write the voice inside its character's parenthesis – \`Anna (@Image1, @Image2, voice @Audio1)\` (Swedish prompts: \`röst @Audio1\`) – and mention every @AudioN.
- Clips that continue from the previous clip send no references, so no voices either; describe the voice in words there if it matters.
- **A new voice for a character:** request_voice_design({asset_id, description, sample_text}) asks the user to approve making a voice from a description with AI (about $0.35; write the description in English – age, gender, timbre, pace, accent, mood – and the sample text in the character's language). Once approved and made it becomes a new Röst clip of the character (get_approval names its audio_id; listen with get_asset include_audio). It is the only way an agent adds an audio clip.
- **Cloning a voice for new lines (Redigera):** a character's Röst clip can be cloned to speak new lines (speak_lines with {clone_audio_id}) only after the user has ticked "Får klonas för nya repliker" for that clip – clone_consent in list_assets. You can't give that consent; when it is false, the approval dialog asks the user to tick it before they approve. The clone model's Swedish is unverified: have the user listen to the first lines before re-voicing a whole film.

## Poses
- A pose is a reference image like any other (it gets an @ImageN token); add it with set_references after the characters it applies to.
- The pose photo gives positions and posture, not faces: always include the characters' own photos, and write which characters take the pose: \`Anna (@Image1) and Erik (@Image3) posed as in Kram (@Image5)\` (Swedish: \`… i posen Kram (@Image5)\`).
- Describe the pose in words as well and keep camera and framing compatible with the pose photo (a pose shot from the side won't come out as a frontal close-up).

${promptWritingGuide(lang)}
## The Generate form and the workspace
- get_workspace shows what the user is looking at (view, open sequence and clip, or open storyboard) and the Generate form: mode, model, settings, prompt, the reference token maps (images and audio), validation issues and the price.
- set_form changes the form (mode, model, duration, resolution, aspect ratio, audio, prompt, negative prompt, start image, the description switches) and switches Studio to the Generate view; set_references sets its references and reorder_references changes their order (renumbering the prompt's tokens). The user sees every change live in Studio, so tell them what you changed.
- open_in_studio brings the Generate view, a sequence clip, a storyboard or an edit in Redigera (view "editor", edit_id) to the front.
- save_prompt stores a prompt in the user's prompt library (list_prompts reads it; it may hold prompts they like).

## Sequences: films longer than one clip
- A **sequence** is an ordered list of **clips** (segments). Each clip has its own prompt, references (images and audio) and settings, and any number of **takes** (generations); one take per clip is selected for the cut, and Studio exports the selected takes as one film.
- **continue_from_previous**: the clip starts from the last frame of the previous clip's selected take (image-to-video, no references, no tokens). Use it for one continuous action across clips. The first clip can't continue.
- **end_from_next**: the clip ends on the first frame of the next clip's selected take (image-to-video with a model that takes an end image). Together with continue_from_previous it fits a clip exactly between its neighbours (see "Replacing a clip between its neighbours"). The last clip can't take its end from a next one.
- **Start and end images** (keyframes) and **notes** – see "Keyframes and stills in sequences" below. (To plan a film as milestone pictures with the clips generated between them, use a storyboard instead – see "Storyboards".)
- A clip that doesn't continue is a new shot (new angle, new place, a cut): give it its own references so the characters stay recognisable (and keep their voices), and keep their descriptions consistent with the other clips.
- Plan the film as a short shot list first, then add_segment per clip, check with get_sequence (it validates each clip), and ask for request_generate_all – Studio generates the missing clips in an order that gives every clip the frames it needs (a continuation after the clip before it, a clip that ends on the next clip's first frame after that clip).
- While "Generera saknade" (generate all) runs for a sequence, its clips can't be changed (generate_all_running in get_sequence); wait until it is done.

## Storyboards: milestone pictures, with the clips generated between them
A **storyboard** is a separate way of making a film – not a sequence. The user (or you) first mocks up the film's **milestones as pictures**, one picture per **board**; then Studio generates the **transitions**: the clips that go from each board's picture to the next one's. Storyboards have their own view in Studio (Storyboards) and their own tools; they never show up among the sequences.
- **Boards:** an ordered list; each board has exactly one picture (or none yet, while planning) and a short **note** ("Vad visar bilden?") – what the picture shows, in any language. get_storyboard lists them with their picture (a still or a library photo) and \`aspect_mismatch\` when a picture's format differs from the storyboard's.
- **Transitions:** between every two neighbouring boards there is one: transition N goes from board N's picture (its start image) to board N+1's picture (its end image). It is image-to-video with an end image (Seedance image-to-video by default; only models that take an end image), with its own prompt ("Vad händer?"), duration (5 s by default), resolution, audio and takes. It can be generated once both its boards have pictures (\`ready\`). Each transition is independent of the others: it only needs its two pictures.
- **Aspect ratio:** a storyboard has one (16:9 by default; 9:16, 1:1, 4:3, 3:4, 21:9). Make the pictures in it – request_image_generation does by default – since a transition takes its format from its pictures.
- **Workflow:**
  1. **Plan the milestones with the user:** the key moments of the film, in order – each a picture worth stopping at (an establishing view, the character arriving, the turn, the final image). Not too many: every pair of neighbours becomes one 5–10 s clip. create_storyboard({name, board_notes}) creates the boards with their notes; add_board / update_board / move_board / delete_board change them.
  2. **Make each board's picture:** request_image_generation({prompt, assign_to: {board_id}, …}) with the characters, outfits, environment and pose as references (reference_asset_ids / reference_image_ids; the first reference is the base picture). For visual continuity from one milestone to the next, pass \`previous_board_as_reference: true\`: the previous board's picture becomes the base picture, so the place, light and people carry over, and the prompt says what has changed. The user can also use an existing picture – a still, a library photo or a frame of a clip: add_board / update_board({image}). Follow get_approval, then look at the result (get_storyboard or get_still) and redo it if it isn't right – every attempt is kept among the storyboard's stills.
  3. **Write each transition's prompt as the motion from picture A to picture B:** preview_transition shows both pictures. Describe what happens in between, within the duration – who moves where and how, what the camera does, how the light changes – so that the clip starts exactly on A and lands exactly on B. Image-to-video: no @ tokens, name people in words, don't describe a place or outfit the pictures don't show. update_transition({prompt, duration, …}) saves it.
  4. **Generate:** request_transition_generation({transition_id}) for one, or request_generate_storyboard({storyboard_id}) for every transition without a finished take (all of them must be ready).
  5. **Review and regenerate:** review_generation of each new take shows its frames next to the two pictures it was made from: does it start on A and end on B, is the motion natural, do the people stay themselves? Rewrite the prompt and ask again where needed; pick the best take with update_transition({selected_take_id}). A take made before a board's picture changed is marked \`made_from_earlier_pictures\`; a finished take made from the pictures there now replaces it as the selected take by itself. The user exports the film (the selected takes back to back) in Studio; review_export looks at it.
- convert_storyboard_to_sequence makes an ordinary sequence of the transitions' selected takes when the user wants to go on editing the film in Sekvenser.

## Keyframes and stills in sequences
A sequence's clips can also start and end on chosen pictures:
- **Notes:** every clip has free-text \`notes\` (Swedish or English) – what happens in the shot, who is in it, the framing. Set them with add_segment / update_segment({notes}). Notes are not sent to Venice; the prompt is.
- **Start and end images:** get_sequence shows each clip's \`start_image\` and \`end_image\`: \`{kind: "previous"}\` (the previous clip's last frame, i.e. continue_from_previous), \`{kind: "next"}\` (the next clip's first frame, i.e. end_from_next), or \`{kind: "image", still_id | asset_image_id, path}\`; \`supports_end_image\` says whether the clip's video model can take an end image, and \`frame_problems\` what still stops an automatic frame (e.g. the neighbour has no finished take yet). Set them with add_segment / update_segment: \`start_image\` / \`end_image\` = \`{still_id}\` (a still), \`{asset_image_id}\` (a library photo), \`{generation_id, time}\` (a frame of a finished clip, saved as a still), \`"previous"\` / \`"next"\`, or \`null\` to clear it.
- **A clip with a start and/or end image is generated image-to-video** with its family's image-to-video model (Studio switches it): no references, no @ tokens, and the look comes from the images (see "Clips with a start and/or end image" above). An end image needs a model with supports_end_image (Seedance image-to-video has it). Image-to-video takes its format from the start image, so make keyframes in the sequence's aspect ratio (request_image_generation does by default).
- **Stills** are the pictures of a sequence or a storyboard: generated images, uploaded pictures and frames saved from clips. list_stills lists them (with the clips and boards that use them), get_still shows one, save_frame_as_still saves a frame of a finished clip (free).

## Making pictures – request_image_generation
💰 Cheap (about $0.06), but it needs the user's approval like video.
- A prompt plus up to max_input_images references (list_image_models; usually 3): \`reference_still_ids\`, \`reference_image_ids\` (library photos) and \`reference_asset_ids\` (an asset's cover photo), sent in that order – after the previous board's picture when \`previous_board_as_reference\` is set. **The first reference is the base picture** the model edits – put first the picture whose composition should be kept (often the environment, a pose, or the previous milestone or keyframe for continuity), then the characters and outfits. Without references a text-to-image model makes the picture from the prompt alone.
- \`assign_to: {board_id}\` makes the result a storyboard board's picture; \`assign_to: {segment_id, slot: "start" | "end"}\` puts it into a sequence clip. Every result is saved as a still of its storyboard or sequence whether or not it is assigned. While the user's "Säkert läge för bilder" is on (list_image_models says \`safe_mode\`), Venice blurs adult content in the picture; only the user can switch it off.
- **Image prompts are written in English** (whatever the video prompt language) and describe **one still frame**, not motion: who is in it and what they are doing at that instant; composition and framing (shot size, camera height and angle, where the subject is in the frame); place and time of day; lighting and colour; style ("cinematic film still, 35 mm, shallow depth of field"). Refer to the references by their place in the list – "the woman from image 2 wearing the red dress from image 3, standing on the wooden pier from image 1" – never with @ tokens. Keep faces, clothes and places as the references show them. Use negative_prompt (text-to-image models only) for things to avoid.
- **Sequence keyframes workflow:** for shots of a sequence that must look exactly right, make a keyframe with \`assign_to\` the clip's start (and, if the shot must end on a particular picture, its end); connect shots that flow into each other with \`start_image: "previous"\` (and \`end_image: "next"\`); rewrite each video prompt for image-to-video, check get_sequence (ready, issues, frame_problems) and ask for request_generate_all.

## Replacing a clip between its neighbours
When one clip in the middle of a film came out badly, make a new take of it that **starts exactly where the previous clip ends and ends exactly where the next clip begins**, so the neighbours stay untouched:
1. **Review** – review_sequence or review_generation: which clip is wrong and why (identity drift, wrong action, a break at a cut …).
2. **bridge_segment({segment_id})** – free. It turns on "Startbild från föregående klipp" (continue_from_previous) and "Slutbild från nästa klipp" (end_from_next), switches the clip to its family's image-to-video model that takes an end image (keeping duration, prompt and audio), drops its references (with a note), and answers with both frames as images, any problems and the price. The first clip, which has no clip before it, keeps its own start image (or the first frame of its current take, saved as a still); the last clip only gets the start frame.
3. **Look and rewrite** – the two frames show where the clip has to start and end. Rewrite the prompt (update_segment({prompt})) to describe what happens between them in the clip's duration, in words, without @ tokens. preview_segment_frames shows the frames again at any time (also after the user picked another take of a neighbour or changed its trim).
4. **request_segment_generation({segment_id, note})** – the user approves the price. The neighbours need finished selected takes; the old take of the clip is kept.
5. **Review again** – follow get_approval → review_generation of the new take, compare it with the old one (review_sequence shows the selected takes around the cuts). The new take is not selected automatically while the old one is: if it is better, select it with update_segment({selected_take_id}) and tell the user; the old one stays among the clip's takes, so it can be selected again.

## Your own clips (Egna klipp)
The user can bring their own films into Studio – phone videos, camera footage – as **own clips**. Only the user can import files from disk (you can't); once imported, you can use them like any finished video.
- list_generations({source: "import"}) lists them, named by \`title\` (the file name) – their prompt is empty. get_generation shows the \`recipe\` (file name, size, why a working copy was made) and \`original_path\`: when a film was HDR, 10-bit, 4K, rotated, variable frame rate, anamorphic (pixels that aren't square), had sound and picture starting apart or was in a format Studio can't play, Studio made an upright H.264 working copy and kept the original next to it. The "import" source also lists copies of exported films opened in Redigera (recipe.export): those were made in Studio, not filmed by the user.
- **Into a sequence:** add_segment({sequence_id, from_generation_id}) makes a clip whose selected take is the own film (get_sequence marks it \`own_clip: true\`); update_segment({selected_take_id}) chooses between a clip's own and AI takes. Everything that works with a take works with an own clip: the next clip can continue from its last frame (continue_from_previous), the clip before it can end on its first frame (end_from_next), bridge_segment can replace a clip between own clips, and the export takes it along. A clip generated from an own clip's frame is image-to-video from a real-world picture: describe the people and the place in words, and keep the motion plausible for real footage.
- **Real people:** Venice's public Seedance models often refuse pictures or video of real people. If a continuation from an own clip (or an AI edit of one) is refused, try another model and tell the user.
- The sequence's Exportformat (get_sequence \`export_height\`: 480/720/1080, or null for the first clip's own size) decides the film's size when own clips and AI clips are mixed. Only the user sets it.
- Review an own clip with review_generation like any video (its frames, and its sound with include_audio).

## Editing films (Redigera)
Redigera changes **one finished, continuous film** – a clip from the feed, a take, an exported film (export_id) or an own clip – into **versions**. The original (v1) is never changed: every operation makes a new version with its parent (the version it was made from), so nothing is ever lost.
- **Open:** create_edit({generation_id} or {export_id}) – check list_edits first; the answer names other edits of the same film. get_edit shows the version tree (versions with version_id, parent_version_id, the operation and its cost, which sequence clips use them), the current version, the paid jobs, the edit's audio media, every version's added sound layers (layer_id), and for the current version its cut markers (Klippgränser) and its transcript. set_current_version chooses the version that counts (an undo is choosing the parent); rename_edit renames it. Only the user can delete edits or versions or clean them up.
- **Plan first, always:** plan_edit_operation({edit_id, operation}) is free. It answers with the operation as it would run (ranges snapped to frames, cuts, lines and what the model allows; defaults filled in), whether it is paid, its price (price_note: billed per started minute, a voice clone Venice doesn't price…), the parts, notes, warnings and problems – and for picture operations the frames it works from as images (regenerate: the frame before and after the range; extend: the film's last frame; prompt_edit: the first and last frame of the range). price_usd with partial_price means a part has no price (a voice clone): the user is asked once more about such a price, as about an unknown one or one above $5. Then free operations go with **apply_edit**, paid ones with **request_edit_operation** (the user approves the price in Studio; nothing is sent before). Ranges are seconds in the base version: choose them from get_edit's cuts and get_transcript's line times, and keep them as short as the problem.
- **Prefer free operations** (made on this Mac): trim (keep a part) and cut (remove a part), fade (in from / out to black), volume (the whole film, a range, or only the voice or the background), mute (target "voice" removes the voice and keeps music and effects, "background" keeps only the voice), denoise, loudness (-14 LUFS for the web), add_audio (audio already in the edit by media_id – earlier music, effects, lines – or a library clip by asset_audio_id) and layer (change or remove an added sound). The voice and background targets need voice separation on this Mac (get_edit / list_audio_models: separation).
- **Which paid operation for which problem:**
  - a broken stretch (a glitch, a wrong movement, a face that melts) → **regenerate** the shortest range around it: a new picture from the frame before the range to the frame after it (4–30 whole seconds). The prompt (English) describes what happens between those two frames, as one continuous shot.
  - a visual change (remove a person, evening light, another jacket colour, a style) → **prompt_edit** on the shortest range that shows it: one change per run, written as the change only ("Remove the person in the background, keeping the rest of the video unchanged."); for Seedance Studio wraps it as \`Strictly edit <Video 1>, …\`. reference_image_ids add library photos to copy a look from (@Image1… in the prompt).
  - the film ends too soon → **extend** (4–15 s from its last frame). Low resolution → **upscale** (2× or 4×, the whole version; short films only).
  - the whole film in another voice → **change_voice** when list_audio_models lists a voice changer (speech to speech: the timing and the performance stay, so the lips still match; segment_ids limits it to some lines, e.g. one of two speakers; only those lines get the new voice, and the approval dialog lists them so the user can check you picked the right speaker). Without a voice changer: **transcribe**, then **speak_lines**.
  - wrong or new words → **transcribe** (when get_transcript has nothing; about $0.01 a minute), fix misheard words with update_transcript (free), then **speak_lines**: {segment_id, text} replaces a line, {at, text} adds one. New lines don't move the lips: best for a voice off screen, or regenerate the stretch afterwards. The voice: a preset ({preset} from list_audio_models), a provider id ({voice_id}), or a character's cloned Röst clip ({clone_audio_id}, see "Voices").
  - music or a sound → **music** (a range or the whole film; it ducks under speech) or **effect** (at a time, a few seconds).
  - background under a replaced voice: keep (music and effects stay; needs separation), duck (lowered) or remove.
- **Prompts are English**, concrete and visual, like video prompts. Venice's public Seedance models often refuse real people: own footage may be refused – try another model (Gemini, Wan, HappyHorse for prompt_edit) and tell the user.
- **Review every new version** with review_generation({generation_id: <version_id>, include_audio: true}) – frames, and up to 30 s of sound from audio_start – and compare it with its parent (get_frames at the same times). Keep the better one current with set_current_version.
- **Paid jobs:** an approved operation runs as a job (get_edit's jobs, get_approval: progress, the parts, errors); the finished result becomes a new version by itself (current when its base still is). A job interrupted by quitting Studio never sends its remaining parts by itself: only the user continues it in Redigera (or you ask again).
- **Into a sequence:** send_edit_to_sequence({version_id, segment_id}) adds a version as a new take of that clip; {version_id, sequence_id, after_segment_id} as a new clip. Then it is an own clip there (see "Your own clips").

## Approvals (paid generations)
- request_generation (the Generate form), request_segment_generation (one clip), request_generate_all (every clip without a finished take), request_transition_generation (one storyboard transition), request_generate_storyboard (every transition without a finished take), request_image_generation (one still: a board's picture or a keyframe), request_edit_operation (a paid operation in Redigera: its version, frames, lines, voice, parts and price) and request_voice_design (a new voice for a character) check everything first and then create an **approval request** with the price. Studio shows the user a dialog with the prompt, references and price (for a clip with automatic start and end frames, previews of them; for a transition, the two board pictures it goes between); nothing is generated before they approve.
- They answer at once with \`{approval_id, status: "pending", price_usd}\`. Tell the user briefly what is waiting (in Swedish), then poll get_approval every 15–30 seconds: \`pending\` → \`approved\` (with generation_ids, or for an image the still_id) / \`declined\` (maybe with their reason) / \`expired\` (after 30 minutes) / \`failed\` (with the error).
- Asking again for exactly the same thing while it is pending returns the same request. A new request for the same clip, transition or board – the same kind of edit operation on the same version, or a voice design for the same character – replaces the older pending one (so offer alternative voices one at a time). The same edit asked again at another price replaces the pending one too. An edit request lapses when its version's file, the plan or the transcript lines it uses change before the user answers, or Venice's price rises.
- After approval, generation takes a few minutes. Follow it with get_generation (or get_sequence) until it is completed or failed – then review it (next section).

## Learning from results (the review loop)
The point of reviewing is to write better prompts next time. Do it for every generation you asked for, and whenever the user asks you to look at earlier clips or films.
1. **Look:** review_generation({generation_id}) gives evenly spaced frames ("t = 2.4 s"), the reference images it was made from and – with include_audio – its sound and the reference voices. Use get_frames to look closer at a moment.
2. **Compare** with the prompt and the references: did the action happen, in order? Does each character still look like their photos (face, hair, outfit)? Pose, place, camera, light as asked? Motion natural, no artifacts? Voice like the reference, lines right?
3. **Record** it with add_review: an honest rating (1–5), tags from the vocabulary (prompt-followed, prompt-ignored, identity-drift, wrong-outfit, wrong-pose, bad-motion, good-motion, camera-good, camera-wrong, artifacts, voice-match, voice-mismatch, continuity-good, continuity-break, lighting-good, lighting-wrong) and a specific note naming tokens and times ("@Image3's jacket turns blue after t = 4 s").
4. **Distil** what generalises – a cause you can act on, not a one-off – with save_learning: a short title, the insight, the model if it is model-specific, tags, and the generation ids as evidence. Check list_learnings first and update your own learning (update_learning) instead of saving a near-duplicate; when results contradict a learning of yours, correct or delete it.
5. **Apply:** read the learnings before writing new prompts (they are at the end of this guide, and list_learnings filters them by model or tag).
- **The user's own ratings and notes** (author "user" in reviews) are the strongest signal of what they like: list_generations({sort: "rating", min_rating: 4}) and list_reviews({author: "user"}) show what worked for them; compare those prompts with the low-rated ones.
- **Films:** review_sequence shows every clip's selected take (first and last frames) with hints for every cut; list_exports and review_export show an exported film (of a sequence or a storyboard) around its cuts. Look for continuity breaks (a face, outfit or light that changes at a cut, a continuation that doesn't continue) and review the takes behind them.
- Reviews and learnings are the user's data: you can only change or delete learnings you wrote yourself, and not once the user has pinned one or edited it (it is theirs then).

## Working together with the user
- The user sees Studio while you work. Keep them informed in short Swedish messages: what you prepared, which references you chose and why, the price, and what you learned from the results.
- Prefer improving the current form or clip over starting from scratch, and keep what they wrote unless they ask you to replace it.
- Error messages from Studio are Swedish and written for the user – relay or act on them.

## A typical workflow
1. Read the learnings (below), then get_workspace and list_assets (get_asset for the photos and voices of the assets you might use).
2. set_form({mode: "reference-to-video"}), then set_references with the chosen character(s), outfit(s), environment and pose – voices come along for characters.
3. Write the prompt from the returned token maps – the action, camera and mood; the assets' descriptions are appended for you; set_form({prompt, negative_prompt}).
4. validate_prompt({use_form: true}), fix every error and read composed_prompt: that is what will be sent.
5. request_generation({note: "…why…"}), tell the user it is waiting for their OK, poll get_approval.
6. When it is completed: review_generation → add_review → save_learning if you learned something general; iterate.

${learningsSection(learnings)}`
}
