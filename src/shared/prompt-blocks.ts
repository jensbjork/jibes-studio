// Building blocks for writing prompts: ready-made English phrases behind short labels, grouped by what they
// describe (framing, camera, light…). The prompt fields offer them through "/" and the chips under the field;
// agents read the same list (get_prompt_blocks) so both write in the same vocabulary.

/** What a field is for; decides which groups it offers. */
export type PromptBlockContext = 'video' | 'image' | 'negative' | 'music' | 'sound'

export interface PromptBlock {
  /** What the user picks. */
  label: string
  /** English, what goes into the prompt. */
  text: string
}

export interface PromptBlockGroup {
  id: string
  /** Short: the chip and the menu heading. */
  label: string
  /** The fields that offer this group. */
  contexts: readonly PromptBlockContext[]
  blocks: readonly PromptBlock[]
}

const VISUAL: readonly PromptBlockContext[] = ['video', 'image']

export const PROMPT_BLOCK_GROUPS: readonly PromptBlockGroup[] = [
  {
    id: 'scene',
    label: 'Template',
    contexts: VISUAL,
    blocks: [
      {
        label: 'Scene: subject, action, setting, camera, light, mood',
        text: 'Subject: \nAction: \nSetting: \nCamera: \nLighting: \nMood: '
      },
      { label: 'Short scene in one sentence', text: '[who] [does what] in [where], [camera], [light], [mood].' },
      { label: 'Dialogue', text: 'She says: "…"' }
    ]
  },
  {
    id: 'framing',
    label: 'Framing',
    contexts: VISUAL,
    blocks: [
      { label: 'Extreme close-up', text: 'extreme close-up' },
      { label: 'Close-up', text: 'close-up shot' },
      { label: 'Medium shot', text: 'medium shot' },
      { label: 'Full shot', text: 'full shot, head to toe' },
      { label: 'Wide shot', text: 'wide establishing shot' },
      { label: 'Over the shoulder', text: 'over-the-shoulder shot' },
      { label: 'From above', text: 'high angle, looking down' },
      { label: 'From below', text: 'low angle, looking up' },
      { label: "Bird's-eye view", text: "top-down bird's-eye view" },
      { label: 'Eye level', text: 'eye-level shot' },
      { label: 'Profile', text: 'side profile shot' }
    ]
  },
  {
    id: 'camera',
    label: 'Camera',
    contexts: ['video'],
    blocks: [
      { label: 'Still camera', text: 'static locked-off camera' },
      { label: 'Slow dolly in', text: 'slow dolly in' },
      { label: 'Slow dolly out', text: 'slow dolly out' },
      { label: 'Pan left', text: 'slow pan left' },
      { label: 'Pan right', text: 'slow pan right' },
      { label: 'Tilt up', text: 'tilt up' },
      { label: 'Tilt down', text: 'tilt down' },
      { label: 'Follows the subject', text: 'tracking shot following the subject' },
      { label: 'Handheld', text: 'handheld camera with subtle natural shake' },
      { label: 'Crane up', text: 'crane shot rising up' },
      { label: 'Orbits around', text: 'the camera slowly orbits around the subject' },
      { label: 'Zoom in', text: 'slow zoom in' },
      { label: 'One take, no cuts', text: 'one continuous shot, no cuts' }
    ]
  },
  {
    id: 'light',
    label: 'Light',
    contexts: VISUAL,
    blocks: [
      { label: 'Soft morning light', text: 'soft morning light' },
      { label: 'Golden hour', text: 'warm golden hour light' },
      { label: 'Blue hour', text: 'cool blue hour light' },
      { label: 'Dim night light', text: 'dim night lighting' },
      { label: 'Window light', text: 'soft natural window light' },
      { label: 'Hard side light', text: 'hard side light with deep shadows' },
      { label: 'Backlight', text: 'backlit, rim light around the subject' },
      { label: 'Neon', text: 'neon lighting, saturated colours' },
      { label: 'Candlelight', text: 'warm flickering candlelight' },
      { label: 'Overcast daylight', text: 'flat overcast daylight' },
      { label: 'Cinematic light', text: 'cinematic lighting, high contrast' }
    ]
  },
  {
    id: 'style',
    label: 'Style',
    contexts: VISUAL,
    blocks: [
      { label: 'Cinematic', text: 'cinematic, shallow depth of field' },
      { label: 'Photorealistic', text: 'photorealistic, natural skin texture' },
      { label: '35 mm film', text: 'shot on 35mm film, natural grain' },
      { label: 'Documentary', text: 'documentary style' },
      { label: 'Commercial', text: 'polished commercial look' },
      { label: 'Music video', text: 'music video aesthetic' },
      { label: 'Dreamy', text: 'dreamy, soft focus' },
      { label: 'Dark and moody', text: 'dark, moody atmosphere' },
      { label: 'Bright and airy', text: 'bright and airy' },
      { label: 'Tense', text: 'tense, suspenseful mood' },
      { label: 'Calm', text: 'calm, peaceful mood' }
    ]
  },
  {
    id: 'motion',
    label: 'Motion',
    contexts: ['video'],
    blocks: [
      { label: 'Slow motion', text: 'in slow motion' },
      { label: 'Slow and smooth', text: 'slow, smooth movement' },
      { label: 'Fast and energetic', text: 'fast, energetic movement' },
      { label: 'Small natural movements', text: 'subtle natural movement, breathing, blinking' },
      { label: 'Wind in the hair', text: 'hair moving gently in the wind' },
      { label: 'Turns to the camera', text: 'turns to face the camera' },
      { label: 'Walks towards the camera', text: 'walks towards the camera' },
      { label: 'Walks away from the camera', text: 'walks away from the camera' }
    ]
  },
  {
    id: 'sound',
    label: 'Sound',
    contexts: ['video'],
    blocks: [
      { label: 'Only natural sound', text: 'only natural ambient sound, no music' },
      { label: 'Room tone', text: 'quiet room tone' },
      { label: 'Soft background music', text: 'soft background music' },
      { label: 'Footsteps', text: 'footsteps on a wooden floor' },
      { label: 'City sounds', text: 'distant city traffic' },
      { label: 'Rain', text: 'rain against the window' },
      { label: 'Birds', text: 'birdsong outside' },
      { label: 'Silence', text: 'near silence' }
    ]
  },
  {
    id: 'avoid',
    label: 'Avoid',
    contexts: ['negative'],
    blocks: [
      { label: 'Blurry', text: 'blurry, out of focus' },
      { label: 'Text and watermarks', text: 'text, captions, watermarks, logos' },
      { label: 'Distorted hands', text: 'distorted hands, extra fingers' },
      { label: 'Distorted faces', text: 'distorted faces' },
      { label: 'Extra limbs', text: 'extra limbs' },
      { label: 'Cuts and scene changes', text: 'cuts, scene changes' },
      { label: 'Flicker', text: 'flickering' },
      { label: 'Cartoon style', text: 'cartoon, illustration' },
      { label: 'Low quality', text: 'low quality, compression artifacts' },
      { label: 'Music', text: 'music' }
    ]
  },
  {
    id: 'music',
    label: 'Music',
    contexts: ['music'],
    blocks: [
      { label: 'Calm piano', text: 'calm solo piano' },
      { label: 'Strings, tense', text: 'tense string ensemble' },
      { label: 'Cinematic orchestra', text: 'cinematic orchestral score' },
      { label: 'Electronic, pulsing', text: 'pulsing electronic beat' },
      { label: 'Lo-fi', text: 'mellow lo-fi hip hop' },
      { label: 'Acoustic guitar', text: 'warm acoustic guitar' },
      { label: 'Ambient', text: 'slow ambient pads' },
      { label: 'Instrumental', text: 'instrumental, no vocals' },
      { label: 'Slow tempo', text: 'slow tempo' },
      { label: 'High tempo', text: 'high tempo' }
    ]
  },
  {
    id: 'effects',
    label: 'Sound effects',
    contexts: ['sound'],
    blocks: [
      { label: 'Door slamming', text: 'a door slamming shut' },
      { label: 'Footsteps', text: 'footsteps on a wooden floor' },
      { label: 'Rain', text: 'steady rain' },
      { label: 'Thunder', text: 'distant thunder' },
      { label: 'Glass shattering', text: 'glass shattering' },
      { label: 'Wind', text: 'wind howling' },
      { label: 'Crowd applauding', text: 'a crowd applauding' },
      { label: 'Phone ringing', text: 'a phone ringing' }
    ]
  }
]

/** The groups a field of this kind offers, in order. */
export function promptBlockGroups(context: PromptBlockContext): PromptBlockGroup[] {
  return PROMPT_BLOCK_GROUPS.filter((g) => g.contexts.includes(context))
}
