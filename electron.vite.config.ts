import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * electron-builder.yml's appId, for main (__STUDIO_APP_ID__): on Windows the taskbar groups Studio's window with the
 * installer's shortcuts by it (app.setAppUserModelId), so it is read from the one place it is written.
 */
const appId = /^appId:\s*(\S+)/m.exec(readFileSync(resolve('electron-builder.yml'), 'utf8'))?.[1]
if (!appId) throw new Error('electron-builder.yml has no appId.')

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
    define: { __STUDIO_APP_ID__: JSON.stringify(appId), __STUDIO_REPO__: JSON.stringify(repo) }
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
