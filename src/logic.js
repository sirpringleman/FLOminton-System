/*
  logic.js
  FLOminton matchmaking core

  Modes:
  - WINDOW: try to form quads where (max skill - min skill) <= window, expand gradually
  - BAND: fixed bands (1–2, 3–4, 5–6, 7–8, 9–10), allow adjacent bands, expand if needed

  Fairness:
  - we pick who plays first, then we split into quads
  - priority: higher bench debt first, then lower last_played_round, then random
  - hard-ish guard: try not to bench same person twice while others haven’t benched

  Team split (both modes):
  - sort quad ascending by skill → [p1, p2, p3, p4]
  - team1 = [p1, p4], team2 = [p2, p3]
  - this makes averages closer when quad has spread
*/

export const MATCH_MODES = {
  WINDOW: 'window',
  BAND: 'band',
};

/* ---------- band definition ---------- */
const BANDS = [
  { min: 1, max: 2 },
  { min: 3, max: 4 },
  { min: 5, max: 6 },
  { min: 7, max: 8 },
  { min: 9, max: 10 },
];

const START_SKILL_WINDOW = 2;
const MAX_SKILL_WINDOW = 5;
const MAX_BAND_EXPANSION = 4;

const REMATCH_MEMORY = 4; // not heavily used right now
const MAX_CONSECUTIVE_BENCH = 1;

/* ---------- local storage for mode ---------- */
function safeGetLocal(k) {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function safeSetLocal(k, v) {
  try {
    localStorage.setItem(k, v);
  } catch {}
}

let currentMode = safeGetLocal('match_mode') || MATCH_MODES.WINDOW;

export function setMatchMode(mode) {
  currentMode = mode === MATCH_MODES.BAND ? MATCH_MODES.BAND : MATCH_MODES.WINDOW;
  safeSetLocal('match_mode', currentMode);
}

export function getMatchMode() {
  return currentMode;
}

/* ---------- utils ---------- */
const by = (fn) => (a, b) => {
  const x = fn(a),
    y = fn(b);
  if (x < y) return -1;
  if (x > y) return 1;
  return 0;
};

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

/* =========================================================
   SELECT PLAYERS FOR ROUND
   ========================================================= */
/**
 * present: [{id, name, skill_level, is_present, bench_count, last_played_round}]
 * roundNumber: number
 * lastRoundBenched: Set<id>
 * courtsCount: number
 * benchDebt: { [playerId]: number }
 */
export function selectPlayersForRound(
  present,
  roundNumber,
  lastRoundBenched = new Set(),
  courtsCount = 4,
  benchDebt = {}
) {
  // how many can we actually seat
  const maxSeats = courtsCount * 4;
  if (!present || present.length === 0) {
    return { playing: [], benched: [] };
  }

  // we only want multiples of 4
  const totalPlayers = present.length;
  const playingCount = Math.min(maxSeats, totalPlayers - (totalPlayers % 4));
  const benchCount = Math.max(0, totalPlayers - playingCount);

  // sort present by fairness:
  // 1) higher bench debt first
  // 2) lower last_played_round (older) first
  // 3) random tiebreak
  const ranked = present.slice().sort((a, b) => {
    const debtA = benchDebt[a.id] || 0;
    const debtB = benchDebt[b.id] || 0;
    if (debtA !== debtB) return debtB - debtA;
    const lpA = a.last_played_round || 0;
    const lpB = b.last_played_round || 0;
    if (lpA !== lpB) return lpA - lpB;
    return Math.random() - 0.5;
  });

  if (benchCount === 0) {
    return {
      playing: ranked.slice(0, playingCount),
      benched: [],
    };
  }

  // we need to bench "benchCount" players, but we should try
  // not to bench the same that were benched last time
  const reversed = ranked.slice().reverse(); // lowest priority at end
  const benched = [];

  // Pass 1: bench people who were NOT benched last round
  for (const p of reversed) {
    if (benched.length >= benchCount) break;
    if (!lastRoundBenched.has(p.id)) {
      benched.push(p);
    }
  }
  // Pass 2: if still need benches, allow consecutive benches
  if (benched.length < benchCount) {
    for (const p of reversed) {
      if (benched.length >= benchCount) break;
      if (!benched.find((b) => b.id === p.id)) {
        benched.push(p);
      }
    }
  }

  const benchedIds = new Set(benched.map((b) => b.id));
  const playing = ranked.filter((p) => !benchedIds.has(p.id)).slice(0, playingCount);

  return { playing, benched };
}

/* =========================================================
   BUILD MATCHES FROM SELECTED PLAYERS
   ========================================================= */
export function buildMatchesFrom16(
  players,
  teammateHistory = new Map(),
  courtsCount = 4,
  mode = currentMode
) {
  if (!players || players.length < 4) return [];
  const sorted = players.slice().sort(by((p) => p.skill_level));
  const totalCourts = Math.min(courtsCount, Math.floor(sorted.length / 4));
  if (totalCourts <= 0) return [];

  let groups;
  if (mode === MATCH_MODES.BAND) {
    groups = makeGroupsBand(sorted, totalCourts);
  } else {
    groups = makeGroupsWindow(sorted, totalCourts);
  }

  if (!groups || groups.length !== totalCourts) {
    // fallback
    groups = chunk(sorted, 4).slice(0, totalCourts);
  }

  const matches = [];
  let courtNo = 1;
  for (const g of groups) {
    const quad = g.slice().sort(by((p) => p.skill_level));
    if (quad.length < 4) continue;
    const team1 = [quad[0], quad[3]];
    const team2 = [quad[1], quad[2]];

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

/* =========================================================
   WINDOW GROUPING
   ========================================================= */
function makeGroupsWindow(sortedPlayers, courtCount) {
  for (let w = START_SKILL_WINDOW; w <= MAX_SKILL_WINDOW; w++) {
    const groups = greedyWindowGroups(sortedPlayers, courtCount, w);
    if (groups.length === courtCount) return groups;
  }
  return [];
}

function greedyWindowGroups(sortedPlayers, courtCount, window) {
  const used = new Set();
  const groups = [];

  for (let i = 0; i < sortedPlayers.length && groups.length < courtCount; i++) {
    if (used.has(i)) continue;
    const root = sortedPlayers[i];
    const minSkill = root.skill_level;
    const picked = [i];

    // try forward
    for (let j = i + 1; j < sortedPlayers.length && picked.length < 4; j++) {
      if (used.has(j)) continue;
      const s = sortedPlayers[j].skill_level;
      if (s - minSkill <= window) {
        picked.push(j);
      } else {
        break;
      }
    }
    // try backward (from end)
    for (let j = sortedPlayers.length - 1; j > i && picked.length < 4; j--) {
      if (used.has(j)) continue;
      const s = sortedPlayers[j].skill_level;
      if (s - minSkill <= window) {
        picked.push(j);
      }
    }

    if (picked.length >= 4) {
      picked.sort((a, b) => a - b);
      const quad = picked.slice(0, 4).map((ix) => sortedPlayers[ix]);
      for (const ix of picked.slice(0, 4)) used.add(ix);
      groups.push(quad);
    }
  }

  return groups;
}

/* =========================================================
   BAND GROUPING
   ========================================================= */
function makeGroupsBand(sortedPlayers, courtCount) {
  const withBand = sortedPlayers.map((p) => ({ ...p, _band: bandOf(p.skill_level) }));
  for (let bw = 0; bw <= MAX_BAND_EXPANSION; bw++) {
    const groups = greedyBandGroups(withBand, courtCount, bw);
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
    const baseBand = root._band;
    const picked = [i];

    // forward
    for (let j = i + 1; j < playersWithBand.length && picked.length < 4; j++) {
      if (used.has(j)) continue;
      const bj = playersWithBand[j]._band;
      if (Math.abs(bj - baseBand) <= bandWindow) {
        picked.push(j);
      } else if (bj - baseBand > bandWindow) {
        break;
      }
    }

    // backward from end
    for (let j = playersWithBand.length - 1; j > i && picked.length < 4; j--) {
      if (used.has(j)) continue;
      const bj = playersWithBand[j]._band;
      if (Math.abs(bj - baseBand) <= bandWindow) {
        picked.push(j);
      }
    }

    if (picked.length >= 4) {
      picked.sort((a, b) => a - b);
      const quad = picked.slice(0, 4).map((ix) => {
        const { _band, ...rest } = playersWithBand[ix];
        return rest;
      });
      for (const ix of picked.slice(0, 4)) used.add(ix);
      groups.push(quad);
    }
  }

  return groups;
}

function bandOf(level) {
  for (let i = 0; i < BANDS.length; i++) {
    const b = BANDS[i];
    if (level >= b.min && level <= b.max) return i;
  }
  if (level < BANDS[0].min) return 0;
  return BANDS.length - 1;
}

/* =========================================================
   TIME FORMAT
   ========================================================= */
export function formatTime(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds || 0));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}
