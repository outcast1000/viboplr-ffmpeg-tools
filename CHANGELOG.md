# Changelog

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
