#!/usr/bin/env node
// Builds Studio's native helpers into build/bin (gitignored), from where development runs them and electron-builder
// copies them into the app (extraResources → Contents/Resources/bin). Today that is one helper:
//
//   studio-voice-isolate  native/voice-isolate/main.swift  (voice/background separation with AUSoundIsolation)
//
// Run by `npm run build:helpers`, and before `dev`, `build` and `app`, so it must be quick when nothing changed: a
// stamp file next to the binary records a hash of the source and the compiler flags, and an up-to-date helper is left
// alone. Without the Swift compiler (or off macOS) it skips with a note; Studio then runs without voice separation.
// Set STUDIO_SKIP_HELPERS=1 to skip on purpose, or pass --force to rebuild.

import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'build', 'bin')
const force = process.argv.includes('--force')

const HELPERS = [
  {
    name: 'studio-voice-isolate',
    sources: ['native/voice-isolate/main.swift'],
    // arm64 only, like the app; macOS 13 is where AUSoundIsolation first shipped.
    flags: ['-O', '-target', 'arm64-apple-macos13']
  }
]

const log = (message) => console.log(`build-helpers: ${message}`)

/**
 * How to run swiftc: through xcrun with the macOS SDK (the toolchain's own swiftc can't find the standard library
 * without it), else a swiftc on PATH (a Swift toolchain installed outside Xcode). Undefined without either.
 */
function swiftCompiler() {
  const found = spawnSync('xcrun', ['--sdk', 'macosx', '--find', 'swiftc'], { encoding: 'utf8' })
  if (found.status === 0 && found.stdout.trim()) return { command: 'xcrun', prefix: ['--sdk', 'macosx', 'swiftc'] }
  const which = spawnSync('which', ['swiftc'], { encoding: 'utf8' })
  return which.status === 0 && which.stdout.trim() ? { command: which.stdout.trim(), prefix: [] } : undefined
}

function stampOf(helper, compilerVersion) {
  const hash = createHash('sha256')
  hash.update(compilerVersion)
  hash.update(JSON.stringify(helper.flags))
  for (const source of helper.sources) hash.update(readFileSync(join(root, source)))
  return hash.digest('hex')
}

function main() {
  if (process.env.STUDIO_SKIP_HELPERS === '1') {
    log('skipped (STUDIO_SKIP_HELPERS=1); voice separation stays unavailable in this build.')
    return
  }
  if (process.platform !== 'darwin') {
    log(`skipped on ${process.platform}: the helpers use macOS frameworks (voice separation is macOS only).`)
    return
  }
  const swiftc = swiftCompiler()
  if (!swiftc) {
    log(
      'skipped: the Swift compiler (swiftc) was not found. Install the Xcode Command Line Tools with ' +
        '`xcode-select --install` and run `npm run build:helpers`; until then Studio runs without voice separation.'
    )
    return
  }
  const version = spawnSync(swiftc.command, [...swiftc.prefix, '--version'], { encoding: 'utf8' })
  const compilerVersion = `${version.stdout ?? ''}${version.stderr ?? ''}`.trim()
  mkdirSync(outDir, { recursive: true })

  for (const helper of HELPERS) {
    const binary = join(outDir, helper.name)
    const stampFile = join(outDir, `.${helper.name}.stamp`)
    const stamp = stampOf(helper, compilerVersion)
    if (!force && existsSync(binary) && existsSync(stampFile) && readFileSync(stampFile, 'utf8').trim() === stamp) {
      log(`${helper.name} is up to date.`)
      continue
    }
    log(`compiling ${helper.name} (takes up to a minute the first time)…`)
    const tmp = join(outDir, `.${helper.name}.tmp`)
    rmSync(tmp, { force: true })
    try {
      execFileSync(swiftc.command, [...swiftc.prefix, ...helper.flags, '-o', tmp, ...helper.sources.map((s) => join(root, s))], {
        stdio: 'inherit',
        cwd: root
      })
      // Apple Silicon refuses to run unsigned code; an ad-hoc signature is enough for a local build.
      execFileSync('codesign', ['--force', '--sign', '-', '--identifier', helper.name, tmp], { stdio: 'inherit' })
      renameSync(tmp, binary)
      writeFileSync(stampFile, `${stamp}\n`)
      log(`built ${relative(root, binary)}.`)
    } catch (err) {
      rmSync(tmp, { force: true })
      console.error(`build-helpers: building ${helper.name} failed.`)
      throw err
    }
  }
}

try {
  main()
} catch {
  process.exit(1)
}
