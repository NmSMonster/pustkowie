// Rival lab AI. Each faction runs the same controller with personality weights
// from FACTIONS[fid].ai: { aggression, econ, tech, trustCare }.
import { UNITS, BUILDINGS, MILESTONES, ABILITIES, TRUST } from './data.js';

export class LabAI {
  constructor(sim, fid) {
    this.sim = sim;
    this.fid = fid;
    this.p = sim.fac(fid).def.ai;
    this.thinkT = sim.rand() * 1;
    this.raid = null; // { targetFid }
    this.raidCdT = 0;
    this.buildCursor = 0;
  }

  tick(dt) {
    this.thinkT -= dt;
    if (this.thinkT > 0) return;
    this.thinkT = 1.0 + this.sim.rand() * 0.4;

    const s = this.sim, f = s.fac(this.fid);
    if (!f.alive || s.over) return;

    this.manageEconomy(f);
    this.manageResearch(f);
    this.manageMilitary(f);
    this.manageAbilities(f);
  }

  // ---------- economy ----------
  manageEconomy(f) {
    const s = this.sim;
    const mins = s.t / 60;
    const my = { hq: null, counts: {} };
    for (const b of s.livingBuildings(this.fid)) {
      my.counts[b.kind] = (my.counts[b.kind] || 0) + 1;
      if (b.kind === 'hq') my.hq = b;
    }
    if (!my.hq) return;

    // researcher management
    const researchers = s.units.filter(u => !u.dead && u.faction === this.fid && u.kind === 'researcher');
    const cap = s.talentCap(this.fid);
    const targetR = Math.min(cap, 5 + Math.floor(mins * 1.5 * this.p.econ));
    const dataFlush = f.data > 1200 && researchers.length > 4;
    if (researchers.length < targetR && !dataFlush) s.cmdTrain(my.hq.id, 'researcher');

    // assign idle researchers: construction first, then gather
    const underCon = s.livingBuildings(this.fid).filter(b => !b.done);
    for (const u of researchers) {
      if (u.order.type === 'idle' || (u.order.type === 'attackmove_hold')) {
        if (underCon.length) s.cmdBuildAssign([u.id], underCon[0].id);
        else {
          const node = s.nearestNode(u, 1e9);
          if (node) s.cmdGather([u.id], node.id);
        }
      }
    }

    // build order — driven by needs
    const want = [];
    if ((my.counts.datacenter || 0) < 1) want.push('datacenter');
    if (mins > 1.0 && (my.counts.foundry || 0) < 1) want.push('foundry');
    if (mins > 1.6 && (my.counts.lobby || 0) < 1) want.push('lobby');
    if (researchers.length >= cap - 1 && (my.counts.campus || 0) < 2) want.push('campus');
    if (mins > 2.3 && (my.counts.tower || 0) < 1) want.push('tower');
    if ((my.counts.datacenter || 0) < 2 && mins > 4) want.push('datacenter');
    const nodesLeft = s.nodes.reduce((a, n) => a + n.amount, 0);
    const dataNeed = f.milestone < 5 ? MILESTONES[f.milestone].cost.data : 0;
    const synthTarget = f.milestone >= 2 ? (nodesLeft < 900 || f.data < dataNeed * 0.4 ? 3 : 1) : 0;
    if ((my.counts.synth || 0) < synthTarget) want.push('synth');
    if (mins > 6 && (my.counts.tower || 0) < 2) want.push('tower');
    if (mins > 8 && (my.counts.datacenter || 0) < 3) want.push('datacenter');

    if (want.length && underCon.length < 2) {
      const kind = want[0];
      const cost = s.buildingCost(this.fid, kind);
      // save for research if tech-focused and close to affording milestone
      const m = f.milestone < 5 ? MILESTONES[f.milestone] : null;
      const saving = m && !f.researching && this.p.tech > 0.7 &&
        f.compute > m.cost.compute * 0.65 && f.compute < m.cost.compute + 200;
      if (!saving && s.canAfford(f, cost)) {
        const spot = this.findSpot(kind, my.hq);
        if (spot) {
          const b = s.cmdBuild(this.fid, kind, spot.x, spot.z);
          if (b) {
            const near = researchers.filter(u => u.order.type !== 'build').slice(0, 2);
            if (near.length) s.cmdBuildAssign(near.map(u => u.id), b.id);
          }
        }
      }
    }
  }

  findSpot(kind, hq) {
    const s = this.sim;
    const size = BUILDINGS[kind].size;
    for (let attempt = 0; attempt < 24; attempt++) {
      const a = s.rand() * Math.PI * 2;
      const r = (kind === 'tower' ? 9 : 5) + s.rand() * (kind === 'tower' ? 6 : 11);
      const x = hq.x + Math.cos(a) * r, z = hq.z + Math.sin(a) * r;
      if (s.placementValid(kind, x, z)) return { x, z };
    }
    return null;
  }

  // ---------- research ----------
  manageResearch(f) {
    const s = this.sim;
    if (f.researching || f.milestone >= 5) return;
    const m = MILESTONES[f.milestone];
    // tech-hungry factions research asap; others keep a small buffer
    const buffer = (1 - this.p.tech) * 150;
    if (f.compute >= m.cost.compute + buffer && f.data >= m.cost.data) s.cmdResearch(this.fid);
  }

  // ---------- military ----------
  manageMilitary(f) {
    const s = this.sim;
    const mins = s.t / 60;
    const foundry = s.livingBuildings(this.fid).find(b => b.kind === 'foundry' && b.done);
    const army = s.units.filter(u => !u.dead && u.faction === this.fid && u.kind !== 'researcher');

    if (foundry) {
      const targetArmy = Math.floor(2 + mins * (0.6 + this.p.aggression * 1.4));
      if (army.length + foundry.queue.length < targetArmy) {
        const kind = (f.milestone >= 2 && s.rand() < 0.45) ? 'sentinel' : 'agent';
        s.cmdTrain(foundry.id, kind);
      }
    }

    // defense: if under attack, rally army home
    if (f.underAttackT > 8) {
      const ids = army.map(u => u.id);
      if (ids.length) s.cmdMove(ids, f.base.x, f.base.z, true);
      this.raid = null;
      return;
    }

    // raiding
    this.raidCdT = Math.max(0, this.raidCdT - 1);
    const threshold = Math.max(4, Math.round(5 + (1 - this.p.aggression) * 5));
    if (mins < 4 || this.raidCdT > 0) return;
    const idleArmy = army.filter(u => u.order.type === 'idle' || u.order.type === 'attackmove_hold');
    const garrison = 2; // never leave the lab empty
    if (!this.raid && idleArmy.length >= threshold + garrison) {
      const target = this.pickRaidTarget(f);
      if (target) {
        this.raid = { targetFid: target.id };
        this.raidCdT = 45 + (1 - this.p.aggression) * 40;
        const spot = this.pickRaidSpot(target);
        s.cmdMove(idleArmy.slice(garrison).map(u => u.id), spot.x, spot.z, true);
        s.emit({ type: 'raidLaunched', fid: this.fid, victim: target.id });
      }
    }
    if (this.raid) {
      const t = s.fac(this.raid.targetFid);
      if (!t.alive || army.length < 2) this.raid = null;
    }
  }

  pickRaidTarget(f) {
    const s = this.sim;
    const others = Object.values(s.factions).filter(o => o.alive && o.id !== this.fid);
    if (!others.length) return null;
    // prefer the race leader; xAI just hits whoever is richest
    others.sort((a, b) =>
      (b.milestone + b.researchProgress) - (a.milestone + a.researchProgress) ||
      b.compute - a.compute);
    const leader = others[0];
    const me = f.milestone + f.researchProgress;
    if (leader.milestone + leader.researchProgress > me + 0.5 || this.p.aggression > 0.7) return leader;
    // otherwise raid nearest
    let best = others[0], bd = 1e9;
    for (const o of others) {
      const d = Math.hypot(o.base.x - f.base.x, o.base.z - f.base.z);
      if (d < bd) { bd = d; best = o; }
    }
    return best;
  }

  pickRaidSpot(target) {
    const s = this.sim;
    // hit their economy: a datacenter if any, else HQ
    const dcs = s.livingBuildings(target.id).filter(b => b.kind === 'datacenter' && b.done);
    const t = dcs.length ? dcs[Math.floor(s.rand() * dcs.length)] : { x: target.base.x, z: target.base.z };
    return { x: t.x, z: t.z };
  }

  // ---------- abilities ----------
  manageAbilities(f) {
    const s = this.sim;
    // PR when trust is dangerous
    if (f.trust < TRUST.low + 8 && this.p.trustCare > 0.2) s.cmdAbility(this.fid, 'pr');
    // subsidy when poor
    if (f.compute < 120 && f.favor >= ABILITIES.subsidy.cost.favor) s.cmdAbility(this.fid, 'subsidy');
    // probe the leader
    if (f.favor >= ABILITIES.probe.cost.favor && s.rand() < 0.4) {
      const others = Object.values(s.factions).filter(o => o.alive && o.id !== this.fid);
      others.sort((a, b) => (b.milestone + b.researchProgress) - (a.milestone + a.researchProgress));
      if (others[0] && (others[0].milestone + others[0].researchProgress) > (f.milestone + f.researchProgress)) {
        s.cmdAbility(this.fid, 'probe', others[0].id);
      }
    }
    // poach when rich and unscrupulous
    if (this.p.trustCare < 0.6 && f.compute > 400 && s.rand() < 0.25) {
      const victims = s.units.filter(u => !u.dead && u.kind === 'researcher' && u.faction !== this.fid);
      if (victims.length) s.cmdAbility(this.fid, 'poach', victims[Math.floor(s.rand() * victims.length)].id);
    }
  }
}

export function makeAIs(sim) {
  return Object.keys(sim.factions)
    .filter(fid => !sim.fac(fid).isPlayer)
    .map(fid => new LabAI(sim, fid));
}
