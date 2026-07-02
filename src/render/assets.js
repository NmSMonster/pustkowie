// Loads every GLB once; hands out clones. Skinned characters are cloned with
// SkeletonUtils so each instance owns its skeleton + AnimationMixer.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as skClone } from 'three/addons/utils/SkeletonUtils.js';

const MODELS = {
  // rigged characters
  xbot: 'assets/models/Xbot.glb',                    // Researcher
  robot: 'assets/models/RobotExpressive.glb',        // Agent
  soldier: 'assets/models/Soldier.glb',              // Sentinel
  // buildings (Kenney City Builder)
  hq: 'assets/models/city/building-small-c.glb',
  datacenter: 'assets/models/city/building-garage.glb',
  campus: 'assets/models/city/building-small-b.glb',
  foundry: 'assets/models/city/building-small-d.glb',
  lobby: 'assets/models/city/building-small-a.glb',
  synth: 'assets/models/city/pavement-fountain.glb',
  wall: 'assets/models/fps/wall-high.glb',           // tower base
  // props
  trees: 'assets/models/city/grass-trees.glb',
  treesTall: 'assets/models/city/grass-trees-tall.glb',
  pavement: 'assets/models/city/pavement.glb',
  coin: 'assets/models/platformer/coin.glb',         // data node core
  flag: 'assets/models/platformer/flag.glb',
};

export const assets = { models: {}, anims: {} };

export async function loadAssets(onProgress = () => {}) {
  const loader = new GLTFLoader();
  const names = Object.keys(MODELS);
  let done = 0;
  await Promise.all(names.map(async (name) => {
    const gltf = await loader.loadAsync(MODELS[name]);
    gltf.scene.traverse(o => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = true;
        if (o.material) o.material.shadowSide = THREE.FrontSide;
      }
    });
    assets.models[name] = gltf.scene;
    assets.anims[name] = gltf.animations;
    onProgress(++done / names.length);
  }));
  return assets;
}

export function instance(name) {
  const src = assets.models[name];
  let skinned = false;
  src.traverse(o => { if (o.isSkinnedMesh) skinned = true; });
  const obj = skinned ? skClone(src) : src.clone(true);
  return obj;
}

// Tint helper: recolors meshes that carry the kit's neutral palette so each
// faction's buildings and units read at a glance. Clones materials per call.
export function tint(obj, hex, strength = 0.55) {
  const c = new THREE.Color(hex);
  obj.traverse(o => {
    if (o.isMesh && o.material) {
      o.material = o.material.clone();
      if (o.material.color) o.material.color.lerp(c, strength);
    }
  });
  return obj;
}
