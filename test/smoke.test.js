const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPlugin, mockApi } = require("./harness/sandbox.js");

function tick(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms || 20));
}

const MP3_STDERR = `Input #0, mp3, from '/music/Song.mp3':
  Metadata:
    title           : Song Name
    artist          : Some Artist
    encoder         : LAME3.100
  Duration: 00:03:45.32, start: 0.025056, bitrate: 320 kb/s
    Stream #0:0: Audio: mp3, 44100 Hz, stereo, fltp, 320 kb/s
At least one output file must be specified
`;

const EBUR128_STDERR = `[Parsed_ebur128_0 @ 0x1234] Summary:

  Integrated loudness:
    I:         -23.1 LUFS
    Threshold: -33.2 LUFS

  Loudness range:
    LRA:         6.1 LU
    Threshold: -43.3 LUFS
    LRA low:   -27.0 LUFS
    LRA high:  -20.9 LUFS

  True peak:
    Peak:       -1.2 dBFS
`;

const M4A_STDERR = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from '/music/Song.m4a':
  Metadata:
    major_brand     : isom
    title           : Song
  Duration: 00:02:00.00, start: 0.000000, bitrate: 256 kb/s
    Stream #0:0[0x1](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 255 kb/s (default)
`;

function probeExec(probeStderr) {
  const calls = [];
  return {
    calls,
    exec: (program, args) => {
      calls.push(args);
      const fc = args.indexOf("-filter_complex");
      const graph = fc === -1 ? "" : args[fc + 1];
      // The structure analysis (its graph has the `env` meter) exits cleanly; the
      // rest mimic `ffmpeg -i` with no output file, which exits 1.
      if (graph.indexOf("ametadata@env") !== -1) return Promise.resolve({ exitCode: 0, stdout: "", stderr: EBUR128_STDERR });
      return Promise.resolve({ exitCode: 1, stdout: "", stderr: graph ? WAVE_STDERR + EBUR128_STDERR : args.indexOf("-af") !== -1 ? EBUR128_STDERR : probeStderr });
    },
  };
}

// The RMS meter's frames, as the media-info pass prints them: silence, then a steady level.
// Each band meter gets its own shape so a mix-up between them shows.
function meterLines(tag, dbs) {
  return dbs
    .map((db, i) => `[ametadata@${tag} @ 0xabc] frame:${i} pts:${i * 160} pts_time:${i * 0.02}\n[ametadata@${tag} @ 0xabc] lavfi.astats.Overall.RMS_level=${db === -120 ? "-inf" : db}\n`)
    .join("");
}
const WAVE_STDERR =
  meterLines("wave", [-120, -6.0206, -6.0206, -6.0206]) +
  meterLines("wlow", [-6.0206, -6.0206, -6.0206, -6.0206]) +
  meterLines("wmid", [-120, -120, -6.0206, -6.0206]) +
  meterLines("whigh", [-6.0206, -120, -120, -120]);

function statsByLabel(view) {
  const out = {};
  (function walk(node) {
    if (!node) return;
    if (node.className === "plugin-kv") out[node.children[0].content] = node.children[1].content;
    (node.children || []).forEach(walk);
  })(view);
  return out;
}

test("Media Info is no longer a Track Detail information type — nothing runs on page load", async () => {
  const ex = probeExec(MP3_STDERR);
  const { api, state } = mockApi({ system: { getDependency: () => Promise.resolve({ installed: true }), exec: ex.exec } });
  loadPlugin().activate(api);
  await tick();
  assert.equal(state.probeHandler, undefined);
  assert.equal(ex.calls.length, 0);
});

test("the Media Info menu item fills the FFmpeg Tools view's Media Info tab", async () => {
  const ex = probeExec(MP3_STDERR);
  const { api, state } = mockApi({
    library: { getTrackById: (id) => Promise.resolve({ id, path: "file://C:\\Music\\Song.mp3", title: "Song Name", artist_name: "Some Artist" }) },
    system: { getDependency: () => Promise.resolve({ installed: true, version: "6.0", origin: "system" }), exec: ex.exec },
  });
  loadPlugin().activate(api);
  await tick();

  state.menuHandlers["ffmpeg-media-info"]({ kind: "track", trackId: 42, title: "Song Name", artistName: "Some Artist" });
  const loading = state.views["ffmpeg-tools-jobs"];
  assert.equal(loading.children[0].type, "tabs");
  assert.equal(loading.children[0].activeTab, "info");
  assert.ok(loading.children.some((c) => c.type === "loading"));
  await tick();

  const view = state.views["ffmpeg-tools-jobs"];
  const byLabel = statsByLabel(view);
  assert.equal(byLabel["Container"], "mp3");
  assert.equal(byLabel["Duration"], "3:45");
  assert.equal(byLabel["Codec"], "mp3");
  assert.equal(byLabel["Sample rate"], "44100 Hz");
  assert.equal(byLabel["Bitrate"], "320 kb/s");
  assert.equal(byLabel["Integrated"], "-23.1 LUFS");
  assert.equal(byLabel["Suggested gain"], "+5.10 dB (not applied)");
  assert.equal(byLabel["Encoder"], "LAME3.100", "every tag is listed");
  assert.ok(!view.children.some((c) => c.type === "stats-grid"), "label/value rows, not tiles");
  assert.equal(view.children.find((c) => c.type === "toolbar").title, undefined, "the tab already names the view");

  // The waveform rides the loudness pass: linear amplitude, relative to the loudest moment.
  const wave = view.children.find((c) => c.type === "line-chart");
  assert.deepEqual(wave.series[0].points, [0, 100, 100, 100]);
  assert.deepEqual(wave.labels, ["0:00", "0:56", "1:53", "2:49", "3:45"]);

  // Three bands, each relative to its own loudest moment, colour-keyed by a legend.
  const bands = view.children.filter((c) => c.type === "line-chart")[1];
  assert.deepEqual(bands.series.map((x) => x.points), [[100, 100, 100, 100], [0, 0, 100, 100], [100, 0, 0, 0]]);
  assert.ok(bands.series.every((x) => /^var\(--/.test(x.color)), "band colours come from the skin");

  // The structure comes from the (cached) analyze_audio analysis.
  assert.ok(view.children.some((c) => c.className === "plugin-heading" && /^(Structure|Sections)$/.test(c.content)) ||
    view.children.some((c) => c.type === "loading" && /sections and tempo/.test(c.message)), "a Structure block");
  assert.ok(ex.calls.some((a) => a.indexOf("-filter_complex") !== -1 && a[a.indexOf("-filter_complex") + 1].indexOf("ametadata@env") !== -1), "the structure analysis ran");

  // Refresh re-runs the probe and the measuring pass.
  const probes = () => ex.calls.filter((a) => a.length === 3).length;
  const before = probes();
  state.actionHandlers["refresh-media-info"]();
  await tick();
  assert.ok(probes() > before);

  // Switching tabs shows the convert jobs.
  state.actionHandlers["switch-tab"]({ tabId: "jobs" });
  assert.equal(state.views["ffmpeg-tools-jobs"].children[0].activeTab, "jobs");
});

test("Media Info reads m4a, whose container name contains commas", async () => {
  const ex = probeExec(M4A_STDERR);
  const { api, state } = mockApi({
    library: { getTrackById: (id) => Promise.resolve({ id, path: "file:///music/Song.m4a", title: "Song" }) },
    system: { getDependency: () => Promise.resolve({ installed: true }), exec: ex.exec },
  });
  loadPlugin().activate(api);
  await tick();
  state.menuHandlers["ffmpeg-media-info"]({ kind: "track", trackId: 1 });
  await tick();
  const byLabel = statsByLabel(state.views["ffmpeg-tools-jobs"]);
  assert.equal(byLabel["Container"], "m4a", "the file's extension, not ffmpeg's demuxer list");
  assert.equal(byLabel["Codec"], "aac (LC) (mp4a / 0x6134706D)");
  assert.equal(byLabel["Major brand"], undefined, "MP4 brand bookkeeping is hidden");
});

const MP4_VIDEO_STDERR = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from '/videos/Clip.mp4':
  Metadata:
    title           : Clip
  Duration: 00:04:10.00, start: 0.000000, bitrate: 5200 kb/s
    Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(tv, bt709, progressive), 1920x1080 [SAR 1:1 DAR 16:9], 4997 kb/s, 29.97 fps, 29.97 tbr, 30k tbn (default)
      Metadata:
        handler_name    : VideoHandler
    Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 48000 Hz, stereo, fltp, 192 kb/s (default)
      Metadata:
        handler_name    : SoundHandler
    Stream #0:2: Video: mjpeg (Baseline), yuvj420p(pc, bt470bg/unknown/unknown), 600x600 [SAR 1:1 DAR 1:1], 90k tbr, 90k tbn (attached pic)
`;

test("Media Info lists video streams and cover art, each stream keeping its own metadata", async () => {
  const ex = probeExec(MP4_VIDEO_STDERR);
  let tool = null;
  const { api, state } = mockApi({
    library: { getTrackById: (id) => Promise.resolve({ id, path: "file:///videos/Clip.mp4", title: "Clip" }) },
    playback: { getCurrentTrack: () => null },
    system: { getDependency: () => Promise.resolve({ installed: true }), exec: ex.exec },
    assistant: { onTool: (name, h) => { if (name === "media_info") tool = h; } },
  });
  loadPlugin().activate(api);
  await tick();
  state.menuHandlers["ffmpeg-media-info"]({ kind: "track", trackId: 3 });
  await tick();
  const view = state.views["ffmpeg-tools-jobs"];
  const headings = view.children.filter((c) => c.className === "plugin-heading").map((c) => c.content);
  assert.ok(headings.indexOf("Video") !== -1 && headings.indexOf("Audio") !== -1, "video files get separate Video and Audio blocks");
  const byLabel = statsByLabel(view);
  assert.equal(byLabel["Resolution"], "1920 × 1080");
  assert.equal(byLabel["Frame rate"], "29.97 fps");
  assert.equal(byLabel["Pixel format"], "yuv420p");
  assert.equal(byLabel["Cover art"], "JPEG, 600 × 600", "an attached picture is cover art, not a video stream");
  assert.equal(byLabel["Sample rate"], "48000 Hz");

  const r = await tool({ trackId: 3 });
  assert.equal(r.videoStreams.length, 1);
  assert.equal(r.videoStreams[0].codec, "h264 (High) (avc1 / 0x31637661)");
  assert.equal(r.videoStreams[0].tags.handler_name, "VideoHandler");
  assert.equal(r.streams[0].tags.handler_name, "SoundHandler", "the video's metadata no longer lands on the audio stream");
  assert.deepEqual(r.coverArt, { codec: "mjpeg (Baseline)", width: 600, height: 600 });
});

test("Media Info on a remote track explains itself without running ffmpeg", async () => {
  const ex = probeExec(MP3_STDERR);
  const { api, state } = mockApi({
    library: { getTrackById: (id) => Promise.resolve({ id, path: "subsonic://col1/9", title: "Remote" }) },
    system: { getDependency: () => Promise.resolve({ installed: true }), exec: ex.exec },
  });
  loadPlugin().activate(api);
  await tick();
  state.menuHandlers["ffmpeg-media-info"]({ kind: "track", trackId: 9 });
  await tick();
  const err = state.views["ffmpeg-tools-jobs"].children.find((c) => c.className === "plugin-error");
  assert.match(err.content, /needs a local file; this track plays from subsonic/);
  assert.equal(ex.calls.length, 0);
});

test("Media Info with ffmpeg missing prompts the install — it's an explicit action", async () => {
  const { api, state } = mockApi({
    system: { getDependency: () => Promise.resolve({ installed: false }), exec: () => Promise.reject(new Error("should not be called")) },
  });
  loadPlugin().activate(api);
  await tick();
  state.menuHandlers["ffmpeg-media-info"]({ kind: "track", trackId: 1 });
  await tick();
  assert.deepEqual(state.requestActions, [["require-dependency", { name: "ffmpeg", feature: "Media Info" }]]);
});

test("media_info assistant tool returns the same facts as JSON", async () => {
  const ex = probeExec(MP3_STDERR);
  let tool = null;
  const { api } = mockApi({
    library: { getTrackById: (id) => Promise.resolve({ id, path: "file:///music/Song.mp3", title: "Song Name", artist_name: "Some Artist" }) },
    playback: { getCurrentTrack: () => null },
    system: { getDependency: () => Promise.resolve({ installed: true }), exec: ex.exec },
    assistant: { onTool: (name, h) => { if (name === "media_info") tool = h; } },
  });
  loadPlugin().activate(api);
  await tick();

  const r = await tool({ trackId: 42 });
  assert.equal(r.format, "mp3");
  assert.equal(r.durationSecs, 225.32);
  assert.equal(r.overallBitrateKbps, 320);
  assert.equal(r.streams[0].sampleRateHz, 44100);
  assert.deepEqual(r.loudness, { integratedLufs: -23.1, truePeakDb: -1.2, rangeLu: 6.1, suggestedGainDb: 5.1 });
  assert.equal(r.tags.encoder, "LAME3.100");
  assert.equal(r.track.title, "Song Name");

  await assert.rejects(Promise.resolve().then(() => tool({ trackId: "x" })), /trackId must be a positive integer/);
  await assert.rejects(tool({}), /Nothing is playing/);
});

test("Convert skips remote tracks and only converts local ones", async () => {
  const tracks = {
    1: { id: 1, path: "file://C:\\Music\\Artist\\Song One.flac", title: "Song One", artist_name: "Artist" },
    2: { id: 2, path: "subsonic://col1/99", title: "Remote Song", artist_name: "Artist" },
  };
  const { api, state } = mockApi({ library: { getTrackById: (id) => Promise.resolve(tracks[id] || null) } });

  loadPlugin().activate(api);
  await tick();

  assert.ok(state.menuHandlers["ffmpeg-convert-mp3"], "mp3 preset should be registered");
  state.menuHandlers["ffmpeg-convert-mp3"]({ kind: "multi-track", trackIds: [1, 2] });
  await tick();

  assert.deepEqual(state.notifications, ["1 track skipped (not a local file)"]);
  assert.equal(state.execCalls.length, 1);
  assert.match(state.execCalls[0].join(" "), /Song One\.flac.*-c:a libmp3lame.*Song One\.mp3$/);
});

test("Convert job's Delete original button routes through the canonical delete-tracks action", async () => {
  const tracks = { 1: { id: 1, path: "file://C:\\Music\\Song.flac", title: "Song", artist_name: "Artist" } };
  const { api, state } = mockApi({ library: { getTrackById: (id) => Promise.resolve(tracks[id] || null) } });

  loadPlugin().activate(api);
  await tick();

  state.menuHandlers["ffmpeg-convert-flac"]({ trackId: 1 });
  await tick();

  const jobsView = state.views["ffmpeg-tools-jobs"];
  const section = jobsView.children.find((c) => c.type === "section");
  const deleteBtn = section.children.find((c) => c.type === "button");
  assert.equal(deleteBtn.action, "delete-original");

  state.actionHandlers["delete-original"](deleteBtn.data);
  assert.deepEqual(state.requestActions, [["delete-tracks", { trackIds: [1] }]]);
});

test("Boot shows a one-time notification when ffmpeg is missing", async () => {
  const { api, state } = mockApi({ system: { getDependency: () => Promise.resolve({ installed: false }), exec: () => Promise.resolve({ exitCode: 1, stdout: "", stderr: "" }) } });
  loadPlugin().activate(api);
  await tick();
  assert.equal(state.notifications.length, 1);
  assert.match(state.notifications[0], /ffmpeg/i);
});
