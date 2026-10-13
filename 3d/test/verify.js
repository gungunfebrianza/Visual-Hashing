// Verifies the shared core (visualhash.js).
//   node 3d/test/verify.js           check everything
//   node 3d/test/verify.js --write   regenerate test/vectors.json
//
// 1. Legacy parity: runs the frozen original (reference/index-v2.2.0.js) in a sandbox
//    with a recording canvas and checks visualhash.js makes the exact same fill() calls.
// 2. SHA-256 against node's crypto.
// 3. Portable trig: accuracy against Math.sin/cos, and v3 never touches Math.sin/cos.
// 4. Test vectors: every name/seed in vectors.json reproduces bit for bit.
"use strict";
var fs = require("fs");
var path = require("path");
var vm = require("vm");
var crypto = require("crypto");
var VH = require("../visualhash.js");

var VECTORS = path.join(__dirname, "vectors.json");
var failures = 0;

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
  vm.runInContext(fs.readFileSync(path.join(__dirname, "reference/index-v2.2.0.js"), "utf8"), sandbox);
  return {
    run: function (name) {
      ctx.fills.length = 0;
      input.value = name;
      sandbox.stp();
      return ctx.fills.slice();
    },
  };
}

// ---------------------------------------------------------------- 1. legacy parity

var names = [
  "", "a", "War", "Gun Gun Feb", "Gun Gun Febrianza", "Bitcoin", "Blockchain", "Visual Hashing",
  "Baphomet", "Sontoloyo", "Luhut", "Kiamat", "Faraday", "Honeymoon", "Pregnant",
  "a very long name that wraps the seed words several times over", "Ünïcødé ✓", "日本語",
];
for (var i = 0; i < 40; i++) names.push(crypto.randomBytes(1 + (i % 14)).toString("base64"));

var original = loadOriginal();
var parityFail = 0, totalFills = 0;
names.forEach(function (name) {
  var expected = original.run(name);
  var ctx = recordingCtx();
  VH.render2D(VH.compute(name), ctx);
  totalFills += expected.length;
  if (expected.length !== ctx.fills.length) {
    parityFail++;
    console.log("FAIL count", JSON.stringify(name), expected.length, ctx.fills.length);
    return;
  }
  for (var j = 0; j < expected.length; j++) {
    if (expected[j] !== ctx.fills[j]) {
      parityFail++;
      console.log("FAIL fill", JSON.stringify(name), j, "\n  ", expected[j].slice(0, 120), "\n  ", ctx.fills[j].slice(0, 120));
      return;
    }
  }
});
failures += parityFail;
console.log("legacy parity:", names.length - parityFail, "/", names.length, "names identical,", totalFills, "fills compared");

// ---------------------------------------------------------------- 2. sha256

var shaFail = 0;
["", "abc", "Gun Gun Feb", "Ünïcødé ✓", "x".repeat(55), "x".repeat(56), "x".repeat(64), "x".repeat(1000)].forEach(function (s) {
  var got = VH.sha256(VH.utf8(s)).map(hex32).join("");
  var want = crypto.createHash("sha256").update(s, "utf8").digest("hex");
  if (got !== want) { shaFail++; console.log("FAIL sha256", JSON.stringify(s), got, want); }
});
failures += shaFail;
console.log("sha256:", shaFail ? shaFail + " failures" : "ok");

// ---------------------------------------------------------------- 3. portable trig

var maxErr = 0, x0 = 0x2545f491;
for (i = 0; i < 1000000; i++) {
  x0 = (Math.imul(x0, 1103515245) + 12345) | 0;
  var x = (x0 / 2147483648) * 1000;
  maxErr = Math.max(maxErr, Math.abs(VH.trig.sin(x) - Math.sin(x)), Math.abs(VH.trig.cos(x) - Math.cos(x)));
}
var trigOk = maxErr < 1e-15;

var realSin = Math.sin, realCos = Math.cos, leaked = false;
Math.sin = Math.cos = function () { leaked = true; return NaN; };
try {
  VH.compute("Gun Gun Feb", { seed: "v3" });
} finally {
  Math.sin = realSin;
  Math.cos = realCos;
}
if (!trigOk || leaked) failures++;
console.log("portable trig: max error " + maxErr.toExponential(2) + " over 1e6 samples in [-1000, 1000]" +
  (trigOk ? "" : " FAIL") + ", v3 uses Math.sin/cos: " + (leaked ? "yes FAIL" : "no"));

// ---------------------------------------------------------------- 4. test vectors

var vectorNames = [
  "", "a", "War", "Gun Gun Feb", "Gun Gun Febrianza", "Bitcoin", "Visual Hashing", "Baphomet",
  "Faraday", "Ünïcødé ✓", "日本語", "😀 emoji", "A123456789012345B", "B123456789012345A",
  "a very long name that wraps the seed words several times over, and then some more",
  "x".repeat(200),
];

function hex32(w) {
  return ("00000000" + (w >>> 0).toString(16)).slice(-8);
}

function digest(arrays) {
  var h = crypto.createHash("sha256");
  arrays.forEach(function (a) {
    // Typed arrays are little-endian on every platform node runs on; make it explicit.
    var b = Buffer.alloc(a.length * a.BYTES_PER_ELEMENT);
    for (var k = 0; k < a.length; k++) {
      if (a instanceof Float64Array) b.writeDoubleLE(a[k], k * 8);
      else b.writeUInt32LE(a[k], k * 4);
    }
    h.update(b);
  });
  return h.digest("hex");
}

function vectorOf(name, seed) {
  var hash = VH.compute(name, { seed: seed });
  return {
    name: name,
    seed: seed,
    seedWords: hash.seed,
    N: hash.N,
    k: hash.k,
    q: hash.q,
    h: hash.h,
    n: hash.n,
    layers: hash.layers.map(function (L) {
      return { hue: L.hue, sat: L.sat, stride: L.stride, count: L.count };
    }),
    pointsSha256: digest([hash.x, hash.y]),
    indexSha256: digest(hash.layers.map(function (L) { return L.index; })),
  };
}

var current = [];
vectorNames.forEach(function (name) {
  current.push(vectorOf(name, "legacy"), vectorOf(name, "v3"));
});

if (process.argv.indexOf("--write") >= 0) {
  var doc = {
    about: "Test vectors for Visual Hashing (3d/visualhash.js). Regenerate: node 3d/test/verify.js --write",
    format: {
      seedWords: "xorshift128 state after seeding, 4 x uint32 hex",
      q: "frequencies q0..q7, h: amplitudes (h[1] and h[4] unused, null), n: signs",
      layers: "per triangle layer: hue, sat (%), stride, kept triangle count",
      pointsSha256: "SHA-256 of x[0..4619] then y[0..4619] as float64 little-endian (unit circle coordinates)",
      indexSha256: "SHA-256 of the kept triangle indices of layers 1..3 as uint32 little-endian",
    },
    seeds: {
      legacy: "v2.2.0 seed with Math.sin/Math.cos. Reference engine: V8 (Math.sin is not required to be correctly rounded, so other engines may differ in the last bits)",
      v3: "SHA-256 seed with the portable trig: bit-exact in every engine and language (no FMA)",
    },
    vectors: current,
  };
  fs.writeFileSync(VECTORS, JSON.stringify(doc, null, 1) + "\n");
  console.log("vectors: wrote", current.length, "entries to", path.relative(process.cwd(), VECTORS));
} else {
  var saved = JSON.parse(fs.readFileSync(VECTORS, "utf8")).vectors;
  var vecFail = 0;
  saved.forEach(function (want, k) {
    var got = current[k];
    if (!got || JSON.stringify(got) !== JSON.stringify(want)) {
      vecFail++;
      console.log("FAIL vector", JSON.stringify(want.name).slice(0, 40), want.seed);
    }
  });
  if (saved.length !== current.length) vecFail++;
  failures += vecFail;
  console.log("vectors:", saved.length - vecFail, "/", saved.length, "match (v3 portable, legacy V8 reference)");
}

process.exit(failures ? 1 : 0);
