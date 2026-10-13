/*
 * Visual Hashing 3D — three.js front end for visualhash.js.
 *
 * Plain script: three.js and its addons come from vendor/three.bundle.min.js
 * (window.VH3D_DEPS) and are handed to VH3D.start(), so the page runs offline
 * and from file://.
 *
 * Pipeline:
 *   hash (2D points + signals) --morph--> frame --map(mode)--> P3 (3D points)
 *   P3 --gather by triangle index--> layer meshes (additive light)
 *
 * Light: every triangle keeps the light it has in the original image
 * (alpha × area = 55 canvas px), and the vertex shader spreads it over the
 * triangle's projected area on screen. Seen straight from above that is
 * exactly the original alpha = 55/area; tilted, lifted or wrapped shapes keep
 * the same overall brightness without per-form fudge factors.
 */
(function () {
  "use strict";

  var VH3D = (window.VH3D = { started: false, start: start, fail: fail });

  function fail(message) {
    var el = document.getElementById("fallback");
    el.textContent = message;
    el.hidden = false;
  }

  function start(deps) {
    try {
      run(deps);
      VH3D.started = true;
    } catch (err) {
      console.error(err);
      fail("WebGL is not available in this browser, so the 3D view cannot start. (" + err.message + ")");
      VH3D.started = true;
    }
  }

  function run(deps) {
    const THREE = deps.THREE;
    const VH = window.VisualHash;
    const SIZE = VH.SIZE;
    const TAU = Math.PI * 2;
    const MODES = ["sculpture", "lotus", "sphere", "torus", "pendant"];
    const SIGNALS = ["radius", "phase", "loop", "wave"];
    const LAYER_SPIN = [0.13, -0.09, 0.055];
    const TURN_SPEED = TAU / 100; // one turn every 100 s
    const LIGHT_UNIT = 2 * 110 * 110; // canvas shoelace value (2 × px area) per world unit²
    const TORUS_R = 1.45, TORUS_r = 0.62, SPHERE_R = 1.75;
    const SIDE_GAP = 2.05;
    const MAX_GAIN = 3;
    const TINT_A = [0.8, 0.45, 0.05], TINT_B = [0.05, 0.4, 0.8]; // sum to neutral grey
    const $ = (id) => document.getElementById(id);
    const reduceMotion = !!(window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches);

    const DEFAULTS = {
      liftAmount: 0.55,
      explode: 0.85,
      spin: !reduceMotion,
      bloom: 0.6,
      exposure: 1,
      showCurve: false,
      thickness: 0.045,
      relief: 0.12,
      ring: true,
      wrap: 1,
      sizeMm: 40,
      glowTube: false,
    };
    // Short URL keys for every look/shape option that a shared link should carry.
    const URL_KEYS = {
      liftAmount: "la", explode: "ex", spin: "sp", bloom: "gl", exposure: "br", showCurve: "cv",
      thickness: "th", relief: "rl", ring: "rg", wrap: "wr", sizeMm: "mm",
    };

    // ------------------------------------------------------------ state

    const initial = readUrl();
    const state = initial.state;
    const opts = initial.opts;

    let current = null; // main hash being shown (or morphed to)
    let dirty = true; // P3 needs recomputing
    let pendant = null;
    let pendantTimer = 0;
    let autoTimer = 0;
    let urlTimer = 0;
    let triFade = 1;
    let curveOpacity = 0;
    let spinAngle = initial.view.spin;
    let spinHome = null; // "sym": settle on a symmetry angle (looks like angle 0); "zero": exactly 0, bail on top
    let modeFrom = state.mode;
    let hoverLayer = -1;
    let contextLost = false;
    let capturing = false; // GIF capture steps frames itself
    let recording = null; // live video capture
    let moving = false; // set by approach() while a damped value is still travelling

    const morph = { active: false, t: 1, dur: 0.9 };
    const modeAnim = { active: false, t: 1, dur: 0.9 };
    const draw = { active: false, t: 0, dur: 3.4, visual: null };
    const grow = { active: false, t: 0, dur: 3.4 };
    const camAnim = { active: false, t: 0, dur: 1.1, from: new THREE.Vector3(), to: new THREE.Vector3() };
    const layerZ = [0, 0, 0];
    const layerRot = [0, 0, 0];
    const layerVis = state.hidden.map((h) => (h ? 0 : 1));
    const layout = { main: 0, other: 0, tint: 0 };
    const bounds = { H: 0, R: 1.7 };
    const shadeG = { value: 1 }; // footprint factor shared by every triangle material

    const morphFrom = emptyFrame();
    let morphTo = null;

    // ------------------------------------------------------------ three.js setup

    const stage = $("stage");
    const renderer = new THREE.WebGLRenderer({ canvas: stage, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

    const scene = new THREE.Scene();
    const BG_GLOW = new THREE.Color(0x000000);
    const BG_METAL = new THREE.Color(0x0c0e13);
    scene.background = BG_GLOW;

    const camera = new THREE.PerspectiveCamera(38, 1, 0.05, 100);
    camera.up.set(0, 0, 1); // z is "out of the original canvas"
    const VIEW_ANGLE = new THREE.Vector3(0, -6.1, 4.3);
    const VIEW_TOP = new THREE.Vector3(0, -0.0001, 7.2);
    const VIEW_FRONT = new THREE.Vector3(0, -1.6, 6.6);
    camera.position.copy(initial.view.cam || (state.mode === "pendant" ? VIEW_FRONT : VIEW_ANGLE));

    const controls = new deps.OrbitControls(camera, stage);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 2.5;
    controls.maxDistance = 20;
    if (initial.view.target) controls.target.copy(initial.view.target);
    controls.addEventListener("start", () => {
      camAnim.active = false;
      kick();
    });
    controls.addEventListener("change", kick);

    let pmrem = null;
    function makeEnvironment() {
      if (scene.environment) scene.environment.dispose();
      if (pmrem) pmrem.dispose();
      pmrem = new THREE.PMREMGenerator(renderer);
      scene.environment = pmrem.fromScene(new deps.RoomEnvironment(renderer), 0.04).texture;
    }
    makeEnvironment();
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.4);
    keyLight.position.set(-3, -4, 6);
    scene.add(keyLight);

    // Glow modes render into an 8-bit target: additive light clamps at 1 per
    // pixel, exactly like the original canvas. The pendant needs float for lighting.
    function makeComposer(type) {
      const target = type ? new THREE.WebGLRenderTarget(1, 1, { type: type }) : undefined;
      const c = new deps.EffectComposer(renderer, target);
      c.addPass(new deps.RenderPass(scene, camera));
      c.bloom = new deps.UnrealBloomPass(new THREE.Vector2(256, 256), opts.bloom, 0.4, 0);
      c.addPass(c.bloom);
      c.addPass(new deps.OutputPass());
      return c;
    }
    const glowComposer = makeComposer(THREE.UnsignedByteType);
    const metalComposer = makeComposer(null);
    let composer = glowComposer;

    // Main hash on the left (or centre), compared hash on the right.
    const mainRoot = new THREE.Group();
    const compareRoot = new THREE.Group();
    scene.add(mainRoot, compareRoot);

    function resize() {
      const w = stage.clientWidth, h = stage.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      glowComposer.setSize(w, h);
      metalComposer.setSize(w, h);
      camera.aspect = w / h;
      // Portrait screens keep at least the landscape horizontal field of view.
      const half = THREE.MathUtils.degToRad(19);
      camera.fov = w >= h ? 38 : Math.min(75, THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(half) / camera.aspect)));
      camera.updateProjectionMatrix();
      kick();
    }
    new ResizeObserver(resize).observe(stage);

    // The curve itself (closed by repeating the first point so drawRange works).
    const curvePos = new Float32Array((SIZE + 1) * 3);
    const curveGeo = new THREE.BufferGeometry();
    curveGeo.setAttribute("position", new THREE.BufferAttribute(curvePos, 3).setUsage(THREE.DynamicDrawUsage));
    const curveMat = new THREE.LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const curveLine = new THREE.Line(curveGeo, curveMat);
    curveLine.frustumCulled = false;
    mainRoot.add(curveLine);

    // Comet head for the draw-on and pendant-growth animations.
    const cometGeo = new THREE.BufferGeometry();
    cometGeo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(3), 3));
    const comet = new THREE.Points(
      cometGeo,
      new THREE.PointsMaterial({
        map: glowTexture(),
        size: 0.42,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      })
    );
    comet.frustumCulled = false;
    comet.visible = false;
    mainRoot.add(comet);

    const metal = new THREE.MeshStandardMaterial({ metalness: 1, roughness: 0.3 });

    // Additive triangle material. The vertex shader turns each triangle's fixed
    // light into alpha = light / projected area (see the header comment). A big
    // triangle seen edge-on would collapse into a solid line, so no triangle may
    // get more than MAX_GAIN times its original alpha.
    function triMaterial() {
      const mat = new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      mat.userData.tint = { value: new THREE.Color() };
      mat.userData.tintMix = { value: 0 };
      mat.onBeforeCompile = (shader) => {
        shader.uniforms.uG = shadeG;
        shader.uniforms.uTint = mat.userData.tint;
        shader.uniforms.uTintMix = mat.userData.tintMix;
        shader.vertexShader =
          "#define MAX_GAIN " + MAX_GAIN.toFixed(1) + "\n" +
          "attribute vec3 triCross;\nattribute vec2 triLight;\nuniform float uG;\nuniform vec3 uTint;\nuniform float uTintMix;\n" +
          shader.vertexShader.replace(
            "#include <color_vertex>",
            "#include <color_vertex>\n" +
              "  float projected = abs((normalMatrix * triCross).z);\n" +
              "  vColor.rgb = mix(vColor.rgb, uTint, uTintMix);\n" +
              "  vColor.a = min(min(1.0, triLight.y * MAX_GAIN), 2.0 * triLight.x * uG / max(projected, 1e-9));\n"
          );
      };
      mat.customProgramCacheKey = () => "vh-triangles";
      return mat;
    }

    // ------------------------------------------------------------ frames (2D data)

    function emptyFrame() {
      const f = { x: new Float32Array(SIZE), y: new Float32Array(SIZE), sig: {} };
      SIGNALS.forEach((k) => (f.sig[k] = new Float32Array(SIZE)));
      return f;
    }

    function frameOf(hash) {
      return { x: hash.x, y: hash.y, sig: hash.signals };
    }

    function copyFrame(src, dst) {
      dst.x.set(src.x);
      dst.y.set(src.y);
      SIGNALS.forEach((k) => dst.sig[k].set(src.sig[k]));
    }

    function lerpFrame(a, b, t, out) {
      lerpArray(a.x, b.x, t, out.x);
      lerpArray(a.y, b.y, t, out.y);
      SIGNALS.forEach((k) => lerpArray(a.sig[k], b.sig[k], t, out.sig[k]));
    }

    function lerpArray(a, b, t, out) {
      for (let i = 0; i < out.length; i++) out[i] = a[i] + (b[i] - a[i]) * t;
    }

    // A track is one hash on screen: its 2D frame, mapped points and meshes.
    function makeTrack(root) {
      return {
        root: root,
        hash: null,
        frame: emptyFrame(),
        P3: new Float32Array(SIZE * 3),
        tmp: new Float32Array(SIZE * 3),
        snap: new Float32Array(SIZE * 3),
        visuals: [], // >1 only while cross-fading
      };
    }
    const main = makeTrack(mainRoot);
    const other = makeTrack(compareRoot);

    // ------------------------------------------------------------ 2D -> 3D mappings

    // Canvas y grows downward; flip it so the top view matches the original image.
    function mapInto(mode, frame, out) {
      const x = frame.x, y = frame.y;
      if (mode === "sphere") {
        // Inverse stereographic projection: conformal, centre -> north pole.
        const R = SPHERE_R, w = opts.wrap;
        for (let i = 0, o = 0; i < SIZE; i++, o += 3) {
          const u = x[i] * w, v = -y[i] * w, rr = u * u + v * v, d = 1 + rr;
          out[o] = (R * 2 * u) / d;
          out[o + 1] = (R * 2 * v) / d;
          out[o + 2] = (R * (1 - rr)) / d;
        }
      } else if (mode === "torus") {
        // Angle -> around the ring, radius -> around the tube (inner edge, over the top, outside).
        const R = TORUS_R, r = TORUS_r, w = opts.wrap;
        for (let i = 0, o = 0; i < SIZE; i++, o += 3) {
          const u = x[i], v = -y[i];
          const theta = Math.atan2(v, u);
          const phi = Math.PI * (1 - Math.hypot(u, v) * 0.9 * w);
          const ring = R + r * Math.cos(phi);
          out[o] = ring * Math.cos(theta);
          out[o + 1] = ring * Math.sin(theta);
          out[o + 2] = r * Math.sin(phi);
        }
      } else {
        // Sculpture and pendant lift by the chosen signal; lotus layers stay flat.
        const s = frame.sig[state.lift];
        const amp = mode === "sculpture" ? opts.liftAmount : mode === "pendant" ? opts.relief : 0;
        for (let i = 0, o = 0; i < SIZE; i++, o += 3) {
          out[o] = x[i];
          out[o + 1] = -y[i];
          out[o + 2] = s[i] * amp;
        }
      }
    }

    function updateTrack(track) {
      if (!track.hash) return;
      if (modeAnim.active) {
        mapInto(state.mode, track.frame, track.tmp);
        const e = ease(modeAnim.t), P3 = track.P3, snap = track.snap, tmp = track.tmp;
        for (let i = 0; i < P3.length; i++) P3[i] = snap[i] + (tmp[i] - snap[i]) * e;
      } else {
        mapInto(state.mode, track.frame, track.P3);
      }
      track.visuals.forEach((v) => writeVisual(v, track.P3));
    }

    function updatePoints() {
      updateTrack(main);
      updateTrack(other);
      const P3 = main.P3;
      curvePos.set(P3);
      curvePos[SIZE * 3] = P3[0];
      curvePos[SIZE * 3 + 1] = P3[1];
      curvePos[SIZE * 3 + 2] = P3[2];
      curveGeo.attributes.position.needsUpdate = true;
      let zMin = Infinity, zMax = -Infinity, r2 = 0;
      for (let o = 0; o < P3.length; o += 3) {
        if (P3[o + 2] < zMin) zMin = P3[o + 2];
        if (P3[o + 2] > zMax) zMax = P3[o + 2];
        r2 = Math.max(r2, P3[o] * P3[o] + P3[o + 1] * P3[o + 1]);
      }
      bounds.H = zMax - zMin;
      bounds.R = Math.sqrt(r2);
    }

    // Roughly how much screen area the form covers from this direction, relative
    // to its top view: the tilted disc (cos θ) or, seen from the side, the band
    // made by its height, whichever dominates. Total light scales with it, so
    // light per pixel stays steady. A flat layer gives exactly the original alpha.
    function footprint(mode, dir) {
      const vz = Math.min(1, Math.abs(dir.z)), side = Math.sqrt(1 - vz * vz);
      if (mode === "sphere") return 1;
      if (mode === "torus") return Math.max(vz, ((TORUS_R + TORUS_r) / (Math.PI * TORUS_R)) * side);
      if (mode === "sculpture") return Math.max(vz, ((2 * bounds.H) / (Math.PI * Math.max(bounds.R, 0.5))) * side);
      return vz;
    }

    // ------------------------------------------------------------ triangle visuals

    function createVisual(hash, root, P3) {
      const group = new THREE.Group();
      const layers = hash.layers.map((L) => {
        const n = L.count * 3;
        const pos = new Float32Array(n * 3);
        const cross = new Float32Array(n * 3);
        const light = new Float32Array(n * 2);
        const col = new Float32Array(n * 4);
        const [r, g, b] = L.rgb;
        for (let t = 0; t < L.count; t++) {
          // alpha × area of the original triangle, in world units (= 55 px unless capped).
          const lt = Math.min(L.area[t], 55) / LIGHT_UNIT;
          const a2 = VH.alphaOf(L.area[t]);
          for (let v = 0; v < 3; v++) {
            const o = (t * 3 + v) * 4;
            col[o] = r;
            col[o + 1] = g;
            col[o + 2] = b;
            col[o + 3] = 1;
            light[(t * 3 + v) * 2] = lt;
            light[(t * 3 + v) * 2 + 1] = a2;
          }
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
        geo.setAttribute("color", new THREE.BufferAttribute(col, 4));
        geo.setAttribute("triCross", new THREE.BufferAttribute(cross, 3).setUsage(THREE.DynamicDrawUsage));
        geo.setAttribute("triLight", new THREE.BufferAttribute(light, 2));
        const mesh = new THREE.Mesh(geo, triMaterial());
        mesh.frustumCulled = false;
        const pivot = new THREE.Group();
        pivot.add(mesh);
        group.add(pivot);
        return { pivot, mesh, geo, pos, cross, index: L.index, count: L.count };
      });
      root.add(group);
      const v = { hash, group, layers, opacity: 0, from: 0, to: 1 };
      writeVisual(v, P3);
      return v;
    }

    function writeVisual(v, P3) {
      v.layers.forEach((L) => {
        const idx = L.index, pos = L.pos, cr = L.cross;
        for (let t = 0, o = 0; t < L.count; t++, o += 9) {
          const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
          const ax = P3[a], ay = P3[a + 1], az = P3[a + 2];
          const bx = P3[b], by = P3[b + 1], bz = P3[b + 2];
          const cx = P3[c], cy = P3[c + 1], cz = P3[c + 2];
          pos[o] = ax; pos[o + 1] = ay; pos[o + 2] = az;
          pos[o + 3] = bx; pos[o + 4] = by; pos[o + 5] = bz;
          pos[o + 6] = cx; pos[o + 7] = cy; pos[o + 8] = cz;
          // Cross product = normal × 2·area; its view-space z is twice the projected area.
          const ux = bx - ax, uy = by - ay, uz = bz - az;
          const wx = cx - ax, wy = cy - ay, wz = cz - az;
          const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
          cr[o] = cr[o + 3] = cr[o + 6] = nx;
          cr[o + 1] = cr[o + 4] = cr[o + 7] = ny;
          cr[o + 2] = cr[o + 5] = cr[o + 8] = nz;
        }
        L.geo.attributes.position.needsUpdate = true;
        L.geo.attributes.triCross.needsUpdate = true;
      });
    }

    function disposeVisual(v) {
      if (v.group.parent) v.group.parent.remove(v.group);
      v.layers.forEach((L) => {
        L.geo.dispose();
        L.mesh.material.dispose();
      });
      if (draw.visual === v) finishDraw();
    }

    // ------------------------------------------------------------ hash changes

    function regenerate(how) {
      setHash(VH.compute(state.name, { seed: state.seed }), how);
      if (state.compare) setCompare(state.compare);
    }

    // how: "morph" (slide from the current shape), "draw" (trace it in), "instant"
    function setHash(hash, how) {
      const prev = current;
      current = main.hash = hash;
      if (reduceMotion) how = "instant";
      finishDraw();
      if (how === "morph" && prev) {
        copyFrame(main.frame, morphFrom);
        morphTo = frameOf(hash);
        main.visuals = main.visuals.filter((v) => {
          if (v.opacity < 0.15) disposeVisual(v);
          return v.opacity >= 0.15;
        });
        while (main.visuals.length > 2) disposeVisual(main.visuals.shift());
        main.visuals.forEach((v) => {
          v.from = v.opacity;
          v.to = 0;
        });
        main.visuals.push(createVisual(hash, mainRoot, main.P3));
        morph.t = 0;
        morph.active = true;
      } else {
        main.visuals.forEach(disposeVisual);
        main.visuals = [];
        copyFrame(frameOf(hash), main.frame);
        morph.active = false;
        updatePoints();
        const v = createVisual(hash, mainRoot, main.P3);
        v.opacity = v.from = v.to = 1;
        main.visuals = [v];
        if (how === "draw") startDraw(v);
      }
      dirty = true;
      updateInfo(hash);
      writeUrl();
      if (state.mode === "pendant") schedulePendant();
      kick();
    }

    // ------------------------------------------------------------ compare

    function setCompare(name) {
      state.compare = name;
      other.visuals.forEach(disposeVisual);
      other.visuals = [];
      other.hash = null;
      if (name) {
        const hash = VH.compute(name, { seed: state.seed });
        other.hash = hash;
        copyFrame(frameOf(hash), other.frame);
        mapInto(state.mode, other.frame, other.P3);
        other.snap.set(other.P3);
        const v = createVisual(hash, compareRoot, other.P3);
        v.opacity = reduceMotion ? 1 : 0;
        other.visuals = [v];
      }
      updateCompareInfo();
      syncUi();
      writeUrl();
      kick();
    }

    function setLayout(value) {
      if (value === state.layout) return;
      const wasSide = state.compare && state.layout === "side";
      state.layout = value;
      const isSide = state.compare && value === "side";
      if (wasSide !== isSide) zoomFor(isSide);
      syncUi();
      writeUrl();
      kick();
    }

    // Side by side needs a wider shot.
    function zoomFor(side) {
      const to = camera.position.clone().sub(controls.target);
      to.setLength(THREE.MathUtils.clamp(to.length() * (side ? 1.6 : 1 / 1.6), controls.minDistance, controls.maxDistance));
      flyTo(to.add(controls.target), true);
    }

    function updateCompareInfo() {
      const info = $("compareInfo");
      if (!other.hash || !current) {
        info.innerHTML = "Type a second name to see both hashes together. The same name always gives the same image.";
        return;
      }
      const a = current, b = other.hash;
      if (a.seed.join() === b.seed.join()) {
        info.innerHTML =
          a.name === b.name
            ? "<strong>Identical.</strong> Same name, same seed, same image."
            : "<strong>Collision:</strong> two different names produce the same seed, so the images are identical." +
              (state.seed === "legacy" ? " The v3 seed tells them apart." : "");
      } else {
        info.innerHTML =
          "<strong>Different.</strong> " + a.N + "-fold vs " + b.N + "-fold symmetry, turn " + a.k + "/" + a.N + " vs " + b.k + "/" + b.N +
          ". In Overlay, matching light turns white.";
      }
    }

    // ------------------------------------------------------------ draw-on animation

    function startDraw(v) {
      draw.active = true;
      draw.t = 0;
      draw.visual = v;
      applyDraw();
    }

    function applyDraw() {
      const t = draw.t, P3 = main.P3;
      const head = clamp01(t / 0.8);
      draw.visual.layers.forEach((L, li) => {
        const p = clamp01((t - li * 0.1) / 0.8);
        L.geo.setDrawRange(0, Math.floor(p * L.count) * 3);
      });
      const hi = Math.min(SIZE, Math.floor(head * SIZE));
      curveGeo.setDrawRange(0, hi + 1);
      const cp = cometGeo.attributes.position.array;
      cp[0] = P3[(hi % SIZE) * 3];
      cp[1] = P3[(hi % SIZE) * 3 + 1];
      cp[2] = P3[(hi % SIZE) * 3 + 2];
      cometGeo.attributes.position.needsUpdate = true;
      comet.visible = head < 1;
    }

    function finishDraw() {
      if (draw.visual) draw.visual.layers.forEach((L) => L.geo.setDrawRange(0, Infinity));
      draw.active = false;
      draw.visual = null;
      curveGeo.setDrawRange(0, Infinity);
      if (!grow.active) comet.visible = false;
    }

    // Replay stays in the current form: glow forms trace in, the pendant grows along its tube.
    function replay() {
      if (state.mode === "pendant") {
        clearTimeout(pendantTimer);
        if (!pendant) buildPendant();
        if (!reduceMotion) startGrow();
      } else {
        setHash(current, "draw");
      }
      kick();
    }

    // ------------------------------------------------------------ modes

    function snapshot() {
      main.snap.set(main.P3);
      other.snap.set(other.P3);
      modeFrom = state.mode;
      if (reduceMotion) return;
      modeAnim.t = 0;
      modeAnim.active = true;
    }

    function setMode(mode) {
      if (!MODES.includes(mode) || mode === state.mode) return;
      snapshot();
      modeFrom = state.mode;
      state.mode = mode;
      if (mode === "pendant" && !state.turntable) spinHome = "zero";
      if (mode === "pendant") buildPendant();
      else removePendant();
      dirty = true;
      syncUi();
      writeUrl();
      kick();
    }

    function setLift(lift) {
      if (!SIGNALS.includes(lift) || lift === state.lift) return;
      snapshot();
      state.lift = lift;
      dirty = true;
      if (state.mode === "pendant") schedulePendant();
      syncUi();
      writeUrl();
      kick();
    }

    function setSeed(seed) {
      if (seed === state.seed) return;
      state.seed = seed;
      syncUi();
      regenerate("morph");
    }

    function setTurntable(on) {
      state.turntable = on;
      if (on) spinHome = null;
      syncUi();
      writeUrl();
      kick();
    }

    // Presets bundle the loose sliders into three named looks.
    function applyPreset(name) {
      stopAuto();
      let mode = "sculpture";
      if (name === "original") {
        // Flat, no glow, from above, settled on a symmetry angle: the 2D image inside the 3D one.
        Object.assign(opts, { liftAmount: 0, bloom: 0, exposure: 1, showCurve: false });
        state.turntable = false;
        spinHome = "sym";
        flyTo(VIEW_TOP);
      } else if (name === "showcase") {
        Object.assign(opts, { liftAmount: DEFAULTS.liftAmount, bloom: DEFAULTS.bloom, exposure: 1 });
        state.turntable = !reduceMotion;
        flyTo(VIEW_ANGLE);
      } else if (name === "print") {
        mode = "pendant";
        Object.assign(opts, { thickness: DEFAULTS.thickness, relief: DEFAULTS.relief, ring: true });
        state.turntable = false;
        spinHome = "zero";
        flyTo(VIEW_FRONT);
      }
      if (mode !== state.mode) {
        setMode(mode);
      } else {
        snapshot();
        dirty = true;
        if (mode === "pendant") schedulePendant();
      }
      syncUi();
      writeUrl();
      kick();
    }

    // ------------------------------------------------------------ pendant

    function schedulePendant() {
      clearTimeout(pendantTimer);
      pendantTimer = setTimeout(() => {
        buildPendant();
        kick();
      }, 120);
    }

    function removePendant() {
      clearTimeout(pendantTimer);
      finishGrow();
      if (!pendant) return;
      mainRoot.remove(pendant);
      pendant.traverse((o) => o.geometry && o.geometry.dispose());
      pendant = null;
      updatePendantInfo();
    }

    function buildPendant() {
      if (state.mode !== "pendant" || !current) return;
      const hash = current;
      const lift = hash.signals[state.lift];
      const oldScale = pendant ? pendant.scale.x : 0.6;
      const growing = grow.active;
      removePendant();

      const group = new THREE.Group();
      const pts = [];
      const flat = new Float32Array(Math.ceil(SIZE / 2) * 3);
      let maxR = 0, maxI = 0, topI = 0;
      for (let i = 0; i < SIZE; i++) {
        const r = Math.hypot(hash.x[i], hash.y[i]);
        if (r > maxR) { maxR = r; maxI = i; }
        if (-hash.y[i] > -hash.y[topI]) topI = i;
        if (i % 2 === 0) {
          const p = new THREE.Vector3(hash.x[i], -hash.y[i], lift[i] * opts.relief);
          flat.set([p.x, p.y, p.z], pts.length * 3);
          pts.push(p);
        }
      }
      const radial = 8;
      const path = new THREE.CatmullRomCurve3(pts, true, "centripetal");
      const tube = new THREE.Mesh(new THREE.TubeGeometry(path, SIZE, opts.thickness, radial, true), metal);
      group.add(tube);
      const extras = [];

      // The ring touches the curve at its N outermost points, so the print is one piece.
      let bailAt, ringSpec = null;
      if (opts.ring) {
        const ringZ = lift[maxI] * opts.relief;
        const ring = new THREE.Mesh(new THREE.TorusGeometry(maxR, opts.thickness * 1.15, 12, 360), metal);
        ring.position.z = ringZ;
        group.add(ring);
        extras.push(ring);
        bailAt = new THREE.Vector3(0, maxR, ringZ);
        ringSpec = { radius: maxR, tube: opts.thickness * 1.15, z: ringZ };
      } else {
        bailAt = new THREE.Vector3(hash.x[topI], -hash.y[topI], lift[topI] * opts.relief);
      }
      const bailR = 0.2;
      const bail = new THREE.Mesh(new THREE.TorusGeometry(bailR, opts.thickness * 1.3, 12, 64), metal);
      bail.rotation.y = Math.PI / 2;
      bail.position.set(bailAt.x, bailAt.y + bailR * 0.9, bailAt.z);
      group.add(bail);
      extras.push(bail);

      metal.color.setHSL(hash.layers[0].hue / 360, 0.42, 0.62);
      const outerR = opts.ring ? maxR + opts.thickness * 1.15 : maxR + opts.thickness;
      const mmScale = opts.sizeMm / 2 / outerR;

      // Bounding box at scale 1, in local units, for the size readout.
      const box = new THREE.Box3();
      group.children.forEach((m) => {
        m.updateMatrix();
        m.geometry.computeBoundingBox();
        box.union(m.geometry.boundingBox.clone().applyMatrix4(m.matrix));
      });

      group.userData = {
        tube, radial, path, extras, mmScale, box,
        tubeSegments: SIZE,
        solid: null, // cached print-ready mesh promise
        spec: {
          path: flat,
          radius: opts.thickness,
          ring: ringSpec,
          bail: { x: bail.position.x, y: bail.position.y, z: bail.position.z, radius: bailR, tube: opts.thickness * 1.3 },
          scale: mmScale,
          segments: 8,
        },
      };
      group.scale.setScalar(oldScale);
      pendant = group;
      mainRoot.add(group);
      updatePendantInfo();
      if (growing) startGrow();
    }

    function startGrow() {
      if (!pendant) return;
      grow.active = true;
      grow.t = 0;
      applyGrow();
    }

    function applyGrow() {
      const u = pendant.userData;
      const f = clamp01(grow.t / 0.85);
      u.tube.geometry.setDrawRange(0, Math.floor(f * u.tubeSegments) * u.radial * 6);
      const s = ease(clamp01((grow.t - 0.8) / 0.2));
      u.extras.forEach((m) => m.scale.setScalar(Math.max(s, 1e-4)));
      if (f < 1) {
        const p = u.path.getPointAt(f).multiplyScalar(pendant.scale.x);
        cometGeo.attributes.position.array.set([p.x, p.y, p.z]);
        cometGeo.attributes.position.needsUpdate = true;
        comet.visible = true;
      } else {
        comet.visible = false;
      }
    }

    function finishGrow() {
      if (pendant) {
        pendant.userData.tube.geometry.setDrawRange(0, Infinity);
        pendant.userData.extras.forEach((m) => m.scale.setScalar(1));
      }
      grow.active = false;
      if (!draw.active) comet.visible = false;
    }

    function updatePendantInfo() {
      const el = $("pendantInfo");
      if (!pendant) {
        el.textContent = "";
        return;
      }
      const u = pendant.userData, size = u.box.getSize(new THREE.Vector3()).multiplyScalar(u.mmScale);
      const tubeMm = 2 * opts.thickness * u.mmScale;
      const fmt = (v) => (Math.round(v * 10) / 10).toString();
      let note = "";
      if (tubeMm < 0.5) note = '<span class="warn">Tube thinner than 0.5 mm: too fragile even for resin printers.</span>';
      else if (tubeMm < 0.8) note = '<span class="warn">Tube under 0.8 mm: fine on resin, too thin for most FDM printers.</span>';
      else note = '<span class="ok">Printable on resin and FDM printers.</span>';
      el.innerHTML =
        fmt(size.x) + " × " + fmt(size.y) + " × " + fmt(size.z) + " mm · tube Ø " + fmt(tubeMm) + " mm<br>" + note;
    }

    // ------------------------------------------------------------ frame loop

    const clock = new THREE.Clock();
    const camDir = new THREE.Vector3();
    let running = false;

    // Render on demand: the loop runs while something moves and stops when the scene is still.
    function kick() {
      if (running || capturing || contextLost) return;
      running = true;
      clock.getDelta();
      requestAnimationFrame(frame);
    }

    function frame() {
      if (capturing || contextLost) {
        running = false;
        return;
      }
      // Slow devices advance in real time; only genuine stalls are capped.
      const busy = step(Math.min(clock.getDelta(), 0.25));
      composer.render();
      if (busy) requestAnimationFrame(frame);
      else running = false;
    }

    // Advances every animation by dt. Returns true while anything is still moving.
    function step(dt, spinTo) {
      moving = false;
      let busy = false;
      const lotus = state.mode === "lotus";
      const isPendant = state.mode === "pendant";

      if (morph.active) {
        morph.t = Math.min(1, morph.t + dt / morph.dur);
        const e = ease(morph.t);
        lerpFrame(morphFrom, morphTo, e, main.frame);
        main.visuals.forEach((v) => (v.opacity = v.from + (v.to - v.from) * e));
        if (morph.t >= 1) {
          morph.active = false;
          main.visuals = main.visuals.filter((v) => {
            if (v.to === 0) disposeVisual(v);
            return v.to !== 0;
          });
        }
        dirty = busy = true;
      }

      if (modeAnim.active) {
        modeAnim.t = Math.min(1, modeAnim.t + dt / modeAnim.dur);
        if (modeAnim.t >= 1) modeAnim.active = false;
        dirty = busy = true;
      }

      if (dirty) {
        updatePoints();
        dirty = false;
      }

      if (draw.active) {
        draw.t = Math.min(1, draw.t + dt / draw.dur);
        applyDraw();
        if (draw.t >= 1) finishDraw();
        busy = true;
      }

      if (grow.active && pendant) {
        grow.t = Math.min(1, grow.t + dt / grow.dur);
        applyGrow();
        if (grow.t >= 1) finishGrow();
        busy = true;
      }

      // Turntable: the objects turn in place, so side-by-side compare does not orbit.
      const sym = TAU / (current ? current.N : 7);
      if (spinTo !== undefined) spinAngle = spinTo;
      else if (recording && recording.kind === "turntable") spinAngle = recording.spin0 + TAU * clamp01(recording.t / recording.dur);
      else if (state.turntable) {
        spinAngle += TURN_SPEED * dt;
        busy = true;
      } else if (spinHome) {
        const unit = spinHome === "zero" ? TAU : sym;
        spinAngle = approach(spinAngle, Math.round(spinAngle / unit) * unit, 4, dt);
      }
      mainRoot.rotation.z = compareRoot.rotation.z = spinAngle;

      // Lotus: layers drift apart and spin; elsewhere they settle back onto a
      // multiple of 2π/N, which looks identical thanks to the N-fold symmetry.
      for (let i = 0; i < 3; i++) {
        layerZ[i] = approach(layerZ[i], lotus ? (1 - i) * opts.explode : 0, 5, dt);
        if (lotus && opts.spin && !reduceMotion) {
          layerRot[i] += LAYER_SPIN[i] * dt;
          busy = true;
        } else {
          layerRot[i] = approach(layerRot[i], Math.round(layerRot[i] / sym) * sym, 3, dt);
        }
        const target = state.hidden[i] ? 0 : hoverLayer >= 0 && hoverLayer !== i ? 0.15 : 1;
        layerVis[i] = approach(layerVis[i], target, 10, dt);
      }
      triFade = approach(triFade, isPendant ? 0 : 1, 6, dt);

      const comparing = !!other.hash, side = comparing && state.layout === "side";
      layout.main = approach(layout.main, side ? -SIDE_GAP : 0, 6, dt);
      layout.other = approach(layout.other, side ? SIDE_GAP : 0, 6, dt);
      layout.tint = approach(layout.tint, comparing && state.layout === "overlay" ? 1 : 0, 6, dt);
      mainRoot.position.x = layout.main;
      compareRoot.position.x = layout.other;
      other.visuals.forEach((v) => (v.opacity = approach(v.opacity, 1, 6, dt)));

      if (camAnim.active) {
        camAnim.t = Math.min(1, camAnim.t + dt / camAnim.dur);
        const e = ease(camAnim.t);
        const len = camAnim.from.length() + (camAnim.to.length() - camAnim.from.length()) * e;
        camera.position.lerpVectors(camAnim.from, camAnim.to, e).setLength(len);
        if (camAnim.t >= 1) camAnim.active = false;
        busy = true;
      }
      if (controls.update()) busy = true;

      camera.getWorldDirection(camDir);
      const gTo = footprint(state.mode, camDir);
      const gFrom = modeAnim.active ? footprint(modeFrom, camDir) : gTo;
      shadeG.value = Math.max(0.02, gFrom + (gTo - gFrom) * (modeAnim.active ? ease(modeAnim.t) : 1));

      const styleTrack = (track, tint) =>
        track.visuals.forEach((v) => {
          v.layers.forEach((L, i) => {
            L.pivot.position.z = layerZ[i];
            L.pivot.rotation.z = layerRot[i];
            const m = L.mesh.material;
            m.opacity = v.opacity * triFade * opts.exposure * layerVis[i];
            m.userData.tint.value.setRGB(tint[0], tint[1], tint[2]);
            m.userData.tintMix.value = layout.tint;
            L.mesh.visible = m.opacity > 0.002;
          });
        });
      styleTrack(main, TINT_A);
      styleTrack(other, TINT_B);

      const curveTarget = draw.active ? 0.7 : opts.showCurve && !isPendant ? 0.25 : 0;
      curveOpacity = approach(curveOpacity, curveTarget, 6, dt);
      curveMat.opacity = curveOpacity;
      curveLine.visible = curveOpacity > 0.002;

      if (pendant) pendant.scale.setScalar(approach(pendant.scale.x, 1, 7, dt));

      // Glow modes keep the original's additive sRGB math; the pendant gets a lit, tone-mapped look.
      renderer.outputColorSpace = isPendant ? THREE.SRGBColorSpace : THREE.LinearSRGBColorSpace;
      renderer.toneMapping = isPendant ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping;
      scene.background = isPendant ? BG_METAL : BG_GLOW;
      composer = isPendant ? metalComposer : glowComposer;
      composer.bloom.strength = isPendant ? opts.bloom * 0.12 : opts.bloom;
      composer.bloom.threshold = isPendant ? 0.9 : 0.5;

      if (recording) {
        recording.t += dt;
        if (recording.t >= recording.dur) stopRecording();
        busy = true;
      }
      return busy || moving;
    }

    // ------------------------------------------------------------ UI

    const nameInput = $("name");
    const compareInput = $("compareName");

    function syncUi() {
      document.querySelectorAll("[data-group]").forEach((g) => {
        const value = state[g.dataset.group];
        g.querySelectorAll("[role=radio]").forEach((b) => {
          const on = b.dataset.value === value;
          b.setAttribute("aria-checked", String(on));
          b.tabIndex = on ? 0 : -1;
        });
      });
      document.querySelectorAll(".mode-opts").forEach((el) =>
        el.classList.toggle("active", el.dataset.for.split(" ").includes(state.mode))
      );
      document.querySelectorAll("[data-opt]").forEach((el) => {
        if (el.type === "checkbox") el.checked = !!opts[el.dataset.opt];
        else el.value = opts[el.dataset.opt];
      });
      $("rotateBtn").setAttribute("aria-pressed", String(state.turntable));
      $("autoBtn").setAttribute("aria-pressed", String(!!autoTimer));
      $("autoBtn").textContent = autoTimer ? "Stop auto" : "Auto random";
      $("seedHint").hidden = !(state.seed === "legacy" && state.name.length > 16);
      $("compareOpts").hidden = !state.compare;
      if (compareInput.value !== state.compare) compareInput.value = state.compare;
      document.querySelectorAll("#layers [data-layer]").forEach((b) =>
        b.setAttribute("aria-pressed", String(!state.hidden[+b.dataset.layer]))
      );
    }

    function updateInfo(hash) {
      const hue = hash.layers[0].hue;
      document.documentElement.style.setProperty("--accent", "hsl(" + hue + " 78% 66%)");
      $("hudName").textContent = hash.name || "(empty)";
      $("hudMeta").textContent =
        hash.N + "-fold symmetry · turn " + hash.k + "/" + hash.N + " · " + (hash.seedMode === "v3" ? "v3 SHA-256" : "legacy") + " seed";
      document.title = (hash.name ? hash.name + " · " : "") + "Visual Hashing 3D";

      const f = (v) => (Math.round(v * 1000) / 1000).toString();
      const rows = [
        ["Symmetry", hash.N + "-fold (N = " + hash.N + ")"],
        ["Base turn", "pr = " + hash.k + "/" + hash.N],
        ["Epicycles", "q0 " + f(hash.q[0]) + " · q1 " + f(hash.q[1])],
        ["Waves", "q2..q7 = " + hash.q.slice(2).join(", ")],
        ["Amplitudes", "h0 " + f(hash.h[0]) + " · h2 " + f(hash.h[2]) + " · h3 " + f(hash.h[3])],
        ["FM depth", "h5 " + f(hash.h[5]) + " · h7 " + f(hash.h[7])],
        ["Seed", "<code>" + hash.seed.join(" ") + "</code>"],
      ];
      $("dna").innerHTML = rows.map((r) => "<dt>" + r[0] + "</dt><dd>" + r[1] + "</dd>").join("");
      $("layers").innerHTML = hash.layers
        .map(
          (L, i) =>
            '<button type="button" class="layer" data-layer="' + i + '" aria-pressed="' + !state.hidden[i] +
            '" title="Show or hide layer ' + (i + 1) + '"><i style="background:hsl(' + L.hue + " " + L.sat +
            '% 50%)"></i><span>Layer ' + (i + 1) + " · stride " + L.stride + "</span><span>" + L.count + " tris</span></button>"
        )
        .join("");
      updateCompareInfo();
      syncUi();
    }

    function toast(message, sticky) {
      const el = $("toast");
      el.textContent = message;
      el.classList.add("show");
      clearTimeout(toast.timer);
      if (!sticky) toast.timer = setTimeout(() => el.classList.remove("show"), 2200);
    }

    function randomName() {
      state.name = window.chance ? chance.name({ middle: true }) : "Name " + ((Math.random() * 1e6) | 0);
      nameInput.value = state.name;
      regenerate("morph");
    }

    function stopAuto() {
      clearInterval(autoTimer);
      autoTimer = 0;
      syncUi();
    }

    function flyTo(target, keepTarget) {
      if (!keepTarget) controls.target.set(0, 0, 0);
      if (reduceMotion) {
        camera.position.copy(target);
        kick();
        return;
      }
      camAnim.from.copy(camera.position);
      camAnim.to.copy(target);
      camAnim.t = 0;
      camAnim.active = true;
      kick();
    }

    nameInput.value = state.name;
    nameInput.addEventListener("input", () => {
      stopAuto();
      state.name = nameInput.value;
      regenerate("morph");
    });
    $("nameForm").addEventListener("submit", (e) => {
      e.preventDefault();
      stopAuto();
      state.name = nameInput.value;
      regenerate("draw");
    });
    $("randomBtn").addEventListener("click", () => {
      stopAuto();
      randomName();
    });
    $("autoBtn").addEventListener("click", () => {
      if (autoTimer) return stopAuto();
      randomName();
      autoTimer = setInterval(randomName, 2600);
      syncUi();
    });
    $("useV3Btn").addEventListener("click", () => setSeed("v3"));

    let compareTimer = 0;
    compareInput.addEventListener("input", () => {
      clearTimeout(compareTimer);
      compareTimer = setTimeout(() => {
        const was = !!state.compare && state.layout === "side";
        setCompare(compareInput.value);
        const is = !!state.compare && state.layout === "side";
        if (was !== is) zoomFor(is);
      }, 120);
    });
    $("compareForm").addEventListener("submit", (e) => e.preventDefault());
    $("collisionBtn").addEventListener("click", () => {
      stopAuto();
      const was = !!state.compare && state.layout === "side";
      state.seed = "legacy";
      state.name = nameInput.value = "A123456789012345B";
      regenerate("morph");
      setCompare("B123456789012345A");
      if (!was && state.layout === "side") zoomFor(true);
    });
    $("clearCompareBtn").addEventListener("click", () => {
      const was = !!state.compare && state.layout === "side";
      setCompare("");
      if (was) zoomFor(false);
    });

    // Segmented controls are radio groups: one tab stop, arrow keys move the choice.
    function choose(group, value) {
      if (group === "mode") setMode(value);
      else if (group === "lift") setLift(value);
      else if (group === "seed") setSeed(value);
      else if (group === "layout") setLayout(value);
    }
    document.querySelectorAll("[data-group]").forEach((g) => {
      g.setAttribute("role", "radiogroup");
      g.querySelectorAll("button").forEach((b) => b.setAttribute("role", "radio"));
      g.addEventListener("click", (e) => {
        const b = e.target.closest("button");
        if (b) choose(g.dataset.group, b.dataset.value);
      });
      g.addEventListener("keydown", (e) => {
        const dir = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
        if (!dir) return;
        e.preventDefault();
        const buttons = Array.from(g.querySelectorAll("[role=radio]"));
        const i = buttons.indexOf(document.activeElement);
        const next = buttons[(i + dir + buttons.length) % buttons.length];
        choose(g.dataset.group, next.dataset.value);
        next.focus();
      });
    });

    document.querySelectorAll("[data-opt]").forEach((el) => {
      el.addEventListener("input", () => {
        const key = el.dataset.opt;
        opts[key] = el.type === "checkbox" ? el.checked : parseFloat(el.value);
        dirty = true;
        if (["thickness", "relief", "ring", "sizeMm"].includes(key)) schedulePendant();
        syncUi();
        if (key !== "glowTube") writeUrl();
        kick();
      });
    });

    document.querySelectorAll("[data-preset]").forEach((b) =>
      b.addEventListener("click", () => applyPreset(b.dataset.preset))
    );

    const layersEl = $("layers");
    layersEl.addEventListener("click", (e) => {
      const b = e.target.closest("[data-layer]");
      if (!b) return;
      const i = +b.dataset.layer;
      state.hidden[i] = !state.hidden[i];
      syncUi();
      writeUrl();
      kick();
    });
    const hoverOn = (e) => {
      const b = e.target.closest("[data-layer]");
      hoverLayer = b ? +b.dataset.layer : -1;
      kick();
    };
    const hoverOff = () => {
      hoverLayer = -1;
      kick();
    };
    layersEl.addEventListener("pointerover", hoverOn);
    layersEl.addEventListener("pointerleave", hoverOff);
    layersEl.addEventListener("focusin", hoverOn);
    layersEl.addEventListener("focusout", hoverOff);

    $("topBtn").addEventListener("click", () => flyTo(VIEW_TOP));
    $("angleBtn").addEventListener("click", () => flyTo(VIEW_ANGLE));
    $("replayBtn").addEventListener("click", replay);
    $("rotateBtn").addEventListener("click", () => setTurntable(!state.turntable));

    // ------------------------------------------------------------ keyboard + help

    const help = $("help");
    function toggleHelp(show) {
      help.hidden = show === undefined ? !help.hidden : !show;
      $("helpBtn").setAttribute("aria-expanded", String(!help.hidden));
    }
    $("helpBtn").addEventListener("click", () => toggleHelp());
    $("helpClose").addEventListener("click", () => toggleHelp(false));

    document.addEventListener("keydown", (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target;
      const typing = t && ((t.tagName === "INPUT" && t.type === "text") || t.tagName === "TEXTAREA" || t.isContentEditable);
      if (typing) {
        if (e.key === "Escape") t.blur();
        return;
      }
      if (e.key === "Escape") {
        if (!help.hidden) toggleHelp(false);
        return;
      }
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (k >= "1" && k <= "5") setMode(MODES[+k - 1]);
      else if (k === "t") flyTo(VIEW_TOP);
      else if (k === "a") flyTo(VIEW_ANGLE);
      else if (k === "r") replay();
      else if (k === "o") applyPreset("original");
      else if (k === "s") applyPreset("showcase");
      else if (k === "p") applyPreset("print");
      else if (k === "c") copyLink();
      else if (k === "/") nameInput.focus();
      else if (k === "?") toggleHelp();
      else if (k === " ") {
        // Space keeps its normal meaning on buttons and checkboxes.
        if (t && /^(BUTTON|INPUT|SELECT|A)$/.test(t.tagName)) return;
        setTurntable(!state.turntable);
      } else return;
      e.preventDefault();
    });

    // ------------------------------------------------------------ export + sharing

    function fileBase() {
      return (state.name.trim() || "visual-hash").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 60);
    }

    function download(data, filename, type) {
      const url = typeof data === "string" ? data : URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type: type }));
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      if (url !== data) setTimeout(() => URL.revokeObjectURL(url), 4000);
    }

    function metadata() {
      return {
        visualHash: {
          app: "Visual Hashing 3D",
          name: current.name,
          seedMode: current.seedMode,
          seed: current.seed.join(" "),
          symmetry: current.N,
          turn: current.k + "/" + current.N,
          form: state.mode,
          link: shareUrl(true),
        },
      };
    }

    $("png3dBtn").addEventListener("click", () => {
      composer.render();
      download(renderer.domElement.toDataURL("image/png"), fileBase() + "-3d.png");
    });

    $("png2dBtn").addEventListener("click", () => {
      const c = document.createElement("canvas");
      c.width = c.height = 1200;
      VH.render2D(current, c.getContext("2d"), 3);
      download(c.toDataURL("image/png"), fileBase() + ".png");
    });

    // Glow forms: bake the alpha you currently see into the vertex colours, so other
    // viewers (which blend, not add) show the same light. Optional emissive curve tube.
    function glowExport() {
      scene.updateMatrixWorld(true);
      const out = new THREE.Group();
      out.name = "visual-hash";
      const v = main.visuals[main.visuals.length - 1];
      const nm = new THREE.Matrix3();
      const mv = new THREE.Matrix4();
      v.layers.forEach((L, i) => {
        if (state.hidden[i]) return;
        mv.multiplyMatrices(camera.matrixWorldInverse, L.mesh.matrixWorld);
        nm.getNormalMatrix(mv);
        const e = nm.elements;
        const col = L.geo.attributes.color.array.slice();
        const light = L.geo.attributes.triLight.array, cr = L.cross;
        for (let t = 0; t < L.count; t++) {
          const o = t * 9;
          const z = e[2] * cr[o] + e[5] * cr[o + 1] + e[8] * cr[o + 2];
          const lt = light[t * 6], a2 = light[t * 6 + 1];
          const shaded = Math.min(Math.min(1, a2 * MAX_GAIN), (2 * lt * shadeG.value) / Math.max(Math.abs(z), 1e-9));
          const a = Math.min(1, shaded * opts.exposure);
          for (let k = 0; k < 3; k++) col[(t * 3 + k) * 4 + 3] = a;
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", L.geo.attributes.position.clone());
        geo.setAttribute("color", new THREE.BufferAttribute(col, 4));
        const mesh = new THREE.Mesh(
          geo,
          new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide })
        );
        mesh.name = "layer-" + (i + 1);
        const pivot = new THREE.Group();
        pivot.position.copy(L.pivot.position);
        pivot.rotation.copy(L.pivot.rotation);
        pivot.add(mesh);
        out.add(pivot);
      });
      if (opts.glowTube) {
        const pts = [];
        for (let i = 0; i < SIZE; i += 2) pts.push(new THREE.Vector3(main.P3[i * 3], main.P3[i * 3 + 1], main.P3[i * 3 + 2]));
        const color = new THREE.Color().setHSL(current.layers[0].hue / 360, 0.8, 0.6);
        const tube = new THREE.Mesh(
          new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, true, "centripetal"), SIZE, 0.006, 6, true),
          new THREE.MeshStandardMaterial({ color: 0x000000, emissive: color, emissiveIntensity: 4 })
        );
        tube.name = "curve";
        out.add(tube);
      }
      return out;
    }

    $("glbBtn").addEventListener("click", () => {
      finishDraw();
      finishGrow();
      let target;
      if (state.mode === "pendant" && pendant) {
        target = pendant.clone();
        target.scale.setScalar(1);
      } else {
        target = glowExport();
      }
      target.userData = metadata();
      new deps.GLTFExporter().parse(
        target,
        (glb) => download(glb, fileBase() + "-" + state.mode + ".glb", "model/gltf-binary"),
        (err) => {
          console.error(err);
          toast("GLB export failed");
        },
        { binary: true }
      );
    });

    // Print-ready pendant: one watertight solid via manifold-3d, raw tube as fallback.
    // The self-crossing tube is unioned from ~2300 capsules in a Worker (10–15 s).
    function solidPendant() {
      const u = pendant.userData;
      if (!u.solid) {
        const progress = (f) => toast("Building a watertight solid… " + Math.round(f * 100) + "%", true);
        u.solid = window.VHSolid
          ? VHSolid.load().then(() => VHSolid.pendant(u.spec, progress))
          : Promise.reject(new Error("solidify.js not loaded"));
        u.solid.catch(() => (u.solid = null));
      }
      return u.solid;
    }

    // Raw meshes of the preview pendant (self-intersecting), scaled to mm.
    function rawPendant() {
      const positions = [], indices = [], u = pendant.userData;
      pendant.children.forEach((m) => {
        m.updateMatrix();
        const g = m.geometry.index ? m.geometry : m.geometry.toNonIndexed();
        const p = g.attributes.position, base = positions.length / 3, v = new THREE.Vector3();
        for (let i = 0; i < p.count; i++) {
          v.fromBufferAttribute(p, i).applyMatrix4(m.matrix).multiplyScalar(u.mmScale);
          positions.push(v.x, v.y, v.z);
        }
        if (g.index) for (let i = 0; i < g.index.count; i++) indices.push(base + g.index.getX(i));
        else for (let i = 0; i < p.count; i++) indices.push(base + i);
      });
      return { positions: new Float32Array(positions), indices: new Uint32Array(indices), raw: true };
    }

    async function printMesh() {
      if (state.mode !== "pendant") return null;
      clearTimeout(pendantTimer);
      if (!pendant) buildPendant();
      finishGrow();
      const buttons = [$("stlBtn"), $("threemfBtn")];
      buttons.forEach((b) => (b.disabled = true));
      toast("Building a watertight solid…", true);
      try {
        const solid = await solidPendant();
        toast("Solid ready · " + Math.round(solid.indices.length / 3).toLocaleString() + " triangles, watertight");
        return solid;
      } catch (err) {
        console.error(err);
        toast("Could not merge the solid; exporting the raw tube instead");
        return rawPendant();
      } finally {
        buttons.forEach((b) => (b.disabled = false));
      }
    }

    $("stlBtn").addEventListener("click", async () => {
      const mesh = await printMesh();
      if (!mesh) return;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
      geo.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
      const stl = new deps.STLExporter().parse(new THREE.Mesh(geo), { binary: true });
      download(stl, fileBase() + "-pendant.stl", "model/stl");
    });

    $("threemfBtn").addEventListener("click", async () => {
      const mesh = await printMesh();
      if (!mesh || !window.VH3MF) return;
      const meta = metadata().visualHash;
      const bytes = VH3MF.build(mesh, {
        title: (current.name || "Visual hash") + " pendant",
        designer: "Visual Hashing 3D",
        description: "Pendant generated from the name \"" + current.name + "\" (" + meta.seedMode + " seed " + meta.seed + ").",
        metadata: { seed: meta.seed, seedMode: meta.seedMode, link: meta.link },
      });
      download(bytes, fileBase() + "-pendant.3mf", "model/3mf");
    });

    // ------------------------------------------------------------ video + GIF

    function prepareClip(kind) {
      finishDraw();
      finishGrow();
      if (kind === "draw") {
        if (state.mode === "pendant") startGrow();
        else {
          const saved = reduceMotion;
          setHash(current, saved ? "instant" : "draw");
          if (!draw.active) startDraw(main.visuals[0]);
        }
        return draw.dur + 0.6;
      }
      return 8;
    }

    function stopRecording() {
      const r = recording;
      recording = null;
      if (r && r.recorder.state !== "inactive") r.recorder.stop();
    }

    $("videoDrawBtn").addEventListener("click", () => recordVideo("draw"));
    $("videoTurnBtn").addEventListener("click", () => recordVideo("turntable"));
    $("gifDrawBtn").addEventListener("click", () => recordGif("draw"));
    $("gifTurnBtn").addEventListener("click", () => recordGif("turntable"));

    function recordVideo(kind) {
      if (recording || capturing) return;
      if (!stage.captureStream || !window.MediaRecorder) return toast("This browser cannot record video");
      const types = ["video/mp4;codecs=avc1", "video/mp4", "video/webm;codecs=vp9", "video/webm"];
      const mime = types.find((t) => MediaRecorder.isTypeSupported(t)) || "";
      const recorder = new MediaRecorder(stage.captureStream(60), mime ? { mimeType: mime, videoBitsPerSecond: 8e6 } : undefined);
      const chunks = [];
      recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      recorder.onstop = () => {
        const type = recorder.mimeType || mime || "video/webm";
        download(new Blob(chunks, { type: type }), fileBase() + "-" + kind + (type.includes("mp4") ? ".mp4" : ".webm"));
        toast("Video saved");
      };
      const dur = prepareClip(kind);
      recording = { kind, recorder, t: 0, dur, spin0: spinAngle };
      recorder.start();
      toast("Recording " + Math.round(dur) + " s…", true);
      kick();
    }

    // GIF frames are rendered offline at a fixed step, so slow machines still get smooth loops.
    async function recordGif(kind) {
      if (recording || capturing || !window.VHGif) return;
      capturing = true;
      const fps = 15, size = 400, frames = [];
      const dur = kind === "draw" ? prepareClip("draw") : 6;
      const total = Math.round(dur * fps), spin0 = spinAngle;
      const c = document.createElement("canvas");
      c.width = c.height = size;
      const g = c.getContext("2d", { willReadFrequently: true });
      try {
        for (let i = 0; i < total; i++) {
          step(i === 0 ? 0 : 1 / fps, kind === "turntable" ? spin0 + (TAU * i) / total : undefined);
          composer.render();
          const w = stage.width, h = stage.height, s = Math.min(w, h);
          g.drawImage(stage, (w - s) / 2, (h - s) / 2, s, s, 0, 0, size, size);
          frames.push(g.getImageData(0, 0, size, size));
          if (i % 5 === 0) {
            toast("Rendering GIF frames " + Math.round((100 * i) / total) + "%", true);
            await new Promise((r) => setTimeout(r, 0));
          }
        }
      } finally {
        capturing = false;
        kick();
      }
      const bytes = await VHGif.encodeAsync(frames, { delay: Math.round(100 / fps), loop: 0 }, (p) =>
        toast("Encoding GIF " + Math.round(p * 100) + "%", true)
      );
      download(bytes, fileBase() + "-" + kind + ".gif", "image/gif");
      toast("GIF saved");
    }

    // ------------------------------------------------------------ URL state

    function round(v, d) {
      const m = Math.pow(10, d);
      return Math.round(v * m) / m;
    }

    function vecStr(v) {
      return [v.x, v.y, v.z].map((n) => round(n, 2)).join(",");
    }

    // full = also the exact camera and turntable angle (Copy link); the address bar skips them.
    function shareUrl(full) {
      const p = new URLSearchParams();
      p.set("name", state.name);
      if (state.seed !== "legacy") p.set("seed", state.seed);
      if (state.mode !== "sculpture") p.set("mode", state.mode);
      if (state.lift !== "radius") p.set("lift", state.lift);
      Object.keys(URL_KEYS).forEach((k) => {
        if (opts[k] === DEFAULTS[k]) return;
        p.set(URL_KEYS[k], typeof opts[k] === "boolean" ? (opts[k] ? "1" : "0") : String(round(opts[k], 3)));
      });
      if (state.compare) {
        p.set("cmp", state.compare);
        if (state.layout !== "side") p.set("lay", state.layout);
      }
      const hide = state.hidden.map((h, i) => (h ? i + 1 : "")).join("");
      if (hide) p.set("hide", hide);
      if (state.turntable === reduceMotion) p.set("tt", state.turntable ? "1" : "0");
      if (full) {
        p.set("cam", vecStr(camera.position));
        if (controls.target.lengthSq() > 1e-6) p.set("tgt", vecStr(controls.target));
        const a = ((spinAngle % TAU) + TAU) % TAU;
        if (a > 1e-3) p.set("rot", String(round(a, 3)));
      }
      return location.href.split(/[?#]/)[0] + "?" + p.toString();
    }

    function writeUrl() {
      clearTimeout(urlTimer);
      urlTimer = setTimeout(() => {
        const p = new URLSearchParams();
        p.set("name", state.name);
        if (state.seed !== "legacy") p.set("seed", state.seed);
        $("flatLink").href = "../index.html?" + p.toString();
        try {
          history.replaceState(null, "", shareUrl(false));
        } catch (e) {
          /* some browsers refuse replaceState on file:// */
        }
      }, 250);
    }

    function readUrl() {
      const p = new URLSearchParams(location.search);
      const mode = p.get("mode"), lift = p.get("lift"), hide = p.get("hide") || "";
      const st = {
        name: p.has("name") ? p.get("name") : "Gun Gun Feb",
        seed: p.get("seed") === "v3" ? "v3" : "legacy",
        mode: MODES.includes(mode) ? mode : "sculpture",
        lift: SIGNALS.includes(lift) ? lift : "radius",
        compare: p.get("cmp") || "",
        layout: p.get("lay") === "overlay" ? "overlay" : "side",
        hidden: [0, 1, 2].map((i) => hide.includes(String(i + 1))),
        turntable: reduceMotion ? false : p.has("tt") ? p.get("tt") !== "0" : true,
      };
      const o = Object.assign({}, DEFAULTS);
      Object.keys(URL_KEYS).forEach((k) => {
        if (!p.has(URL_KEYS[k])) return;
        const raw = p.get(URL_KEYS[k]);
        if (typeof DEFAULTS[k] === "boolean") {
          o[k] = raw !== "0";
          return;
        }
        const v = parseFloat(raw), el = document.querySelector('input[data-opt="' + k + '"]');
        if (isFinite(v)) o[k] = el ? Math.min(+el.max, Math.max(+el.min, v)) : v;
      });
      const vec = (s) => {
        const a = (s || "").split(",").map(Number);
        return a.length === 3 && a.every(isFinite) ? new THREE.Vector3(a[0], a[1], a[2]) : null;
      };
      let cam = vec(p.get("cam"));
      if (cam) cam.setLength(THREE.MathUtils.clamp(cam.length(), 2.5, 20));
      return { state: st, opts: o, view: { cam: cam, target: vec(p.get("tgt")), spin: parseFloat(p.get("rot")) || 0 } };
    }

    function copyLink() {
      const url = shareUrl(true);
      const done = () => toast("Link copied, with this exact view");
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(done, () => window.prompt("Copy this link", url));
      } else {
        window.prompt("Copy this link", url);
      }
    }
    $("linkBtn").addEventListener("click", copyLink);

    // ------------------------------------------------------------ mobile bottom sheet

    const panel = $("panel");
    const sheetMq = window.matchMedia("(max-width: 860px)");
    const sheet = { state: "peek", dragging: false, y0: 0, start: 0, offset: 0, moved: false };

    function sheetStops() {
      const h = panel.offsetHeight;
      const peek = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--peek")) || 184;
      return { full: 0, half: Math.max(0, h * 0.5), peek: Math.max(0, h - peek) };
    }

    function setSheet(name) {
      sheet.state = name;
      if (!sheetMq.matches) {
        panel.style.transform = "";
        panel.dataset.sheet = "";
        return;
      }
      panel.dataset.sheet = name;
      panel.style.transform = "translateY(" + sheetStops()[name] + "px)";
      $("sheetHandle").setAttribute("aria-expanded", String(name !== "peek"));
    }

    $("sheetHandle").addEventListener("pointerdown", (e) => {
      if (!sheetMq.matches) return;
      sheet.dragging = true;
      sheet.moved = false;
      sheet.y0 = e.clientY;
      sheet.start = sheetStops()[sheet.state];
      panel.classList.add("dragging");
      e.currentTarget.setPointerCapture(e.pointerId);
    });
    $("sheetHandle").addEventListener("pointermove", (e) => {
      if (!sheet.dragging) return;
      const dy = e.clientY - sheet.y0;
      if (Math.abs(dy) > 4) sheet.moved = true;
      const stops = sheetStops();
      sheet.offset = THREE.MathUtils.clamp(sheet.start + dy, stops.full, stops.peek);
      panel.style.transform = "translateY(" + sheet.offset + "px)";
    });
    $("sheetHandle").addEventListener("pointerup", () => {
      if (!sheet.dragging) return;
      sheet.dragging = false;
      panel.classList.remove("dragging");
      if (!sheet.moved) {
        setSheet({ peek: "half", half: "full", full: "peek" }[sheet.state]);
        return;
      }
      const stops = sheetStops();
      let best = "peek";
      Object.keys(stops).forEach((k) => {
        if (Math.abs(stops[k] - sheet.offset) < Math.abs(stops[best] - sheet.offset)) best = k;
      });
      setSheet(best);
    });
    $("sheetHandle").addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      setSheet({ peek: "half", half: "full", full: "peek" }[sheet.state]);
    });
    sheetMq.addEventListener("change", () => setSheet("peek"));
    window.addEventListener("resize", () => setSheet(sheet.state));

    // ------------------------------------------------------------ lost graphics context

    stage.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      contextLost = true;
      fail("The graphics context was lost (driver reset or too many tabs). Restoring…");
    });
    stage.addEventListener("webglcontextrestored", () => {
      contextLost = false;
      $("fallback").hidden = true;
      makeEnvironment();
      setHash(current, "instant");
      if (state.compare) setCompare(state.compare);
      if (state.mode === "pendant") buildPendant();
      resize();
      kick();
    });

    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) kick();
    });

    // ------------------------------------------------------------ helpers

    function ease(t) {
      return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    }

    // Exponential approach that snaps when close, so the render loop can go idle.
    function approach(a, b, lambda, dt) {
      const v = b + (a - b) * Math.exp(-lambda * dt);
      if (Math.abs(v - b) > 1e-4) {
        moving = true;
        return v;
      }
      return b;
    }

    function clamp01(v) {
      return v < 0 ? 0 : v > 1 ? 1 : v;
    }

    function glowTexture() {
      const c = document.createElement("canvas");
      c.width = c.height = 64;
      const g = c.getContext("2d");
      const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      grd.addColorStop(0, "rgba(255,255,255,1)");
      grd.addColorStop(0.2, "rgba(255,255,255,0.7)");
      grd.addColorStop(1, "rgba(255,255,255,0)");
      g.fillStyle = grd;
      g.fillRect(0, 0, 64, 64);
      return new THREE.CanvasTexture(c);
    }

    // ------------------------------------------------------------ go

    resize();
    setSheet("peek");
    syncUi();
    setHash(VH.compute(state.name, { seed: state.seed }), "draw");
    if (state.compare) {
      setCompare(state.compare);
      if (!initial.view.cam && state.layout === "side") camera.position.multiplyScalar(1.6);
    }
    if (state.mode === "pendant") buildPendant();
    kick();

    VH3D.debug = {
      state, opts, setMode, setLift, setSeed, setCompare, setLayout, applyPreset, flyTo, replay, camera, controls,
      draw, grow, morph, shadeG, step, shareUrl,
      get running() { return running; },
      get current() { return current; },
      get pendant() { return pendant; },
      renderer,
      render: () => composer.render(),
    };
  }
})();
