// Verifies the 3D core against the original 2D implementation.
//   node 3d/test/verify.js
// Runs the untouched ../../index.js in a sandbox with a recording canvas, then checks
// that visualhash.js produces the exact same fill() calls (path points + fillStyle).
"use strict";
var fs = require("fs");
var path = require("path");
var vm = require("vm");
var crypto = require("crypto");
var VH = require("../visualhash.js");

function recordingCtx() {
  var fills = [], current = [];
  return {
    fills: fills,
    fillStyle: "",
    globalCompositeOperation: "",
    save: function () {},
    restore: function () {},
    setTransform: function () {},
    fillRect: function () {},
    beginPath: function () { current = []; },
    lineTo: function (x, y) { current.push(x, y); },
    fill: function () { fills.push(current.join(",") + "|" + this.fillStyle); },
  };
}

function loadOriginal() {
  var ctx = recordingCtx();
  var input = { value: "" };
  var el = { classList: { add: function () {}, remove: function () {} }, innerHTML: "" };
  var sandbox = {
    Math: Math,
    window: { event: null },
    setTimeout: function () {},
    clearTimeout: function () {},
    chance: { name: function () { return "Seed Name"; } },
    document: {
      getElementsByTagName: function () { return [{ getContext: function () { return ctx; } }]; },
      getElementById: function (id) { return id === "textpattern" ? input : el; },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../../index.js"), "utf8"), sandbox);
  return {
    run: function (name) {
      ctx.fills.length = 0;
      input.value = name;
      sandbox.stp();
      return ctx.fills.slice();
    },
  };
}

var names = [
  "", "a", "War", "Gun Gun Feb", "Gun Gun Febrianza", "Bitcoin", "Blockchain", "Visual Hashing",
  "Baphomet", "Sontoloyo", "Luhut", "Kiamat", "Faraday", "Honeymoon", "Pregnant",
  "a very long name that wraps the seed words several times over", "Ünïcødé ✓", "日本語",
];
for (var i = 0; i < 40; i++) names.push(crypto.randomBytes(1 + (i % 14)).toString("base64"));

var original = loadOriginal();
var failed = 0, totalFills = 0;
names.forEach(function (name) {
  var expected = original.run(name);
  var ctx = recordingCtx();
  VH.render2D(VH.compute(name), ctx);
  totalFills += expected.length;
  if (expected.length !== ctx.fills.length) {
    failed++;
    console.log("FAIL count", JSON.stringify(name), expected.length, ctx.fills.length);
    return;
  }
  for (var j = 0; j < expected.length; j++) {
    if (expected[j] !== ctx.fills[j]) {
      failed++;
      console.log("FAIL fill", JSON.stringify(name), j, "\n  ", expected[j].slice(0, 120), "\n  ", ctx.fills[j].slice(0, 120));
      return;
    }
  }
});
console.log("legacy parity:", names.length - failed, "/", names.length, "names identical,", totalFills, "fills compared");

var shaFail = 0;
["", "abc", "Gun Gun Feb", "Ünïcødé ✓", "x".repeat(55), "x".repeat(56), "x".repeat(64), "x".repeat(1000)].forEach(function (s) {
  var got = VH.sha256(VH.utf8(s)).map(function (w) { return ("00000000" + (w >>> 0).toString(16)).slice(-8); }).join("");
  var want = crypto.createHash("sha256").update(s, "utf8").digest("hex");
  if (got !== want) { shaFail++; console.log("FAIL sha256", JSON.stringify(s), got, want); }
});
console.log("sha256:", shaFail ? shaFail + " failures" : "ok");

var v3 = VH.compute("Gun Gun Feb", { seed: "v3" });
console.log("v3 sample: N=" + v3.N, "k=" + v3.k, "layers=" + v3.layers.map(function (l) { return l.count; }).join("/"));

process.exit(failed || shaFail ? 1 : 0);
