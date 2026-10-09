// Building blocks for writing prompts: ready-made English phrases behind Swedish labels, grouped by what they
// describe (framing, camera, light…). The prompt fields offer them through "/" and the chips under the field;
// agents read the same list (get_prompt_blocks) so both write in the same vocabulary.

/** What a field is for; decides which groups it offers. */
export type PromptBlockContext = 'video' | 'image' | 'negative' | 'music' | 'sound'

export interface PromptBlock {
  /** Swedish, what the user picks. */
  label: string
  /** English, what goes into the prompt. */
  text: string
}

export interface PromptBlockGroup {
  id: string
  /** Swedish, short: the chip and the menu heading. */
  label: string
  /** The fields that offer this group. */
  contexts: readonly PromptBlockContext[]
  blocks: readonly PromptBlock[]
}

const VISUAL: readonly PromptBlockContext[] = ['video', 'image']

export const PROMPT_BLOCK_GROUPS: readonly PromptBlockGroup[] = [
  {
    id: 'scene',
    label: 'Mall',
    contexts: VISUAL,
    blocks: [
      {
        label: 'Scen: motiv, handling, plats, kamera, ljus, stämning',
        text: 'Subject: \nAction: \nSetting: \nCamera: \nLighting: \nMood: '
      },
      { label: 'Kort scen i en mening', text: '[who] [does what] in [where], [camera], [light], [mood].' },
      { label: 'Dialog', text: 'She says: "…"' }
    ]
  },
  {
    id: 'framing',
    label: 'Utsnitt',
    contexts: VISUAL,
    blocks: [
      { label: 'Extrem närbild', text: 'extreme close-up' },
      { label: 'Närbild', text: 'close-up shot' },
      { label: 'Halvbild', text: 'medium shot' },
      { label: 'Helbild', text: 'full shot, head to toe' },
      { label: 'Totalbild', text: 'wide establishing shot' },
      { label: 'Över axeln', text: 'over-the-shoulder shot' },
      { label: 'Ovanifrån', text: 'high angle, looking down' },
      { label: 'Underifrån', text: 'low angle, looking up' },
      { label: 'Fågelperspektiv', text: "top-down bird's-eye view" },
      { label: 'Ögonhöjd', text: 'eye-level shot' },
      { label: 'Profil', text: 'side profile shot' }
    ]
  },
  {
    id: 'camera',
    label: 'Kamera',
    contexts: ['video'],
    blocks: [
      { label: 'Stilla kamera', text: 'static locked-off camera' },
      { label: 'Långsam åkning in', text: 'slow dolly in' },
      { label: 'Långsam åkning ut', text: 'slow dolly out' },
      { label: 'Panorera vänster', text: 'slow pan left' },
      { label: 'Panorera höger', text: 'slow pan right' },
      { label: 'Tilta upp', text: 'tilt up' },
      { label: 'Tilta ner', text: 'tilt down' },
      { label: 'Följer personen', text: 'tracking shot following the subject' },
      { label: 'Handhållen', text: 'handheld camera with subtle natural shake' },
      { label: 'Kranåkning uppåt', text: 'crane shot rising up' },
      { label: 'Kretsar runt', text: 'the camera slowly orbits around the subject' },
      { label: 'Zoomar in', text: 'slow zoom in' },
      { label: 'En tagning utan klipp', text: 'one continuous shot, no cuts' }
    ]
  },
  {
    id: 'light',
    label: 'Ljus',
    contexts: VISUAL,
    blocks: [
      { label: 'Mjukt morgonljus', text: 'soft morning light' },
      { label: 'Gyllene timmen', text: 'warm golden hour light' },
      { label: 'Blå timmen', text: 'cool blue hour light' },
      { label: 'Dämpat nattljus', text: 'dim night lighting' },
      { label: 'Fönsterljus', text: 'soft natural window light' },
      { label: 'Hårt sidoljus', text: 'hard side light with deep shadows' },
      { label: 'Motljus', text: 'backlit, rim light around the subject' },
      { label: 'Neon', text: 'neon lighting, saturated colours' },
      { label: 'Levande ljus', text: 'warm flickering candlelight' },
      { label: 'Mulet dagsljus', text: 'flat overcast daylight' },
      { label: 'Filmiskt ljus', text: 'cinematic lighting, high contrast' }
    ]
  },
  {
    id: 'style',
    label: 'Stil',
    contexts: VISUAL,
    blocks: [
      { label: 'Filmisk', text: 'cinematic, shallow depth of field' },
      { label: 'Fotorealistisk', text: 'photorealistic, natural skin texture' },
      { label: '35 mm film', text: 'shot on 35mm film, natural grain' },
      { label: 'Dokumentär', text: 'documentary style' },
      { label: 'Reklamfilm', text: 'polished commercial look' },
      { label: 'Musikvideo', text: 'music video aesthetic' },
      { label: 'Drömsk', text: 'dreamy, soft focus' },
      { label: 'Mörk och dyster', text: 'dark, moody atmosphere' },
      { label: 'Ljus och luftig', text: 'bright and airy' },
      { label: 'Spänd', text: 'tense, suspenseful mood' },
      { label: 'Lugn', text: 'calm, peaceful mood' }
    ]
  },
  {
    id: 'motion',
    label: 'Rörelse',
    contexts: ['video'],
    blocks: [
      { label: 'Slow motion', text: 'in slow motion' },
      { label: 'Långsamt och mjukt', text: 'slow, smooth movement' },
      { label: 'Snabbt och energiskt', text: 'fast, energetic movement' },
      { label: 'Små naturliga rörelser', text: 'subtle natural movement, breathing, blinking' },
      { label: 'Vind i håret', text: 'hair moving gently in the wind' },
      { label: 'Vänder sig mot kameran', text: 'turns to face the camera' },
      { label: 'Går mot kameran', text: 'walks towards the camera' },
      { label: 'Går ifrån kameran', text: 'walks away from the camera' }
    ]
  },
  {
    id: 'sound',
    label: 'Ljud',
    contexts: ['video'],
    blocks: [
      { label: 'Bara naturliga ljud', text: 'only natural ambient sound, no music' },
      { label: 'Rumsljud', text: 'quiet room tone' },
      { label: 'Lugn bakgrundsmusik', text: 'soft background music' },
      { label: 'Fotsteg', text: 'footsteps on a wooden floor' },
      { label: 'Stadsljud', text: 'distant city traffic' },
      { label: 'Regn', text: 'rain against the window' },
      { label: 'Fåglar', text: 'birdsong outside' },
      { label: 'Tystnad', text: 'near silence' }
    ]
  },
  {
    id: 'avoid',
    label: 'Undvik',
    contexts: ['negative'],
    blocks: [
      { label: 'Suddigt', text: 'blurry, out of focus' },
      { label: 'Text och vattenstämplar', text: 'text, captions, watermarks, logos' },
      { label: 'Förvrängda händer', text: 'distorted hands, extra fingers' },
      { label: 'Förvrängda ansikten', text: 'distorted faces' },
      { label: 'Extra kroppsdelar', text: 'extra limbs' },
      { label: 'Klipp och scenbyten', text: 'cuts, scene changes' },
      { label: 'Flimmer', text: 'flickering' },
      { label: 'Tecknad stil', text: 'cartoon, illustration' },
      { label: 'Låg kvalitet', text: 'low quality, compression artifacts' },
      { label: 'Musik', text: 'music' }
    ]
  },
  {
    id: 'music',
    label: 'Musik',
    contexts: ['music'],
    blocks: [
      { label: 'Lugnt piano', text: 'calm solo piano' },
      { label: 'Stråkar, spänt', text: 'tense string ensemble' },
      { label: 'Filmisk orkester', text: 'cinematic orchestral score' },
      { label: 'Elektroniskt, pulserande', text: 'pulsing electronic beat' },
      { label: 'Lo-fi', text: 'mellow lo-fi hip hop' },
      { label: 'Akustisk gitarr', text: 'warm acoustic guitar' },
      { label: 'Ambient', text: 'slow ambient pads' },
      { label: 'Instrumentalt', text: 'instrumental, no vocals' },
      { label: 'Långsamt tempo', text: 'slow tempo' },
      { label: 'Högt tempo', text: 'high tempo' }
    ]
  },
  {
    id: 'effects',
    label: 'Ljudeffekter',
    contexts: ['sound'],
    blocks: [
      { label: 'Dörr som slår igen', text: 'a door slamming shut' },
      { label: 'Fotsteg', text: 'footsteps on a wooden floor' },
      { label: 'Regn', text: 'steady rain' },
      { label: 'Åska', text: 'distant thunder' },
      { label: 'Glas som krossas', text: 'glass shattering' },
      { label: 'Vind', text: 'wind howling' },
      { label: 'Publik som applåderar', text: 'a crowd applauding' },
      { label: 'Telefon som ringer', text: 'a phone ringing' }
    ]
  }
]

/** The groups a field of this kind offers, in order. */
export function promptBlockGroups(context: PromptBlockContext): PromptBlockGroup[] {
  return PROMPT_BLOCK_GROUPS.filter((g) => g.contexts.includes(context))
}
