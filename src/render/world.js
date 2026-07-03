// Renderer: owns the three.js scene and mirrors sim state into views.
// The sim never imports this; this reads sim state + drains sim events.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { OutlinePass } from 'three/addons/postprocessing/OutlinePass.js';
import { AfterimagePass } from 'three/addons/postprocessing/AfterimagePass.js';
import { Lensflare, LensflareElement } from 'three/addons/objects/Lensflare.js';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { instance, tint, assets, desaturatedMap, stripBaseTile } from './assets.js';
import { BUILDINGS, UNITS, FACTIONS, MAP } from '../sim/data.js';
import { settings, onSettingsChange } from '../settings.js';

// final color grade: vignette + gentle saturation + warm cast (runs pre-tonemap)
const GradeShader = {
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uCA: { value: 0.0016 }, uGrain: { value: 0.014 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; varying vec2 vUv;
    uniform float uTime; uniform float uCA; uniform float uGrain;
    void main(){
      vec4 t = texture2D(tDiffuse, vUv);
      // chromatic aberration: grows toward frame edges
      vec2 toC = vUv - 0.5;
      vec2 caOff = toC * dot(toC, toC) * uCA * 8.0;
      vec3 c = vec3(
        texture2D(tDiffuse, vUv + caOff).r,
        t.g,
        texture2D(tDiffuse, vUv - caOff).b);
      // filmic S-curve for punchy midtones
      c = mix(c, c * c * (3.0 - 2.0 * c), 0.25);
      // split tone: cool shadows / warm highlights (blockbuster grade)
      float l = dot(c, vec3(0.299, 0.587, 0.114));
      c *= mix(vec3(0.93, 1.0, 1.12), vec3(1.07, 1.0, 0.93), smoothstep(0.12, 0.72, l));
      c = mix(vec3(l), c, 1.14);
      float d = distance(vUv, vec2(0.5));
      c *= 1.0 - smoothstep(0.5, 0.95, d) * 0.42;
      // animated film grain
      float gn = fract(sin(dot(vUv * (uTime + 1.0), vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
      c += gn * uGrain;
      gl_FragColor = vec4(c, t.a);
    }`,
};

// screen-space crepuscular rays scattered from the sun's screen position
const GodRayShader = {
  uniforms: { tDiffuse: { value: null }, uSunPos: { value: null }, uIntensity: { value: 0.3 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform vec2 uSunPos; uniform float uIntensity;
    varying vec2 vUv;
    void main(){
      vec4 base = texture2D(tDiffuse, vUv);
      vec2 dir = vUv - uSunPos;
      float dist = length(dir);
      vec2 stepv = dir / 26.0;
      vec3 acc = vec3(0.0);
      vec2 p = vUv;
      float decay = 1.0;
      for (int i = 0; i < 26; i++) {
        p -= stepv;
        vec3 smp = texture2D(tDiffuse, p).rgb;
        float lum = max(0.0, dot(smp, vec3(0.299, 0.587, 0.114)) - 0.72);
        acc += smp * lum * decay;
        decay *= 0.93;
      }
      acc /= 26.0;
      float falloff = smoothstep(1.35, 0.0, dist);
      gl_FragColor = vec4(base.rgb + acc * uIntensity * falloff * vec3(1.0, 0.86, 0.62), base.a);
    }`,
};

const UNIT_MODEL = { researcher: 'xbot', agent: 'robot', sentinel: 'soldier' };
const UNIT_SCALE = { researcher: 1.15, agent: 0.44, sentinel: 1.15 };

export class World {
  constructor(sim, canvas) {
    this.sim = sim;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.5;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x131228);
    this.scene.fog = new THREE.Fog(0x201c38, 150, 330);

    this.camera = new THREE.PerspectiveCamera(46, window.innerWidth / window.innerHeight, 0.5, 400);
    // camera rig: focus point on ground + spherical offset
    this.camFocus = new THREE.Vector3(sim.fac(sim.playerFaction).base.x, 0, sim.fac(sim.playerFaction).base.z);
    this.camDist = 42; this.camYaw = Math.PI * 0.25; this.camPitch = 0.96;

    this.views = new Map();      // entity id -> view
    this.effects = [];           // transient vfx
    this.raycaster = new THREE.Raycaster();
    this._windTime = { value: 0 };
    // day-night cycle (starts mid-afternoon); ?night=0..1 pins it for testing
    this.cycleT = 40; this.cycleLen = 360; this.night = 0;
    const qp = new URLSearchParams(location.search);
    this._forceNight = qp.get('night') !== null ? parseFloat(qp.get('night')) : undefined;

    this.setupLights();
    this.setupSky();
    this.setupTerrain();
    this.setupNodes();

    // image-based lighting for material sheen; a real sunset HDRI streams in
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.35;
    new RGBELoader().load('assets/textures/venice_sunset_1k.hdr', (hdr) => {
      this.scene.environment = pmrem.fromEquirectangular(hdr).texture;
      hdr.dispose();
    }, undefined, () => { /* keep procedural env on failure */ });

    this.setupComposer();

    // auto-quality: step down when fps stays low (helps weak GPUs)
    this._fpsAcc = 0; this._fpsN = 0; this._qLevel = 0;
    this.applyQualitySetting();
    onSettingsChange(() => this.applyQualitySetting());

    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      this.composer?.setSize(window.innerWidth, window.innerHeight);
      this.bloom?.setSize(window.innerWidth, window.innerHeight);
      this.gtao?.setSize(window.innerWidth, window.innerHeight);
      this.outline?.setSize(window.innerWidth, window.innerHeight);
    });
  }

  // ---------------- environment ----------------
  setupLights() {
    this.hemi = new THREE.HemisphereLight(0x7c8fd4, 0x3d3a24, 1.3);
    this.scene.add(this.hemi);
    const sun = new THREE.DirectionalLight(0xffc896, 3.2);
    sun.position.set(55, 58, -80);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const s = 62;
    Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 20, far: 220 });
    sun.shadow.bias = -0.0004;
    this.scene.add(sun);
    this.sun = sun;
    const rim = new THREE.DirectionalLight(0x6a8cff, 0.6);
    rim.position.set(-50, 45, 70);
    this.scene.add(rim);
    this.rim = rim;
  }

  // ---------------- sky ----------------
  setupSky() {
    this.skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { uNight: { value: 0 } },
      vertexShader: `varying vec3 vPos; void main(){ vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `
        varying vec3 vPos; uniform float uNight;
        void main(){
          vec3 dir = normalize(vPos);
          float h = dir.y;
          vec3 zenithD  = vec3(0.030, 0.045, 0.115);
          vec3 midD     = vec3(0.135, 0.120, 0.255);
          vec3 horizonD = vec3(0.92, 0.45, 0.22);
          vec3 zenithN  = vec3(0.004, 0.007, 0.022);
          vec3 midN     = vec3(0.012, 0.020, 0.052);
          vec3 horizonN = vec3(0.045, 0.075, 0.155);
          vec3 zenith = mix(zenithD, zenithN, uNight);
          vec3 midc   = mix(midD, midN, uNight);
          vec3 horizon= mix(horizonD, horizonN, uNight);
          vec3 c = mix(midc, zenith, smoothstep(0.10, 0.55, h));
          c = mix(horizon, c, smoothstep(-0.03, 0.16, h));
          vec3 sunDir = normalize(vec3(0.5, 0.42, -0.72));
          float sunAmt = max(dot(dir, sunDir), 0.0);
          vec3 glowC = mix(vec3(1.0, 0.60, 0.28), vec3(0.65, 0.75, 1.0), uNight);
          c += glowC * pow(sunAmt, mix(60.0, 220.0, uNight)) * mix(1.6, 1.0, uNight);
          c += glowC * pow(sunAmt, 6.0) * mix(0.30, 0.05, uNight);
          gl_FragColor = vec4(c, 1.0);
        }`,
    });
    const sky = new THREE.Mesh(new THREE.SphereGeometry(340, 32, 16), this.skyMat);
    sky.renderOrder = -10;
    this.scene.add(sky);
    const pos = [];
    for (let i = 0; i < 380; i++) {
      const a = Math.random() * Math.PI * 2, e = 0.24 + Math.random() * 1.25, r = 330;
      pos.push(Math.cos(a) * Math.cos(e) * r, Math.sin(e) * r, Math.sin(a) * Math.cos(e) * r);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    this.starMat = new THREE.PointsMaterial({
      color: 0xbfd0ff, size: 1.3, sizeAttenuation: false, transparent: true, opacity: 0.35, fog: false,
    });
    this.scene.add(new THREE.Points(g, this.starMat));
  }

  // crossfades the whole scene between golden hour and deep night
  updateDayNight(dt) {
    this.cycleT = (this.cycleT + dt) % this.cycleLen;
    const ph = this.cycleT / this.cycleLen;
    let n = THREE.MathUtils.smoothstep(ph, 0.50, 0.60) * (1 - THREE.MathUtils.smoothstep(ph, 0.84, 0.96));
    if (this._forceNight !== undefined) n = this._forceNight;
    this.night = n;
    this.skyMat.uniforms.uNight.value = n;
    this.sun.intensity = THREE.MathUtils.lerp(3.2, 0.6, n);
    this.sun.color.lerpColors(new THREE.Color(0xffc896), new THREE.Color(0x8fa4e8), n);
    this.hemi.intensity = THREE.MathUtils.lerp(1.3, 0.55, n);
    this.hemi.color.lerpColors(new THREE.Color(0x7c8fd4), new THREE.Color(0x2e3a63), n);
    this.hemi.groundColor.lerpColors(new THREE.Color(0x3d3a24), new THREE.Color(0x121420), n);
    this.rim.intensity = THREE.MathUtils.lerp(0.6, 0.3, n);
    this.scene.fog.color.lerpColors(new THREE.Color(0x201c38), new THREE.Color(0x070a16), n);
    this.scene.background.copy(this.scene.fog.color);
    this.renderer.toneMappingExposure = THREE.MathUtils.lerp(1.5, 1.34, n);
    this.starMat.opacity = THREE.MathUtils.lerp(0.35, 1.0, n);
    this.scene.environmentIntensity = THREE.MathUtils.lerp(0.35, 0.12, n);
    if (this.bloom) this.bloom.strength = THREE.MathUtils.lerp(0.55, 0.85, n);
    for (const gl of this.lampGlows || []) gl.material.opacity = n * 0.85;
    for (const wm of this.waterMats || []) wm.uniforms.uNight.value = n;
    // aviation lights blink at night
    const blink = Math.sin(this._windTime.value * 3.4) > 0.4 ? 2.4 : 0.25;
    for (const tip of this.antennaTips || []) tip.material.emissiveIntensity = n > 0.15 ? blink : 0.5;
    // morning mist right after dawn + rain closes the fog in
    const ph2 = this.cycleT / this.cycleLen;
    const mist = THREE.MathUtils.smoothstep(ph2, 0.94, 0.985) * (1 - THREE.MathUtils.smoothstep(ph2, 0.02, 0.10));
    const closeK = Math.max(mist, (this.rainK || 0) * 0.7);
    this.scene.fog.near = THREE.MathUtils.lerp(150, 62, closeK);
    this.scene.fog.far = THREE.MathUtils.lerp(330, 190, closeK);
    if (this.rainK > 0.02) {
      this.hemi.intensity *= 1 - this.rainK * 0.25;
      this.sun.intensity *= 1 - this.rainK * 0.35;
    }
    if (this.fireflies) {
      this.fireflies.visible = n > 0.03 && this._qLevel < 2;
      this.fireflyMat.opacity = n * 0.9;
    }
  }

  // gentle wind displacement for foliage/grass (instance-aware)
  addWind(mat, amp) {
    const self = this;
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = self._windTime;
      sh.vertexShader = ('uniform float uTime;\n' + sh.vertexShader).replace('#include <begin_vertex>',
        `#include <begin_vertex>
        {
          vec3 wp = vec3(0.0);
          #ifdef USE_INSTANCING
            wp = vec3(instanceMatrix[3][0], 0.0, instanceMatrix[3][2]);
          #endif
          float wamp = ${amp.toFixed(3)} * max(transformed.y, 0.0);
          transformed.x += sin(uTime * 1.7 + wp.x * 0.6 + wp.z * 0.8) * wamp;
          transformed.z += cos(uTime * 1.3 + wp.x * 0.9) * wamp * 0.6;
        }`);
    };
  }

  noise2(x, z) {
    const xi = Math.floor(x), zi = Math.floor(z), xf = x - xi, zf = z - zi;
    const h = (a, b) => { const v = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return v - Math.floor(v); };
    const u = xf * xf * (3 - 2 * xf), v = zf * zf * (3 - 2 * zf);
    return (h(xi, zi) * (1 - u) + h(xi + 1, zi) * u) * (1 - v) + (h(xi, zi + 1) * (1 - u) + h(xi + 1, zi + 1) * u) * v - 0.5;
  }

  groundTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 1024;
    const g = c.getContext('2d');
    g.fillStyle = '#3d5031'; g.fillRect(0, 0, 1024, 1024);
    for (let i = 0; i < 2600; i++) {
      const x = Math.random() * 1024, y = Math.random() * 1024, r = 6 + Math.random() * 26;
      g.fillStyle = `rgba(${52 + Math.random() * 36 | 0},${82 + Math.random() * 36 | 0},${42 + Math.random() * 22 | 0},0.16)`;
      g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
    }
    g.strokeStyle = 'rgba(255,255,255,0.028)'; g.lineWidth = 1;
    for (let i = 0; i <= 32; i++) {
      g.beginPath(); g.moveTo(i * 32, 0); g.lineTo(i * 32, 1024); g.stroke();
      g.beginPath(); g.moveTo(0, i * 32); g.lineTo(1024, i * 32); g.stroke();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(9, 9);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  setupTerrain() {
    // Rolling hills as a backdrop OUTSIDE the playable square; inside stays flat
    // so gameplay/picking never fight the terrain.
    this.ponds = [{ x: 96, z: 22, r: 17 }, { x: -92, z: -66, r: 13 }];
    const size = 470, seg = 108;
    const geo = new THREE.PlaneGeometry(size, size, seg, seg);
    geo.rotateX(-Math.PI / 2);
    const posA = geo.attributes.position;
    const cols = [];
    const cLow = new THREE.Color(0x495c36), cHigh = new THREE.Color(0x637e46), cRock = new THREE.Color(0x77644a);
    for (let i = 0; i < posA.count; i++) {
      const x = posA.getX(i), z = posA.getZ(i);
      const edge = Math.max(Math.abs(x), Math.abs(z));
      const t = THREE.MathUtils.smoothstep(edge, MAP.half + 4, MAP.half + 46);
      let hgt = t * (this.noise2(x * 0.024, z * 0.024) * 10 + this.noise2(x * 0.075, z * 0.075) * 3.2 + t * 7);
      for (const pd of this.ponds) {
        const d = Math.hypot(x - pd.x, z - pd.z);
        if (d < pd.r * 1.5) hgt = THREE.MathUtils.lerp(-0.6, hgt, THREE.MathUtils.smoothstep(d, pd.r * 0.7, pd.r * 1.5));
      }
      posA.setY(i, hgt);
      const n = this.noise2(x * 0.05 + 9, z * 0.05 - 7) + 0.5;
      const c = cLow.clone().lerp(cHigh, THREE.MathUtils.clamp(n, 0, 1));
      if (hgt > 2.5) c.lerp(cRock, Math.min(1, (hgt - 2.5) / 11) * 0.75);
      cols.push(c.r, c.g, c.b);
    }
    geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    geo.computeVertexNormals();
    const bump = this.bumpTexture();
    const ground = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      map: this.groundTexture(), vertexColors: true, roughness: 0.95,
      bumpMap: bump, bumpScale: 0.35,
    }));
    ground.receiveShadow = true;
    ground.name = 'ground';
    this.ground = ground;
    this.scene.add(ground);
    this.setupGrass();

    // map edge glow frame
    const edge = new THREE.Mesh(
      new THREE.RingGeometry(MAP.half * 1.414, MAP.half * 1.414 + 1.2, 4, 1),
      new THREE.MeshBasicMaterial({ color: 0x2b3f66, transparent: true, opacity: 0.5, side: THREE.DoubleSide })
    );
    edge.rotation.x = -Math.PI / 2; edge.rotation.z = Math.PI / 4;
    edge.position.y = 0.05;
    this.scene.add(edge);

    // organic tree clusters — tiles stripped, trunks rooted in the soil
    const rnd = (a, b) => a + Math.random() * (b - a);
    const clear = [...this.sim.nodes, ...Object.values(this.sim.factions).map(f => ({ x: f.base.x, z: f.base.z }))];
    const variants = ['trees', 'treesTall'].map(k => {
      const { geometry, material } = stripBaseTile(assets.models[k]);
      const mat = material.clone();
      if (mat.color) mat.color.lerp(new THREE.Color(0x27381f), 0.45); // dusk-darkened foliage
      this.addWind(mat, 0.05);
      return { geometry, mat, spots: [] };
    });
    for (let c = 0; c < 14; c++) {
      let cx, cz, ok = false, tries = 0;
      while (!ok && tries++ < 40) {
        cx = rnd(-MAP.half + 6, MAP.half - 6); cz = rnd(-MAP.half + 6, MAP.half - 6);
        ok = clear.every(p => Math.hypot(p.x - cx, p.z - cz) > 13);
      }
      if (!ok) continue;
      const n = 2 + (Math.random() * 3 | 0);
      for (let i = 0; i < n; i++) {
        const a = Math.random() * Math.PI * 2, r = i === 0 ? 0 : rnd(1.6, 4.2);
        variants[Math.random() < 0.55 ? 0 : 1].spots.push({
          x: cx + Math.cos(a) * r, z: cz + Math.sin(a) * r,
          s: rnd(3.1, 5.4), rot: rnd(0, Math.PI * 2), tilt: rnd(-0.035, 0.035),
        });
      }
    }
    const treeAO = [];
    for (const v of variants) {
      if (!v.spots.length) continue;
      const im = new THREE.InstancedMesh(v.geometry, v.mat, v.spots.length);
      im.castShadow = true; im.receiveShadow = true;
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler();
      v.spots.forEach((sp, i) => {
        e.set(sp.tilt, sp.rot, 0);
        q.setFromEuler(e);
        m.compose(new THREE.Vector3(sp.x, 0, sp.z), q, new THREE.Vector3(sp.s, sp.s * rnd(0.9, 1.12), sp.s));
        im.setMatrixAt(i, m);
        treeAO.push(sp);
      });
      this.scene.add(im);
    }
    // pooled contact shadows under every tree
    if (treeAO.length) {
      const aoMesh = new THREE.InstancedMesh(
        new THREE.CircleGeometry(1, 20),
        new THREE.MeshBasicMaterial({ map: this.aoTexture(), transparent: true, depthWrite: false }),
        treeAO.length
      );
      aoMesh.renderOrder = 1;
      const m = new THREE.Matrix4(), q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-Math.PI / 2, 0, 0));
      treeAO.forEach((sp, i) => {
        m.compose(new THREE.Vector3(sp.x, 0.045, sp.z), q, new THREE.Vector3(sp.s * 0.55, sp.s * 0.55, 1));
        aoMesh.setMatrixAt(i, m);
      });
      this.scene.add(aoMesh);
    }

    // circular concrete aprons under each lab, blended into the grass
    for (const f of Object.values(this.sim.factions)) {
      const pad = new THREE.Mesh(
        new THREE.CircleGeometry(10.5, 48),
        new THREE.MeshStandardMaterial({ map: this.concretePadTexture(), transparent: true, roughness: 0.92, depthWrite: false })
      );
      pad.rotation.x = -Math.PI / 2;
      pad.position.set(f.base.x, 0.03, f.base.z);
      pad.receiveShadow = true;
      this.scene.add(pad);
    }

    this.setupRocks();
    this.setupPaths();
    this.setupRoads();
    this.setupLamps();
    this.setupWater();
    this.setupBaseProps();
    this.setupClouds();
    this.setupFireflies();
    this.setupRain();
  }

  setupWater() {
    this.waterMats = [];
    for (const pd of this.ponds) {
      const mat = new THREE.ShaderMaterial({
        transparent: true,
        uniforms: { uTime: this._windTime, uNight: { value: 0 }, uR: { value: pd.r } },
        vertexShader: `varying vec2 vP; void main(){ vP = position.xz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: `
          uniform float uTime; uniform float uNight; uniform float uR; varying vec2 vP;
          void main(){
            float jit = fract(sin(dot(floor(vP * 2.7), vec2(127.1, 311.7))) * 43758.5453) * 6.28;
            float w = sin(vP.x * 3.6 + uTime * 1.4 + jit) + sin(vP.y * 4.7 - uTime * 1.0)
                    + sin((vP.x + vP.y) * 2.3 + uTime * 0.7 + jit * 0.5) + sin((vP.x - vP.y) * 5.1 - uTime * 1.8);
            vec3 deep = mix(vec3(0.022, 0.075, 0.105), vec3(0.006, 0.018, 0.038), uNight);
            vec3 lit  = mix(vec3(0.95, 0.62, 0.38), vec3(0.55, 0.65, 0.95), uNight);
            float sparkle = smoothstep(3.1, 3.85, w);
            float ripple = smoothstep(1.2, 3.1, w) * 0.08;
            vec3 c = deep + deep * ripple * 4.0 + lit * sparkle * 0.5;
            float edge = length(vP) / uR;
            float alpha = 0.9 * (1.0 - smoothstep(0.82, 1.0, edge));
            gl_FragColor = vec4(c, alpha);
          }`,
      });
      const m = new THREE.Mesh(new THREE.CircleGeometry(pd.r, 40).rotateX(-Math.PI / 2), mat);
      m.position.set(pd.x, -0.15, pd.z);
      this.scene.add(m);
      this.waterMats.push(mat);
    }
  }

  roadTexture() {
    if (this._roadTex) return this._roadTex;
    const c = document.createElement('canvas'); c.width = 128; c.height = 512;
    const g = c.getContext('2d');
    g.fillStyle = '#3c3e46'; g.fillRect(0, 0, 128, 512);
    for (let i = 0; i < 700; i++) {
      const v = 46 + Math.random() * 40 | 0;
      g.fillStyle = `rgba(${v},${v},${v + 6},0.5)`;
      g.fillRect(Math.random() * 128, Math.random() * 512, 2, 2);
    }
    g.fillStyle = 'rgba(220,210,160,0.75)';
    for (let y = 10; y < 512; y += 64) g.fillRect(60, y, 8, 30);
    g.fillStyle = 'rgba(20,20,24,0.6)';
    g.fillRect(0, 0, 5, 512); g.fillRect(123, 0, 5, 512);
    this._roadTex = new THREE.CanvasTexture(c);
    this._roadTex.colorSpace = THREE.SRGBColorSpace;
    return this._roadTex;
  }

  setupRoads() {
    // service roads from each lab apron toward the contested center
    for (const f of Object.values(this.sim.factions)) {
      const ang = Math.atan2(-f.base.x, -f.base.z);
      const len = 30;
      const geo = new THREE.PlaneGeometry(3.4, len).rotateX(-Math.PI / 2);
      const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
        map: this.roadTexture(), transparent: true, opacity: 0.94, roughness: 0.94, depthWrite: false,
      }));
      const t0 = 11 + len / 2;
      m.position.set(f.base.x + Math.sin(ang) * t0, 0.055, f.base.z + Math.cos(ang) * t0);
      m.rotation.y = ang;
      m.receiveShadow = true;
      m.renderOrder = 1;
      this.scene.add(m);
    }
  }

  setupBaseProps() {
    // solar panels + blinking antenna masts around every apron
    this.antennaTips = [];
    const panelGeo = new THREE.BoxGeometry(2.3, 0.08, 1.5);
    const legGeo = new THREE.BoxGeometry(0.1, 0.7, 0.1);
    const panelMat = new THREE.MeshStandardMaterial({ color: 0x16264d, roughness: 0.25, metalness: 0.6, emissive: 0x0a1533, emissiveIntensity: 0.4 });
    const frameMat = new THREE.MeshStandardMaterial({ color: 0x9aa4ad, roughness: 0.5, metalness: 0.7 });
    for (const f of Object.values(this.sim.factions)) {
      for (const a of [Math.PI * 0.75, Math.PI * 0.95]) {
        const grp = new THREE.Group();
        const p = new THREE.Mesh(panelGeo, panelMat);
        p.rotation.x = -0.5; p.position.y = 0.85; p.castShadow = true;
        const l1 = new THREE.Mesh(legGeo, frameMat); l1.position.set(-0.8, 0.35, 0);
        const l2 = new THREE.Mesh(legGeo, frameMat); l2.position.set(0.8, 0.35, 0);
        grp.add(p, l1, l2);
        grp.position.set(f.base.x + Math.cos(a) * 8.6, 0, f.base.z + Math.sin(a) * 8.6);
        grp.rotation.y = -a + Math.PI / 2;
        this.scene.add(grp);
      }
      // antenna mast with aviation light
      const mast = new THREE.Group();
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.12, 6.4, 6), frameMat);
      pole.position.y = 3.2; pole.castShadow = true;
      const tip = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 6),
        new THREE.MeshStandardMaterial({ color: 0xff3020, emissive: 0xff2010, emissiveIntensity: 0.6 }));
      tip.position.y = 6.5;
      mast.add(pole, tip);
      for (const hgt of [2.2, 4.2]) {
        const bar = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.05, 0.05), frameMat);
        bar.position.y = hgt;
        mast.add(bar);
      }
      const aa = Math.PI * 1.6;
      mast.position.set(f.base.x + Math.cos(aa) * 8.8, 0, f.base.z + Math.sin(aa) * 8.8);
      this.scene.add(mast);
      this.antennaTips.push(tip);
    }
  }

  setupRain() {
    const N = 650;
    this._rainBox = { w: 90, h: 42 };
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      pos[i * 3] = (Math.random() - 0.5) * this._rainBox.w;
      pos[i * 3 + 1] = Math.random() * this._rainBox.h;
      pos[i * 3 + 2] = (Math.random() - 0.5) * this._rainBox.w;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.rainMat = new THREE.PointsMaterial({
      color: 0xa9c2dd, size: 0.14, sizeAttenuation: true, transparent: true, opacity: 0, depthWrite: false,
    });
    this.rain = new THREE.Points(g, this.rainMat);
    this.rain.visible = false;
    this.rain.userData.noAO = true;
    this.scene.add(this.rain);
    this.rainK = 0;            // 0..1 rain strength
    this._weatherT = 60 + Math.random() * 60;
    this._raining = false; this._rainLeft = 0;
  }

  updateWeather(dt) {
    // storms roll in every couple of minutes
    if (this._raining) {
      this._rainLeft -= dt;
      if (this._rainLeft <= 0) this._raining = false;
    } else {
      this._weatherT -= dt;
      if (this._weatherT <= 0) {
        this._weatherT = 70 + Math.random() * 70;
        if (Math.random() < 0.4) { this._raining = true; this._rainLeft = 25 + Math.random() * 25; }
      }
    }
    this.rainK += ((this._raining ? 1 : 0) - this.rainK) * Math.min(1, dt * 0.7);
    const on = this.rainK > 0.02 && this._qLevel < 2;
    this.rain.visible = on;
    if (on) {
      this.rainMat.opacity = this.rainK * 0.5;
      this.rain.position.set(this.camFocus.x, 0, this.camFocus.z);
      const pos = this.rain.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        let y = pos.getY(i) - 36 * dt;
        if (y < 0) y = this._rainBox.h;
        pos.setY(i, y);
      }
      pos.needsUpdate = true;
    }
  }

  bumpTexture() {
    const c = document.createElement('canvas'); c.width = c.height = 512;
    const g = c.getContext('2d');
    g.fillStyle = '#808080'; g.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 2400; i++) {
      const x = Math.random() * 512, y = Math.random() * 512, r = 2 + Math.random() * 9;
      const v = 96 + Math.random() * 64 | 0;
      g.fillStyle = `rgba(${v},${v},${v},0.5)`;
      g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
    }
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(26, 26);
    return t;
  }

  setupPaths() {
    // trampled dirt from each lab toward its two nearest datastream nodes
    const geo = new THREE.CircleGeometry(1, 18).rotateX(-Math.PI / 2);
    const mat = new THREE.MeshBasicMaterial({ map: this.aoTexture(), transparent: true, depthWrite: false, color: 0x54452f, opacity: 0.34 });
    for (const f of Object.values(this.sim.factions)) {
      const near = [...this.sim.nodes].sort((a, b) =>
        Math.hypot(a.x - f.base.x, a.z - f.base.z) - Math.hypot(b.x - f.base.x, b.z - f.base.z)).slice(0, 2);
      for (const nd of near) {
        const ang = Math.atan2(nd.x - f.base.x, nd.z - f.base.z);
        for (let i = 0; i < 6; i++) {
          const t2 = 0.24 + (i / 5) * 0.58;
          const wob = Math.sin(i * 1.7) * 1.1;
          const m = new THREE.Mesh(geo, mat);
          m.position.set(
            f.base.x + (nd.x - f.base.x) * t2 + Math.cos(ang) * wob,
            0.045,
            f.base.z + (nd.z - f.base.z) * t2 - Math.sin(ang) * wob);
          m.rotation.y = -ang;
          m.scale.set(1.5 + Math.random() * 0.6, 1, 2.6 + Math.random() * 0.8);
          this.scene.add(m);
        }
      }
    }
  }

  setupLamps() {
    this.lampGlows = [];
    const { geometry, material } = stripBaseTile(assets.models.lamppost, 0.06);
    geometry.computeBoundingBox();
    const bb = geometry.boundingBox;
    const S = 4.6;
    const im = new THREE.InstancedMesh(geometry, material.clone(), 8);
    im.castShadow = true;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
    let i = 0;
    for (const f of Object.values(this.sim.factions)) {
      for (const a of [Math.PI * 0.25, Math.PI * 1.25]) {
        const x = f.base.x + Math.cos(a) * 9.2, z = f.base.z + Math.sin(a) * 9.2;
        const yaw = -a; // arms run tangent to the apron ring
        q.setFromAxisAngle(up, yaw);
        m.compose(new THREE.Vector3(x, 0, z), q, new THREE.Vector3(S, S, S));
        im.setMatrixAt(i++, m);
        for (const sx of [bb.min.x * 0.92, bb.max.x * 0.92]) {
          const gl = this.glowSprite(0xffd9a0, 3.4);
          gl.position.set(
            x + (Math.cos(yaw) * sx) * S,
            bb.max.y * S * 0.94,
            z + (-Math.sin(yaw) * sx) * S);
          gl.material.opacity = 0;
          this.scene.add(gl);
          this.lampGlows.push(gl);
        }
      }
    }
    im.count = i;
    this.scene.add(im);
  }

  cloudTexture() {
    if (this._cloudTex) return this._cloudTex;
    const c = document.createElement('canvas'); c.width = 256; c.height = 128;
    const g = c.getContext('2d');
    for (let i = 0; i < 26; i++) {
      const x = 40 + Math.random() * 176, y = 45 + Math.random() * 45, r = 16 + Math.random() * 26;
      const gr = g.createRadialGradient(x, y, 2, x, y, r);
      gr.addColorStop(0, 'rgba(255,255,255,0.34)');
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr;
      g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
    }
    this._cloudTex = new THREE.CanvasTexture(c);
    return this._cloudTex;
  }

  setupClouds() {
    this.clouds = [];
    this.cloudGroup = new THREE.Group();
    const shGeo = new THREE.CircleGeometry(1, 20).rotateX(-Math.PI / 2);
    for (let i = 0; i < 7; i++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({
        map: this.cloudTexture(), transparent: true, opacity: 0.5, depthWrite: false, rotation: Math.random() * Math.PI,
      }));
      const sc = 26 + Math.random() * 22;
      sp.scale.set(sc, sc * 0.5, 1);
      const x = (Math.random() * 2 - 1) * 120, z = (Math.random() * 2 - 1) * 120;
      sp.position.set(x, 46 + Math.random() * 14, z);
      const sh = new THREE.Mesh(shGeo, new THREE.MeshBasicMaterial({
        map: this.aoTexture(), transparent: true, depthWrite: false, color: 0x000000, opacity: 0.12,
      }));
      sh.scale.set(sc * 0.5, 1, sc * 0.3);
      sh.position.set(x, 0.05, z);
      this.cloudGroup.add(sp, sh);
      this.clouds.push({ sp, sh, vx: 0.5 + Math.random() * 0.5, vz: (Math.random() - 0.5) * 0.25 });
    }
    this.scene.add(this.cloudGroup);
  }

  updateClouds(dt) {
    if (!this.cloudGroup?.visible) return;
    for (const c of this.clouds) {
      c.sp.position.x += c.vx * dt; c.sp.position.z += c.vz * dt;
      if (c.sp.position.x > 150) { c.sp.position.x = -150; c.sp.position.z = (Math.random() * 2 - 1) * 110; }
      c.sh.position.set(c.sp.position.x * 0.92, 0.05, c.sp.position.z * 0.92);
      c.sh.material.opacity = 0.13 * (1 - this.night * 0.7);
      c.sp.material.opacity = THREE.MathUtils.lerp(0.5, 0.16, this.night);
    }
  }

  setupFireflies() {
    const N = 110;
    this._ffBase = new Float32Array(N * 3);
    this._ffPhase = new Float32Array(N);
    const pos = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
      this._ffBase[i * 3] = (Math.random() * 2 - 1) * (MAP.half - 4);
      this._ffBase[i * 3 + 1] = 0.6 + Math.random() * 2.0;
      this._ffBase[i * 3 + 2] = (Math.random() * 2 - 1) * (MAP.half - 4);
      this._ffPhase[i] = Math.random() * 6.28;
      pos.set(this._ffBase.subarray(i * 3, i * 3 + 3), i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.fireflyMat = new THREE.PointsMaterial({
      color: 0xd9ffb0, size: 0.5, sizeAttenuation: true, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    this.fireflies = new THREE.Points(g, this.fireflyMat);
    this.fireflies.visible = false;
    this.scene.add(this.fireflies);
  }

  updateFireflies() {
    if (!this.fireflies?.visible) return;
    const t = this._windTime.value;
    const pos = this.fireflies.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      const ph = this._ffPhase[i];
      pos.setXYZ(i,
        this._ffBase[i * 3] + Math.sin(t * 0.6 + ph) * 1.4,
        this._ffBase[i * 3 + 1] + Math.sin(t * 1.1 + ph * 2.0) * 0.5,
        this._ffBase[i * 3 + 2] + Math.cos(t * 0.5 + ph) * 1.4);
    }
    pos.needsUpdate = true;
  }

  concretePadTexture() {
    if (this._concreteTex) return this._concreteTex;
    const S = 512, c = document.createElement('canvas'); c.width = c.height = S;
    const g = c.getContext('2d');
    // asphalt disc with speckle, faint panel rings, soft blended edge
    const grad = g.createRadialGradient(S / 2, S / 2, S * 0.1, S / 2, S / 2, S / 2);
    grad.addColorStop(0, 'rgba(86,88,98,0.96)');
    grad.addColorStop(0.75, 'rgba(74,76,86,0.95)');
    grad.addColorStop(0.9, 'rgba(66,68,78,0.75)');
    grad.addColorStop(1, 'rgba(60,62,72,0)');
    g.fillStyle = grad;
    g.beginPath(); g.arc(S / 2, S / 2, S / 2, 0, 7); g.fill();
    for (let i = 0; i < 900; i++) {
      const a = Math.random() * Math.PI * 2, r = Math.random() ** 0.5 * S * 0.46;
      const x = S / 2 + Math.cos(a) * r, y = S / 2 + Math.sin(a) * r;
      g.fillStyle = Math.random() < 0.5 ? 'rgba(255,255,255,0.045)' : 'rgba(0,0,0,0.07)';
      g.fillRect(x, y, 1.6 + Math.random() * 2, 1.6 + Math.random() * 2);
    }
    g.strokeStyle = 'rgba(0,0,0,0.16)'; g.lineWidth = 2;
    for (const rr of [0.32, 0.62, 0.85]) {
      g.beginPath(); g.arc(S / 2, S / 2, S / 2 * rr, 0, 7); g.stroke();
    }
    g.strokeStyle = 'rgba(255,215,120,0.16)'; g.lineWidth = 5;
    g.beginPath(); g.arc(S / 2, S / 2, S / 2 * 0.94, 0, 7); g.stroke();
    this._concreteTex = new THREE.CanvasTexture(c);
    this._concreteTex.colorSpace = THREE.SRGBColorSpace;
    return this._concreteTex;
  }

  plotTexture() {
    if (this._plotTex) return this._plotTex;
    const S = 256, c = document.createElement('canvas'); c.width = c.height = S;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(S / 2, S / 2, S * 0.2, S / 2, S / 2, S * 0.5);
    grad.addColorStop(0, 'rgba(80,82,92,0.95)');
    grad.addColorStop(0.8, 'rgba(70,72,82,0.85)');
    grad.addColorStop(1, 'rgba(64,66,76,0)');
    g.fillStyle = grad;
    g.beginPath(); g.arc(S / 2, S / 2, S / 2, 0, 7); g.fill();
    for (let i = 0; i < 260; i++) {
      const a = Math.random() * Math.PI * 2, r = Math.random() ** 0.5 * S * 0.44;
      g.fillStyle = Math.random() < 0.5 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.08)';
      g.fillRect(S / 2 + Math.cos(a) * r, S / 2 + Math.sin(a) * r, 2, 2);
    }
    this._plotTex = new THREE.CanvasTexture(c);
    this._plotTex.colorSpace = THREE.SRGBColorSpace;
    return this._plotTex;
  }

  nodePadTexture() {
    if (this._nodePadTex) return this._nodePadTex;
    const S = 256, c = document.createElement('canvas'); c.width = c.height = S;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(S / 2, S / 2, S * 0.08, S / 2, S / 2, S / 2);
    grad.addColorStop(0, 'rgba(20,30,40,0.9)');
    grad.addColorStop(0.78, 'rgba(16,26,36,0.85)');
    grad.addColorStop(1, 'rgba(14,22,32,0)');
    g.fillStyle = grad;
    g.beginPath(); g.arc(S / 2, S / 2, S / 2, 0, 7); g.fill();
    // glowing data ring + tick marks
    g.strokeStyle = 'rgba(80,220,255,0.95)'; g.lineWidth = 5;
    g.beginPath(); g.arc(S / 2, S / 2, S * 0.36, 0, 7); g.stroke();
    g.strokeStyle = 'rgba(80,220,255,0.35)'; g.lineWidth = 11;
    g.beginPath(); g.arc(S / 2, S / 2, S * 0.36, 0, 7); g.stroke();
    g.strokeStyle = 'rgba(140,235,255,0.85)'; g.lineWidth = 3;
    for (let i = 0; i < 12; i++) {
      const a = i / 12 * Math.PI * 2;
      g.beginPath();
      g.moveTo(S / 2 + Math.cos(a) * S * 0.42, S / 2 + Math.sin(a) * S * 0.42);
      g.lineTo(S / 2 + Math.cos(a) * S * 0.47, S / 2 + Math.sin(a) * S * 0.47);
      g.stroke();
    }
    this._nodePadTex = new THREE.CanvasTexture(c);
    this._nodePadTex.colorSpace = THREE.SRGBColorSpace;
    return this._nodePadTex;
  }

  setupRocks() {
    const N = 64;
    const geo = new THREE.IcosahedronGeometry(0.55, 0);
    const pa = geo.attributes.position;
    for (let i = 0; i < pa.count; i++) {
      pa.setXYZ(i,
        pa.getX(i) * (0.82 + Math.random() * 0.4),
        pa.getY(i) * (0.55 + Math.random() * 0.3),
        pa.getZ(i) * (0.82 + Math.random() * 0.4));
    }
    geo.computeVertexNormals();
    const mesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({ color: 0x8d8578, flatShading: true, roughness: 0.95 }), N);
    mesh.castShadow = true; mesh.receiveShadow = true;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), col = new THREE.Color();
    const clear = [...this.sim.nodes, ...Object.values(this.sim.factions).map(f => ({ x: f.base.x, z: f.base.z }))];
    let placed = 0, guard = 0;
    while (placed < N && guard++ < N * 8) {
      const x = (Math.random() * 2 - 1) * (MAP.half - 3);
      const z = (Math.random() * 2 - 1) * (MAP.half - 3);
      if (clear.some(p => Math.hypot(p.x - x, p.z - z) < 9)) continue;
      e.set(0, Math.random() * Math.PI * 2, 0);
      q.setFromEuler(e);
      const sc = 0.35 + Math.random() * 0.85;
      m.compose(new THREE.Vector3(x, sc * 0.12, z), q, new THREE.Vector3(sc, sc * 0.8, sc));
      mesh.setMatrixAt(placed, m);
      col.setHSL(0.09, 0.06 + Math.random() * 0.08, 0.38 + Math.random() * 0.16);
      mesh.setColorAt(placed, col);
      placed++;
    }
    mesh.count = placed;
    this.scene.add(mesh);
  }

  grassTexture() {
    const c = document.createElement('canvas'); c.width = 64; c.height = 64;
    const g = c.getContext('2d');
    for (let i = 0; i < 7; i++) {
      const x = 8 + i * 8 + (Math.random() - 0.5) * 5;
      g.strokeStyle = `rgba(${38 + Math.random() * 22 | 0}, ${72 + Math.random() * 30 | 0}, ${32 + Math.random() * 18 | 0}, 0.9)`;
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(x, 64);
      g.quadraticCurveTo(x + (Math.random() - 0.5) * 10, 34, x + (Math.random() - 0.5) * 16, 6 + Math.random() * 12);
      g.stroke();
    }
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  setupGrass() {
    const N = 1500;
    const geo = new THREE.PlaneGeometry(1.5, 1.15);
    geo.translate(0, 0.48, 0);
    const mat = new THREE.MeshStandardMaterial({
      map: this.grassTexture(), alphaTest: 0.45, side: THREE.DoubleSide, roughness: 1,
    });
    this.addWind(mat, 0.16);
    const mesh = new THREE.InstancedMesh(geo, mat, N);
    mesh.castShadow = false;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
    const col = new THREE.Color();
    const clear = [...this.sim.nodes, ...Object.values(this.sim.factions).map(f => ({ x: f.base.x, z: f.base.z }))];
    let placed = 0, guard = 0;
    while (placed < N && guard++ < N * 6) {
      const x = (Math.random() * 2 - 1) * (MAP.half - 2);
      const z = (Math.random() * 2 - 1) * (MAP.half - 2);
      if (clear.some(p => Math.hypot(p.x - x, p.z - z) < 7)) continue;
      q.setFromAxisAngle(up, Math.random() * Math.PI);
      const sc = 0.7 + Math.random() * 0.6;
      m.compose(new THREE.Vector3(x, 0, z), q, new THREE.Vector3(sc, sc * (0.8 + Math.random() * 0.5), sc));
      mesh.setMatrixAt(placed, m);
      col.setHSL(0.25 + Math.random() * 0.05, 0.4, 0.27 + Math.random() * 0.12);
      mesh.setColorAt(placed, col);
      placed++;
    }
    mesh.count = placed;
    this.grass = mesh;
    this.scene.add(mesh);
  }

  aoTexture() {
    if (this._aoTex) return this._aoTex;
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d');
    const gr = g.createRadialGradient(64, 64, 8, 64, 64, 64);
    gr.addColorStop(0, 'rgba(0,0,0,0.5)');
    gr.addColorStop(0.7, 'rgba(0,0,0,0.22)');
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
    this._aoTex = new THREE.CanvasTexture(c);
    return this._aoTex;
  }

  contactShadow(radius) {
    const m = new THREE.Mesh(
      new THREE.CircleGeometry(radius, 24),
      new THREE.MeshBasicMaterial({ map: this.aoTexture(), transparent: true, depthWrite: false })
    );
    m.rotation.x = -Math.PI / 2;
    m.position.y = 0.04;
    m.renderOrder = 1;
    return m;
  }

  setupNodes() {
    this.nodeViews = new Map();
    for (const n of this.sim.nodes) {
      const grp = new THREE.Group();
      grp.position.set(n.x, 0, n.z);
      // worn earth beneath, then a glowing data pad
      const dirt = new THREE.Mesh(
        new THREE.CircleGeometry(4.6, 28),
        new THREE.MeshBasicMaterial({ map: this.aoTexture(), transparent: true, depthWrite: false, color: 0x584a34, opacity: 0.55 })
      );
      dirt.rotation.x = -Math.PI / 2; dirt.position.y = 0.035;
      grp.add(dirt);
      const pad = new THREE.Mesh(
        new THREE.CircleGeometry(3.1, 40),
        new THREE.MeshBasicMaterial({ map: this.nodePadTexture(), transparent: true, depthWrite: false })
      );
      pad.rotation.x = -Math.PI / 2; pad.position.y = 0.06;
      pad.renderOrder = 1;
      grp.add(pad);
      const coin = tint(instance('coin'), 0x39d5ff, 0.85);
      coin.traverse(o => { if (o.isMesh) { o.material.emissive = new THREE.Color(0x1899cc); o.material.emissiveIntensity = 1.6; } });
      coin.scale.setScalar(5);
      coin.position.y = 1.6;
      grp.add(coin);
      const glow = this.glowSprite(0x39d5ff, 7);
      glow.position.y = 1.2;
      grp.add(glow);
      grp.traverse(o => { o.userData.eid = n.id; });
      this.scene.add(grp);
      this.nodeViews.set(n.id, { grp, coin, glow, spin: Math.random() * 6 });
    }
  }

  glowTexture() {
    if (this._glowTex) return this._glowTex;
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d');
    const gr = g.createRadialGradient(64, 64, 4, 64, 64, 64);
    gr.addColorStop(0, 'rgba(255,255,255,0.9)');
    gr.addColorStop(0.35, 'rgba(255,255,255,0.28)');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
    this._glowTex = new THREE.CanvasTexture(c);
    return this._glowTex;
  }

  glowSprite(color, scale) {
    const m = new THREE.SpriteMaterial({ map: this.glowTexture(), color, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
    const s = new THREE.Sprite(m);
    s.scale.setScalar(scale);
    return s;
  }

  // ---------------- entity views ----------------
  buildingMesh(b) {
    const def = BUILDINGS[b.kind];
    const color = FACTIONS[b.faction].color;
    const grp = new THREE.Group();
    let model;
    if (b.kind === 'tower') {
      model = instance('wall');
      const fc = new THREE.Color(color);
      model.traverse(o => {
        if (o.isMesh && o.material) {
          o.material = o.material.clone();
          if (o.material.map) o.material.map = desaturatedMap(o.material.map);
          if (o.material.color) o.material.color.copy(fc).lerp(new THREE.Color(0xffffff), 0.25);
        }
      });
      model.scale.set(1.1, 2.6, 1.1);
      const orb = new THREE.Mesh(
        new THREE.SphereGeometry(0.55, 16, 12),
        new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: color, emissiveIntensity: 2.2 })
      );
      orb.position.y = 4.9;
      grp.add(orb);
      grp.userData.orb = orb;
      const g = this.glowSprite(color, 3.2);
      g.position.y = 4.9; grp.add(g);
    } else {
      model = instance(b.kind);
      const fc = new THREE.Color(color);
      model.traverse(o => {
        if (o.isMesh && o.material) {
          o.material = o.material.clone();
          if (o.material.map) o.material.map = desaturatedMap(o.material.map);
          if (o.material.color) o.material.color.copy(fc).lerp(new THREE.Color(0xffffff), b.kind === 'hq' ? 0.15 : 0.3);
        }
      });
      const sc = def.size / (b.kind === 'hq' ? 1.05 : 1.0);
      model.scale.set(sc, sc, sc);
    }
    grp.add(model);
    grp.userData.model = model;
    // concrete plot blended into grass + soft contact shadow
    const plot = new THREE.Mesh(
      new THREE.CircleGeometry(def.size * 0.92, 32),
      new THREE.MeshStandardMaterial({ map: this.plotTexture(), transparent: true, roughness: 0.9, depthWrite: false })
    );
    plot.rotation.x = -Math.PI / 2; plot.position.y = 0.05;
    plot.receiveShadow = true;
    grp.add(plot);
    grp.add(this.contactShadow(def.size * 0.8));
    // windows-at-night glow the bloom picks up
    const nglow = this.glowSprite(color, def.size * 2.1);
    nglow.position.y = def.size * 0.75;
    nglow.material.opacity = 0;
    grp.add(nglow);
    grp.userData.nglow = nglow;
    // construction scaffold shown while building
    if (b.kind !== 'hq') {
      const sc = new THREE.Group();
      const postMat = new THREE.MeshStandardMaterial({ color: 0x8a6a3d, roughness: 0.9 });
      const half = def.size * 0.62, hgt = def.size * 1.05;
      for (const [px2, pz2] of [[-half, -half], [half, -half], [-half, half], [half, half]]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.14, hgt, 0.14), postMat);
        post.position.set(px2, hgt / 2, pz2);
        sc.add(post);
      }
      for (const lv of [0.4, 0.8]) {
        for (const [rx, rz, w2, d2] of [[0, -half, half * 2, 0.1], [0, half, half * 2, 0.1], [-half, 0, 0.1, half * 2], [half, 0, 0.1, half * 2]]) {
          const bar = new THREE.Mesh(new THREE.BoxGeometry(Math.max(w2, 0.1), 0.09, Math.max(d2, 0.1)), postMat);
          bar.position.set(rx, hgt * lv, rz);
          sc.add(bar);
        }
      }
      grp.add(sc);
      grp.userData.scaffold = sc;
    }
    model.traverse(o => {
      if (o.isMesh && o.material?.emissive) {
        o.material.emissive = new THREE.Color(color);
        o.material.emissiveIntensity = 0.06;
      }
    });

    if (b.kind === 'hq') {
      const flag = instance('flag');
      flag.traverse(o => {
        if (o.isMesh && o.material) {
          o.material = o.material.clone();
          if (o.material.map) o.material.map = desaturatedMap(o.material.map);
          if (o.material.color) o.material.color.set(color);
        }
      });
      flag.scale.setScalar(3.2);
      flag.position.set(def.size * 0.62, 0, def.size * 0.62);
      grp.add(flag);
      // research beam (hidden until researching)
      const beam = new THREE.Mesh(
        new THREE.CylinderGeometry(0.55, 0.9, 34, 12, 1, true),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide })
      );
      beam.position.y = 17;
      grp.add(beam);
      grp.userData.beam = beam;
    }
    grp.position.set(b.x, 0, b.z);
    grp.rotation.y = (Math.random() * 4 | 0) * Math.PI / 2;
    grp.traverse(o => { o.userData.eid = b.id; });
    return grp;
  }

  unitView(u) {
    const model = UNIT_MODEL[u.kind];
    const color = FACTIONS[u.faction].color;
    const obj = tint(instance(model), color, u.kind === 'researcher' ? 0.45 : 0.3);
    obj.scale.setScalar(UNIT_SCALE[u.kind]);
    const grp = new THREE.Group();
    grp.add(obj);
    grp.position.set(u.x, 0, u.z);

    const mixer = new THREE.AnimationMixer(obj);
    const clips = assets.anims[model];
    const actions = {};
    for (const c of clips) actions[c.name] = mixer.clipAction(c);

    // faction ring under feet
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.55, 0.72, 24),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, depthWrite: false })
    );
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.06;
    ring.visible = false;
    grp.add(ring);

    grp.traverse(o => { o.userData.eid = u.id; });
    this.scene.add(grp);
    const v = { grp, obj, mixer, actions, cur: null, dead: false, deathT: 0, ring, kind: u.kind, hpBar: this.makeHpBar(color) };
    grp.add(v.hpBar.grp);
    this.playAnim(v, this.animName(v, 'idle'), 0);
    return v;
  }

  makeHpBar(color) {
    const grp = new THREE.Group();
    const bg = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0x330a0a, depthWrite: false }));
    bg.scale.set(1.3, 0.14, 1);
    const fg = new THREE.Sprite(new THREE.SpriteMaterial({ color: 0x53e06a, depthWrite: false }));
    fg.scale.set(1.24, 0.09, 1);
    grp.add(bg, fg);
    grp.visible = false;
    return { grp, fg, bg };
  }

  animName(v, want) {
    const A = v.actions;
    const map = {
      idle: A.Idle ? 'Idle' : 'idle',
      walk: A.Walking ? 'Walking' : (A.Walk ? 'Walk' : 'walk'),
      run: A.Running ? 'Running' : (A.Run ? 'Run' : 'run'),
      work: A.agree ? 'agree' : (A.Wave ? 'Wave' : (A.Idle ? 'Idle' : 'idle')),
      attack: A.Punch ? 'Punch' : (A.Idle ? 'Idle' : 'idle'),
      death: A.Death ? 'Death' : null,
    };
    return map[want];
  }

  playAnim(v, name, fade = 0.22) {
    if (!name || v.cur === name || !v.actions[name]) return;
    const next = v.actions[name];
    next.reset();
    if (name === 'Death') { next.setLoop(THREE.LoopOnce); next.clampWhenFinished = true; }
    next.fadeIn(fade).play();
    if (v.cur && v.actions[v.cur]) v.actions[v.cur].fadeOut(fade);
    v.cur = name;
  }

  // ---------------- per-frame sync ----------------
  sync(dt, selection = new Set()) {
    const sim = this.sim;
    const seen = new Set();

    for (const b of sim.buildings) {
      seen.add(b.id);
      let v = this.views.get(b.id);
      if (!v) {
        v = { grp: this.buildingMesh(b), building: true, kind: b.kind, faction: b.faction, hpBar: this.makeHpBar(), dead: false, deathT: 0 };
        v.hpBar.grp.position.y = BUILDINGS[b.kind].size * 1.15 + 0.8;
        v.hpBar.bg.scale.set(2.2, 0.18, 1); v.hpBar.fg.scale.set(2.12, 0.12, 1);
        v.grp.add(v.hpBar.grp);
        this.scene.add(v.grp);
        this.views.set(b.id, v);
      }
      if (b.dead && !v.dead) { v.dead = true; v.deathT = 0; this.explode(b.x, b.z, BUILDINGS[b.kind].size); }
      if (v.dead) {
        v.deathT += dt;
        v.grp.scale.setScalar(Math.max(0.001, 1 - v.deathT * 1.6));
        v.grp.rotation.z = v.deathT * 0.25;
        continue;
      }
      // scaffold visible only during construction
      const scaf = v.grp.userData.scaffold;
      if (scaf) scaf.visible = !b.done;
      // construction rise
      const target = b.done ? 1 : 0.15 + b.progress * 0.85;
      const model = v.grp.userData.model;
      model.scale.y = model.scale.x * target;
      model.traverse(o => { if (o.isMesh && o.material.transparent !== undefined) { o.material.transparent = !b.done; o.material.opacity = b.done ? 1 : 0.55 + b.progress * 0.45; } });
      // hq research beam
      const beam = v.grp.userData.beam;
      if (beam) {
        const f = sim.fac(b.faction);
        const active = f.researching;
        const final = active && f.milestone === 4;
        beam.material.opacity += ((active ? (final ? 0.5 : 0.22) : 0) - beam.material.opacity) * Math.min(1, dt * 3);
        if (active) {
          beam.rotation.y += dt * (final ? 2.2 : 0.7);
          const pulse = 1 + Math.sin(performance.now() / (final ? 130 : 400)) * (final ? 0.25 : 0.08);
          beam.scale.set(pulse, 1, pulse);
        }
      }
      // tower orb pulse
      const orb = v.grp.userData.orb;
      if (orb) orb.material.emissiveIntensity = 1.8 + Math.sin(performance.now() / 300 + b.x) * 0.7;
      const ng = v.grp.userData.nglow;
      if (ng) ng.material.opacity = this.night * (b.done ? 0.34 : 0.08);
      // damage flash + smolder when badly hurt
      if (b.hitT > 0) this.flashGroup(v.grp, b.hitT);
      if (b.done && b.hp / b.maxHp < 0.45 && Math.random() < dt * 2.2) {
        this.smoke(b.x + (Math.random() - 0.5) * 1.6, BUILDINGS[b.kind].size * 1.1, b.z + (Math.random() - 0.5) * 1.6, 1.6, 1.8);
      }
      this.updateHpBar(v, b, selection.has(b.id));
      this.updateRing?.(v, b, selection);
    }

    for (const u of sim.units) {
      seen.add(u.id);
      let v = this.views.get(u.id);
      if (!v) { v = this.unitView(u); this.views.set(u.id, v); }
      if (u.dead && !v.dead) {
        v.dead = true; v.deathT = 0;
        // ragdoll-lite: a hop, a spin and a random topple direction
        v.deathVy = 1.6 + Math.random() * 1.4;
        v.deathSpin = (Math.random() - 0.5) * 4;
        v.deathDir = Math.random() < 0.5 ? 1 : -1;
        const dn = this.animName(v, 'death');
        if (dn) this.playAnim(v, dn, 0.12);
        v.ring.visible = false; v.hpBar.grp.visible = false;
      }
      if (v.dead) {
        v.deathT += dt;
        v.mixer.update(dt);
        if (v.deathT < 0.8) {
          v.deathVy -= 10 * dt;
          v.grp.position.y = Math.max(0, v.grp.position.y + v.deathVy * dt);
          v.grp.rotation.y += v.deathSpin * dt;
        }
        if (!v.actions.Death) { // topple for models without a death clip
          v.grp.rotation.x = Math.min(Math.PI / 2, v.deathT * 3.2) * v.deathDir;
        }
        if (v.deathT > 1.6) v.grp.position.y = -(v.deathT - 1.6) * 0.8;
        continue;
      }
      // interpolate toward sim position
      const k = Math.min(1, dt * 14);
      v.grp.position.x += (u.x - v.grp.position.x) * k;
      v.grp.position.z += (u.z - v.grp.position.z) * k;
      let targetRot = u.rot;
      let dr = targetRot - v.grp.rotation.y;
      while (dr > Math.PI) dr -= Math.PI * 2;
      while (dr < -Math.PI) dr += Math.PI * 2;
      v.grp.rotation.y += dr * Math.min(1, dt * 10);

      // dust kicked up while running
      if (u.moving && this._qLevel < 2 && Math.random() < dt * 2.4) this.puffDust(u.x, u.z);
      // animation state
      let want = 'idle';
      if (u.moving) want = u.kind === 'researcher' ? 'walk' : 'run';
      else if (u.attacking) want = 'attack';
      else if (u.working) want = 'work';
      this.playAnim(v, this.animName(v, want));
      // LOD: distant units animate at 1/3 rate
      const dx2 = u.x - this.camFocus.x, dz2 = u.z - this.camFocus.z;
      if (dx2 * dx2 + dz2 * dz2 > 4900) {
        v.lodSkip = (v.lodSkip || 0) + 1;
        if (v.lodSkip % 3 === 0) v.mixer.update(dt * 3);
      } else v.mixer.update(dt);

      v.ring.visible = selection.has(u.id);
      if (u.hitT > 0) this.flashGroup(v.grp, u.hitT);
      this.updateHpBar(v, u, selection.has(u.id));
    }

    // remove views whose entities are gone
    for (const [id, v] of this.views) {
      if (!seen.has(id)) { this.scene.remove(v.grp); this.views.delete(id); }
    }

    // nodes
    for (const n of this.sim.nodes) {
      const nv = this.nodeViews.get(n.id);
      if (!nv) continue;
      const frac = n.amount / n.max;
      nv.coin.rotation.y += dt * (0.6 + frac);
      nv.coin.position.y = 1.6 + Math.sin(performance.now() / 700 + nv.spin) * 0.15;
      nv.coin.scale.setScalar(5 * (0.35 + 0.65 * frac));
      nv.glow.material.opacity = (0.25 + 0.55 * frac) * (1 + this.night * 0.8);
      nv.grp.visible = n.amount > 0.5;
    }

    this._windTime.value += dt;
    this.poolUpdate(this.sparks, dt);
    this.poolUpdate(this.dust, dt);
    for (const sc of this.scorches) {
      if (!sc.visible) continue;
      sc.userData.t -= dt;
      if (sc.userData.t < 10) sc.material.opacity = Math.max(0, sc.userData.t / 10);
      if (sc.userData.t <= 0) sc.visible = false;
    }
    if (this.grade) this.grade.uniforms.uTime.value = (this.grade.uniforms.uTime.value + dt) % 100;
    this.updateDayNight(dt);
    this.updateWeather(dt);
    this.updatePostFX(dt, selection);
    this.updateClouds(dt);
    this.updateFireflies();
    if (this.dof?.enabled) {
      this.dof.uniforms.focus.value = this.camera.position.distanceTo(this.camFocus);
    }
    this.updateEffects(dt);
    this.updateCinema(dt);
    this.updateCamera();
    this.autoQuality(dt);
  }

  updateHpBar(v, e, selected) {
    const frac = Math.max(0, e.hp / e.maxHp);
    const show = selected || (frac < 0.999 && !e.dead);
    v.hpBar.grp.visible = show;
    if (!show) return;
    if (!v.building) v.hpBar.grp.position.y = 2.3;
    v.hpBar.fg.scale.x = (v.building ? 2.12 : 1.24) * frac;
    v.hpBar.fg.position.x = -(v.building ? 2.12 : 1.24) * (1 - frac) / 2;
    v.hpBar.fg.material.color.setHSL(frac * 0.33, 0.85, 0.5);
  }

  flashGroup(grp, hitT) {
    // brief emissive flash on hit
    grp.traverse(o => {
      if (o.isMesh && o.material && o.material.emissive) {
        o.material.emissive.setRGB(hitT * 2.2, hitT * 1.4, hitT * 1.2);
      }
    });
  }

  // ---------------- effects ----------------
  smokeTexture() {
    if (this._smokeTex) return this._smokeTex;
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d');
    for (let i = 0; i < 14; i++) {
      const x = 34 + Math.random() * 60, y = 34 + Math.random() * 60, r = 14 + Math.random() * 22;
      const gr = g.createRadialGradient(x, y, 2, x, y, r);
      gr.addColorStop(0, 'rgba(58,54,52,0.55)');
      gr.addColorStop(1, 'rgba(58,54,52,0)');
      g.fillStyle = gr;
      g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
    }
    this._smokeTex = new THREE.CanvasTexture(c);
    return this._smokeTex;
  }

  smoke(x, y, z, scale = 2.2, life = 1.6) {
    const m = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this.smokeTexture(), transparent: true, depthWrite: false, opacity: 0.65,
      rotation: Math.random() * Math.PI * 2,
    }));
    m.position.set(x + (Math.random() - 0.5), y, z + (Math.random() - 0.5));
    m.scale.setScalar(scale * (0.7 + Math.random() * 0.6));
    this.scene.add(m);
    this.effects.push({ obj: m, t: 0, life: life * (0.8 + Math.random() * 0.5), kind: 'smoke', rise: 1.2 + Math.random() });
  }

  lightning(from, to, color) {
    const a = new THREE.Vector3(from.x, from.y ?? 3, from.z);
    const b = new THREE.Vector3(to.x, to.y ?? 1.1, to.z);
    const pts = [];
    const N = 7;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const p = a.clone().lerp(b, t);
      if (i > 0 && i < N) {
        p.x += (Math.random() - 0.5) * 1.7;
        p.y += (Math.random() - 0.5) * 1.3;
        p.z += (Math.random() - 0.5) * 1.7;
      }
      pts.push(p);
    }
    const curve = new THREE.CatmullRomCurve3(pts);
    const mk = (r, c, op) => {
      const m = new THREE.Mesh(
        new THREE.TubeGeometry(curve, 22, r, 5),
        new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: op, blending: THREE.AdditiveBlending, depthWrite: false })
      );
      this.scene.add(m);
      this.effects.push({ obj: m, t: 0, life: 0.17, kind: 'flash' });
    };
    mk(0.26, color, 0.5);
    mk(0.07, 0xffffff, 1);
  }

  explode(x, z, size = 2) {
    this.flashLight(x, z, 0xffa53a, 10, 0.45);
    this.addScorch(x, z, size * 2.1);
    const shakeAmp = 0.9 * Math.max(0, 1 - Math.hypot(this.camFocus.x - x, this.camFocus.z - z) / 70);
    if (shakeAmp > 0.05) { this.shake.t = 0.45; this.shake.amp = Math.max(this.shake.amp, shakeAmp); }
    // fireball
    const fb = new THREE.Mesh(
      new THREE.SphereGeometry(1, 14, 10),
      new THREE.MeshBasicMaterial({ color: 0xffa53a, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false })
    );
    fb.position.set(x, 1.4, z);
    this.scene.add(fb);
    this.effects.push({ obj: fb, t: 0, life: 0.45, kind: 'fireball', grow: size * 2.4 });
    const flash = this.glowSprite(0xffc06a, size * 6);
    flash.position.set(x, 1.5, z);
    this.scene.add(flash);
    this.effects.push({ obj: flash, t: 0, life: 0.4, kind: 'flash' });
    for (let i = 0; i < 4; i++) this.smoke(x + (Math.random() - 0.5) * size, 1.5 + Math.random() * 1.5, z + (Math.random() - 0.5) * size, size * 1.6, 2);
    // shockwave ring
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.4, 0.9, 36),
      new THREE.MeshBasicMaterial({ color: 0xffc07a, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false })
    );
    ring.rotation.x = -Math.PI / 2; ring.position.set(x, 0.15, z);
    this.scene.add(ring);
    this.effects.push({ obj: ring, t: 0, life: 0.7, kind: 'ring', grow: size * 6 });
    // debris sparks
    this.burst(x, 1.2, z, 0xffb35a, 14, 7);
    this.burst(x, 1.2, z, 0x8a8a8a, 10, 5);
  }

  burst(x, y, z, color, n = 8, speed = 5) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      this.poolSpawn(this.sparks, {
        x, y, z, color,
        vx: Math.cos(a) * speed * (0.4 + Math.random()),
        vy: 2 + Math.random() * speed,
        vz: Math.sin(a) * speed * (0.4 + Math.random()),
        life: 0.45 + Math.random() * 0.35,
        size: 0.5 + Math.random() * 0.6, grav: 14,
      });
    }
  }

  puffDust(x, z) {
    this.poolSpawn(this.dust, {
      x: x + (Math.random() - 0.5) * 0.5, y: 0.25, z: z + (Math.random() - 0.5) * 0.5,
      color: 0xb0a184, vx: (Math.random() - 0.5) * 0.6, vy: 0.7 + Math.random() * 0.5, vz: (Math.random() - 0.5) * 0.6,
      life: 0.5 + Math.random() * 0.3, size: 0.5 + Math.random() * 0.4, grow: 1.6, grav: 0.4,
    });
  }

  // double-layer tracer: hot core + colored glow
  tracer2(from, to, color) {
    this.tracer(from, to, 0xffffff, 0.05, 0.11);
    this.tracer(from, to, color, 0.16, 0.14);
  }

  tracer(from, to, color, thick = 0.09, life = 0.13) {
    const dir = new THREE.Vector3(to.x - from.x, (to.y ?? 1.1) - (from.y ?? 1.1), to.z - from.z);
    const len = dir.length();
    const geo = new THREE.CylinderGeometry(thick, thick, len, 5);
    const mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false });
    const m = new THREE.Mesh(geo, mat);
    m.position.set((from.x + to.x) / 2, ((from.y ?? 1.1) + (to.y ?? 1.1)) / 2, (from.z + to.z) / 2);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
    this.scene.add(m);
    this.effects.push({ obj: m, t: 0, life, kind: 'flash' });
  }

  milestoneBeam(x, z, color) {
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(1.6, 2.6, 60, 16, 1, true),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide })
    );
    beam.position.set(x, 30, z);
    this.scene.add(beam);
    this.effects.push({ obj: beam, t: 0, life: 2.4, kind: 'beam' });
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.6, 1.2, 48),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false })
    );
    ring.rotation.x = -Math.PI / 2; ring.position.set(x, 0.18, z);
    this.scene.add(ring);
    this.effects.push({ obj: ring, t: 0, life: 1.6, kind: 'ring', grow: 26 });
  }

  updateEffects(dt) {
    for (let i = this.effects.length - 1; i >= 0; i--) {
      const e = this.effects[i];
      e.t += dt;
      const f = e.t / e.life;
      if (f >= 1) {
        this.scene.remove(e.obj);
        e.obj.material?.dispose?.(); e.obj.geometry?.dispose?.();
        this.effects.splice(i, 1);
        continue;
      }
      if (e.kind === 'flash') e.obj.material.opacity = 1 - f;
      else if (e.kind === 'ring') {
        const s = 1 + f * e.grow;
        e.obj.scale.set(s, s, s);
        e.obj.material.opacity = 0.9 * (1 - f);
      } else if (e.kind === 'spark') {
        e.vy -= 14 * dt;
        e.obj.position.x += e.vx * dt; e.obj.position.y += e.vy * dt; e.obj.position.z += e.vz * dt;
        if (e.obj.position.y < 0.1) e.obj.position.y = 0.1;
        e.obj.material.opacity = 1 - f;
      } else if (e.kind === 'fireball') {
        const s2 = 1 + f * e.grow;
        e.obj.scale.setScalar(s2);
        e.obj.material.opacity = 1 - f * f;
      } else if (e.kind === 'smoke') {
        e.obj.position.y += e.rise * dt;
        e.obj.scale.multiplyScalar(1 + dt * 0.65);
        e.obj.material.opacity = 0.65 * (1 - f);
      } else if (e.kind === 'beam') {
        e.obj.material.opacity = 0.7 * (1 - f * f);
        e.obj.rotation.y += dt * 3;
        const p = 1 + Math.sin(e.t * 20) * 0.1;
        e.obj.scale.set(p, 1, p);
      }
    }
  }

  // consume sim events -> vfx (audio/UI drain the same list separately)
  applyEvents(events) {
    for (const e of events) {
      switch (e.type) {
        case 'shot':
          this.tracer2({ x: e.from.x, y: 1.35, z: e.from.z }, { x: e.to.x, y: 1.1, z: e.to.z }, 0xffc46a);
          this.burst(e.to.x, 1.1, e.to.z, 0xffd977, 3, 3);
          break;
        case 'punch':
          this.burst(e.to.x, 1.2, e.to.z, 0xffffff, 4, 3);
          break;
        case 'zap':
          this.lightning({ x: e.from.x, y: e.from.y ?? 3, z: e.from.z }, { x: e.to.x, y: 1.0, z: e.to.z }, FACTIONS[e.fid].color);
          this.burst(e.to.x, 1.0, e.to.z, FACTIONS[e.fid].color, 5, 4);
          this.flashLight(e.to.x, e.to.z, FACTIONS[e.fid].color, 4, 0.2);
          break;
        case 'unitDied':
          this.burst(e.x, 1.0, e.z, 0xff6a5a, 8, 5);
          break;
        case 'buildingDied':
          this.explode(e.x, e.z, e.size || 2);
          break;
        case 'buildTick':
          if (Math.random() < 0.5) this.burst(e.x + (Math.random() - 0.5) * 2, 0.4, e.z + (Math.random() - 0.5) * 2, 0xc9a877, 2, 2);
          break;
        case 'milestone':
        case 'researchStart':
        case 'finalrun': {
          const f = this.sim.fac(e.fid);
          this.milestoneBeam(f.base.x, f.base.z, FACTIONS[e.fid].color);
          if (e.type === 'finalrun') {
            this.shake.t = 0.55; this.shake.amp = Math.max(this.shake.amp, 0.55);
            this.startCinema(f.base.x, f.base.z, 3.8);
          } else if (e.type === 'milestone' && e.fid === this.sim.playerFaction) {
            this.startCinema(f.base.x, f.base.z, 3.0);
          }
          break;
        }
        case 'poached': {
          this.burst(e.x, 1.4, e.z, 0xd48aff, 10, 4);
          break;
        }
        case 'trained':
          this.burst(e.x, 0.6, e.z, FACTIONS[e.fid].color, 5, 2.5);
          break;
        case 'placed':
          this.burst(e.x, 0.5, e.z, 0xc9a877, 6, 3);
          break;
        case 'built':
          this.burst(e.x, 1.0, e.z, 0x9fe87a, 8, 4);
          break;
      }
    }
  }

  // ---------------- camera ----------------
  startCinema(x, z, dur = 3.4) {
    if (this.cinema) return;
    this.cinema = {
      t: 0, dur,
      fromF: this.camFocus.clone(), fromD: this.camDist,
      toF: new THREE.Vector3(x, 0, z), toD: 26,
    };
    document.body.classList.add('cinema');
    const cancel = () => { this.endCinema(); };
    this._cinemaCancel = cancel;
    window.addEventListener('pointerdown', cancel, { once: true });
    window.addEventListener('keydown', cancel, { once: true });
  }

  endCinema() {
    if (!this.cinema) return;
    this.camFocus.copy(this.cinema.fromF);
    this.camDist = this.cinema.fromD;
    this.cinema = null;
    document.body.classList.remove('cinema');
  }

  updateCinema(dt) {
    const c = this.cinema;
    if (!c) return;
    c.t += dt;
    if (c.t >= c.dur) { this.endCinema(); return; }
    // ease in, hold, ease out
    const inK = THREE.MathUtils.smoothstep(c.t, 0, 0.7);
    const outK = 1 - THREE.MathUtils.smoothstep(c.t, c.dur - 0.8, c.dur);
    const k = Math.min(inK, outK);
    this.camFocus.lerpVectors(c.fromF, c.toF, k);
    this.camDist = THREE.MathUtils.lerp(c.fromD, c.toD, k);
  }

  updateCamera() {
    // sun + tight shadow frustum follow the view for sharper shadows
    if (this.sun) {
      this.sun.position.set(this.camFocus.x + 55, 58, this.camFocus.z - 80);
      if (!this.sun.target.parent) this.scene.add(this.sun.target);
      this.sun.target.position.set(this.camFocus.x, 0, this.camFocus.z);
    }
    const h = Math.max(0.35, Math.min(1.35, this.camPitch));
    this.camPitch = h;
    this.camDist = Math.max(14, Math.min(85, this.camDist));
    const lim = MAP.half + 8;
    this.camFocus.x = Math.max(-lim, Math.min(lim, this.camFocus.x));
    this.camFocus.z = Math.max(-lim, Math.min(lim, this.camFocus.z));
    const cy = Math.sin(h) * this.camDist;
    const cr = Math.cos(h) * this.camDist;
    let sx = 0, sy = 0, sz = 0;
    if (this.shake.t > 0) {
      this.shake.t -= 1 / 60;
      const k = this.shake.amp * (this.shake.t / 0.45);
      sx = (Math.random() - 0.5) * k; sy = (Math.random() - 0.5) * k * 0.7; sz = (Math.random() - 0.5) * k;
      if (this.shake.t <= 0) this.shake.amp = 0;
    }
    this.camera.position.set(
      this.camFocus.x + Math.sin(this.camYaw) * cr + sx,
      cy + sy,
      this.camFocus.z + Math.cos(this.camYaw) * cr + sz
    );
    this.camera.lookAt(this.camFocus.x, 0, this.camFocus.z);
  }

  pick(nx, ny) {
    // returns { id } | { ground: {x,z} } for normalized device coords
    this.raycaster.setFromCamera({ x: nx, y: ny }, this.camera);
    const hits = this.raycaster.intersectObjects(this.scene.children, true);
    for (const h of hits) {
      let o = h.object;
      while (o) {
        if (o.userData.eid) return { id: o.userData.eid, point: h.point };
        o = o.parent;
      }
      if (h.object === this.ground) return { ground: { x: h.point.x, z: h.point.z } };
    }
    return null;
  }

  project(x, y, z) {
    const v = new THREE.Vector3(x, y, z).project(this.camera);
    if (v.z > 1) return null;
    return { x: (v.x + 1) / 2 * window.innerWidth, y: (1 - v.y) / 2 * window.innerHeight };
  }

  ping(x, z, color = 0x9fe87a) {
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.5, 0.75, 28),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, side: THREE.DoubleSide, depthWrite: false })
    );
    ring.rotation.x = -Math.PI / 2; ring.position.set(x, 0.12, z);
    this.scene.add(ring);
    this.effects.push({ obj: ring, t: 0, life: 0.55, kind: 'ring', grow: 3.5 });
  }

  moveGhost(kind, x, z, valid) {
    if (!this.ghost || this.ghostKind !== kind) {
      this.hideGhost();
      this.ghostKind = kind;
      const model = kind === 'tower' ? instance('wall') : instance(kind);
      const def = BUILDINGS[kind];
      if (kind === 'tower') model.scale.set(1.1, 2.6, 1.1);
      else model.scale.setScalar(def.size);
      model.traverse(o => {
        if (o.isMesh) { o.material = o.material.clone(); o.material.transparent = true; o.material.opacity = 0.55; o.castShadow = false; }
      });
      this.ghost = model;
      this.scene.add(model);
    }
    this.ghost.position.set(x, 0.05, z);
    this.ghost.traverse(o => { if (o.isMesh) o.material.color?.setHex(valid ? 0x7dff8a : 0xff5f5f); });
  }

  hideGhost() {
    if (this.ghost) { this.scene.remove(this.ghost); this.ghost = null; this.ghostKind = null; }
  }

  groundPoint(nx, ny) {
    this.raycaster.setFromCamera({ x: nx, y: ny }, this.camera);
    const hit = this.raycaster.intersectObject(this.ground, false)[0];
    return hit ? { x: hit.point.x, z: hit.point.z } : null;
  }

  setupComposer() {
    const w = window.innerWidth, h = window.innerHeight;
    const rt = new THREE.WebGLRenderTarget(w, h, { samples: 4, type: THREE.HalfFloatType });
    this.composer = new EffectComposer(this.renderer, rt);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    // ground-truth ambient occlusion (corners, contacts, crevices)
    const qp2 = new URLSearchParams(location.search);
    this.gtao = new GTAOPass(this.scene, this.camera, w, h);
    this.gtao.output = GTAOPass.OUTPUT.Default;
    this.gtao.blendIntensity = 0.6;
    this.gtao.updateGtaoMaterial({ radius: 0.5, distanceExponent: 1, thickness: 1, scale: 1.2, samples: 12, distanceFallOff: 1, screenSpaceRadius: false });
    this.gtao.enabled = qp2.get('ao') !== '0';
    {
      // AO depth/normal override renders sprites as opaque quads -> hide FX
      const origRender = this.gtao.render.bind(this.gtao);
      const hidden = [];
      this.gtao.render = (...args) => {
        hidden.length = 0;
        this.scene.traverse(o => {
          if (o.visible && (o.isSprite || o.isPoints || o.material?.blending === THREE.AdditiveBlending || o.userData.noAO)) {
            hidden.push(o); o.visible = false;
          }
        });
        origRender(...args);
        for (const o of hidden) o.visible = true;
      };
    }
    this.composer.addPass(this.gtao);
    // selection outline
    this.outline = new OutlinePass(new THREE.Vector2(w, h), this.scene, this.camera);
    this.outline.edgeStrength = 3.2;
    this.outline.edgeGlow = 0.35;
    this.outline.edgeThickness = 1.0;
    this.outline.visibleEdgeColor.set(0xd9ffe8);
    this.outline.hiddenEdgeColor.set(0x123018);
    this.composer.addPass(this.outline);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.55, 0.5, 0.85);
    this.composer.addPass(this.bloom);
    // tilt-shift depth of field: the premium diorama look
    this.dof = new BokehPass(this.scene, this.camera, { focus: 44, aperture: 0.00011, maxblur: 0.0045 });
    this.composer.addPass(this.dof);
    // crepuscular light shafts from the sun
    this.godrays = new ShaderPass(GodRayShader);
    this.godrays.uniforms.uSunPos.value = new THREE.Vector2(0.5, 1.2);
    this.composer.addPass(this.godrays);
    // motion trail blur while the camera is flying
    this.afterimage = new AfterimagePass(0);
    this.afterimage.enabled = false;
    this.composer.addPass(this.afterimage);
    this.grade = new ShaderPass(GradeShader);
    this.composer.addPass(this.grade);
    this.composer.addPass(new OutputPass());
    this.postFX = true;

    // lens flare riding the sun direction
    this.sunDirV = new THREE.Vector3(0.5, 0.42, -0.72).normalize();
    const flare = new Lensflare();
    flare.addElement(new LensflareElement(this.flareTexture(200, 1), 300, 0, new THREE.Color(0xffd9a8)));
    flare.addElement(new LensflareElement(this.flareTexture(70, 0.45), 90, 0.35, new THREE.Color(0xffc890)));
    flare.addElement(new LensflareElement(this.flareTexture(50, 0.4), 130, 0.65, new THREE.Color(0x9fc4ff)));
    flare.addElement(new LensflareElement(this.flareTexture(40, 0.35), 60, 1.0, new THREE.Color(0xffe9c8)));
    this.flareHost = new THREE.Object3D();
    this.flareHost.add(flare);
    this.scene.add(this.flareHost);

    // batched particle pools: hundreds of sparks/dust in 2 draw calls
    this.sparks = this.makePool(256, new THREE.MeshBasicMaterial({
      map: this.glowTexture(), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    this.dust = this.makePool(96, new THREE.MeshBasicMaterial({
      map: this.smokeTexture(), transparent: true, depthWrite: false, opacity: 0.5,
    }));
    // scorch decal ring buffer
    this.scorches = [];
    this._scorchIdx = 0;
    this.shake = { t: 0, amp: 0 };

    // pooled point lights for explosions and zaps
    this.plPool = Array.from({ length: 4 }, () => {
      const l = new THREE.PointLight(0xffaa55, 0, 30, 2);
      this.scene.add(l);
      return { l, t: 0, life: 1, peak: 0 };
    });
    this._plIdx = 0;
  }

  makePool(count, material) {
    const geo = new THREE.PlaneGeometry(1, 1);
    const mesh = new THREE.InstancedMesh(geo, material, count);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.userData.noAO = true;
    mesh.frustumCulled = false;
    const slots = Array.from({ length: count }, () => ({ t: 0 }));
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < count; i++) mesh.setMatrixAt(i, zero);
    mesh.setColorAt(0, new THREE.Color(1, 1, 1));
    this.scene.add(mesh);
    return { mesh, slots, idx: 0, zero };
  }

  poolSpawn(pool, o) {
    const i = pool.idx++ % pool.slots.length;
    const s = pool.slots[i];
    Object.assign(s, {
      t: o.life, life: o.life, x: o.x, y: o.y, z: o.z,
      vx: o.vx || 0, vy: o.vy || 0, vz: o.vz || 0,
      size: o.size || 0.5, grow: o.grow || 0, grav: o.grav ?? 10,
      col: o.color || 0xffffff,
    });
    pool.mesh.setColorAt(i, new THREE.Color(s.col));
  }

  poolUpdate(pool, dt) {
    const m = new THREE.Matrix4(), q = this.camera.quaternion, sc = new THREE.Vector3(), pos = new THREE.Vector3();
    const col = new THREE.Color();
    let any = false;
    for (let i = 0; i < pool.slots.length; i++) {
      const s = pool.slots[i];
      if (s.t <= 0) continue;
      any = true;
      s.t -= dt;
      if (s.t <= 0) { pool.mesh.setMatrixAt(i, pool.zero); continue; }
      const f = s.t / s.life;
      s.vy -= s.grav * dt;
      s.x += s.vx * dt; s.y += s.vy * dt; s.z += s.vz * dt;
      if (s.y < 0.08) { s.y = 0.08; s.vy = 0; }
      const size = s.size * (1 + (1 - f) * s.grow);
      pos.set(s.x, s.y, s.z); sc.setScalar(size);
      m.compose(pos, q, sc);
      pool.mesh.setMatrixAt(i, m);
      col.set(s.col).multiplyScalar(f);
      pool.mesh.setColorAt(i, col);
    }
    if (any) {
      pool.mesh.instanceMatrix.needsUpdate = true;
      if (pool.mesh.instanceColor) pool.mesh.instanceColor.needsUpdate = true;
    }
  }

  scorchTexture() {
    if (this._scorchTex) return this._scorchTex;
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const g = c.getContext('2d');
    for (let i = 0; i < 40; i++) {
      const a = Math.random() * Math.PI * 2, r = Math.random() ** 0.6 * 90;
      const x = 128 + Math.cos(a) * r, y = 128 + Math.sin(a) * r;
      const rad = 14 + Math.random() * 34;
      const gr = g.createRadialGradient(x, y, 1, x, y, rad);
      gr.addColorStop(0, 'rgba(8,6,4,0.55)');
      gr.addColorStop(1, 'rgba(8,6,4,0)');
      g.fillStyle = gr;
      g.beginPath(); g.arc(x, y, rad, 0, 7); g.fill();
    }
    this._scorchTex = new THREE.CanvasTexture(c);
    return this._scorchTex;
  }

  addScorch(x, z, size) {
    const MAXS = 24;
    let sc;
    if (this.scorches.length < MAXS) {
      sc = new THREE.Mesh(
        new THREE.CircleGeometry(1, 20).rotateX(-Math.PI / 2),
        new THREE.MeshBasicMaterial({ map: this.scorchTexture(), transparent: true, depthWrite: false })
      );
      sc.renderOrder = 1;
      this.scene.add(sc);
      this.scorches.push(sc);
    } else sc = this.scorches[this._scorchIdx++ % MAXS];
    sc.position.set(x, 0.06, z);
    sc.rotation.y = Math.random() * Math.PI * 2;
    sc.scale.setScalar(size);
    sc.userData.t = 40;
    sc.material.opacity = 1;
    sc.visible = true;
  }

  addShake(amp) {
    const d = Math.hypot(this.camFocus.x, this.camFocus.z); // just guard NaN
    this.shake.t = 0.4;
    this.shake.amp = Math.max(this.shake.amp * (this.shake.t > 0 ? 1 : 0), amp);
  }

  flareTexture(size, alpha) {
    const c = document.createElement('canvas'); c.width = c.height = size;
    const g = c.getContext('2d');
    const gr = g.createRadialGradient(size / 2, size / 2, 1, size / 2, size / 2, size / 2);
    gr.addColorStop(0, `rgba(255,255,255,${alpha})`);
    gr.addColorStop(0.35, `rgba(255,235,200,${alpha * 0.45})`);
    gr.addColorStop(1, 'rgba(255,235,200,0)');
    g.fillStyle = gr; g.fillRect(0, 0, size, size);
    const t = new THREE.CanvasTexture(c);
    return t;
  }

  flashLight(x, z, color, intensity = 8, life = 0.4) {
    const slot = this.plPool[this._plIdx++ % this.plPool.length];
    slot.l.position.set(x, 3.2, z);
    slot.l.color.set(color);
    slot.t = life; slot.life = life; slot.peak = intensity;
  }

  setTier(n) {
    this._qLevel = n;
    if (n === 0) {
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      this.renderer.shadowMap.enabled = true;
      this.sun.castShadow = true;
      this.sun.shadow.mapSize.set(2048, 2048);
      this.sun.shadow.map?.dispose(); this.sun.shadow.map = null;
      this.postFX = true;
      if (this.dof) this.dof.enabled = true;
      if (this.gtao) this.gtao.enabled = new URLSearchParams(location.search).get('ao') !== '0';
      if (this.godrays) this.godrays.enabled = true;
      if (this.grass) this.grass.visible = true;
      if (this.cloudGroup) this.cloudGroup.visible = true;
    } else if (n === 1) {
      this.renderer.setPixelRatio(1);
      this.renderer.shadowMap.enabled = true;
      this.sun.castShadow = true;
      this.sun.shadow.mapSize.set(1024, 1024);
      this.sun.shadow.map?.dispose(); this.sun.shadow.map = null;
      this.postFX = true;
      if (this.dof) this.dof.enabled = false;
      if (this.gtao) this.gtao.enabled = false;
      if (this.godrays) this.godrays.enabled = true;
      if (this.grass) this.grass.visible = true;
      if (this.cloudGroup) this.cloudGroup.visible = true;
    } else {
      this.renderer.shadowMap.enabled = false;
      this.sun.castShadow = false;
      this.postFX = false;
      if (this.dof) this.dof.enabled = false;
      if (this.gtao) this.gtao.enabled = false;
      if (this.godrays) this.godrays.enabled = false;
      if (this.grass) this.grass.visible = false;
      if (this.cloudGroup) this.cloudGroup.visible = false;
      if (this.fireflies) this.fireflies.visible = false;
    }
  }

  applyQualitySetting() {
    const maxq = new URLSearchParams(location.search).get('maxq');
    if (maxq || settings.quality === 'high') { this._lockQ = true; this.setTier(0); return; }
    if (settings.quality === 'low') { this._lockQ = true; this.setTier(2); return; }
    this._lockQ = false;
  }

  updatePostFX(dt, selection) {
    // sun screen position drives the god rays
    if (this.godrays) {
      const p = new THREE.Vector3().copy(this.camera.position).addScaledVector(this.sunDirV, 220).project(this.camera);
      const behind = p.z > 1 || p.z < -1;
      this.godrays.uniforms.uSunPos.value.set((p.x + 1) / 2, (p.y + 1) / 2);
      this.godrays.uniforms.uIntensity.value = behind ? 0 : THREE.MathUtils.lerp(0.34, 0.1, this.night);
    }
    // lens flare rides the sun, fades out at night
    if (this.flareHost) {
      this.flareHost.position.copy(this.camera.position).addScaledVector(this.sunDirV, 250);
      this.flareHost.visible = this.postFX && this.night < 0.5 && this._qLevel === 0;
    }
    // motion blur only while the camera is actually flying
    if (this.afterimage) {
      if (!this._prevCam) this._prevCam = { f: this.camFocus.clone(), d: this.camDist };
      const speed = this._prevCam.f.distanceTo(this.camFocus) + Math.abs(this._prevCam.d - this.camDist) * 0.6;
      this._prevCam.f.copy(this.camFocus); this._prevCam.d = this.camDist;
      const damp = THREE.MathUtils.clamp(speed * 0.28, 0, 0.55);
      this.afterimage.enabled = this._qLevel === 0 && damp > 0.06;
      this.afterimage.uniforms.damp.value = damp;
    }
    // outline follows selection
    if (this.outline) {
      const objs = [];
      for (const id of selection || []) {
        const v = this.views.get(id);
        if (v && !v.dead) objs.push(v.grp);
      }
      this.outline.selectedObjects = objs;
      this.outline.enabled = this._qLevel < 2 && objs.length > 0;
    }
    // pooled dynamic lights decay
    for (const slot of this.plPool || []) {
      if (slot.t > 0) {
        slot.t -= dt;
        slot.l.intensity = Math.max(0, slot.t / slot.life) * slot.peak;
      } else slot.l.intensity = 0;
    }
  }

  autoQuality(dt) {
    if (this._lockQ) return;
    this._fpsAcc += dt; this._fpsN++;
    if (this._fpsAcc < 3) return;
    const fps = this._fpsN / this._fpsAcc;
    this._fpsAcc = 0; this._fpsN = 0;
    if (fps < 24 && this._qLevel === 0) this.setTier(1);
    else if (fps < 15 && this._qLevel === 1) this.setTier(2);
  }

  render() {
    if (this.postFX && this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }
}
