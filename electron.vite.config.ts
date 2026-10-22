import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * electron-builder.yml's appId, for main (__STUDIO_APP_ID__): on Windows the taskbar groups Studio's window with the
 * installer's shortcuts by it (app.setAppUserModelId), so it is read from the one place it is written.
 */
const baseAppId = /^appId:\s*(\S+)/m.exec(readFileSync(resolve('electron-builder.yml'), 'utf8'))?.[1]
if (!baseAppId) throw new Error('electron-builder.yml has no appId.')

/**
 * STUDIO_VARIANT, set by scripts/app-variant.mjs: the variant this build is ("Test" for Studio Test, see
 * src/main/variant.ts), for main (__STUDIO_VARIANT__); empty for Studio itself. A variant's appId has its name after
 * Studio's, as app-variant.mjs gives electron-builder.
 */
const variant = process.env.STUDIO_VARIANT ?? ''
if (variant && !/^[A-Z][A-Za-z0-9]{0,19}$/.test(variant)) {
  throw new Error('STUDIO_VARIANT must be a short name such as Test: a capital letter, then letters and digits.')
}
const appId = variant ? `${baseAppId}.${variant.toLowerCase()}` : baseAppId

/**
 * The GitHub repository Studio is released from ("owner/name"), for main (__STUDIO_REPO__): updates.ts asks its
 * releases for a newer Studio, as install.sh downloads them, so it is read from install.sh, where it is written.
 */
const repo = /^REPO="\$\{STUDIO_REPO:-([\w.-]+\/[\w.-]+)\}"$/m.exec(readFileSync(resolve('install.sh'), 'utf8'))?.[1]
if (!repo) throw new Error('install.sh has no REPO.')

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } },
    define: {
      __STUDIO_APP_ID__: JSON.stringify(appId),
      __STUDIO_REPO__: JSON.stringify(repo),
      __STUDIO_VARIANT__: JSON.stringify(variant)
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } }
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    resolve: { alias: { '@shared': resolve('src/shared') } }
  }
})
