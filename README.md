# Visual Hashing v.2.2.0
Mathematic is Beautiful #oldstuff #project #last updated (13/05/2021)

<img src="Cover.JPG">

## 3D Version (three.js)
Open `3d/index.html` in a browser (double-click works; three.js loads from a CDN).

+ **Sculpture** — the curve is lifted by signals already inside the algorithm (radius wobble, phase wobble, epicycle amplitude). Seen from the top with zero lift it is the original 2D image.
+ **Lotus** — the three triangle layers float apart and spin like gears.
+ **Sphere / Torus** — the plane wrapped onto a globe (inverse stereographic projection) or a ring.
+ **Pendant** — the curve as a solid tube with a frame ring and bail, exported as a 40 mm STL for 3D printing.
+ Morphs between names while you type, draw-on animation, shareable `?name=` links, PNG (3D view and original 2D), GLB export.
+ Seed: **Legacy v2** gives exactly the same images as this page; **v3** seeds the generator with SHA-256 of the name (no collisions from character positions).

`node 3d/test/verify.js` checks that the 3D core draws exactly the same triangles as the original `index.js`.

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
