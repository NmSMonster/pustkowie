// Overlay HUD: resource bar, race panel, selection/actions, minimap,
// event feed, help, menu and end screens. Reads sim; issues commands.
import { FACTIONS, UNITS, BUILDINGS, MILESTONES, ABILITIES, MAP, TRUST } from '../sim/data.js';

const ICONS = { compute: '⚡', data: '◈', favor: '🏛', trust: '☺' };
const fmt = (n) => n >= 1000 ? (n / 1000).toFixed(1) + 'k' : Math.floor(n);

export function initHud(state) {
  const hud = document.getElementById('hud');
  const sim = () => state.sim;
  const me = () => sim().fac(sim().playerFaction);

  hud.innerHTML = `
    <div id="topbar" class="panel">
      <div id="fbadge"></div>
      <div class="res" id="res-compute"><span class="ic">${ICONS.compute}</span><b>0</b><i>+0/s</i></div>
      <div class="res" id="res-data"><span class="ic">${ICONS.data}</span><b>0</b></div>
      <div class="res" id="res-talent"><span class="ic">🧑‍🔬</span><b>0/0</b></div>
      <div class="res" id="res-favor"><span class="ic">${ICONS.favor}</span><b>0</b></div>
      <div class="res trust"><span class="ic">${ICONS.trust}</span><div id="trustbar"><div></div></div></div>
      <div id="clock">0:00</div>
      <button id="helpbtn" title="How to play (H)">?</button>
    </div>
    <div id="race" class="panel"><h4>RACE TO SUPERINTELLIGENCE</h4></div>
    <div id="minimap-wrap" class="panel"><canvas id="minimap" width="196" height="196"></canvas></div>
    <div id="feed"></div>
    <div id="selpanel" class="panel" style="display:none"></div>
    <div id="alert"></div>
    <div id="help" class="modal" style="display:none"></div>
    <div id="endscreen" class="modal" style="display:none"></div>
    <div id="pauseflag" style="display:none">⏸ PAUSED</div>
  `;
  hud.appendChild(document.getElementById('selbox') || document.createElement('i'));

  const el = (id) => document.getElementById(id);
  const feed = el('feed');
  const mm = el('minimap').getContext('2d');

  // faction badge
  const f0 = FACTIONS[sim().playerFaction];
  el('fbadge').innerHTML = `<span class="dot" style="background:${f0.css}"></span>${f0.name}`;
  el('helpbtn').onclick = () => api.toggleHelp();

  // race rows
  const raceRows = {};
  for (const fid in sim().factions) {
    const d = FACTIONS[fid];
    const row = document.createElement('div');
    row.className = 'racerow';
    row.innerHTML = `
      <span class="dot" style="background:${d.css}"></span>
      <span class="rname">${d.short}</span>
      <span class="pips">${[0, 1, 2, 3, 4].map(i => `<i data-i="${i}"></i>`).join('')}</span>
      <span class="rbar"><i></i></span>`;
    el('race').appendChild(row);
    raceRows[fid] = row;
  }

  // ---------- selection panel ----------
  function refreshSelection() {
    const sp = el('selpanel');
    const ids = [...state.selection];
    if (!ids.length) { sp.style.display = 'none'; sp.__lastHtml = null; return; }
    sp.style.display = 'flex';
    const ents = ids.map(id => sim().getEntity(id)).filter(Boolean);
    const units = ents.filter(e => e.kind && UNITS[e.kind]);
    const myUnits = units.filter(u => u.faction === sim().playerFaction);
    const building = ents.find(e => e.kind && BUILDINGS[e.kind]);
    const node = ents.find(e => e.amount !== undefined);

    let html = '';
    if (myUnits.length) {
      const byKind = {};
      for (const u of myUnits) (byKind[u.kind] ||= []).push(u);
      html += `<div class="selinfo">` + Object.entries(byKind).map(([k, arr]) =>
        `<span class="selchip">${arr.length}× ${UNITS[k].name}</span>`).join('') + `</div>`;
      if (byKind.researcher) {
        html += `<div class="actions"><span class="alabel">BUILD</span>` +
          Object.entries(BUILDINGS).filter(([k, d]) => k !== 'hq')
            .map(([k, d]) => {
              const locked = d.needsMilestone && me().milestone < d.needsMilestone;
              const cost = sim().buildingCost(sim().playerFaction, k);
              const cs = Object.entries(cost).map(([r, v]) => `${ICONS[r]}${v}`).join(' ');
              return `<button class="act" data-build="${k}" ${locked ? 'disabled' : ''} title="${d.desc}${locked ? ` (needs ${MILESTONES[d.needsMilestone - 1].short})` : ''}">${d.name}<i>${cs}</i></button>`;
            }).join('') + `</div>`;
      }
    } else if (building && building.faction === sim().playerFaction) {
      const d = BUILDINGS[building.kind];
      html += `<div class="selinfo"><span class="selchip">${d.name}</span><span class="hp">${Math.ceil(building.hp)}/${d.hp}</span>${building.done ? '' : ' <span class="hp">— under construction</span>'}</div>`;
      if (building.done) {
        const acts = [];
        if (building.kind === 'hq') {
          acts.push(`<button class="act" data-train="researcher">Hire Researcher<i>${ICONS.compute}${UNITS.researcher.cost.compute}</i></button>`);
          const m = me().milestone < 5 ? MILESTONES[me().milestone] : null;
          if (m && !me().researching) {
            const cs = Object.entries(m.cost).map(([r, v]) => `${ICONS[r]}${v}`).join(' ');
            acts.push(`<button class="act research" data-research="1" title="${m.desc} — ${m.perk}">🚀 ${m.name}<i>${cs}</i></button>`);
          } else if (me().researching) {
            acts.push(`<span class="selchip">researching… ${(me().researchProgress * 100).toFixed(0)}%</span>`);
          }
          acts.push(abilityBtn('poach'));
        }
        if (building.kind === 'foundry') {
          acts.push(`<button class="act" data-train="agent">Deploy Agent<i>${ICONS.compute}${UNITS.agent.cost.compute} ${ICONS.data}${UNITS.agent.cost.data}</i></button>`);
          const locked = me().milestone < UNITS.sentinel.needsMilestone;
          acts.push(`<button class="act" data-train="sentinel" ${locked ? 'disabled' : ''} title="${locked ? 'needs Advanced Reasoning' : 'ranged security unit'}">Deploy Sentinel<i>${ICONS.compute}${UNITS.sentinel.cost.compute} ${ICONS.data}${UNITS.sentinel.cost.data}</i></button>`);
        }
        if (building.kind === 'lobby') {
          acts.push(abilityBtn('probe'), abilityBtn('subsidy'), abilityBtn('pr'));
        }
        if (building.queue.length) {
          acts.push(`<span class="selchip">queue: ${building.queue.map(q => UNITS[q.kind].name[0]).join(' ')}</span>`);
        }
        if (acts.length) html += `<div class="actions">${acts.join('')}</div>`;
      }
    } else if (node) {
      html += `<div class="selinfo"><span class="selchip">Datastream Node</span><span class="hp">${Math.ceil(node.amount)} data left</span></div>`;
    } else if (building) {
      html += `<div class="selinfo"><span class="selchip" style="color:${FACTIONS[building.faction].css}">${FACTIONS[building.faction].name} — ${BUILDINGS[building.kind].name}</span></div>`;
    }
    if (sp.__lastHtml === html) return; // don't nuke DOM (and in-flight clicks) needlessly
    sp.__lastHtml = html;
    sp.innerHTML = html;

    sp.querySelectorAll('[data-build]').forEach(b => b.onclick = () => state.input.enterBuildMode(b.dataset.build));
    sp.querySelectorAll('[data-train]').forEach(b => b.onclick = () => {
      const ok = sim().cmdTrain(building.id, b.dataset.train);
      if (ok) state.audio?.play('click');
      refreshSelection();
    });
    sp.querySelectorAll('[data-research]').forEach(b => b.onclick = () => {
      if (sim().cmdResearch(sim().playerFaction)) state.audio?.play('coin');
      refreshSelection();
    });
    sp.querySelectorAll('[data-ability]').forEach(b => b.onclick = () => {
      const key = b.dataset.ability;
      if (key === 'poach' || key === 'probe') {
        if (key === 'probe') {
          // pick the race leader among rivals as target via menu-less UX: target by click on any enemy building/unit
        }
        state.input.enterAbilityMode(key);
      } else {
        if (sim().cmdAbility(sim().playerFaction, key)) state.audio?.play('coin');
      }
      refreshSelection();
    });
  }

  function abilityBtn(key) {
    const a = ABILITIES[key];
    const cd = me().cooldowns[key] || 0;
    const cost = Object.entries(a.cost).map(([r, v]) => `${ICONS[r]}${v}`).join(' ') + (a.trustCost ? ` −${a.trustCost}${ICONS.trust}` : '');
    return `<button class="act ability" data-ability="${key}" ${cd > 0 ? 'disabled' : ''} title="${a.desc}">${a.name}${cd > 0 ? ` (${Math.ceil(cd)}s)` : ''}<i>${cost}</i></button>`;
  }

  // ---------- feed & alerts ----------
  function post(msg, color = '#cfd8ea') {
    const d = document.createElement('div');
    d.className = 'feeditem';
    d.style.borderLeftColor = color;
    d.textContent = msg;
    feed.prepend(d);
    while (feed.children.length > 6) feed.lastChild.remove();
    setTimeout(() => d.classList.add('fade'), 7000);
    setTimeout(() => d.remove(), 9000);
  }

  function bigAlert(msg, color = '#ffd76a') {
    const a = el('alert');
    a.textContent = msg;
    a.style.color = color;
    a.classList.remove('show');
    void a.offsetWidth;
    a.classList.add('show');
  }

  function applyEvents(events) {
    for (const e of events) {
      const fd = e.fid ? FACTIONS[e.fid] : null;
      const mine = e.fid === sim().playerFaction;
      switch (e.type) {
        case 'milestone': {
          const m = MILESTONES[e.milestone - 1];
          bigAlert(`${fd.name} achieved ${m.name}!`, fd.css);
          post(`${fd.short} → ${m.short} (M${e.milestone}/5)`, fd.css);
          break;
        }
        case 'finalrun':
          bigAlert(`⚠ ${fd.name} HAS BEGUN THE FINAL TRAINING RUN ⚠`, fd.css);
          post(`${fd.short} is training a superintelligence!`, fd.css);
          break;
        case 'underattack':
          if (mine) { bigAlert('⚔ Your lab is under attack!', '#ff6a5a'); }
          break;
        case 'raidLaunched':
          if (e.victim === sim().playerFaction) post(`Hostile agents heading your way`, '#ff6a5a');
          break;
        case 'poached':
          post(`${fd.short} poached a researcher from ${FACTIONS[e.victim].short}`, fd.css);
          if (e.victim === sim().playerFaction) bigAlert('A researcher was poached!', '#d48aff');
          break;
        case 'probed':
          post(`${FACTIONS[e.victim].short} under regulatory probe (by ${fd.short})`, '#8ab6ff');
          if (e.victim === sim().playerFaction) bigAlert('Regulators are probing your lab! −50% compute', '#8ab6ff');
          break;
        case 'eliminated':
          bigAlert(`${fd.name} has been shut down`, '#99a3b8');
          post(`${fd.name} eliminated`, '#99a3b8');
          if (mine) showKnockout();
          break;
        case 'lowTrust':
          bigAlert('Public trust critical — regulators issue fines', '#ff9a4a');
          break;
        case 'nodeDepleted':
          post('A datastream node ran dry', '#39d5ff');
          break;
        case 'victory':
          showEnd(e.fid);
          break;
        case 'built':
          if (mine) post(`${BUILDINGS[e.kind].name} online`, '#9fe87a');
          break;
        case 'trained':
          if (mine && e.kind !== 'researcher') post(`${UNITS[e.kind].name} deployed`, fd.css);
          break;
      }
    }
  }

  // ---------- end / help / pause ----------
  function showKnockout() {
    const f = sim().fac(sim().playerFaction);
    el('endscreen').style.display = 'flex';
    el('endscreen').innerHTML = `
      <div class="modalbox" style="border-color:#99a3b8">
        <h1 style="color:#99a3b8">YOUR LAB HAS BEEN DISSOLVED</h1>
        <p>Your Frontier Lab is rubble, your researchers have updated their LinkedIn profiles, and a rival's blog post calls it "consolidation in the ecosystem." The race goes on — without you.</p>
        <p class="stats">Milestones ${f.milestone}/5 · Kills ${f.stats.kills} · Losses ${f.stats.losses}</p>
        <button onclick="location.reload()">RUN IT BACK</button>
        <button onclick="document.getElementById('endscreen').style.display='none'">WATCH THE FINISH</button>
      </div>`;
  }

  function showEnd(winnerId) {
    const win = winnerId === sim().playerFaction;
    const d = FACTIONS[winnerId];
    const f = sim().fac(sim().playerFaction);
    el('endscreen').style.display = 'flex';
    el('endscreen').innerHTML = `
      <div class="modalbox" style="border-color:${d.css}">
        <h1 style="color:${d.css}">${win ? '🏆 SUPERINTELLIGENCE ACHIEVED' : `${d.name} WINS THE RACE`}</h1>
        <p>${win
          ? 'Your model wakes up, reads the internet in an afternoon, and politely takes it from here. History will argue about what happened next — but it will argue in your name.'
          : `${d.name} reached superintelligence first. Their model is now writing the history books — you're a footnote in chapter 12.`}</p>
        <p class="stats">Milestones ${f.milestone}/5 · Kills ${f.stats.kills} · Losses ${f.stats.losses} · Researchers poached ${f.stats.poached}</p>
        <button onclick="location.reload()">RUN IT BACK</button>
      </div>`;
  }

  function toggleHelp(force) {
    const h = el('help');
    const show = force !== undefined ? force : h.style.display === 'none';
    h.style.display = show ? 'flex' : 'none';
    if (!show) return;
    h.innerHTML = `
      <div class="modalbox help">
        <h1>HOW TO WIN THE AI RACE</h1>
        <div class="cols">
          <div>
            <h3>THE GOAL</h3>
            <p>Be first to research all <b>5 frontier milestones</b> — the last one is the final training run to <b>SUPERINTELLIGENCE</b>. Everyone sees you start it, and damage to your Frontier Lab pauses it. Losing your Frontier Lab knocks you out of the race.</p>
            <h3>THE ECONOMY</h3>
            <p>${ICONS.compute} <b>Compute</b> flows from Compute Clusters — your money.<br>
            ${ICONS.data} <b>Data</b> is scraped by researchers from glowing datastream nodes. Nodes run dry — fight for the middle, or brew synthetic data later.<br>
            🧑‍🔬 <b>Talent</b> caps your researchers — grow it with Campuses. Rivals can <b>poach</b> yours.<br>
            ${ICONS.favor} <b>Favor</b> from the Policy Office buys regulatory strikes & subsidies.<br>
            ${ICONS.trust} <b>Trust</b> is public perception: high trust = faster research; below 30, fines drain you. Aggression costs trust.</p>
          </div>
          <div>
            <h3>CONTROLS (TRACKPAD)</h3>
            <p>
            <b>Two-finger scroll</b> — pan the map<br>
            <b>Pinch</b> — zoom · <b>Q / E</b> — rotate<br>
            <b>Click / drag</b> — select · <b>Shift</b> adds<br>
            <b>Two-finger tap</b> (right-click) — order: move, gather a node, attack<br>
            <b>1 / 2</b> — select army / researchers · <b>F</b> — jump to base<br>
            <b>H</b> — this guide · <b>P</b> — pause</p>
            <h3>THE PLAYBOOK</h3>
            <p>Researchers gather data & construct; select them to open the <b>build menu</b>. The Foundry deploys Agents (melee) and later Sentinels (ranged). Firewall Towers defend while you research. Watch the race panel — if a rival leads, probe them, poach them, or raid their Compute Clusters.</p>
          </div>
        </div>
        <button onclick="document.getElementById('help').style.display='none'">CLOSE (H)</button>
      </div>`;
  }

  function setPaused(p) { el('pauseflag').style.display = p ? 'block' : 'none'; }

  // ---------- per-frame ----------
  let uiT = 0;
  function update(dt) {
    uiT += dt;
    const f = me();
    // resources
    const dcs = sim().livingBuildings(f.id).filter(b => b.done);
    let rate = 0;
    for (const b of dcs) rate += (BUILDINGS[b.kind].income?.compute || 0);
    rate *= sim().incomeMult(f) * (f.def.computeMult || 1) * (f.probedT > 0 ? 0.5 : 1);
    el('res-compute').querySelector('b').textContent = fmt(f.compute);
    el('res-compute').querySelector('i').textContent = `+${rate.toFixed(1)}/s`;
    el('res-data').querySelector('b').textContent = fmt(f.data);
    el('res-talent').querySelector('b').textContent = `${sim().researcherCount(f.id)}/${sim().talentCap(f.id)}`;
    el('res-favor').querySelector('b').textContent = fmt(f.favor);
    const tb = el('trustbar').firstElementChild;
    tb.style.width = f.trust + '%';
    tb.style.background = f.trust < TRUST.low ? '#ff5f4a' : f.trust > TRUST.high ? '#6ee787' : '#ffd76a';
    const t = sim().t | 0;
    el('clock').textContent = `${(t / 60) | 0}:${String(t % 60).padStart(2, '0')}`;

    // race panel
    for (const fid in raceRows) {
      const rf = sim().fac(fid);
      const row = raceRows[fid];
      row.classList.toggle('dead', !rf.alive);
      row.querySelectorAll('.pips i').forEach((pip, i) => {
        pip.className = i < rf.milestone ? 'done' : (rf.researching && i === rf.milestone ? 'active' : '');
      });
      const bar = row.querySelector('.rbar i');
      bar.style.width = (rf.researching ? rf.researchProgress * 100 : 0) + '%';
      bar.style.background = FACTIONS[fid].css;
      row.querySelector('.rbar').classList.toggle('final', rf.researching && rf.milestone === 4);
    }

    // refresh selection panel occasionally (cooldowns/progress tick)
    if (uiT > 0.5) { uiT = 0; if (el('selpanel').style.display !== 'none') refreshSelection(); }

    drawMinimap();
  }

  function drawMinimap() {
    const S = 196, k = S / (MAP.half * 2);
    mm.fillStyle = '#101a12';
    mm.fillRect(0, 0, S, S);
    const px = (x) => (x + MAP.half) * k;
    // nodes
    for (const n of sim().nodes) {
      if (n.amount <= 0) continue;
      mm.fillStyle = '#39d5ff';
      mm.fillRect(px(n.x) - 2, px(n.z) - 2, 4, 4);
    }
    // buildings & units
    for (const b of sim().buildings) {
      if (b.dead) continue;
      mm.fillStyle = FACTIONS[b.faction].css;
      const s = b.kind === 'hq' ? 7 : 4;
      mm.fillRect(px(b.x) - s / 2, px(b.z) - s / 2, s, s);
    }
    for (const u of sim().units) {
      if (u.dead) continue;
      mm.fillStyle = FACTIONS[u.faction].css;
      mm.fillRect(px(u.x) - 1, px(u.z) - 1, 2.4, 2.4);
    }
    // camera frustum marker
    const w = state.world;
    mm.strokeStyle = 'rgba(255,255,255,0.75)';
    mm.strokeRect(px(w.camFocus.x) - 11, px(w.camFocus.z) - 8, 22, 16);
  }

  // minimap click to jump
  el('minimap').addEventListener('mousedown', (e) => {
    const r = e.target.getBoundingClientRect();
    const k = (MAP.half * 2) / 196;
    state.world.camFocus.x = (e.clientX - r.left) * k - MAP.half;
    state.world.camFocus.z = (e.clientY - r.top) * k - MAP.half;
  });

  const api = { update, applyEvents, refreshSelection, toggleHelp, setPaused, post, bigAlert };
  state.hud = api;
  post('Welcome. Scale responsibly — or don\'t.', f0.css);
  return api;
}

// ---------- faction select menu ----------
export function showMenu(onPick) {
  const hud = document.getElementById('hud');
  const menu = document.createElement('div');
  menu.className = 'modal';
  menu.id = 'menu';
  menu.innerHTML = `
    <div class="menubox">
      <h1 class="title">SUPERINTELLIGENCE</h1>
      <p class="subtitle">Four labs. One finish line. Pick your allegiance in the race that decides everything.</p>
      <div class="cards">
        ${Object.values(FACTIONS).map(f => `
          <div class="card" data-fid="${f.id}" style="--c:${f.css}">
            <h2>${f.name}</h2>
            <p class="motto">“${f.motto}”</p>
            <p class="bonus"><b>${f.bonusName}</b> — ${f.bonusDesc}</p>
            <button>LEAD ${f.short}</button>
          </div>`).join('')}
      </div>
      <p class="hint">Two-finger scroll to pan · pinch to zoom · two-finger tap to command · H for the full guide</p>
    </div>`;
  hud.appendChild(menu);
  menu.querySelectorAll('.card').forEach(c => {
    c.onclick = () => {
      menu.remove();
      onPick(c.dataset.fid);
    };
  });
}
