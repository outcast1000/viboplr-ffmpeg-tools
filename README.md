# Viboplr FFmpeg Tools Plugin

Bulk-convert local library tracks to another format, and inspect a deep
container/stream/tag + loudness "Media Info" tab on Track Detail — all via your
system `ffmpeg`.

Plugin id: `ffmpeg-tools` (so an installed copy overrides the app's bundled
built-in of the same id, if any).

## Features

- **Convert** — right-click a local track (or a multi-track selection) → **Convert
  to…** for a native submenu of fixed presets: MP3 (256k), AAC (256k), FLAC
  (lossless), OGG Vorbis (q6), Opus (160k), WAV (PCM16). Conversions run in a
  sequential job queue (sidebar **FFmpeg Jobs**), writing a new file next to the
  original — nothing is overwritten or deleted without your say-so. An optional
  Settings toggle routes the original through the app's normal
  delete-with-confirmation flow once a conversion succeeds.
- **Media Info** — an information tab on Track Detail with container format,
  duration, per-stream codec/sample-rate/channels/bitrate, a handful of embedded
  tags, and measured loudness (integrated LUFS, true peak, and a suggested
  ReplayGain-style track gain — informational only, nothing is written back to
  the file).

## Requirements

This plugin shells out to `ffmpeg` via the host's allow-listed `api.system.exec`.
There is no `ffprobe` access (only `ffmpeg`/`yt-dlp` are allow-listed), so Media
Info's container/stream data comes from parsing plain ffmpeg's human-readable
`-i` output rather than a JSON API — this is a best-effort parse and can miss
fields on unusual files or different ffmpeg builds/locales.

A plugin cannot rewrite a track's original file in place (the plugin file API is
jailed to this plugin's own storage, and ffmpeg can't safely read+write the same
path), so:
- Convert always writes to a **new sibling file** — never the original. Converted
  files are not automatically added to your library; rescan the collection from
  Collections to pick them up.
- Loudness is **read-only** in Media Info — no ReplayGain tags are ever written.

`ffmpeg` must be on the app's `PATH` (or installed via the app's own dependency
manager). Settings → FFmpeg Tools shows install status and links to the app's
install flow when it's missing; a one-time notification also fires on load if
`ffmpeg` isn't found.

## Install

In Viboplr: **Extensions → Install from URL** and paste this repo's URL, or it
auto-updates if already installed (the app checks `updateUrl` every 24h).

## Develop & Release

For every release: edit `index.js` / `manifest.json`, **bump `version` in
`manifest.json`**, and add a `## vX.Y.Z` section at the top of `CHANGELOG.md`.
Then publish via CI (preferred) or manually.

Bump helper: `scripts/bump.sh <patch|minor|major|X.Y.Z>` rewrites the
`manifest.json` version and prepends a `## vX.Y.Z` CHANGELOG section (with a
`TODO` to fill in). It does not commit/tag/push — review, fill in the changelog,
then release.

### Release via CI (preferred)

A GitHub Actions workflow (`.github/workflows/release.yml`) builds and publishes
the release. It verifies the `manifest.json` version matches the release version
and that the zip has `manifest.json` at its root, then attaches
`ffmpeg-tools.zip` + `update.json`. Two ways to trigger it:

- **Push a tag:** after committing the version bump + changelog, run
  `git tag vX.Y.Z && git push origin vX.Y.Z`.
- **Manual dispatch:** GitHub → Actions → *Release* → *Run workflow*, enter the
  version (must equal `manifest.json`). CI creates the tag for you.

### Release manually (fallback)

1. `scripts/package.sh` → produces `ffmpeg-tools.zip` + `update.json`.
   - The zip MUST contain `manifest.json` at its root (the script guarantees
     this; verify via the printed `unzip -l`).
2. `gh release create vX.Y.Z ffmpeg-tools.zip update.json --repo outcast1000/viboplr-ffmpeg-tools --title "vX.Y.Z" --notes-file CHANGELOG.md`

The update endpoint is the permanent
`https://github.com/outcast1000/viboplr-ffmpeg-tools/releases/latest/download/update.json`.

## Tests

`node --test` runs the suite in `test/` (loads `index.js` in a sandboxed
`new Function` context matching how the host actually executes it, then drives
`activate()` with a mocked `api`). CI runs this on every push/PR and again before
every release.
