// Synthetic audio, generated with ffmpeg at test time — no copyrighted (or any)
// audio is committed.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ffmpeg-tools-test-"));
}

function gen(out, args) {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y"].concat(args, [out]), { encoding: "utf8" });
  if (r.status !== 0) throw new Error("fixture generation failed: " + r.stderr);
  return out;
}

// 5 ms 1 kHz clicks at exactly `bpm` for `secs` seconds.
function clickTrack(dir, bpm, secs) {
  const period = 60 / bpm;
  const expr = `if(lt(mod(t\\,${period})\\,0.005)\\,0.8*sin(2*PI*1000*t)\\,0)`;
  return gen(path.join(dir, `click-${bpm}.flac`), ["-f", "lavfi", "-i", `aevalsrc=${expr}:s=44100:d=${secs}`, "-c:a", "flac"]);
}

// Quiet noise 20 s, loud 60 s, quiet 20 s, loud 40 s, silence 10 s (150 s, stereo).
function structureTrack(dir) {
  const parts = [
    ["anoisesrc=d=20:a=0.03:c=pink:r=44100:s=1", "q1"],
    ["anoisesrc=d=60:a=0.3:c=pink:r=44100:s=2", "l1"],
    ["anoisesrc=d=20:a=0.03:c=pink:r=44100:s=3", "q2"],
    ["anoisesrc=d=40:a=0.3:c=pink:r=44100:s=4", "l2"],
    ["anullsrc=r=44100:cl=mono:d=10", "z"],
  ];
  const graph = parts.map(([src, n]) => `${src},aformat=channel_layouts=mono[${n}]`).join(";") +
    ";" + parts.map(([, n]) => `[${n}]`).join("") + "concat=n=5:v=0:a=1,pan=stereo|c0=c0|c1=c0[out]";
  return gen(path.join(dir, "structure.flac"), ["-filter_complex", graph, "-map", "[out]", "-c:a", "flac"]);
}

// 30 s of noise, 40 s of silence, then a 20 s "hidden track" (90 s, mono).
function hiddenTrack(dir) {
  const graph = "anoisesrc=d=30:a=0.3:c=pink:r=44100:s=5[a];anullsrc=r=44100:cl=mono:d=40[b];" +
    "anoisesrc=d=20:a=0.3:c=pink:r=44100:s=6[c];[a][b][c]concat=n=3:v=0:a=1[out]";
  return gen(path.join(dir, "hidden.flac"), ["-filter_complex", graph, "-map", "[out]", "-c:a", "flac"]);
}

module.exports = { tmpDir, clickTrack, structureTrack, hiddenTrack };
