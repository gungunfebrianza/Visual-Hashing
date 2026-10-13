# Visual Hashing v.2.2.0
Mathematic is Beautiful #oldstuff #project #last updated (13/05/2021)

<img src="Cover.JPG">

## 3D Version (three.js)
Open `3d/index.html` in a browser. Double-click works and no internet is needed: three.js is bundled in `3d/vendor/`.

+ **Sculpture** — the curve is lifted by signals already inside the algorithm (radius wobble, phase wobble, epicycle amplitude). Seen from the top with zero lift it is the original 2D image.
+ **Lotus** — the three triangle layers float apart and spin like gears.
+ **Sphere / Torus** — the plane wrapped onto a globe (inverse stereographic projection) or a ring; **Wrap** sets how much reaches the far side.
+ **Pendant** — the curve as a tube with a frame ring and bail. **STL** and **3MF** exports merge everything into one watertight solid (manifold-3d, 10–15 s), with real size in mm and a warning when the tube is too thin to print.
+ **Presets** — *Original* (flat, no glow, from above: the 2D image inside the 3D one), *Showcase*, *Print*.
+ **Light** — every triangle keeps the light it has in the original (alpha × area = 55 px) and the shader spreads it over the triangle's projected area, so tilted, lifted and wrapped forms keep the same overall brightness without per-form constants.
+ **Compare** — a second name side by side or overlaid (orange + blue; identical light turns white). *Show a collision* demonstrates two 17-character names that share a legacy seed.
+ **Layers** — click a layer in *Hash DNA* to hide it, hover to highlight it.
+ **Share** — the address bar keeps name, seed, form and every slider; *Copy link* (or `C`) also stores the exact camera and turntable angle.
+ **Export** — PNG (3D view and original 2D), GLB (alpha baked as seen, optional glowing curve tube, seed and link in the node extras), video (MP4/WebM) and GIF of the draw-on or a turntable.
+ **Keyboard** — `1`–`5` forms, `O` `S` `P` presets, `T`/`A` views, `R` replay, `Space` turntable, `C` copy link, `/` name, `?` help. Segmented controls are radio groups (arrow keys).
+ Respects *reduce motion*, renders only while something moves, recovers from a lost WebGL context, and turns the panel into a bottom sheet on phones.
+ Seed: **Legacy v2** gives exactly the same images as this page; **v3** seeds the generator with SHA-256 of the name (no collisions from character positions) and uses its own sine and cosine, built from `+ - * /` only, so a v3 image is bit-identical in every browser and every language that avoids fused multiply-add.

The 2D page (`index.html`) now draws through the same core, `3d/visualhash.js`, and gained the seed choice and a *View in 3D* link (`?name=…&seed=v3` works on both pages).

### Tests and test vectors
`npm test` (or `node 3d/test/verify.js`) checks:

+ the original v2.2.0 script, frozen in `3d/test/reference/index-v2.2.0.js`, and the shared core draw exactly the same triangles;
+ SHA-256 against Node's crypto, and the portable sine/cosine against `Math.sin`/`Math.cos` (max error 1.1e-16);
+ `3d/test/vectors.json`: seed, parameters, layer counts and SHA-256 digests of the points and triangle indices for 16 names × 2 seeds. Ports to other languages can check themselves against it; v3 entries must match bit for bit, legacy entries are a V8 reference. `3d/test/portable_trig.py` is a Python port of the trig.

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
