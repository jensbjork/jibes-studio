#!/usr/bin/env node
// Fetches the ffmpeg that the Windows build of Studio ships (resources/ffmpeg, see electron-builder.yml): a GPL build of
// FFmpeg's release branch for 64-bit Windows from BtbN/FFmpeg-Builds, pinned by its URL and SHA-256. The download is
// checked against that hash before anything is unpacked; then ffmpeg.exe, ffprobe.exe, the FFmpeg libraries they load
// (the "shared" build: one copy of libavcodec & co. for both programs, about half the size of two static .exe files),
// FFmpeg's licence and a note on where the source is go into build/ffmpeg-win (gitignored). The repository never holds
// the binaries.
//
//   node scripts/fetch-ffmpeg-win.mjs            → build/ffmpeg-win (left alone when it already holds this build)
//   node scripts/fetch-ffmpeg-win.mjs --out DIR  → another folder (to try the script out)
//   node scripts/fetch-ffmpeg-win.mjs --check    → on Windows, also runs the fetched ffmpeg and checks that it has
//                                                  every encoder, muxer and filter Studio uses (the release workflow)
//
// Updating the pin: pick a month's last "autobuild-YYYY-MM-DD-HH-MM" release on
// https://github.com/BtbN/FFmpeg-Builds/releases (BtbN keeps those for two years; daily ones only for 14 days), take
// its ffmpeg-n<version>-win64-gpl-shared-<branch>.zip, and copy the asset's SHA-256 from that release's
// checksums.sha256 (GitHub shows the same digest next to the asset). Then run this script with --check on Windows, or
// let the release workflow do it.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { inflateRawSync } from 'node:zlib'

const BUILD = {
  release: 'autobuild-2026-09-30-13-08',
  asset: 'ffmpeg-n8.1.3-9-g29e619e767-win64-gpl-shared-8.1.zip',
  sha256: 'dfe81c3aa0a546ee81980b1b824486dd0fe0a1d452f00cb55135379a74be7bcf',
  /** As `ffmpeg -version` reports it: FFmpeg's release/8.1 at commit 29e619e767, built on 2026-09-30. */
  version: 'n8.1.3-9-g29e619e767-20260930',
  commit: '29e619e767'
}
const URL_ = `https://github.com/BtbN/FFmpeg-Builds/releases/download/${BUILD.release}/${BUILD.asset}`

/** What Studio asks of ffmpeg (src/main: ffmpeg.ts, edit-mix.ts, edit-ops.ts …); --check fails without any of it. */
const REQUIRED = {
  encoders: ['libx264', 'aac', 'libmp3lame', 'flac', 'pcm_s16le', 'pcm_f32le', 'mjpeg', 'png'],
  muxers: ['mp4', 'ipod', 'adts', 'mp3', 'flac', 'wav', 'image2', 'image2pipe', 'f32le', 's16le', 'null'],
  filters: [
    'adelay', 'aevalsrc', 'afade', 'afftdn', 'aformat', 'alimiter', 'amix', 'anull', 'anullsrc', 'apad', 'aresample',
    'asetnsamples', 'asetpts', 'asplit', 'atempo', 'atrim', 'color', 'concat', 'crop', 'fade', 'format', 'fps',
    'highpass', 'loudnorm', 'null', 'pad', 'pan', 'reverse', 'rubberband', 'scale', 'scdet', 'setparams', 'setpts',
    'setsar', 'sidechaincompress', 'silencedetect', 'tonemap', 'tpad', 'trim', 'volume', 'zscale'
  ]
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const outArg = args.indexOf('--out')
const outDir = resolve(outArg >= 0 && args[outArg + 1] ? args[outArg + 1] : join(root, 'build', 'ffmpeg-win'))
const check = args.includes('--check')
const stampFile = join(outDir, '.build.sha256')

const log = (message) => console.log(`fetch-ffmpeg-win: ${message}`)

/** Downloads the pinned zip to `file`, hashing it on the way; throws unless the hash is the pinned one. */
async function download(file) {
  log(`downloading ${BUILD.asset} …`)
  const response = await fetch(URL_, { redirect: 'follow' })
  if (!response.ok || !response.body) throw new Error(`The download failed (HTTP ${response.status}): ${URL_}`)
  const hash = createHash('sha256')
  const body = Readable.fromWeb(response.body)
  body.on('data', (chunk) => hash.update(chunk))
  await pipeline(body, createWriteStream(file))
  const actual = hash.digest('hex')
  if (actual !== BUILD.sha256) {
    throw new Error(`The download's SHA-256 is ${actual}, not the pinned ${BUILD.sha256}. Nothing was unpacked.`)
  }
  log(`SHA-256 verified (${BUILD.sha256}).`)
}

/** The entries of a zip (no Zip64 needed: every file in it is far below 4 GB), from its central directory. */
function zipEntries(zip) {
  let eocd = -1
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('The download is not a zip file.')
  const count = zip.readUInt16LE(eocd + 10)
  let at = zip.readUInt32LE(eocd + 16)
  const entries = []
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error('The zip file is damaged.')
    const method = zip.readUInt16LE(at + 10)
    const compressed = zip.readUInt32LE(at + 20)
    const size = zip.readUInt32LE(at + 24)
    const nameLength = zip.readUInt16LE(at + 28)
    const extraLength = zip.readUInt16LE(at + 30)
    const commentLength = zip.readUInt16LE(at + 32)
    const local = zip.readUInt32LE(at + 42)
    const name = zip.toString('utf8', at + 46, at + 46 + nameLength)
    entries.push({ name, method, compressed, size, local })
    at += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

function unpack(zip, entry) {
  const nameLength = zip.readUInt16LE(entry.local + 26)
  const extraLength = zip.readUInt16LE(entry.local + 28)
  const start = entry.local + 30 + nameLength + extraLength
  const data = zip.subarray(start, start + entry.compressed)
  const out = entry.method === 0 ? data : entry.method === 8 ? inflateRawSync(data) : undefined
  if (!out) throw new Error(`${entry.name} is packed in a way this script can't read (method ${entry.method}).`)
  if (out.length !== entry.size) throw new Error(`${entry.name} did not unpack to its full size.`)
  return out
}

/** ffmpeg.exe, ffprobe.exe and the DLLs from bin/, and LICENSE.txt, into dir. */
function extract(zipFile, dir) {
  const zip = readFileSync(zipFile)
  const entries = zipEntries(zip)
  const wanted = entries.filter((e) => {
    const parts = e.name.split('/')
    const file = parts[parts.length - 1]
    if (parts.length === 2 && file === 'LICENSE.txt') return true
    return parts.length === 3 && parts[1] === 'bin' && /^(ffmpeg\.exe|ffprobe\.exe|[\w.-]+\.dll)$/i.test(file)
  })
  for (const name of ['ffmpeg.exe', 'ffprobe.exe', 'LICENSE.txt']) {
    if (!wanted.some((e) => e.name.endsWith(`/${name}`))) throw new Error(`${name} is missing from ${BUILD.asset}.`)
  }
  mkdirSync(dir, { recursive: true })
  for (const entry of wanted) writeFileSync(join(dir, entry.name.split('/').pop()), unpack(zip, entry))
  writeFileSync(
    join(dir, 'SOURCE.txt'),
    [
      `FFmpeg ${BUILD.version} for 64-bit Windows, as shipped with Studio (resources/ffmpeg).`,
      '',
      'FFmpeg is free software, licensed under the GNU General Public License version 3 in this build (LICENSE.txt):',
      'it includes GPL components such as libx264 and librubberband.',
      '',
      `Binaries: ${URL_}`,
      `  SHA-256 ${BUILD.sha256}`,
      `Source of FFmpeg: https://github.com/FFmpeg/FFmpeg/tree/${BUILD.commit} (release/8.1 branch; also git.ffmpeg.org)`,
      `How it was built, with the version of every library in it: https://github.com/BtbN/FFmpeg-Builds/tree/${BUILD.release}`,
      ''
    ].join('\r\n')
  )
  return wanted.length
}

/** Runs the fetched ffmpeg (Windows only) and checks its version and everything Studio needs. */
function checkBuild(dir) {
  if (process.platform !== 'win32') {
    log('--check runs the Windows programs, so it is skipped on this system.')
    return
  }
  const ffmpeg = join(dir, 'ffmpeg.exe')
  const run = (...a) => {
    const r = spawnSync(ffmpeg, ['-hide_banner', ...a], { encoding: 'utf8', windowsHide: true })
    if (r.status !== 0) throw new Error(`ffmpeg ${a.join(' ')} failed: ${r.error?.message ?? r.stderr}`)
    return r.stdout
  }
  const version = /ffmpeg version (\S+)/.exec(run('-version'))?.[1]
  if (version !== BUILD.version) throw new Error(`ffmpeg reports version ${version}, not ${BUILD.version}.`)
  const names = (text, flags) =>
    new Set(
      text
        .split(/\r?\n/)
        .map((line) => new RegExp(`^\\s*${flags}\\s+(\\S+)`).exec(line)?.[1])
        .filter(Boolean)
    )
  const encoders = names(run('-encoders'), '[VAS][F.][S.][X.][B.][D.]')
  const muxers = names(run('-muxers'), '[D ]?E[ d]?')
  // As src/main/ffmpeg.ts reads them: "TS" flags since ffmpeg 8 ("TSC" before).
  const filters = names(run('-filters'), '[T.][S.][C.]?')
  const missing = [
    ...REQUIRED.encoders.filter((n) => !encoders.has(n)).map((n) => `encoder ${n}`),
    ...REQUIRED.muxers.filter((n) => !muxers.has(n)).map((n) => `muxer ${n}`),
    ...REQUIRED.filters.filter((n) => !filters.has(n)).map((n) => `filter ${n}`)
  ]
  if (missing.length) throw new Error(`This ffmpeg lacks what Studio uses: ${missing.join(', ')}.`)
  const probe = spawnSync(join(dir, 'ffprobe.exe'), ['-hide_banner', '-version'], { encoding: 'utf8', windowsHide: true })
  if (probe.status !== 0) throw new Error(`ffprobe could not be started: ${probe.error?.message ?? probe.stderr}`)
  log(
    `checked: ffmpeg ${version} has all ${REQUIRED.encoders.length} encoders, ${REQUIRED.muxers.length} muxers and ` +
      `${REQUIRED.filters.length} filters Studio uses; ffprobe starts.`
  )
}

async function main() {
  if (existsSync(stampFile) && readFileSync(stampFile, 'utf8').trim() === BUILD.sha256) {
    log(`${outDir} already holds ffmpeg ${BUILD.version}.`)
  } else {
    const parent = dirname(outDir)
    mkdirSync(parent, { recursive: true })
    const zipFile = join(parent, `.${BUILD.asset}.part`)
    const staging = `${outDir}.part`
    rmSync(staging, { recursive: true, force: true })
    try {
      await download(zipFile)
      const count = extract(zipFile, staging)
      writeFileSync(join(staging, '.build.sha256'), `${BUILD.sha256}\n`)
      rmSync(outDir, { recursive: true, force: true })
      renameSync(staging, outDir)
      log(`unpacked ${count} files into ${outDir}.`)
    } finally {
      rmSync(zipFile, { force: true })
      rmSync(staging, { recursive: true, force: true })
    }
  }
  if (check) checkBuild(outDir)
}

main().catch((err) => {
  console.error(`fetch-ffmpeg-win: ${err instanceof Error ? err.message : err}`)
  process.exit(1)
})
