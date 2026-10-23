// The ready-made directors: generic ways of making a film that every library has, read-only ("Copy to edit" copies one
// into the library as a director of its own, StudioApi.copyDirectorPreset). Their ids start with
// DIRECTOR_PRESET_PREFIX and are never stored as assets; params, sequences and storyboards may name them directly.
//
// The texts are written for Seedance-class video models: short concrete phrases (what the camera does, what the light
// is, what the grade looks like), the vocabulary of the building blocks (prompt-blocks.ts), no adjectives that say
// nothing ("beautiful", "amazing"), no real people's names. They stay English whatever the prompt language is: only the
// Direction section's heading and labels follow it (direction.ts). Names are made up and generic.

import { DIRECTOR_PRESET_PREFIX, type DirectorPreset } from './types'

/** The ready-made directors, in the order the pickers list them. */
export const DIRECTOR_PRESETS: readonly DirectorPreset[] = [
  {
    id: `${DIRECTOR_PRESET_PREFIX}documentary`,
    name: 'Documentary',
    description: 'Observational and handheld – real places, available light, nothing staged.',
    direction: {
      editing: 'unhurried observational cutting that holds on moments, with an occasional jump cut within a scene',
      shotSeconds: 6,
      continuity: 'cut',
      look: 'natural colour, true-to-life skin tones, gentle contrast, subtle 16mm grain',
      camera: 'handheld with subtle natural shake, follows the action at eye level, 35mm lens',
      light: 'available light only: daylight from windows and practical lamps, no added fill',
      framing: 'medium shots and close-ups on faces and hands, wide shots to set the place',
      rhythm: 'real-time pace, no slow motion',
      performance: 'naturalistic and unaware of the camera, small everyday gestures, no posing',
      sound: 'only natural ambient sound and location dialogue, no music',
      avoid: 'staged posing, glossy commercial look, lens flares, slow motion',
      defaults: { aspectRatio: '16:9' }
    }
  },
  {
    id: `${DIRECTOR_PRESET_PREFIX}music-video`,
    name: 'Music video',
    description: 'Bold and rhythmic – quick cuts on the beat, a moving camera and strong colour.',
    direction: {
      editing: 'fast cuts on the beat, match cuts on movement, speed ramps between shots',
      shotSeconds: 3,
      continuity: 'cut',
      look: 'saturated colour, deep blacks, high contrast, glossy finish',
      camera: 'dynamic moves: fast dolly in, orbit around the performer, low angles, smooth Steadicam glides',
      light: 'coloured backlight and rim light, neon accents, haze in the air',
      framing: 'bold close-ups of the performer alternating with wide stylised compositions, strong symmetry',
      rhythm: 'movement synced to the beat, short bursts of slow motion on the accents',
      performance: 'confident and expressive, performing to the camera',
      sound: 'the music drives everything, no dialogue',
      avoid: 'static shots, flat lighting, washed-out colour',
      defaults: { aspectRatio: '16:9' }
    }
  },
  {
    id: `${DIRECTOR_PRESET_PREFIX}noir`,
    name: 'Noir',
    description: 'Shadows and tension – hard light, deep blacks, slow deliberate moves.',
    direction: {
      editing: 'slow, deliberate cuts with lingering holds; cut on a look or a sound',
      shotSeconds: 6,
      continuity: 'cut',
      look: 'high-contrast black and white, deep inky shadows, fine film grain',
      camera: 'slow dolly moves, low angles, a slight Dutch tilt for tension, locked-off framing in dialogue',
      light: 'hard low-key side light, venetian-blind shadows, pools of streetlight, smoky haze',
      framing: 'tight close-ups half in shadow, silhouettes in doorways, deep-focus wide shots',
      rhythm: 'slow and tense, long pauses',
      performance: 'restrained and guarded, few words, meaningful glances',
      sound: 'rain on the street, distant traffic, a lonely saxophone far away',
      avoid: 'bright even lighting, saturated colour, handheld shake'
    }
  },
  {
    id: `${DIRECTOR_PRESET_PREFIX}commercial`,
    name: 'Commercial',
    description: 'Polished and bright – clean compositions that make the product and the people shine.',
    direction: {
      editing: 'clean, purposeful cuts that build to a hero shot, smooth match cuts',
      shotSeconds: 4,
      continuity: 'cut',
      look: 'polished commercial look, bright and clean, rich but natural colour, crisp detail',
      camera: 'smooth slider and gimbal moves, slow push-ins on details, a perfectly level horizon',
      light: 'soft, even key light with a gentle rim light, glossy highlights on surfaces',
      framing: 'hero close-ups of the product and hands, medium shots of people, generous negative space',
      rhythm: 'upbeat and confident, a touch of slow motion on the hero moment',
      performance: 'warm, natural smiles, relaxed and confident',
      sound: 'light upbeat music, crisp product sounds',
      avoid: 'film grain, dirt, harsh shadows, shaky camera, clutter',
      defaults: { aspectRatio: '16:9' }
    }
  },
  {
    id: `${DIRECTOR_PRESET_PREFIX}dreamy`,
    name: 'Dreamy',
    description: 'Soft and floating – hazy light, slow motion and a gentle glow.',
    direction: {
      editing: 'slow, soft transitions and long takes that linger on details',
      shotSeconds: 8,
      continuity: 'flow',
      look: 'soft focus, pastel tones, lifted blacks, gentle bloom and halation',
      camera: 'slow floating moves, a gentle drift and glide, shallow depth of field',
      light: 'hazy backlight, warm golden hour, sunlight flaring through leaves',
      framing: 'close-ups of faces and textures, wide airy compositions with lots of sky',
      rhythm: 'slow motion, unhurried and weightless',
      performance: 'quiet and introspective, soft gazes',
      sound: 'soft ambient pads, distant birdsong, near silence',
      avoid: 'hard light, fast cuts, harsh contrast, shaky camera'
    }
  },
  {
    id: `${DIRECTOR_PRESET_PREFIX}action`,
    name: 'Action',
    description: 'Kinetic and intense – fast cuts, a camera in the middle of it, real impact.',
    direction: {
      editing: 'fast, punchy cuts on impact, quick cutaways, an occasional whip-pan transition',
      shotSeconds: 3,
      continuity: 'cut',
      look: 'high contrast, teal and orange grade, crisp detail, slight motion blur',
      camera: 'energetic handheld, fast tracking shots that follow the action, low angles, wide lens close to the subject',
      light: 'hard directional light, strong backlight, sparks and dust catching the light',
      framing: 'tight close-ups on eyes and hands, dynamic wide shots of the action',
      rhythm: 'fast and relentless, a speed ramp into slow motion on the biggest impact',
      performance: 'physical and intense, determined',
      sound: 'heavy impacts, whooshes, driving percussion',
      avoid: 'static camera, slow pacing, soft dreamy look',
      defaults: { aspectRatio: '21:9' }
    }
  },
  {
    id: `${DIRECTOR_PRESET_PREFIX}vintage-film`,
    name: 'Vintage film',
    description: 'Like an old reel – warm grain, faded colour and a simple, classic camera.',
    direction: {
      editing: 'classic continuity cutting, simple fades between scenes',
      shotSeconds: 5,
      continuity: 'cut',
      look: 'shot on 16mm film, warm faded colour, visible grain, soft vignette, slight gate weave',
      camera: 'simple pans and tilts on a tripod, an occasional slow zoom, eye level',
      light: 'warm practical light and soft daylight, slightly overexposed highlights',
      framing: 'medium and wide shots, centred compositions, generous headroom like a home movie',
      rhythm: 'gentle and nostalgic',
      performance: 'natural and a little candid, an occasional glance at the camera',
      sound: 'a soft projector hum, faint crackle, warm room tone',
      avoid: 'digital sharpness, modern neon, drone shots',
      defaults: { aspectRatio: '4:3' }
    }
  },
  {
    id: `${DIRECTOR_PRESET_PREFIX}minimal`,
    name: 'Minimal',
    description: 'Calm and precise – still frames, clean space and few elements.',
    direction: {
      editing: 'few cuts; long, still takes; cut only when the composition changes',
      shotSeconds: 8,
      look: 'clean and muted, soft neutral palette, low contrast, crisp detail',
      camera: 'static locked-off camera with symmetrical framing, or a very slow push-in',
      light: 'soft diffused daylight, gentle shadows',
      framing: 'wide compositions with lots of negative space, one subject at a time, symmetry',
      rhythm: 'slow and calm, moments of stillness',
      performance: 'subtle and minimal, small deliberate movements',
      sound: 'quiet room tone, sparse sounds, long silences',
      avoid: 'clutter, busy backgrounds, fast camera moves, saturated colour'
    }
  }
]

/** The ready-made director with this id ("preset:noir"); undefined for any other id. */
export function directorPreset(id: unknown): DirectorPreset | undefined {
  return typeof id === 'string' ? DIRECTOR_PRESETS.find((p) => p.id === id) : undefined
}
