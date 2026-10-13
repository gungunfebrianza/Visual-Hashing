/*
 * Visual Hashing 3D — three.js front end for visualhash.js.
 *
 * Plain script: three.js and its addons are imported by a small module in
 * index.html and handed to VH3D.start(), so the page also runs from file://.
 *
 * Pipeline per frame:
 *   hash (2D points + signals) --morph--> disp --map(mode)--> P3 (3D points)
 *   P3 --gather by triangle index--> layer meshes (additive, alpha = 55/area)
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
    const PENDANT_MM = 40;
    const $ = (id) => document.getElementById(id);

    // ------------------------------------------------------------ state

    const state = readUrl();
    const opts = {
      liftAmount: 0.55,
      explode: 0.85,
      spin: true,
      bloom: 0.6,
      exposure: 1,
      showCurve: false,
      thickness: 0.045,
      relief: 0.12,
      ring: true,
    };

    let current = null; // hash being shown (or morphed to)
    let visuals = []; // triangle sets; >1 only while cross-fading
    let dirty = true; // P3 needs recomputing
    let pendant = null;
    let pendantTimer = 0;
    let autoTimer = 0;
    let urlTimer = 0;
    let triFade = 1;
    let curveOpacity = 0;
    let viewExposure = 1;

    const morph = { active: false, t: 1, dur: 0.9 };
    const modeAnim = { active: false, t: 1, dur: 0.9 };
    const draw = { active: false, t: 0, dur: 3.4, visual: null };
    const camAnim = { active: false, t: 0, dur: 1.1, from: new THREE.Vector3(), to: new THREE.Vector3() };
    const layerZ = [0, 0, 0];
    const layerRot = [0, 0, 0];

    const disp = emptyFrame(); // 2D points + signals currently displayed
    const morphFrom = emptyFrame();
    let morphTo = null;
    const P3 = new Float32Array(SIZE * 3); // mapped 3D points
    const mapTmp = new Float32Array(SIZE * 3);
    const modeSnap = new Float32Array(SIZE * 3);

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
    camera.position.copy(VIEW_ANGLE);

    const controls = new deps.OrbitControls(camera, stage);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 2.5;
    controls.maxDistance = 20;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.6;
    controls.addEventListener("start", () => (camAnim.active = false));

    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new deps.RoomEnvironment(renderer), 0.04).texture;
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

    const world = new THREE.Group();
    scene.add(world);

    function resize() {
      const w = stage.clientWidth, h = stage.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      glowComposer.setSize(w, h);
      metalComposer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
    new ResizeObserver(resize).observe(stage);
    resize();

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
    world.add(curveLine);

    // Comet head for the draw-on animation.
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
    world.add(comet);

    const metal = new THREE.MeshStandardMaterial({ metalness: 1, roughness: 0.3 });

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

    // ------------------------------------------------------------ 2D -> 3D mappings

    // Canvas y grows downward; flip it so the top view matches the original image.
    function mapInto(mode, out) {
      const x = disp.x, y = disp.y;
      if (mode === "sculpture" || mode === "pendant" || mode === "lotus") {
        const s = disp.sig[mode === "sculpture" ? state.lift : "radius"];
        const amp = mode === "sculpture" ? opts.liftAmount : mode === "pendant" ? opts.relief : 0;
        for (let i = 0, o = 0; i < SIZE; i++, o += 3) {
          out[o] = x[i];
          out[o + 1] = -y[i];
          out[o + 2] = s[i] * amp;
        }
      } else if (mode === "sphere") {
        // Inverse stereographic projection: conformal, centre -> north pole.
        const R = 1.75;
        for (let i = 0, o = 0; i < SIZE; i++, o += 3) {
          const u = x[i], v = -y[i], rr = u * u + v * v, d = 1 + rr;
          out[o] = (R * 2 * u) / d;
          out[o + 1] = (R * 2 * v) / d;
          out[o + 2] = (R * (1 - rr)) / d;
        }
      } else if (mode === "torus") {
        // Angle -> around the ring, radius -> around the tube (inner edge, over the top, outside).
        const R = 1.45, r = 0.62;
        for (let i = 0, o = 0; i < SIZE; i++, o += 3) {
          const u = x[i], v = -y[i];
          const theta = Math.atan2(v, u);
          const phi = Math.PI * (1 - Math.hypot(u, v) * 0.9);
          const ring = R + r * Math.cos(phi);
          out[o] = ring * Math.cos(theta);
          out[o + 1] = ring * Math.sin(theta);
          out[o + 2] = r * Math.sin(phi);
        }
      }
    }

    function updatePoints() {
      if (modeAnim.active) {
        mapInto(state.mode, mapTmp);
        const e = ease(modeAnim.t);
        for (let i = 0; i < P3.length; i++) P3[i] = modeSnap[i] + (mapTmp[i] - modeSnap[i]) * e;
      } else {
        mapInto(state.mode, P3);
      }
      visuals.forEach(writeVisual);
      curvePos.set(P3);
      curvePos[SIZE * 3] = P3[0];
      curvePos[SIZE * 3 + 1] = P3[1];
      curvePos[SIZE * 3 + 2] = P3[2];
      curveGeo.attributes.position.needsUpdate = true;
    }

    // ------------------------------------------------------------ triangle visuals

    function createVisual(hash) {
      const group = new THREE.Group();
      const layers = hash.layers.map((L) => {
        const pos = new Float32Array(L.count * 9);
        const col = new Float32Array(L.count * 12);
        const [r, g, b] = L.rgb;
        for (let t = 0; t < L.count; t++) {
          const a = VH.alphaOf(L.area[t]);
          for (let v = 0; v < 3; v++) {
            const o = (t * 3 + v) * 4;
            col[o] = r;
            col[o + 1] = g;
            col[o + 2] = b;
            col[o + 3] = a;
          }
        }
        const geo = new THREE.BufferGeometry();
        geo.setAttribute("position", new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
        geo.setAttribute("color", new THREE.BufferAttribute(col, 4));
        const mat = new THREE.MeshBasicMaterial({
          vertexColors: true,
          transparent: true,
          opacity: 0,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
          side: THREE.DoubleSide,
        });
        const mesh = new THREE.Mesh(geo, mat);
        mesh.frustumCulled = false;
        const pivot = new THREE.Group();
        pivot.add(mesh);
        group.add(pivot);
        return { pivot, mesh, geo, pos, index: L.index, count: L.count };
      });
      world.add(group);
      const v = { hash, group, layers, opacity: 0, from: 0, to: 1 };
      writeVisual(v);
      return v;
    }

    function writeVisual(v) {
      v.layers.forEach((L) => {
        const idx = L.index, pos = L.pos;
        for (let j = 0, o = 0; j < idx.length; j++, o += 3) {
          const p = idx[j] * 3;
          pos[o] = P3[p];
          pos[o + 1] = P3[p + 1];
          pos[o + 2] = P3[p + 2];
        }
        L.geo.attributes.position.needsUpdate = true;
      });
    }

    function disposeVisual(v) {
      world.remove(v.group);
      v.layers.forEach((L) => {
        L.geo.dispose();
        L.mesh.material.dispose();
      });
      if (draw.visual === v) finishDraw();
    }

    // ------------------------------------------------------------ hash changes

    function regenerate(how) {
      setHash(VH.compute(state.name, { seed: state.seed }), how);
    }

    // how: "morph" (slide from the current shape), "draw" (trace it in), "instant"
    function setHash(hash, how) {
      const prev = current;
      current = hash;
      finishDraw();
      if (how === "morph" && prev) {
        copyFrame(disp, morphFrom);
        morphTo = frameOf(hash);
        visuals = visuals.filter((v) => {
          if (v.opacity < 0.15) disposeVisual(v);
          return v.opacity >= 0.15;
        });
        while (visuals.length > 2) disposeVisual(visuals.shift());
        visuals.forEach((v) => {
          v.from = v.opacity;
          v.to = 0;
        });
        visuals.push(createVisual(hash));
        morph.t = 0;
        morph.active = true;
      } else {
        visuals.forEach(disposeVisual);
        visuals = [];
        copyFrame(frameOf(hash), disp);
        morph.active = false;
        updatePoints();
        const v = createVisual(hash);
        v.opacity = v.from = v.to = 1;
        visuals = [v];
        if (how === "draw") startDraw(v);
      }
      dirty = true;
      updateInfo(hash);
      writeUrl();
      if (state.mode === "pendant") schedulePendant();
    }

    // ------------------------------------------------------------ draw-on animation

    function startDraw(v) {
      draw.active = true;
      draw.t = 0;
      draw.visual = v;
      applyDraw();
    }

    function applyDraw() {
      const t = draw.t;
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
      comet.visible = false;
    }

    // ------------------------------------------------------------ modes

    function setMode(mode) {
      if (!MODES.includes(mode) || mode === state.mode) return;
      modeSnap.set(P3);
      modeAnim.t = 0;
      modeAnim.active = true;
      state.mode = mode;
      if (mode === "pendant") buildPendant();
      else removePendant();
      dirty = true;
      syncUi();
      writeUrl();
    }

    function setLift(lift) {
      if (!SIGNALS.includes(lift) || lift === state.lift) return;
      modeSnap.set(P3);
      modeAnim.t = 0;
      modeAnim.active = true;
      state.lift = lift;
      syncUi();
      writeUrl();
    }

    function setSeed(seed) {
      if (seed === state.seed) return;
      state.seed = seed;
      syncUi();
      regenerate("morph");
    }

    // ------------------------------------------------------------ pendant

    function schedulePendant() {
      clearTimeout(pendantTimer);
      pendantTimer = setTimeout(buildPendant, 120);
    }

    function removePendant() {
      clearTimeout(pendantTimer);
      if (!pendant) return;
      world.remove(pendant);
      pendant.traverse((o) => o.geometry && o.geometry.dispose());
      pendant = null;
    }

    function buildPendant() {
      if (state.mode !== "pendant" || !current) return;
      const hash = current;
      const lift = hash.signals.radius;
      const oldScale = pendant ? pendant.scale.x : 0.6;
      removePendant();

      const group = new THREE.Group();
      const pts = [];
      let maxR = 0, maxI = 0, topI = 0;
      for (let i = 0; i < SIZE; i++) {
        const r = Math.hypot(hash.x[i], hash.y[i]);
        if (r > maxR) { maxR = r; maxI = i; }
        if (-hash.y[i] > -hash.y[topI]) topI = i;
        if (i % 2 === 0) pts.push(new THREE.Vector3(hash.x[i], -hash.y[i], lift[i] * opts.relief));
      }
      const path = new THREE.CatmullRomCurve3(pts, true, "centripetal");
      group.add(new THREE.Mesh(new THREE.TubeGeometry(path, SIZE, opts.thickness, 8, true), metal));

      // The ring touches the curve at its N outermost points, so the print is one piece.
      let bailAt;
      if (opts.ring) {
        const ringZ = lift[maxI] * opts.relief;
        const ring = new THREE.Mesh(new THREE.TorusGeometry(maxR, opts.thickness * 1.15, 12, 360), metal);
        ring.position.z = ringZ;
        group.add(ring);
        bailAt = new THREE.Vector3(0, maxR, ringZ);
      } else {
        bailAt = new THREE.Vector3(hash.x[topI], -hash.y[topI], lift[topI] * opts.relief);
      }
      const bailR = 0.2;
      const bail = new THREE.Mesh(new THREE.TorusGeometry(bailR, opts.thickness * 1.3, 12, 64), metal);
      bail.rotation.y = Math.PI / 2;
      bail.position.set(bailAt.x, bailAt.y + bailR * 0.9, bailAt.z);
      group.add(bail);

      metal.color.setHSL(hash.layers[0].hue / 360, 0.42, 0.62);
      group.userData.mmScale = PENDANT_MM / 2 / (opts.ring ? maxR : maxR + 0.05);
      group.scale.setScalar(oldScale);
      pendant = group;
      world.add(group);
    }

    // ------------------------------------------------------------ frame loop

    const clock = new THREE.Clock();

    function frame() {
      requestAnimationFrame(frame);
      const dt = Math.min(clock.getDelta(), 0.05);
      const lotus = state.mode === "lotus";
      const isPendant = state.mode === "pendant";

      if (morph.active) {
        morph.t = Math.min(1, morph.t + dt / morph.dur);
        const e = ease(morph.t);
        lerpFrame(morphFrom, morphTo, e, disp);
        visuals.forEach((v) => (v.opacity = v.from + (v.to - v.from) * e));
        if (morph.t >= 1) {
          morph.active = false;
          visuals = visuals.filter((v) => {
            if (v.to === 0) disposeVisual(v);
            return v.to !== 0;
          });
        }
        dirty = true;
      }

      if (modeAnim.active) {
        modeAnim.t = Math.min(1, modeAnim.t + dt / modeAnim.dur);
        if (modeAnim.t >= 1) modeAnim.active = false;
        dirty = true;
      }

      if (dirty) {
        updatePoints();
        dirty = false;
      }

      if (draw.active) {
        draw.t = Math.min(1, draw.t + dt / draw.dur);
        applyDraw();
        if (draw.t >= 1) finishDraw();
      }

      // Lotus: layers drift apart and spin; elsewhere they settle back onto a
      // multiple of 2π/N, which looks identical thanks to the N-fold symmetry.
      const sym = TAU / (current ? current.N : 7);
      for (let i = 0; i < 3; i++) {
        layerZ[i] = damp(layerZ[i], lotus ? (1 - i) * opts.explode : 0, 5, dt);
        if (lotus && opts.spin) layerRot[i] += LAYER_SPIN[i] * dt;
        else layerRot[i] = damp(layerRot[i], Math.round(layerRot[i] / sym) * sym, 3, dt);
      }
      triFade = damp(triFade, isPendant ? 0 : 1, 6, dt);

      // A tilted plane packs the same triangles into fewer pixels (1/cos θ more
      // overlap). Scaling alpha by cos θ keeps the light per pixel of the original
      // top view, in the spirit of its alpha = 55/area rule. Closed shapes overlap
      // front and back, so they get a fixed factor.
      const viewCos = Math.abs(camera.position.z) / camera.position.length();
      const autoExposure = state.mode === "sphere" ? 0.34 : state.mode === "torus" ? 0.32 : Math.max(0.2, viewCos);
      viewExposure = damp(viewExposure, autoExposure, 6, dt);
      const exposure = viewExposure * opts.exposure;
      visuals.forEach((v) => {
        v.layers.forEach((L, i) => {
          L.pivot.position.z = layerZ[i];
          L.pivot.rotation.z = layerRot[i];
          L.mesh.material.opacity = v.opacity * triFade * exposure;
          L.mesh.visible = L.mesh.material.opacity > 0.002;
        });
      });

      const curveTarget = draw.active ? 0.7 : (opts.showCurve || lotus) && !isPendant ? 0.3 : 0;
      curveOpacity = damp(curveOpacity, curveTarget, 6, dt);
      curveMat.opacity = curveOpacity;
      curveLine.visible = curveOpacity > 0.002;

      if (pendant) pendant.scale.setScalar(damp(pendant.scale.x, 1, 7, dt));

      // Glow modes keep the original's additive sRGB math; the pendant gets a lit, tone-mapped look.
      renderer.outputColorSpace = isPendant ? THREE.SRGBColorSpace : THREE.LinearSRGBColorSpace;
      renderer.toneMapping = isPendant ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping;
      scene.background = isPendant ? BG_METAL : BG_GLOW;
      composer = isPendant ? metalComposer : glowComposer;
      composer.bloom.strength = isPendant ? opts.bloom * 0.12 : opts.bloom;
      composer.bloom.threshold = isPendant ? 0.9 : 0.5;

      if (camAnim.active) {
        camAnim.t = Math.min(1, camAnim.t + dt / camAnim.dur);
        const e = ease(camAnim.t);
        const len = camAnim.from.length() + (camAnim.to.length() - camAnim.from.length()) * e;
        camera.position.lerpVectors(camAnim.from, camAnim.to, e).setLength(len);
        if (camAnim.t >= 1) camAnim.active = false;
      }

      controls.update();
      composer.render();
    }

    // ------------------------------------------------------------ UI

    const nameInput = $("name");

    function syncUi() {
      document.querySelectorAll("[data-group]").forEach((g) => {
        const value = state[g.dataset.group];
        g.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.value === value)));
      });
      document.querySelectorAll(".mode-opts").forEach((el) => el.classList.toggle("active", el.dataset.for === state.mode));
      document.querySelectorAll("[data-opt]").forEach((el) => {
        if (el.type === "checkbox") el.checked = !!opts[el.dataset.opt];
        else el.value = opts[el.dataset.opt];
      });
      $("rotateBtn").setAttribute("aria-pressed", String(controls.autoRotate));
      $("autoBtn").setAttribute("aria-pressed", String(!!autoTimer));
      $("autoBtn").textContent = autoTimer ? "Stop auto" : "Auto random";
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
            '<div class="layer"><i style="background:hsl(' + L.hue + " " + L.sat + '% 50%)"></i><span>Layer ' + (i + 1) +
            " · stride " + L.stride + "</span><span>" + L.count + " tris</span></div>"
        )
        .join("");
    }

    function toast(message) {
      const el = $("toast");
      el.textContent = message;
      el.classList.add("show");
      clearTimeout(toast.timer);
      toast.timer = setTimeout(() => el.classList.remove("show"), 1800);
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

    function flyTo(target) {
      camAnim.from.copy(camera.position);
      camAnim.to.copy(target);
      camAnim.t = 0;
      camAnim.active = true;
      controls.target.set(0, 0, 0);
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

    document.querySelectorAll("[data-group]").forEach((g) => {
      g.addEventListener("click", (e) => {
        const b = e.target.closest("button");
        if (!b) return;
        const v = b.dataset.value;
        if (g.dataset.group === "mode") setMode(v);
        else if (g.dataset.group === "lift") setLift(v);
        else if (g.dataset.group === "seed") setSeed(v);
      });
    });

    document.querySelectorAll("[data-opt]").forEach((el) => {
      el.addEventListener("input", () => {
        const key = el.dataset.opt;
        opts[key] = el.type === "checkbox" ? el.checked : parseFloat(el.value);
        dirty = true;
        if (key === "thickness" || key === "relief" || key === "ring") schedulePendant();
      });
    });

    $("topBtn").addEventListener("click", () => flyTo(VIEW_TOP));
    $("angleBtn").addEventListener("click", () => flyTo(VIEW_ANGLE));
    $("replayBtn").addEventListener("click", () => {
      if (state.mode === "pendant") setMode("sculpture");
      setHash(current, "draw");
    });
    $("rotateBtn").addEventListener("click", () => {
      controls.autoRotate = !controls.autoRotate;
      syncUi();
    });

    // ------------------------------------------------------------ export + sharing

    function fileBase() {
      return (state.name.trim() || "visual-hash").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 60);
    }

    function download(data, filename, type) {
      const url = typeof data === "string" ? data : URL.createObjectURL(new Blob([data], { type: type }));
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      if (url !== data) setTimeout(() => URL.revokeObjectURL(url), 4000);
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

    $("glbBtn").addEventListener("click", () => {
      finishDraw();
      const target = state.mode === "pendant" && pendant ? pendant : visuals[visuals.length - 1].group;
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

    $("stlBtn").addEventListener("click", () => {
      if (state.mode !== "pendant") return;
      clearTimeout(pendantTimer);
      buildPendant();
      const g = pendant.clone();
      g.scale.setScalar(pendant.userData.mmScale);
      g.updateMatrixWorld(true);
      const stl = new deps.STLExporter().parse(g, { binary: true });
      download(stl, fileBase() + "-pendant.stl", "model/stl");
      toast("STL saved · " + PENDANT_MM + " mm across");
    });

    function shareUrl() {
      const p = new URLSearchParams();
      p.set("name", state.name);
      if (state.seed !== "legacy") p.set("seed", state.seed);
      if (state.mode !== "sculpture") p.set("mode", state.mode);
      if (state.lift !== "radius") p.set("lift", state.lift);
      return location.href.split(/[?#]/)[0] + "?" + p.toString();
    }

    function writeUrl() {
      clearTimeout(urlTimer);
      urlTimer = setTimeout(() => {
        try {
          history.replaceState(null, "", shareUrl());
        } catch (e) {
          /* some browsers refuse replaceState on file:// */
        }
      }, 250);
    }

    function readUrl() {
      const p = new URLSearchParams(location.search);
      const mode = p.get("mode"), lift = p.get("lift");
      return {
        name: p.has("name") ? p.get("name") : "Gun Gun Feb",
        seed: p.get("seed") === "v3" ? "v3" : "legacy",
        mode: MODES.includes(mode) ? mode : "sculpture",
        lift: SIGNALS.includes(lift) ? lift : "radius",
      };
    }

    $("linkBtn").addEventListener("click", () => {
      const url = shareUrl();
      const done = () => toast("Link copied");
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(done, () => window.prompt("Copy this link", url));
      } else {
        window.prompt("Copy this link", url);
      }
    });

    // ------------------------------------------------------------ helpers

    function ease(t) {
      return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    }

    function damp(a, b, lambda, dt) {
      return b + (a - b) * Math.exp(-lambda * dt);
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

    syncUi();
    setHash(VH.compute(state.name, { seed: state.seed }), "draw");
    if (state.mode === "pendant") buildPendant();
    frame();

    VH3D.debug = { state, opts, setMode, setLift, setSeed, flyTo, camera, controls, draw, morph, get current() { return current; } };
  }
})();
