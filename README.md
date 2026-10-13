# Visual Hashing v.2.2.0
Mathematic is Beautiful #oldstuff #project #last updated (13/05/2021)

<img src="Cover.JPG">

## 3D Version (three.js)
Open `3d/index.html` in a browser. Double-click works and no internet is needed: three.js is bundled in `3d/vendor/`.

+ **Sculpture** — the curve is lifted by signals already inside the algorithm (radius wobble, phase wobble, epicycle amplitude). Seen from the top with zero lift it is the original 2D image.
+ **Lotus** — the three triangle layers float apart and spin like gears.
+ **Sphere / Torus** — the plane wrapped onto a globe (inverse stereographic projection) or a ring; **Wrap** sets how much reaches the far side.
+ **Pendant** — the curve as a tube with a frame ring and bail. **STL** and **3MF** exports merge everything into one watertight solid (manifold-3d, 10–15 s), with real size in mm and a warning when the tube is too thin to print.
+ **Lithophane** — brightness becomes thickness (0.8–3.2 mm): a disc to hang in a window or a dome lamp shade. The preview lights it from behind; STL and 3MF are watertight.
+ **Presets** — *Original* (flat, no glow, from above: the 2D image inside the 3D one), *Showcase*, *Print*.
+ **Light** — every triangle keeps the light it has in the original (alpha × area = 55 px) and the shader spreads it over the triangle's projected area, so tilted, lifted and wrapped forms keep the same overall brightness without per-form constants.
+ **Compare** — a second name side by side, overlaid (orange + blue; identical light turns white) or as a *Difference* (|A − B|: identical light cancels to black, so a collision disappears). *Twist* turns the second hash a few degrees for moiré. *Show a collision* demonstrates two 17-character names that share a legacy seed.
+ **Art styles** — each one is a structure already in the hash, drawn in the language of a medium with the same structure:
  + *Oscilloscope*: beam brightness ∝ 1/speed, the same law as alpha ∝ 1/area. *Play sound* sends x and y to the left and right channels, so a real oscilloscope in XY mode draws the hash (also as WAV).
  + *Caustics*: a rippling water surface refracts the points; each triangle keeps its light, so the light focuses and spreads like real caustics.
  + *Long exposure*: photons collect with shot noise; *Shutter* sets how grainy the final frame stays.
  + *Spectrum*: each layer is a wavelength and bends by its hue, with a chromatic split.
  + *Aurora*: curtains of light rise from the curve.
  + *Stained glass*, *Risograph*, *Pen plotter*: the dual of additive light — inks absorbing on paper. Risograph exports one SVG layer per ink, the plotter an SVG in pen layers and drawing order.
  + *String art*: nails on the curve, each layer one thread walking j → j + t; exports a printable nail template and the thread order.
  + *ASCII*: the image typed with the characters of the name itself.
+ **Symmetry view** — *Wedge* shows one 2π/N wedge (it holds the whole image); *Mirror* folds it into a kaleidoscope.
+ **Motion** — *Shatter* breaks the old hash into its triangles when the name changes; *Strobe* turns the turntable 2π/N per flash so the image freezes like a zoetrope (*Drift* makes it creep; the turntable GIF follows the flashes); the *Epicycle machine* shows the three rotating arms whose sum draws the curve.
+ **Explore** — the *Avalanche* readout counts the seed bits each keystroke flips (about 64 of 128 with v3, a handful with the legacy seed); *1-bit neighbours* shows the images of the seed with one bit flipped; *Breed* mixes gene groups of the two names into children; *Damping* turns the curve into a decaying harmonograph. Children and damping are marked *art mode*: the image is no longer the hash of the name.
+ **Layers** — click a layer in *Hash DNA* to hide it, hover to highlight it.
+ **Share** — the address bar keeps name, seed, form and every slider; *Copy link* (or `C`) also stores the exact camera and turntable angle.
+ **Export** — PNG (3D view and original 2D), Domemaster PNG (180° fisheye from inside the form, for planetarium domes), GLB (alpha baked as seen, optional glowing curve tube, seed and link in the node extras), video (MP4/WebM) and GIF of the draw-on or a turntable.
+ **Keyboard** — `1`–`6` forms, `V` next style (`Shift`+`V` previous), `K` symmetry view, `M` epicycle machine, `O` `S` `P` presets, `T`/`A` views, `R` replay, `Space` turntable, `C` copy link, `/` name, `?` help. Segmented controls are radio groups (arrow keys).
+ Respects *reduce motion*, renders only while something moves, recovers from a lost WebGL context, and turns the panel into a bottom sheet on phones.
+ Seed: **Legacy v2** gives exactly the same images as this page; **v3** seeds the generator with SHA-256 of the name (no collisions from character positions) and uses its own sine and cosine, built from `+ - * /` only, so a v3 image is bit-identical in every browser and every language that avoids fused multiply-add.

The 2D page (`index.html`) now draws through the same core, `3d/visualhash.js`, and gained the seed choice and a *View in 3D* link (`?name=…&seed=v3` works on both pages).

### Tests and test vectors
`npm test` runs `3d/test/verify.js` and `3d/test/art.js`, which check:

+ the original v2.2.0 script, frozen in `3d/test/reference/index-v2.2.0.js`, and the shared core draw exactly the same triangles;
+ SHA-256 against Node's crypto, and the portable sine/cosine against `Math.sin`/`Math.cos` (max error 1.1e-16);
+ `3d/test/vectors.json`: seed, parameters, layer counts and SHA-256 digests of the points and triangle indices for 16 names × 2 seeds. Ports to other languages can check themselves against it; v3 entries must match bit for bit, legacy entries are a V8 reference. `3d/test/portable_trig.py` is a Python port of the trig;
+ the art data (`3d/lib/art.js`): seed bits, crossover (children keep exact N-fold symmetry), string art plans, SVG and WAV exports, and that both lithophanes are watertight and outward-facing.

`npm install && npm run build:vendor` rebuilds `3d/vendor/` (three.js 0.160.0 and manifold-3d bundles).

## Other Example
<img src="assets/War.JPG" width=700>  

<img src="assets/Random1.JPG" width=700>  

<img src="assets/Baby.JPG" width=700>  
<img src="assets/Luhut.JPG" width=700>  
<img src="assets/Merugikan.JPG" width=700>  
<img src="assets/Sontoloyo.JPG" width=700>  
<img src="assets/Aman.JPG" width=700>  

<img src="assets/Random2.JPG" width=700>  

<img src="assets/Die.JPG" width=700>  
<img src="assets/Iwan.JPG" width=700> 
<img src="assets/Yusuf.JPG" width=700>  
<img src="assets/Disaster.JPG" width=700>  
<img src="assets/Bitcoin.JPG" width=700>  
<img src="assets/Blockchain.JPG" width=700>  
<img src="assets/Honeymoon.JPG" width=700> 
<img src="assets/Pregnant.JPG" width=700> 
<img src="assets/Kafir.JPG" width=700> 
<img src="assets/Faraday.JPG" width=700> 
<img src="assets/Marry.JPG" width=700> 
<img src="assets/Baphomet.JPG" width=700>  
<img src="assets/Visual Hashing.JPG" width=700>  

### Contributor : 
+ Earlier UI - [Eas](https://github.com/easterneas)
+ New UI - [Yuma Yusuf](https://github.com/yumavol)
+ Random Generation + Automation - [Yuma Yusuf](https://github.com/yumavol)
+ Add Spin & Animation - [Rahmat Agung ](https://github.com/rahmatagungj)
+ Add Social Button, On Input Event, Optimize Code [Muhammad Fauzan](https://github.com/fauzan121002)

### Remake : 
+ Visual Hashing in [Rust](https://www.emsifa.com/visual-hashing-yew) by [Muhammad Syifa](https://github.com/emsifa)
<img src="assets/Rust-based.JPG" width=350>  
+ Visual Hashing in [Golang](https://github.com/ibrahim4529/gotk-visual-hash) by [Ibrahim](https://github.com/ibrahim4529)
