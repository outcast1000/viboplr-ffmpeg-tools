const { test } = require("node:test");
const assert = require("node:assert/strict");
const { loadPlugin } = require("./harness/sandbox.js");

test("loadPlugin returns the plugin object with activate/deactivate", () => {
  const plugin = loadPlugin();
  assert.equal(typeof plugin.activate, "function");
  assert.equal(typeof plugin.deactivate, "function");
});

test("each loadPlugin call returns a fresh instance (no shared state)", () => {
  const a = loadPlugin();
  const b = loadPlugin();
  assert.notEqual(a, b);
  assert.notEqual(a.activate, b.activate);
});

test("index.js does not reference forbidden globals at load time", () => {
  // loadPlugin itself evaluates the file body; if a top-level statement touched a
  // forbidden global it would throw here. Module-scoped code in index.js only
  // declares vars/functions, so loading must succeed.
  assert.doesNotThrow(() => loadPlugin());
});
