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

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': resolve('src/shared') } },
    define: { __STUDIO_APP_ID__: JSON.stringify(appId) }
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
