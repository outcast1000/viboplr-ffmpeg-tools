// A mock `api` whose system.exec really runs ffmpeg, plus an in-memory
// storage.files — for driving analyze_audio end-to-end against generated audio.
const { spawn, spawnSync } = require("node:child_process");
const { mockApi } = require("./sandbox.js");

function hasFfmpeg() {
  try {
    return spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
  } catch (e) {
    return false;
  }
}

function realExec(program, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out = [];
    const err = [];
    child.stdout.on("data", (d) => out.push(d));
    child.stderr.on("data", (d) => err.push(d));
    child.on("error", reject);
    child.on("close", (code) => resolve({
      exitCode: code,
      stdout: Buffer.concat(out).toString("utf8"),
      stderr: Buffer.concat(err).toString("utf8"),
    }));
  });
}

function memoryFiles() {
  const files = new Map();
  const k = (p) => p.join("/");
  return {
    files,
    api: {
      exists: (p) => Promise.resolve(files.has(k(p))),
      readJson: (p) => files.has(k(p)) ? Promise.resolve(JSON.parse(files.get(k(p)))) : Promise.reject(new Error("not found: " + k(p))),
      writeJson: (p, data) => { files.set(k(p), JSON.stringify(data)); return Promise.resolve(); },
      remove: (p) => { files.delete(k(p)); return Promise.resolve(); },
    },
  };
}

// tracks: { [id]: Track-like }. Returns { api, state, files, execCalls }.
function realApi({ tracks = {}, current = null } = {}) {
  const mem = memoryFiles();
  const execCalls = [];
  let toolHandler = null;
  const { api, state } = mockApi({
    system: {
      getDependency: () => Promise.resolve({ name: "ffmpeg", installed: true, version: "test", origin: "system" }),
      exec: (program, args) => { execCalls.push(args); return realExec(program, args); },
    },
    library: { getTrackById: (id) => Promise.resolve(tracks[id] || null) },
    playback: { getCurrentTrack: () => (typeof current === "function" ? current() : current) },
    storage: { get: () => Promise.resolve(null), set: () => Promise.resolve(), files: mem.api },
    assistant: { onTool: (name, h) => { if (name === "analyze_audio") toolHandler = h; } },
  });
  return { api, state, files: mem.files, execCalls, analyze: (args) => toolHandler(args) };
}

module.exports = { hasFfmpeg, realExec, realApi };
