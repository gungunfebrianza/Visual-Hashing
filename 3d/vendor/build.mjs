// Builds the vendored browser bundles:
//   three.bundle.min.js  three.js + the addons the 3D page uses (window.VH3D_DEPS)
//   manifold.bundle.js   manifold-3d with its WASM embedded. The code is stored as
//                        a string (window.VHManifoldSource) so 3d/lib/solidify.js
//                        can start it inside a blob Worker, even from file://.
// Run: npm install && npm run build:vendor
import { build } from "esbuild";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const pkg = (name) => JSON.parse(readFileSync(join(root, "node_modules", name, "package.json"), "utf8"));

const three = pkg("three");
await build({
  entryPoints: [join(here, "entry.js")],
  outfile: join(here, "three.bundle.min.js"),
  bundle: true,
  minify: true,
  format: "iife",
  target: "es2018",
  legalComments: "none",
  banner: {
    js:
      "/*! three.js r" + three.version.split(".")[1] + " (" + three.version + ") + addons | " +
      "Copyright 2010-2023 Three.js Authors | MIT License | https://github.com/mrdoob/three.js */",
  },
});

const manifold = pkg("manifold-3d");
const out = await build({
  entryPoints: [join(here, "manifold-entry.js")],
  bundle: true,
  minify: true,
  write: false,
  format: "iife",
  target: "es2020",
  platform: "browser",
  loader: { ".wasm": "binary" },
  external: ["node:module"],
  define: { "import.meta.url": '"file:///manifold.js"' },
  legalComments: "none",
});
writeFileSync(
  join(here, "manifold.bundle.js"),
  "/*! manifold-3d " + manifold.version + " | Copyright 2020 The Manifold Authors | " +
    "Apache License 2.0 | https://github.com/elalish/manifold */\n" +
    "window.VHManifoldSource = " + JSON.stringify(out.outputFiles[0].text) + ";\n"
);

console.log("built three " + three.version + ", manifold-3d " + manifold.version);
