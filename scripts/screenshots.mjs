// Takes the README screenshots (docs/images/*.png) from the built app with a brand-new, empty profile and library in
// a temporary folder – never your own settings or library. Run `npm run build` first, then `npm run screenshots`.
//
// It only adds a little made-up structure to that throwaway library – a sequence and a storyboard with short notes and
// prompts, directed by one of the ready-made directors, and the Generate form filled in – no media; opens each view at
// 1440 × 900 (2× pixels) and saves a PNG. Nothing is generated and no API key is used.

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

  // A little made-up structure in the throwaway library: text-to-video clips, ready to generate, directed by a
  // ready-made director.
  const T2V = 'seedance-2-5-text-to-video-basic'
  const DIRECTOR = 'preset:noir'
  await run(`
    const s = await window.studio.createSequence('Evening at the harbour')
    await window.studio.updateSequence(s.id, { director: ${JSON.stringify(DIRECTOR)} })
    const seq = await window.studio.getSequence(s.id)
    const clips = [
      ['The harbour falls quiet as the lights come on.', 'Wide establishing shot of a quiet harbour at dusk, boats rocking gently, warm lights coming on one by one.'],
      ['She walks along the pier towards us.', 'Medium shot: a woman in a yellow raincoat walks along the wet pier towards the camera, rain catching the lamplight.'],
      ['She stops and looks out over the water.', 'Close-up: she stops at the end of the pier and looks out over the water as the last light fades.']
    ]
    for (let i = 0; i < clips.length; i++) {
      // A new sequence may start with an empty clip; the others are added.
      const segs = i < seq.segments.length ? seq.segments : (await window.studio.addSegment(s.id, {})).segments
      const seg = segs[i] ?? segs[segs.length - 1]
      const [notes, prompt] = clips[i]
      await window.studio.updateSegment(seg.id, { notes, params: { ...seg.params, model: ${JSON.stringify(T2V)}, prompt } })
    }
    const b = await window.studio.createStoryboard('The harbour', '16:9')
    await window.studio.updateStoryboard(b.id, { director: ${JSON.stringify(DIRECTOR)} })
    const board = await window.studio.getStoryboard(b.id)
    const notes = ['Empty harbour at dusk', 'A woman in a yellow raincoat on the pier', 'She looks out over the water', 'The lighthouse beam sweeps the bay']
    for (let i = 0; i < notes.length; i++) {
      if (board.boards[i]) await window.studio.updateBoard(board.boards[i].id, { note: notes[i] })
      else await window.studio.addBoard(b.id, { note: notes[i] })
    }
    return true
  `)

  // The Generate form filled in as a user does: text-to-video, the same director, a prompt.
  await click('Generate')
  await click('Text')
  const filled = await run(`
    const select = [...document.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === ${JSON.stringify(DIRECTOR)}))
    if (select) {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, ${JSON.stringify(DIRECTOR)})
      select.dispatchEvent(new Event('change', { bubbles: true }))
    }
    await new Promise((r) => setTimeout(r, 500))
    const t = [...document.querySelectorAll('textarea')].find((t) => /Describe the scene/.test(t.placeholder))
    t.focus()
    document.execCommand('insertText', false, 'A lighthouse on a rocky cliff at dusk, waves breaking white below, its beam sweeping across low clouds. Slow aerial push-in towards the lantern room, the last warm light on the rocks.')
    t.blur()
    return { director: !!select, prompt: !!t }
  `)
  if (!filled.director || !filled.prompt) throw new Error(`The Generate form wasn't filled in: ${JSON.stringify(filled)}`)
  await shot('generate')

  // The building-block menu at the caret.
  await run(`
    const t = [...document.querySelectorAll('textarea')].find((t) => /lighthouse/.test(t.value))
    t.focus()
    t.setSelectionRange(t.value.length, t.value.length)
    document.execCommand('insertText', false, ' /camera')
    return true
  `)
  await shot('prompt-blocks')
  await run(`
    const t = document.activeElement
    t.setSelectionRange(t.value.length - 8, t.value.length)
    document.execCommand('delete')
    t.blur()
    return true
  `)

  await click('Sequences')
  await run(`[...document.querySelectorAll('[role=button],div[tabindex]')].find((e) => /Evening at the harbour/.test(e.textContent || ''))?.click(); await new Promise((r) => setTimeout(r, 800)); return true`)
  await shot('sequences')

  await click('Storyboards')
  await shot('storyboards')

  // Directors: the ready-made ones, one of them open.
  await click('Directors')
  await run(`[...document.querySelectorAll('[role=button],[role=option],button,div[tabindex]')].find((e) => (e.textContent || '').trim().startsWith('Noir'))?.click(); await new Promise((r) => setTimeout(r, 800)); return true`)
  await shot('directors')
} finally {
  ws.close()
  app.kill()
  await sleep(500)
  rmSync(profile, { recursive: true, force: true })
}
