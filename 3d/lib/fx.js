/*
 * Visual Hashing 3D — art styles and screen effects.
 *
 * Every style is an isomorphism: a structure that already exists in the hash,
 * drawn in the visual language of another medium that has the same structure.
 *
 *   glow        the original: additive light, alpha × area = constant
 *   scope       oscilloscope: beam brightness ∝ 1/speed, the same rule as alpha ∝ 1/area
 *   caustic     water caustics: light per triangle is fixed, so a ripple that
 *               stretches a triangle dims it and one that squeezes it brightens it
 *   exposure    long exposure: additive light = photons collected, grain = shot noise
 *   spectrum    dispersion: each layer is a wavelength, bluer layers bend more
 *   aurora      emitting curtains rising from the curve
 *   glass       stained glass: additive light on black ≅ absorbing glass on white
 *   riso        risograph: 3 layers = 3 ink drums, misregistered, grainy
 *   plotter     pen plotter: the curve in drawing order, chords as pen strokes
 *   string      string art: chords i → i+s are threads between nails
 *   ascii       the image typed with the characters of the name itself
 *
 * Plus the screen lenses (kaleidoscope wedge / mirror), the difference pass for
 * compare, the epicycle machine overlay and the domemaster capture.
 *
 * Plain script: VHFx.create(ctx) is called by app.js once three.js is loaded.
 */
(function (root) {
  "use strict";

  function create(ctx) {
    const THREE = ctx.THREE;
    const SIZE = ctx.SIZE;
    const TAU = Math.PI * 2;
    const opts = ctx.opts;
    const reduceMotion = ctx.reduceMotion;

    // ------------------------------------------------------------ full-screen passes

    const VS = "varying vec2 vUv;\nvoid main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }";
    const quadGeo = new THREE.PlaneGeometry(2, 2);
    const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    // Minimal EffectComposer pass (the vendor bundle has no ShaderPass).
    function Pass(fragmentShader, uniforms) {
      this.enabled = true;
      this.needsSwap = true;
      this.clear = false;
      this.renderToScreen = false;
      this.uniforms = Object.assign(
        { tDiffuse: { value: null }, uRes: { value: new THREE.Vector2(1, 1) } },
        uniforms || {}
      );
      this.material = new THREE.ShaderMaterial({
        uniforms: this.uniforms,
        vertexShader: VS,
        fragmentShader: fragmentShader,
        depthTest: false,
        depthWrite: false,
      });
      this.quad = new THREE.Mesh(quadGeo, this.material);
      this.quad.frustumCulled = false;
      this.scene = new THREE.Scene();
      this.scene.add(this.quad);
    }
    Pass.prototype.setSize = function (w, h) {
      this.uniforms.uRes.value.set(w, h);
    };
    Pass.prototype.render = function (renderer, writeBuffer, readBuffer) {
      this.uniforms.tDiffuse.value = readBuffer.texture;
      renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
      renderer.render(this.scene, quadCam);
    };
    Pass.prototype.dispose = function () {
      this.material.dispose();
    };

    const NOISE = [
      "float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }",
      "float vnoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);",
      "  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), f.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), f.x), f.y); }",
      "float fbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { s += a * vnoise(p); p *= 2.03; a *= 0.5; } return s; }",
    ].join("\n");

    // ------------------------------------------------------------ fat lines
    //
    // Screen-space ribbons, a constant width in pixels (WebGL lines are 1 px).
    // Segments are stored as start/end pairs; colours are per vertex (rgba).

    const FAT_VS = [
      "attribute vec3 aB; attribute float aT; attribute float aSide; attribute vec4 aCol;",
      "uniform vec2 uRes; uniform float uWidth;",
      "varying vec4 vCol; varying float vSide;",
      "void main() {",
      "  vec4 ca = projectionMatrix * modelViewMatrix * vec4(position, 1.0);",
      "  vec4 cb = projectionMatrix * modelViewMatrix * vec4(aB, 1.0);",
      "  vec2 d = (cb.xy / cb.w - ca.xy / ca.w) * uRes;",
      "  float l = length(d);",
      "  d = l > 1e-5 ? d / l : vec2(1.0, 0.0);",
      "  vec4 c = mix(ca, cb, aT);",
      "  c.xy += vec2(-d.y, d.x) * aSide * uWidth / uRes * c.w;",
      "  gl_Position = c;",
      "  vCol = aCol; vSide = aSide;",
      "}",
    ].join("\n");
    const FAT_FS = [
      "uniform float uOpacity; uniform float uPaper;",
      "varying vec4 vCol; varying float vSide;",
      "void main() {",
      "  float a = vCol.a * uOpacity * (1.0 - smoothstep(0.55, 1.0, abs(vSide)));",
      "  gl_FragColor = uPaper > 0.5 ? vec4(a * (1.0 - vCol.rgb), 1.0) : vec4(vCol.rgb, a);",
      "}",
    ].join("\n");

    const resUniform = { value: new THREE.Vector2(1, 1) };
    const pxRatio = { value: 1 };

    function setBlend(mat, kind) {
      if (kind === "paper") {
        // Multiply the paper by the light the ink lets through: dst *= 1 - a(1 - c).
        mat.blending = THREE.CustomBlending;
        mat.blendEquation = THREE.AddEquation;
        mat.blendSrc = THREE.ZeroFactor;
        mat.blendDst = THREE.OneMinusSrcColorFactor;
      } else if (kind === "add") {
        mat.blending = THREE.AdditiveBlending;
      } else {
        mat.blending = THREE.NormalBlending;
      }
      mat.needsUpdate = true;
    }

    function FatLines(maxSegs, blend, width) {
      const nV = maxSegs * 4;
      this.max = maxSegs;
      this.count = 0;
      this.a = new Float32Array(nV * 3);
      this.b = new Float32Array(nV * 3);
      this.col = new Float32Array(nV * 4);
      const t = new Float32Array(nV), side = new Float32Array(nV);
      const index = new Uint32Array(maxSegs * 6);
      for (let s = 0; s < maxSegs; s++) {
        const v = s * 4;
        t[v] = 0; side[v] = -1;
        t[v + 1] = 0; side[v + 1] = 1;
        t[v + 2] = 1; side[v + 2] = -1;
        t[v + 3] = 1; side[v + 3] = 1;
        index.set([v, v + 2, v + 1, v + 1, v + 2, v + 3], s * 6);
      }
      const geo = (this.geo = new THREE.BufferGeometry());
      geo.setAttribute("position", new THREE.BufferAttribute(this.a, 3).setUsage(THREE.DynamicDrawUsage));
      geo.setAttribute("aB", new THREE.BufferAttribute(this.b, 3).setUsage(THREE.DynamicDrawUsage));
      geo.setAttribute("aCol", new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage));
      geo.setAttribute("aT", new THREE.BufferAttribute(t, 1));
      geo.setAttribute("aSide", new THREE.BufferAttribute(side, 1));
      geo.setIndex(new THREE.BufferAttribute(index, 1));
      this.width = { value: width || 1.5 };
      this.material = new THREE.ShaderMaterial({
        uniforms: { uRes: resUniform, uWidth: this.width, uOpacity: { value: 1 }, uPaper: { value: 0 } },
        vertexShader: FAT_VS,
        fragmentShader: FAT_FS,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      this.setBlend(blend || "add");
      this.mesh = new THREE.Mesh(geo, this.material);
      this.mesh.frustumCulled = false;
      this.mesh.renderOrder = 5;
    }
    FatLines.prototype.setBlend = function (kind) {
      setBlend(this.material, kind);
      this.material.uniforms.uPaper.value = kind === "paper" ? 1 : 0;
    };
    // Segment s from (ax,ay,az) to (bx,by,bz), colour rgba at both ends.
    FatLines.prototype.set = function (s, ax, ay, az, bx, by, bz, r, g, b, al, r2, g2, b2, al2) {
      const A = this.a, B = this.b, C = this.col;
      for (let k = 0; k < 4; k++) {
        const v = s * 4 + k, o = v * 3, c = v * 4, end = k >= 2;
        A[o] = ax; A[o + 1] = ay; A[o + 2] = az;
        B[o] = bx; B[o + 1] = by; B[o + 2] = bz;
        if (end && r2 !== undefined) {
          C[c] = r2; C[c + 1] = g2; C[c + 2] = b2; C[c + 3] = al2;
        } else {
          C[c] = r; C[c + 1] = g; C[c + 2] = b; C[c + 3] = al;
        }
      }
    };
    FatLines.prototype.alpha = function (s, a0, a1) {
      const C = this.col;
      for (let k = 0; k < 4; k++) C[(s * 4 + k) * 4 + 3] = k >= 2 && a1 !== undefined ? a1 : a0;
    };
    FatLines.prototype.commit = function (count, colorsOnly) {
      if (count !== undefined) this.count = count;
      this.geo.setDrawRange(0, this.count * 6);
      const at = this.geo.attributes;
      at.aCol.needsUpdate = true;
      if (!colorsOnly) {
        at.position.needsUpdate = true;
        at.aB.needsUpdate = true;
      }
    };
    FatLines.prototype.show = function (n) {
      this.geo.setDrawRange(0, Math.max(0, Math.min(this.count, n)) * 6);
    };
    FatLines.prototype.dispose = function () {
      this.geo.dispose();
      this.material.dispose();
    };

    // ------------------------------------------------------------ helpers

    function hsl(h, s, l) {
      return ctx.VH.hslToRgb(h, s, l);
    }

    // Small deterministic generator from the seed words, for per-hash randomness
    // (wave directions, misregistration) that stays the same on every reload.
    function seededRand(hash) {
      let x = parseInt(hash.seed[0], 16) ^ parseInt(hash.seed[2], 16) ^ 0x9e3779b9;
      if (!x) x = 1;
      return function () {
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        return (x >>> 0) / 4294967296;
      };
    }

    // Hue → position in the spectrum: 0 red … 1 violet (magenta folds back to red).
    function wavelengthRank(hue) {
      const h = ((hue % 360) + 360) % 360;
      return h <= 270 ? h / 270 : (360 - h) / 90 * 0.15;
    }

    const PAPER = new THREE.Color(0.955, 0.94, 0.9);
    const BLACK = new THREE.Color(0, 0, 0);

    // ------------------------------------------------------------ styles

    const styles = {};
    const order = [];
    function def(id, label, s) {
      order.push(id);
      styles[id] = Object.assign(
        {
          id: id,
          label: label,
          paper: false, // subtractive inks on a light background
          bg: BLACK,
          hideTriangles: false,
          triGain: 1,
          bloom: 1,
          inkMix: 0,
          ink: null, // (layer index, hash) -> rgb
          layerTransform: null, // (layer index, pivot, hash) -> void
          modifyPoints: null, // (P3, time) -> void
          pass: null,
          animated: false, // needs frames while shown
          enter: function () {},
          exit: function () {},
          update: function () { return false; },
          onHash: function () {},
          onPoints: function () {},
        },
        s
      );
    }

    def("glow", "Glow (original)", {});

    // ---- oscilloscope: dwell time = 1/speed, the same law as alpha = 55/area
    const scope = { lines: null, bright: new Float32Array(SIZE), head: 0, P3: null };
    def("scope", "Oscilloscope", {
      hideTriangles: true,
      bloom: 1.5,
      pass: new Pass(
        [
          "uniform sampler2D tDiffuse; uniform vec2 uRes; uniform vec2 uCenter; uniform float uPx;",
          "varying vec2 vUv;",
          "void main() {",
          "  vec3 c = texture2D(tDiffuse, vUv).rgb;",
          "  vec2 p = gl_FragCoord.xy - uCenter;",
          "  float div = uRes.y / 8.0;",
          "  vec2 g = abs(fract(p / div + 0.5) - 0.5) * div;",
          "  float grid = (1.0 - smoothstep(0.0, uPx, min(g.x, g.y))) * 0.07;",
          "  vec2 t = abs(fract(p / (div / 5.0) + 0.5) - 0.5) * div / 5.0;",
          "  float ticks = (1.0 - smoothstep(0.0, uPx, min(t.x, t.y))) * step(min(abs(p.x), abs(p.y)), 4.0 * uPx) * 0.12;",
          "  float vig = 1.0 - 0.45 * dot(vUv - 0.5, vUv - 0.5) * 2.0;",
          "  vec3 glass = vec3(0.01, 0.03, 0.025) * vig;",
          "  gl_FragColor = vec4(c + glass + vec3(0.25, 0.9, 0.45) * (grid + ticks), 1.0);",
          "}",
        ].join("\n"),
        { uCenter: { value: new THREE.Vector2() }, uPx: { value: 1 } }
      ),
      enter: function (env) {
        if (!scope.lines) scope.lines = new FatLines(SIZE, "add", 2);
        env.mainRoot.add(scope.lines.mesh);
        scope.head = 0;
      },
      exit: function (env) {
        if (scope.lines) env.mainRoot.remove(scope.lines.mesh);
      },
      onPoints: function (P3) {
        scope.P3 = P3;
        // Brightness per segment: inverse of its length (beam speed), median-normalised.
        const len = new Float32Array(SIZE);
        for (let i = 0; i < SIZE; i++) {
          const a = i * 3, b = ((i + 1) % SIZE) * 3;
          len[i] = Math.hypot(P3[b] - P3[a], P3[b + 1] - P3[a + 1], P3[b + 2] - P3[a + 2]);
        }
        const sorted = Float32Array.from(len).sort();
        const med = sorted[SIZE >> 1] || 1e-3;
        for (let i = 0; i < SIZE; i++) scope.bright[i] = Math.min(4, (0.55 * med) / Math.max(len[i], 1e-6));
        const L = scope.lines;
        for (let i = 0; i < SIZE; i++) {
          const a = i * 3, b = ((i + 1) % SIZE) * 3;
          L.set(i, P3[a], P3[a + 1], P3[a + 2], P3[b], P3[b + 1], P3[b + 2], 0.25, 1, 0.45, 1);
        }
        L.commit(SIZE);
        this.paint();
      },
      paint: function () {
        const L = scope.lines, persist = reduceMotion ? 1 : opts.persist;
        const full = persist >= 0.99, span = Math.max(20, persist * SIZE), head = scope.head;
        const gain = 0.8 * opts.exposure;
        for (let i = 0; i < SIZE; i++) {
          let trail = 1;
          if (!full) {
            const back = (head - i + SIZE) % SIZE;
            trail = Math.exp(-back / span);
          }
          L.alpha(i, Math.min(1, scope.bright[i] * trail * gain));
        }
        L.commit(undefined, true);
      },
      update: function (env) {
        const u = this.pass.uniforms;
        u.uCenter.value.copy(env.center);
        u.uPx.value = pxRatio.value * 1.2;
        if (!scope.P3) return false;
        const moving = !reduceMotion && opts.persist < 0.99;
        if (env.head < 1) scope.head = Math.floor(env.head * SIZE);
        else if (moving) scope.head = (scope.head + Math.round((env.dt * SIZE) / 2.4)) % SIZE;
        this.paint();
        if (env.head < 1) scope.lines.show(Math.floor(env.head * SIZE));
        else scope.lines.show(SIZE);
        return moving;
      },
    });

    // ---- caustics: refraction through a rippling surface moves the points; the
    // shader already divides each triangle's fixed light by its area, so the
    // light focuses and spreads exactly like flux through a lens.
    const caustic = { waves: [], time: 0 };
    def("caustic", "Caustics", {
      bg: new THREE.Color(0.0, 0.03, 0.05),
      inkMix: 0.3,
      ink: function () {
        return [0.08, 0.42, 0.5];
      },
      triGain: 0.6,
      bloom: 0.8,
      animated: true,
      onHash: function (hash) {
        const rnd = seededRand(hash);
        caustic.waves = [];
        for (let j = 0; j < 6; j++) {
          const k = 2.2 + rnd() * 5.5;
          const th = rnd() * TAU;
          caustic.waves.push({
            kx: Math.cos(th) * k,
            ky: Math.sin(th) * k,
            // Deep-water dispersion ω = √(g k): long waves travel faster.
            w: Math.sqrt(9.8 * k) * 0.32,
            a: 0.022 / Math.pow(k / 2.2, 1.4),
            p: rnd() * TAU,
          });
        }
      },
      modifyPoints: function (P3) {
        const W = caustic.waves, t = caustic.time, amp = opts.ripple;
        if (!amp || !W.length) return;
        for (let o = 0; o < P3.length; o += 3) {
          const x = P3[o], y = P3[o + 1];
          let gx = 0, gy = 0;
          for (let j = 0; j < W.length; j++) {
            const w = W[j], c = Math.cos(w.kx * x + w.ky * y - w.w * t + w.p) * w.a;
            gx += w.kx * c;
            gy += w.ky * c;
          }
          // Small-angle refraction: the ray bends against the surface slope.
          P3[o] = x - gx * amp;
          P3[o + 1] = y - gy * amp;
        }
      },
      update: function (env) {
        if (reduceMotion) return false;
        caustic.time += env.dt;
        env.markDirty();
        return true;
      },
    });

    // ---- long exposure: light arrives as photons. Each pixel holds λ = c·frac·P
    // photons, Poisson-distributed; shown as c·frac + √(c·frac/P)·noise.
    const expo = { t: 0, dur: 4.5 };
    def("exposure", "Long exposure", {
      bloom: 0.8,
      pass: new Pass(
        [
          "uniform sampler2D tDiffuse; uniform float uFrac; uniform float uPhotons; uniform float uSeed;",
          "varying vec2 vUv;",
          "float h(vec2 p, float s) { vec3 p3 = fract(vec3(p.xyx) * 0.1031 + s); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }",
          "void main() {",
          "  vec3 c = texture2D(tDiffuse, vUv).rgb;",
          "  vec2 p = gl_FragCoord.xy;",
          "  float u1 = max(h(p, uSeed), 1e-4), u2 = h(p, uSeed + 0.37), u3 = max(h(p, uSeed + 0.61), 1e-4), u4 = h(p, uSeed + 0.83);",
          "  float r1 = sqrt(-2.0 * log(u1)), r2 = sqrt(-2.0 * log(u3));",
          "  vec3 g = vec3(r1 * cos(6.2831853 * u2), r1 * sin(6.2831853 * u2), r2 * cos(6.2831853 * u4));",
          "  vec3 lam = c * uFrac;",
          "  gl_FragColor = vec4(max(lam + sqrt(lam / uPhotons) * g, 0.0), 1.0);",
          "}",
        ].join("\n"),
        { uFrac: { value: 1 }, uPhotons: { value: 300 }, uSeed: { value: 0 } }
      ),
      restart: function () {
        expo.t = reduceMotion ? expo.dur : 0;
      },
      onHash: function () {
        this.restart();
      },
      enter: function () {
        this.restart();
      },
      update: function (env) {
        expo.t = Math.min(expo.dur, expo.t + env.dt);
        const f = expo.t / expo.dur;
        const u = this.pass.uniforms;
        u.uFrac.value = 0.04 + 0.96 * f;
        u.uPhotons.value = Math.pow(10, opts.shutter);
        if (f < 1) u.uSeed.value = Math.random() * 10;
        return f < 1;
      },
    });

    // ---- dispersion: wavelength rank → radial scale, plus a chromatic split
    def("spectrum", "Spectrum", {
      bloom: 1.1,
      layerTransform: function (i, pivot, hash) {
        const k = wavelengthRank(hash.layers[i].hue);
        pivot.scale.set(1 + opts.dispersion * 0.07 * k, 1 + opts.dispersion * 0.07 * k, 1);
      },
      pass: new Pass(
        [
          "uniform sampler2D tDiffuse; uniform vec2 uRes; uniform vec2 uCenter; uniform float uK;",
          "varying vec2 vUv;",
          "void main() {",
          "  vec2 off = (gl_FragCoord.xy - uCenter) / uRes * uK;",
          "  float r = texture2D(tDiffuse, vUv - off).r;",
          "  float g = texture2D(tDiffuse, vUv).g;",
          "  float b = texture2D(tDiffuse, vUv + off).b;",
          "  gl_FragColor = vec4(r, g, b, 1.0);",
          "}",
        ].join("\n"),
        { uCenter: { value: new THREE.Vector2() }, uK: { value: 0 } }
      ),
      update: function (env) {
        this.pass.uniforms.uCenter.value.copy(env.center);
        this.pass.uniforms.uK.value = opts.dispersion * 0.035;
        return false;
      },
    });

    // ---- aurora: every point emits a curtain upward; brightness fades with height
    const aurora = { mesh: null, cols: 0, time: { value: 0 } };
    function auroraMesh() {
      const step = 2, cols = SIZE / step;
      const pos = new Float32Array(cols * 2 * 3);
      const v = new Float32Array(cols * 2);
      const index = new Uint32Array(cols * 6);
      for (let c = 0; c < cols; c++) {
        v[c * 2] = 0;
        v[c * 2 + 1] = 1;
        const n = (c + 1) % cols;
        index.set([c * 2, n * 2, c * 2 + 1, c * 2 + 1, n * 2, n * 2 + 1], c * 6);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
      geo.setAttribute("aV", new THREE.BufferAttribute(v, 1));
      geo.setIndex(new THREE.BufferAttribute(index, 1));
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uTime: aurora.time,
          uH: { value: 1 },
          uOpacity: { value: 0.03 },
          uColA: { value: new THREE.Color() },
          uColB: { value: new THREE.Color() },
        },
        vertexShader: [
          "attribute float aV; uniform float uTime; uniform float uH; varying float vV;",
          "void main() {",
          "  vec3 p = position;",
          "  float sway = sin(uTime * 0.55 + p.x * 2.1 + p.y * 1.3) * 0.07 * aV;",
          "  vec2 dir = normalize(p.xy + vec2(1e-4));",
          "  p.xy += dir * sway;",
          "  p.z += aV * uH * (0.75 + 0.25 * sin(uTime * 0.3 + p.x * 3.0));",
          "  vV = aV;",
          "  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);",
          "}",
        ].join("\n"),
        fragmentShader: [
          "uniform vec3 uColA; uniform vec3 uColB; uniform float uOpacity; varying float vV;",
          "void main() {",
          "  float a = smoothstep(0.0, 0.05, vV) * pow(1.0 - vV, 1.7) * uOpacity;",
          "  gl_FragColor = vec4(mix(uColA, uColB, pow(vV, 0.7)), a);",
          "}",
        ].join("\n"),
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      aurora.cols = cols;
      return mesh;
    }
    def("aurora", "Aurora", {
      triGain: 0.55,
      bloom: 1.3,
      animated: true,
      enter: function (env) {
        if (!aurora.mesh) aurora.mesh = auroraMesh();
        env.mainRoot.add(aurora.mesh);
      },
      exit: function (env) {
        if (aurora.mesh) env.mainRoot.remove(aurora.mesh);
      },
      onHash: function (hash) {
        if (!aurora.mesh) aurora.mesh = auroraMesh();
        const u = aurora.mesh.material.uniforms;
        u.uColA.value.setRGB.apply(u.uColA.value, hsl(hash.layers[0].hue, 0.9, 0.55));
        u.uColB.value.setRGB.apply(u.uColB.value, hsl(hash.layers[1].hue, 0.9, 0.5));
      },
      onPoints: function (P3) {
        const pos = aurora.mesh.geometry.attributes.position;
        const arr = pos.array;
        for (let c = 0; c < aurora.cols; c++) {
          const o = c * 2 * 3;
          arr[o] = arr[o + 3] = P3[c * 6];
          arr[o + 1] = arr[o + 4] = P3[c * 6 + 1];
          arr[o + 2] = arr[o + 5] = P3[c * 6 + 2];
        }
        pos.needsUpdate = true;
      },
      update: function (env) {
        const u = aurora.mesh.material.uniforms;
        u.uH.value = opts.aurora;
        u.uOpacity.value = 0.028 * opts.exposure;
        if (env.head < 1) aurora.mesh.geometry.setDrawRange(0, Math.floor(env.head * aurora.cols) * 6);
        else aurora.mesh.geometry.setDrawRange(0, Infinity);
        if (reduceMotion) return false;
        aurora.time.value += env.dt;
        return true;
      },
    });

    // ---- paper styles share a post pass: paper fibre, ink grain, ink bleed
    function paperPass() {
      return new Pass(
        [
          "uniform sampler2D tDiffuse; uniform vec2 uRes; uniform vec3 uPaper; uniform float uGrain; uniform float uBleed; uniform float uPx;",
          "varying vec2 vUv;",
          NOISE,
          "void main() {",
          "  vec2 px = 1.0 / uRes * uPx;",
          "  vec3 c = texture2D(tDiffuse, vUv).rgb;",
          "  vec3 m = min(min(texture2D(tDiffuse, vUv + vec2(px.x, 0.0)).rgb, texture2D(tDiffuse, vUv - vec2(px.x, 0.0)).rgb),",
          "               min(texture2D(tDiffuse, vUv + vec2(0.0, px.y)).rgb, texture2D(tDiffuse, vUv - vec2(0.0, px.y)).rgb));",
          "  c = mix(c, min(c, m), uBleed);",
          "  vec3 cover = clamp(1.0 - c / uPaper, 0.0, 1.0);",
          "  float n = hash12(floor(gl_FragCoord.xy / max(uPx, 1.0)));",
          "  cover *= mix(1.0, 0.62 + 0.7 * n, uGrain);",
          "  float fibre = fbm(gl_FragCoord.xy / uPx * vec2(0.02, 0.05)) - 0.5;",
          "  vec3 o = uPaper * (1.0 - clamp(cover, 0.0, 1.0)) * (1.0 + fibre * 0.07);",
          "  gl_FragColor = vec4(o, 1.0);",
          "}",
        ].join("\n"),
        { uPaper: { value: PAPER }, uGrain: { value: 0 }, uBleed: { value: 0 }, uPx: { value: 1 } }
      );
    }

    // ---- stained glass: absorbing glass in front of daylight, lead along the curve
    const glass = { lead: null };
    def("glass", "Stained glass", {
      paper: true,
      bg: new THREE.Color(0.97, 0.955, 0.92),
      bloom: 0,
      triGain: 2.4,
      inkMix: 1,
      ink: function (i, hash) {
        return hsl(hash.layers[i].hue, 0.85, 0.5);
      },
      enter: function (env) {
        if (!glass.lead) glass.lead = new FatLines(SIZE + 22, "normal", 2.4);
        env.mainRoot.add(glass.lead.mesh);
      },
      exit: function (env) {
        if (glass.lead) env.mainRoot.remove(glass.lead.mesh);
      },
      onPoints: function (P3, hash) {
        const L = glass.lead, k = 0.07;
        for (let i = 0; i < SIZE; i++) {
          const a = i * 3, b = ((i + 1) % SIZE) * 3;
          L.set(i, P3[a], P3[a + 1], P3[a + 2], P3[b], P3[b + 1], P3[b + 2], k, k, k, 0.92);
        }
        // Rose-window spokes on the N symmetry axes.
        let r = 0;
        for (let o = 0; o < P3.length; o += 3) r = Math.max(r, Math.hypot(P3[o], P3[o + 1]));
        const n = hash ? hash.N : 7;
        for (let j = 0; j < n; j++) {
          const th = (j / n) * TAU + Math.PI / 2;
          L.set(SIZE + j, 0, 0, 0, Math.cos(th) * r * 1.02, Math.sin(th) * r * 1.02, 0, k, k, k, 0.55);
        }
        L.commit(SIZE + n);
      },
      update: function (env) {
        glass.lead.width.value = 2.4 * pxRatio.value;
        if (env.head < 1) glass.lead.show(Math.floor(env.head * SIZE));
        else glass.lead.show(Infinity);
        return false;
      },
    });

    // ---- risograph: one drum per layer, misregistered, grainy ink on paper
    const riso = { inks: null, offsets: [[0, 0], [0, 0], [0, 0]], pass: paperPass() };
    def("riso", "Risograph", {
      paper: true,
      bg: PAPER,
      bloom: 0,
      triGain: 1.9,
      inkMix: 1,
      pass: riso.pass,
      ink: function (i) {
        return riso.inks ? riso.inks[i].rgb : [0, 0, 0];
      },
      onHash: function (hash) {
        const Art = root.VHArt;
        const inks = Art && Art.risoInks ? Art.risoInks(hash) : null;
        riso.inks = (inks || [{ hex: "#FF48B0" }, { hex: "#0078BF" }, { hex: "#FFE800" }]).map((k) => {
          const c = new THREE.Color(k.hex);
          return { name: k.name || k.hex, hex: k.hex, rgb: [c.r, c.g, c.b] };
        });
        const rnd = seededRand(hash);
        riso.offsets = [0, 1, 2].map(() => {
          const th = rnd() * TAU;
          return [Math.cos(th), Math.sin(th)];
        });
      },
      layerTransform: function (i, pivot) {
        const o = riso.offsets[i], d = opts.misreg * 0.025;
        pivot.position.x = o[0] * d;
        pivot.position.y = o[1] * d;
        pivot.rotation.z += o[0] * opts.misreg * 0.004;
      },
      update: function () {
        const u = riso.pass.uniforms;
        u.uGrain.value = 1;
        u.uBleed.value = 0.35;
        u.uPx.value = pxRatio.value;
        return false;
      },
    });

    // ---- pen plotter: the curve as one stroke in drawing order, chords as pens
    const plot = { lines: null, pass: paperPass(), order: null };
    def("plotter", "Pen plotter", {
      paper: true,
      bg: PAPER,
      bloom: 0,
      hideTriangles: true,
      pass: plot.pass,
      enter: function (env) {
        if (!plot.lines) plot.lines = new FatLines(SIZE * 4, "paper", 1.1);
        env.mainRoot.add(plot.lines.mesh);
      },
      exit: function (env) {
        if (plot.lines) env.mainRoot.remove(plot.lines.mesh);
      },
      onPoints: function (P3, hash) {
        if (!hash) return;
        const L = plot.lines;
        let s = 0;
        const order = [];
        for (let i = 0; i < SIZE; i++, s++) {
          const a = i * 3, b = ((i + 1) % SIZE) * 3;
          L.set(s, P3[a], P3[a + 1], P3[a + 2], P3[b], P3[b + 1], P3[b + 2], 0.08, 0.08, 0.12, 0.85);
          order.push(i);
        }
        hash.layers.forEach((layer, li) => {
          if (ctx.state.hidden[li]) return;
          const c = layer.rgb, idx = layer.index;
          for (let t = 0; t < layer.count && s < L.max; t++, s++) {
            const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3;
            L.set(s, P3[a], P3[a + 1], P3[a + 2], P3[b], P3[b + 1], P3[b + 2], c[0], c[1], c[2], 0.2);
            order.push(idx[t * 3]);
          }
        });
        plot.order = order;
        L.commit(s);
      },
      update: function (env) {
        const L = plot.lines, u = plot.pass.uniforms;
        L.width.value = 1.1 * pxRatio.value;
        L.material.uniforms.uOpacity.value = Math.min(1.6, opts.exposure);
        u.uGrain.value = 0.25;
        u.uBleed.value = 0.6;
        u.uPx.value = pxRatio.value;
        if (env.head < 1 && plot.order) {
          // The pen follows r: curve first, each layer's chords as r passes them.
          const lim = env.head * SIZE;
          let n = 0;
          while (n < plot.order.length && (n < SIZE ? n <= lim : plot.order[n] <= lim)) n++;
          if (n >= SIZE) {
            // chords: show those whose start index is behind the pen, per layer block
            n = SIZE;
            for (let k = SIZE; k < plot.order.length; k++) L.alpha(k, plot.order[k] <= lim ? 0.2 : 0);
            L.commit(undefined, true);
            L.show(Infinity);
          } else {
            L.show(n);
          }
          plot.drawing = true;
        } else if (plot.drawing) {
          plot.drawing = false;
          for (let k = SIZE; k < plot.lines.count; k++) L.alpha(k, 0.2);
          L.commit(undefined, true);
          L.show(Infinity);
        }
        return false;
      },
    });

    // ---- string art: nails on the curve, threads walk j → j+t (a modular times table)
    const str = { lines: null, nails: null, board: null, plan: null, M: 0 };
    function woodTexture() {
      const c = document.createElement("canvas");
      c.width = c.height = 512;
      const g = c.getContext("2d");
      g.fillStyle = "#7a4f2e";
      g.fillRect(0, 0, 512, 512);
      for (let i = 0; i < 160; i++) {
        const r = 6 + i * 3.1 + Math.sin(i * 1.7) * 2;
        g.strokeStyle = "rgba(" + (i % 2 ? "95,62,36" : "48,30,18") + "," + (0.25 + 0.25 * Math.sin(i)) + ")";
        g.lineWidth = 1 + (i % 3);
        g.beginPath();
        g.ellipse(256 + 40, 256 - 20, r * 1.4, r, 0.3, 0, TAU);
        g.stroke();
      }
      const t = new THREE.CanvasTexture(c);
      return t;
    }
    def("string", "String art", {
      bg: new THREE.Color(0.03, 0.025, 0.02),
      hideTriangles: true,
      bloom: 0.15,
      enter: function (env) {
        if (!str.lines) {
          str.lines = new FatLines(3 * 924, "normal", 1.3);
          str.board = new THREE.Mesh(
            new THREE.CircleGeometry(1, 128),
            new THREE.MeshBasicMaterial({ map: woodTexture(), color: 0x9a8a7a })
          );
          str.board.renderOrder = -1;
          str.nailGeo = new THREE.CylinderGeometry(0.009, 0.009, 0.07, 6);
          str.nailGeo.rotateX(Math.PI / 2);
          str.nailMat = new THREE.MeshStandardMaterial({ color: 0xc9c2b8, metalness: 0.9, roughness: 0.35 });
        }
        env.mainRoot.add(str.lines.mesh, str.board);
        if (str.nails) env.mainRoot.add(str.nails);
      },
      exit: function (env) {
        if (str.lines) env.mainRoot.remove(str.lines.mesh, str.board);
        if (str.nails) env.mainRoot.remove(str.nails);
      },
      onHash: function (hash) {
        const Art = root.VHArt;
        if (!Art || !Art.stringArt) return;
        const options = Art.nailOptions(hash.N);
        let M = opts.nails;
        if (options.indexOf(M) < 0) {
          M = options.reduce((best, m) => (Math.abs(m - 420) < Math.abs(best - 420) ? m : best), options[0]);
        }
        str.M = M;
        str.plan = Art.stringArt(hash, M);
        str.options = options;
      },
      onPoints: function (P3, hash, env) {
        if (!str.plan) return;
        const M = str.M, every = SIZE / M, L = str.lines;
        if (!str.nails || str.nails.count !== M) {
          if (str.nails) {
            if (str.nails.parent) str.nails.parent.remove(str.nails);
            str.nails.dispose();
          }
          str.nails = new THREE.InstancedMesh(str.nailGeo, str.nailMat, M);
          str.nails.frustumCulled = false;
          if (env && ctx.getStyle() === "string") env.mainRoot.add(str.nails);
        }
        const m = new THREE.Matrix4();
        let zMin = Infinity, r = 0;
        for (let j = 0; j < M; j++) {
          const o = j * every * 3;
          m.makeTranslation(P3[o], P3[o + 1], P3[o + 2] + 0.02);
          str.nails.setMatrixAt(j, m);
          zMin = Math.min(zMin, P3[o + 2]);
          r = Math.max(r, Math.hypot(P3[o], P3[o + 1]));
        }
        str.nails.instanceMatrix.needsUpdate = true;
        str.board.scale.setScalar(r * 1.1);
        str.board.position.z = zMin - 0.015;
        let s = 0;
        str.plan.layers.forEach((layer, li) => {
          if (ctx.state.hidden[li]) return;
          const c = hsl(layer.hue, Math.min(1, layer.sat / 100 + 0.2), 0.6);
          layer.segments.forEach((seg) => {
            if (s >= L.max) return;
            const a = seg[0] * every * 3, b = seg[1] * every * 3;
            L.set(s++, P3[a], P3[a + 1], P3[a + 2] + 0.03, P3[b], P3[b + 1], P3[b + 2] + 0.03, c[0], c[1], c[2], 0.7);
          });
        });
        L.commit(s);
      },
      update: function (env) {
        str.lines.width.value = 1.2 * pxRatio.value;
        str.lines.material.uniforms.uOpacity.value = Math.min(1.4, opts.exposure);
        if (env.head < 1) str.lines.show(Math.floor(env.head * str.lines.count));
        else str.lines.show(Infinity);
        return false;
      },
    });

    // ---- ASCII: brightness typed with the characters of the name, darkest = space
    const ascii = { atlas: null, count: 1, glyphs: " " };
    function buildAtlas(name) {
      const chars = [];
      Array.from(name || "").forEach((ch) => {
        if (!/\s/.test(ch) && chars.indexOf(ch) < 0 && chars.length < 48) chars.push(ch);
      });
      if (!chars.length) chars.push("·");
      const S = 64, c = document.createElement("canvas");
      c.width = S * (chars.length + 1);
      c.height = S;
      const g = c.getContext("2d", { willReadFrequently: true });
      g.fillStyle = "#000";
      g.fillRect(0, 0, c.width, c.height);
      g.fillStyle = "#fff";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.font = "bold 50px ui-monospace, Menlo, Consolas, monospace";
      // Measure each glyph's ink to sort them from light to dark.
      const ink = chars.map((ch, i) => {
        g.fillText(ch, S * (i + 1.5), S * 0.54);
        const d = g.getImageData(S * (i + 1), 0, S, S).data;
        let sum = 0;
        for (let k = 0; k < d.length; k += 4) sum += d[k];
        return { ch: ch, ink: sum };
      });
      ink.sort((a, b) => a.ink - b.ink);
      g.fillStyle = "#000";
      g.fillRect(0, 0, c.width, c.height);
      g.fillStyle = "#fff";
      ink.forEach((o, i) => g.fillText(o.ch, S * (i + 1.5), S * 0.54));
      if (ascii.atlas) ascii.atlas.dispose();
      ascii.atlas = new THREE.CanvasTexture(c);
      ascii.atlas.minFilter = THREE.LinearFilter;
      ascii.atlas.generateMipmaps = false;
      ascii.count = chars.length + 1;
      ascii.glyphs = " " + ink.map((o) => o.ch).join("");
    }
    def("ascii", "ASCII (name)", {
      bloom: 0.3,
      pass: new Pass(
        [
          "uniform sampler2D tDiffuse; uniform sampler2D tAtlas; uniform vec2 uRes; uniform float uCell; uniform float uCount;",
          "varying vec2 vUv;",
          "void main() {",
          "  vec2 cell = floor(gl_FragCoord.xy / uCell);",
          "  vec2 q = 0.25 * uCell / uRes;",
          "  vec2 c0 = (cell + 0.5) * uCell / uRes;",
          "  vec3 c = (texture2D(tDiffuse, c0 + vec2(q.x, q.y)).rgb + texture2D(tDiffuse, c0 + vec2(-q.x, q.y)).rgb +",
          "            texture2D(tDiffuse, c0 + vec2(q.x, -q.y)).rgb + texture2D(tDiffuse, c0 - q).rgb) * 0.25;",
          "  float l = max(c.r, max(c.g, c.b));",
          "  float idx = floor(clamp(pow(l, 1.5), 0.0, 0.999) * uCount);",
          "  vec2 f = fract(gl_FragCoord.xy / uCell);",
          "  float g = texture2D(tAtlas, vec2((idx + f.x) / uCount, f.y)).r;",
          "  vec3 hue = c / max(l, 1e-3);",
          "  gl_FragColor = vec4(hue * g * min(1.0, 0.5 + l * 1.5), 1.0);",
          "}",
        ].join("\n"),
        { tAtlas: { value: null }, uCell: { value: 10 }, uCount: { value: 1 } }
      ),
      onHash: function (hash) {
        buildAtlas(hash.name);
      },
      update: function () {
        const u = this.pass.uniforms;
        u.tAtlas.value = ascii.atlas;
        u.uCount.value = ascii.count;
        u.uCell.value = Math.round(opts.cell * pxRatio.value);
        return false;
      },
    });

    // ------------------------------------------------------------ kaleidoscope lens
    //
    // The image is invariant under turns of 2π/N, so one wedge holds all of it.
    // "wedge" shows that fundamental domain; "mirror" folds it into a D_N
    // kaleidoscope (an art view: the hash itself is chiral).
    const kaleido = new Pass(
      [
        "uniform sampler2D tDiffuse; uniform vec2 uRes; uniform vec2 uCenter; uniform float uPhase; uniform float uN;",
        "uniform float uMode; uniform float uPx; uniform vec3 uBg;",
        "varying vec2 vUv;",
        "void main() {",
        "  vec2 p = gl_FragCoord.xy - uCenter;",
        "  float r = length(p), a = atan(p.y, p.x), w = 6.2831853 / uN;",
        "  float rel = mod(a - uPhase, 6.2831853);",
        "  if (uMode > 1.5) {",
        "    float m = mod(rel, w);",
        "    if (m > 0.5 * w) m = w - m;",
        "    vec2 q = uCenter + r * vec2(cos(uPhase + m), sin(uPhase + m));",
        "    gl_FragColor = vec4(texture2D(tDiffuse, q / uRes).rgb, 1.0);",
        "    return;",
        "  }",
        "  vec3 c = texture2D(tDiffuse, vUv).rgb;",
        "  if (rel > w) c = mix(c, uBg, 0.78);",
        "  float e0 = abs(r * sin(rel)), e1 = abs(r * sin(rel - w));",
        "  float edge = max((cos(rel) > 0.0 ? 1.0 - smoothstep(0.0, uPx, e0) : 0.0), (cos(rel - w) > 0.0 ? 1.0 - smoothstep(0.0, uPx, e1) : 0.0));",
        "  vec3 ink = dot(uBg, vec3(0.33)) > 0.5 ? vec3(0.1) : vec3(0.9);",
        "  gl_FragColor = vec4(mix(c, ink, edge * 0.55), 1.0);",
        "}",
      ].join("\n"),
      {
        uCenter: { value: new THREE.Vector2() },
        uPhase: { value: 0 },
        uN: { value: 7 },
        uMode: { value: 1 },
        uPx: { value: 1.2 },
        uBg: { value: new THREE.Color() },
      }
    );

    // ------------------------------------------------------------ difference (compare)
    //
    // Interferometry: render both hashes separately and show |A − B|. Identical
    // light cancels to black, so a collision disappears completely.
    function DiffPass(scene, camera, rootA, rootB) {
      Pass.call(
        this,
        [
          "uniform sampler2D tA; uniform sampler2D tB; varying vec2 vUv;",
          "void main() { gl_FragColor = vec4(abs(texture2D(tA, vUv).rgb - texture2D(tB, vUv).rgb), 1.0); }",
        ].join("\n"),
        { tA: { value: null }, tB: { value: null } }
      );
      this.needsSwap = false;
      this.rtA = new THREE.WebGLRenderTarget(1, 1);
      this.rtB = new THREE.WebGLRenderTarget(1, 1);
      this.sceneRef = scene;
      this.cameraRef = camera;
      this.rootA = rootA;
      this.rootB = rootB;
    }
    DiffPass.prototype = Object.create(Pass.prototype);
    DiffPass.prototype.setSize = function (w, h) {
      this.rtA.setSize(w, h);
      this.rtB.setSize(w, h);
    };
    DiffPass.prototype.render = function (renderer, writeBuffer, readBuffer) {
      const s = this.sceneRef, c = this.cameraRef, A = this.rootA, B = this.rootB;
      B.visible = false;
      renderer.setRenderTarget(this.rtA);
      renderer.clear();
      renderer.render(s, c);
      B.visible = true;
      A.visible = false;
      renderer.setRenderTarget(this.rtB);
      renderer.clear();
      renderer.render(s, c);
      A.visible = true;
      this.uniforms.tA.value = this.rtA.texture;
      this.uniforms.tB.value = this.rtB.texture;
      renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
      renderer.render(this.scene, quadCam);
    };

    // ------------------------------------------------------------ epicycle machine
    //
    // The point is the sum of three rotating arms (main radius, two epicycles):
    // Ptolemy's machine, or a three-term Fourier series. The arms and their
    // orbits are drawn at the current pen position.
    const machine = { lines: null, joints: null, idx: 0, active: false };
    const CIRCLE = 72;
    function machineInit(glowTex) {
      // Normal blending: additive white would vanish on the bright image.
      machine.lines = new FatLines(3 + CIRCLE * 3, "normal", 2.4);
      machine.lines.mesh.renderOrder = 10;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(4 * 3), 3));
      machine.joints = new THREE.Points(
        geo,
        new THREE.PointsMaterial({ map: glowTex, size: 0.18, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false })
      );
      machine.joints.frustumCulled = false;
      machine.lines.mesh.frustumCulled = false;
    }
    // env.mapPoint(x, y, index, out3) maps a 2D point to the current form.
    function machineUpdate(env, hash, idx) {
      const L = machine.lines, A = hash.arms;
      const px = hash.x[idx], py = hash.y[idx];
      const pts = [
        [0, 0],
        [A.ax[idx], A.ay[idx]],
        [A.ax[idx] + A.bx[idx], A.ay[idx] + A.by[idx]],
        [px, py],
      ];
      const m = pts.map((p) => env.mapPoint(p[0], p[1], idx));
      const cols = [[1, 1, 1], hsl(hash.layers[0].hue, 0.9, 0.62), hsl(hash.layers[1].hue, 0.9, 0.62)];
      for (let k = 0; k < 3; k++) {
        const a = m[k], b = m[k + 1], c = cols[k];
        L.set(k, a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], 1);
      }
      // Orbit of each arm around its own pivot.
      let s = 3;
      for (let k = 0; k < 3; k++) {
        const cx = pts[k][0], cy = pts[k][1];
        const rr = Math.hypot(pts[k + 1][0] - cx, pts[k + 1][1] - cy);
        const c = cols[k];
        let prev = env.mapPoint(cx + rr, cy, idx);
        for (let j = 1; j <= CIRCLE; j++) {
          const th = (j / CIRCLE) * TAU;
          const cur = env.mapPoint(cx + Math.cos(th) * rr, cy + Math.sin(th) * rr, idx);
          L.set(s++, prev[0], prev[1], prev[2], cur[0], cur[1], cur[2], c[0], c[1], c[2], 0.5);
          prev = cur;
        }
      }
      L.commit(s);
      L.width.value = 2.4 * pxRatio.value;
      const jp = machine.joints.geometry.attributes.position;
      m.forEach((p, i) => jp.setXYZ(i, p[0], p[1], p[2]));
      jp.needsUpdate = true;
    }

    // ------------------------------------------------------------ domemaster
    //
    // Fulldome: render a cube map from inside the form and unwrap it into an
    // azimuthal-equidistant fisheye (180°, zenith at the centre).
    function domemaster(renderer, scene, eye, size) {
      size = size || 2048;
      const face = Math.min(2048, size);
      const crt = new THREE.WebGLCubeRenderTarget(face);
      const cam = new THREE.CubeCamera(0.01, 100, crt);
      cam.position.copy(eye);
      scene.add(cam);
      cam.update(renderer, scene);
      scene.remove(cam);
      const mat = new THREE.ShaderMaterial({
        uniforms: { tCube: { value: crt.texture } },
        vertexShader: VS,
        fragmentShader: [
          "uniform samplerCube tCube; varying vec2 vUv;",
          "void main() {",
          "  vec2 p = vUv * 2.0 - 1.0;",
          "  float r = length(p);",
          "  if (r > 1.0) { gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0); return; }",
          "  float th = r * 1.5707963, ph = atan(p.y, p.x);",
          // Image right = world +x, image up = world +y: the audience sees the hash
          // with the same handedness as the top view (a hash mirrored is another image).
          "  vec3 dir = vec3(sin(th) * cos(ph), sin(th) * sin(ph), cos(th));",
          "  gl_FragColor = vec4(textureCube(tCube, dir).rgb, 1.0);",
          "}",
        ].join("\n"),
        depthTest: false,
        depthWrite: false,
      });
      const quad = new THREE.Mesh(quadGeo, mat);
      const sc = new THREE.Scene();
      sc.add(quad);
      const rt = new THREE.WebGLRenderTarget(size, size);
      renderer.setRenderTarget(rt);
      renderer.render(sc, quadCam);
      const px = new Uint8Array(size * size * 4);
      renderer.readRenderTargetPixels(rt, 0, 0, size, size, px);
      renderer.setRenderTarget(null);
      crt.dispose();
      rt.dispose();
      mat.dispose();
      const c = document.createElement("canvas");
      c.width = c.height = size;
      const g = c.getContext("2d");
      const img = g.createImageData(size, size);
      for (let y = 0; y < size; y++) {
        img.data.set(px.subarray((size - 1 - y) * size * 4, (size - y) * size * 4), y * size * 4);
      }
      for (let k = 3; k < img.data.length; k += 4) img.data[k] = 255;
      g.putImageData(img, 0, 0);
      return c;
    }

    return {
      Pass: Pass,
      FatLines: FatLines,
      DiffPass: DiffPass,
      styles: styles,
      order: order,
      kaleido: kaleido,
      machine: machine,
      machineInit: machineInit,
      machineUpdate: machineUpdate,
      domemaster: domemaster,
      setResolution: function (w, h, ratio) {
        resUniform.value.set(w, h);
        pxRatio.value = ratio;
      },
      expo: expo,
      riso: riso,
      str: str,
      ascii: ascii,
      wavelengthRank: wavelengthRank,
      PAPER: PAPER,
    };
  }

  root.VHFx = { create: create };
})(this);
