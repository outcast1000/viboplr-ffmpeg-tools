# Viboplr FFmpeg Tools Plugin

Bulk-convert local library tracks to another format, inspect a file's
container/stream/tag + loudness "Media Info" on demand, and give AI assistants a
song's file facts and musical structure — all via your system `ffmpeg`.

Plugin id: `ffmpeg-tools` (so an installed copy overrides the app's bundled
built-in of the same id, if any).

## Features

- **Convert** — right-click a local track (or a multi-track selection) → **Convert
  to…** for a native submenu of fixed presets: MP3 (256k), AAC (256k), FLAC
  (lossless), OGG Vorbis (q6), Opus (160k), WAV (PCM16). Conversions run in a
  sequential job queue (sidebar **FFmpeg Tools** → *Convert jobs*), writing a new file next to the
  original — nothing is overwritten or deleted without your say-so. An optional
  Settings toggle routes the original through the app's normal
  delete-with-confirmation flow once a conversion succeeds.
- **Media Info** — right-click a local library track → **Media Info (FFmpeg)**. The
  sidebar **FFmpeg Tools** view opens on its *Media Info* tab with container format,
  duration, per-stream codec/sample-rate/channels/sample-format/bitrate, every
  embedded tag, and measured loudness (integrated LUFS, true peak, loudness range,
  and a suggested ReplayGain-style track gain — informational only, nothing is
  written back to the file). It runs only when asked — never when a page opens —
  and is measured fresh each time (about a second for a song); **Refresh** re-reads.
  The `media_info` assistant tool (`ffmpeg-tools__media_info`, read-only) returns the
  same facts as JSON.
- **Song structure for AI assistants** — the read-only `analyze_audio` assistant tool
  (exposed as `ffmpeg-tools__analyze_audio`) returns a local track's music start/end,
  loudness, sections, loud peaks, a loudness envelope, beats, and optionally per-band
  levels and a vocal-presence hint. See [analyze_audio](#analyze_audio) below.

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

## analyze_audio

Input: `{ trackId?, include?, envelopeHz? }`. `trackId` is a library track id; omit it to
analyse the playing track. There is deliberately no path input — the tool can only
read files the library or the player already points at. `include` picks from
`sections`, `envelope`, `beats`, `bands`, `vocals` (default the first three);
`envelopeHz` is 1, 2 or 4 (the envelope is capped near 1200 points, so long files get a
lower rate — read `envelope.hz`). Non-local tracks, missing files and a missing ffmpeg
come back as readable errors.

How it works — everything comes from **one ffmpeg decode** plus plain JS:

- The audio is split (`asplit`) into named meters (`ametadata@env`, `@low`, `@mid`,
  `@high`, `@ons`, `@vmid`, `@vside`) whose log prefix tells them apart in the shared
  stderr; `silencedetect` and `ebur128` ride the same pass. The high band (>4 kHz) runs
  on a 16 kHz branch, because 4 kHz is the Nyquist limit of the 8 kHz analysis rate.
- **Regions**: silences ≥1 s (−50 dB) split the file; region edges are sharpened on a
  10 ms envelope. Regions closer than 15 s are one song; music after a longer silence
  is a hidden track (`musicRegions[1…]`), not the outro. `musicEndSecs` is the end of
  the first.
- **Sections**: per-second features (loudness, band shape relative to loudness, onset
  activity, centre-vs-side) standardised over the song; a novelty curve (mean vector
  before vs after, ±8 s — Foote's checkerboard kernel without the matrix) gives
  boundaries ≥8 s apart, refined on the 4 Hz envelope and snapped to a beat. Kinds come
  from relative level and trend (a breakdown dips ≥6 dB below both neighbours for
  ≥8 s); labels cluster section feature means.
- **Beats**: 5-band log-energy flux at 100 Hz (50 Hz past 8 min) → autocorrelation
  over 60–200 BPM with a log-Gaussian prior at 120 BPM → Ellis (2007) dynamic-programming
  beat tracking → bpm refined from the beat grid's own slope. Confidence combines the
  peak's sharpness, how well the pulse repeats at 2–4 periods, and a penalty when
  half/double tempo is nearly as likely; below 0.3 the bpm is reported without a grid.
  Downbeats assume 4/4 and are a guess (`downbeatConfidence` ≤ 0.5). Files over 30 min
  skip beat tracking.
- **Vocals** (on request): mid (L+R) vs side (L−R) energy in 300–3400 Hz per second,
  normalised over the song. A hint, never lyric timing; `null` for mono or dual-mono.

Results are cached in plugin storage (`audio-analysis/`), keyed by file path + size +
modification time + `analysisVersion` — not by song name, so a re-tagged or replaced
file is analysed again. Least-recently-used entries beyond 2000, or unused for 180
days, are evicted. Bump `ANALYSIS_VERSION` in `index.js` whenever the algorithm
changes. Two analyses run at once at most; concurrent calls for the same file share
one run.

Cost: a 4–5 minute song takes about 3–5 s (one ffmpeg pass at ~60–100× realtime,
~12 MB of stderr; parsing and analysis ~150 ms). A 45-minute file takes ~11 s.

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

`test/analyze.test.js` runs `analyze_audio` against audio **generated by ffmpeg at test
time** (click tracks at 70/120/140 BPM, a noise-built intro/main/breakdown/main/silence
file, a hidden-track file) — no audio is committed. Those tests skip when `ffmpeg` is not
on `PATH`; CI installs it.
