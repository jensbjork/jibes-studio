#!/usr/bin/env node
// Builds a variant of Studio for this Mac: a separately named app ("Studio Test") with its own settings, its own
// suggested library (~/Movies/Studio Test) and its own place in the Dock, that runs beside Studio.app and Studio Dev
// and never updates itself from GitHub (src/main/variant.ts). For keeping one library apart from the ones you try
// things out in.
//
//   node scripts/app-variant.mjs Test            builds dist/test/mac-arm64/Studio Test.app  (app:test)
//   node scripts/app-variant.mjs Test --install  … and puts it in /Applications  (app:install:test)
//
// The variant's name goes to electron-vite as STUDIO_VARIANT (electron.vite.config.ts) and to electron-builder as the
// product name "Studio <Name>" and the appId with ".<name>" after it; its own output folder keeps Studio.app's build
// in dist/mac-arm64 as it is.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const [name, flag] = process.argv.slice(2)
if (!/^[A-Z][A-Za-z0-9]{0,19}$/.test(name ?? '') || (flag !== undefined && flag !== '--install')) {
  console.error('Usage: node scripts/app-variant.mjs <Name> [--install]  (a capital letter, then letters and digits)')
  process.exit(1)
}
if (process.platform !== 'darwin') {
  console.error('A variant is built for macOS only.')
  process.exit(1)
}

const productName = `Studio ${name}`
const baseAppId = /^appId:\s*(\S+)/m.exec(readFileSync('electron-builder.yml', 'utf8'))?.[1]
if (!baseAppId) throw new Error('electron-builder.yml has no appId.')
const output = join('dist', name.toLowerCase())
const bin = (tool) => join('node_modules', '.bin', tool)

function run(file, args, env = {}) {
  const result = spawnSync(file, args, { stdio: 'inherit', env: { ...process.env, ...env } })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

run(process.execPath, ['scripts/build-helpers.mjs'])
run(bin('electron-vite'), ['build'], { STUDIO_VARIANT: name })
run(
  bin('electron-builder'),
  [
    '--mac',
    `-c.productName=${productName}`,
    `-c.extraMetadata.productName=${productName}`,
    `-c.appId=${baseAppId}.${name.toLowerCase()}`,
    `-c.directories.output=${output}`
  ],
  { NODE_OPTIONS: '--experimental-require-module' }
)

const built = join(output, 'mac-arm64', `${productName}.app`)
if (!existsSync(built)) throw new Error(`${built} wasn't built.`)
if (flag === '--install') {
  const installed = join('/Applications', `${productName}.app`)
  rmSync(installed, { recursive: true, force: true })
  // ditto copies the bundle as it is: symlinks, permissions and the ad-hoc signature.
  run('ditto', [built, installed])
  console.log(`${productName}.app installed in /Applications`)
} else {
  console.log(`${productName}.app built in ${join(output, 'mac-arm64')}`)
}
