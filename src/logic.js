/* logic.js
   FLOminton Matchmaking

   Modes:
   - WINDOW: group quads by skill window (start ±2; expand only if courts can’t be filled)
   - BAND  : fixed bands {1–2, 3–4, 5–6, 7–8, 9–10}; allow band±1; expand further only if needed

   Team split in BOTH modes:
   - Balanced pairing: weak+high vs weak+high (p1,p4) vs (p2,p3)

   Fairness (both modes):
   - Select players by highest bench_count, then oldest last_played_round, then random
   - Hard guard: no one benches twice before everyone benches once
   - Avoid consecutive benches where possible
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

// Rematch memory (soft nudge only; doesn’t override fairness/skill constraints)
const REMATCH_MEMORY  = 4;
const REMATCH_PENALTY = 1;

// Fairness guard
const MAX_CONSECUTIVE_BENCH = 1;

/* ========================= Mode storage ========================= */
let currentMode = safeGetLocal('match_mode') || MATCH_MODES.WINDOW;

export function setMatchMode(mode) {
  currentMode = mode === MATCH_MODES.BAND ? MATCH_MODES.BAND : MATCH_MODES.WINDOW;
  safeSetLocal('match_mode', currentMode);
}
export function getMatchMode() {
  return currentMode;
}

function safeGetLocal(k) { try { return localStorage.getItem(k); } catch { return null; } }
function safeSetLocal(k, v) { try { localStorage.setItem(k, v); } catch {} }

/* ========================= Utilities ========================= */
const by = (fn) => (a, b) => {
  const x = fn(a), y = fn(b);
  if (x < y) return -1;
  if (x > y) return 1;
  return 0;
};
const shuffle = (arr) => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/* ========================= Public API ========================= */

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

  // Fairness priority: higher bench_count first; then older last_played_round; tie random
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

  // Build bench from the bottom of priority while respecting eligibility/avoid-consecutive
  const reversed = ranked.slice().reverse();
  const bench = [];

  const tryBench = (pred) => {
    for (const p of reversed) {
      if (bench.length >= toBenchCount) break;
      if (bench.find(x => x.id === p.id)) continue;
      if (pred(p)) bench.push(p);
    }
  };

  // a) eligible & not consecutive
  tryBench(p => benchEligible.has(p.id) && !avoidConsecutive.has(p.id));
  // b) eligible (even if consecutive)
  tryBench(p => benchEligible.has(p.id));
  // c) not consecutive
  tryBench(p => !avoidConsecutive.has(p.id));
  // d) anyone
  tryBench(_ => true);

  // Try to swap to avoid consecutive benches if possible
  if (MAX_CONSECUTIVE_BENCH > 0) {
    for (let i = 0; i < bench.length; i++) {
      const p = bench[i];
      if (avoidConsecutive.has(p.id)) {
        const swap = ranked.find(x =>
          !bench.find(b => b.id === x.id) && !avoidConsecutive.has(x.id)
        );
        if (swap) bench[i] = swap;
      }
    }
  }

  const benchIds = new Set(bench.map(b => b.id));
  const playing = ranked.filter(p => !benchIds.has(p.id)).slice(0, NEED);
  return { playing, benched: bench };
}

/**
 * Build matches from selected players using the active mode.
 * @param {Array} players - length divisible by 4
 * @param {Map<string, Array<number>>} teammateHistory
 * @param {number} courtsCount
 * @returns {Array} matches [{court, team1:[p,p], team2:[p,p], avg1, avg2}]
 */
export function buildMatchesFrom16(players, teammateHistory = new Map(), courtsCount = 4) {
  if (!players || players.length < 4) return [];
  const sorted = players.slice().sort(by(p => p.skill_level));
  const totalCourts = Math.floor(sorted.length / 4);

  let groups = [];
  if (currentMode === MATCH_MODES.BAND) {
    groups = makeGroupsBand(sorted, totalCourts);
  } else {
    groups = makeGroupsWindow(sorted, totalCourts);
  }
  if (groups.length !== totalCourts) {
    // last resort: simple chunk (still sorted ⇒ skill-proximal)
    groups = chunk(sorted, 4).slice(0, totalCourts);
  }

  // Build matches with BALANCED PAIRING: (p1,p4) vs (p2,p3)
  const matches = [];
  let courtNo = 1;

  for (const g of groups) {
    const quad = g.slice().sort(by(p => p.skill_level)); // [p1<=p2<=p3<=p4]
    const team1 = [quad[0], quad[3]];
    const team2 = [quad[1], quad[2]];

    // Optional tiny rematch penalty bookkeeping (doesn’t affect pairing choice here)
    addPair(team1[0], team1[1], teammateHistory);
    addPair(team2[0], team2[1], teammateHistory);
    trimHistory(teammateHistory, REMATCH_MEMORY);

    matches.push({
      court: courtNo++,
      team1,
      team2,
      avg1: (team1[0].skill_level + team1[1].skill_level) / 2,
      avg2: (team2[0].skill_level + team2[1].skill_level) / 2,
    });
  }

  return matches;
}

/* ========================= Grouping algorithms ========================= */

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

    // try to pick 4 within window from i outward
    const pickIdx = [i];
    const minSkill = sortedPlayers[i].skill_level;
    for (let j = i + 1; j < sortedPlayers.length && pickIdx.length < 4; j++) {
      if (used.has(j)) continue;
      const s = sortedPlayers[j].skill_level;
      if (s - minSkill <= window) pickIdx.push(j);
      else break;
    }
    // if not enough, try to pull from end while respecting window
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

// BAND MODE: assign band index; allow band±1; expand band window only if needed
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

    // collect candidates whose band ∈ [minBand - bandWindow, minBand + bandWindow]
    const pickIdx = [i];
    for (let j = i + 1; j < playersWithBand.length && pickIdx.length < 4; j++) {
      if (used.has(j)) continue;
      const bj = playersWithBand[j]._band;
      if (Math.abs(bj - minBand) <= bandWindow) pickIdx.push(j);
      else if (bj - minBand > bandWindow) break; // too far to the right
    }
    // try from the end as well
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
  // clamp out-of-range
  if (level < BANDS[0].min) return 0;
  return BANDS.length - 1;
}
function stripBand(p) {
  const { _band, ...rest } = p;
  return rest;
}

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
function pairPenalty(a, b, map) {
  const entry = map.get(pairKey(a, b));
  if (!entry || entry.length === 0) return 0;
  return Math.min(3, entry.length) * REMATCH_PENALTY;
}

/* ========================= Timer util (used by App.jsx) ========================= */
export function formatTime(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds || 0));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}
