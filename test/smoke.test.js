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
  Duration: 00:02:00.00, start: 0.000000, bitrate: 256 kb/s
    Stream #0:0[0x1](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, stereo, fltp, 255 kb/s (default)
`;

function probeExec(probeStderr) {
  const calls = [];
  return {
    calls,
    exec: (program, args) => {
      calls.push(args);
      return Promise.resolve({ exitCode: 1, stdout: "", stderr: args.indexOf("-af") !== -1 ? EBUR128_STDERR : probeStderr });
    },
  };
}

function statsByLabel(view) {
  const out = {};
  (function walk(node) {
    if (!node) return;
    if (node.type === "stats-grid") node.items.forEach((i) => { out[i.label] = i.value; });
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

  const byLabel = statsByLabel(state.views["ffmpeg-tools-jobs"]);
  assert.equal(byLabel["Format"], "mp3");
  assert.equal(byLabel["Duration"], "3:45");
  assert.equal(byLabel["Codec"], "mp3");
  assert.equal(byLabel["Sample rate"], "44100 Hz");
  assert.equal(byLabel["Integrated"], "-23.1 LUFS");
  assert.equal(byLabel["Suggested track gain"], "+5.10 dB");
  assert.equal(byLabel["encoder"], "LAME3.100", "every tag is listed");

  // Refresh re-runs the probe.
  const before = ex.calls.length;
  state.actionHandlers["refresh-media-info"]();
  await tick();
  assert.equal(ex.calls.length, before + 2);

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
  assert.equal(byLabel["Format"], "mov,mp4,m4a,3gp,3g2,mj2");
  assert.equal(byLabel["Codec"], "aac (LC) (mp4a / 0x6134706D)");
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
