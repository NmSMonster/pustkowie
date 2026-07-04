# SUPERINTELLIGENCE — an RTS about the AI race

A browser-based, bird's-eye real-time strategy game where **OpenAI, Anthropic,
Google DeepMind and xAI** race to be first to superintelligence. Age of
Empires bones, but every mechanic is drawn from what frontier labs actually
compete over: **compute, data, talent, government favor and public trust**.

## Run it

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

No build step. Plain ES modules + Three.js from `lib/`.

## The metaphor, made mechanical

| RTS concept | In this game |
|---|---|
| Gold mine | **Datastream nodes** — researchers scrape them; they run dry mid-game, forcing a fight for the center or a pivot to Synthetic Data Plants |
| Town center | **Frontier Lab** — trains researchers, runs milestone research; lose it and your lab folds |
| Economy | **Compute** from Compute Clusters, **Data** from nodes, **Talent** cap from Campuses, **Favor** from the Policy Office |
| Tech tree | **5 frontier milestones**: Foundation Model → Reasoning → Autonomous Agents → Recursive Self-Improvement → **SUPERINTELLIGENCE** |
| Win condition | First lab to finish the final training run wins — everyone is warned when it starts, and damaging their HQ pauses it |
| Army | **Agents** (melee cyber-raiders) and **Sentinels** (ranged security), countered by **Firewall Towers** |
| Diplomacy screen | **Trust** (public perception): high trust speeds research, low trust brings regulatory fines. Poaching, probes and raids all cost trust |
| Spells | **Poach Talent** (steal a rival researcher), **Regulatory Probe** (halve a rival's compute), **State Subsidy**, **PR Campaign** |
| Diplomacy | **Non-aggression pacts** (+0.6⚡/s shared infra each) — trailing labs form coalitions against the leader, offer you deals mid-game, and **betray** partners who get too close to winning. Betrayal costs trust and earns a long grudge |
| Random events | **World events** hit everyone at once: Chip Export Ban, Open-Source Leak, AI Winter Scare, VC Frenzy, Congressional Hearing, Solar Flare |
| Fog of war | The map hides until scouted; discovered enemy buildings stay on the map, units vanish back into the dark. **Infiltrate** plants a 30s mole revealing a rival's base and books |
| Unit counters | Agents (melee) beat Sentinels up close · Sentinels outrange **Interceptors** · Interceptors EMP Agents (2.2×, slow) |
| Data sourcing | **Web Scrape** (+150 data, −10 trust) vs **Licensed Data** (+150 data, costs compute, +trust) |
| Setup | **Difficulty** (Easy/Normal/Hard, plus **Insane** unlocked at account level 5) and **three map scripts** (Classic Crossfire, Scarce Center, Data Ring) picked in the menu |
| Meta | **8 achievements** persisted across runs, end-of-match **race chart**, defeat **replay** of the final seconds, guided **tutorial** on first launch, **Ctrl+1–9 control groups** |
| Career | A persistent **lab career**: every match awards **XP** (win, milestones, kills, achievements, scaled by difficulty) toward **10 account levels** with titles from *Intern* to *Architect of Superintelligence*. Levels unlock **faction skins** (Neon, Stealth, Gilded), **Spectate mode**, and **Insane** difficulty. Per-faction **mastery stars** track wins. All stored locally |

Each faction plays to its reputation: OpenAI *Blitzscale* (+compute, faster
research, eroding trust), Anthropic *Constitutional* (trust floor + high-trust
research bonus), DeepMind *TPU Empire* (cheap buildings, richer nodes), xAI
*Ship It* (fast training, harder-hitting agents, bleeding trust).

The three rival labs are driven by utility AIs with personality weights —
they expand, tech, defend, raid the race leader, poach your researchers and
call the regulators on whoever's winning.

## Controls (trackpad-first)

- **Two-finger scroll** — pan · **pinch** — zoom · **Q/E** — rotate
- **Click / drag** — select · **two-finger tap** (right-click) — contextual order
- **1 / 2** — select army / researchers · **F** — jump to base · **H** — in-game guide · **P** — pause
- **[ / ]** — game speed (0.5×–3×, also in the top bar) · **Space** — jump to the latest alert
- **Click an event in the feed** — snap the camera to where it happened

## Accessibility & comfort

Settings (⚙) include a **colorblind-safe faction palette**, **reduce motion & effects**
(damps screen shake and heavy particles), and an **HUD scale** slider — all saved locally.

## Architecture

- `src/sim/` — pure fixed-timestep simulation (no rendering imports); testable headless: `node tools/simtest.mjs 30 7`
- `src/render/` — Three.js world that mirrors sim state; skeletal animation, dramatic lighting, shadows, effects; auto quality scaling
- `src/ui/` — overlay HUD, race panel, minimap, guide, menus
- `src/input.js` / `src/audio.js` — trackpad-first controls; WebAudio SFX driven by sim events
- `src/settings.js` — persistent settings (volumes, graphics quality, last faction) in localStorage

Rendering — the full AAA-style pipeline:
**post**: GTAO ambient occlusion (FX-aware), selection outlines, bloom,
tilt-shift depth of field, screen-space god rays, camera motion blur
(afterimage), filmic grade with S-curve, teal/orange split-toning,
chromatic aberration, animated film grain and vignette, lens flare with
ghosting — all on an MSAA HDR target.
**lighting**: sunset HDRI image-based lighting, camera-following tight
shadow frustum for crisp shadows, pooled dynamic point lights on
explosions and zaps, a living day-night cycle (lab windows, street lamps,
blinking antenna beacons, fireflies, starfield).
**world**: animated water ponds in the backdrop hills, service roads with
lane markings, solar panels and antenna masts at every base, drifting
clouds with moving ground shadows, weather fronts (rain + closing fog),
morning mist after dawn, wind-swaying grass and foliage, bump-mapped
terrain, trampled paths, instanced rocks.
**gameplay feel**: batched particle pools (sparks/dust in 2 draw calls),
dust under running feet, scorch decals that linger after explosions,
double-layer tracers, ragdoll-lite deaths (hop, spin, topple), screen
shake, construction scaffolding, milestone kill-cam with letterbox bars,
distance-based animation LOD. Three quality tiers auto-scale for weak
GPUs (or force in ⚙ settings).

All 3D models, sound effects and music are real, downloaded, CC-licensed
assets — see [ATTRIBUTION.md](ATTRIBUTION.md).
