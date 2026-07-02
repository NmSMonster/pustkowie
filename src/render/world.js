// Renderer: owns the three.js scene and mirrors sim state into views.
// The sim never imports this; this reads sim state + drains sim events.
import * as THREE from 'three';
import { instance, tint, assets } from './assets.js';
import { BUILDINGS, UNITS, FACTIONS, MAP } from '../sim/data.js';

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
    this.renderer.toneMappingExposure = 1.25;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0b1020);
    this.scene.fog = new THREE.Fog(0x0b1020, 130, 320);

    this.camera = new THREE.PerspectiveCamera(46, window.innerWidth / window.innerHeight, 0.5, 400);
    // camera rig: focus point on ground + spherical offset
    this.camFocus = new THREE.Vector3(sim.fac(sim.playerFaction).base.x, 0, sim.fac(sim.playerFaction).base.z);
    this.camDist = 42; this.camYaw = Math.PI * 0.25; this.camPitch = 0.96;

    this.views = new Map();      // entity id -> view
    this.effects = [];           // transient vfx
    this.raycaster = new THREE.Raycaster();

    this.setupLights();
    this.setupTerrain();
    this.setupNodes();

    // auto-quality: step down when fps stays low (helps weak GPUs)
    this._fpsAcc = 0; this._fpsN = 0; this._qLevel = 0;

    window.addEventListener('resize', () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });
  }

  // ---------------- environment ----------------
  setupLights() {
    this.scene.add(new THREE.HemisphereLight(0x9db1ff, 0x27351d, 1.05));
    const sun = new THREE.DirectionalLight(0xffe3b8, 2.6);
    sun.position.set(60, 80, 30);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const s = 95;
    Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 20, far: 220 });
    sun.shadow.bias = -0.0004;
    this.scene.add(sun);
    this.sun = sun;
    const rim = new THREE.DirectionalLight(0x5b7bff, 0.55);
    rim.position.set(-50, 40, -60);
    this.scene.add(rim);
  }

  groundTexture() {
    const c = document.createElement('canvas');
    c.width = c.height = 1024;
    const g = c.getContext('2d');
    g.fillStyle = '#35452b'; g.fillRect(0, 0, 1024, 1024);
    for (let i = 0; i < 2600; i++) {
      const x = Math.random() * 1024, y = Math.random() * 1024, r = 6 + Math.random() * 26;
      g.fillStyle = `rgba(${44 + Math.random() * 34 | 0},${70 + Math.random() * 34 | 0},${36 + Math.random() * 20 | 0},0.16)`;
      g.beginPath(); g.arc(x, y, r, 0, 7); g.fill();
    }
    g.strokeStyle = 'rgba(255,255,255,0.028)'; g.lineWidth = 1;
    for (let i = 0; i <= 32; i++) {
      g.beginPath(); g.moveTo(i * 32, 0); g.lineTo(i * 32, 1024); g.stroke();
      g.beginPath(); g.moveTo(0, i * 32); g.lineTo(1024, i * 32); g.stroke();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(4, 4);
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  setupTerrain() {
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(MAP.size + 60, MAP.size + 60),
      new THREE.MeshStandardMaterial({ map: this.groundTexture(), roughness: 0.95 })
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    ground.name = 'ground';
    this.ground = ground;
    this.scene.add(ground);

    // map edge glow frame
    const edge = new THREE.Mesh(
      new THREE.RingGeometry(MAP.half * 1.414, MAP.half * 1.414 + 1.2, 4, 1),
      new THREE.MeshBasicMaterial({ color: 0x2b3f66, transparent: true, opacity: 0.5, side: THREE.DoubleSide })
    );
    edge.rotation.x = -Math.PI / 2; edge.rotation.z = Math.PI / 4;
    edge.position.y = 0.05;
    this.scene.add(edge);

    // scattered trees away from bases and nodes
    const rnd = (a, b) => a + Math.random() * (b - a);
    const clear = [...this.sim.nodes, ...Object.values(this.sim.factions).map(f => ({ x: f.base.x, z: f.base.z }))];
    for (let i = 0; i < 34; i++) {
      let x, z, ok = false, tries = 0;
      while (!ok && tries++ < 30) {
        x = rnd(-MAP.half + 4, MAP.half - 4); z = rnd(-MAP.half + 4, MAP.half - 4);
        ok = clear.every(p => Math.hypot(p.x - x, p.z - z) > 13);
      }
      if (!ok) continue;
      const t = instance(Math.random() < 0.5 ? 'trees' : 'treesTall');
      t.scale.setScalar(rnd(3.4, 5.2));
      t.position.set(x, 0, z);
      t.rotation.y = rnd(0, Math.PI * 2);
      this.scene.add(t);
    }

    // base pads
    for (const f of Object.values(this.sim.factions)) {
      const pad = instance('pavement');
      pad.scale.set(10, 1, 10);
      pad.position.set(f.base.x, 0.01, f.base.z);
      this.scene.add(pad);
    }
  }

  setupNodes() {
    this.nodeViews = new Map();
    for (const n of this.sim.nodes) {
      const grp = new THREE.Group();
      grp.position.set(n.x, 0, n.z);
      const pad = instance('pavement');
      pad.scale.set(4.5, 1, 4.5);
      grp.add(pad);
      const coin = tint(instance('coin'), 0x39d5ff, 0.85);
      coin.traverse(o => { if (o.isMesh) { o.material.emissive = new THREE.Color(0x1899cc); o.material.emissiveIntensity = 0.9; } });
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
      model = tint(instance('wall'), color, 0.35);
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
      model = tint(instance(b.kind), color, b.kind === 'hq' ? 0.62 : 0.38);
      const sc = def.size / (b.kind === 'hq' ? 1.05 : 1.0);
      model.scale.set(sc, sc, sc);
    }
    grp.add(model);
    grp.userData.model = model;

    if (b.kind === 'hq') {
      const flag = tint(instance('flag'), color, 0.85);
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
      // damage flash
      if (b.hitT > 0) this.flashGroup(v.grp, b.hitT);
      this.updateHpBar(v, b, selection.has(b.id));
      this.updateRing?.(v, b, selection);
    }

    for (const u of sim.units) {
      seen.add(u.id);
      let v = this.views.get(u.id);
      if (!v) { v = this.unitView(u); this.views.set(u.id, v); }
      if (u.dead && !v.dead) {
        v.dead = true; v.deathT = 0;
        const dn = this.animName(v, 'death');
        if (dn) this.playAnim(v, dn, 0.12);
        v.ring.visible = false; v.hpBar.grp.visible = false;
      }
      if (v.dead) {
        v.deathT += dt;
        v.mixer.update(dt);
        if (!v.actions.Death) { // fall for models without a death clip
          v.grp.rotation.x = Math.min(Math.PI / 2, v.deathT * 3.2);
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

      // animation state
      let want = 'idle';
      if (u.moving) want = u.kind === 'researcher' ? 'walk' : 'run';
      else if (u.attacking) want = 'attack';
      else if (u.working) want = 'work';
      this.playAnim(v, this.animName(v, want));
      v.mixer.update(dt);

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
      nv.glow.material.opacity = 0.25 + 0.55 * frac;
      nv.grp.visible = n.amount > 0.5;
    }

    this.updateEffects(dt);
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
  explode(x, z, size = 2) {
    // fireball flash
    const flash = this.glowSprite(0xffa53a, size * 5);
    flash.position.set(x, 1.5, z);
    this.scene.add(flash);
    this.effects.push({ obj: flash, t: 0, life: 0.5, kind: 'flash' });
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
      const s = this.glowSprite(color, 0.5 + Math.random() * 0.6);
      s.position.set(x, y, z);
      const a = Math.random() * Math.PI * 2, up = 2 + Math.random() * speed;
      this.scene.add(s);
      this.effects.push({
        obj: s, t: 0, life: 0.45 + Math.random() * 0.35, kind: 'spark',
        vx: Math.cos(a) * speed * (0.4 + Math.random()), vy: up, vz: Math.sin(a) * speed * (0.4 + Math.random()),
      });
    }
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
          this.tracer({ x: e.from.x, y: 1.35, z: e.from.z }, { x: e.to.x, y: 1.1, z: e.to.z }, 0xfff2a8);
          this.burst(e.to.x, 1.1, e.to.z, 0xffd977, 3, 3);
          break;
        case 'punch':
          this.burst(e.to.x, 1.2, e.to.z, 0xffffff, 4, 3);
          break;
        case 'zap':
          this.tracer({ x: e.from.x, y: e.from.y ?? 3, z: e.from.z }, { x: e.to.x, y: 1.0, z: e.to.z }, FACTIONS[e.fid].color, 0.14, 0.18);
          this.burst(e.to.x, 1.0, e.to.z, FACTIONS[e.fid].color, 5, 4);
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
  updateCamera() {
    const h = Math.max(0.35, Math.min(1.35, this.camPitch));
    this.camPitch = h;
    this.camDist = Math.max(14, Math.min(85, this.camDist));
    const lim = MAP.half + 8;
    this.camFocus.x = Math.max(-lim, Math.min(lim, this.camFocus.x));
    this.camFocus.z = Math.max(-lim, Math.min(lim, this.camFocus.z));
    const cy = Math.sin(h) * this.camDist;
    const cr = Math.cos(h) * this.camDist;
    this.camera.position.set(
      this.camFocus.x + Math.sin(this.camYaw) * cr,
      cy,
      this.camFocus.z + Math.cos(this.camYaw) * cr
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

  autoQuality(dt) {
    if (this._lockQ === undefined) this._lockQ = !!new URLSearchParams(location.search).get('maxq');
    if (this._lockQ) return;
    this._fpsAcc += dt; this._fpsN++;
    if (this._fpsAcc < 3) return;
    const fps = this._fpsN / this._fpsAcc;
    this._fpsAcc = 0; this._fpsN = 0;
    if (fps < 24 && this._qLevel === 0) {
      this._qLevel = 1;
      this.renderer.setPixelRatio(1);
      this.sun.shadow.mapSize.set(1024, 1024);
      this.sun.shadow.map?.dispose(); this.sun.shadow.map = null;
    } else if (fps < 16 && this._qLevel === 1) {
      this._qLevel = 2;
      this.renderer.shadowMap.enabled = false;
      this.sun.castShadow = false;
    }
  }

  render() { this.renderer.render(this.scene, this.camera); }
}
