/*
 * Visual Hashing core — exact port of the original 2D algorithm (index.js stp()).
 *
 * compute(name, { seed: "legacy" | "v3" }) returns the curve points, the internal
 * signals of the generator and the triangle layers, so any renderer (2D canvas or
 * three.js) can draw the same hash. "legacy" seeding reproduces v2.2.0 images
 * exactly; "v3" seeds the same generator from SHA-256(name).
 *
 * Trig: "legacy" uses Math.sin/Math.cos, as the original did. JavaScript does not
 * require those to be correctly rounded, so legacy images are only guaranteed
 * bit-identical within one engine (the reference is V8). "v3" uses the portable
 * sin/cos below, built from + - * / and Math.floor only. Every one of those is
 * correctly rounded IEEE 754, so a v3 hash is bit-identical in every browser and
 * in any language that evaluates the same operations in the same order without
 * fused multiply-add (see test/portable_trig.py and test/vectors.json).
 *
 * Plain script (no modules) so the page also works when opened from file://.
 */
(function (root) {
  "use strict";

  var SIZE = 4620; // 2^2*3*5*7*11: divisible by both symmetry orders (7, 11)
  var SCALE = 110; // original canvas mapping: p = v * 110 + 200
  var OFFSET = 200;

  // ---------------------------------------------------------------- seeding

  function legacySeed(name) {
    var c = [123456789, 362436069, 521288629, 0];
    for (var b = 0; b < name.length; b++)
      c[(b + 3) % 4] ^= name.charCodeAt(b) << (b * 11) % 16;
    return c;
  }

  var K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];

  function ror(x, n) {
    return (x >>> n) | (x << (32 - n));
  }

  // SHA-256 of a byte array, returned as 8 signed 32-bit words.
  function sha256(bytes) {
    var len = bytes.length;
    var padded = (((len + 9 + 63) / 64) | 0) * 64;
    var m = new Uint8Array(padded);
    m.set(bytes);
    m[len] = 0x80;
    var dv = new DataView(m.buffer);
    dv.setUint32(padded - 8, Math.floor((len * 8) / 4294967296));
    dv.setUint32(padded - 4, (len * 8) >>> 0);

    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var W = new Array(64);
    for (var off = 0; off < padded; off += 64) {
      var i;
      for (i = 0; i < 16; i++) W[i] = dv.getUint32(off + i * 4) | 0;
      for (i = 16; i < 64; i++) {
        var w15 = W[i - 15], w2 = W[i - 2];
        var s0 = ror(w15, 7) ^ ror(w15, 18) ^ (w15 >>> 3);
        var s1 = ror(w2, 17) ^ ror(w2, 19) ^ (w2 >>> 10);
        W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (i = 0; i < 64; i++) {
        var S1 = ror(e, 6) ^ ror(e, 11) ^ ror(e, 25);
        var ch = (e & f) ^ (~e & g);
        var t1 = (h + S1 + ch + K[i] + W[i]) | 0;
        var S0 = ror(a, 2) ^ ror(a, 13) ^ ror(a, 22);
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + maj) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0;
        d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    return H;
  }

  function utf8(str) {
    if (typeof TextEncoder !== "undefined") return new TextEncoder().encode(str);
    var s = unescape(encodeURIComponent(str)), out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  function v3Seed(name) {
    var H = sha256(utf8(name));
    var c = [H[0] ^ H[4], H[1] ^ H[5], H[2] ^ H[6], H[3] ^ H[7]];
    if (!(c[0] | c[1] | c[2] | c[3])) c[0] = 1; // xorshift must not start at all-zero
    return c;
  }

  // Marsaglia xorshift128, output mapped to [0, 1) exactly like the original rand().
  function makeRand(c) {
    var x = c[0], y = c[1], z = c[2], w = c[3];
    return function () {
      var t = x ^ (x << 11);
      x = y; y = z; z = w;
      w = w ^ (w >>> 19) ^ (t ^ (t >>> 8));
      return w / 4294967296 + 0.5;
    };
  }

  // ---------------------------------------------------------------- portable trig
  //
  // fdlibm's method: Cody–Waite reduction by π/2, then the minimax polynomials of
  // __kernel_sin / __kernel_cos on [-π/4, π/4]. Accurate to about 1 ulp for
  // |x| < 2^19 (the generator stays below ~1000). Operation order is part of the
  // contract: ports must evaluate exactly these expressions, without FMA.

  var INV_PIO2 = 6.36619772367581382433e-1; // 2/π
  var PIO2_1 = 1.57079632673412561417e0; // first 33 bits of π/2, so n * PIO2_1 is exact
  var PIO2_1T = 6.07710050650619224932e-11; // π/2 - PIO2_1

  var S1 = -1.66666666666666324348e-1;
  var S2 = 8.33333333332248946124e-3;
  var S3 = -1.98412698298579493134e-4;
  var S4 = 2.75573137070700676789e-6;
  var S5 = -2.50507602534068634195e-8;
  var S6 = 1.58969099521155010221e-10;

  var C1 = 4.16666666666666019037e-2;
  var C2 = -1.38888888888741095749e-3;
  var C3 = 2.48015872894767294178e-5;
  var C4 = -2.75573143513906633035e-7;
  var C5 = 2.08757232129817482790e-9;
  var C6 = -1.13596475577881948265e-11;

  function kernelSin(x) {
    var z = x * x;
    var v = z * x;
    var r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)));
    return x + v * (S1 + z * r);
  }

  function kernelCos(x) {
    var z = x * x;
    var r = z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6)))));
    var hz = 0.5 * z;
    var w = 1 - hz;
    return w + (((1 - w) - hz) + z * r);
  }

  // x = n·π/2 + y with |y| <= π/4; returns quadrant (n mod 4) and y.
  function reduce(x, out) {
    var n = Math.floor(x * INV_PIO2 + 0.5);
    out[0] = (n % 4 + 4) % 4;
    out[1] = (x - n * PIO2_1) - n * PIO2_1T;
  }

  var red = [0, 0];

  function psin(x) {
    reduce(x, red);
    var q = red[0], y = red[1];
    if (q === 0) return kernelSin(y);
    if (q === 1) return kernelCos(y);
    if (q === 2) return -kernelSin(y);
    return -kernelCos(y);
  }

  function pcos(x) {
    reduce(x, red);
    var q = red[0], y = red[1];
    if (q === 0) return kernelCos(y);
    if (q === 1) return -kernelSin(y);
    if (q === 2) return -kernelCos(y);
    return kernelSin(y);
  }

  var portableTrig = { sin: psin, cos: pcos };

  // ---------------------------------------------------------------- generator

  function compute(name, opts) {
    name = name == null ? "" : String(name);
    var seedMode = opts && opts.seed === "v3" ? "v3" : "legacy";
    var seed = seedMode === "v3" ? v3Seed(name) : legacySeed(name);
    var rand = makeRand(seed);
    var T = seedMode === "v3" ? portableTrig : Math;
    var a, b, f;

    function fi() {
      return rand() < 0.5;
    }
    function rg(ha) {
      var i = (ha.length * rand()) | 0;
      var v = ha[i];
      ha[i] = ha[ha.length - 1];
      ha.pop();
      return v;
    }

    for (a = 0; a < 52; a++) rand();

    var N = fi() ? 7 : 11;

    var h = [];
    h[2] = 0.3 + rand() * 0.2;
    h[3] = 0.1 + rand() * 0.1;
    h[5] = 1 + rand() * 4;
    h[6] = 1 + rand();
    h[7] = 1 + rand();
    h[0] = 0.4 + rand() * 0.2;
    for (a = 2; a < 8; a++) if (fi()) h[a] *= -1;

    var ki = [1, 3, 5, 7, 9, 11];
    var gu = [0, 0, 2, 4, 6, 8, 10];
    var s = [], q = [], fn = [];
    var k = (1 + rand() * (N - 1)) | 0;
    var pr = k / N;

    for (a = 0; a < 2; a++) {
      if (fi()) {
        s[a] = [T.cos, T.sin];
        q[a] = rg(ki) - pr;
        fn[a] = "cos/sin";
      } else {
        s[a] = [T.sin, T.cos];
        q[a] = rg(gu) + pr;
        fn[a] = "sin/cos";
      }
    }
    for (a = 2; a < 8; a++) {
      b = fi();
      if (!ki.length) b = 0;
      if (!gu.length) b = 1;
      q[a] = b ? rg(ki) : rg(gu);
      if (fi()) q[a] *= -1;
      if (a > 5) b = !b;
      s[a] = b ? T.cos : T.sin;
      fn[a] = b ? "cos" : "sin";
    }

    var n = [];
    for (a = 0; a < 3; a++) n[a] = fi() ? 1 : -1;

    // ---- trace the curve, keeping the internal signals for the 3D lift
    var x = new Float64Array(SIZE), y = new Float64Array(SIZE);
    var cx = new Float64Array(SIZE), cy = new Float64Array(SIZE);
    var sMod = new Float32Array(SIZE), sPhase = new Float32Array(SIZE);
    var sLoop = new Float32Array(SIZE), sWave = new Float32Array(SIZE);
    var step = ((Math.PI * 2) / SIZE) * N;
    var r = 0, maxPhase = 1e-9;
    for (f = 0; f < SIZE; f++) {
      var bb = s[6](r * q[6] + s[3](r * q[3]) * h[5]) * n[0];
      var ra = 1 + bb * h[0];
      var d = s[7](r * q[7]);
      var e = -d;
      var dd = d * ((2 - ra) * n[1]);
      e *= (2 - ra) * n[2];
      var c = (s[4](r * q[4] + s[5](r * q[5]) * h[7]) / 4) * h[6] * (ra - (1 - h[0]));
      var px =
        T.sin(r * pr + c) * ra +
        s[0][0](r * q[0]) * h[2] * dd +
        s[1][0](r * q[1]) * h[3] * e;
      var py =
        T.cos(r * pr + c) * ra +
        s[0][1](r * q[0]) * h[2] * dd +
        s[1][1](r * q[1]) * h[3] * e;
      x[f] = px;
      y[f] = py;
      cx[f] = px * SCALE + OFFSET;
      cy[f] = py * SCALE + OFFSET;
      sMod[f] = bb;
      sPhase[f] = c;
      sLoop[f] = d;
      sWave[f] = T.sin((f / SIZE) * Math.PI * 2);
      if (Math.abs(c) > maxPhase) maxPhase = Math.abs(c);
      r += step;
    }
    for (f = 0; f < SIZE; f++) sPhase[f] /= maxPhase;

    // ---- triangle layers (same order and filter as the canvas version)
    var layers = [];
    var hh = 0;
    for (var L = 0; L < 3; L++) {
      var hue = (rand() * 360) | 0;
      hh += (1 + rand() * 3) | 0;
      var sat = (50 + rand() * 20) | 0;
      var stride = (L + 1) * hh;
      var idx = [], area = [];
      for (a = 0; a < SIZE; a++) {
        var i0 = a % SIZE, i1 = (a + stride) % SIZE, i2 = (a + 2 * stride) % SIZE;
        var ar = cx[i0] * (cy[i1] - cy[i2]);
        ar += cx[i1] * (cy[i2] - cy[i0]);
        ar += cx[i2] * (cy[i0] - cy[i1]);
        if (ar > 45 && ar < 8000) {
          idx.push(i0, i1, i2);
          area.push(ar);
        }
      }
      layers.push({
        hue: hue,
        sat: sat,
        light: 40,
        stride: stride,
        count: area.length,
        index: new Uint32Array(idx),
        area: new Float64Array(area),
        rgb: hslToRgb(hue, sat / 100, 0.4),
      });
    }

    return {
      name: name,
      seedMode: seedMode,
      seed: seed.map(function (v) {
        return ("00000000" + (v >>> 0).toString(16)).slice(-8);
      }),
      size: SIZE,
      N: N,
      k: k,
      pr: pr,
      q: q,
      fn: fn,
      h: h,
      n: n,
      x: x,
      y: y,
      cx: cx,
      cy: cy,
      signals: { radius: sMod, phase: sPhase, loop: sLoop, wave: sWave },
      layers: layers,
    };
  }

  // Triangle opacity used by the original renderer: constant "light" per triangle.
  function alphaOf(area) {
    return Math.min(1, 55 / area);
  }

  function hslToRgb(hDeg, s, l) {
    var c = (1 - Math.abs(2 * l - 1)) * s;
    var hp = (((hDeg % 360) + 360) % 360) / 60;
    var x = c * (1 - Math.abs((hp % 2) - 1));
    var r = 0, g = 0, b = 0;
    if (hp < 1) { r = c; g = x; }
    else if (hp < 2) { r = x; g = c; }
    else if (hp < 3) { g = c; b = x; }
    else if (hp < 4) { g = x; b = c; }
    else if (hp < 5) { r = x; b = c; }
    else { r = c; b = x; }
    var m = l - c / 2;
    return [r + m, g + m, b + m];
  }

  // Draw a hash with the original 2D canvas technique (400x400 logical units).
  function render2D(hash, ctx, scale) {
    scale = scale || 1;
    ctx.save();
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.fillStyle = "rgb(0,0,0)";
    ctx.fillRect(0, 0, 400, 400);
    ctx.globalCompositeOperation = "lighter";
    for (var L = 0; L < hash.layers.length; L++) {
      var layer = hash.layers[L], idx = layer.index;
      for (var t = 0; t < layer.count; t++) {
        ctx.beginPath();
        for (var v = 0; v < 3; v++) {
          var i = idx[t * 3 + v];
          ctx.lineTo(hash.cx[i], hash.cy[i]);
        }
        ctx.fillStyle = "hsla(" + layer.hue + "," + layer.sat + "%,40%," + 55 / layer.area[t] + ")";
        ctx.fill();
      }
    }
    ctx.restore();
  }

  var api = {
    SIZE: SIZE,
    compute: compute,
    render2D: render2D,
    alphaOf: alphaOf,
    hslToRgb: hslToRgb,
    sha256: sha256,
    utf8: utf8,
    trig: portableTrig,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.VisualHash = api;
})(this);
