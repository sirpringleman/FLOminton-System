/* logic.js
   FLOminton Matchmaking

   Modes:
   - WINDOW: group quads by skill window (start ±2; expand only if courts can’t be filled)
   - BAND  : fixed bands {1–2, 3–4, 5–6, 7–8, 9–10}; allow band±1; expand further only if needed

   Team split in BOTH modes:
   - Balanced pairing: weak+high vs weak+high (p1,p4) vs (p2,p3)

   Fairness (tiered):
   Tier 1 (always): sort by bench_count, then last_played_round, add small debt for “benched last round”
   Tier 2 (conditional): players whose bench_count is noticeably above session avg are forced into PLAY for this round
   Tier 3 (gentle): grouping functions allow a +1 window/band for those forced players so they can actually be placed

   Extra (this version):
   - Bench tolerance tightened to 0.5
   - If bench std dev is high, we temporarily relax band/window (fairnessPressure)
   - We keep a tiny per-player bias in localStorage so repeat-benched players get nudged up next round
*/

export const MATCH_MODES = { WINDOW: 'window', BAND: 'band' };

/* ========================= Tunables ========================= */

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

// Fairness guards
const MAX_CONSECUTIVE_BENCH = 1;
// tighter now: if you’re 0.5 benches above average, we try to force you in
const FAIRNESS_LAG_TOLERANCE = 0.5;

// bench-bias persistence
const BIAS_KEY = 'flominton_bench_bias_v1';
const MAX_BIAS = 0.8;               // cap how much boost someone can accumulate
const DECAY_PLAY  = 0.15;           // how much to reduce bias when someone plays
const BOOST_BENCH = 0.25;           // how much to increase bias when someone benches

/* ========================= Mode + pressure storage ========================= */
let currentMode = safeGetLocal('match_mode') || MATCH_MODES.WINDOW;

// fairnessPressure is set during selectPlayersForRound (when we detect bench spread)
// and read later during grouping to allow slightly wider bands/windows
let fairnessPressure = 0;           // 0 = normal, 1 = slightly loosen, 2 = loosen more
let fairnessPressureRounds = 0;     // countdown for how long to keep it

export function setMatchMode(mode) {
  currentMode = mode === MATCH_MODES.BAND ? MATCH_MODES.BAND : MATCH_MODES.WINDOW;
  safeSetLocal('match_mode', currentMode);
}
export function getMatchMode() {
  return currentMode;
}

function safeGetLocal(k) {
  try { return localStorage.getItem(k); } catch { return null; }
}
function safeSetLocal(k, v) {
  try { localStorage.setItem(k, v); } catch {}
}

/* ========================= bias helpers ========================= */
function loadBiasMap() {
  try {
    const raw = localStorage.getItem(BIAS_KEY);
    if (!raw) return {};
    return JSON.parse(raw) || {};
  } catch {
    return {};
  }
}
function saveBiasMap(map) {
  try {
    localStorage.setItem(BIAS_KEY, JSON.stringify(map));
  } catch {}
}

/* ========================= Utilities ========================= */
const by = (fn) => (a, b) => {
  const x = fn(a), y = fn(b);
  if (x < y) return -1;
  if (x > y) return 1;
  return 0;
};
function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
function stddev(arr) {
  if (!arr.length) return 0;
  const mean = arr.reduce((s, x) => s + x, 0) / arr.length;
  const v = arr.reduce((s, x) => s + (x - mean) * (x - mean), 0) / arr.length;
  return Math.sqrt(v);
}

/* ========================= Public API ========================= */

/**
 * Select 4*courts players with fairness hard-guards.
 * Tiered fairness is applied here.
 *
 * @param {Array} present - [{id, name, skill_level, is_present, bench_count, last_played_round}]
 * @param {number} roundNumber
 * @param {Set<string>} lastRoundBenched
 * @param {number} courtsCount
 * @returns {{playing: Array, benched: Array}}
 */
export function selectPlayersForRound(
  present,
  roundNumber,
  lastRoundBenched = new Set(),
  courtsCount = 4
) {
  const total = present.length;
  if (total < 4) return { playing: [], benched: present.slice() };

  const maxSlots = courtsCount * 4;
  const NEED = Math.min(total - (total % 4), maxSlots);
  if (NEED <= 0) return { playing: [], benched: present.slice() };

  const biasMap = loadBiasMap();

  // ---- Tier 1: base fairness ordering ----
  // IMPORTANT: sort DESC by (bench_count + debt + bias)
  const ranked = present.slice().sort((a, b) => {
    const benchA = a.bench_count || 0;
    const benchB = b.bench_count || 0;
    const debtA  = lastRoundBenched?.has(a.id) ? 0.5 : 0;
    const debtB  = lastRoundBenched?.has(b.id) ? 0.5 : 0;
    const biasA  = biasMap[a.id] || 0;
    const biasB  = biasMap[b.id] || 0;
    const scoreA = benchA + debtA + biasA;
    const scoreB = benchB + debtB + biasB;

    // higher score (more benched) should come FIRST
    if (scoreA !== scoreB) return scoreB - scoreA;

    const lpa = a.last_played_round || 0;
    const lpb = b.last_played_round || 0;
    // older last_played_round should come first
    if (lpa !== lpb) return lpa - lpb;

    return Math.random() - 0.5;
  });

  // average bench to detect lagging players
  const benchCounts = present.map(p => p.bench_count || 0);
  const avgBench = benchCounts.reduce((s, x) => s + x, 0) / benchCounts.length;
  const sdBench = stddev(benchCounts);

  // ---- dynamic skill expansion trigger ----
  // if fairness is getting worse, relax for the next 2 rounds
  if (sdBench > 2.0) {
    fairnessPressure = 2;
    fairnessPressureRounds = 2;
  } else if (sdBench > 1.5) {
    fairnessPressure = 1;
    fairnessPressureRounds = 1;
  } else {
    // if it’s good, decay existing pressure
    if (fairnessPressureRounds > 0) {
      fairnessPressureRounds -= 1;
      if (fairnessPressureRounds <= 0) {
        fairnessPressure = 0;
      }
    } else {
      fairnessPressure = 0;
    }
  }

  // ---- Tier 2: force-in players who are clearly behind ----
  const laggingIds = new Set(
    present
      .filter(p => (p.bench_count || 0) > avgBench + FAIRNESS_LAG_TOLERANCE)
      .map(p => p.id)
  );

  const playing = [];
  for (const p of ranked) {
    if (laggingIds.has(p.id) && playing.length < NEED) {
      p._mustPlay = true;
      playing.push(p);
    }
  }
  for (const p of ranked) {
    if (playing.length >= NEED) break;
    if (!playing.find(x => x.id === p.id)) {
      playing.push(p);
    }
  }

  const playingIds = new Set(playing.map(p => p.id));
  const benched = present.filter(p => !playingIds.has(p.id));

  // ---- avoid consecutive benches where possible ----
  if (benched.length > 0 && MAX_CONSECUTIVE_BENCH > 0 && lastRoundBenched && lastRoundBenched.size > 0) {
    for (let i = 0; i < benched.length; i++) {
      const b = benched[i];
      if (lastRoundBenched.has(b.id)) {
        const swap = playing.find(p =>
          !laggingIds.has(p.id) &&
          !lastRoundBenched.has(p.id)
        );
        if (swap) {
          benched[i] = swap;
          const idx = playing.findIndex(x => x.id === swap.id);
          playing[idx] = b;
          playingIds.delete(swap.id);
          playingIds.add(b.id);
        }
      }
    }
  }

  // ---- micro bench quota equalizer (persisted) ----
  // bump benched players, decay playing players
  for (const p of benched) {
    const cur = biasMap[p.id] || 0;
    const next = Math.min(MAX_BIAS, cur + BOOST_BENCH);
    biasMap[p.id] = next;
  }
  for (const p of playing) {
    const cur = biasMap[p.id] || 0;
    const next = Math.max(0, cur - DECAY_PLAY);
    if (next === 0) {
      delete biasMap[p.id];
    } else {
      biasMap[p.id] = next;
    }
  }
  saveBiasMap(biasMap);

  return { playing, benched };
}

/**
 * Build matches from selected players using the active mode.
 * Players with _mustPlay=true are allowed a slightly wider band/window during grouping.
 * We also respect fairnessPressure coming from the selector.
 *
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
    groups = makeGroupsBand(sorted, totalCourts, fairnessPressure);
  } else {
    groups = makeGroupsWindow(sorted, totalCourts, fairnessPressure);
  }

  // if grouping couldn’t make all courts, fall back to a chunk that
  // puts _mustPlay players first, so debt players actually get a court.
  if (groups.length !== totalCourts) {
    const prioritized = players
      .slice()
      .sort((a, b) => {
        const am = a._mustPlay ? -1 : 0;
        const bm = b._mustPlay ? -1 : 0;
        if (am !== bm) return am - bm;    // mustPlay first
        return a.skill_level - b.skill_level; // then skill
      });
    groups = chunk(prioritized, 4).slice(0, totalCourts);
  }

  const matches = [];
  let courtNo = 1;

  for (const g of groups) {
    const quad = g.slice().sort(by(p => p.skill_level));
    const team1 = [quad[0], quad[3]];
    const team2 = [quad[1], quad[2]];

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

// WINDOW MODE
function makeGroupsWindow(sortedPlayers, courtCount, pressure = 0) {
  const extra = Math.min(pressure, 2); // don’t blow it out
  for (let window = START_SKILL_WINDOW; window <= MAX_SKILL_WINDOW + extra; window++) {
    const groups = greedyWindowGroups(sortedPlayers, courtCount, window, extra);
    if (groups.length === courtCount) return groups;
  }
  return [];
}

function greedyWindowGroups(sortedPlayers, courtCount, window, pressureExtra = 0) {
  const used = new Set();
  const groups = [];

  for (let i = 0; i < sortedPlayers.length && groups.length < courtCount; i++) {
    if (used.has(i)) continue;

    const root = sortedPlayers[i];
    const minSkill = root.skill_level;
    const pickIdx = [i];

    // forward
    for (let j = i + 1; j < sortedPlayers.length && pickIdx.length < 4; j++) {
      if (used.has(j)) continue;
      if (pickIdx.includes(j)) continue;
      const candidate = sortedPlayers[j];
      const s = candidate.skill_level;
      const allowExtra = root._mustPlay || candidate._mustPlay;
      if (s - minSkill <= window + (allowExtra ? 1 : 0)) {
        pickIdx.push(j);
      } else if (pressureExtra > 0 && s - minSkill <= window + pressureExtra) {
        pickIdx.push(j);
      } else {
        break;
      }
    }
    // backward
    for (let j = sortedPlayers.length - 1; j > i && pickIdx.length < 4; j--) {
      if (used.has(j)) continue;
      if (pickIdx.includes(j)) continue;
      const candidate = sortedPlayers[j];
      const s = candidate.skill_level;
      const allowExtra = root._mustPlay || candidate._mustPlay;
      if (s - minSkill <= window + (allowExtra ? 1 : 0)) {
        pickIdx.push(j);
      } else if (pressureExtra > 0 && s - minSkill <= window + pressureExtra) {
        pickIdx.push(j);
      }
    }

    if (pickIdx.length >= 4) {
      pickIdx.sort((a, b) => a - b);
      const quad = pickIdx.slice(0, 4).map(ix => sortedPlayers[ix]);
      for (const ix of pickIdx.slice(0, 4)) used.add(ix);
      groups.push(quad);
    }
  }

  return groups;
}

// BAND MODE
function makeGroupsBand(sortedPlayers, courtCount, pressure = 0) {
  const withBand = sortedPlayers.map(p => ({ ...p, _band: bandOf(p.skill_level) }));
  const extra = Math.min(pressure, 2);
  for (let bandWindow = 0; bandWindow <= MAX_BAND_EXPANSION + extra; bandWindow++) {
    const groups = greedyBandGroups(withBand, courtCount, bandWindow, extra);
    if (groups.length === courtCount) return groups;
  }
  return [];
}

function greedyBandGroups(playersWithBand, courtCount, bandWindow, pressureExtra = 0) {
  const used = new Set();
  const groups = [];

  for (let i = 0; i < playersWithBand.length && groups.length < courtCount; i++) {
    if (used.has(i)) continue;
    const root = playersWithBand[i];
    const minBand = root._band;

    const pickIdx = [i];

    // forward
    for (let j = i + 1; j < playersWithBand.length && pickIdx.length < 4; j++) {
      if (used.has(j)) continue;
      if (pickIdx.includes(j)) continue;
      const candidate = playersWithBand[j];
      const bj = candidate._band;
      const allowExtra = root._mustPlay || candidate._mustPlay;
      if (Math.abs(bj - minBand) <= bandWindow + (allowExtra ? 1 : 0)) {
        pickIdx.push(j);
      } else if (pressureExtra > 0 && Math.abs(bj - minBand) <= bandWindow + pressureExtra) {
        pickIdx.push(j);
      } else if (bj - minBand > bandWindow + 1) {
        break;
      }
    }
    // backward
    for (let j = playersWithBand.length - 1; j > i && pickIdx.length < 4; j--) {
      if (used.has(j)) continue;
      if (pickIdx.includes(j)) continue;
      const candidate = playersWithBand[j];
      const bj = candidate._band;
      const allowExtra = root._mustPlay || candidate._mustPlay;
      if (Math.abs(bj - minBand) <= bandWindow + (allowExtra ? 1 : 0)) {
        pickIdx.push(j);
      } else if (pressureExtra > 0 && Math.abs(bj - minBand) <= bandWindow + pressureExtra) {
        pickIdx.push(j);
      }
    }

    if (pickIdx.length >= 4) {
      pickIdx.sort((a, b) => a - b);
      const quad = pickIdx.slice(0, 4).map(ix => stripBand(playersWithBand[ix]));
      for (const ix of pickIdx.slice(0, 4)) used.add(ix);
      groups.push(quad);
    }
  }

  return groups;
}

function bandOf(level) {
  for (let i = 0; i < BANDS.length; i++) {
    if (level >= BANDS[i].min && level <= BANDS[i].max) return i;
  }
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
