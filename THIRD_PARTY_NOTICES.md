# Third-party notices

Studio's own code is under the [MIT License](LICENSE). Its builds also contain software made by others, under their
own licences.

## FFmpeg (Windows build only)

The Windows build of Studio ships [FFmpeg](https://ffmpeg.org) – `ffmpeg.exe`, `ffprobe.exe` and the FFmpeg
libraries they load (`avcodec`, `avdevice`, `avfilter`, `avformat`, `avutil`, `swresample`, `swscale`) – in its
`resources\ffmpeg` folder. Studio runs them as separate programs; it doesn't link to them.

FFmpeg is free software. This build is configured with `--enable-gpl --enable-version3`, so it is licensed under the
**GNU General Public License, version 3**; it includes GPL-licensed libraries such as x264 and Rubber Band, besides
others such as LAME, zimg and soxr. The full licence text is in `resources\ffmpeg\LICENSE.txt`, next to the programs,
and `resources\ffmpeg\SOURCE.txt` says where the build comes from.

- **The build:** [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds), release
  [`autobuild-2026-09-30-13-08`](https://github.com/BtbN/FFmpeg-Builds/releases/tag/autobuild-2026-09-30-13-08),
  file `ffmpeg-n8.1.3-9-g29e619e767-win64-gpl-shared-8.1.zip`
  (SHA-256 `dfe81c3aa0a546ee81980b1b824486dd0fe0a1d452f00cb55135379a74be7bcf`), shipped unchanged.
- **Its source:** FFmpeg at commit
  [`29e619e767`](https://github.com/FFmpeg/FFmpeg/tree/29e619e767) on the `release/8.1` branch (also on
  [git.ffmpeg.org](https://git.ffmpeg.org/ffmpeg.git)), and the build scripts with the exact version of every library
  in it at [BtbN/FFmpeg-Builds `autobuild-2026-09-30-13-08`](https://github.com/BtbN/FFmpeg-Builds/tree/autobuild-2026-09-30-13-08).

`scripts/fetch-ffmpeg-win.mjs` downloads exactly this file and checks its SHA-256; this notice changes with it.

On a Mac, Studio uses the ffmpeg you install yourself (Homebrew); nothing of FFmpeg is bundled there.

## Electron and Chromium

Every build of Studio is an [Electron](https://www.electronjs.org) app. Electron's licence (MIT) and the licences of
Chromium and its components are in `LICENSE.electron.txt` and `LICENSES.chromium.html` in the Windows app's folder,
and with every [Electron release](https://github.com/electron/electron/releases).

## npm packages

The packages Studio is built with – among them [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) (MIT)
with [SQLite](https://sqlite.org) (public domain), the [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
(MIT), [Zod](https://zod.dev) (MIT) and [React](https://react.dev) (MIT) – keep their own licences; each one's is in
its folder under `node_modules` after `npm install`.
