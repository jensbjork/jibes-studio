// Takes the README's pictures and animations (docs/images/*.png, *.gif) from the built app with a brand-new, empty
// profile and library in a temporary folder – never your own settings or library. Run `npm run build` first, then
// `npm run screenshots`. Needs ffmpeg (for the demo clips and the GIFs).
//
// The throwaway library is filled with made-up content: the illustrations in scripts/demo-art.mjs (rendered inside the
// app's window), short clips made from them with ffmpeg (a slow camera move over a picture) imported as the user's own
// clips, characters, places, a product, an outfit, a pose, saved prompts, a sequence and a storyboard. Nothing is
// generated at Venice and no API key is used. The stills are taken at 1440 × 900 (2× pixels), the social preview at
// 1280 × 640; the animations are recorded at 1180 × 740 (2× pixels, scaled down) with a drawn pointer and typing, and
// encoded as GIFs (GitHub plays GIFs in a README, not videos). DEMO_ONLY=generate,sequence … records only those
// animations (the stills are always taken; DEMO_ONLY=none records none).

import { execFileSync, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEMO_ART } from './demo-art.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'docs', 'images')
const port = 9339
const electron = join(root, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
const only = process.env.DEMO_ONLY ? new Set(process.env.DEMO_ONLY.split(',')) : undefined

const profile = mkdtempSync(join(tmpdir(), 'studio-screenshots-'))
const library = join(profile, 'Studio')
const fx = join(profile, 'demo')
mkdirSync(join(profile, 'userData'), { recursive: true })
mkdirSync(library, { recursive: true })
mkdirSync(fx, { recursive: true })
mkdirSync(out, { recursive: true })

const ffmpeg = (args) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args])

// A window behind others paints no frames, and a screencast records none: keep it painting wherever it is.
const keepPainting = [
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling'
]
const app = spawn(electron, ['.', `--remote-debugging-port=${port}`, ...keepPainting], {
  cwd: root,
  env: { ...process.env, STUDIO_PROFILE_DIR: profile, STUDIO_DEV_PROFILE: '' },
  stdio: 'ignore'
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── The DevTools connection ──────────────────────────────────────────────────

let ws
let id = 0
const pending = new Map()
const listeners = new Map()

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

/** (Re)attaches to the window – a library opening reloads it. */
async function attach() {
  ws?.close()
  ws = new WebSocket(await connect())
  await new Promise((r) => ws.addEventListener('open', r))
  ws.addEventListener('message', (m) => {
    const d = JSON.parse(m.data)
    if (d.id && pending.has(d.id)) {
      pending.get(d.id)(d)
      pending.delete(d.id)
    } else if (d.method) listeners.get(d.method)?.(d.params)
  })
}

function send(method, params = {}) {
  const my = ++id
  return new Promise((resolve, reject) => {
    pending.set(my, (d) => (d.error ? reject(new Error(d.error.message)) : resolve(d.result)))
    ws.send(JSON.stringify({ id: my, method, params }))
  })
}

async function run(expression) {
  const r = await send('Runtime.evaluate', {
    expression: `(async () => { ${expression} })()`,
    awaitPromise: true,
    returnByValue: true
  })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'evaluate failed')
  return r.result.value
}

/** Saves the window as docs/images/<name>.png (or <dir>/<name>.png). */
async function shot(name, dir = out) {
  await sleep(900)
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(dir, `${name}.png`), Buffer.from(data, 'base64'))
  if (dir === out) console.log(`docs/images/${name}.png`)
}

/** Clicks the first button (or tab) whose text or accessible name starts with `label`. */
const click = (label) =>
  run(
    `const b = [...document.querySelectorAll('button,[role=tab]')].find((b) => (b.getAttribute('aria-label') || b.textContent || '').trim().startsWith(${JSON.stringify(label)})); b?.click(); await new Promise((r) => setTimeout(r, 700)); return !!b`
  )

const view = (width, height, scale) =>
  send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: scale,
    mobile: false
  })

// ── Recording ────────────────────────────────────────────────────────────────

// A pointer drawn into the page (a screencast has none) that glides to what is clicked, with a ripple on the click,
// and typing one character at a time. Installed after every reload; `demo` in page scripts.
const DEMO_KIT = `
  if (!window.demo) {
    const cursor = document.createElement('div')
    cursor.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24"><path d="M4 2 L4 19 L8.6 14.6 L11.8 21.4 L14.6 20.1 L11.4 13.4 L18 13.4 Z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>'
    Object.assign(cursor.style, { position: 'fixed', left: '0', top: '0', zIndex: 2147483647, pointerEvents: 'none',
      transform: 'translate(900px, 520px)', transition: 'transform 0.45s cubic-bezier(0.3, 0, 0.2, 1)', filter: 'drop-shadow(0 1px 2px rgba(0,0,0,0.5))' })
    document.body.appendChild(cursor)
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    // By the start of its name (aria-label, title or text, leading symbols and counts left out: "＋ From library").
    const names = (e) => [e.getAttribute('aria-label'), e.getAttribute('title'), e.textContent].filter(Boolean).map((t) => t.trim().replace(/^[^\\p{L}]+/u, ''))
    const find = (sel, text) => [...document.querySelectorAll(sel)].find((e) => e.offsetParent && (!text || names(e).some((n) => n.startsWith(text))))
    const move = async (el) => {
      if (!el) throw new Error('nothing to point at')
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      const r = el.getBoundingClientRect()
      cursor.style.transform = 'translate(' + Math.round(r.left + Math.min(r.width / 2, 60)) + 'px, ' + Math.round(r.top + r.height / 2) + 'px)'
      await wait(520)
    }
    const ripple = () => {
      const m = /translate\\((\\d+)px, (\\d+)px\\)/.exec(cursor.style.transform)
      const dot = document.createElement('div')
      Object.assign(dot.style, { position: 'fixed', left: (m ? +m[1] : 0) - 14 + 'px', top: (m ? +m[2] : 0) - 14 + 'px', width: '28px', height: '28px',
        borderRadius: '50%', background: 'rgba(255,255,255,0.35)', zIndex: 2147483646, pointerEvents: 'none', transition: 'transform 0.4s, opacity 0.4s' })
      document.body.appendChild(dot)
      requestAnimationFrame(() => { dot.style.transform = 'scale(1.8)'; dot.style.opacity = '0' })
      setTimeout(() => dot.remove(), 500)
    }
    window.demo = {
      wait, find, move,
      async click(sel, text) { const el = typeof sel === 'string' ? find(sel, text) : sel; await move(el); ripple(); await wait(120); el.click(); await wait(480) },
      async type(el, text, ms = 32) { el.focus(); for (const ch of text) { document.execCommand('insertText', false, ch); await wait(ms) } await wait(300) },
      /** Types "@" in the prompt and picks the reference named so from the menu that opens. */
      async mention(el, text) {
        await this.type(el, '@', 0)
        await wait(500)
        const option = [...document.querySelectorAll('[role=option]')].find((o) => o.textContent.includes(text))
        await this.click(option)
      },
      async choose(select, value) { await move(select); ripple(); const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; set.call(select, value); select.dispatchEvent(new Event('change', { bubbles: true })); await wait(900) }
    }
  }
  return true`

/** Records `scene` (page script using `demo`) and writes docs/images/<name>.gif, at `fps` frames a second. */
async function record(name, scene, fps = 12) {
  if (only && !only.has(name)) return
  const frames = []
  const dir = join(profile, `frames-${name}`)
  mkdirSync(dir, { recursive: true })
  listeners.set('Page.screencastFrame', (p) => {
    frames.push({ data: p.data, t: p.metadata.timestamp })
    send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {})
  })
  await run(DEMO_KIT)
  await send('Page.bringToFront')
  await send('Page.startScreencast', {
    format: 'jpeg',
    quality: 92,
    maxWidth: 2360,
    maxHeight: 1480,
    everyNthFrame: 1
  })
  await sleep(600)
  await run(scene)
  await sleep(1400)
  await send('Page.stopScreencast')
  listeners.delete('Page.screencastFrame')
  // A screencast sends a frame when the page changes: each frame lasts until the next one.
  const list = frames.map((f, i) => {
    const file = join(dir, `${String(i).padStart(5, '0')}.jpg`)
    writeFileSync(file, Buffer.from(f.data, 'base64'))
    const next = frames[i + 1]?.t ?? f.t + 1.2
    return `file '${file}'\nduration ${Math.max(0.02, next - f.t).toFixed(3)}`
  })
  list.push(`file '${join(dir, `${String(frames.length - 1).padStart(5, '0')}.jpg`)}'`)
  writeFileSync(join(dir, 'list.txt'), list.join('\n'))
  ffmpeg([
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    join(dir, 'list.txt'),
    '-vf',
    `fps=${fps},scale=1180:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=200:stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle`,
    '-loop',
    '0',
    join(out, `${name}.gif`)
  ])
  console.log(`docs/images/${name}.gif (${frames.length} frames)`)
}

// ── The demo library ─────────────────────────────────────────────────────────

/** Renders every illustration to <fx>/<name>.png inside the window (canvas), so no SVG tool is needed. */
async function renderArt() {
  for (const [name, art] of Object.entries(DEMO_ART)) {
    const [w, h] = art.wide ? [1280, 720] : [768, 1024]
    const png = await run(`
      const img = new Image()
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(${JSON.stringify(art.svg)})
      await img.decode()
      const c = document.createElement('canvas'); c.width = ${w}; c.height = ${h}
      c.getContext('2d').drawImage(img, 0, 0, ${w}, ${h})
      return c.toDataURL('image/png').slice('data:image/png;base64,'.length)`)
    writeFileSync(join(fx, `${name}.png`), Buffer.from(png, 'base64'))
  }
}

/** A 6-second clip from a wide picture: a slow push-in, with a quiet sound track. */
function clipFrom(name, title) {
  const file = join(fx, `${title}.mp4`)
  ffmpeg([
    '-loop',
    '1',
    '-i',
    join(fx, `${name}.png`),
    '-f',
    'lavfi',
    '-i',
    'anoisesrc=color=brown:amplitude=0.02:duration=6',
    '-vf',
    "scale=2560:1440,zoompan=z='min(zoom+0.0009,1.14)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=144:s=1280x720:fps=24",
    '-t',
    '6',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    file
  ])
  return file
}

async function seed() {
  const p = (name) => join(fx, `${name}.png`)
  const clips = {
    harbour: clipFrom('harbour', 'Harbour at dusk'),
    pier: clipFrom('mara-on-the-pier', 'Mara on the pier'),
    sea: clipFrom('looking-out', 'Looking out to sea'),
    lighthouse: clipFrom('lighthouse', 'The lighthouse')
  }
  await run(`
    const s = window.studio
    const add = async (kind, name, description, pics) => s.addAssetImages((await s.saveAsset({ kind, name, description })).id, pics)
    await add('character', 'Mara', 'woman in her thirties, short dark hair, bright yellow raincoat, calm and watchful', [${JSON.stringify(p('mara'))}])
    await add('character', 'Theo', 'fisherman in his sixties, grey beard, navy wool sweater', [${JSON.stringify(p('theo'))}])
    await add('character', 'Ines', 'teenage girl, curly red hair, green parka', [${JSON.stringify(p('ines'))}])
    await add('environment', 'Harbour at dusk', 'small fishing harbour at dusk, wet wooden pier, lamps coming on, boats at anchor', [${JSON.stringify(p('harbour'))}])
    await add('environment', 'The lighthouse', 'white lighthouse with red bands on a dark cliff above the sea, at night', [${JSON.stringify(p('lighthouse'))}])
    await add('product', 'Coffee tin', 'red enamel coffee tin with a cream label reading CAFÉ – Harbour Roast', [${JSON.stringify(p('coffee-tin'))}])
    await add('outfit', 'Yellow raincoat', 'bright yellow rubber raincoat with a hood and dark buttons', [${JSON.stringify(p('raincoat'))}])
    await add('pose', 'Looking out to sea', 'standing at a railing, one hand on it, looking into the distance', [${JSON.stringify(p('pose'))}])
    for (const [title, body, favorite] of [
      ['Harbour establishing shot', 'Wide establishing shot of a quiet harbour at dusk, boats rocking gently, warm lights coming on one by one.', true],
      ['Lighthouse push-in', 'Slow aerial push-in towards a lighthouse on a rocky cliff, waves breaking white below, its beam sweeping low clouds.', false],
      ['Rain close-up', 'Close-up of rain drops on a wet wooden pier, shallow depth of field, lamplight reflections.', false]
    ]) await s.savePrompt({ title, body, tags: ['harbour'], favorite })

    // Own clips: three on the clips of a sequence, the lighthouse into the clip feed and the Editor.
    await s.importVideoFiles([${JSON.stringify(clips.lighthouse)}], { kind: 'feed' })
    const q = await s.createSequence('Evening at the harbour')
    await s.updateSequence(q.id, { director: 'preset:noir' })
    let seq = await s.getSequence(q.id)
    const notes = ['The harbour falls quiet as the lights come on.', 'Mara walks out along the pier.', 'She stops and looks out to sea.']
    for (let i = 0; i < notes.length; i++) {
      const segs = i < seq.segments.length ? seq.segments : (await s.addSegment(q.id, {})).segments
      const seg = segs[i] ?? segs[segs.length - 1]
      seq = await s.updateSegment(seg.id, { notes: notes[i], params: { ...seg.params, model: 'seedance-2-5-text-to-video-basic', prompt: notes[i] } })
    }
    const takes = [${JSON.stringify(clips.harbour)}, ${JSON.stringify(clips.pier)}, ${JSON.stringify(clips.sea)}]
    for (let i = 0; i < takes.length; i++) await s.importVideoFiles([takes[i]], { kind: 'segment', segmentId: seq.segments[i].id })

    const b = await s.createStoryboard('The lighthouse', '16:9')
    await s.updateStoryboard(b.id, { director: 'preset:noir' })
    const board = await s.getStoryboard(b.id)
    const boards = [['Empty harbour at dusk', ${JSON.stringify(p('harbour'))}], ['Mara on the pier', ${JSON.stringify(p('mara-on-the-pier'))}], ['The lighthouse at night', ${JSON.stringify(p('lighthouse'))}]]
    for (let i = 0; i < boards.length; i++) {
      const patch = { note: boards[i][0], image: { kind: 'file', path: boards[i][1] } }
      if (board.boards[i]) await s.updateBoard(board.boards[i].id, patch)
      else await s.addBoard(b.id, patch)
    }

    const lighthouse = (await s.listGenerations()).find((g) => g.source === 'import' && /lighthouse/i.test(g.title ?? g.prompt ?? ''))
    if (lighthouse) await s.createEdit({ generationId: lighthouse.id }, 'The lighthouse – cut')
    return true`)
}

try {
  await attach()
  await view(1440, 900, 2)
  await sleep(3000)

  // A new library in the throwaway folder (as choosing an empty folder in the app does), then the window reloads.
  // Not awaited inside the page: the window reloads when the library opens, and the old page never answers.
  await run(`window.studio.setLibraryRoot(${JSON.stringify(library)}, 'new'); return true`).catch(() => {})
  await sleep(3000)
  await attach()
  await view(1440, 900, 2)
  for (let i = 0; i < 40; i++) {
    const ready = await run(`return (await window.studio.libraryStatus()).state === 'ready'`).catch(() => false)
    if (ready) break
    await sleep(500)
  }
  await sleep(1500)

  await renderArt()
  await seed()
  await run('location.reload(); return true').catch(() => {})
  await sleep(2500)
  await attach()
  await view(1440, 900, 2)
  await sleep(2500)

  // ── Stills ──
  await click('Generate')
  await click('Text')
  await run(`
    const select = [...document.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === 'preset:noir'))
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, 'preset:noir')
    select.dispatchEvent(new Event('change', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 500))
    const t = [...document.querySelectorAll('textarea')].find((t) => /Describe the scene/.test(t.placeholder))
    t.focus()
    document.execCommand('insertText', false, 'A lighthouse on a rocky cliff at dusk, waves breaking white below, its beam sweeping across low clouds. Slow aerial push-in towards the lantern room, the last warm light on the rocks.')
    t.blur()
    return true`)
  await run(`
    const t = [...document.querySelectorAll('textarea')].find((t) => /lighthouse/.test(t.value))
    t.focus(); t.setSelectionRange(t.value.length, t.value.length)
    document.execCommand('insertText', false, ' /camera')
    return true`)
  await shot('prompt-blocks')
  await run(
    `const t = document.activeElement; t.setSelectionRange(t.value.length - 8, t.value.length); document.execCommand('delete'); t.blur(); return true`
  )

  await click('Sequences')
  await run(
    `[...document.querySelectorAll('[data-side-row],[role=button],div[tabindex]')].find((e) => /Evening at the harbour/.test(e.textContent || ''))?.click(); await new Promise((r) => setTimeout(r, 900)); return true`
  )
  await shot('sequences', fx)
  await click('Characters')
  await run(
    `[...document.querySelectorAll('[data-side-row]')].find((e) => /Mara/.test(e.textContent || ''))?.click(); await new Promise((r) => setTimeout(r, 900)); return true`
  )
  await shot('library')
  await click('Directors')
  await run(
    `[...document.querySelectorAll('[data-side-row],[role=button],button,div[tabindex]')].find((e) => (e.textContent || '').trim().startsWith('Noir'))?.click(); await new Promise((r) => setTimeout(r, 800)); return true`
  )
  await shot('directors')
  await click('Editor')
  await shot('editor')

  // The repository's social preview (GitHub: Settings → General → Social preview, uploaded by hand): 1280 × 640, the
  // icon, the name and a screenshot, drawn over the window.
  await view(1280, 640, 1)
  await sleep(600)
  const png = (file) => 'data:image/png;base64,' + readFileSync(file).toString('base64')
  await run(`
    const card = document.createElement('div')
    card.id = 'social-card'
    card.innerHTML = \`
      <div style="position:absolute;inset:0;background:radial-gradient(900px 500px at 0% 100%, rgba(255,120,80,0.22), transparent 60%),radial-gradient(700px 500px at 100% 0%, rgba(255,80,160,0.18), transparent 60%),#0b0b0f"></div>
      <div style="position:absolute;left:72px;top:0;bottom:0;width:470px;display:flex;flex-direction:column;justify-content:center;gap:22px">
        <img src="${png(join(root, 'build', 'icon.png'))}" style="width:112px;height:112px;margin-left:-12px">
        <div style="font-size:64px;font-weight:700;letter-spacing:-1.5px;line-height:1;color:#fff">JIBES Studio</div>
        <div style="font-size:27px;line-height:1.35;color:#c9c9d2">Make films with Venice.ai’s video models – from one clip to a whole story.</div>
        <div style="font-size:19px;color:#8b8b96">Open source · macOS &amp; Windows</div>
      </div>
      <img src="${png(join(fx, 'sequences.png'))}" style="position:absolute;left:600px;top:84px;width:900px;border-radius:14px;border:1px solid rgba(255,255,255,0.12);box-shadow:0 30px 80px rgba(0,0,0,0.6)">\`
    Object.assign(card.style, { position: 'fixed', inset: '0', zIndex: 2147483647, overflow: 'hidden' })
    document.body.appendChild(card)
    await Promise.all([...card.querySelectorAll('img')].map((i) => i.decode()))
    return true`)
  await shot('social-preview')
  await run(`document.getElementById('social-card').remove(); return true`)

  // ── Animations ── (recorded at 2× and scaled down: sharper text in the README)
  await view(1180, 740, 2)
  await sleep(800)

  // Generate: references from the library, a prompt, a director – up to the button (never pressed: it is paid).
  await click('Generate')
  await click('References')
  await run(`
    const t = [...document.querySelectorAll('textarea')].find((t) => /Describe the scene/.test(t.placeholder))
    t.focus(); t.select(); document.execCommand('delete'); t.blur()
    const director = [...document.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === 'preset:noir'))
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(director, director.options[0].value)
    director.dispatchEvent(new Event('change', { bubbles: true }))
    return true`)
  await record(
    'generate',
    `
    await demo.click('button', 'From library')
    await demo.click('[role=tab]', 'Characters')
    await demo.click('button', 'Mara')
    await demo.click('button', 'From library')
    await demo.click('[role=tab]', 'Environments')
    await demo.click('button', 'Harbour at dusk')
    const t = [...document.querySelectorAll('textarea')].find((t) => /Describe the scene/.test(t.placeholder))
    await demo.click(t)
    await demo.mention(t, 'Mara')
    await demo.type(t, 'walks along the wet pier of ')
    await demo.mention(t, 'Harbour at dusk')
    await demo.type(t, 'as the lamps come on one by one. Slow dolly in, warm light.')
    t.blur()
    await demo.wait(400)
    const director = [...document.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === 'preset:noir'))
    await demo.choose(director, 'preset:noir')
    await demo.move([...document.querySelectorAll('button')].find((b) => /^Generate/.test(b.textContent.trim()) && b.textContent.includes('$')))
    await demo.wait(1500)
    return true`
  )

  // A sequence: the clips and their takes, then the whole film in Preview.
  await click('Sequences')
  await run(
    `[...document.querySelectorAll('[data-side-row]')].find((e) => /Evening at the harbour/.test(e.textContent || ''))?.click(); await new Promise((r) => setTimeout(r, 900)); return true`
  )
  await record(
    'sequence',
    `
    const card = (text) => [...document.querySelectorAll('div, button, li')].reverse().find((e) => e.textContent?.trim().includes(text) && e.getBoundingClientRect().top < 260 && e.getBoundingClientRect().height < 260)
    await demo.click(card('Mara on the pier') ?? card('Mara walks'))
    await demo.wait(900)
    await demo.click(card('Looking out to sea') ?? card('She stops'))
    await demo.wait(900)
    await demo.click('button', 'Preview')
    await demo.wait(6500)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await demo.wait(800)
    return true`,
    9
  )

  // A storyboard: the key moments as pictures; a transition between two of them gets its prompt suggested from the
  // boards' notes, and a touch more – up to the button (never pressed).
  await run(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true`)
  await click('Storyboards')
  await record(
    'storyboard',
    `
    await demo.wait(900)
    const transition = [...document.querySelectorAll('button, [role=button], div[tabindex]')].find((e) => /^Transition 1/.test(e.textContent?.trim() ?? ''))
    await demo.click(transition)
    await demo.wait(900)
    await demo.click('button', 'Suggest')
    await demo.wait(900)
    const label = [...document.querySelectorAll('label')].find((l) => l.textContent.trim() === 'What happens?')
    const t = document.getElementById(label.htmlFor)
    await demo.click(t)
    t.focus(); t.setSelectionRange(t.value.length, t.value.length)
    await demo.type(t, ' The lamps come on one by one; slow dolly in.')
    t.blur()
    await demo.wait(500)
    await demo.move([...document.querySelectorAll('button')].find((b) => /^Generate/.test(b.textContent.trim()) && b.textContent.includes('$')))
    await demo.wait(1800)
    return true`
  )
} finally {
  ws?.close()
  app.kill()
  await sleep(500)
  rmSync(profile, { recursive: true, force: true })
}
