// Overlay HUD: resource bar, race panel, selection/actions, minimap,
// event feed, help, menu and end screens. Reads sim; issues commands.
import { FACTIONS, UNITS, BUILDINGS, MILESTONES, ABILITIES, MAP, TRUST, WORLD_EVENTS, PACT, MAP_VARIANTS, DIFFICULTY } from '../sim/data.js';
import { settings, saveSettings } from '../settings.js';

const ICONS = { compute: '⚡', data: '◈', favor: '🏛', trust: '☺' };

const ACHIEVEMENTS = [
  { id: 'pacifist', icon: '🕊', name: 'Aligned by Default', desc: 'Win without a single kill' },
  { id: 'untrusted', icon: '🕶', name: 'Court of Public Opinion', desc: 'Win with trust below 30' },
  { id: 'speed', icon: '⏱', name: 'Fast Takeoff', desc: 'Win in under 12 minutes' },
  { id: 'coalition', icon: '🤝', name: 'Multi-Stakeholder', desc: 'Win while a pact is active' },
  { id: 'backstab', icon: '🗡', name: 'Effective Altruist', desc: 'Betray a pact and still win' },
  { id: 'fullhouse', icon: '🏗', name: 'Full Stack Lab', desc: 'Win owning all 7 building types' },
  { id: 'poacher', icon: '🎣', name: 'Talent Magnet', desc: 'Poach 3+ researchers in one match' },
  { id: 'survivor', icon: '🚑', name: 'Near Miss', desc: 'Win after your HQ fell below 25% HP' },
];
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
      <button id="gearbtn" title="Settings">⚙</button>
    </div>
    <div id="eventchip" class="panel" style="display:none"></div>
    <div id="intelchip" class="panel" style="display:none"></div>
    <div id="tutorial" class="panel" style="display:none"></div>
    <div id="pactoffer" class="panel" style="display:none"></div>
    <div id="settings" class="modal" style="display:none"></div>
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
  el('gearbtn').onclick = () => toggleSettings();

  // race rows
  const raceRows = {};
  for (const fid in sim().factions) {
    const d = FACTIONS[fid];
    const row = document.createElement('div');
    row.className = 'racerow';
    const isMe = fid === sim().playerFaction;
    row.innerHTML = `
      <span class="dot" style="background:${d.css}"></span>
      <span class="rname">${d.short}</span>
      <span class="pips">${[0, 1, 2, 3, 4].map(i => `<i data-i="${i}"></i>`).join('')}</span>
      <span class="rbar"><i></i></span>
      <span class="pactslot">${isMe ? '' : `<button class="pactbtn" data-fid="${fid}" title="Propose non-aggression pact (${PACT.proposeCost} favor, +${PACT.income}⚡/s each while active)">🤝</button>`}</span>`;
    el('race').appendChild(row);
    raceRows[fid] = row;
    const pb = row.querySelector('.pactbtn');
    if (pb) pb.onclick = () => {
      const ok = sim().cmdProposePact(fid);
      if (ok) state.audio?.play('coin');
      else post(`${d.short} is not interested (or you lack favor)`, '#99a3b8');
    };
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
          acts.push(abilityBtn('poach'), abilityBtn('scrape'), abilityBtn('license'));
        }
        if (building.kind === 'foundry') {
          acts.push(`<button class="act" data-train="agent" title="melee raider — beats Sentinels up close, EMP'd by Interceptors">Deploy Agent<i>${ICONS.compute}${UNITS.agent.cost.compute} ${ICONS.data}${UNITS.agent.cost.data}</i></button>`);
          const iLocked = me().milestone < UNITS.interceptor.needsMilestone;
          acts.push(`<button class="act" data-train="interceptor" ${iLocked ? 'disabled' : ''} title="${iLocked ? 'needs Foundation Model' : 'EMP specialist — 2.2x damage vs Agents and slows them; loses to Sentinels'}">Deploy Interceptor<i>${ICONS.compute}${UNITS.interceptor.cost.compute} ${ICONS.data}${UNITS.interceptor.cost.data}</i></button>`);
          const locked = me().milestone < UNITS.sentinel.needsMilestone;
          acts.push(`<button class="act" data-train="sentinel" ${locked ? 'disabled' : ''} title="${locked ? 'needs Advanced Reasoning' : 'long-range — shreds Interceptors, folds to Agents in melee'}">Deploy Sentinel<i>${ICONS.compute}${UNITS.sentinel.cost.compute} ${ICONS.data}${UNITS.sentinel.cost.data}</i></button>`);
        }
        if (building.kind === 'lobby') {
          acts.push(abilityBtn('probe'), abilityBtn('subsidy'), abilityBtn('pr'), abilityBtn('infiltrate'));
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
      if (key === 'poach' || key === 'probe' || key === 'infiltrate') {
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
        case 'worldEvent': {
          const w = WORLD_EVENTS[e.key];
          bigAlert(`${w.icon} ${w.name}`, '#8ab6ff');
          post(w.desc, '#8ab6ff');
          break;
        }
        case 'worldEventEnd': {
          post(`${WORLD_EVENTS[e.key].name} is over`, '#6b7893');
          break;
        }
        case 'pactOffer':
          showPactOffer(e.from);
          state.audio?.play('coin', 0.6);
          break;
        case 'pactOfferExpired':
          el('pactoffer').style.display = 'none';
          break;
        case 'pactFormed': {
          const other = e.a === sim().playerFaction ? e.b : e.a;
          const involveMe = e.a === sim().playerFaction || e.b === sim().playerFaction;
          post(`🤝 Pact: ${FACTIONS[e.a].short} + ${FACTIONS[e.b].short}`, involveMe ? '#6ee787' : '#99a3b8');
          if (involveMe) bigAlert(`🤝 Pact with ${FACTIONS[other].name}`, '#6ee787');
          break;
        }
        case 'pactBroken': {
          const involveMe = e.a === sim().playerFaction || e.b === sim().playerFaction;
          if (e.betrayal) {
            const victim = e.by === e.a ? e.b : e.a;
            post(`🗡 ${FACTIONS[e.by].short} betrayed ${FACTIONS[victim].short}!`, '#ff6a5a');
            if (victim === sim().playerFaction) bigAlert(`🗡 ${FACTIONS[e.by].name} BETRAYED YOU`, '#ff6a5a');
            else if (involveMe) bigAlert('You broke the pact — trust suffers', '#ff9a4a');
          } else if (involveMe) post('A pact has ended', '#99a3b8');
          break;
        }
        case 'pactExpired':
          if (e.a === sim().playerFaction || e.b === sim().playerFaction) post('Your pact expired', '#99a3b8');
          break;
        case 'pactDeclined':
          if (e.to === sim().playerFaction) post(`${FACTIONS[e.by].short} declined your pact`, '#99a3b8');
          break;
        case 'scrape':
          if (mine) post('Scraped the open web: +150 data, the op-eds write themselves', '#ff9a4a');
          break;
        case 'license':
          if (mine) post('Licensed a clean corpus: +150 data, publishers appeased', '#6ee787');
          break;
        case 'infiltrated':
          if (mine) { bigAlert(`🕵 Mole placed inside ${FACTIONS[e.victim].name}`, '#d48aff'); post('Their base and books are visible for 30s', '#d48aff'); }
          else if (e.victim === sim().playerFaction) post('Counterintel: someone infiltrated your lab', '#ff6a5a');
          break;
        case 'intelEnd':
          post('Your mole went cold', '#99a3b8');
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
        ${replayHtml()}
        <button onclick="location.reload()">RUN IT BACK</button>
        <button onclick="document.getElementById('endscreen').style.display='none'">WATCH THE FINISH</button>
      </div>`;
    startReplay();
  }

  function evalAchievements(win) {
    if (!win) return [];
    const f = me(), s2 = sim();
    const kinds = new Set(s2.livingBuildings(f.id).map(b => b.kind));
    const hasPactNow = Object.values(s2.pacts).some(pp => pp.a === f.id || pp.b === f.id);
    const unlocked = [];
    const cond = {
      pacifist: f.stats.kills === 0,
      untrusted: f.trust < 30,
      speed: s2.t < 12 * 60,
      coalition: hasPactNow,
      backstab: (f.stats.betrayals || 0) > 0,
      fullhouse: kinds.size >= 7,
      poacher: f.stats.poached >= 3,
      survivor: !!f.stats.hqLow,
    };
    for (const a of ACHIEVEMENTS) {
      if (cond[a.id] && !settings.achievements[a.id]) {
        settings.achievements[a.id] = true;
        unlocked.push(a);
      }
    }
    if (unlocked.length) saveSettings({ achievements: settings.achievements });
    return unlocked;
  }

  function raceChartHtml() {
    return `<canvas id="endchart" width="520" height="150" style="margin:10px auto;display:block;background:#0a0e1a;border-radius:8px"></canvas>`;
  }

  function drawRaceChart() {
    const cv2 = el('endchart');
    if (!cv2) return;
    const g = cv2.getContext('2d');
    const H2 = cv2.height, W2 = cv2.width, hist = sim().history;
    if (!hist.length) return;
    g.strokeStyle = 'rgba(140,160,200,0.25)';
    for (let m = 1; m <= 5; m++) {
      const y = H2 - 12 - (m / 5) * (H2 - 24);
      g.beginPath(); g.moveTo(30, y); g.lineTo(W2 - 8, y); g.stroke();
      g.fillStyle = '#66748f'; g.font = '9px sans-serif';
      g.fillText('M' + m, 8, y + 3);
    }
    const tMax = hist[hist.length - 1].t || 1;
    for (const fid in sim().factions) {
      g.strokeStyle = FACTIONS[fid].css;
      g.lineWidth = 2;
      g.beginPath();
      let started = false;
      for (const h of hist) {
        if (h.s[fid] === null) break;
        const x = 30 + (h.t / tMax) * (W2 - 40);
        const y = H2 - 12 - (Math.min(5, h.s[fid]) / 5) * (H2 - 24);
        if (!started) { g.moveTo(x, y); started = true; } else g.lineTo(x, y);
      }
      g.stroke();
    }
  }

  function replayHtml() {
    return `<canvas id="endreplay" width="220" height="220" style="margin:8px auto;display:block;background:#0d1410;border-radius:8px"></canvas>
      <p class="stats">ostatnie sekundy meczu</p>`;
  }

  function startReplay() {
    const cv2 = el('endreplay');
    if (!cv2 || !sim().recap.length) return;
    const g = cv2.getContext('2d');
    let fi = 0;
    const frames = sim().recap;
    const k = 220 / (MAP.half * 2);
    const px = (x) => (x + MAP.half) * k;
    clearInterval(window.__replayTimer);
    window.__replayTimer = setInterval(() => {
      if (!document.body.contains(cv2)) { clearInterval(window.__replayTimer); return; }
      const fr = frames[fi];
      fi = (fi + 1) % frames.length;
      g.fillStyle = '#0d1410'; g.fillRect(0, 0, 220, 220);
      g.fillStyle = '#39d5ff';
      for (const n of sim().nodes) if (n.amount > 0) g.fillRect(px(n.x) - 1.5, px(n.z) - 1.5, 3, 3);
      for (const b of fr.b) {
        g.fillStyle = FACTIONS[b[0]].css;
        const s3 = b[1] ? 7 : 4;
        g.globalAlpha = 0.35 + 0.65 * (b[4] / 100);
        g.fillRect(px(b[2]) - s3 / 2, px(b[3]) - s3 / 2, s3, s3);
      }
      g.globalAlpha = 1;
      for (const u of fr.u) {
        g.fillStyle = FACTIONS[u[0]].css;
        g.fillRect(px(u[2]) - 1, px(u[3]) - 1, u[1] ? 2.6 : 2, u[1] ? 2.6 : 2);
      }
      g.fillStyle = '#8fa2c4'; g.font = '10px sans-serif';
      g.fillText(`t=${Math.round(fr.t)}s  (${fi + 1}/${frames.length})`, 6, 212);
    }, 320);
  }

  function showEnd(winnerId) {
    const win = winnerId === sim().playerFaction;
    const d = FACTIONS[winnerId];
    const f = sim().fac(sim().playerFaction);
    const unlocked = evalAchievements(win);
    el('endscreen').style.display = 'flex';
    el('endscreen').innerHTML = `
      <div class="modalbox" style="border-color:${d.css}">
        <h1 style="color:${d.css}">${win ? '🏆 SUPERINTELLIGENCE ACHIEVED' : `${d.name} WINS THE RACE`}</h1>
        <p>${win
          ? 'Your model wakes up, reads the internet in an afternoon, and politely takes it from here. History will argue about what happened next — but it will argue in your name.'
          : `${d.name} reached superintelligence first. Their model is now writing the history books — you're a footnote in chapter 12.`}</p>
        <p class="stats">Milestones ${f.milestone}/5 · Kills ${f.stats.kills} · Losses ${f.stats.losses} · Researchers poached ${f.stats.poached}</p>
        ${raceChartHtml()}
        ${unlocked.length ? `<p class="feat">${unlocked.map(a => `${a.icon} <b>${a.name}</b> — ${a.desc}`).join('<br>')}</p>` : ''}
        <button onclick="location.reload()">RUN IT BACK</button>
      </div>`;
    drawRaceChart();
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
            <b>Ctrl+1..9</b> — bind control group · <b>1..9</b> — recall it<br>
            <b>1 / 2</b> — (unbound) select army / researchers · <b>F</b> — jump to base<br>
            <b>H</b> — this guide · <b>P</b> — pause</p>
            <h3>THE PLAYBOOK</h3>
            <p>Researchers gather data & construct; select them to open the <b>build menu</b>. The Foundry deploys <b>Agents</b> (melee), <b>Interceptors</b> (EMP: 2.2× vs Agents) and <b>Sentinels</b> (long range, shred Interceptors) — a counter triangle. The map hides under <b>fog of war</b>: scout it or buy an <b>Infiltrate</b> mole for 30s of intel. Short on data? <b>Web Scrape</b> (costs trust) or buy <b>Licensed Data</b> (costs compute).</p>
          </div>
        </div>
        <button onclick="document.getElementById('help').style.display='none'">CLOSE (H)</button>
      </div>`;
  }

  function setPaused(p) { el('pauseflag').style.display = p ? 'block' : 'none'; }

  // ---------- pact offer ----------
  function showPactOffer(fromFid) {
    const d = FACTIONS[fromFid];
    const po = el('pactoffer');
    po.style.display = 'block';
    po.innerHTML = `
      <b style="color:${d.css}">${d.name}</b> proposes a <b>non-aggression pact</b>
      <span class="hp">(+${PACT.income}⚡/s each, ${PACT.duration}s)</span>
      <div class="actions" style="margin-top:6px">
        <button class="act" id="pact-yes">🤝 Accept</button>
        <button class="act" id="pact-no">Decline</button>
      </div>`;
    el('pact-yes').onclick = () => { sim().respondPact(true); po.style.display = 'none'; state.audio?.play('coin'); };
    el('pact-no').onclick = () => { sim().respondPact(false); po.style.display = 'none'; };
  }

  // ---------- settings ----------
  function toggleSettings(force) {
    const sEl = el('settings');
    const show = force !== undefined ? force : sEl.style.display === 'none';
    sEl.style.display = show ? 'flex' : 'none';
    if (!show) return;
    sEl.innerHTML = `
      <div class="modalbox">
        <h1>SETTINGS</h1>
        <div class="setrow"><label>Master volume</label><input type="range" id="set-master" min="0" max="1" step="0.05" value="${settings.master}"></div>
        <div class="setrow"><label>Music volume</label><input type="range" id="set-music" min="0" max="1" step="0.05" value="${settings.music}"></div>
        <div class="setrow"><label>Graphics quality</label>
          <select id="set-quality">
            ${['auto', 'high', 'low'].map(q => `<option value="${q}" ${settings.quality === q ? 'selected' : ''}>${q}</option>`).join('')}
          </select></div>
        <p class="stats">Saved automatically. Quality changes apply to new matches instantly; in-match it adjusts on the fly.</p>
        <button onclick="document.getElementById('settings').style.display='none'">CLOSE</button>
      </div>`;
    el('set-master').oninput = (e) => saveSettings({ master: +e.target.value });
    el('set-music').oninput = (e) => saveSettings({ music: +e.target.value });
    el('set-quality').onchange = (e) => saveSettings({ quality: e.target.value });
  }

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

    // active world event chip
    const chip = el('eventchip');
    if (sim().activeEvent) {
      const w = WORLD_EVENTS[sim().activeEvent.key];
      chip.style.display = 'block';
      chip.textContent = `${w.icon} ${w.name} — ${Math.ceil(sim().activeEvent.t)}s`;
    } else chip.style.display = 'none';

    // pact badges + propose availability in race panel
    for (const fid in raceRows) {
      if (fid === sim().playerFaction) continue;
      const pb = raceRows[fid].querySelector('.pactbtn');
      if (!pb) continue;
      const pact = sim().hasPact(sim().playerFaction, fid);
      const grudge = (sim().grudges[sim().pactKey(sim().playerFaction, fid)] || 0) > 0;
      pb.classList.toggle('active', pact);
      pb.disabled = pact || grudge || !sim().fac(fid).alive;
      pb.textContent = pact ? '🤝' : grudge ? '💢' : '🤝';
    }

    // live intel readout while the mole is active
    const ic = el('intelchip');
    if (sim().intel) {
      const tf = sim().fac(sim().intel.on);
      const army = sim().units.filter(u => !u.dead && u.faction === tf.id && u.kind !== 'researcher').length;
      ic.style.display = 'block';
      ic.innerHTML = `🕵 <b style="color:${FACTIONS[tf.id].css}">${FACTIONS[tf.id].short}</b>
        ⚡${fmt(tf.compute)} ◈${fmt(tf.data)} · armia ${army} · M${tf.milestone}${tf.researching ? ` (${Math.round(tf.researchProgress * 100)}%)` : ''} · ${Math.ceil(sim().intel.t)}s`;
    } else ic.style.display = 'none';
    updateTutorial();

    // refresh selection panel occasionally (cooldowns/progress tick)
    if (uiT > 0.5) { uiT = 0; if (el('selpanel').style.display !== 'none') refreshSelection(); }

    drawMinimap();
  }

  // static terrain backdrop for the minimap, painted once
  let mmBg = null;
  function minimapBg() {
    if (mmBg) return mmBg;
    mmBg = document.createElement('canvas');
    mmBg.width = mmBg.height = 196;
    const g = mmBg.getContext('2d');
    const grad = g.createRadialGradient(98, 98, 20, 98, 98, 150);
    grad.addColorStop(0, '#22301c');
    grad.addColorStop(0.72, '#1d2a18');
    grad.addColorStop(1, '#141d12');
    g.fillStyle = grad;
    g.fillRect(0, 0, 196, 196);
    // grass mottling
    for (let i = 0; i < 260; i++) {
      const v = Math.random();
      g.fillStyle = `rgba(${40 + v * 30 | 0},${60 + v * 34 | 0},${32 + v * 20 | 0},0.25)`;
      g.beginPath(); g.arc(Math.random() * 196, Math.random() * 196, 2 + Math.random() * 6, 0, 7); g.fill();
    }
    // roads toward center
    g.strokeStyle = 'rgba(90,92,104,0.8)'; g.lineWidth = 2.5;
    const k = 196 / (MAP.half * 2);
    for (const f of Object.values(sim().factions)) {
      const bx = (f.base.x + MAP.half) * k, bz = (f.base.z + MAP.half) * k;
      g.beginPath(); g.moveTo(bx, bz);
      g.lineTo(bx + (98 - bx) * 0.42, bz + (98 - bz) * 0.42);
      g.stroke();
      g.fillStyle = 'rgba(110,112,124,0.5)';
      g.beginPath(); g.arc(bx, bz, 8, 0, 7); g.fill();
    }
    return mmBg;
  }

  function drawMinimap() {
    const S = 196, k = S / (MAP.half * 2);
    mm.drawImage(minimapBg(), 0, 0);
    const px = (x) => (x + MAP.half) * k;
    const s2 = sim(), w = state.world;
    const fogOn = w.fogEnabled;
    // nodes (explored only)
    for (const n of s2.nodes) {
      if (n.amount <= 0 || (fogOn && !s2.expAt(n.x, n.z))) continue;
      mm.fillStyle = '#39d5ff';
      mm.fillRect(px(n.x) - 2, px(n.z) - 2, 4, 4);
    }
    for (const b of s2.buildings) {
      if (b.dead) continue;
      if (fogOn && b.faction !== s2.playerFaction && !b.seen) continue;
      mm.fillStyle = FACTIONS[b.faction].css;
      const sz = b.kind === 'hq' ? 7 : 4;
      mm.fillRect(px(b.x) - sz / 2, px(b.z) - sz / 2, sz, sz);
    }
    for (const u of s2.units) {
      if (u.dead) continue;
      if (fogOn && u.faction !== s2.playerFaction && !s2.visAt(u.x, u.z)) continue;
      mm.fillStyle = FACTIONS[u.faction].css;
      mm.fillRect(px(u.x) - 1, px(u.z) - 1, 2.4, 2.4);
    }
    // fog shroud
    if (fogOn) {
      const n = s2.fogN, cs = S / n;
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const idx = j * n + i;
        if (s2.visible[idx]) continue;
        mm.fillStyle = s2.explored[idx] ? 'rgba(5,8,14,0.45)' : 'rgba(4,6,11,0.88)';
        mm.fillRect(i * cs, j * cs, cs + 0.5, cs + 0.5);
      }
    }
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

  // ---------- guided first-game tutorial ----------
  const TUT_STEPS = [
    { text: 'Naciśnij 2, by zaznaczyć badaczy', done: () => [...state.selection].some(id => sim().units.find(u => u.id === id && u.kind === 'researcher')) },
    { text: 'Dwoma palcami tapnij świecący węzeł — wyślij ich po dane', done: () => sim().units.some(u => u.faction === sim().playerFaction && u.order.type === 'gather') },
    { text: 'Zbuduj Compute Cluster (menu budowy przy zaznaczonych badaczach)', done: () => sim().buildings.some(b => b.faction === sim().playerFaction && b.kind === 'datacenter') },
    { text: 'Zaznacz Frontier Lab i zatrudnij badacza', done: () => { const hq = sim().buildings.find(b => b.kind === 'hq' && b.faction === sim().playerFaction); return hq && (hq.queue.length > 0 || sim().researcherCount(sim().playerFaction) > 3); } },
    { text: 'Postaw Agent Foundry — przyda się obrona', done: () => sim().buildings.some(b => b.faction === sim().playerFaction && b.kind === 'foundry') },
    { text: 'Rozpocznij badanie kamienia milowego w Frontier Lab', done: () => me().researching || me().milestone > 0 },
  ];
  let tutStep = settings.tutorialDone ? -1 : 0;
  function updateTutorial() {
    const elT = el('tutorial');
    if (tutStep < 0) { elT.style.display = 'none'; return; }
    if (tutStep >= TUT_STEPS.length) {
      saveSettings({ tutorialDone: true });
      tutStep = -1;
      bigAlert('🎓 Samouczek ukończony — wygraj ten wyścig!', '#6ee787');
      elT.style.display = 'none';
      return;
    }
    if (TUT_STEPS[tutStep].done()) { state.audio?.play('coin', 0.5); tutStep++; return; }
    elT.style.display = 'block';
    const html = `<b>SAMOUCZEK ${tutStep + 1}/${TUT_STEPS.length}</b><br>${TUT_STEPS[tutStep].text}
      <button id="tutskip" class="act" style="margin-top:6px">pomiń</button>`;
    if (elT.__h !== html) {
      elT.__h = html;
      elT.innerHTML = html;
      el('tutskip').onclick = () => { saveSettings({ tutorialDone: true }); tutStep = -1; elT.style.display = 'none'; };
    }
  }

  const api = { update, applyEvents, refreshSelection, toggleHelp, setPaused, post, bigAlert };
  state.hud = api;
  post('Welcome. Scale responsibly — or don\'t.', f0.css);
  return api;
}

// ---------- faction select menu ----------
export function showMenu(onPick) {
  const hud = document.getElementById('hud');
  const last = settings.faction;
  const menu = document.createElement('div');
  menu.className = 'modal';
  menu.id = 'menu';
  menu.innerHTML = `
    <div class="menubox">
      <h1 class="title">SUPERINTELLIGENCE</h1>
      <p class="subtitle">Four labs. One finish line. Pick your allegiance in the race that decides everything.</p>
      <div class="menuopts">
        <label>Difficulty
          <select id="m-diff">${Object.entries(DIFFICULTY).map(([k, d]) => `<option value="${k}" ${settings.difficulty === k ? 'selected' : ''}>${d.name}</option>`).join('')}</select>
        </label>
        <label>Map
          <select id="m-map">${Object.entries(MAP_VARIANTS).map(([k, n]) => `<option value="${k}" ${settings.map === k ? 'selected' : ''}>${n}</option>`).join('')}</select>
        </label>
      </div>
      ${Object.keys(settings.achievements || {}).length ? `<p class="achrow">${ACHIEVEMENTS.filter(a => settings.achievements[a.id]).map(a => `<span title="${a.name} — ${a.desc}">${a.icon}</span>`).join(' ')}</p>` : ''}
      <div class="cards">
        ${Object.values(FACTIONS).map(f => `
          <div class="card ${last === f.id ? 'last' : ''}" data-fid="${f.id}" style="--c:${f.css}">
            ${last === f.id ? '<span class="lastbadge">LAST PLAYED</span>' : ''}
            <h2>${f.name}</h2>
            <p class="motto">“${f.motto}”</p>
            <p class="bonus"><b>${f.bonusName}</b> — ${f.bonusDesc}</p>
            <button>LEAD ${f.short}</button>
          </div>`).join('')}
      </div>
      <p class="hint">Two-finger scroll to pan · pinch to zoom · two-finger tap to command · H for the full guide</p>
    </div>`;
  hud.appendChild(menu);
  menu.querySelector('#m-diff').onchange = (e) => saveSettings({ difficulty: e.target.value });
  menu.querySelector('#m-map').onchange = (e) => saveSettings({ map: e.target.value });
  menu.querySelectorAll('.card').forEach(c => {
    c.onclick = () => {
      menu.remove();
      saveSettings({ faction: c.dataset.fid });
      onPick(c.dataset.fid);
    };
  });
}
