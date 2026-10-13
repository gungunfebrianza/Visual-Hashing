// Entry for manifold.bundle.js: the manifold-3d WASM build with the binary
// embedded (no fetch), so it runs from file:// and inside a blob Worker.
import Module from "manifold-3d/manifold.js";
import wasm from "manifold-3d/manifold.wasm";

globalThis.VHManifoldModule = function (options) {
  var opts = { wasmBinary: wasm, locateFile: function (f) { return f; } };
  for (var k in options || {}) opts[k] = options[k];
  return Module(opts);
};
