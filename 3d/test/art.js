// Checks the art data module (3d/lib/art.js): node 3d/test/art.js
"use strict";
var VH = require("../visualhash.js");
var ART = require("../lib/art.js");

var failures = 0;
function report(label, problems, okText) {
  failures += problems.length;
  console.log(label + ":", problems.length ? problems.length + " FAIL\n  " + problems.slice(0, 5).join("\n  ") : okText);
}

// ---------------------------------------------------------------- seed bits

(function () {
  var p = [];
  var a = VH.compute("Gun Gun Feb", { seed: "v3" }).seed;
  if (ART.hamming(a, a) !== 0) p.push("hamming(a, a) != 0");
  for (var bit = 0; bit < 128; bit += 7) {
    var b = ART.flipBit(a, bit);
    if (ART.hamming(a, b) !== 1) p.push("flipBit " + bit + " changed " + ART.hamming(a, b) + " bits");
    if (ART.hamming(a, ART.flipBit(b, bit)) !== 0) p.push("flipBit " + bit + " not an involution");
    if (!b.every(function (w) { return /^[0-9a-f]{8}$/.test(w); })) p.push("flipBit format " + b.join(" "));
    var h = VH.compute("", { seed: "v3", seedWords: b });
    if (h.seed.join() !== b.join()) p.push("compute(seedWords) seed mismatch at bit " + bit);
  }
  if (ART.hamming(["ffffffff", "ffffffff", "ffffffff", "ffffffff"], ["00000000", "00000000", "00000000", "00000000"]) !== 128) p.push("hamming all bits");
  report("seed bits", p, "ok (hamming, flipBit, compute with seedWords)");
})();

// ---------------------------------------------------------------- breeding

// The curve repeats every SIZE/N points turned by the base turn 2πk/N, so the
// point set maps onto itself under that rotation.
function symmetryError(hash) {
  var M = hash.size / hash.N, a = (2 * Math.PI * hash.k) / hash.N, err = Infinity;
  [a, -a].forEach(function (ang) {
    var c = Math.cos(ang), s = Math.sin(ang), e = 0;
    for (var f = 0; f < hash.size; f++) {
      var g = (f + M) % hash.size;
      var x = c * hash.x[f] - s * hash.y[f], y = s * hash.x[f] + c * hash.y[f];
      e = Math.max(e, Math.abs(x - hash.x[g]), Math.abs(y - hash.y[g]));
    }
    err = Math.min(err, e);
  });
  return err;
}

(function () {
  var p = [], checked = 0, maxErr = 0;
  var pairs = [["War", "Peace", "legacy"], ["Gun Gun Feb", "Bitcoin", "v3"], ["Faraday", "Baphomet", "v3"], ["a", "日本語", "legacy"]];
  var sawMixedN = false;
  pairs.forEach(function (pr) {
    var A = VH.compute(pr[0], { seed: pr[2] }), B = VH.compute(pr[1], { seed: pr[2] });
    if (A.N !== B.N) sawMixedN = true;
    // mask 0 must reproduce A exactly
    var same = VH.compute(pr[0], { seed: pr[2], genes: ART.crossover(A.genes, B.genes, 0) });
    for (var f = 0; f < A.size; f++) {
      if (same.x[f] !== A.x[f] || same.y[f] !== A.y[f]) {
        p.push("mask 0 differs from parent A for " + pr[0]);
        break;
      }
    }
    var masks = ART.childMasks(A.seed, B.seed, 12).concat([1, 254, 0xff]);
    masks.forEach(function (m) {
      var g = ART.crossover(A.genes, B.genes, m);
      var child;
      try {
        child = VH.compute(pr[0] + " x " + pr[1], { seed: pr[2], genes: g });
      } catch (e) {
        p.push("compute threw for mask " + m + ": " + e.message);
        return;
      }
      if (g.k < 1 || g.k >= g.N) p.push("bad k/N " + g.k + "/" + g.N);
      // h[1] and h[4] are unused by the generator (h[4] can be NaN: the sign flip hits a hole).
      if (isFinite(g.h[1]) || isFinite(g.h[4])) p.push("h holes filled " + JSON.stringify(g.h));
      var e = symmetryError(child);
      maxErr = Math.max(maxErr, e);
      if (!(e < 1e-9)) p.push(pr.join("/") + " mask " + m + " symmetry error " + e.toExponential(2));
      if (!child.art) p.push("child not flagged as art");
      checked++;
    });
    // Parents' genes are not mutated
    var again = VH.compute(pr[0], { seed: pr[2] });
    if (JSON.stringify(again.genes) !== JSON.stringify(A.genes)) p.push("crossover mutated parent genes");
  });
  if (!sawMixedN) p.push("test pairs never mix N = 7 and N = 11");
  report("crossover", p, checked + " children keep N-fold symmetry (max error " + maxErr.toExponential(2) + "), mask 0 = parent A");

  var q = [];
  var a = VH.compute("War").seed, b = VH.compute("Peace").seed;
  var m1 = ART.childMasks(a, b, 20), m2 = ART.childMasks(a, b, 20);
  if (m1.join() !== m2.join()) q.push("not deterministic");
  if (new Set(m1).size !== 20) q.push("not distinct");
  if (m1.some(function (m) { return m < 1 || m > 254; })) q.push("out of range");
  if (ART.childMasks(a, a, 254).length !== 254) q.push("cannot fill 254 masks");
  if (ART.childMasks(a, b, 8).join() === ART.childMasks(a, VH.compute("Peace!").seed, 8).join()) q.push("same masks for different parents");
  report("child masks", q, "ok (deterministic, distinct, 1..254)");
})();

// ---------------------------------------------------------------- string art

function svgProblems(svg, label) {
  var p = [];
  if (/NaN|undefined|Infinity/.test(svg)) p.push(label + ": contains NaN/undefined/Infinity");
  if (svg.indexOf("<svg") < 0 || svg.trim().slice(-6) !== "</svg>") p.push(label + ": not an svg document");
  var stack = [], re = /<(\/?)([a-zA-Z][\w:-]*)[^>]*?(\/?)>/g, m;
  var body = svg.replace(/<\?xml[^>]*\?>/, "");
  while ((m = re.exec(body))) {
    if (m[3]) continue;
    if (m[1]) {
      if (stack.pop() !== m[2]) {
        p.push(label + ": unbalanced </" + m[2] + ">");
        break;
      }
    } else stack.push(m[2]);
  }
  if (stack.length) p.push(label + ": unclosed " + stack.join(","));
  return p;
}

(function () {
  var p = [];
  var opts7 = ART.nailOptions(7), opts11 = ART.nailOptions(11);
  [opts7, opts11].forEach(function (o, i) {
    var N = i ? 11 : 7;
    if (!o.length) p.push("no nail options for N=" + N);
    o.forEach(function (m) {
      if (4620 % m || m % N || m < 60 || m > 924) p.push("bad nail option " + m + " for N=" + N);
    });
  });
  var hash = VH.compute("Gun Gun Feb");
  var opts = ART.nailOptions(hash.N);
  [opts[0], opts[Math.floor(opts.length / 2)], opts[opts.length - 1]].forEach(function (M) {
    var plan = ART.stringArt(hash, M);
    if (plan.points.length !== M) p.push("points " + plan.points.length + " != " + M);
    plan.layers.forEach(function (L, li) {
      if (L.step < 1 || L.step >= M) p.push("step " + L.step);
      var g = M, t = L.step;
      while (t) { var r = g % t; g = t; t = r; }
      if (L.cycles !== g) p.push("layer " + li + " cycles " + L.cycles + " != gcd " + g);
      if (L.kept !== L.segments.length || L.kept > M) p.push("kept count");
      L.segments.forEach(function (s) {
        if (s[1] !== (s[0] + L.step) % M) p.push("segment " + s.join("-") + " not a step chord");
      });
      if (!L.kept) p.push("layer " + li + " empty at M=" + M);
    });
    p = p.concat(svgProblems(ART.stringArtSvg(plan, { sizeMm: 300 }), "string svg M=" + M));
    var txt = ART.stringArtText(plan);
    if (txt.indexOf("cycle 1:") < 0 || /NaN|undefined/.test(txt)) p.push("text instructions");
  });
  report("string art", p, "ok (nail options N=7: " + opts7.join(",") + "; N=11: " + opts11.join(",") + ")");
})();

// ---------------------------------------------------------------- plotter + riso SVG

(function () {
  var p = [];
  ["War", "Gun Gun Feb"].forEach(function (name) {
    var hash = VH.compute(name, { seed: "v3" });
    var svg = ART.plotterSvg(hash, { sizeMm: 200 });
    p = p.concat(svgProblems(svg, "plotter " + name));
    if ((svg.match(/inkscape:groupmode="layer"/g) || []).length !== 4) p.push("plotter layer count");
    var hidden = ART.plotterSvg(hash, { hidden: [false, true, false], curve: false });
    if ((hidden.match(/inkscape:groupmode="layer"/g) || []).length !== 2) p.push("plotter hidden/curve options");
    var inks = ART.risoInks(hash);
    if (inks.length !== 3 || new Set(inks.map(function (i) { return i.hex; })).size !== 3) p.push("riso inks not 3 distinct");
    var riso = ART.risoSvg(hash, { offsets: [[0.4, 0], [0, -0.3], [-0.2, 0.2]] });
    p = p.concat(svgProblems(riso, "riso " + name));
    var polys = (riso.match(/<polygon/g) || []).length;
    var want = hash.layers.reduce(function (s, L) { return s + L.count; }, 0);
    if (polys !== want) p.push("riso polygons " + polys + " != " + want);
    if (riso.indexOf("mix-blend-mode:multiply") < 0 || riso.indexOf('sodipodi:insensitive="true"') < 0) p.push("riso layer styles");
  });
  report("plotter + riso svg", p, "ok (balanced, no NaN, 4 plotter layers, all triangles as polygons)");
})();

// ---------------------------------------------------------------- oscilloscope audio

(function () {
  var p = [];
  var hash = VH.compute("Gun Gun Feb");
  var per = ART.scopePeriod(hash, 48000, 110);
  if (per.length !== Math.round((48000 * hash.N) / 110)) p.push("period length " + per.length);
  var peak = 0;
  for (var i = 0; i < per.length; i++) peak = Math.max(peak, Math.abs(per.left[i]), Math.abs(per.right[i]));
  if (Math.abs(peak - 0.9) > 1e-6) p.push("peak " + peak);
  var wav = ART.scopeWav(hash, { seconds: 2 });
  var dv = new DataView(wav.buffer);
  var s = function (o, n) { return String.fromCharCode.apply(null, wav.slice(o, o + n)); };
  if (s(0, 4) !== "RIFF" || s(8, 4) !== "WAVE" || s(12, 4) !== "fmt " || s(36, 4) !== "data") p.push("wav chunk ids");
  if (dv.getUint16(20, true) !== 1 || dv.getUint16(22, true) !== 2 || dv.getUint32(24, true) !== 48000 || dv.getUint16(34, true) !== 16) p.push("wav fmt");
  if (dv.getUint32(40, true) !== 2 * 48000 * 4 || wav.length !== 44 + 2 * 48000 * 4 || dv.getUint32(4, true) !== wav.length - 8) p.push("wav sizes");
  report("scope audio", p, "ok (period " + per.length + " samples, 16-bit stereo WAV " + wav.length + " bytes)");
})();

// ---------------------------------------------------------------- lithophane

function meshProblems(m, label) {
  var p = [], pos = m.positions, idx = m.indices, nv = pos.length / 3;
  for (var i = 0; i < pos.length; i++) if (!isFinite(pos[i])) { p.push(label + ": non-finite position"); break; }
  for (i = 0; i < m.thickness.length; i++) if (!isFinite(m.thickness[i])) { p.push(label + ": non-finite thickness"); break; }
  if (m.thickness.length !== nv) p.push(label + ": thickness per vertex");
  if (m.triangles !== idx.length / 3) p.push(label + ": triangle count");
  var directed = new Map();
  var vol = 0;
  for (var t = 0; t < idx.length; t += 3) {
    var a = idx[t], b = idx[t + 1], c = idx[t + 2];
    if (a >= nv || b >= nv || c >= nv) { p.push(label + ": index out of range"); break; }
    if (a === b || b === c || a === c) { p.push(label + ": degenerate triangle"); break; }
    [[a, b], [b, c], [c, a]].forEach(function (e) {
      var k = e[0] * nv + e[1];
      directed.set(k, (directed.get(k) || 0) + 1);
    });
    var ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
    var bx = pos[b * 3], by = pos[b * 3 + 1], bz = pos[b * 3 + 2];
    var cx = pos[c * 3], cy = pos[c * 3 + 1], cz = pos[c * 3 + 2];
    vol += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  var bad = 0;
  directed.forEach(function (n, k) {
    var a = Math.floor(k / nv), b = k % nv;
    if (n !== 1 || directed.get(b * nv + a) !== 1) bad++;
  });
  if (bad) p.push(label + ": " + bad + " directed edges not matched exactly once by their reverse");
  if (!(vol > 0)) p.push(label + ": signed volume " + vol);
  return { problems: p, volume: vol };
}

(function () {
  var p = [], notes = [];
  // A test image: bright rings, so thickness really varies.
  var lum = function (u, v) { return 0.5 + 0.5 * Math.cos(Math.hypot(u, v) * 12); };
  var cases = [
    { shape: "disc", rings: 40, sectors: 120 },
    { shape: "disc", rings: 30, sectors: 96, frameMm: 0 },
    { shape: "dome", rings: 40, sectors: 120 },
    { shape: "dome", rings: 30, sectors: 96, frameMm: 0, wrap: 1.4 },
    { shape: "disc" },
    { shape: "dome" },
  ];
  cases.forEach(function (c) {
    var m = ART.lithophane(Object.assign({ lum: lum }, c));
    var label = c.shape + " " + (c.rings || 160) + "x" + (c.sectors || 720) + (c.frameMm === 0 ? " no frame" : "");
    var r = meshProblems(m, label);
    p = p.concat(r.problems);
    var tMin = Infinity, tMax = -Infinity;
    for (var i = 0; i < m.thickness.length; i++) {
      tMin = Math.min(tMin, m.thickness[i]);
      tMax = Math.max(tMax, m.thickness[i]);
    }
    if (tMin < 0.8 - 1e-6 || tMax > 3.6 + 1e-6) p.push(label + ": thickness range " + tMin + ".." + tMax);
    notes.push(label + " " + m.triangles + " tris " + m.sizeMm.map(function (v) { return v.toFixed(1); }).join("x") + " mm");
  });
  var disc = ART.lithophane({ lum: lum, shape: "disc", rings: 20, sectors: 64 });
  if (Math.abs(disc.sizeMm[0] - 100) > 0.5 || Math.abs(disc.sizeMm[2] - 3.6) > 1e-6) p.push("disc size " + disc.sizeMm.join(","));
  report("lithophane", p, "watertight, outward (" + notes.join("; ") + ")");
})();

process.exit(failures ? 1 : 0);
