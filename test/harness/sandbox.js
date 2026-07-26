const fs = require("node:fs");
const path = require("node:path");

const INDEX_PATH = path.join(__dirname, "..", "..", "index.js");

// Globals the host's frozen sandbox does NOT provide. Shadowing them as throwing
// bindings means any accidental use inside index.js fails loudly in tests.
// NOTE: Math, JSON, Date, Promise, timers, parseInt, etc. ARE provided by the host
// and must NOT be shadowed here.
const FORBIDDEN = [
  "fetch", "require", "process", "module", "exports",
  "__dirname", "__filename", "global", "import"
];

function loadPlugin() {
  const code = fs.readFileSync(INDEX_PATH, "utf8");

  // Build a preamble that declares each forbidden name as a getter-throwing const.
  // `import` is a reserved word, so it cannot be shadowed via a variable; it is
  // omitted from the preamble (a real `import` statement would be a syntax error
  // in a Function body anyway, which is its own guard).
  const shadowNames = FORBIDDEN.filter((n) => n !== "import");
  const preamble = shadowNames
    .map((n) => `var ${n} = new Proxy(function(){}, { get: function(){ throw new Error("forbidden global accessed in sandbox: ${n}"); }, apply: function(){ throw new Error("forbidden global called in sandbox: ${n}"); } });`)
    .join("\n");

  const body = preamble + "\n" + code;
  const factory = new Function("api", "window", "globalThis", "self", "document", body);

  // The host passes the frozen sandbox object for window/globalThis/self/document.
  // index.js does not use them, so an empty frozen object is faithful enough.
  const sandboxGlobal = Object.freeze({});
  return factory(undefined, sandboxGlobal, sandboxGlobal, sandboxGlobal, sandboxGlobal);
}

// A minimal mock of the `api` surface this plugin actually uses, for tests
// that need to drive activate() end-to-end (see smoke.test.js).
function mockApi(overrides) {
  const state = {
    execCalls: [],
    notifications: [],
    requestActions: [],
    menuHandlers: {},
    actionHandlers: {},
    views: {},
    badges: {},
  };
  const base = {
    system: {
      getDependency: () => Promise.resolve({ name: "ffmpeg", installed: true, version: "6.0", origin: "system" }),
      exec: (program, args) => {
        state.execCalls.push(args);
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
      },
    },
    library: { getTrackById: () => Promise.resolve(null) },
    ui: {
      requestAction: (a, p) => state.requestActions.push([a, p]),
      showNotification: (m) => state.notifications.push(m),
      setViewData: (id, data) => { state.views[id] = data; },
      setBadge: (id, badge) => { state.badges[id] = badge; },
      navigateToView: () => {},
      onAction: (id, h) => { state.actionHandlers[id] = h; },
    },
    contextMenu: {
      registerItem: () => {},
      onAction: (id, h) => { state.menuHandlers[id] = h; },
    },
    informationTypes: { onFetch: (id, h) => { state.probeHandler = h; } },
    storage: { get: () => Promise.resolve(null), set: () => Promise.resolve() },
  };
  const api = Object.assign({}, base, overrides);
  return { api, state };
}

module.exports = { loadPlugin, mockApi };
