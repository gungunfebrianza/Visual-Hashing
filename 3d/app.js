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
    const MODES = ["sculpture", "lotus", "sphere", "torus", "pendant", "lithophane"];
    const SOLID_MODES = ["pendant", "lithophane"]; // lit objects; every other form is additive light
    const SIGNALS = ["radius", "phase", "loop", "wave"];
    const LAYER_SPIN = [0.13, -0.09, 0.055];
    const TURN_SPEED = TAU / 100; // one turn every 100 s
    const LIGHT_UNIT = 2 * 110 * 110; // canvas shoelace value (2 × px area) per world unit²
    const TORUS_R = 1.45, TORUS_r = 0.62, SPHERE_R = 1.75;
    const SIDE_GAP = 2.05;
    const MAX_GAIN = 3;
    const STROBE_DT = 1 / 12; // seconds between strobe flashes
    const KALEIDO = ["full", "wedge", "mirror"];
    const STYLES = ["glow", "scope", "caustic", "exposure", "spectrum", "aurora", "glass", "riso", "plotter", "string", "ascii"];
    const GENE_NAMES = ["symmetry", "radius wobble", "phase wobble", "epicycle 1", "epicycle 2", "loop", "colours", "strides"];
    const NEIGHBOUR_BITS = [0, 13, 31, 32, 50, 77, 96, 127];
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
      // art styles
      persist: 0.35,
      ripple: 1,
      shutter: 2,
      dispersion: 1,
      aurora: 1,
      misreg: 1,
      nails: 0, // 0 = automatic
      cell: 10,
      // motion and explore
      strobe: false,
      drift: 0.04,
      machine: false,
      twist: 0,
      damping: 0,
      // lithophane
      lithoMm: 100,
      backlight: true,
      // secret shares (pixels across the secret image)
      vcDetail: 120,
    };
    // Short URL keys for every look/shape option that a shared link should carry.
    const URL_KEYS = {
      liftAmount: "la", explode: "ex", spin: "sp", bloom: "gl", exposure: "br", showCurve: "cv",
      thickness: "th", relief: "rl", ring: "rg", wrap: "wr", sizeMm: "mm",
      persist: "pt", ripple: "rp", shutter: "sh", dispersion: "dp", aurora: "au", misreg: "mr", nails: "nl", cell: "ce",
      strobe: "sb", drift: "dr", machine: "mc", twist: "tw", damping: "dm", lithoMm: "lm", backlight: "bl",
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
    let litho = null;
    let lithoTimer = 0;
    let enteredStyle = null; // style whose objects are in the scene (null on solid forms)
    let strobeAcc = 0;
    let machineIdx = 0;
    let audio = null;
    let avalanche = null; // last keystroke: seed bits that changed

    const morph = { active: false, t: 1, dur: 0.9, kind: "morph" };
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

    // Main hash on the left (or centre), compared hash on the right.
    const mainRoot = new THREE.Group();
    const compareRoot = new THREE.Group();
    scene.add(mainRoot, compareRoot);

    // Art styles, lenses and screen effects (lib/fx.js).
    const fx = window.VHFx.create({
      THREE, SIZE, VH, opts, state, reduceMotion,
      getStyle: () => enteredStyle,
    });
    const Art = window.VHArt;
    const diffPass = new fx.DiffPass(scene, camera, mainRoot, compareRoot);
    diffPass.enabled = false;
    const stylePasses = [];
    fx.order.forEach((id) => {
      const p = fx.styles[id].pass;
      if (p && stylePasses.indexOf(p) < 0) stylePasses.push(p);
    });

    // Glow modes render into an 8-bit target: additive light clamps at 1 per
    // pixel, exactly like the original canvas. The pendant needs float for lighting.
    // Glow passes: [difference] → scene → bloom → [style] → [kaleidoscope] → output.
    function makeComposer(type) {
      const target = type ? new THREE.WebGLRenderTarget(1, 1, { type: type }) : undefined;
      const c = new deps.EffectComposer(renderer, target);
      if (type) c.addPass(diffPass);
      c.scenePass = new deps.RenderPass(scene, camera);
      c.addPass(c.scenePass);
      c.bloom = new deps.UnrealBloomPass(new THREE.Vector2(256, 256), opts.bloom, 0.4, 0);
      c.addPass(c.bloom);
      if (type) {
        stylePasses.forEach((p) => {
          p.enabled = false;
          c.addPass(p);
        });
        fx.kaleido.enabled = false;
        c.addPass(fx.kaleido);
      }
      c.addPass(new deps.OutputPass());
      return c;
    }
    const glowComposer = makeComposer(THREE.UnsignedByteType);
    const metalComposer = makeComposer(null);
    let composer = glowComposer;

    function resize() {
      const w = stage.clientWidth, h = stage.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      glowComposer.setSize(w, h);
      metalComposer.setSize(w, h);
      const ratio = renderer.getPixelRatio();
      fx.setResolution(w * ratio, h * ratio, ratio);
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
      const u = (mat.userData = {
        tint: { value: new THREE.Color() },
        tintMix: { value: 0 },
        ink: { value: new THREE.Color() },
        inkMix: { value: 0 },
        paper: { value: 0 },
        shatter: { value: 0 },
        blend: "add",
      });
      mat.onBeforeCompile = (shader) => {
        shader.uniforms.uG = shadeG;
        shader.uniforms.uTint = u.tint;
        shader.uniforms.uTintMix = u.tintMix;
        shader.uniforms.uInk = u.ink;
        shader.uniforms.uInkMix = u.inkMix;
        shader.uniforms.uPaper = u.paper;
        shader.uniforms.uShatter = u.shatter;
        shader.vertexShader =
          "#define MAX_GAIN " + MAX_GAIN.toFixed(1) + "\n" +
          "attribute vec3 triCross;\nattribute vec2 triLight;\nattribute vec3 triCenter;\n" +
          "uniform float uG;\nuniform vec3 uTint;\nuniform float uTintMix;\nuniform vec3 uInk;\nuniform float uInkMix;\nuniform float uShatter;\n" +
          shader.vertexShader
            .replace(
              "#include <begin_vertex>",
              // Shatter: each triangle shrinks, spins and flies off along its own random direction.
              "#include <begin_vertex>\n" +
                "  if (uShatter > 0.0) {\n" +
                "    float tid = float(gl_VertexID / 3);\n" +
                "    vec3 rnd = fract(sin(vec3(tid * 12.9898, tid * 78.233, tid * 37.719)) * 43758.5453) * 2.0 - 1.0;\n" +
                "    vec3 d = transformed - triCenter;\n" +
                "    float ang = uShatter * 5.0 * rnd.z, cs = cos(ang), sn = sin(ang);\n" +
                "    d = vec3(cs * d.x - sn * d.y, sn * d.x + cs * d.y, d.z) * (1.0 - 0.6 * uShatter);\n" +
                "    vec3 dir = normalize(vec3(triCenter.xy, 0.0) + rnd * 0.7 + vec3(0.0, 0.0, 1e-4));\n" +
                "    transformed = triCenter + d + dir * uShatter * (1.4 + rnd.x) + vec3(0.0, 0.0, rnd.y * uShatter);\n" +
                "  }\n"
            )
            .replace(
              "#include <color_vertex>",
              "#include <color_vertex>\n" +
                "  float projected = abs((normalMatrix * triCross).z);\n" +
                "  vColor.rgb = mix(vColor.rgb, uInk, uInkMix);\n" +
                "  vColor.rgb = mix(vColor.rgb, uTint, uTintMix);\n" +
                "  vColor.a = min(min(1.0, triLight.y * MAX_GAIN), 2.0 * triLight.x * uG / max(projected, 1e-9));\n" +
                "  vColor.a *= 1.0 - uShatter;\n"
            );
        // Paper styles: output the light the ink absorbs; the blend multiplies the paper by its complement.
        shader.fragmentShader =
          "uniform float uPaper;\n" +
          shader.fragmentShader.replace(
            "#include <dithering_fragment>",
            "#include <dithering_fragment>\n  if (uPaper > 0.5) gl_FragColor = vec4(gl_FragColor.a * (1.0 - gl_FragColor.rgb), 1.0);\n"
          );
      };
      mat.customProgramCacheKey = () => "vh-triangles-2";
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
    // frame may hold fewer than SIZE points (mapPoint maps a single one).
    function mapInto(mode, frame, out) {
      const x = frame.x, y = frame.y, SIZE = frame.x.length;
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

    // One 2D point (hash coordinates, signal value s) mapped like mapInto does.
    const pointFrame = { x: new Float32Array(1), y: new Float32Array(1), sig: {} };
    SIGNALS.forEach((k) => (pointFrame.sig[k] = new Float32Array(1)));
    const pointOut = new Float32Array(3);
    function mapPoint(x, y, index) {
      pointFrame.x[0] = x;
      pointFrame.y[0] = y;
      SIGNALS.forEach((k) => (pointFrame.sig[k][0] = main.frame.sig[k][index]));
      mapInto(state.mode, pointFrame, pointOut);
      return [pointOut[0], pointOut[1], pointOut[2]];
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
      const st = enteredStyle && fx.styles[enteredStyle];
      if (st && st.modifyPoints) st.modifyPoints(track.P3);
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
      const st = enteredStyle && fx.styles[enteredStyle];
      if (st && current) st.onPoints(P3, current, fxEnv);
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
        const center = new Float32Array(n * 3);
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
        geo.setAttribute("triCenter", new THREE.BufferAttribute(center, 3).setUsage(THREE.DynamicDrawUsage));
        const mesh = new THREE.Mesh(geo, triMaterial());
        mesh.frustumCulled = false;
        const pivot = new THREE.Group();
        pivot.add(mesh);
        group.add(pivot);
        return { pivot, mesh, geo, pos, cross, center, index: L.index, count: L.count };
      });
      root.add(group);
      const v = { hash, group, layers, opacity: 0, from: 0, to: 1, shatter: 0, frozen: false };
      writeVisual(v, P3);
      return v;
    }

    function writeVisual(v, P3) {
      if (v.frozen) return; // shattering away: keeps the shape it had
      v.layers.forEach((L) => {
        const idx = L.index, pos = L.pos, cr = L.cross, ce = L.center;
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
          ce[o] = ce[o + 3] = ce[o + 6] = (ax + bx + cx) / 3;
          ce[o + 1] = ce[o + 4] = ce[o + 7] = (ay + by + cy) / 3;
          ce[o + 2] = ce[o + 5] = ce[o + 8] = (az + bz + cz) / 3;
        }
        L.geo.attributes.position.needsUpdate = true;
        L.geo.attributes.triCross.needsUpdate = true;
        L.geo.attributes.triCenter.needsUpdate = true;
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

    // The hash shown for the main name: the plain hash, or (art mode) a child
    // bred with the second name and/or a damped harmonograph trace.
    function mainHash() {
      const o = { seed: state.seed, damping: opts.damping };
      if (state.child >= 0 && state.compare && Art) {
        o.genes = Art.crossover(VH.genes(state.name, state.seed), VH.genes(state.compare, state.seed), state.child);
      }
      return VH.compute(state.name, o);
    }

    function compareHash() {
      if (state.nb >= 0 && Art) {
        const seed = VH.compute(state.name, { seed: state.seed }).seed;
        return VH.compute(state.name, { seed: state.seed, seedWords: Art.flipBit(seed, state.nb), damping: opts.damping });
      }
      return state.compare ? VH.compute(state.compare, { seed: state.seed, damping: opts.damping }) : null;
    }

    function regenerate(how) {
      const prev = current;
      setHash(mainHash(), how);
      // Avalanche: how many of the 128 seed bits one edit of the name flipped.
      if (prev && Art && prev.name !== current.name && prev.seedMode === current.seedMode) {
        avalanche = { from: prev.name, to: current.name, bits: Art.hamming(prev.seed, current.seed), seed: current.seedMode };
        updateAvalanche();
      }
      if (state.compare || state.nb >= 0) refreshCompare();
    }

    function updateAvalanche() {
      const el = $("avalanche");
      if (!avalanche) {
        el.textContent = "Type in the name: each keystroke shows how many of the 128 seed bits it flipped.";
        return;
      }
      const a = avalanche, pct = Math.round((a.bits / 128) * 100);
      const short = (s) => "“" + escapeHtml(s.length > 18 ? "…" + s.slice(-17) : s) + "”";
      el.innerHTML =
        short(a.from) + " → " + short(a.to) + ": <strong>" + a.bits + " of 128</strong> seed bits flipped (" + pct + "%). " +
        (a.seed === "v3"
          ? "SHA-256 flips each bit with probability ½: a full avalanche."
          : "The legacy seed only XORs the changed character into one word: a weak avalanche, which is why names can collide.");
    }

    // how: "morph" (slide or shatter from the current shape), "draw" (trace it in), "instant"
    function setHash(hash, how) {
      const prev = current;
      current = main.hash = hash;
      if (reduceMotion) how = "instant";
      finishDraw();
      if (how === "morph" && prev) {
        main.visuals = main.visuals.filter((v) => {
          if (v.opacity < 0.15) disposeVisual(v);
          return v.opacity >= 0.15;
        });
        while (main.visuals.length > 2) disposeVisual(main.visuals.shift());
        main.visuals.forEach((v) => {
          v.from = v.opacity;
          v.to = 0;
        });
        if (state.transition === "shatter") {
          // The old hash breaks into its triangles; the new one assembles from shards.
          main.visuals.forEach((v) => {
            v.frozen = true;
            v.shatterFrom = v.shatter;
            v.shatterTo = 1;
          });
          copyFrame(frameOf(hash), main.frame);
          morphTo = null;
          updatePoints();
          const nv = createVisual(hash, mainRoot, main.P3);
          nv.shatter = nv.shatterFrom = 1;
          nv.shatterTo = 0;
          main.visuals.push(nv);
          morph.kind = "shatter";
          morph.dur = 1.3;
        } else {
          copyFrame(main.frame, morphFrom);
          morphTo = frameOf(hash);
          main.visuals.forEach((v) => (v.shatterTo = v.shatterFrom = v.shatter));
          main.visuals.push(createVisual(hash, mainRoot, main.P3));
          morph.kind = "morph";
          morph.dur = 0.9;
        }
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
      const st = enteredStyle && fx.styles[enteredStyle];
      if (st) st.onHash(hash);
      updateStyleInfo();
      if (audio) startSound();
      dirty = true;
      updateInfo(hash);
      writeUrl();
      if (state.mode === "pendant") schedulePendant();
      if (state.mode === "lithophane") scheduleLitho();
      scheduleShares();
      kick();
    }

    // ------------------------------------------------------------ compare

    // name: a second name; nb >= 0 instead compares with the main seed with one bit flipped.
    function setCompare(name, nb) {
      state.compare = name;
      state.nb = nb === undefined ? -1 : nb;
      if (state.child >= 0) {
        // A child needs its second parent: going back to the plain hash.
        state.child = -1;
        setHash(mainHash(), "morph");
      }
      refreshCompare(true);
      syncUi();
      writeUrl();
      kick();
    }

    function refreshCompare(fresh) {
      other.visuals.forEach(disposeVisual);
      other.visuals = [];
      other.hash = null;
      const hash = compareHash();
      if (hash) {
        other.hash = hash;
        copyFrame(frameOf(hash), other.frame);
        mapInto(state.mode, other.frame, other.P3);
        other.snap.set(other.P3);
        const v = createVisual(hash, compareRoot, other.P3);
        v.opacity = reduceMotion || !fresh ? 1 : 0;
        other.visuals = [v];
      }
      dirty = true;
      updateCompareInfo();
    }

    function setLayout(value) {
      if (value === state.layout) return;
      const wasSide = !!other.hash && state.layout === "side";
      state.layout = value;
      const isSide = !!other.hash && value === "side";
      if (wasSide !== isSide) zoomFor(isSide);
      updateCompareInfo();
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
      const how =
        state.layout === "difference"
          ? " In Difference, matching light cancels to black."
          : state.layout === "overlay"
          ? " In Overlay, matching light turns white."
          : "";
      if (state.nb >= 0) {
        info.innerHTML =
          "<strong>Seed bit " + state.nb + " flipped.</strong> The seeds differ in 1 of 128 bits, yet the image is unrelated: " +
          "52 warm-up rounds of xorshift spread every bit over the whole state." + how;
      } else if (a.seed.join() === b.seed.join() && !a.art) {
        info.innerHTML =
          a.name === b.name
            ? "<strong>Identical.</strong> Same name, same seed, same image." + how
            : "<strong>Collision:</strong> two different names produce the same seed, so the images are identical." +
              (state.seed === "legacy" ? " The v3 seed tells them apart." : "") + how;
      } else {
        info.innerHTML =
          "<strong>Different.</strong> " + a.N + "-fold vs " + b.N + "-fold symmetry, turn " + a.k + "/" + a.N + " vs " + b.k + "/" + b.N +
          (Art ? ", " + Art.hamming(a.seed, b.seed) + " of 128 seed bits differ." : ".") + how;
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
      if (state.mode === "lithophane") {
        buildLitho();
      } else if (state.mode === "pendant") {
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
      if (SOLID_MODES.includes(mode) && !state.turntable) spinHome = "zero";
      if (mode === "pendant") buildPendant();
      else removePendant();
      if (mode === "lithophane") buildLitho();
      else removeLitho();
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

    // ------------------------------------------------------------ lithophane
    //
    // Brightness ≅ thickness: thin plastic lets light through, thick plastic
    // blocks it. The original 2D image becomes a relief that shows the hash
    // when lit from behind (disc) or from inside (dome lamp shade).

    const lithoUniforms = { uBack: { value: 1 }, uMu: { value: 1.3 } }; // uMu: attenuation per mm of white PLA
    const lithoMat = new THREE.MeshStandardMaterial({ color: 0xf1ebdf, roughness: 0.55, metalness: 0 });
    lithoMat.onBeforeCompile = (shader) => {
      shader.uniforms.uBack = lithoUniforms.uBack;
      shader.uniforms.uMu = lithoUniforms.uMu;
      shader.vertexShader =
        "attribute float thick;\nvarying float vThick;\n" +
        shader.vertexShader.replace("#include <begin_vertex>", "#include <begin_vertex>\n  vThick = thick;");
      shader.fragmentShader =
        "uniform float uBack;\nuniform float uMu;\nvarying float vThick;\n" +
        shader.fragmentShader.replace(
          "#include <emissivemap_fragment>",
          "#include <emissivemap_fragment>\n" +
            "  totalEmissiveRadiance += uBack * vec3(1.0, 0.8, 0.55) * 3.2 * exp(-uMu * vThick);\n" +
            "  diffuseColor.rgb *= 1.0 - 0.93 * uBack;\n"
        );
    };
    lithoMat.customProgramCacheKey = () => "vh-litho";

    // Luminance of the original 2D image, sampled on the unit disc (v up).
    function lumSampler(hash) {
      const S = 512, c = document.createElement("canvas");
      c.width = c.height = S;
      const g = c.getContext("2d", { willReadFrequently: true });
      VH.render2D(hash, g, S / 400);
      const d = g.getImageData(0, 0, S, S).data, L = new Float32Array(S * S);
      for (let i = 0; i < S * S; i++) L[i] = (0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]) / 255;
      // Stretch so the brightest 0.5 % reach full light.
      const top = Math.max(Float32Array.from(L).sort()[Math.floor(S * S * 0.995)], 1e-3);
      for (let i = 0; i < L.length; i++) L[i] = Math.pow(Math.min(1, L[i] / top), 1.5);
      let R = 0;
      for (let i = 0; i < SIZE; i++) R = Math.max(R, Math.hypot(hash.x[i], hash.y[i]));
      R *= 1.04;
      const k = S / 400;
      const at = (x, y) => (x < 0 || y < 0 || x >= S || y >= S ? 0 : L[y * S + x]);
      return (u, v) => {
        const px = (u * R * 110 + 200) * k - 0.5, py = (-v * R * 110 + 200) * k - 0.5;
        const x0 = Math.floor(px), y0 = Math.floor(py), tx = px - x0, ty = py - y0;
        return (at(x0, y0) * (1 - tx) + at(x0 + 1, y0) * tx) * (1 - ty) + (at(x0, y0 + 1) * (1 - tx) + at(x0 + 1, y0 + 1) * tx) * ty;
      };
    }

    function lithoMesh(full) {
      return Art.lithophane({
        lum: lumSampler(current),
        shape: state.lithoShape,
        diameterMm: opts.lithoMm,
        // The dome has twice the surfaces of the disc: a little coarser keeps the file reasonable.
        rings: full ? (state.lithoShape === "dome" ? 120 : 160) : 90,
        sectors: full ? (state.lithoShape === "dome" ? 600 : 720) : 420,
      });
    }

    function scheduleLitho() {
      clearTimeout(lithoTimer);
      lithoTimer = setTimeout(() => {
        buildLitho();
        kick();
      }, 150);
    }

    function removeLitho() {
      clearTimeout(lithoTimer);
      if (!litho) return;
      mainRoot.remove(litho);
      litho.geometry.dispose();
      litho = null;
      updateLithoInfo();
    }

    function buildLitho() {
      if (state.mode !== "lithophane" || !current || !Art) return;
      removeLitho();
      const m = lithoMesh(false);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute("position", new THREE.BufferAttribute(m.positions, 3));
      geo.setAttribute("thick", new THREE.BufferAttribute(m.thickness, 1));
      geo.setIndex(new THREE.BufferAttribute(m.indices, 1));
      geo.computeVertexNormals();
      geo.computeBoundingBox();
      const mesh = new THREE.Mesh(geo, lithoMat);
      const k = SPHERE_R / (opts.lithoMm / 2); // mm -> world units
      mesh.scale.setScalar(k);
      const bb = geo.boundingBox;
      mesh.position.z = (-(bb.min.z + bb.max.z) / 2) * k;
      mesh.userData = { sizeMm: m.sizeMm, triangles: m.triangles };
      litho = mesh;
      mainRoot.add(mesh);
      updateLithoInfo();
    }

    function updateLithoInfo() {
      const el = $("lithoInfo");
      if (!litho) {
        el.textContent = "";
        return;
      }
      const s = litho.userData.sizeMm, f = (v) => (Math.round(v * 10) / 10).toString();
      el.innerHTML =
        f(s[0]) + " × " + f(s[1]) + " × " + f(s[2]) + " mm · 0.8–3.2 mm thick<br>" +
        '<span class="ok">White PLA, 100 % infill, 0.1 mm layers. Light it ' +
        (state.lithoShape === "dome" ? "from inside (a small LED)." : "from behind (a window or a lamp).") + "</span>";
    }

    // ------------------------------------------------------------ frame loop

    const clock = new THREE.Clock();
    const camDir = new THREE.Vector3();
    const tmpV = new THREE.Vector3();
    const bufSize = new THREE.Vector2();
    let running = false;

    // Shared with the styles in lib/fx.js.
    const fxEnv = {
      mainRoot,
      center: new THREE.Vector2(),
      dt: 0,
      head: 1,
      mapPoint,
      markDirty: () => (dirty = true),
    };

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

    // Styles only exist on the glow forms; solid forms (pendant, lithophane) are lit objects.
    function switchStyle(id) {
      if (enteredStyle) fx.styles[enteredStyle].exit(fxEnv);
      enteredStyle = id;
      if (id) {
        const s = fx.styles[id];
        s.enter(fxEnv);
        if (current) s.onHash(current);
      }
      if (id !== "scope") stopSound();
      dirty = true;
      updateStyleInfo();
    }

    function setTriBlend(m, kind) {
      if (kind === "paper") {
        m.blending = THREE.CustomBlending;
        m.blendEquation = THREE.AddEquation;
        m.blendSrc = THREE.ZeroFactor;
        m.blendDst = THREE.OneMinusSrcColorFactor;
      } else {
        m.blending = THREE.AdditiveBlending;
      }
      m.userData.blend = kind;
      m.userData.paper.value = kind === "paper" ? 1 : 0;
    }

    // World point (in obj's local frame) -> drawing-buffer pixels.
    function toScreen(obj, x, y, z, out) {
      tmpV.set(x, y, z).applyMatrix4(obj.matrixWorld).project(camera);
      return out.set(((tmpV.x + 1) / 2) * bufSize.x, ((tmpV.y + 1) / 2) * bufSize.y);
    }

    // Advances every animation by dt. Returns true while anything is still moving.
    function step(dt, spinTo) {
      moving = false;
      let busy = false;
      const lotus = state.mode === "lotus";
      const isPendant = state.mode === "pendant";
      const solid = SOLID_MODES.includes(state.mode);
      const wantStyle = solid ? null : state.style;
      if (wantStyle !== enteredStyle) switchStyle(wantStyle);
      const st = enteredStyle ? fx.styles[enteredStyle] : null;

      if (morph.active) {
        morph.t = Math.min(1, morph.t + dt / morph.dur);
        const e = ease(morph.t);
        if (morph.kind === "morph") lerpFrame(morphFrom, morphTo, e, main.frame);
        main.visuals.forEach((v) => {
          v.opacity = v.from + (v.to - v.from) * e;
          if (v.shatterTo !== undefined) v.shatter = v.shatterFrom + (v.shatterTo - v.shatterFrom) * e;
        });
        if (morph.t >= 1) {
          morph.active = false;
          main.visuals = main.visuals.filter((v) => {
            if (v.to === 0) disposeVisual(v);
            return v.to !== 0;
          });
          main.visuals.forEach((v) => {
            v.shatter = 0;
            v.frozen = false;
            v.shatterTo = v.shatterFrom = undefined;
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
        dirty = false;
        updatePoints();
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
      // Strobe: one flash every STROBE_DT, each a turn of 2π/N (plus drift). The
      // N-fold symmetry maps the image onto itself, so it freezes like a zoetrope.
      const sym = TAU / (current ? current.N : 7);
      const strobe = opts.strobe && !reduceMotion;
      if (spinTo !== undefined) spinAngle = spinTo;
      else if (recording && recording.kind === "turntable") {
        spinAngle = strobe
          ? recording.spin0 + Math.floor(recording.t / STROBE_DT) * sym * (1 + opts.drift)
          : recording.spin0 + TAU * clamp01(recording.t / recording.dur);
      } else if (state.turntable) {
        if (strobe) {
          strobeAcc += dt;
          while (strobeAcc >= STROBE_DT) {
            strobeAcc -= STROBE_DT;
            spinAngle += sym * (1 + opts.drift);
          }
          if (spinAngle > 1e4) spinAngle %= TAU;
        } else {
          spinAngle += TURN_SPEED * dt;
        }
        busy = true;
      } else if (spinHome) {
        const unit = spinHome === "zero" ? TAU : sym;
        spinAngle = approach(spinAngle, Math.round(spinAngle / unit) * unit, 4, dt);
      }
      const comparing = !!other.hash, side = comparing && state.layout === "side";
      mainRoot.rotation.z = spinAngle;
      // Twist: a small extra turn of the second hash; on top of the first it makes moiré.
      compareRoot.rotation.z = spinAngle + (comparing && !side ? THREE.MathUtils.degToRad(opts.twist) : 0);

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
      triFade = approach(triFade, solid || (st && st.hideTriangles) ? 0 : 1, 6, dt);

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

      const blend = st && st.paper ? "paper" : "add";
      const styleTrack = (track, tint) =>
        track.visuals.forEach((v) => {
          v.layers.forEach((L, i) => {
            const p = L.pivot;
            p.position.set(0, 0, layerZ[i]);
            p.rotation.z = layerRot[i];
            p.scale.set(1, 1, 1);
            if (st && st.layerTransform) st.layerTransform(i, p, track.hash);
            const m = L.mesh.material, u = m.userData;
            m.opacity = v.opacity * triFade * opts.exposure * layerVis[i] * (st ? st.triGain : 1);
            u.tint.value.setRGB(tint[0], tint[1], tint[2]);
            u.tintMix.value = layout.tint;
            if (st && st.ink && st.inkMix) {
              const c = st.ink(i, track.hash);
              u.ink.value.setRGB(c[0], c[1], c[2]);
              u.inkMix.value = st.inkMix;
            } else {
              u.inkMix.value = 0;
            }
            u.shatter.value = v.shatter || 0;
            if (u.blend !== blend) setTriBlend(m, blend);
            L.mesh.visible = m.opacity > 0.002;
          });
        });
      styleTrack(main, TINT_A);
      styleTrack(other, TINT_B);

      const curveTarget = draw.active ? 0.7 : opts.showCurve && !solid ? 0.25 : 0;
      curveOpacity = approach(curveOpacity, curveTarget, 6, dt);
      curveMat.opacity = curveOpacity;
      curveLine.visible = curveOpacity > 0.002 && blend === "add";

      if (pendant) pendant.scale.setScalar(approach(pendant.scale.x, 1, 7, dt));
      lithoUniforms.uBack.value = opts.backlight ? 1 : 0;
      lithoMat.envMapIntensity = opts.backlight ? 0.12 : 1; // a lamp behind it in a dim room

      // Glow modes keep the original's additive sRGB math; solid forms get a lit, tone-mapped look.
      renderer.outputColorSpace = solid ? THREE.SRGBColorSpace : THREE.LinearSRGBColorSpace;
      renderer.toneMapping = solid ? THREE.ACESFilmicToneMapping : THREE.NoToneMapping;
      scene.background = solid ? BG_METAL : st ? st.bg : BG_GLOW;
      composer = solid ? metalComposer : glowComposer;
      composer.bloom.strength = solid ? opts.bloom * (isPendant ? 0.12 : 0.3) : opts.bloom * (st ? st.bloom : 1);
      composer.bloom.threshold = solid ? 0.9 : 0.5;

      // Screen-space effects need the form's centre and orientation in pixels.
      renderer.getDrawingBufferSize(bufSize);
      camera.updateMatrixWorld();
      mainRoot.updateMatrixWorld();
      toScreen(mainRoot, 0, 0, 0, fxEnv.center);
      fxEnv.dt = dt;
      fxEnv.head = draw.active ? clamp01(draw.t / 0.8) : 1;

      stylePasses.forEach((p) => (p.enabled = !!st && st.pass === p));
      if (st && st.update(fxEnv)) busy = true;

      diffPass.enabled = !solid && comparing && state.layout === "difference";
      glowComposer.scenePass.enabled = !diffPass.enabled;

      const lens = !solid && !!current && state.kaleido !== "full";
      fx.kaleido.enabled = lens;
      if (lens) {
        const u = fx.kaleido.uniforms, ax = toScreen(mainRoot, 1, 0, 0, new THREE.Vector2());
        u.uCenter.value.copy(fxEnv.center);
        u.uPhase.value = Math.atan2(ax.y - fxEnv.center.y, ax.x - fxEnv.center.x);
        u.uN.value = current.N;
        u.uMode.value = state.kaleido === "mirror" ? 2 : 1;
        u.uPx.value = 1.4 * renderer.getPixelRatio();
        u.uBg.value.copy(scene.background);
      }

      // Epicycle machine: the three arms whose sum is the pen, at the pen's position.
      const M = fx.machine;
      if (opts.machine && current && !solid) {
        if (!M.lines) fx.machineInit(comet.material.map);
        if (!M.lines.mesh.parent) mainRoot.add(M.lines.mesh, M.joints);
        if (draw.active) machineIdx = Math.min(SIZE - 1, fxEnv.head * SIZE);
        else if (!reduceMotion) {
          machineIdx = (machineIdx + (dt * SIZE) / 24) % SIZE;
          busy = true;
        }
        fx.machineUpdate(fxEnv, current, Math.floor(machineIdx));
      } else if (M.lines && M.lines.mesh.parent) {
        mainRoot.remove(M.lines.mesh, M.joints);
      }

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
    const styleSelect = $("styleSelect");

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
      document.querySelectorAll(".style-opts").forEach((el) => el.classList.toggle("active", el.dataset.style === state.style));
      styleSelect.value = state.style;
      styleSelect.disabled = SOLID_MODES.includes(state.mode);
      styleSelect.title = styleSelect.disabled ? "Styles apply to the glowing forms" : "Next style: V";
      document.querySelectorAll("[data-opt]").forEach((el) => {
        if (el.type === "checkbox") el.checked = !!opts[el.dataset.opt];
        else el.value = opts[el.dataset.opt];
      });
      $("rotateBtn").setAttribute("aria-pressed", String(state.turntable));
      $("autoBtn").setAttribute("aria-pressed", String(!!autoTimer));
      $("autoBtn").textContent = autoTimer ? "Stop auto" : "Auto random";
      $("seedHint").hidden = !(state.seed === "legacy" && state.name.length > 16);
      $("compareOpts").hidden = !(state.compare || state.nb >= 0);
      if (compareInput.value !== state.compare) compareInput.value = state.compare;
      compareInput.placeholder = state.nb >= 0 ? "Seed bit " + state.nb + " flipped" : "Type another name";
      $("soundBtn").setAttribute("aria-pressed", String(!!audio));
      $("soundBtn").textContent = audio ? "Stop sound" : "Play sound";
      $("artNote").hidden = !(current && current.art);
      document.querySelectorAll("#layers [data-layer]").forEach((b) =>
        b.setAttribute("aria-pressed", String(!state.hidden[+b.dataset.layer]))
      );
    }

    function updateInfo(hash) {
      const hue = hash.layers[0].hue;
      document.documentElement.style.setProperty("--accent", "hsl(" + hue + " 78% 66%)");
      const child = state.child >= 0 && state.compare;
      $("hudName").textContent = child ? (hash.name || "(empty)") + " × " + state.compare : hash.name || "(empty)";
      $("hudMeta").textContent =
        hash.N + "-fold symmetry · turn " + hash.k + "/" + hash.N + " · " + (hash.seedMode === "v3" ? "v3 SHA-256" : "legacy") + " seed";
      $("hudArt").hidden = !hash.art;
      $("hudArt").textContent = child
        ? "Art mode: a child of two names, not a hash"
        : "Art mode: harmonograph damping, not the hash of this name";
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
      state.child = -1;
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
      state.child = -1;
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
        const was = !!other.hash && state.layout === "side";
        setCompare(compareInput.value);
        const is = !!other.hash && state.layout === "side";
        if (was !== is) zoomFor(is);
      }, 120);
    });
    $("compareForm").addEventListener("submit", (e) => e.preventDefault());
    $("collisionBtn").addEventListener("click", () => {
      stopAuto();
      const was = !!state.compare && state.layout === "side";
      state.seed = "legacy";
      state.name = nameInput.value = "A123456789012345B";
      state.child = -1;
      regenerate("morph");
      setCompare("B123456789012345A");
      if (!was && state.layout === "side") zoomFor(true);
    });
    $("clearCompareBtn").addEventListener("click", () => {
      const was = !!other.hash && state.layout === "side";
      setCompare("");
      if (was) zoomFor(false);
    });

    // Segmented controls are radio groups: one tab stop, arrow keys move the choice.
    function choose(group, value) {
      if (group === "mode") setMode(value);
      else if (group === "lift") setLift(value);
      else if (group === "seed") setSeed(value);
      else if (group === "layout") setLayout(value);
      else if (group === "kaleido") setKaleido(value);
      else if (group === "transition") {
        state.transition = value;
        syncUi();
        writeUrl();
      } else if (group === "lithoShape" && value !== state.lithoShape) {
        state.lithoShape = value;
        scheduleLitho();
        syncUi();
        writeUrl();
      } else if (group === "vcScheme" && value !== state.vcScheme) {
        state.vcScheme = value;
        scheduleShares(true);
        syncUi();
        writeUrl();
      } else if (group === "vcView") {
        state.vcView = value;
        drawShares();
        syncUi();
      }
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
        if (key === "lithoMm") scheduleLitho();
        if (key === "damping") scheduleDamping();
        if (key === "vcDetail") scheduleShares(true);
        if (key === "nails" && enteredStyle === "string") fx.styles.string.onHash(current);
        if (key === "strobe" && opts.strobe && reduceMotion) toast("Strobe is off while the system asks to reduce motion");
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

    // ------------------------------------------------------------ art styles

    fx.order.forEach((id) => {
      const o = document.createElement("option");
      o.value = id;
      o.textContent = fx.styles[id].label;
      styleSelect.appendChild(o);
    });
    styleSelect.addEventListener("change", () => setStyle(styleSelect.value));

    function setStyle(id) {
      if (!fx.styles[id] || id === state.style) return;
      state.style = id;
      syncUi();
      writeUrl();
      kick();
    }

    function cycleStyle(dir) {
      const i = fx.order.indexOf(state.style);
      setStyle(fx.order[(i + dir + fx.order.length) % fx.order.length]);
    }

    function setKaleido(value) {
      if (!KALEIDO.includes(value) || value === state.kaleido) return;
      state.kaleido = value;
      syncUi();
      writeUrl();
      kick();
    }

    // Readouts that depend on the style and the hash.
    function updateStyleInfo() {
      if (!current) return;
      const inks = fx.riso.inks;
      $("risoInks").textContent = inks ? "Inks: " + inks.map((k) => k.name).join(", ") + "." : "";
      $("asciiGlyphs").textContent = fx.ascii.glyphs.length > 1 ? fx.ascii.glyphs.slice(1) : "";
      const sel = $("nailsSelect");
      const options = Art ? Art.nailOptions(current.N) : [];
      const key = current.N + ":" + options.join(",");
      if (sel.dataset.key !== key) {
        sel.dataset.key = key;
        sel.innerHTML = '<option value="0">Auto</option>' + options.map((m) => '<option value="' + m + '">' + m + "</option>").join("");
      }
      sel.value = String(options.includes(opts.nails) ? opts.nails : 0);
    }

    // ---- oscilloscope sound: x on the left channel, y on the right, looped
    function startSound() {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC || !Art || !current) return toast("This browser cannot play Web Audio");
      if (!audio) audio = { ac: new AC() };
      const ac = audio.ac;
      const per = Art.scopePeriod(current, ac.sampleRate, 110);
      const buf = ac.createBuffer(2, per.length, ac.sampleRate);
      buf.copyToChannel(per.left, 0);
      buf.copyToChannel(per.right, 1);
      const src = ac.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      const gain = ac.createGain();
      gain.gain.setValueAtTime(0, ac.currentTime);
      gain.gain.linearRampToValueAtTime(0.16, ac.currentTime + 0.25);
      src.connect(gain).connect(ac.destination);
      src.start();
      if (audio.src) {
        const old = audio;
        old.gain.gain.linearRampToValueAtTime(0, ac.currentTime + 0.1);
        old.src.stop(ac.currentTime + 0.12);
      }
      audio.src = src;
      audio.gain = gain;
      if (ac.state === "suspended") ac.resume();
      syncUi();
    }

    function stopSound() {
      if (!audio) return;
      const a = audio;
      audio = null;
      if (a.gain) a.gain.gain.linearRampToValueAtTime(0, a.ac.currentTime + 0.15);
      setTimeout(() => a.ac.close(), 250);
      syncUi();
    }

    $("soundBtn").addEventListener("click", () => (audio ? stopSound() : startSound()));
    $("wavBtn").addEventListener("click", () => {
      if (Art) download(Art.scopeWav(current, { seconds: 8 }), fileBase() + "-oscilloscope.wav", "audio/wav");
    });
    $("exposeBtn").addEventListener("click", () => {
      fx.styles.exposure.restart();
      kick();
    });
    $("risoSvgBtn").addEventListener("click", () => {
      if (!Art) return;
      // World units -> mm on a 200 mm sheet (the 400-unit canvas spans 400/110 world units).
      const mmPerWorld = 200 / (400 / 110), d = opts.misreg * 0.025 * mmPerWorld;
      const svg = Art.risoSvg(current, {
        sizeMm: 200,
        inks: fx.riso.inks.map((k) => ({ name: k.name, hex: k.hex })),
        offsets: fx.riso.offsets.map((o) => [o[0] * d, -o[1] * d]),
        hidden: state.hidden,
      });
      download(new Blob([svg], { type: "image/svg+xml" }), fileBase() + "-riso.svg");
    });
    $("plotterSvgBtn").addEventListener("click", () => {
      if (!Art) return;
      const svg = Art.plotterSvg(current, { sizeMm: 200, hidden: state.hidden });
      download(new Blob([svg], { type: "image/svg+xml" }), fileBase() + "-plotter.svg");
    });
    function stringPlan() {
      if (enteredStyle !== "string" || !fx.str.plan) fx.styles.string.onHash(current);
      return fx.str.plan;
    }
    $("stringSvgBtn").addEventListener("click", () => {
      if (!Art) return;
      const svg = Art.stringArtSvg(stringPlan(), { sizeMm: 300, title: current.name + " string art" });
      download(new Blob([svg], { type: "image/svg+xml" }), fileBase() + "-string-art.svg");
    });
    $("stringTxtBtn").addEventListener("click", () => {
      if (!Art) return;
      download(new Blob([Art.stringArtText(stringPlan())], { type: "text/plain" }), fileBase() + "-string-art.txt");
    });

    // ---- harmonograph damping changes the drawing itself: rebuild after the slider settles
    let dampTimer = 0;
    function scheduleDamping() {
      clearTimeout(dampTimer);
      dampTimer = setTimeout(() => regenerate("instant"), 60);
    }
    $("backToHashBtn").addEventListener("click", () => {
      opts.damping = 0;
      state.child = -1;
      regenerate("morph");
      syncUi();
      writeUrl();
    });

    // ---- galleries: 1-bit neighbours of the seed, children of two names
    function showGallery(hint, items) {
      const el = $("gallery");
      el.innerHTML = "";
      $("galleryHint").hidden = false;
      $("galleryHint").textContent = hint;
      const px = Math.round(84 * Math.min(window.devicePixelRatio || 1, 2));
      items.forEach((item) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "thumb";
        b.title = item.title;
        const c = document.createElement("canvas");
        c.width = c.height = px;
        VH.render2D(item.hash, c.getContext("2d"), px / 400);
        const label = document.createElement("span");
        label.textContent = item.label;
        b.append(c, label);
        b.addEventListener("click", () => {
          el.querySelectorAll(".thumb").forEach((t) => t.setAttribute("aria-pressed", String(t === b)));
          item.pick();
        });
        b.setAttribute("aria-pressed", "false");
        el.appendChild(b);
      });
    }

    $("neighboursBtn").addEventListener("click", () => {
      if (!Art) return;
      const seed = VH.compute(state.name, { seed: state.seed }).seed;
      showGallery(
        "Each image is the hash of the same seed with one bit flipped. Click one to compare it with yours.",
        NEIGHBOUR_BITS.map((bit) => ({
          hash: VH.compute(state.name, { seed: state.seed, seedWords: Art.flipBit(seed, bit) }),
          label: "bit " + bit,
          title: "Seed bit " + bit + " flipped",
          pick: () => {
            const was = !!other.hash && state.layout === "side";
            setCompare("", bit);
            if (!was && state.layout === "side") zoomFor(true);
          },
        }))
      );
    });

    $("breedBtn").addEventListener("click", () => {
      if (!Art) return;
      if (!state.compare) {
        const was = !!other.hash && state.layout === "side";
        setCompare(window.chance ? chance.name() : "Partner");
        if (!was && state.layout === "side") zoomFor(true);
      }
      const A = VH.genes(state.name, state.seed), B = VH.genes(state.compare, state.seed);
      const seedA = VH.compute(state.name, { seed: state.seed }).seed;
      const seedB = VH.compute(state.compare, { seed: state.seed }).seed;
      showGallery(
        "Children of “" + state.name + "” × “" + state.compare + "”: each takes some gene groups from each parent. Click one to grow it (art mode).",
        Art.childMasks(seedA, seedB, 8).map((mask) => {
          const fromB = GENE_NAMES.filter((g, i) => mask & (1 << i));
          return {
            hash: VH.compute(state.name, { seed: state.seed, genes: Art.crossover(A, B, mask) }),
            label: "#" + mask,
            title: "From " + state.compare + ": " + fromB.join(", "),
            pick: () => {
              state.child = mask;
              regenerate("morph");
              writeUrl();
            },
          };
        })
      );
    });

    // ---- lithophane exports (full resolution)
    function lithoExport(kind) {
      if (state.mode !== "lithophane" || !Art) return;
      toast("Building the lithophane…", true);
      setTimeout(() => {
        const m = lithoMesh(true);
        if (kind === "stl") {
          const geo = new THREE.BufferGeometry();
          geo.setAttribute("position", new THREE.BufferAttribute(m.positions, 3));
          geo.setIndex(new THREE.BufferAttribute(m.indices, 1));
          download(new deps.STLExporter().parse(new THREE.Mesh(geo), { binary: true }), fileBase() + "-lithophane.stl", "model/stl");
        } else if (window.VH3MF) {
          const meta = metadata().visualHash;
          download(
            VH3MF.build(m, {
              title: (current.name || "Visual hash") + " lithophane",
              designer: "Visual Hashing 3D",
              description: "Lithophane of the name \"" + current.name + "\" (" + meta.seedMode + " seed " + meta.seed + "). Print in white, light from behind.",
              metadata: { seed: meta.seed, seedMode: meta.seedMode, link: meta.link },
            }),
            fileBase() + "-lithophane.3mf",
            "model/3mf"
          );
        }
        toast("Lithophane ready · " + m.triangles.toLocaleString() + " triangles, watertight");
      }, 30);
    }
    $("lithoStlBtn").addEventListener("click", () => lithoExport("stl"));
    $("lithoThreemfBtn").addEventListener("click", () => lithoExport("3mf"));

    // ---- domemaster: fisheye from inside the form (sphere / torus) or from below (flat forms)
    $("domeBtn").addEventListener("click", () => {
      if (SOLID_MODES.includes(state.mode)) return toast("Domemaster works on the glowing forms");
      finishDraw();
      step(0);
      scene.updateMatrixWorld(true);
      const inside = state.mode === "sphere" || state.mode === "torus";
      const eye = new THREE.Vector3(layout.main, 0, inside ? 0 : -1.5);
      const canvas = fx.domemaster(renderer, scene, eye, 2048);
      download(canvas.toDataURL("image/png"), fileBase() + "-domemaster.png");
      kick();
    });

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
      if (k >= "1" && k <= "6") setMode(MODES[+k - 1]);
      else if (k === "v") cycleStyle(e.shiftKey ? -1 : 1);
      else if (k === "k") setKaleido(KALEIDO[(KALEIDO.indexOf(state.kaleido) + 1) % KALEIDO.length]);
      else if (k === "m") {
        opts.machine = !opts.machine;
        syncUi();
        writeUrl();
        kick();
      }
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

    // ------------------------------------------------------------ secret shares

    // Visual cryptography (Naor–Shamir): the 2D image, dithered to one bit per pixel,
    // becomes two shares of crypto.getRandomValues noise. Stacking them is the overlay
    // compare done with ink; XOR is the Difference layout on a 1-bit image.
    let vc = null; // { scheme, width, a, b, pair, hash }
    let vcTimer = 0;
    let vcStale = true;
    let vcVisible = false;
    let vcAnim = 0;
    const vcCanvas = $("vcCanvas");
    const vcOffset = $("vcOffset");

    function randomHex(bytes) {
      return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
    }

    // fresh: new randomness even if the image is the same (scheme, detail, "New shares").
    function scheduleShares(fresh) {
      vcStale = true;
      if (fresh) vc = null;
      clearTimeout(vcTimer);
      if (vcVisible) vcTimer = setTimeout(buildShares, 120);
    }

    function buildShares() {
      if (!current || !Art || !window.crypto) return;
      vcStale = false;
      const W = opts.vcDetail, n = 3, sample = lumSampler(current), lum = new Float32Array(W * W);
      for (let y = 0; y < W; y++) {
        for (let x = 0; x < W; x++) {
          let s = 0;
          for (let j = 0; j < n; j++)
            for (let i = 0; i < n; i++) s += sample(((x + (i + 0.5) / n) / W) * 2 - 1, 1 - ((y + (j + 0.5) / n) / W) * 2);
          lum[y * W + x] = s / (n * n);
        }
      }
      const shares = Art.vcShares(Art.dither(lum, W), W, { scheme: state.vcScheme, fill: (buf) => crypto.getRandomValues(buf) });
      vc = Object.assign(shares, { pair: randomHex(2), hash: current });
      drawShares();
    }

    function drawShares() {
      if (!vc) return;
      const S = vc.width, dx = +vcOffset.value * (vc.scheme === "or" ? 1 : 0.5);
      const bits = state.vcView === "a" ? vc.a : state.vcView === "b" ? Art.vcStack({ scheme: "or", width: S, a: new Uint8Array(S * S), b: vc.b }, dx) : Art.vcStack(vc, dx);
      if (vcCanvas.width !== S) vcCanvas.width = vcCanvas.height = S;
      const g = vcCanvas.getContext("2d"), img = g.createImageData(S, S), d = img.data;
      for (let i = 0; i < S * S; i++) {
        const ink = bits[i];
        d[i * 4] = ink ? 21 : 242;
        d[i * 4 + 1] = ink ? 21 : 239;
        d[i * 4 + 2] = ink ? 26 : 232;
        d[i * 4 + 3] = 255;
      }
      g.putImageData(img, 0, 0);
      const what = { a: "Share A alone: random noise", b: "Share B alone: random noise", stack: "Share A and share B stacked" }[state.vcView];
      vcCanvas.setAttribute("aria-label", what + (state.vcView === "stack" && dx ? ", slid apart" : ""));
      updateSharesInfo();
    }

    function updateSharesInfo() {
      const or = state.vcScheme === "or";
      $("vcSaveABtn").textContent = (or ? "SVG" : "PNG") + " · share A";
      $("vcSaveBBtn").textContent = (or ? "SVG" : "PNG") + " · share B";
      $("vcHow").textContent = or
        ? "Print both at 100 % on transparency film and line up the corner marks. Film only adds ink, so light pixels stack to half ink and dark ones to full: the hash shows as grey on black."
        : "Film cannot XOR, so combine these on screen: open both in an image editor and set the top layer to Difference. On 1-bit images Difference is XOR, the same as the Difference compare.";
      if (!vc) {
        $("vcInfo").textContent = "";
        return;
      }
      const S = vc.width;
      let ink = 0;
      for (let i = 0; i < vc.b.length; i++) ink += vc.b[i];
      $("vcInfo").textContent = or
        ? "Pair " + vc.pair + " · " + S + " × " + S + " subpixels (" + round(120 / S, 2) + " mm each at 120 mm). Every 2 × 2 cell of either share is exactly half ink, whatever the image."
        : "Pair " + vc.pair + " · " + S + " × " + S + " bits. Share B is " + round((100 * ink) / vc.b.length, 1) + " % ink; lined up, XOR gives the image back exactly.";
    }

    function saveShare(which) {
      if (!vc) buildShares();
      if (!vc) return;
      const S = vc.width, bits = vc[which], tag = which.toUpperCase();
      // The file name and label carry only the pair id: the name would give the image away.
      const base = "visual-hash-share-" + tag + "-" + vc.pair;
      if (vc.scheme === "or") {
        const svg = Art.vcSvg(bits, S, { sizeMm: 120, label: "Share " + tag + " of 2 · pair " + vc.pair, labelAt: which === "a" ? 0.32 : 0.68 });
        download(new Blob([svg], { type: "image/svg+xml" }), base + ".svg");
        return;
      }
      const k = 4, c = document.createElement("canvas");
      c.width = c.height = S * k;
      const g = c.getContext("2d");
      g.fillStyle = "#fff";
      g.fillRect(0, 0, S * k, S * k);
      g.fillStyle = "#000";
      for (let i = 0; i < S * S; i++) if (bits[i]) g.fillRect((i % S) * k, Math.floor(i / S) * k, k, k);
      download(c.toDataURL("image/png"), base + ".png");
    }

    function slideTogether() {
      cancelAnimationFrame(vcAnim);
      if (reduceMotion) {
        vcOffset.value = 0;
        drawShares();
        return;
      }
      if (state.vcView !== "stack") choose("vcView", "stack");
      const from = +vcOffset.value || +vcOffset.max, t0 = performance.now();
      const tick = (now) => {
        const t = Math.min(1, (now - t0) / 1400), e = 1 - Math.pow(1 - t, 3);
        vcOffset.value = Math.round(from * (1 - e));
        drawShares();
        if (t < 1) vcAnim = requestAnimationFrame(tick);
      };
      vcAnim = requestAnimationFrame(tick);
    }

    vcOffset.addEventListener("input", drawShares);
    $("vcSlideBtn").addEventListener("click", slideTogether);
    $("vcNewBtn").addEventListener("click", () => {
      scheduleShares(true);
      clearTimeout(vcTimer);
      buildShares();
    });
    $("vcSaveABtn").addEventListener("click", () => saveShare("a"));
    $("vcSaveBBtn").addEventListener("click", () => saveShare("b"));
    // Only build while the section is on screen: each name change re-renders the 2D image.
    if (window.IntersectionObserver) {
      new IntersectionObserver((entries) => {
        vcVisible = entries.some((e) => e.isIntersecting);
        if (vcVisible && (vcStale || !vc)) scheduleShares();
      }).observe(vcCanvas);
    } else {
      vcVisible = true;
    }
    updateSharesInfo();

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
          style: state.style,
          artMode: !!current.art,
          parents: state.child >= 0 && state.compare ? [current.name, state.compare] : undefined,
          damping: opts.damping || undefined,
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
      const strobe = kind === "turntable" && opts.strobe && !reduceMotion;
      const sym = TAU / current.N;
      // Strobe: one frame per flash; the loop closes once the drift adds up to a whole 2π/N.
      const total = strobe
        ? Math.abs(opts.drift) > 1e-3 ? Math.min(150, Math.max(12, Math.round(1 / Math.abs(opts.drift)))) : 30
        : Math.round(dur * fps);
      const spin0 = spinAngle;
      const angleAt = (i) => (strobe ? spin0 + i * sym * (1 + opts.drift) : spin0 + (TAU * i) / total);
      const c = document.createElement("canvas");
      c.width = c.height = size;
      const g = c.getContext("2d", { willReadFrequently: true });
      try {
        for (let i = 0; i < total; i++) {
          step(i === 0 ? 0 : 1 / fps, kind === "turntable" ? angleAt(i) : undefined);
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
      if (state.style !== "glow") p.set("st", state.style);
      if (state.kaleido !== "full") p.set("ks", state.kaleido);
      if (state.transition !== "morph") p.set("tr", state.transition);
      if (state.lithoShape !== "disc") p.set("ls", state.lithoShape);
      if (state.vcScheme !== "or") p.set("vc", state.vcScheme);
      if (state.compare) p.set("cmp", state.compare);
      if (state.nb >= 0) p.set("nb", String(state.nb));
      if ((state.compare || state.nb >= 0) && state.layout !== "side") p.set("lay", state.layout);
      if (state.child >= 0 && state.compare) p.set("child", String(state.child));
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
        layout: ["overlay", "difference"].includes(p.get("lay")) ? p.get("lay") : "side",
        style: STYLES.includes(p.get("st")) ? p.get("st") : "glow",
        kaleido: KALEIDO.includes(p.get("ks")) ? p.get("ks") : "full",
        transition: p.get("tr") === "shatter" ? "shatter" : "morph",
        lithoShape: p.get("ls") === "dome" ? "dome" : "disc",
        vcScheme: p.get("vc") === "xor" ? "xor" : "or",
        vcView: "stack",
        nb: /^\d+$/.test(p.get("nb") || "") && +p.get("nb") < 128 ? +p.get("nb") : -1,
        child: /^\d+$/.test(p.get("child") || "") && +p.get("child") < 256 && p.get("cmp") ? +p.get("child") : -1,
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
      if (state.compare || state.nb >= 0) refreshCompare();
      if (state.mode === "pendant") buildPendant();
      if (state.mode === "lithophane") buildLitho();
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

    function escapeHtml(text) {
      return String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
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
    setHash(mainHash(), "draw");
    if (state.compare || state.nb >= 0) {
      refreshCompare(true);
      syncUi();
      if (!initial.view.cam && state.layout === "side") camera.position.multiplyScalar(1.6);
    }
    if (state.mode === "pendant") buildPendant();
    if (state.mode === "lithophane") buildLitho();
    updateAvalanche();
    kick();

    VH3D.debug = {
      state, opts, setMode, setLift, setSeed, setCompare, setLayout, applyPreset, flyTo, replay, camera, controls,
      draw, grow, morph, shadeG, step, shareUrl, fx, setStyle, setKaleido, mapPoint, scene,
      get litho() { return litho; },
      get audio() { return audio; },
      get running() { return running; },
      get current() { return current; },
      get pendant() { return pendant; },
      renderer,
      render: () => composer.render(),
    };
  }
})();
