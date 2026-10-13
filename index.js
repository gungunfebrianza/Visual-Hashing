// Visual Hashing 2D page. The algorithm lives in 3d/visualhash.js, shared with the
// 3D version; the untouched v2.2.0 script is kept in 3d/test/reference/ and the
// parity test (node 3d/test/verify.js) proves both draw exactly the same image.
var canvas, ctx;
canvas = document.getElementsByTagName("canvas")[0];
ctx = canvas.getContext("2d");
canvas.width = canvas.height = 400;
ctx.fillRect(0, 0, 400, 400);

var timeout;
var toggle_start_random = false;
var urlTimer;
var seed = "legacy";

init();

function init() {
  var params = new URLSearchParams(location.search);
  seed = params.get("seed") === "v3" ? "v3" : "legacy";
  if (params.has("name")) {
    document.getElementById("textpattern").value = params.get("name");
    stp();
  } else {
    execute_generate();
  }
}

function execute_generate() {
  document.getElementById("textpattern").value = chance.name({ middle: true });
  stp();
}

function change_style_btn_generate(stop_true) {
  if (stop_true) {
    document.getElementById("btn_generate").innerHTML = "Auto random name";
    document.getElementById("btn_generate").classList.add("btn-outline-dark");
    document.getElementById("btn_generate").classList.remove("btn-danger");
  } else {
    document.getElementById("btn_generate").innerHTML = "Stop auto random name";
    document
      .getElementById("btn_generate")
      .classList.remove("btn-outline-dark");
    document.getElementById("btn_generate").classList.add("btn-danger");
  }
}

function start() {
  if (toggle_start_random) {
    change_style_btn_generate(false);
  } else {
    change_style_btn_generate(true);
  }
  if (toggle_start_random) {
    timeout = setTimeout(function () {
      execute_generate();
      start();
    }, 2000);
  } else {
    clearTimeout(timeout);
  }
}

function manual_generate() {
  toggle_start_random = !toggle_start_random;
  if (toggle_start_random) {
    start();
  } else {
    change_style_btn_generate(true);
    clearTimeout(timeout);
  }
}

function eventkeypress(e) {
  if (!e) e = window.event;
  if (e.keyCode == 13) {
    stp();
    return false;
  }
}

function visualhash() {
  change_style_btn_generate(true);
  clearTimeout(timeout);
  document.getElementById("textpattern").value = chance.name({ middle: true });
  stp();
}

function stop_loop() {
  toggle_start_random = false;
  change_style_btn_generate(true);
  clearTimeout(timeout);
}

function set_seed(value) {
  seed = value === "v3" ? "v3" : "legacy";
  stp();
}

function stp(e) {
  if (typeof e != "undefined") {
    toggle_start_random = false;
    change_style_btn_generate(true);
    clearTimeout(timeout);
  }
  var name = document.getElementById("textpattern").value;
  VisualHash.render2D(VisualHash.compute(name, { seed: seed }), ctx);
  update_links(name);

  document.getElementById("output_cont").classList.remove("fadein");
  setTimeout(() => {
    document.getElementById("output_cont").classList.add("fadein");
  }, 200);
}

// Same parameters as the 3D page: ?name=...&seed=v3 (legacy is the default).
function query(name) {
  var p = new URLSearchParams();
  p.set("name", name);
  if (seed === "v3") p.set("seed", "v3");
  return "?" + p.toString();
}

function update_links(name) {
  var buttons = document.querySelectorAll("[data-seed]");
  for (var i = 0; i < buttons.length; i++) {
    var on = buttons[i].getAttribute("data-seed") === seed;
    buttons[i].classList.toggle("active", on);
    buttons[i].setAttribute("aria-pressed", String(on));
  }
  // Legacy seeding repeats every 16 characters, so longer names can collide.
  document.getElementById("seed_hint").hidden = !(seed === "legacy" && name.length > 16);
  document.getElementById("btn_3d").href = "3d/index.html" + query(name);

  clearTimeout(urlTimer);
  urlTimer = setTimeout(function () {
    try {
      history.replaceState(null, "", location.href.split(/[?#]/)[0] + query(name));
    } catch (err) {
      /* some browsers refuse replaceState on file:// */
    }
  }, 250);
}

function download_cnv(button) {
  var cnv = document.getElementById("cnv");
  const name = document.getElementById("textpattern").value;
  var dataURL = cnv.toDataURL("image/png");
  button.setAttribute("download", `${name}.png`);
  button.href = dataURL;
}
