const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { loadPlugin, mockApi } = require("./harness/sandbox.js");
const { hasFfmpeg, realApi } = require("./harness/realApi.js");
const fixtures = require("./harness/fixtures.js");

const T = loadPlugin().__test;

function tick(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms || 20));
}

// ---- parsers (recorded ffmpeg stderr; no ffmpeg needed) ---------------------

const RECORDED = `Input #0, flac, from '/music/a.flac':
  Duration: 00:00:03.00, start: 0.000000, bitrate: 900 kb/s
  Stream #0:0: Audio: flac, 44100 Hz, stereo, s16
[silencedetect @ 0x6000] silence_start: 0
[ametadata@env @ 0xa1] frame:0    pts:0       pts_time:0
[ametadata@env @ 0xa1] lavfi.astats.Overall.RMS_level=-inf
[ametadata@ons @ 0xa2] frame:0    pts:0       pts_time:0
[ametadata@ons @ 0xa2] lavfi.astats.1.RMS_level=-inf
[ametadata@ons @ 0xa2] lavfi.astats.2.RMS_level=-80.5
[ametadata@low @ 0xa3] frame:0    pts:0       pts_time:0
[silencedetect @ 0x6000] silence_end: 1.25 | silence_duration: 1.25
[ametadata@env @ 0xa1] frame:1    pts:2000    pts_time:0.25
[ametadata@low @ 0xa3] lavfi.astats.Overall.RMS_level=-33.25
[ametadata@env @ 0xa1] lavfi.astats.Overall.RMS_level=-20.123456
[ametadata@ons @ 0xa2] frame:1    pts:80      pts_time:0.01
[ametadata@ons @ 0xa2] lavfi.astats.1.RMS_level=-12
[ametadata@ons @ 0xa2] lavfi.astats.2.RMS_level=nan
[Parsed_astats_4 @ 0xb] Overall
[Parsed_astats_4 @ 0xb] RMS level dB: -20.1
[Parsed_ebur128_6 @ 0xc] Summary:

  Integrated loudness:
    I:          -9.8 LUFS
    Threshold: -19.9 LUFS

  Loudness range:
    LRA:         6.1 LU
    Threshold: -29.9 LUFS
    LRA low:   -13.4 LUFS
    LRA high:   -7.3 LUFS

  True peak:
    Peak:       -0.3 dBFS
[silencedetect @ 0x6000] silence_start: 2.5
`;

describe("parseAnalysisStderr", () => {
  test("reads named meters, per-channel meters, -inf/nan, silences and the ebur128 summary", () => {
    const p = T.parseAnalysisStderr(RECORDED);
    assert.deepEqual(p.series.env.v, [-90, -20.123456]);
    assert.deepEqual(p.series.env.t, [0, 0.25]);
    assert.deepEqual(p.series.low.v, [-33.25]);
    assert.deepEqual(p.series["ons.1"].v, [-90, -12]);
    assert.deepEqual(p.series["ons.2"].v, [-80.5, -90]);
    assert.deepEqual(p.silences, [{ start: 0, end: 1.25 }]);
    assert.equal(p.openSilenceStart, 2.5, "a silence still open at EOF is reported, not dropped");
    assert.deepEqual(p.loudness, { integratedLufs: -9.8, peakDb: -0.3, rangeLu: 6.1 });
  });

  test("an empty run yields empty results, not a throw", () => {
    const p = T.parseAnalysisStderr("");
    assert.deepEqual(p.series, {});
    assert.deepEqual(p.silences, []);
    assert.equal(p.loudness, null);
    assert.throws(() => T.analyzeParsed(p, { durationSecs: 10, envHz: 4, onsetHz: 100, channels: 2 }), /no audio/);
  });

  test("a truncated run keeps what got through", () => {
    const cut = RECORDED.slice(0, RECORDED.indexOf("pts_time:0.25") + 13);
    const p = T.parseAnalysisStderr(cut);
    assert.deepEqual(p.series.env.v, [-90], "a frame line with no value yet adds nothing");
    assert.equal(p.loudness, null);
  });
});

describe("validateAnalyzeArgs", () => {
  test("defaults", () => {
    assert.deepEqual(T.validateAnalyzeArgs({}), { trackId: null, include: ["sections", "envelope", "beats"], envelopeHz: 1 });
    assert.deepEqual(T.validateAnalyzeArgs(undefined).include, ["sections", "envelope", "beats"]);
  });
  test("rejects bad input with readable messages", () => {
    assert.throws(() => T.validateAnalyzeArgs({ trackId: "12" }), /trackId must be a positive integer/);
    assert.throws(() => T.validateAnalyzeArgs({ trackId: 1.5 }), /trackId/);
    assert.throws(() => T.validateAnalyzeArgs({ include: ["chords"] }), /Unknown include "chords"/);
    assert.throws(() => T.validateAnalyzeArgs({ include: [] }), /non-empty/);
    assert.throws(() => T.validateAnalyzeArgs({ envelopeHz: 3 }), /1, 2 or 4/);
    assert.throws(() => T.validateAnalyzeArgs({ path: "/etc/passwd", trackId: -1 }), /trackId/);
  });
});

test("the analysis graph names every meter it later parses", () => {
  const args = T.buildAnalysisArgs("/m/a.flac", T.analysisPlan(240, 2));
  const graph = args[args.indexOf("-filter_complex") + 1];
  for (const name of ["env", "low", "mid", "high", "ons", "vmid", "vside"]) assert.match(graph, new RegExp("ametadata@" + name + "="));
  assert.ok(args.includes("-vn"), "video files analyse their audio track");
  const mono = T.buildAnalysisArgs("/m/a.flac", T.analysisPlan(240, 1)).join(" ");
  assert.doesNotMatch(mono, /vmid|pan=/, "mono files skip the centre/side branch");
  const long = T.buildAnalysisArgs("/m/a.flac", T.analysisPlan(3600, 2)).join(" ");
  assert.doesNotMatch(long, /ametadata@ons/, "files over 30 min skip beat tracking");
  assert.match(long, /peak=sample/);
});

// ---- tool contract (mocked exec) ---------------------------------------------

function toolApi(overrides) {
  let handler = null;
  const { api, state } = mockApi(Object.assign({
    assistant: { onTool: (name, h) => { if (name === "analyze_audio") handler = h; } },
    playback: { getCurrentTrack: () => null },
  }, overrides));
  loadPlugin().activate(api);
  return { state, analyze: (a) => handler(a) };
}

describe("analyze_audio errors", () => {
  test("a non-local track is refused before ffmpeg starts", async () => {
    const execs = [];
    const { analyze } = toolApi({
      library: { getTrackById: () => Promise.resolve({ id: 7, path: "subsonic://col1/99", title: "X" }) },
      system: { getDependency: () => Promise.resolve({ installed: true }), exec: (p, a) => { execs.push(a); return Promise.resolve({ exitCode: 0, stderr: "" }); } },
    });
    await tick();
    const before = execs.length;
    await assert.rejects(analyze({ trackId: 7 }), /analyze_audio needs a local file; this track plays from subsonic/);
    assert.equal(execs.length, before);
  });

  test("ffmpeg missing → install hint, no install modal", async () => {
    const { analyze, state } = toolApi({
      system: { getDependency: () => Promise.resolve({ installed: false }), exec: () => Promise.reject(new Error("no")) },
    });
    await tick();
    await assert.rejects(analyze({ trackId: 1 }), /ffmpeg is not installed — install it from Extensions → Tools/);
    assert.equal(state.requestActions.length, 0);
  });

  test("nothing playing and no trackId", async () => {
    const { analyze } = toolApi({});
    await tick();
    await assert.rejects(analyze({}), /Nothing is playing/);
  });

  test("unknown track id", async () => {
    const { analyze } = toolApi({});
    await tick();
    await assert.rejects(analyze({ trackId: 99 }), /No library track with id 99/);
  });

  test("a file missing on disk", async () => {
    const { analyze } = toolApi({
      library: { getTrackById: () => Promise.resolve({ id: 3, path: "file:///gone/a.flac", title: "A" }) },
      system: {
        getDependency: () => Promise.resolve({ installed: true }),
        exec: () => Promise.resolve({ exitCode: 1, stderr: "[in#0 @ 0x1] Error opening input: No such file or directory\n/gone/a.flac: No such file or directory\n" }),
      },
    });
    await tick();
    await assert.rejects(analyze({ trackId: 3 }), /missing on disk: \/gone\/a\.flac/);
  });

  test("bad arguments reach the caller verbatim", async () => {
    const { analyze } = toolApi({});
    await tick();
    await assert.rejects(Promise.resolve().then(() => analyze({ envelopeHz: 8 })), /envelopeHz must be 1, 2 or 4/);
  });
});

// ---- real ffmpeg on generated audio --------------------------------------------

const FFMPEG = hasFfmpeg();

describe("analyze_audio on generated audio", { skip: FFMPEG ? false : "ffmpeg not on PATH" }, () => {
  let dir;
  const files = {};
  before(() => {
    dir = fixtures.tmpDir();
    files.click120 = fixtures.clickTrack(dir, 120, 60);
    files.click70 = fixtures.clickTrack(dir, 70, 60);
    files.click140 = fixtures.clickTrack(dir, 140, 60);
    files.structure = fixtures.structureTrack(dir);
    files.hidden = fixtures.hiddenTrack(dir);
  });
  after(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

  function trackFor(file, id, extra) {
    return Object.assign({ id, path: "file://" + file, title: "T" + id, artist_name: "Test", file_size: fs.statSync(file).size, modified_at: 1700000000 }, extra);
  }

  async function analyzeFile(file, args) {
    const h = realApi({ tracks: { 1: trackFor(file, 1) } });
    loadPlugin().activate(h.api);
    await tick();
    return h.analyze(Object.assign({ trackId: 1 }, args));
  }

  test("120 BPM click track: bpm 120 ± 1, ≥90% of beats within 20 ms", async () => {
    const r = await analyzeFile(files.click120);
    assert.ok(Math.abs(r.beats.bpm - 120) <= 1, "bpm " + r.beats.bpm);
    assert.ok(r.beats.confidence >= 0.5, "confidence " + r.beats.confidence);
    const truth = Array.from({ length: 120 }, (_, k) => k * 0.5);
    const hit = truth.filter((t) => r.beats.times.some((b) => Math.abs(b - t) <= 0.02)).length;
    assert.ok(hit / truth.length >= 0.9, `${hit}/${truth.length} beats within 20 ms`);
    assert.ok(r.beats.downbeatConfidence <= 0.5, "downbeats are a guess and say so");
  });

  test("70 vs 140 BPM: no octave error reported with confidence above 0.5", async () => {
    const r70 = await analyzeFile(files.click70);
    const r140 = await analyzeFile(files.click140);
    assert.ok(!(Math.abs(r70.beats.bpm - 140) < 5 && r70.beats.confidence > 0.5), "70 read as " + r70.beats.bpm);
    assert.ok(!(Math.abs(r140.beats.bpm - 70) < 5 && r140.beats.confidence > 0.5), "140 read as " + r140.beats.bpm);
    assert.ok(Math.abs(r70.beats.bpm - 70) <= 1, "70 → " + r70.beats.bpm);
    assert.ok(Math.abs(r140.beats.bpm - 140) <= 1, "140 → " + r140.beats.bpm);
  });

  test("sections: intro, main, breakdown, main, silence; the loud parts share a label", async () => {
    const r = await analyzeFile(files.structure, { include: ["sections", "envelope", "beats", "bands", "vocals"], envelopeHz: 4 });
    assert.deepEqual(r.sections.map((s) => s.kind), ["intro", "main", "breakdown", "main", "silence"]);
    [20, 80, 100, 140].forEach((t, i) => {
      assert.ok(Math.abs(r.sections[i].until - t) <= 2, `boundary ${i}: ${r.sections[i].until} vs ${t}`);
    });
    assert.equal(r.sections[1].label, r.sections[3].label);
    assert.notEqual(r.sections[0].label, r.sections[1].label);
    // Full coverage, no gaps or overlaps.
    assert.equal(r.sections[0].at, 0);
    assert.equal(r.sections[r.sections.length - 1].until, r.track.durationSecs);
    for (let i = 1; i < r.sections.length; i++) assert.equal(r.sections[i].at, r.sections[i - 1].until);
    for (const s of r.sections) {
      assert.ok(s.confidence >= 0 && s.confidence <= 1);
      assert.ok(s.level >= 0 && s.level <= 1);
    }
    // Noise has no pulse: a bpm may be reported, but no invented grid.
    assert.ok(r.beats.confidence < 0.3, "noise beat confidence " + r.beats.confidence);
    assert.deepEqual(r.beats.times, []);
    assert.equal(r.envelope.hz, 4);
    assert.equal(r.envelope.unit, "dBFS");
    assert.ok(r.envelope.values.length >= 590 && r.envelope.values.length <= 601);
    assert.equal(r.bands.low.length, r.bands.high.length);
    assert.equal(r.vocals, null, "identical channels give no centre/side cue");
  });

  test("music end: trailing silence is detected", async () => {
    const r = await analyzeFile(files.structure, { include: ["sections"] });
    assert.ok(Math.abs(r.musicEndSecs - 140) <= 0.5, "musicEndSecs " + r.musicEndSecs);
    assert.ok(r.musicStartSecs <= 0.1);
    assert.ok(Math.abs(r.track.durationSecs - 150) <= 0.1);
    assert.equal(r.envelope, undefined, "only what was asked for");
    assert.equal(r.beats, undefined);
  });

  test("a hidden track after a long silence is a second region, not part of the song", async () => {
    const r = await analyzeFile(files.hidden, { include: ["sections", "vocals"] });
    assert.ok(Math.abs(r.musicEndSecs - 30) <= 0.5, "musicEndSecs " + r.musicEndSecs);
    assert.equal(r.musicRegions.length, 2);
    assert.ok(Math.abs(r.musicRegions[1].at - 70) <= 0.5);
    const silence = r.sections.find((s) => s.kind === "silence");
    assert.ok(silence && Math.abs(silence.at - 30) <= 0.5 && Math.abs(silence.until - 70) <= 0.5);
    assert.equal(r.sections[0].at, 0);
    assert.equal(r.sections[r.sections.length - 1].until, r.track.durationSecs);
    for (let i = 1; i < r.sections.length; i++) assert.equal(r.sections[i].at, r.sections[i - 1].until);
    assert.equal(r.vocals, null, "mono file → no vocal hint");
  });

  test("cache: a repeat call is served cached; a touched file is analysed again", async () => {
    const tracks = { 1: trackFor(files.click120, 1) };
    const h = realApi({ tracks });
    loadPlugin().activate(h.api);
    await tick();
    const first = await h.analyze({ trackId: 1 });
    assert.equal(first.cached, false);
    await tick(50); // the cache write is not awaited by the call
    const execsAfterFirst = h.execCalls.length;
    const second = await h.analyze({ trackId: 1, envelopeHz: 2 });
    assert.equal(second.cached, true);
    assert.equal(h.execCalls.length, execsAfterFirst, "no ffmpeg run for a cache hit");
    assert.equal(second.envelope.hz, 2, "one cache entry serves every envelope rate");
    assert.deepEqual(second.beats, first.beats);

    tracks[1] = Object.assign({}, tracks[1], { modified_at: 1800000000 });
    const third = await h.analyze({ trackId: 1 });
    assert.equal(third.cached, false);
    assert.ok(h.execCalls.length > execsAfterFirst);
  });

  test("simultaneous calls for one file share a single analysis", async () => {
    const h = realApi({ tracks: { 1: trackFor(files.click70, 1) } });
    loadPlugin().activate(h.api);
    await tick();
    const before = h.execCalls.length;
    const [a, b] = await Promise.all([h.analyze({ trackId: 1 }), h.analyze({ trackId: 1 })]);
    assert.deepEqual(a.beats, b.beats);
    const analysisRuns = h.execCalls.slice(before).filter((args) => args.includes("-filter_complex")).length;
    assert.equal(analysisRuns, 1);
  });

  test("no trackId analyses the playing track via its library row", async () => {
    const h = realApi({
      tracks: { 5: trackFor(files.click120, 5) },
      current: { key: "q:1", libraryId: 5, path: "file://" + files.click120, title: "T5", artist_name: "Test" },
    });
    loadPlugin().activate(h.api);
    await tick();
    const r = await h.analyze({ include: ["beats"] });
    assert.equal(r.track.title, "T5");
    assert.ok(Math.abs(r.beats.bpm - 120) <= 1);
  });
});
