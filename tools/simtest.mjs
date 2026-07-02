// Headless sim verification: all four labs run on AI, race to ASI.
// Usage: node tools/simtest.mjs [minutes] [seed]
import { Sim } from '../src/sim/sim.js';
import { LabAI } from '../src/sim/ai.js';

const minutes = parseFloat(process.argv[2] || '20');
const seed = parseInt(process.argv[3] || '7', 10);

const sim = new Sim('anthropic', seed);
sim.factions.anthropic.isPlayer = false; // let AI drive all four
const ais = Object.keys(sim.factions).map(fid => new LabAI(sim, fid));

const eventCounts = {};
let lastReport = 0;
const dt = 0.1;
for (let t = 0; t < minutes * 60 && !sim.over; t += dt) {
  sim.tick(dt);
  for (const ai of ais) ai.tick(dt);
  for (const e of sim.events) eventCounts[e.type] = (eventCounts[e.type] || 0) + 1;
  const alerts = sim.events.filter(e => ['milestone', 'finalrun', 'eliminated', 'victory', 'raidLaunched'].includes(e.type));
  for (const a of alerts) console.log(`[${(sim.t / 60).toFixed(1)}m]`, a.type, a.fid || '', a.milestone !== undefined ? 'M' + a.milestone : '', a.victim || '');
  sim.events.length = 0;

  if (sim.t - lastReport >= 120) {
    lastReport = sim.t;
    console.log(`--- t=${(sim.t / 60).toFixed(0)}m ---`);
    for (const f of Object.values(sim.factions)) {
      const units = sim.livingUnits(f.id).length;
      const blds = sim.livingBuildings(f.id).length;
      console.log(`  ${f.id.padEnd(9)} ${f.alive ? 'alive' : 'DEAD '} M${f.milestone} prog=${(f.researchProgress * 100).toFixed(0)}% c=${f.compute.toFixed(0)} d=${f.data.toFixed(0)} favor=${f.favor.toFixed(0)} trust=${f.trust.toFixed(0)} units=${units} blds=${blds}`);
    }
  }
}
console.log('\n=== RESULT ===');
console.log('over:', sim.over, 'winner:', sim.winner, 'at', (sim.t / 60).toFixed(1), 'min');
console.log('events:', JSON.stringify(eventCounts));
