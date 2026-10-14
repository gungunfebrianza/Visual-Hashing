/*
 * Visual Hashing art — pure data for the digital-art effects (no three.js).
 *
 * Every function takes a hash from VisualHash.compute() (or its genes / seed
 * words) and returns plain data: seed bit tools, gene crossover, string art and
 * plotter / risograph SVGs, oscilloscope audio, lithophane meshes and visual
 * cryptography shares. The 3D page renders and downloads them; test/art.js
 * checks them in node.
 *
 * Plain script (no modules) so the page also works when opened from file://.
 */
(function (root) {
  "use strict";

  var SIZE = 4620;
  var TAU = Math.PI * 2;

  // ---------------------------------------------------------------- helpers

  function hex32(w) {
    return ("00000000" + (w >>> 0).toString(16)).slice(-8);
  }

  function word(w) {
    return typeof w === "string" ? parseInt(w, 16) >>> 0 : w >>> 0;
  }

  function popcount(v) {
    v = v - ((v >>> 1) & 0x55555555);
    v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
    return (Math.imul((v + (v >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24);
  }

  function gcd(a, b) {
    while (b) {
      var t = a % b;
      a = b;
      b = t;
    }
    return a;
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

  function rgbHex(rgb) {
    return "#" + rgb.map(function (v) {
      return ("0" + Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16)).slice(-2);
    }).join("");
  }

  function layerHex(L) {
    return rgbHex(hslToRgb(L.hue, L.sat / 100, 0.4));
  }

  function hueOfHex(hex) {
    var r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    if (!d) return -1; // achromatic
    var h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return (h * 60 + 360) % 360;
  }

  function esc(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function n2(v) {
    return (Math.round(v * 100) / 100).toString();
  }

  function shoelace(cx, cy, i0, i1, i2) {
    var ar = cx[i0] * (cy[i1] - cy[i2]);
    ar += cx[i1] * (cy[i2] - cy[i0]);
    ar += cx[i2] * (cy[i0] - cy[i1]);
    return ar;
  }

  var NS =
    'xmlns="http://www.w3.org/2000/svg" ' +
    'xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" ' +
    'xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"';

  function svgOpen(sizeMm, title, hash) {
    var meta = hash ? { name: hash.name, seedMode: hash.seedMode, seed: hash.seed.join(" "), symmetry: hash.N, art: !!hash.art } : null;
    return (
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      "<svg " + NS + ' width="' + sizeMm + 'mm" height="' + sizeMm + 'mm" viewBox="0 0 ' + sizeMm + " " + sizeMm + '">\n' +
      "<title>" + esc(title) + "</title>\n" +
      (meta ? "<metadata>" + esc(JSON.stringify({ visualHash: meta })) + "</metadata>\n" : "")
    );
  }

  function layerOpen(label, extra) {
    return '<g inkscape:groupmode="layer" inkscape:label="' + esc(label) + '"' + (extra || "") + ">\n";
  }

  // ---------------------------------------------------------------- seed bits

  // Differing bits between two 128-bit seeds (hex word arrays): the avalanche meter.
  function hamming(seedA, seedB) {
    var d = 0;
    for (var i = 0; i < 4; i++) d += popcount(word(seedA[i]) ^ word(seedB[i]));
    return d;
  }

  // One-bit neighbour of a seed: bit 0..127, word = bit >> 5.
  function flipBit(seedWords, bit) {
    var out = seedWords.map(function (w) {
      return hex32(word(w));
    });
    var i = (bit >> 5) & 3;
    out[i] = hex32(word(out[i]) ^ (1 << (bit & 31)));
    return out;
  }

  // ---------------------------------------------------------------- breeding

  function cloneGenes(g) {
    return {
      N: g.N,
      k: g.k,
      h: g.h.slice(),
      q: g.q.slice(),
      fn: g.fn.slice(),
      n: g.n.slice(),
      layers: g.layers.map(function (L) {
        return { hue: L.hue, step: L.step, sat: L.sat };
      }),
    };
  }

  // Epicycle frequencies are integer ∓ pr (pr = k/N): that offset is what makes
  // the curve N-fold symmetric. Keep the integer, re-apply the child's pr.
  function epicycleInt(g, a) {
    var pr = g.k / g.N;
    return Math.round(g.fn[a] === "cos/sin" ? g.q[a] + pr : g.q[a] - pr);
  }

  // Child genes: bit i of mask set = gene group i comes from B.
  function crossover(genesA, genesB, mask) {
    var A = genesA, B = genesB;
    var c = cloneGenes(A);
    var pick = function (bit) {
      return (mask >> bit) & 1 ? B : A;
    };
    var take = function (src, key, list) {
      list.forEach(function (i) {
        c[key][i] = src[key][i];
      });
    };
    var s;
    s = pick(0); c.N = s.N; c.k = s.k;
    s = pick(1); take(s, "h", [0, 5]); take(s, "q", [3, 6]); take(s, "fn", [3, 6]); take(s, "n", [0]);
    s = pick(2); take(s, "h", [6, 7]); take(s, "q", [4, 5]); take(s, "fn", [4, 5]);
    s = pick(5); take(s, "q", [7]); take(s, "fn", [7]);
    var pr = c.k / c.N;
    [3, 4].forEach(function (bit, a) {
      s = pick(bit);
      var whole = epicycleInt(s, a);
      c.fn[a] = s.fn[a];
      c.h[a + 2] = s.h[a + 2];
      c.n[a + 1] = s.n[a + 1];
      // Same expression as the generator, so mask 0 reproduces A bit for bit.
      c.q[a] = c.fn[a] === "cos/sin" ? whole - pr : whole + pr;
    });
    for (var L = 0; L < 3; L++) {
      s = pick(6);
      c.layers[L].hue = s.layers[L].hue;
      c.layers[L].sat = s.layers[L].sat;
      c.layers[L].step = pick(7).layers[L].step;
    }
    return c;
  }

  // Distinct masks in 1..254 (never all-A or all-B), deterministic per parent pair.
  function childMasks(seedA, seedB, count) {
    var x = word(seedA[0]) ^ word(seedB[0]), y = word(seedA[1]) ^ word(seedB[1]);
    var z = word(seedA[2]) ^ word(seedB[2]), w = word(seedA[3]) ^ word(seedB[3]);
    if (!(x | y | z | w)) x = 0x9e3779b9;
    count = Math.max(0, Math.min(254, count | 0));
    var out = [], seen = {};
    while (out.length < count) {
      var t = x ^ (x << 11);
      x = y; y = z; z = w;
      w = (w ^ (w >>> 19) ^ (t ^ (t >>> 8))) >>> 0;
      var m = (w % 254) + 1;
      if (!seen[m]) {
        seen[m] = true;
        out.push(m);
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- string art

  // Nail counts that sample the curve exactly (divide 4620) and keep N-fold symmetry.
  function nailOptions(N) {
    var out = [];
    for (var m = 60; m <= 924; m++) if (SIZE % m === 0 && m % N === 0) out.push(m);
    return out;
  }

  // A layer is the walk j -> j+t -> j+2t ... mod M: one thread per cycle
  // (gcd(M, t) cycles). A chord is skipped where the original drops its triangle.
  function stringArt(hash, nails) {
    var M = nails | 0, g = SIZE / M;
    if (!(M > 0) || SIZE % M) throw new Error("nail count must divide " + SIZE);
    var points = [];
    for (var j = 0; j < M; j++) points.push([hash.x[j * g], -hash.y[j * g]]);
    var prevT = 0;
    var layers = hash.layers.map(function (L) {
      // The stride in nails, kept distinct per layer: nails are coarser than the
      // curve, and three identical threads would hide the layers' different strides.
      var t = Math.max(prevT + 1, Math.round((L.stride * M) / SIZE)) % M || 1;
      prevT = t;
      // A longer step than the original stride spans a bigger triangle; scale the
      // upper area bound with it so the filter keeps the same shapes.
      var k = Math.max(1, (t * g) / L.stride);
      var maxArea = 8000 * k * k;
      var visited = new Uint8Array(M), segments = [], cycles = 0;
      for (var start = 0; start < M; start++) {
        if (visited[start]) continue;
        cycles++;
        var a = start;
        do {
          visited[a] = 1;
          var b = (a + t) % M, c = (a + 2 * t) % M;
          var ar = shoelace(hash.cx, hash.cy, a * g, b * g, c * g);
          if (ar > 45 && ar < maxArea) segments.push([a, b]);
          a = b;
        } while (a !== start);
      }
      return { hue: L.hue, sat: L.sat, hex: layerHex(L), step: t, segments: segments, kept: segments.length, cycles: cycles };
    });
    return { nails: M, name: hash.name, seed: hash.seed.slice(), points: points, layers: layers };
  }

  function boardTransform(plan, sizeMm) {
    var maxR = 1e-9;
    plan.points.forEach(function (p) {
      maxR = Math.max(maxR, Math.hypot(p[0], p[1]));
    });
    var c = sizeMm / 2, s = (sizeMm / 2 - 15) / maxR;
    return function (p) {
      return [c + p[0] * s, c - p[1] * s];
    };
  }

  function stringArtSvg(plan, opts) {
    opts = opts || {};
    var size = opts.sizeMm || 300, c = size / 2;
    var at = boardTransform(plan, size);
    var title = opts.title || "String art template · " + (plan.name || "visual hash") + " · " + plan.nails + " nails";
    var out = svgOpen(size, title, null);
    out += layerOpen("board");
    out += '<circle cx="' + c + '" cy="' + c + '" r="' + n2(size / 2 - 2) + '" fill="none" stroke="#000" stroke-width="0.3"/>\n';
    out += '<path d="M' + n2(c - 3) + " " + c + "H" + n2(c + 3) + "M" + c + " " + n2(c - 3) + "V" + n2(c + 3) + '" stroke="#000" stroke-width="0.2"/>\n</g>\n';
    plan.layers.forEach(function (L, i) {
      var d = L.segments.map(function (s) {
        var a = at(plan.points[s[0]]), b = at(plan.points[s[1]]);
        return "M" + n2(a[0]) + " " + n2(a[1]) + "L" + n2(b[0]) + " " + n2(b[1]);
      }).join("");
      out += layerOpen("thread " + (i + 1) + " (preview)");
      out += '<path d="' + d + '" fill="none" stroke="' + L.hex + '" stroke-opacity="0.35" stroke-width="0.15"/>\n</g>\n';
    });
    out += layerOpen("nails");
    var font = Math.max(1, Math.min(2.2, (Math.PI * size * 0.8) / plan.nails / 2));
    plan.points.forEach(function (p, j) {
      var q = at(p), dx = q[0] - c, dy = q[1] - c, r = Math.hypot(dx, dy) || 1;
      out += '<circle cx="' + n2(q[0]) + '" cy="' + n2(q[1]) + '" r="0.8" fill="none" stroke="#000" stroke-width="0.15"/>';
      out += '<text x="' + n2(q[0] + (dx / r) * 2.6) + '" y="' + n2(q[1] + (dy / r) * 2.6 + font * 0.35) + '" font-size="' + n2(font) +
        '" font-family="sans-serif" text-anchor="middle">' + j + "</text>\n";
    });
    out += "</g>\n</svg>\n";
    return out;
  }

  function stringArtText(plan) {
    var lines = [
      "Visual Hashing string art" + (plan.name ? " · " + plan.name : ""),
      "Seed " + plan.seed.join(" "),
      plan.nails + " nails, numbered 0.." + (plan.nails - 1) + " (see the SVG template, print at 100 %).",
      "Each layer is one thread colour. Follow each cycle in order; '(skip)' means wrap around the nail",
      "without crossing the board, because the original image drops that triangle.",
      "",
    ];
    plan.layers.forEach(function (L, i) {
      var keep = {};
      L.segments.forEach(function (s) {
        keep[s[0]] = true;
      });
      lines.push("Layer " + (i + 1) + ": thread hsl(" + L.hue + ", " + L.sat + "%, 40%) " + L.hex +
        ", step " + L.step + ", " + L.kept + " chords, " + L.cycles + " cycle" + (L.cycles > 1 ? "s" : ""));
      var visited = new Uint8Array(plan.nails), cycle = 0;
      for (var start = 0; start < plan.nails; start++) {
        if (visited[start]) continue;
        cycle++;
        var seq = [String(start)], a = start;
        do {
          visited[a] = 1;
          var b = (a + L.step) % plan.nails;
          seq.push(keep[a] ? String(b) : b + " (skip)");
          a = b;
        } while (a !== start);
        lines.push("  cycle " + cycle + ": " + seq.join(" > "));
      }
      lines.push("");
    });
    return lines.join("\n");
  }

  // ---------------------------------------------------------------- plotter

  // One pen per layer: the chords i -> i+stride of the kept triangles, in plot order.
  function plotterSvg(hash, opts) {
    opts = opts || {};
    var size = opts.sizeMm || 200, s = size / 400, hidden = opts.hidden || [];
    var px = function (i) {
      return n2(hash.cx[i] * s) + " " + n2(hash.cy[i] * s);
    };
    var out = svgOpen(size, "Plotter · " + (hash.name || "visual hash"), hash);
    if (opts.curve !== false) {
      var d = "M" + px(0);
      for (var i = 1; i < SIZE; i++) d += "L" + px(i);
      out += layerOpen("1 curve");
      out += '<path d="' + d + 'Z" fill="none" stroke="#111" stroke-width="0.3" stroke-linejoin="round"/>\n</g>\n';
    }
    hash.layers.forEach(function (L, li) {
      if (hidden[li]) return;
      var parts = [];
      for (var t = 0; t < L.count; t++) parts.push("M" + px(L.index[t * 3]) + "L" + px(L.index[t * 3 + 1]));
      out += layerOpen(li + 2 + " pen layer " + (li + 1));
      out += '<path d="' + parts.join("") + '" fill="none" stroke="hsl(' + L.hue + "," + L.sat + '%,40%)" stroke-width="0.3" stroke-linecap="round"/>\n</g>\n';
    });
    return out + "</svg>\n";
  }

  // ---------------------------------------------------------------- risograph

  var RISO_INKS = [
    { name: "Fluorescent Pink", hex: "#FF48B0" },
    { name: "Yellow", hex: "#FFE800" },
    { name: "Blue", hex: "#0078BF" },
    { name: "Green", hex: "#00A95C" },
    { name: "Bright Red", hex: "#F15060" },
    { name: "Purple", hex: "#765BA7" },
    { name: "Teal", hex: "#00838A" },
    { name: "Orange", hex: "#FF6C2F" },
    { name: "Black", hex: "#000000" },
  ];

  // One distinct drum per layer, nearest ink by hue (black only as a last resort).
  function risoInks(hash) {
    var used = {};
    return hash.layers.map(function (L) {
      var best = -1, bestD = Infinity;
      RISO_INKS.forEach(function (ink, i) {
        if (used[i]) return;
        var h = hueOfHex(ink.hex);
        var d = h < 0 ? 1000 : Math.min(Math.abs(h - L.hue), 360 - Math.abs(h - L.hue));
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      });
      used[best] = true;
      return { name: RISO_INKS[best].name, hex: RISO_INKS[best].hex };
    });
  }

  function risoSvg(hash, opts) {
    opts = opts || {};
    var size = opts.sizeMm || 200, s = size / 400, hidden = opts.hidden || [];
    var inks = opts.inks || risoInks(hash), offsets = opts.offsets || [[0, 0], [0, 0], [0, 0]];
    var out = svgOpen(size, "Risograph · " + (hash.name || "visual hash"), hash);
    out += layerOpen("paper", ' sodipodi:insensitive="true"');
    out += '<rect width="' + size + '" height="' + size + '" fill="#ffffff"/>\n</g>\n';
    hash.layers.forEach(function (L, li) {
      if (hidden[li]) return;
      var ink = inks[li], off = offsets[li] || [0, 0];
      out += layerOpen("ink " + (li + 1) + " " + ink.name, ' style="mix-blend-mode:multiply" transform="translate(' + n2(off[0]) + " " + n2(off[1]) + ')"');
      for (var t = 0; t < L.count; t++) {
        var p = [];
        for (var v = 0; v < 3; v++) {
          var i = L.index[t * 3 + v];
          p.push(n2(hash.cx[i] * s) + "," + n2(hash.cy[i] * s));
        }
        out += '<polygon points="' + p.join(" ") + '" fill="' + ink.hex + '" fill-opacity="' +
          (Math.round(Math.min(1, 55 / L.area[t]) * 1000) / 1000) + '"/>\n';
      }
      out += "</g>\n";
    });
    return out + "</svg>\n";
  }

  // ---------------------------------------------------------------- oscilloscope audio

  // x -> left, y -> right: an oscilloscope in XY mode draws the hash. The whole
  // curve is one period; its N-fold symmetry puts the strongest tone at `fundamental`.
  function scopePeriod(hash, sampleRate, fundamental) {
    sampleRate = sampleRate || 48000;
    fundamental = fundamental || 110;
    var len = Math.max(2, Math.round((sampleRate * hash.N) / fundamental));
    var left = new Float32Array(len), right = new Float32Array(len), peak = 1e-9, i;
    for (i = 0; i < len; i++) {
      var p = (i / len) * SIZE, a = Math.floor(p), f = p - a, b = (a + 1) % SIZE;
      left[i] = hash.x[a] + (hash.x[b] - hash.x[a]) * f;
      right[i] = -(hash.y[a] + (hash.y[b] - hash.y[a]) * f);
      peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
    }
    var g = 0.9 / peak;
    for (i = 0; i < len; i++) {
      left[i] *= g;
      right[i] *= g;
    }
    return { left: left, right: right, length: len };
  }

  function scopeWav(hash, opts) {
    opts = opts || {};
    var rate = opts.sampleRate || 48000, seconds = opts.seconds || 8;
    var per = scopePeriod(hash, rate, opts.fundamental || 110);
    var frames = Math.round(rate * seconds), bytes = frames * 4;
    var buf = new Uint8Array(44 + bytes), dv = new DataView(buf.buffer);
    var str = function (o, s) {
      for (var i = 0; i < s.length; i++) buf[o + i] = s.charCodeAt(i);
    };
    str(0, "RIFF");
    dv.setUint32(4, 36 + bytes, true);
    str(8, "WAVE");
    str(12, "fmt ");
    dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true); // PCM
    dv.setUint16(22, 2, true); // stereo
    dv.setUint32(24, rate, true);
    dv.setUint32(28, rate * 4, true);
    dv.setUint16(32, 4, true);
    dv.setUint16(34, 16, true);
    str(36, "data");
    dv.setUint32(40, bytes, true);
    for (var i = 0, o = 44; i < frames; i++, o += 4) {
      var k = i % per.length;
      dv.setInt16(o, Math.round(per.left[k] * 32767), true);
      dv.setInt16(o + 2, Math.round(per.right[k] * 32767), true);
    }
    return buf;
  }

  // ---------------------------------------------------------------- lithophane

  // Bright = thin, so light passing through shows the image. The solid is a
  // closed profile (rings of vertices) swept around the axis; consecutive rings
  // are stitched in one direction, which keeps it watertight and outward-facing.
  function lithophane(o) {
    o = o || {};
    var shape = o.shape === "dome" ? "dome" : "disc";
    var D = o.diameterMm || 100, R = D / 2;
    var tMin = o.tMin == null ? 0.8 : o.tMin, tMax = o.tMax == null ? 3.2 : o.tMax;
    var rings = Math.max(2, o.rings || 160), sectors = Math.max(8, o.sectors || 720);
    var wrap = o.wrap || 1, frameMm = o.frameMm == null ? 3 : o.frameMm;
    var tFrame = tMax + 0.4;
    var lum = o.lum || function () { return 0.5; };

    var pos = [], thick = [], profile = [];
    var cosT = new Float64Array(sectors), sinT = new Float64Array(sectors);
    for (var j = 0; j < sectors; j++) {
      cosT[j] = Math.cos((TAU * j) / sectors);
      sinT[j] = Math.sin((TAU * j) / sectors);
    }
    function vert(x, y, z, t) {
      pos.push(x, y, z);
      thick.push(t);
      return thick.length - 1;
    }
    function thickAt(u, v) {
      var l = +lum(u, v);
      if (!(l >= 0)) l = 0;
      if (l > 1) l = 1;
      return tMin + (tMax - tMin) * (1 - l);
    }
    // ring(fn): fn(cos, sin, j) -> [x, y, z, t]; point(): a single vertex on the axis
    function ring(fn) {
      var idx = [];
      for (var j = 0; j < sectors; j++) {
        var p = fn(cosT[j], sinT[j], j);
        idx.push(vert(p[0], p[1], p[2], p[3]));
      }
      profile.push(idx);
      return idx;
    }
    function point(x, y, z, t) {
      profile.push(vert(x, y, z, t));
    }

    var i;
    if (shape === "disc") {
      var Rimg = frameMm > 0 ? R - frameMm : R;
      var t0 = thickAt(0, 0);
      point(0, 0, t0, t0);
      for (i = 1; i <= rings; i++) {
        (function (rho) {
          ring(function (c, s) {
            var t = thickAt(rho * c, rho * s);
            return [rho * Rimg * c, rho * Rimg * s, t, t];
          });
        })(i / rings);
      }
      if (frameMm > 0) {
        ring(function (c, s) { return [Rimg * c, Rimg * s, tFrame, tFrame]; });
        ring(function (c, s) { return [R * c, R * s, tFrame, tFrame]; });
      }
      var tEdge = frameMm > 0 ? tFrame : null;
      ring(function (c, s) {
        return [R * c, R * s, 0, tEdge == null ? thickAt(c, s) : tEdge];
      });
      point(0, 0, 0, t0);
    } else {
      // Spherical cap by inverse stereographic projection (as the Sphere form),
      // pole up. A rim band of frameMm (measured along the outer surface) stays thick.
      var Rs = R;
      var dRho = frameMm > 0 ? Math.min(0.3, frameMm / ((Rs * 2 * wrap) / (1 + wrap * wrap))) : 0;
      var rhoB = 1 - dRho;
      var dir = function (rho, c, s) {
        var u = rho * wrap * c, v = rho * wrap * s, r2 = u * u + v * v, d = 1 + r2;
        return [(2 * u) / d, (2 * v) / d, (1 - r2) / d];
      };
      var shell = function (rho, c, s, rad, t) {
        var d = dir(rho, c, s);
        return [d[0] * rad, d[1] * rad, d[2] * rad, t];
      };
      var tPole = thickAt(0, 0);
      point(0, 0, Rs + tPole, tPole);
      var outer = [];
      for (i = 1; i <= rings; i++) {
        (function (rho) {
          outer.push(ring(function (c, s) {
            var t = thickAt((rho / rhoB) * c, (rho / rhoB) * s);
            return shell(rho, c, s, Rs + t, t);
          }));
        })((i / rings) * rhoB);
      }
      if (dRho > 0) {
        ring(function (c, s) { return shell(rhoB, c, s, Rs + tFrame, tFrame); });
        ring(function (c, s) { return shell(1, c, s, Rs + tFrame, tFrame); });
        ring(function (c, s) { return shell(1, c, s, Rs, tFrame); });
      }
      // Inner surface back to the pole; each vertex keeps its outer twin's thickness.
      for (i = rings; i >= 1; i--) {
        (function (rho, tw) {
          ring(function (c, s, j) {
            return shell(rho, c, s, Rs, thick[tw[j]]);
          });
        })((i / rings) * rhoB, outer[i - 1]);
      }
      point(0, 0, Rs, tPole);
    }

    // Stitch consecutive profile rings: (a_j, b_j, b_j+1) and (a_j, b_j+1, a_j+1).
    var idx = [];
    for (var p = 0; p + 1 < profile.length; p++) {
      var A = profile[p], B = profile[p + 1];
      for (j = 0; j < sectors; j++) {
        var j1 = (j + 1) % sectors;
        if (typeof A === "number") idx.push(A, B[j], B[j1]);
        else if (typeof B === "number") idx.push(A[j], B, A[j1]);
        else idx.push(A[j], B[j], B[j1], A[j], B[j1], A[j1]);
      }
    }

    var positions = new Float32Array(pos);
    var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (i = 0; i < positions.length; i += 3) {
      for (var k = 0; k < 3; k++) {
        if (positions[i + k] < lo[k]) lo[k] = positions[i + k];
        if (positions[i + k] > hi[k]) hi[k] = positions[i + k];
      }
    }
    return {
      shape: shape,
      positions: positions,
      indices: new Uint32Array(idx),
      thickness: new Float32Array(thick),
      triangles: idx.length / 3,
      sizeMm: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]],
    };
  }

  // ------------------------------------------------- visual cryptography

  // Floyd–Steinberg: luminance (W*W, 0..1, row by row) -> one bit per pixel, 1 = dark.
  function dither(lum, W) {
    var e = Float32Array.from(lum), out = new Uint8Array(W * W);
    for (var y = 0; y < W; y++) {
      for (var x = 0; x < W; x++) {
        var i = y * W + x, light = e[i] >= 0.5 ? 1 : 0, err = e[i] - light;
        out[i] = 1 - light;
        if (x + 1 < W) e[i + 1] += (err * 7) / 16;
        if (y + 1 < W) {
          if (x > 0) e[i + W - 1] += (err * 3) / 16;
          e[i + W] += (err * 5) / 16;
          if (x + 1 < W) e[i + W + 1] += err / 16;
        }
      }
    }
    return out;
  }

  // The six 2x2 subpixel patterns with exactly two dark cells (bits tl tr bl br).
  var VC_PATTERNS = [3, 5, 6, 9, 10, 12];

  // count uniform integers in [0, n) from fill(Uint8Array) (e.g. crypto.getRandomValues),
  // by rejection so that no value is more likely than another.
  function randomInts(count, n, fill) {
    var out = new Uint8Array(count), lim = 256 - (256 % n), k = 0;
    var buf = new Uint8Array(Math.min(65536, count + (count >> 2) + 64)), pos = buf.length;
    while (k < count) {
      if (pos === buf.length) {
        fill(buf);
        pos = 0;
      }
      var b = buf[pos++];
      if (b < lim) out[k++] = b % n;
    }
    return out;
  }

  // (2, 2) visual secret sharing of a 1-bit image (W*W, 1 = dark).
  // "or" (Naor–Shamir 1994): every pixel becomes 2x2 subpixels, two of them dark on
  //   each share. A light pixel gets the same pattern on both shares (stacked: 2 of 4
  //   dark), a dark pixel complementary patterns (stacked: 4 of 4). Film only adds
  //   ink, so this is the scheme for printed transparencies. Shares are 2W wide.
  // "xor": share B = share A xor image. No expansion and the image comes back exactly,
  //   but the stacking has to be digital.
  // Share A is made from the randomness alone, and share B alone is just as uniform:
  // one share says nothing about the image.
  function vcShares(secret, W, opts) {
    var fill = opts.fill, i;
    if (opts.scheme === "xor") {
      var a = randomInts(W * W, 2, fill), b = new Uint8Array(W * W);
      for (i = 0; i < W * W; i++) b[i] = a[i] ^ secret[i];
      return { scheme: "xor", width: W, a: a, b: b };
    }
    var S = 2 * W, A = new Uint8Array(S * S), B = new Uint8Array(S * S), r = randomInts(W * W, 6, fill);
    function put(arr, o, m) {
      arr[o] = (m >> 3) & 1;
      arr[o + 1] = (m >> 2) & 1;
      arr[o + S] = (m >> 1) & 1;
      arr[o + S + 1] = m & 1;
    }
    for (var y = 0; y < W; y++) {
      for (var x = 0; x < W; x++) {
        i = y * W + x;
        var pa = VC_PATTERNS[r[i]], o = 2 * y * S + 2 * x;
        put(A, o, pa);
        put(B, o, secret[i] ? 15 ^ pa : pa);
      }
    }
    return { scheme: "or", width: S, a: A, b: B };
  }

  // Lay share B on share A, shifted dx subpixels to the right (dx = 0: lined up).
  // Ink adds (OR) for "or"; "xor" combines digitally.
  function vcStack(shares, dx) {
    var S = shares.width, out = new Uint8Array(S * S), xor = shares.scheme === "xor";
    dx = dx | 0;
    for (var y = 0; y < S; y++) {
      for (var x = 0; x < S; x++) {
        var i = y * S + x, bx = x - dx, b = bx >= 0 && bx < S ? shares.b[y * S + bx] : 0;
        out[i] = xor ? shares.a[i] ^ b : shares.a[i] | b;
      }
    }
    return out;
  }

  // One share as a printable SVG (S*S bits, 1 = ink): dark subpixels as row runs, plus
  // registration marks outside the image to line the two transparencies up.
  // opts.labelAt (0..1) places the label along the bottom edge, so the labels of
  // two stacked shares do not print over each other. The SVG carries only the label (a pair id), never the name: that would give the
  // image away.
  function vcSvg(bits, S, opts) {
    opts = opts || {};
    var size = opts.sizeMm || 120, unit = size / S, m = Math.ceil(14 / unit), T = S + 2 * m;
    var d = [];
    for (var y = 0; y < S; y++) {
      for (var x = 0; x < S; ) {
        if (!bits[y * S + x]) {
          x++;
          continue;
        }
        var x0 = x;
        while (x < S && bits[y * S + x]) x++;
        d.push("M" + (x0 + m) + " " + (y + m) + "h" + (x - x0) + "v1h-" + (x - x0) + "z");
      }
    }
    var mark = function (cx, cy) {
      var r = 4 / unit, w = (0.25 / unit).toFixed(3);
      return (
        '<circle cx="' + cx + '" cy="' + cy + '" r="' + (r * 0.6).toFixed(2) + '" fill="none" stroke="#000" stroke-width="' + w + '"/>' +
        '<path d="M' + (cx - r).toFixed(2) + " " + cy + "H" + (cx + r).toFixed(2) + "M" + cx + " " + (cy - r).toFixed(2) + "V" + (cy + r).toFixed(2) +
        '" stroke="#000" stroke-width="' + w + '"/>'
      );
    };
    var c = m / 2, label = String(opts.label || "").replace(/[<&>"]/g, "");
    return (
      '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<svg xmlns="http://www.w3.org/2000/svg" width="' + (T * unit).toFixed(2) + 'mm" height="' + (T * unit).toFixed(2) + 'mm" viewBox="0 0 ' + T + " " + T + '">\n' +
      "<title>" + label + "</title>\n" +
      mark(c, c) + mark(T - c, c) + mark(c, T - c) + mark(T - c, T - c) + "\n" +
      '<text x="' + (T * (opts.labelAt == null ? 0.5 : opts.labelAt)).toFixed(2) + '" y="' + (T - c + 1.2 / unit).toFixed(2) + '" font-family="sans-serif" font-size="' + (3 / unit).toFixed(2) + '" text-anchor="middle">' + label + "</text>\n" +
      '<path shape-rendering="crispEdges" fill="#000" d="' + d.join("") + '"/>\n' +
      "</svg>\n"
    );
  }

  var api = {
    hamming: hamming,
    flipBit: flipBit,
    crossover: crossover,
    childMasks: childMasks,
    nailOptions: nailOptions,
    stringArt: stringArt,
    stringArtSvg: stringArtSvg,
    stringArtText: stringArtText,
    plotterSvg: plotterSvg,
    RISO_INKS: RISO_INKS,
    risoInks: risoInks,
    risoSvg: risoSvg,
    scopePeriod: scopePeriod,
    scopeWav: scopeWav,
    lithophane: lithophane,
    layerHex: layerHex,
    dither: dither,
    randomInts: randomInts,
    vcShares: vcShares,
    vcStack: vcStack,
    vcSvg: vcSvg,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.VHArt = api;
})(this);
