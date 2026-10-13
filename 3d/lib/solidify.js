/*
 * Print-ready pendant solid, built with manifold-3d (WASM).
 *
 * The preview pendant is a swept tube that crosses itself hundreds of times,
 * so its mesh is not a valid solid. Here the same shape is rebuilt as a union
 * of convex pieces: one capsule (hull of two small spheres) per curve segment,
 * plus the frame ring and the bail as revolved tori. Manifold turns that into
 * one watertight mesh with no self-intersections.
 *
 * The union is the slow part (several seconds for a typical name), so it runs
 * in a blob Worker and reports progress. Pieces are merged as a tree: 16
 * consecutive capsules at a time, then neighbouring results pairwise, which is
 * faster than one big batch union.
 *
 *   VHSolid.load()                    -> Promise, loads ../vendor/manifold.bundle.js once
 *   VHSolid.pendant(spec, onProgress) -> Promise<{
 *       positions: Float32Array, indices: Uint32Array, triangles,
 *       volume, surfaceArea, genus, status, size: [x, y, z], pieces, ms }>
 *   onProgress(fraction 0..1)
 *
 * spec = {
 *   path:     Float32Array of x,y,z (closed loop, world units, z up)
 *   radius:   tube radius
 *   ring:     { radius, tube, z } | null   torus in the xy plane, centred on 0
 *   bail:     { x, y, z, radius, tube }    torus standing in the yz plane
 *                                          (three.js TorusGeometry with rotation.y = PI/2)
 *   scale:    multiplies every output coordinate (e.g. world -> mm), default 1
 *   segments: circle segments for the tube cross-section, default 8
 * }
 *
 * Plain script: works from file:// (the WASM is embedded in the bundle).
 */
(function (root) {
  "use strict";

  var scriptSrc =
    typeof document !== "undefined" && document.currentScript ? document.currentScript.src : "";
  var loading = null;
  var direct = null; // { wasm } when running on this thread (Node, or no Worker support)
  var worker = null;
  var queue = Promise.resolve();
  var jobs = {};
  var nextJob = 1;

  // Build the solid. Runs inside the Worker (via toString), so it must not use
  // anything from the enclosing scope.
  function build(wasm, spec, progress) {
    var t0 = Date.now();
    var Manifold = wasm.Manifold;
    var segs = spec.segments || 8;
    var radius = spec.radius;
    var path = spec.path;
    var all = [];

    // Unit-sphere sample points: latitude rings plus the poles.
    var unit = [[0, 0, 1], [0, 0, -1]];
    var rings = Math.max(2, Math.round(segs / 2) - 1);
    for (var i = 1; i <= rings; i++) {
      var phi = (Math.PI * i) / (rings + 1);
      for (var j = 0; j < segs; j++) {
        var th = (2 * Math.PI * (j + (i % 2) * 0.5)) / segs;
        unit.push([Math.sin(phi) * Math.cos(th), Math.sin(phi) * Math.sin(th), Math.cos(phi)]);
      }
    }

    // Drop points much closer than the tube radius: they add pieces, not shape.
    var pts = [[path[0], path[1], path[2]]];
    var minD2 = radius * 0.6 * (radius * 0.6);
    for (i = 1; i < path.length / 3; i++) {
      var last = pts[pts.length - 1];
      var x = path[i * 3], y = path[i * 3 + 1], z = path[i * 3 + 2];
      var dx = x - last[0], dy = y - last[1], dz = z - last[2];
      if (dx * dx + dy * dy + dz * dz >= minD2) pts.push([x, y, z]);
    }

    var capsules = [];
    for (i = 0; i < pts.length; i++) {
      var a = pts[i], b = pts[(i + 1) % pts.length];
      var hull = [];
      for (var k = 0; k < unit.length; k++) {
        var u = unit[k];
        hull.push([a[0] + u[0] * radius, a[1] + u[1] * radius, a[2] + u[2] * radius]);
        hull.push([b[0] + u[0] * radius, b[1] + u[1] * radius, b[2] + u[2] * radius]);
      }
      capsules.push(Manifold.hull(hull));
    }
    all = all.concat(capsules);

    // Count the unions so progress is roughly proportional to work.
    var LEAF = 16;
    var leaves = Math.ceil(capsules.length / LEAF);
    var total = leaves + Math.max(0, leaves - 1) + (spec.scale && spec.scale !== 1 ? 2 : 1);
    var done = 0;
    function step(m) {
      m.numTri(); // force evaluation so progress reflects real work
      all.push(m);
      done++;
      progress(done / total);
      return m;
    }

    var level = [];
    for (i = 0; i < capsules.length; i += LEAF) level.push(step(Manifold.union(capsules.slice(i, i + LEAF))));
    while (level.length > 1) {
      var next = [];
      for (i = 0; i < level.length; i += 2) {
        next.push(i + 1 < level.length ? step(Manifold.union([level[i], level[i + 1]])) : level[i]);
      }
      level = next;
    }

    var parts = [level[0]];
    function torus(R, r, ringSegs) {
      var cs = wasm.CrossSection.circle(r, segs);
      var moved = cs.translate([R, 0]);
      var m = moved.revolve(ringSegs);
      cs.delete();
      moved.delete();
      all.push(m);
      return m;
    }
    if (spec.ring) {
      var ring = torus(spec.ring.radius, spec.ring.tube, 180).translate([0, 0, spec.ring.z]);
      all.push(ring);
      parts.push(ring);
    }
    if (spec.bail) {
      var bl = spec.bail;
      var bail = torus(bl.radius, bl.tube, 48).rotate([0, 90, 0]);
      all.push(bail);
      var placed = bail.translate([bl.x, bl.y, bl.z]);
      all.push(placed);
      parts.push(placed);
    }
    var solid = step(Manifold.union(parts));
    if (spec.scale && spec.scale !== 1) solid = step(solid.scale(spec.scale));

    var mesh = solid.getMesh();
    var np = mesh.numProp;
    var nv = mesh.vertProperties.length / np;
    var positions = new Float32Array(nv * 3);
    var lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (var v = 0; v < nv; v++) {
      for (var c = 0; c < 3; c++) {
        var val = mesh.vertProperties[v * np + c];
        positions[v * 3 + c] = val;
        if (val < lo[c]) lo[c] = val;
        if (val > hi[c]) hi[c] = val;
      }
    }
    var result = {
      positions: positions,
      indices: new Uint32Array(mesh.triVerts),
      triangles: mesh.triVerts.length / 3,
      volume: solid.volume(),
      surfaceArea: solid.surfaceArea(),
      genus: solid.genus(),
      status: String(solid.status && solid.status().value !== undefined ? solid.status().value : solid.status()),
      size: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]],
      pieces: capsules.length + parts.length - 1,
      ms: 0,
    };
    all.forEach(function (m) {
      m.delete();
    });
    result.ms = Date.now() - t0;
    return result;
  }

  // Worker body (stringified). VHManifoldModule is defined by the bundle code
  // prepended to it.
  function workerMain() {
    var ready = null;
    self.onmessage = function (e) {
      var id = e.data.id;
      ready = ready || self.VHManifoldModule().then(function (w) {
        w.setup();
        return w;
      });
      ready
        .then(function (wasm) {
          var r = build(wasm, e.data.spec, function (f) {
            self.postMessage({ id: id, progress: f });
          });
          self.postMessage({ id: id, result: r }, [r.positions.buffer, r.indices.buffer]);
        })
        .catch(function (err) {
          self.postMessage({ id: id, error: String((err && err.message) || err) });
        });
    };
  }

  function injectBundle() {
    if (root.VHManifoldSource) return Promise.resolve(root.VHManifoldSource);
    return new Promise(function (resolve, reject) {
      var s = document.createElement("script");
      s.src = new URL("../vendor/manifold.bundle.js", scriptSrc || document.baseURI).href;
      s.onload = function () {
        root.VHManifoldSource ? resolve(root.VHManifoldSource) : reject(new Error("manifold bundle did not register"));
      };
      s.onerror = function () {
        reject(new Error("could not load " + s.src));
      };
      document.head.appendChild(s);
    });
  }

  function startWorker(source) {
    var code = source + "\n;var build = " + build.toString() + ";\n(" + workerMain.toString() + ")();\n";
    var url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
    var w = new Worker(url);
    URL.revokeObjectURL(url);
    w.onmessage = function (e) {
      var job = jobs[e.data.id];
      if (!job) return;
      if (e.data.progress !== undefined) return job.progress(e.data.progress);
      delete jobs[e.data.id];
      e.data.error ? job.reject(new Error(e.data.error)) : job.resolve(e.data.result);
    };
    w.onerror = function (e) {
      Object.keys(jobs).forEach(function (id) {
        jobs[id].reject(new Error(e.message || "worker failed"));
        delete jobs[id];
      });
    };
    return w;
  }

  function mainThreadWasm(factory) {
    return Promise.resolve(factory()).then(function (w) {
      w.setup();
      direct = { wasm: w };
    });
  }

  // `factory` (optional) is a manifold module factory, e.g. the npm package's
  // default export; it makes everything run on the calling thread (Node tests).
  function load(factory) {
    if (loading) return loading;
    if (factory) loading = mainThreadWasm(factory);
    else
      loading = injectBundle().then(function (source) {
        try {
          worker = startWorker(source);
        } catch (err) {
          // No blob Workers here: evaluate the bundle on this thread instead.
          (0, eval)(source);
          return mainThreadWasm(root.VHManifoldModule);
        }
      });
    loading.catch(function () {
      loading = null;
    });
    return loading;
  }

  function pendant(spec, onProgress) {
    var progress = onProgress || function () {};
    var run = function () {
      return load().then(function () {
        if (direct) return build(direct.wasm, spec, progress);
        return new Promise(function (resolve, reject) {
          var id = nextJob++;
          jobs[id] = { resolve: resolve, reject: reject, progress: progress };
          worker.postMessage({ id: id, spec: spec });
        });
      });
    };
    // One build at a time; each waits for the previous one to settle.
    var p = queue.then(run, run);
    queue = p.catch(function () {});
    return p;
  }

  var api = { load: load, pendant: pendant };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.VHSolid = api;
})(this);
