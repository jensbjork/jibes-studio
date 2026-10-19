#!/usr/bin/env node
// Starts a built Studio and checks over the Chrome DevTools Protocol that it works: the window shows Studio, ffmpeg is
// found and reports its version, a new (empty) library can be created – which loads the SQLite database – and Settings
// renders with ffmpeg in it. Then Studio is closed. The release workflow runs it on the Windows build; it works on a
// Mac build too.
//
//   node scripts/smoke-test.mjs [app] [--bundled-ffmpeg] [--port 9360] [--screenshot file.png]
//
// app: the built program; by default dist/win-unpacked/Studio.exe on Windows, dist/mac-arm64/Studio.app on a Mac.
// --bundled-ffmpeg: ffmpeg must be the one that comes with the app (its resources/ffmpeg), not one on the system.
// --screenshot: saves what the window shows at the end, also when a check failed.
//
// Everything happens in a new temporary profile (settings and the library), deleted afterwards: never your own
// settings or library. Nothing is generated, no API key is used and nothing is sent to Venice.

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const option = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}
const positional = args.filter((a, i) => !a.startsWith('--') && !['--port', '--screenshot'].includes(args[i - 1]))
const bundledFfmpeg = args.includes('--bundled-ffmpeg')
const port = Number(option('--port') ?? 9360)
const screenshot = option('--screenshot')

function defaultApp() {
  if (process.platform === 'win32') return join(root, 'dist', 'win-unpacked', 'Studio.exe')
  if (process.platform === 'darwin') return join(root, 'dist', 'mac-arm64', 'Studio.app')
  return join(root, 'dist', 'linux-unpacked', 'studio')
}

/** The executable inside a macOS .app bundle; anything else is run as it is. */
function executableOf(app) {
  return app.endsWith('.app') ? join(app, 'Contents', 'MacOS', 'Studio') : app
}

const appPath = resolve(positional[0] ?? defaultApp())
const executable = executableOf(appPath)
if (!existsSync(executable)) {
  console.error(`smoke-test: ${executable} doesn't exist. Build the app first.`)
  process.exit(1)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (message) => console.log(`smoke-test: ${message}`)

const profile = mkdtempSync(join(tmpdir(), 'studio-smoke-'))
const library = join(profile, 'Library')
const env = { ...process.env, STUDIO_PROFILE_DIR: profile }
delete env.STUDIO_DEV_PROFILE
delete env.ELECTRON_RUN_AS_NODE

log(`starting ${executable} with a temporary profile`)
const child = spawn(executable, [`--remote-debugging-port=${port}`], { env, stdio: ['ignore', 'pipe', 'pipe'] })
let output = ''
const keep = (chunk) => {
  output = (output + chunk.toString()).slice(-8000)
}
child.stdout.on('data', keep)
child.stderr.on('data', keep)
let exited = false
const exitedPromise = new Promise((r) =>
  child.on('exit', (code, signal) => {
    exited = true
    r({ code, signal })
  })
)

async function pageTarget() {
  for (let i = 0; i < 120; i++) {
    if (exited) throw new Error('Studio quit before its window opened.')
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
      const page = targets.find((t) => t.type === 'page')
      if (page) return page.webSocketDebuggerUrl
    } catch {
      // Not up yet.
    }
    await sleep(500)
  }
  throw new Error('Studio did not open a window within 60 s.')
}

let ws
let nextId = 0
const exceptions = []
function send(method, params = {}) {
  const id = ++nextId
  return new Promise((resolvePromise, reject) => {
    const onMessage = (m) => {
      const d = JSON.parse(m.data)
      if (d.id !== id) return
      ws.removeEventListener('message', onMessage)
      if (d.error) reject(new Error(d.error.message))
      else resolvePromise(d.result)
    }
    ws.addEventListener('message', onMessage)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

/** Runs an async function body in the window and returns its value. */
async function evaluate(body) {
  const r = await send('Runtime.evaluate', {
    expression: `(async () => { ${body} })()`,
    awaitPromise: true,
    returnByValue: true
  })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  return r.result.value
}

/** Polls `body` until it returns something truthy (errors while the window reloads count as not yet). */
async function waitFor(what, body, seconds = 30) {
  for (let i = 0; i < seconds * 4; i++) {
    const value = await evaluate(body).catch(() => undefined)
    if (value) return value
    await sleep(250)
  }
  throw new Error(`Timed out after ${seconds} s waiting for ${what}.`)
}

function check(ok, message) {
  if (!ok) throw new Error(message)
}

let failure
try {
  ws = new WebSocket(await pageTarget())
  await new Promise((r, reject) => {
    ws.addEventListener('open', r)
    ws.addEventListener('error', () => reject(new Error('Could not connect to the window.')))
  })
  ws.addEventListener('message', (m) => {
    const d = JSON.parse(m.data)
    if (d.method === 'Runtime.exceptionThrown') exceptions.push(d.params.exceptionDetails?.exception?.description)
  })
  await send('Runtime.enable')

  // 1. The window is Studio's, with its API.
  await waitFor('the window to load', `return document.readyState === 'complete' && !!window.studio`)
  const title = await evaluate('return document.title')
  check(title === 'Studio', `The window's title is "${title}", not "Studio".`)
  const platform = await evaluate('return window.studio.platform')
  check(platform === process.platform, `window.studio.platform is "${platform}" on ${process.platform}.`)
  log(`the window shows Studio (platform ${platform}).`)

  // 2. ffmpeg is found and runs.
  const ffmpeg = await evaluate('return await window.studio.ffmpegStatus()')
  check(ffmpeg?.ok, `ffmpeg was not found: ${ffmpeg?.message ?? 'no answer'}`)
  check(!!ffmpeg.version && ffmpeg.version !== 'unknown', 'ffmpeg did not report its version.')
  if (bundledFfmpeg) {
    const resources = executable.endsWith('.exe')
      ? join(dirname(executable), 'resources', 'ffmpeg')
      : join(appPath, 'Contents', 'Resources', 'ffmpeg')
    check(
      resolve(ffmpeg.path).toLowerCase().startsWith((resources + sep).toLowerCase()),
      `ffmpeg is ${ffmpeg.path}, not the one in ${resources}.`
    )
    // FFmpeg's licence and where its source is go with it (THIRD_PARTY_NOTICES.md).
    for (const file of ['LICENSE.txt', 'SOURCE.txt']) {
      check(existsSync(join(resources, file)), `${file} is missing beside ffmpeg.`)
    }
  }
  log(`ffmpeg ${ffmpeg.version} at ${ffmpeg.path}.`)

  // 3. A new, empty library in the temporary profile: the database is created and migrated. The window reloads when
  // it opens, so the call is not awaited inside the page.
  await evaluate(`window.studio.setLibraryRoot(${JSON.stringify(library)}, 'new'); return true`)
  await waitFor('the new library to open', `return (await window.studio.libraryStatus()).state === 'ready'`, 60)
  log('a new library was created and opened.')

  // 4. Settings renders (without an API key Studio opens on it), with ffmpeg in it.
  await waitFor(
    'Settings to render',
    `return [...document.querySelectorAll('h1')].some((h) => h.textContent.trim() === 'Settings')`
  )
  await waitFor('ffmpeg in Settings', `return document.body.innerText.includes('ffmpeg was found')`)
  log('Settings renders and shows ffmpeg.')

  const separation = await evaluate('return await window.studio.separationStatus()').catch(() => undefined)
  if (separation) log(`voice separation: ${separation.available ? 'available' : separation.message}`)
  if (exceptions.length) log(`errors in the window (not failing the test):\n  ${exceptions.join('\n  ')}`)
} catch (err) {
  failure = err
} finally {
  if (screenshot && ws?.readyState === WebSocket.OPEN) {
    try {
      const { data } = await send('Page.captureScreenshot', { format: 'png' })
      writeFileSync(screenshot, Buffer.from(data, 'base64'))
      log(`screenshot: ${screenshot}`)
    } catch (err) {
      log(`no screenshot: ${err instanceof Error ? err.message : err}`)
    }
  }
  // Closing the window quits Studio on Windows; a Mac app stays open without windows, so it is stopped.
  if (ws?.readyState === WebSocket.OPEN) await evaluate('window.close(); return true').catch(() => {})
  ws?.close()
  const quit = await Promise.race([exitedPromise, sleep(15_000).then(() => undefined)])
  if (!quit) {
    child.kill()
    await Promise.race([exitedPromise, sleep(10_000)])
  }
  // Windows may hold the profile's files for a moment after the process ends.
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
}

if (failure) {
  console.error(`smoke-test: FAILED – ${failure instanceof Error ? failure.message : failure}`)
  if (output.trim()) console.error(`Studio's output (last lines):\n${output.trim().split('\n').slice(-40).join('\n')}`)
  process.exit(1)
}
log('passed.')
