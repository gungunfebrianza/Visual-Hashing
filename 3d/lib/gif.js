/*
 * Tiny animated GIF89a encoder (no dependencies).
 *
 *   VHGif.encode(frames, { delay: 5, loop: 0, dither: true }) -> Uint8Array
 *   VHGif.encodeAsync(frames, opts, onProgress(done, total)) -> Promise<Uint8Array>
 *
 * frames: [{ width, height, data: Uint8ClampedArray RGBA }], all the same size.
 * One global 256-colour palette is built by median cut over pixels sampled from
 * every frame. Index 0 is reserved for pure black, so the dark background of a
 * visual hash stays exactly black and compresses well. Pixels are mapped with a
 * 15-bit (5:5:5) lookup cache and an optional mild 4x4 Bayer dither.
 *
 * Plain script (no modules) so the page also works when opened from file://.
 */
(function (root) {
  "use strict";

  var MAX_SAMPLES = 240000;
  var BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

  // ---------------------------------------------------------------- byte buffer

  function ByteWriter() {
    this.buf = new Uint8Array(1 << 16);
    this.len = 0;
  }
  ByteWriter.prototype.ensure = function (n) {
    if (this.len + n <= this.buf.length) return;
    var size = this.buf.length * 2;
    while (size < this.len + n) size *= 2;
    var next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  };
  ByteWriter.prototype.byte = function (b) {
    this.ensure(1);
    this.buf[this.len++] = b;
  };
  ByteWriter.prototype.word = function (w) {
    this.ensure(2);
    this.buf[this.len++] = w & 255;
    this.buf[this.len++] = (w >> 8) & 255;
  };
  ByteWriter.prototype.bytes = function (arr) {
    this.ensure(arr.length);
    for (var i = 0; i < arr.length; i++) this.buf[this.len++] = arr[i];
  };
  ByteWriter.prototype.ascii = function (s) {
    for (var i = 0; i < s.length; i++) this.byte(s.charCodeAt(i));
  };
  ByteWriter.prototype.result = function () {
    return this.buf.slice(0, this.len);
  };

  // ---------------------------------------------------------------- palette

  // Median cut over sampled non-black pixels. Returns a flat [r,g,b]*256 array
  // whose entry 0 is pure black.
  function buildPalette(frames) {
    var w = frames[0].width, h = frames[0].height;
    var total = w * h * frames.length;
    var stride = Math.max(1, Math.floor(total / MAX_SAMPLES));
    var samples = [];
    var n = 0;
    var cap = Math.ceil(total / stride) * 3;
    var px = new Uint8Array(cap);
    for (var f = 0; f < frames.length; f++) {
      var d = frames[f].data;
      // Offset each frame so the sampling grid does not alias with the image.
      for (var p = f % stride; p < w * h; p += stride) {
        var o = p * 4, r = d[o], g = d[o + 1], b = d[o + 2];
        if (!(r | g | b)) continue;
        px[n * 3] = r;
        px[n * 3 + 1] = g;
        px[n * 3 + 2] = b;
        n++;
      }
    }
    samples = px.subarray(0, n * 3);

    var palette = new Uint8Array(768); // index 0 stays black
    if (!n) return palette;

    var idx = new Uint32Array(n);
    for (var i = 0; i < n; i++) idx[i] = i;
    var boxes = [makeBox(samples, idx, 0, n)];
    var target = 255;
    while (boxes.length < target) {
      var best = -1, bestScore = 0;
      for (var k = 0; k < boxes.length; k++) {
        var bx = boxes[k];
        if (bx.end - bx.start < 2 || bx.range === 0) continue;
        var score = bx.range * Math.sqrt(bx.end - bx.start);
        if (score > bestScore) {
          bestScore = score;
          best = k;
        }
      }
      if (best < 0) break;
      var split = splitBox(samples, idx, boxes[best]);
      if (!split) break;
      boxes.splice(best, 1, split[0], split[1]);
    }

    for (var j = 0; j < boxes.length; j++) {
      var B = boxes[j], sr = 0, sg = 0, sb = 0;
      for (var s = B.start; s < B.end; s++) {
        var q = idx[s] * 3;
        sr += samples[q];
        sg += samples[q + 1];
        sb += samples[q + 2];
      }
      var c = B.end - B.start;
      palette[(j + 1) * 3] = Math.round(sr / c);
      palette[(j + 1) * 3 + 1] = Math.round(sg / c);
      palette[(j + 1) * 3 + 2] = Math.round(sb / c);
    }
    // Unused slots repeat black; harmless.
    return palette;
  }

  function makeBox(samples, idx, start, end) {
    var lo = [255, 255, 255], hi = [0, 0, 0];
    for (var i = start; i < end; i++) {
      var q = idx[i] * 3;
      for (var c = 0; c < 3; c++) {
        var v = samples[q + c];
        if (v < lo[c]) lo[c] = v;
        if (v > hi[c]) hi[c] = v;
      }
    }
    var axis = 0, range = hi[0] - lo[0];
    if (hi[1] - lo[1] > range) { axis = 1; range = hi[1] - lo[1]; }
    if (hi[2] - lo[2] > range) { axis = 2; range = hi[2] - lo[2]; }
    return { start: start, end: end, axis: axis, range: range };
  }

  // Counting sort along the box's longest axis, then cut at the median.
  function splitBox(samples, idx, box) {
    var axis = box.axis, start = box.start, end = box.end;
    var counts = new Uint32Array(257);
    var i;
    for (i = start; i < end; i++) counts[samples[idx[i] * 3 + axis] + 1]++;
    for (i = 1; i < 257; i++) counts[i] += counts[i - 1];
    var tmp = new Uint32Array(end - start);
    for (i = start; i < end; i++) {
      var v = samples[idx[i] * 3 + axis];
      tmp[counts[v]++] = idx[i];
    }
    idx.set(tmp, start);
    var mid = start + ((end - start) >> 1);
    // Move the cut off a run of equal values so both halves differ.
    var mv = samples[idx[mid] * 3 + axis];
    var a = mid, b = mid;
    while (a > start && samples[idx[a - 1] * 3 + axis] === mv) a--;
    while (b < end && samples[idx[b] * 3 + axis] === mv) b++;
    mid = a - start >= end - b ? a : b;
    if (mid <= start || mid >= end) return null;
    return [makeBox(samples, idx, start, mid), makeBox(samples, idx, mid, end)];
  }

  // ---------------------------------------------------------------- mapping

  function makeMapper(palette, dither) {
    var cache = new Int16Array(32768).fill(-1);
    var pr = [], pg = [], pb = [];
    for (var i = 0; i < 256; i++) {
      pr[i] = palette[i * 3];
      pg[i] = palette[i * 3 + 1];
      pb[i] = palette[i * 3 + 2];
    }
    function nearest(key) {
      var r5 = key >> 10, g5 = (key >> 5) & 31, b5 = key & 31;
      // Expand 5 bits back to 8 so bucket 0 is exactly black.
      var r = (r5 << 3) | (r5 >> 2), g = (g5 << 3) | (g5 >> 2), b = (b5 << 3) | (b5 >> 2);
      var best = 0, bestD = 1e9;
      for (var i = 0; i < 256; i++) {
        var dr = pr[i] - r, dg = pg[i] - g, db = pb[i] - b;
        var dd = dr * dr * 2 + dg * dg * 4 + db * db * 3;
        if (dd < bestD) {
          bestD = dd;
          best = i;
          if (!dd) break;
        }
      }
      cache[key] = best;
      return best;
    }
    // Mild dither: about +/-4 levels, so pure black stays in bucket 0.
    var strength = dither ? 8 : 0;
    return function (frame, out) {
      var d = frame.data, w = frame.width, h = frame.height;
      for (var y = 0, p = 0; y < h; y++) {
        var row = (y & 3) << 2;
        for (var x = 0; x < w; x++, p++) {
          var o = p * 4, r = d[o], g = d[o + 1], b = d[o + 2];
          if (strength && (r | g | b)) {
            var t = (BAYER[row | (x & 3)] / 16 - 0.5) * strength;
            r = clamp(r + t);
            g = clamp(g + t);
            b = clamp(b + t);
          }
          var key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
          var c = cache[key];
          out[p] = c >= 0 ? c : nearest(key);
        }
      }
    };
  }

  function clamp(v) {
    return v < 0 ? 0 : v > 255 ? 255 : v | 0;
  }

  // ---------------------------------------------------------------- LZW

  // Shared tables: key (prefix << 8 | byte) -> code, valid only when the stamp
  // matches the current generation, so a clear code costs nothing.
  var lzwStamp = null, lzwCode = null, lzwGen = 0;

  function lzwEncode(pixels, out) {
    var MIN = 8, CLEAR = 256, EOI = 257;
    if (!lzwStamp) {
      lzwStamp = new Int32Array(1 << 20);
      lzwCode = new Uint16Array(1 << 20);
    }
    out.byte(MIN);

    var block = new Uint8Array(255), blen = 0;
    var acc = 0, nbits = 0;
    function emit(code, size) {
      acc |= code << nbits;
      nbits += size;
      while (nbits >= 8) {
        block[blen++] = acc & 255;
        if (blen === 255) {
          out.byte(255);
          out.bytes(block);
          blen = 0;
        }
        acc >>>= 8;
        nbits -= 8;
      }
    }

    var size = MIN + 1, next = EOI + 1;
    var gen = ++lzwGen;
    emit(CLEAR, size);
    var prefix = pixels[0];
    for (var i = 1; i < pixels.length; i++) {
      var k = pixels[i];
      var key = (prefix << 8) | k;
      if (lzwStamp[key] === gen) {
        prefix = lzwCode[key];
        continue;
      }
      emit(prefix, size);
      if (next < 4096) {
        lzwStamp[key] = gen;
        lzwCode[key] = next;
        if (next === 1 << size) size++;
        next++;
      } else {
        emit(CLEAR, size);
        gen = ++lzwGen;
        size = MIN + 1;
        next = EOI + 1;
      }
      prefix = k;
    }
    emit(prefix, size);
    emit(EOI, size);
    if (nbits > 0) emit(0, 8 - nbits);
    if (blen) {
      out.byte(blen);
      out.bytes(block.subarray(0, blen));
    }
    out.byte(0);
  }

  // ---------------------------------------------------------------- container

  function header(out, w, h, palette, loop) {
    out.ascii("GIF89a");
    out.word(w);
    out.word(h);
    out.byte(0xf7); // global colour table, 8 bits per channel, 256 entries
    out.byte(0); // background colour index (black)
    out.byte(0);
    out.bytes(palette);
    if (loop != null && loop >= 0) {
      out.bytes([0x21, 0xff, 0x0b]);
      out.ascii("NETSCAPE2.0");
      out.bytes([0x03, 0x01]);
      out.word(loop);
      out.byte(0);
    }
  }

  function frameBlock(out, w, h, indices, delay) {
    out.bytes([0x21, 0xf9, 0x04, 0x04]); // graphic control, disposal: do not dispose
    out.word(delay);
    out.bytes([0, 0]);
    out.byte(0x2c);
    out.word(0);
    out.word(0);
    out.word(w);
    out.word(h);
    out.byte(0); // no local colour table, not interlaced
    lzwEncode(indices, out);
  }

  function prepare(frames, opts) {
    if (!frames || !frames.length) throw new Error("VHGif: no frames");
    opts = opts || {};
    var w = frames[0].width, h = frames[0].height;
    for (var i = 1; i < frames.length; i++)
      if (frames[i].width !== w || frames[i].height !== h) throw new Error("VHGif: frames differ in size");
    var palette = buildPalette(frames);
    var out = new ByteWriter();
    header(out, w, h, palette, opts.loop == null ? 0 : opts.loop);
    return {
      w: w,
      h: h,
      out: out,
      delay: opts.delay == null ? 5 : Math.max(0, Math.round(opts.delay)),
      map: makeMapper(palette, opts.dither !== false),
      indices: new Uint8Array(w * h),
    };
  }

  function encode(frames, opts) {
    var job = prepare(frames, opts);
    for (var i = 0; i < frames.length; i++) {
      job.map(frames[i], job.indices);
      frameBlock(job.out, job.w, job.h, job.indices, job.delay);
    }
    job.out.byte(0x3b);
    return job.out.result();
  }

  function encodeAsync(frames, opts, onProgress) {
    return new Promise(function (resolve, reject) {
      var job, i = 0;
      try {
        job = prepare(frames, opts);
      } catch (err) {
        return reject(err);
      }
      function step() {
        try {
          job.map(frames[i], job.indices);
          frameBlock(job.out, job.w, job.h, job.indices, job.delay);
          i++;
          if (onProgress) onProgress(i, frames.length);
          if (i < frames.length) return setTimeout(step, 0);
          job.out.byte(0x3b);
          resolve(job.out.result());
        } catch (err) {
          reject(err);
        }
      }
      setTimeout(step, 0);
    });
  }

  var api = { encode: encode, encodeAsync: encodeAsync, buildPalette: buildPalette };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.VHGif = api;
})(this);
