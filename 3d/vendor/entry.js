// Entry for three.bundle.min.js: everything the 3D page needs from three.js,
// exposed as one global so the page runs offline and from file://.
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { STLExporter } from "three/examples/jsm/exporters/STLExporter.js";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";

window.VH3D_DEPS = {
  THREE,
  OrbitControls,
  EffectComposer,
  RenderPass,
  UnrealBloomPass,
  OutputPass,
  RoomEnvironment,
  STLExporter,
  GLTFExporter,
};
