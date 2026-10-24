// The models the Editor, voice design, a song's lyrics and Create image… start from, per service (provider.ts): the
// same choices on Venice and fal.ai – Seedance 2.5 for pictures in motion, Topaz to upscale, ElevenLabs for speech,
// effects and transcripts, Chatterbox for a cloned voice, ACE-Step for music – each under the service's own id.
// Shared by main (edit-ops.ts, song.ts), the window's cards and the agents' defaults.

import { FAL_PREFIX, activeProvider, type Provider } from './provider'

export interface ServiceModels {
  /** Regenerate section and Extend: image-to-video between (or from) frames of the film. */
  i2v: string
  /** Edit with prompt: Seedance 2.5 reference-to-video in its edit task. */
  promptEdit: string
  upscale: string
  /** Lip sync (fal only). */
  lipSync?: string
  transcription: string
  /** New lines in a preset voice, and in a cloned one. */
  speech: string
  cloneSpeech: string
  music: string
  effect: string
  /** A voice from a description. */
  voiceDesign: string
}

const VENICE: ServiceModels = {
  i2v: 'seedance-2-5-image-to-video-basic',
  promptEdit: 'seedance-2-5-reference-to-video-basic',
  upscale: 'topaz-video-upscale',
  transcription: 'elevenlabs/scribe-v2',
  speech: 'elevenlabs-tts-multilingual-v2',
  cloneSpeech: 'tts-chatterbox-hd',
  music: 'ace-step-15',
  effect: 'elevenlabs-sound-effects-v2',
  voiceDesign: 'seed-audio-1-0'
}

const fal = (endpoint: string): string => FAL_PREFIX + endpoint

const FAL: ServiceModels = {
  i2v: fal('bytedance/seedance-2.5/image-to-video'),
  promptEdit: fal('bytedance/seedance-2.5/reference-to-video'),
  upscale: fal('fal-ai/topaz/upscale/video'),
  lipSync: fal('fal-ai/sync-lipsync/v2'),
  transcription: fal('fal-ai/elevenlabs/speech-to-text/scribe-v2'),
  speech: fal('fal-ai/elevenlabs/tts/eleven-v3'),
  cloneSpeech: fal('fal-ai/chatterbox/text-to-speech'),
  music: fal('fal-ai/ace-step/prompt-to-audio'),
  effect: fal('fal-ai/elevenlabs/sound-effects/v2'),
  voiceDesign: fal('fal-ai/qwen-3-tts/voice-design/1.7b')
}

/** A service's models. */
export function serviceModels(provider: Provider): ServiceModels {
  return provider === 'fal' ? FAL : VENICE
}

/** The active service's models (read when used, so they follow a switch). */
export function activeServiceModels(): ServiceModels {
  return serviceModels(activeProvider())
}
