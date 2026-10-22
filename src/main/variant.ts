// A variant is a separately built JIBES Studio – "JIBES Studio Test" (scripts/app-variant.mjs,
// `npm run app:install:test`) – with its own name, settings and suggested library (~/Movies/JIBES Studio Test),
// so one library can be kept apart from the ones JIBES Studio.app and `npm run dev` use. It runs beside them and never
// updates itself from GitHub: a release would replace it with JIBES Studio.

/** Put in at build time by electron.vite.config.ts from STUDIO_VARIANT; absent where a bundler doesn't define it. */
declare const __STUDIO_VARIANT__: string | undefined

/** The variant this build is ("Test"), or '' for Studio itself. */
export const VARIANT: string = typeof __STUDIO_VARIANT__ === 'string' ? __STUDIO_VARIANT__ : ''

/**
 * The name people see (the menu's About, Hide and Quit, the About panel, the agent connection): "JIBES Studio", or
 * "JIBES Studio Test" for a variant – the program's name too (electron-builder.yml). Inside, it keeps the name
 * Studio (Studio Test), which its settings folder and Keychain entry are named after (index.ts).
 */
export const PUBLIC_NAME = VARIANT ? `JIBES Studio ${VARIANT}` : 'JIBES Studio'
