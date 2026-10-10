// Takes the README screenshots (docs/images/*.png) from the built app with a brand-new, empty profile and library in
// a temporary folder – never your own settings or library. Run `npm run build` first, then `npm run screenshots`.
//
// It only adds a little neutral structure to that throwaway library (a sequence and a storyboard with a few short
// notes – no media), opens each view at 1440 × 900 (2× pixels) and saves a PNG.
// Nothing is generated and no API key is used.

import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'docs', 'images')
const port = 9339
const electron = join(root, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')

const profile = mkdtempSync(join(tmpdir(), 'studio-screenshots-'))
const library = join(profile, 'Studio')
mkdirSync(join(profile, 'userData'), { recursive: true })
mkdirSync(library, { recursive: true })
mkdirSync(out, { recursive: true })

const app = spawn(electron, ['.', `--remote-debugging-port=${port}`], {
  cwd: root,
  env: { ...process.env, STUDIO_PROFILE_DIR: profile, STUDIO_DEV_PROFILE: '' },
  stdio: 'ignore'
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function connect() {
  for (let i = 0; i < 60; i++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
      const page = targets.find((t) => t.type === 'page')
      if (page) return page.webSocketDebuggerUrl
    } catch {
      // Not up yet.
    }
    await sleep(500)
  }
  throw new Error('The app did not start.')
}

const ws = new WebSocket(await connect())
await new Promise((r) => ws.addEventListener('open', r))
let id = 0
function send(method, params = {}) {
  const my = ++id
  return new Promise((resolve, reject) => {
    const onMessage = (m) => {
      const d = JSON.parse(m.data)
      if (d.id !== my) return
      ws.removeEventListener('message', onMessage)
      if (d.error) reject(new Error(d.error.message))
      else resolve(d.result)
    }
    ws.addEventListener('message', onMessage)
    ws.send(JSON.stringify({ id: my, method, params }))
  })
}
async function run(expression) {
  const r = await send('Runtime.evaluate', { expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'evaluate failed')
  return r.result.value
}
async function shot(name) {
  await sleep(900)
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(out, `${name}.png`), Buffer.from(data, 'base64'))
  console.log(`docs/images/${name}.png`)
}
/** Clicks the first button whose text (or accessible name) ends with `label`. */
const click = (label) =>
  run(`const b = [...document.querySelectorAll('button')].find((b) => (b.getAttribute('aria-label') || b.textContent || '').trim().endsWith(${JSON.stringify(label)})); b?.click(); await new Promise((r) => setTimeout(r, 700)); return !!b`)

try {
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false })
  await sleep(3000)

  // A new library in the throwaway folder (as choosing an empty folder in the app does), then the window reloads.
  // Not awaited inside the page: the window reloads when the library opens, and the old page never answers.
  await run(`window.studio.setLibraryRoot(${JSON.stringify(library)}, 'new'); return true`)
  for (let i = 0; i < 40; i++) {
    await sleep(500)
    const ready = await run(`return (await window.studio.libraryStatus()).state === 'ready'`).catch(() => false)
    if (ready) break
  }
  await sleep(1500)

  // A little neutral structure in the throwaway library.
  await run(`
    const s = await window.studio.createSequence('Kvällsscen')
    const seq = await window.studio.getSequence(s.id)
    const prompts = [
      'Wide establishing shot of a quiet harbour at dusk, boats rocking gently, warm lights coming on.',
      'Medium shot: a woman in a yellow raincoat walks along the pier towards the camera.',
      'Close-up: she stops and looks out over the water as the last light fades.'
    ]
    for (let i = 0; i < prompts.length; i++) {
      // A new sequence may start with an empty clip; the others are added.
      const segs = i < seq.segments.length ? seq.segments : (await window.studio.addSegment(s.id, {})).segments
      const seg = segs[i] ?? segs[segs.length - 1]
      await window.studio.updateSegment(seg.id, { params: { ...seg.params, prompt: prompts[i] } })
    }
    const b = await window.studio.createStoryboard('Hamnen', '16:9')
    const board = await window.studio.getStoryboard(b.id)
    const notes = ['Tom hamn i skymningen', 'Kvinna i gul regnjacka på piren', 'Hon ser ut över vattnet']
    for (let i = 0; i < notes.length; i++) {
      if (board.boards[i]) await window.studio.updateBoard(board.boards[i].id, { note: notes[i] })
      else await window.studio.addBoard(b.id, { note: notes[i] })
    }
    return true
  `)

  await click('Generera')
  await run(`
    const t = [...document.querySelectorAll('textarea')].find((t) => /Beskriv scenen/.test(t.placeholder))
    t.focus()
    document.execCommand('insertText', false, 'A lighthouse on a rocky cliff at dusk, waves breaking below, ')
    return true
  `)
  await shot('generate')

  // The building-block menu at the caret.
  await run(`document.execCommand('insertText', false, '/kamera'); return true`)
  await shot('prompt-blocks')
  await run(`
    const t = document.activeElement
    t.setSelectionRange(t.value.length - 7, t.value.length)
    document.execCommand('delete')
    t.blur()
    return true
  `)

  await click('Sekvenser')
  await run(`[...document.querySelectorAll('[role=button],div[tabindex]')].find((e) => /Kvällsscen/.test(e.textContent || ''))?.click(); await new Promise((r) => setTimeout(r, 800)); return true`)
  await shot('sequences')

  await click('Storyboards')
  await shot('storyboards')

  await click('Redigera')
  await shot('editor')
} finally {
  ws.close()
  app.kill()
  await sleep(500)
  rmSync(profile, { recursive: true, force: true })
}
