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
// Desaturated copy of the Kenney palette texture: buildings colorize cleanly
// with faction colors while keeping window/door detail. Built lazily.
const desatCache = new WeakMap();
export function desaturatedMap(fromTexture) {
  if (desatCache.has(fromTexture)) return desatCache.get(fromTexture);
  const img = fromTexture.image;
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  const d = g.getImageData(0, 0, c.width, c.height);
  for (let i = 0; i < d.data.length; i += 4) {
    const l = d.data[i] * 0.299 + d.data[i + 1] * 0.587 + d.data[i + 2] * 0.114;
    const v = Math.min(255, 60 + l * 0.85); // lift shadows a touch
    d.data[i] = d.data[i + 1] = d.data[i + 2] = v;
  }
  g.putImageData(d, 0, 0);
  const out = new (fromTexture.constructor)(c);
  out.flipY = fromTexture.flipY;
  out.colorSpace = fromTexture.colorSpace;
  out.needsUpdate = true;
  desatCache.set(fromTexture, out);
  return out;
}

// Geometry surgery: Kenney nature tiles are ONE merged mesh (ground slab +
// trees). Drop every triangle that never rises above the slab, re-root the
// rest at y=0, and the trees grow straight out of the terrain.
export function stripBaseTile(srcObj, yThreshold = 0.1) {
  let mesh = null;
  srcObj.updateMatrixWorld(true);
  srcObj.traverse(o => { if (o.isMesh && !mesh) mesh = o; });
  let geo = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
  geo = geo.clone();
  geo.applyMatrix4(mesh.matrixWorld);
  const pos = geo.attributes.position, norm = geo.attributes.normal, uv = geo.attributes.uv;
  const keepP = [], keepN = [], keepU = [];
  for (let i = 0; i < pos.count; i += 3) {
    const maxY = Math.max(pos.getY(i), pos.getY(i + 1), pos.getY(i + 2));
    if (maxY <= yThreshold) continue;
    for (let k = 0; k < 3; k++) {
      keepP.push(pos.getX(i + k), pos.getY(i + k), pos.getZ(i + k));
      if (norm) keepN.push(norm.getX(i + k), norm.getY(i + k), norm.getZ(i + k));
      if (uv) keepU.push(uv.getX(i + k), uv.getY(i + k));
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(keepP, 3));
  if (keepN.length) out.setAttribute('normal', new THREE.Float32BufferAttribute(keepN, 3));
  if (keepU.length) out.setAttribute('uv', new THREE.Float32BufferAttribute(keepU, 2));
  out.computeBoundingBox();
  out.translate(0, -out.boundingBox.min.y - 0.03, 0); // roots kiss the soil
  return { geometry: out, material: mesh.material };
}

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
