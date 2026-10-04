# Changelog

## v1.2.0
- **`analyze_audio` assistant tool.** An AI assistant can now ask for a local track's
  musical structure, so it can time Now Playing cue sheets and clips to the music:
  where the music starts and really ends, loudness, sections (intro / build / main /
  peak / breakdown / outro / silence, with A/B/C labels for parts that sound alike),
  the loudest moments, a loudness envelope and a beat grid (bpm, beats, downbeats).
  Per-band levels and a centre-panned "vocals likely" hint are available on request.
  Every guess carries a confidence. It runs only when an assistant calls it (a few
  seconds for a song, one ffmpeg pass) and is cached afterwards; it is read-only, so it
  works without the "Plugin actions" permission. Asks for one new permission:
  **reading what's playing** (`playback:read`), used when no track id is given.
- **Media Info is now on demand.** It is no longer a tab on Track Detail — that ran a
  full-file loudness decode every time a track's page opened, and then showed a
  30-day-old answer even after the file changed. Right-click a local track →
  **Media Info (FFmpeg)** instead: it opens in the plugin's view (now **FFmpeg Tools**,
  with *Media Info* and *Convert jobs* tabs), always measured fresh, with a Refresh
  button. It also lists every embedded tag and the loudness range.
- **`media_info` assistant tool.** The same facts as JSON for an AI assistant
  (read-only, no cache).
- **Loudness is measured ~6× faster** (`ebur128` instead of `loudnorm`: about a second
  for a song instead of 7–8 s, same numbers).
- **Media Info works for `.m4a` / `.mp4` files again.** The container name ffmpeg
  reports for them contains commas, which the probe parser choked on.

## v1.1.0
- **Runs in the plugin worker runtime.** It now gets only what it asks for
  — `exec:ffmpeg`, `library:read` — and can't reach anything else in the app. Viboplr asks
  you to allow these once when you update. Requires Viboplr 1.0.85.

## v1.0.0
- Moved the plugin to its own repository with in-app auto-update.
- **Convert** — right-click Convert to… native submenu (MP3/AAC/FLAC/OGG/Opus/WAV
  presets), sequential job queue in a sidebar view, optional auto-delete of the
  original via the app's canonical delete-with-confirmation flow.
- **Media Info** — an information tab on Track Detail with container/stream/tag
  probe data (parsed from plain `ffmpeg -i` output — no `ffprobe` access) plus
  read-only loudness measurement (integrated LUFS, true peak, suggested
  ReplayGain-style track gain).
- A one-time notification fires on load if `ffmpeg` isn't installed.
