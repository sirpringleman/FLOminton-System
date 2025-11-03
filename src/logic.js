/* logic.js
   FLOminton Matchmaking (Merged Deluxe)

   Modes:
   - WINDOW: group quads by skill window (start ±2; expand only if courts can’t be filled)
   - BAND  : fixed bands {1–2, 3–4, 5–6, 7–8, 9–10}; allow band±1; expand further only if needed

   Team split in BOTH modes:
   - Choose the split with the smallest team-average difference among:
       (p1,p4) vs (p2,p3)
       (p1,p3) vs (p2,p4)
       (p1,p2) vs (p3,p4)

   Fairness (selection):
   - Select players by highest bench_count, then oldest last_played_round, then random
   - Hard guard: no one benches twice before everyone benches once
   - Avoid consecutive benches where possible

   Analytics (for Smart Summary & Diagnostics):
   - fairnessStats(playersPresent)
   - roundDiagnostics(matches)   -> build time, court use, avg diffs, spans
   - perPlayerUniq(history)      -> unique teammates/opponents per player
   - countBackToBackBenches(benchedLog)
*/

/* ========================= Tunables ========================= */
export const MATCH_MODES = { WINDOW: 'window', BAND: 'band' };

// Window mode settings
const START_SKILL_WINDOW = 2;      // max-min ≤ this to start; expand if needed
const MAX_SKILL_WINDOW   = 5;

// Band mode settings
const BANDS = [
  { min: 1, max: 2 },  // Band 1
  { min: 3, max: 4 },  // Band 2
  { min: 5, max: 6 },  // Band 3
  { min: 7, max: 8 },  // Band 4
  { min: 9, max: 10 }, // Band 5
];
const MAX_BAND_EXPANSION = 4;      // allow beyond ±1 only if courts would fail

// Rematch memory (bookkeeping only; doesn’t override fairness/skill constraints)
const REMATCH_MEMORY  = 4;

/* ========================= Mode persistence (optional) ========================= */
let __matchMode = safeGetLocal('flomatch_mode') || MATCH_MODES.WINDOW;
export function setMatchMode(mode) {
  __matchMode = (mode === MATCH_MODES.BAND) ? MATCH_MODES.BAND : MATCH_MODES.WINDOW;
  safeSetLocal('flomatch_mode', __matchMode);
}
export function getMatchMode() { return __matchMode; }
function safeGetLocal(k){ try{return localStorage.getItem(k);}catch{return null;} }
function safeSetLocal(k,v){ try{localStorage.setItem(k,v);}catch{} }

/* ========================= Utilities ========================= */
const by = (fn) => (a, b) => {
  const x = fn(a), y = fn(b);
  if (x < y) return -1;
  if (x > y) return 1;
  return 0;
};
export function avg(a){ return a.reduce((s,x)=>s+x,0)/(a.length||1); }
export function stddev(a){
  if(a.length<=1) return 0;
  const m=avg(a); const v=avg(a.map(x=>(x-m)*(x-m)));
  return Math.sqrt(v);
}
export function formatTime(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds || 0));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

/* ========================= Fairness selection ========================= */
/**
 * Select 4*courts players with fairness hard-guards.
 * @param {Array} present - [{id, name, skill_level, is_present, bench_count, last_played_round}]
 * @param {number} roundNumber
 * @param {Set<string>} lastRoundBenched
 * @param {number} courtsCount
 * @returns {{playing: Array, benched: Array}}
 */
export function selectPlayersForRound(present, roundNumber, lastRoundBenched = new Set(), courtsCount = 4) {
  const NEED = Math.min(present.length - (present.length % 4), courtsCount * 4);
  if (present.length < 4) return { playing: [], benched: present.slice() };
  if (NEED <= 0) return { playing: [], benched: present.slice() };

  // Priority: higher bench_count first; then older last_played_round; tie random
  const ranked = present.slice().sort((a, b) => {
    const t =
      (b.bench_count || 0) - (a.bench_count || 0) ||
      (a.last_played_round || 0) - (b.last_played_round || 0);
    if (t !== 0) return t;
    return Math.random() - 0.5;
  });

  // Hard guard: nobody benches twice before all bench once
  const minBench = Math.min(...present.map(p => p.bench_count || 0));
  const benchEligible = new Set(
    present.filter(p => (p.bench_count || 0) > minBench).map(p => p.id)
  );
  const avoidConsecutive = new Set(lastRoundBenched || []);

  const toBenchCount = Math.max(0, present.length - NEED);
  if (toBenchCount === 0) return { playing: ranked.slice(0, NEED), benched: [] };

  const reversed = ranked.slice().reverse();
  const bench = [];
  const pushIf = (pred) => {
    for (const p of reversed) {
      if (bench.length >= toBenchCount) break;
      if (bench.find(x => x.id === p.id)) continue;
      if (pred(p)) bench.push(p);
    }
  };
  // a) eligible & not consecutive
  pushIf(p => benchEligible.has(p.id) && !avoidConsecutive.has(p.id));
  // b) eligible (even if consecutive)
  pushIf(p => benchEligible.has(p.id));
  // c) not consecutive
  pushIf(p => !avoidConsecutive.has(p.id));
  // d) anyone
  pushIf(_ => true);

  // Try to swap to avoid consecutive benches if possible
  for (let i = 0; i < bench.length; i++) {
    const p = bench[i];
    if (avoidConsecutive.has(p.id)) {
      const swap = ranked.find(x =>
        !bench.find(b => b.id === x.id) && !avoidConsecutive.has(x.id)
      );
      if (swap) bench[i] = swap;
    }
  }

  const benchIds = new Set(bench.map(b => b.id));
  const playing = ranked.filter(p => !benchIds.has(p.id)).slice(0, NEED);
  return { playing, benched: bench };
}

/* ========================= Match building (Band & Window) ========================= */

export function buildMatchesFrom16(players, teammateHistory = new Map(), courtsCount = 4, mode = getMatchMode()) {
  if (!players || players.length < 4) return [];
  const sorted = players.slice().sort(by(p => p.skill_level));
  const totalCourts = Math.floor(sorted.length / 4);

  let groups = [];
  if (mode === MATCH_MODES.BAND) {
    groups = makeGroupsBand(sorted, totalCourts);
  } else {
    groups = makeGroupsWindow(sorted, totalCourts);
  }
  if (groups.length !== totalCourts) {
    // last resort: simple chunk (still sorted ⇒ skill-proximal)
    groups = [];
    for (let i=0; i<sorted.length && groups.length<totalCourts; i+=4){
      groups.push(sorted.slice(i, i+4));
    }
  }

  const matches = [];
  let courtNo = 1;
  for (const g of groups) {
    const quad = g.slice().sort(by(p => p.skill_level)); // [p1<=p2<=p3<=p4]
    const best = bestTeamSplit(quad); // {t1:[...], t2:[...], avg1, avg2}
    addPair(best.t1[0], best.t1[1], teammateHistory);
    addPair(best.t2[0], best.t2[1], teammateHistory);
    trimHistory(teammateHistory, REMATCH_MEMORY);

    matches.push({
      court: courtNo++,
      team1: best.t1,
      team2: best.t2,
      avg1: best.avg1,
      avg2: best.avg2,
    });
  }
  return matches;
}

function bestTeamSplit(quad){
  // quad sorted by skill asc: [p1,p2,p3,p4]
  const [a,b,c,d] = quad;
  const candidates = [
    [[a,d],[b,c]],
    [[a,c],[b,d]],
    [[a,b],[c,d]],
  ].map(([t1,t2])=>{
    const avg1=(t1[0].skill_level+t1[1].skill_level)/2;
    const avg2=(t2[0].skill_level+t2[1].skill_level)/2;
    return { t1, t2, avg1, avg2, diff: Math.abs(avg1-avg2) };
  });
  candidates.sort(by(x=>x.diff));
  return candidates[0];
}

// WINDOW MODE: group quads where (max-min) ≤ window; expand window only if needed
function makeGroupsWindow(sortedPlayers, courtCount) {
  for (let window = START_SKILL_WINDOW; window <= MAX_SKILL_WINDOW; window++) {
    const groups = greedyWindowGroups(sortedPlayers, courtCount, window);
    if (groups.length === courtCount) return groups;
  }
  return [];
}
function greedyWindowGroups(sortedPlayers, courtCount, window) {
  const used = new Set();
  const groups = [];

  for (let i = 0; i < sortedPlayers.length && groups.length < courtCount; i++) {
    if (used.has(i)) continue;

    const pickIdx = [i];
    const minSkill = sortedPlayers[i].skill_level;
    // try forward
    for (let j = i + 1; j < sortedPlayers.length && pickIdx.length < 4; j++) {
      if (used.has(j)) continue;
      const s = sortedPlayers[j].skill_level;
      if (s - minSkill <= window) pickIdx.push(j);
      else break;
    }
    // try from end (still respecting window)
    for (let j = sortedPlayers.length - 1; j > i && pickIdx.length < 4; j--) {
      if (used.has(j)) continue;
      const s = sortedPlayers[j].skill_level;
      if (s - minSkill <= window) pickIdx.push(j);
    }

    if (pickIdx.length >= 4) {
      pickIdx.sort((a,b)=>a-b);
      const quad = pickIdx.slice(0, 4).map(ix => sortedPlayers[ix]);
      for (const ix of pickIdx.slice(0,4)) used.add(ix);
      groups.push(quad);
    }
  }
  return groups;
}

// BAND MODE: assign band index; allow band±k; expand only if needed
function makeGroupsBand(sortedPlayers, courtCount) {
  const withBand = sortedPlayers.map(p => ({ ...p, _band: bandOf(p.skill_level) }));
  for (let bandWindow = 0; bandWindow <= MAX_BAND_EXPANSION; bandWindow++) {
    const groups = greedyBandGroups(withBand, courtCount, bandWindow);
    if (groups.length === courtCount) return groups;
  }
  return [];
}
function greedyBandGroups(playersWithBand, courtCount, bandWindow) {
  const used = new Set();
  const groups = [];

  for (let i = 0; i < playersWithBand.length && groups.length < courtCount; i++) {
    if (used.has(i)) continue;
    const root = playersWithBand[i];
    const minBand = root._band;

    const pickIdx = [i];
    for (let j = i + 1; j < playersWithBand.length && pickIdx.length < 4; j++) {
      if (used.has(j)) continue;
      const bj = playersWithBand[j]._band;
      if (Math.abs(bj - minBand) <= bandWindow) pickIdx.push(j);
      else if (bj - minBand > bandWindow) break;
    }
    for (let j = playersWithBand.length - 1; j > i && pickIdx.length < 4; j--) {
      if (used.has(j)) continue;
      const bj = playersWithBand[j]._band;
      if (Math.abs(bj - minBand) <= bandWindow) pickIdx.push(j);
    }
    if (pickIdx.length >= 4) {
      pickIdx.sort((a,b)=>a-b);
      const quad = pickIdx.slice(0, 4).map(ix => stripBand(playersWithBand[ix]));
      for (const ix of pickIdx.slice(0,4)) used.add(ix);
      groups.push(quad);
    }
  }
  return groups;
}
function bandOf(level) {
  for (let i = 0; i < BANDS.length; i++) {
    if (level >= BANDS[i].min && level <= BANDS[i].max) return i; // 0..4
  }
  if (level < BANDS[0].min) return 0;
  return BANDS.length - 1;
}
function stripBand(p) { const { _band, ...rest } = p; return rest; }

/* ========================= Rematch bookkeeping ========================= */
function pairKey(a, b) {
  const aId = a.id || String(a);
  const bId = b.id || String(b);
  return aId < bId ? `${aId}|${bId}` : `${bId}|${aId}`;
}
function addPair(a, b, map) {
  const k = pairKey(a, b);
  const entry = map.get(k) || [];
  entry.push(Date.now());
  map.set(k, entry);
}
function trimHistory(map, keep) {
  for (const [k, arr] of map.entries()) {
    if (arr.length > keep) map.set(k, arr.slice(arr.length - keep));
  }
}

/* ========================= Analytics helpers ========================= */

/** Basic fairness stats on current present set */
export function fairnessStats(present) {
  if (!present || !present.length) return { mean:0, stdev:0, spread:0, min:0, max:0 };
  const bc = present.map(p => p.bench_count || 0);
  return {
    mean: Number(avg(bc).toFixed(2)),
    stdev: Number(stddev(bc).toFixed(2)),
    spread: Math.max(...bc) - Math.min(...bc),
    min: Math.min(...bc),
    max: Math.max(...bc),
  };
}

/** Round diagnostics from built matches */
export function roundDiagnostics(matches, buildMs = 0) {
  if (!matches || !matches.length) return {
    buildMs, avgDiff: 0, diffs: [], usedCourts: 0, spans: []
  };
  const diffs = matches.map(m => Math.abs(m.avg1 - m.avg2));
  const spans = matches.map(m => {
    const s = [...m.team1, ...m.team2].map(p => p.skill_level).sort((a,b)=>a-b);
    return s[s.length-1] - s[0];
  });
  return {
    buildMs,
    avgDiff: Number(avg(diffs).toFixed(2)),
    diffs,
    usedCourts: matches.length,
    spans,
  };
}

/** Unique teammates/opponents per player from history: [{round, court, team1:[...], team2:[...]}...] */
export function perPlayerUniq(history, presentIds = new Set()) {
  const teamMates = new Map(); // id -> Set(ids)
  const opponents = new Map();
  const add = (map, id, peer) => {
    if (!map.has(id)) map.set(id, new Set());
    map.get(id).add(peer);
  };
  for (const h of history || []) {
    const t1 = h.team1 || []; const t2 = h.team2 || [];
    for (const a of t1) for (const b of t1) if (a.id !== b.id) add(teamMates, a.id, b.id);
    for (const a of t2) for (const b of t2) if (a.id !== b.id) add(teamMates, a.id, b.id);
    for (const a of t1) for (const b of t2) { add(opponents, a.id, b.id); add(opponents, b.id, a.id); }
  }
  const out = {};
  const allIds = presentIds.size ? [...presentIds] : Array.from(new Set(
    (history||[]).flatMap(h => [...(h.team1||[]), ...(h.team2||[])]).map(p => p.id)
  ));
  for (const id of allIds) {
    out[id] = {
      uniqTeammates: (teamMates.get(id)?.size || 0),
      uniqOpponents: (opponents.get(id)?.size || 0),
    };
  }
  return out;
}

/** Count back-to-back bench streaks from an array of round benches: [{round, ids:Set()}] */
export function countBackToBackBenches(benchedSequence) {
  // returns map id -> { worst: n, count: nLatest }
  const worst = new Map();
  const cur = new Map();
  for (const step of (benchedSequence || [])) {
    const ids = step.ids || new Set();
    // increment streak for those benched now; reset others
    const allIds = new Set([...cur.keys(), ...ids]);
    for (const id of allIds) {
      const was = cur.get(id) || 0;
      const now = ids.has(id) ? was + 1 : 0;
      cur.set(id, now);
      worst.set(id, Math.max(worst.get(id) || 0, now));
    }
  }
  const out = {};
  for (const [id, w] of worst.entries()) out[id] = w;
  return out;
}
