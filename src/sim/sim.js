// Core simulation. Pure data + logic: no rendering, no DOM, no three.js.
// Fixed-timestep tick; renderer/UI/audio consume `sim.events` each frame.
import { FACTIONS, START, UNITS, BUILDINGS, MILESTONES, ABILITIES, TRUST, MAP, RESEARCHER_ASSIST, makeNodes, BASES } from './data.js';

export function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let NEXT_ID = 1;

export class Sim {
  constructor(playerFactionId = 'anthropic', seed = 1337) {
    this.rand = mulberry32(seed);
    this.t = 0;
    this.over = false;
    this.winner = null;
    this.events = [];
    this.units = [];
    this.buildings = [];
    this.nodes = makeNodes().map((n, i) => ({ id: 'node' + i, ...n, max: n.amount }));
    this.factions = {};
    this.playerFaction = playerFactionId;

    const ids = Object.keys(FACTIONS);
    // Player always starts bottom-left; rivals fill other corners.
    const order = [playerFactionId, ...ids.filter(f => f !== playerFactionId)];
    order.forEach((fid, i) => {
      const def = FACTIONS[fid];
      const base = BASES[i];
      this.factions[fid] = {
        id: fid, def, base,
        compute: START.compute, data: START.data, favor: START.favor, trust: START.trust,
        milestone: 0, researching: false, researchProgress: 0, finalRunAnnounced: false,
        alive: true, isPlayer: fid === playerFactionId,
        probedT: 0, cooldowns: {}, underAttackT: 0, attackedRecentlyT: 0,
        stats: { kills: 0, losses: 0, poached: 0 },
      };
      this.spawnBuilding(fid, 'hq', base.x, base.z, true);
      for (let k = 0; k < 3; k++) {
        const a = (k / 3) * Math.PI * 2;
        this.spawnUnit(fid, 'researcher', base.x + Math.cos(a) * 4.2, base.z + Math.sin(a) * 4.2);
      }
    });
  }

  // ---------- helpers ----------
  emit(e) { this.events.push(e); }
  fac(id) { return this.factions[id]; }
  getEntity(id) {
    return this.units.find(u => u.id === id) || this.buildings.find(b => b.id === id) || this.nodes.find(n => n.id === id);
  }
  livingUnits(fid) { return this.units.filter(u => u.faction === fid && !u.dead); }
  livingBuildings(fid) { return this.buildings.filter(b => b.faction === fid && !b.dead); }
  talentCap(fid) {
    return this.livingBuildings(fid).filter(b => b.done).reduce((s, b) => s + (BUILDINGS[b.kind].talentCap || 0), 0);
  }
  researcherCount(fid) { return this.units.filter(u => u.faction === fid && !u.dead && u.kind === 'researcher').length; }
  incomeMult(f) {
    let m = 1;
    if (f.milestone >= 1) m *= 1.10;
    if (f.milestone >= 4) m *= 1.20;
    return m;
  }
  dist(a, b) { const dx = a.x - b.x, dz = a.z - b.z; return Math.hypot(dx, dz); }

  spawnUnit(fid, kind, x, z) {
    const def = UNITS[kind];
    const u = {
      id: 'u' + (NEXT_ID++), kind, faction: fid,
      x, z, rot: this.rand() * Math.PI * 2,
      hp: def.hp, maxHp: def.hp, dead: false,
      order: { type: 'idle' }, cd: 0, scanT: this.rand() * 0.5,
      vx: 0, vz: 0, hitT: 0,
    };
    this.units.push(u);
    return u;
  }

  spawnBuilding(fid, kind, x, z, instant = false) {
    const def = BUILDINGS[kind];
    const b = {
      id: 'b' + (NEXT_ID++), kind, faction: fid, x, z,
      hp: instant ? def.hp : def.hp * 0.1, maxHp: def.hp,
      progress: instant ? 1 : 0, done: instant,
      queue: [], dead: false, cd: 0, hitT: 0,
      rally: { x: x + def.size + 1.5, z },
    };
    this.buildings.push(b);
    return b;
  }

  // ---------- costs ----------
  buildingCost(fid, kind) {
    const f = this.fac(fid); const c = { ...(BUILDINGS[kind].cost) };
    const disc = f.def.buildDiscount || 1;
    for (const k in c) c[k] = Math.round(c[k] * disc);
    return c;
  }
  canAfford(f, cost) { return Object.entries(cost).every(([k, v]) => f[k] >= v); }
  pay(f, cost) { for (const [k, v] of Object.entries(cost)) f[k] -= v; }

  // ---------- commands ----------
  cmdMove(ids, x, z, attackMove = false) {
    const sel = this.units.filter(u => ids.includes(u.id) && !u.dead);
    const n = sel.length;
    sel.forEach((u, i) => {
      const a = (i / Math.max(1, n)) * Math.PI * 2;
      const r = n > 1 ? 0.8 + Math.sqrt(i) * 0.55 : 0;
      u.order = { type: attackMove ? 'attackmove' : 'move', x: x + Math.cos(a) * r, z: z + Math.sin(a) * r };
    });
  }
  cmdGather(ids, nodeId) {
    for (const u of this.units) {
      if (ids.includes(u.id) && !u.dead && u.kind === 'researcher') u.order = { type: 'gather', nodeId };
    }
  }
  cmdAttack(ids, targetId) {
    for (const u of this.units) {
      if (ids.includes(u.id) && !u.dead && UNITS[u.kind].dmg) u.order = { type: 'attack', targetId };
    }
  }
  cmdBuildAssign(ids, buildingId) {
    for (const u of this.units) {
      if (ids.includes(u.id) && !u.dead && u.kind === 'researcher') u.order = { type: 'build', buildingId };
    }
  }
  smart(ids, x, z, targetId) {
    // Context command: node -> gather, enemy -> attack, own site -> build, ground -> move.
    const target = targetId ? this.getEntity(targetId) : null;
    if (target && target.id.startsWith('node') && target.amount > 0) return this.cmdGather(ids, target.id), 'gather';
    if (target && target.faction && this.units.some(u => ids.includes(u.id))) {
      const anyMine = this.units.find(u => ids.includes(u.id));
      if (anyMine && target.faction !== anyMine.faction) return this.cmdAttack(ids, target.id), 'attack';
      if (target.faction === anyMine?.faction && target.progress !== undefined && !target.done) {
        return this.cmdBuildAssign(ids, target.id), 'build';
      }
    }
    this.cmdMove(ids, x, z);
    return 'move';
  }

  placementValid(kind, x, z) {
    const size = BUILDINGS[kind].size;
    if (Math.abs(x) > MAP.half - 3 || Math.abs(z) > MAP.half - 3) return false;
    for (const b of this.buildings) {
      if (!b.dead && this.dist(b, { x, z }) < (BUILDINGS[b.kind].size + size) / 2 + 1.6) return false;
    }
    for (const n of this.nodes) {
      if (n.amount > 0 && this.dist(n, { x, z }) < size / 2 + 2.5) return false;
    }
    return true;
  }

  cmdBuild(fid, kind, x, z, builderIds = []) {
    const f = this.fac(fid);
    const def = BUILDINGS[kind];
    if (!f.alive || (def.needsMilestone && f.milestone < def.needsMilestone)) return null;
    const cost = this.buildingCost(fid, kind);
    if (!this.canAfford(f, cost) || !this.placementValid(kind, x, z)) return null;
    this.pay(f, cost);
    const b = this.spawnBuilding(fid, kind, x, z);
    if (builderIds.length) this.cmdBuildAssign(builderIds, b.id);
    this.emit({ type: 'placed', fid, kind, x, z, id: b.id });
    return b;
  }

  cmdTrain(buildingId, unitKind) {
    const b = this.buildings.find(x => x.id === buildingId);
    if (!b || b.dead || !b.done) return false;
    const f = this.fac(b.faction);
    const def = UNITS[unitKind];
    if (def.needsMilestone && f.milestone < def.needsMilestone) return false;
    if (unitKind === 'researcher' && this.researcherCount(b.faction) + b.queue.filter(q => q.kind === 'researcher').length >= this.talentCap(b.faction)) return false;
    if (b.queue.length >= 5 || !this.canAfford(f, def.cost)) return false;
    this.pay(f, def.cost);
    const mult = f.def.trainMult || 1;
    b.queue.push({ kind: unitKind, remaining: def.buildTime * mult });
    return true;
  }

  cmdRally(buildingId, x, z) {
    const b = this.buildings.find(x2 => x2.id === buildingId);
    if (b) b.rally = { x, z };
  }

  cmdResearch(fid) {
    const f = this.fac(fid);
    if (!f.alive || f.researching || f.milestone >= 5) return false;
    const m = MILESTONES[f.milestone];
    if (!this.canAfford(f, m.cost)) return false;
    this.pay(f, m.cost);
    f.researching = true;
    f.researchProgress = 0;
    if (f.milestone === 4) {
      this.emit({ type: 'finalrun', fid });
    } else {
      this.emit({ type: 'researchStart', fid, milestone: f.milestone });
    }
    return true;
  }

  cmdAbility(fid, key, targetId = null) {
    const f = this.fac(fid);
    const ab = ABILITIES[key];
    if (!f.alive || (f.cooldowns[key] || 0) > 0) return false;
    if (ab.trustCost && f.trust < TRUST.low) return false; // regulators watching
    if (!this.canAfford(f, ab.cost)) return false;

    if (key === 'poach') {
      const target = this.units.find(u => u.id === targetId && !u.dead && u.kind === 'researcher' && u.faction !== fid);
      if (!target) return false;
      this.pay(f, ab.cost);
      f.trust = Math.max(0, f.trust - ab.trustCost);
      const victim = this.fac(target.faction);
      victim.trust = Math.min(100, victim.trust + TRUST.victimSympathy);
      target.faction = fid;
      target.order = { type: 'move', x: f.base.x, z: f.base.z };
      f.stats.poached++;
      this.emit({ type: 'poached', fid, victim: victim.id, x: target.x, z: target.z });
    } else if (key === 'probe') {
      const victim = this.fac(targetId);
      if (!victim || !victim.alive || victim.id === fid) return false;
      this.pay(f, ab.cost);
      f.trust = Math.max(0, f.trust - ab.trustCost);
      victim.probedT = 30;
      this.emit({ type: 'probed', fid, victim: victim.id });
    } else if (key === 'subsidy') {
      this.pay(f, ab.cost);
      f.compute += 180;
      this.emit({ type: 'subsidy', fid });
    } else if (key === 'pr') {
      this.pay(f, ab.cost);
      f.trust = Math.min(100, f.trust + 12);
      this.emit({ type: 'pr', fid });
    } else return false;

    f.cooldowns[key] = ab.cooldown;
    return true;
  }

  // ---------- tick ----------
  tick(dt = 0.1) {
    if (this.over) return;
    this.t += dt;

    for (const fid in this.factions) this.tickFaction(this.fac(fid), dt);
    for (const b of this.buildings) if (!b.dead) this.tickBuilding(b, dt);
    for (const u of this.units) if (!u.dead) this.tickUnit(u, dt);
    this.separation(dt);

    // prune corpses after their death animation window
    this.units = this.units.filter(u => !u.dead || this.t - u.diedAt < 3.2);
    this.buildings = this.buildings.filter(b => !b.dead || this.t - b.diedAt < 4);
  }

  tickFaction(f, dt) {
    if (!f.alive) return;

    // income from finished buildings
    const mult = this.incomeMult(f);
    for (const b of this.livingBuildings(f.id)) {
      if (!b.done) continue;
      const inc = BUILDINGS[b.kind].income;
      if (inc) {
        let cm = (inc.compute || 0) * mult * (f.def.computeMult || 1);
        if (f.probedT > 0) cm *= 0.5;
        f.compute += cm * dt;
        f.favor += (inc.favor || 0) * mult * dt;
        f.trust = Math.min(100, f.trust + (inc.trust || 0) * dt);
      }
      const sy = BUILDINGS[b.kind].synth;
      if (sy && f.compute > 120) {
        f.compute -= sy.computeIn * dt;
        f.data += sy.dataOut * dt;
      }
    }

    // trust drift, floor, fines
    f.trust += (f.def.trustDrift || 0) * dt / 10;
    if (f.def.trustFloor) f.trust = Math.max(f.def.trustFloor, f.trust);
    f.trust = Math.max(0, Math.min(100, f.trust));
    if (f.trust < TRUST.low) {
      f.compute = Math.max(0, f.compute - TRUST.lowFine * dt);
      if (!f.lowTrustWarned && f.isPlayer) { f.lowTrustWarned = true; this.emit({ type: 'lowTrust', fid: f.id }); }
    } else f.lowTrustWarned = false;

    // research
    if (f.researching) {
      const m = MILESTONES[f.milestone];
      let rm = (f.def.researchMult || 1);
      if (f.trust > TRUST.high) rm *= TRUST.highResearchBonus;
      if (f.def.highTrustResearch && f.trust > TRUST.high) rm *= f.def.highTrustResearch;
      if (f.milestone >= 3) rm *= 1.4; // recursion perk (M4 index 3 completed)
      if (f.pausedT > 0) { f.pausedT -= dt; }
      else f.researchProgress += (dt / m.time) * rm;
      if (f.researchProgress >= 1) {
        f.researching = false; f.researchProgress = 0; f.milestone++;
        this.emit({ type: 'milestone', fid: f.id, milestone: f.milestone });
        if (f.milestone >= 5) {
          this.over = true; this.winner = f.id;
          this.emit({ type: 'victory', fid: f.id });
        }
      }
    }

    for (const k in f.cooldowns) f.cooldowns[k] = Math.max(0, f.cooldowns[k] - dt);
    f.probedT = Math.max(0, f.probedT - dt);
    f.underAttackT = Math.max(0, f.underAttackT - dt);
    f.attackedRecentlyT = Math.max(0, f.attackedRecentlyT - dt);
  }

  tickBuilding(b, dt) {
    b.hitT = Math.max(0, b.hitT - dt);
    const def = BUILDINGS[b.kind];

    // training queue
    if (b.done && b.queue.length) {
      const q = b.queue[0];
      q.remaining -= dt;
      if (q.remaining <= 0) {
        b.queue.shift();
        const a = this.rand() * Math.PI * 2;
        const u = this.spawnUnit(b.faction, q.kind, b.x + Math.cos(a) * (def.size / 2 + 0.9), b.z + Math.sin(a) * (def.size / 2 + 0.9));
        u.order = { type: 'move', x: b.rally.x, z: b.rally.z };
        this.emit({ type: 'trained', fid: b.faction, kind: q.kind, x: u.x, z: u.z });
      }
    }

    // tower attack
    if (b.done && def.attack) {
      b.cd -= dt;
      const f = this.fac(b.faction);
      const range = def.attack.range * (f.def.towerRange || 1);
      if (b.cd <= 0) {
        let best = null, bd = range;
        for (const u of this.units) {
          if (u.dead || u.faction === b.faction) continue;
          const d = this.dist(b, u);
          if (d < bd) { bd = d; best = u; }
        }
        if (best) {
          b.cd = def.attack.cooldown;
          this.damageUnit(best, def.attack.dmg, b.faction);
          this.emit({ type: 'zap', from: { x: b.x, z: b.z, y: 3.2 }, to: { x: best.x, z: best.z }, fid: b.faction });
        }
      }
    }
  }

  tickUnit(u, dt) {
    const def = UNITS[u.kind];
    u.cd = Math.max(0, u.cd - dt);
    u.hitT = Math.max(0, u.hitT - dt);
    u.moving = false; u.working = false; u.attacking = false;

    const o = u.order;
    switch (o.type) {
      case 'idle': {
        if (def.dmg) this.autoAcquire(u, dt);
        break;
      }
      case 'move': case 'attackmove': {
        if (o.type === 'attackmove' && def.dmg && this.autoAcquire(u, dt, true)) break;
        if (this.moveToward(u, o.x, o.z, def.speed, dt, 0.5)) u.order = o.type === 'attackmove' ? { type: 'attackmove_hold', x: o.x, z: o.z } : { type: 'idle' };
        break;
      }
      case 'attackmove_hold': {
        if (def.dmg) this.autoAcquire(u, dt);
        break;
      }
      case 'gather': {
        const node = this.nodes.find(n => n.id === o.nodeId);
        if (!node || node.amount <= 0) {
          const next = this.nearestNode(u, 30);
          u.order = next ? { type: 'gather', nodeId: next.id } : { type: 'idle' };
          break;
        }
        if (this.dist(u, node) > 2.6) this.moveToward(u, node.x, node.z, def.speed, dt, 2.3);
        else {
          u.working = true;
          u.rot = Math.atan2(node.x - u.x, node.z - u.z);
          const f = this.fac(u.faction);
          const rate = def.gatherRate * (f.def.dataYield || 1);
          const got = Math.min(node.amount, rate * dt);
          node.amount -= got; f.data += got;
          if (node.amount <= 0) this.emit({ type: 'nodeDepleted', x: node.x, z: node.z });
        }
        break;
      }
      case 'build': {
        const b = this.buildings.find(x => x.id === o.buildingId);
        if (!b || b.dead || b.done) { u.order = { type: 'idle' }; break; }
        const reach = BUILDINGS[b.kind].size / 2 + 1.1;
        if (this.dist(u, b) > reach + 0.4) this.moveToward(u, b.x, b.z, def.speed, dt, reach);
        else {
          u.working = true;
          u.rot = Math.atan2(b.x - u.x, b.z - u.z);
          // N builders together build at (1 + (N-1)*ASSIST) x base speed; each ticks its share.
          const builders = Math.max(1, this.units.filter(v => !v.dead && v.order.type === 'build' && v.order.buildingId === b.id && this.dist(v, b) < reach + 0.6).length);
          const teamRate = 1 + (builders - 1) * RESEARCHER_ASSIST;
          b.progress = Math.min(1, b.progress + (dt / BUILDINGS[b.kind].buildTime) * (teamRate / builders));
          b.hp = Math.min(b.maxHp, b.maxHp * (0.1 + 0.9 * b.progress));
          if (this.rand() < dt * 2) this.emit({ type: 'buildTick', x: b.x, z: b.z });
          if (b.progress >= 1) {
            b.done = true; b.hp = b.maxHp;
            this.emit({ type: 'built', fid: b.faction, kind: b.kind, x: b.x, z: b.z, id: b.id });
            u.order = { type: 'idle' };
          }
        }
        break;
      }
      case 'attack': {
        const t = this.getEntity(o.targetId);
        if (!t || t.dead || t.amount !== undefined) { u.order = { type: 'idle' }; break; }
        const tSize = t.kind && BUILDINGS[t.kind] ? BUILDINGS[t.kind].size / 2 : (UNITS[t.kind]?.radius || 0.5);
        const range = def.range + tSize;
        const d = this.dist(u, t);
        if (d > range) this.moveToward(u, t.x, t.z, def.speed * this.speedMult(u), dt, range - 0.3);
        else {
          u.attacking = true;
          u.rot = Math.atan2(t.x - u.x, t.z - u.z);
          if (u.cd <= 0) {
            u.cd = def.cooldown;
            const f = this.fac(u.faction);
            let dmg = def.dmg * (f.def.agentDamage && u.kind !== 'researcher' ? f.def.agentDamage : 1);
            if (f.milestone >= 3) dmg *= 1.25;
            this.emit({ type: u.kind === 'sentinel' ? 'shot' : 'punch', from: { x: u.x, z: u.z }, to: { x: t.x, z: t.z }, fid: u.faction });
            if (t.maxHp && t.progress !== undefined) this.damageBuilding(t, dmg, u.faction);
            else this.damageUnit(t, dmg, u.faction);
          }
        }
        break;
      }
      case 'flee': {
        if (this.moveToward(u, o.x, o.z, def.speed * 1.15, dt, 1.5)) u.order = { type: 'idle' };
        break;
      }
    }
  }

  speedMult(u) {
    const f = this.fac(u.faction);
    return (f.milestone >= 3 && u.kind !== 'researcher') ? 1.15 : 1;
  }

  autoAcquire(u, dt, fromMove = false) {
    u.scanT -= dt;
    if (u.scanT > 0) return false;
    u.scanT = 0.4;
    const def = UNITS[u.kind];
    let best = null, bd = def.aggro;
    for (const v of this.units) {
      if (v.dead || v.faction === u.faction) continue;
      const d = this.dist(u, v);
      if (d < bd) { bd = d; best = v; }
    }
    if (!best) {
      for (const b of this.buildings) {
        if (b.dead || b.faction === u.faction) continue;
        const d = this.dist(u, b);
        if (d < bd) { bd = d; best = b; }
      }
    }
    if (best) {
      const back = fromMove ? { x: u.order.x, z: u.order.z } : null;
      u.order = { type: 'attack', targetId: best.id, resume: back };
      return true;
    }
    return false;
  }

  nearestNode(u, maxD = 1e9) {
    let best = null, bd = maxD;
    for (const n of this.nodes) {
      if (n.amount <= 0) continue;
      const d = this.dist(u, n);
      if (d < bd) { bd = d; best = n; }
    }
    return best;
  }

  moveToward(u, x, z, speed, dt, arrive = 0.5) {
    const dx = x - u.x, dz = z - u.z;
    const d = Math.hypot(dx, dz);
    if (d <= arrive) return true;
    const s = Math.min(speed * dt, d);
    u.x += (dx / d) * s; u.z += (dz / d) * s;
    u.rot = Math.atan2(dx, dz);
    u.moving = true;
    // building avoidance: push out
    for (const b of this.buildings) {
      if (b.dead) continue;
      const r = BUILDINGS[b.kind].size / 2 + 0.5;
      const bx = u.x - b.x, bz = u.z - b.z;
      const bd = Math.hypot(bx, bz);
      if (bd < r && bd > 0.001) { u.x = b.x + (bx / bd) * r; u.z = b.z + (bz / bd) * r; }
    }
    u.x = Math.max(-MAP.half + 1, Math.min(MAP.half - 1, u.x));
    u.z = Math.max(-MAP.half + 1, Math.min(MAP.half - 1, u.z));
    return false;
  }

  separation() {
    const cell = 2.4, grid = new Map();
    for (const u of this.units) {
      if (u.dead) continue;
      const k = ((u.x / cell) | 0) + ':' + ((u.z / cell) | 0);
      (grid.get(k) || grid.set(k, []).get(k)).push(u);
    }
    for (const u of this.units) {
      if (u.dead) continue;
      const cx = (u.x / cell) | 0, cz = (u.z / cell) | 0;
      for (let gx = cx - 1; gx <= cx + 1; gx++) for (let gz = cz - 1; gz <= cz + 1; gz++) {
        const cellUnits = grid.get(gx + ':' + gz);
        if (!cellUnits) continue;
        for (const v of cellUnits) {
          if (v === u || v.dead) continue;
          const dx = u.x - v.x, dz = u.z - v.z;
          const d = Math.hypot(dx, dz), min = 1.05;
          if (d < min && d > 0.0001) {
            const push = (min - d) * 0.5;
            u.x += (dx / d) * push; u.z += (dz / d) * push;
          } else if (d <= 0.0001) { u.x += (this.rand() - 0.5) * 0.2; u.z += (this.rand() - 0.5) * 0.2; }
        }
      }
    }
  }

  damageUnit(u, dmg, byFid) {
    if (u.dead) return;
    u.hp -= dmg; u.hitT = 0.25;
    const f = this.fac(u.faction);
    this.noticeAttack(f, u.x, u.z, byFid);
    // researchers flee toward base when hurt
    if (u.kind === 'researcher' && u.order.type !== 'flee') {
      u.order = { type: 'flee', x: f.base.x, z: f.base.z };
    }
    if (u.hp <= 0) {
      u.dead = true; u.diedAt = this.t;
      f.stats.losses++;
      if (byFid) this.fac(byFid).stats.kills++;
      this.emit({ type: 'unitDied', kind: u.kind, fid: u.faction, x: u.x, z: u.z });
    }
  }

  damageBuilding(b, dmg, byFid) {
    if (b.dead) return;
    b.hp -= dmg; b.hitT = 0.25;
    const f = this.fac(b.faction);
    this.noticeAttack(f, b.x, b.z, byFid);
    // final training run interrupted by damage to HQ
    if (b.kind === 'hq' && f.researching && f.milestone === 4) {
      f.pausedT = 4;
      f.researchProgress = Math.max(0, f.researchProgress - dmg / 900);
    }
    if (b.hp <= 0) {
      b.dead = true; b.diedAt = this.t;
      this.emit({ type: 'buildingDied', kind: b.kind, fid: b.faction, x: b.x, z: b.z, size: BUILDINGS[b.kind].size });
      if (byFid) {
        const killer = this.fac(byFid);
        killer.trust = Math.max(0, killer.trust - TRUST.buildingKillPenalty);
        f.trust = Math.min(100, f.trust + TRUST.victimSympathy);
      }
      if (b.kind === 'hq') this.eliminate(f);
    }
  }

  noticeAttack(f, x, z, byFid) {
    if (byFid && byFid !== f.id) {
      const aggressor = this.fac(byFid);
      if (aggressor.attackedRecentlyT <= 0) {
        aggressor.attackedRecentlyT = 30;
        aggressor.trust = Math.max(0, aggressor.trust - TRUST.attackPenalty);
      }
    }
    if (f.underAttackT <= 0) {
      f.underAttackT = 12;
      this.emit({ type: 'underattack', fid: f.id, x, z });
    }
  }

  eliminate(f) {
    f.alive = false; f.researching = false;
    for (const u of this.units) if (u.faction === f.id && !u.dead) { u.dead = true; u.diedAt = this.t; }
    for (const b of this.buildings) if (b.faction === f.id && !b.dead) { b.dead = true; b.diedAt = this.t; }
    this.emit({ type: 'eliminated', fid: f.id });
    const alive = Object.values(this.factions).filter(x => x.alive);
    if (alive.length === 1) {
      this.over = true; this.winner = alive[0].id;
      this.emit({ type: 'victory', fid: alive[0].id, byConquest: true });
    }
  }
}
