#!/usr/bin/env node
// Builds what Studio's Claude Desktop extension is made from into build/mcpb (gitignored), from where development
// reads it and electron-builder copies it into the app (extraResources → Contents/Resources/mcpb on macOS,
// resources\mcpb on Windows):
//
//   build/mcpb/manifest.json        src/mcpb/manifest.json with Studio's version and author (package.json)
//   build/mcpb/server/index.js      src/mcpb/bridge.ts and the MCP SDK it uses, bundled into one file by esbuild
//   build/mcpb/server/LICENSES.txt  the licences of the packages bundled into index.js
//   build/mcpb/icon.png             build/icon.png
//
// Studio (src/main/claude-desktop.ts) zips these into a .mcpb when the user adds Studio to Claude Desktop, with the
// address and the token filled in as the extension's settings. Run by `npm run build:helpers` (scripts/build-helpers.mjs,
// so also before `dev`, `build` and `app`) and by the release workflow; on its own: `node scripts/build-mcpb.mjs`.
// Needs only esbuild, which comes with electron-vite; it takes a fraction of a second, on any system.

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'build', 'mcpb')

const log = (message) => console.log(`build-mcpb: ${message}`)

/** package.json's author as a name ("Name <mail> (url)" or { name }). */
function authorName(author) {
  if (author && typeof author === 'object') return String(author.name ?? '')
  return String(author ?? '').replace(/\s*[<(].*$/, '').trim()
}

/** https://github.com/<owner>/<repo> from package.json's repository, when it names a GitHub repository. */
function githubUrl(pkg) {
  const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url
  if (!repo) return undefined
  const m = /^(?:github:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(repo) ?? /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(repo)
  return m ? `https://github.com/${m[1]}/${m[2]}` : undefined
}

/** The licence texts of the npm packages esbuild put into the bundle (MIT, ISC …), for LICENSES.txt. */
function licensesOf(metafile) {
  const packages = new Map()
  for (const input of Object.keys(metafile.inputs)) {
    const parts = input.split(/[\\/]/)
    const at = parts.lastIndexOf('node_modules')
    if (at < 0) continue
    const name = parts[at + 1].startsWith('@') ? `${parts[at + 1]}/${parts[at + 2]}` : parts[at + 1]
    const dir = join(root, ...parts.slice(0, at + 1), ...name.split('/'))
    if (!packages.has(name)) packages.set(name, dir)
  }
  const sections = []
  for (const [name, dir] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    const file = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'LICENCE'].map((f) => join(dir, f)).find(existsSync)
    const text = file ? readFileSync(file, 'utf8').trim() : `Licensed under ${pkg.license ?? 'an unknown licence'}.`
    sections.push(`${name}@${pkg.version} (${pkg.license ?? 'see below'})\n\n${text}`)
  }
  return (
    'Studio for Claude Desktop: server/index.js bundles these packages, under their own licences.\n\n' +
    sections.join(`\n\n${'-'.repeat(78)}\n\n`) +
    '\n'
  )
}

export async function buildMcpb() {
  const { build } = await import('esbuild').catch(() => {
    throw new Error('esbuild was not found (it comes with electron-vite): run `npm install` first.')
  })
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const tmp = `${outDir}.tmp`
  rmSync(tmp, { recursive: true, force: true })
  mkdirSync(join(tmp, 'server'), { recursive: true })

  // The bridge: one CommonJS file for Claude Desktop's own Node.js (18 or later), nothing to install.
  const result = await build({
    // The metafile's paths (for the licences) are relative to this, whatever folder the script was started from.
    absWorkingDir: root,
    entryPoints: [join(root, 'src', 'mcpb', 'bridge.ts')],
    outfile: join(tmp, 'server', 'index.js'),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    define: { __STUDIO_VERSION__: JSON.stringify(pkg.version) },
    banner: {
      js: `// Studio ${pkg.version} for Claude Desktop – built from src/mcpb/bridge.ts (MIT); bundled packages: LICENSES.txt.`
    },
    legalComments: 'none',
    metafile: true,
    logLevel: 'warning'
  })
  writeFileSync(join(tmp, 'server', 'LICENSES.txt'), licensesOf(result.metafile))

  // The manifest: the template with this Studio's version and author, and its links when package.json names the
  // repository. The address and the token are filled in when the file is made (src/main/claude-desktop.ts).
  const manifest = JSON.parse(readFileSync(join(root, 'src', 'mcpb', 'manifest.json'), 'utf8'))
  manifest.version = pkg.version
  manifest.author = { name: authorName(pkg.author) || 'Studio' }
  const github = githubUrl(pkg)
  if (github) {
    manifest.repository = { type: 'git', url: `${github}.git` }
    manifest.homepage = github
    manifest.documentation = `${github}/blob/main/docs/AGENTS.md`
    manifest.support = `${github}/issues`
  }
  writeFileSync(join(tmp, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  copyFileSync(join(root, 'build', 'icon.png'), join(tmp, 'icon.png'))

  rmSync(outDir, { recursive: true, force: true })
  renameSync(tmp, outDir)
  const size = readFileSync(join(outDir, 'server', 'index.js')).length
  log(`built ${relative(root, outDir).split(sep).join('/')} (bridge ${(size / 1024).toFixed(0)} KB, Studio ${pkg.version}).`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildMcpb().catch((err) => {
    console.error(`build-mcpb: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  })
}
