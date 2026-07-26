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

const LOUDNORM_STDERR = `[Parsed_loudnorm_0 @ 0x1234]
{
	"input_i" : "-23.10",
	"input_tp" : "-1.20"
}
`;

test("Media Info fetch parses container/stream/tag + loudness into key_value rows", async () => {
  const { api, state } = mockApi({
    library: { getTrackById: (id) => Promise.resolve({ id, path: "file://C:\\Music\\Song.mp3", title: "Song Name", artist_name: "Some Artist" }) },
    system: {
      getDependency: () => Promise.resolve({ installed: true, version: "6.0", origin: "system" }),
      exec: (program, args) => Promise.resolve({
        exitCode: 1,
        stdout: "",
        stderr: args.indexOf("-af") !== -1 ? LOUDNORM_STDERR : MP3_STDERR,
      }),
    },
  });

  loadPlugin().activate(api);
  await tick();

  const result = await state.probeHandler({ kind: "track", id: 42, name: "Song Name" });
  assert.equal(result.status, "ok");
  const byKey = Object.fromEntries(result.value.items.map((i) => [i.key, i.value]));
  assert.equal(byKey["Format"], "mp3");
  assert.equal(byKey["Duration"], "3:45");
  assert.equal(byKey["Codec"], "mp3");
  assert.equal(byKey["Sample rate"], "44100 Hz");
  assert.equal(byKey["Measured loudness"], "-23.1 LUFS");
  assert.equal(byKey["Suggested track gain (informational)"], "+5.10 dB");
});

test("Media Info fetch stays silent (not_found) when ffmpeg is missing — never prompts install", async () => {
  const { api, state } = mockApi({
    system: { getDependency: () => Promise.resolve({ installed: false }), exec: () => Promise.reject(new Error("should not be called")) },
  });
  loadPlugin().activate(api);
  await tick();

  const result = await state.probeHandler({ kind: "track", id: 1, name: "X" });
  assert.equal(result.status, "not_found");
  assert.equal(state.requestActions.length, 0);
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
