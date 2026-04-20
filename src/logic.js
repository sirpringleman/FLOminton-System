/* src/logic.js
   FLOminton Matchmaking + ELO helpers
*/

export const MATCH_MODES = {
  WINDOW: 'window',
  BAND: 'band',
};

/* ========================= Tunables ========================= */

// Window mode in ELO points (or fallback match score units)
const START_SCORE_WINDOW = 160;
const MAX_SCORE_WINDOW = 420;

// Band mode uses score buckets
const BAND_SIZE = 150;
const MAX_BAND_EXPANSION = 4;

// Rematch memory
const REMATCH_MEMORY = 4;

// Fairness
const FAIRNESS_LAG_TOLERANCE = 0.5;
const MAX_CONSECUTIVE_BENCH = 1;

// Bench bias persistence
const BIAS_KEY = 'flominton_bench_bias_v2';
const MAX_BIAS = 0.8;
const DECAY_PLAY = 0.15;
const BOOST_BENCH = 0.25;

/* ========================= Mode ========================= */
let currentMode = safeGetLocal('match_mode') || MATCH_MODES.WINDOW;
let fairnessPressure = 0;
let fairnessPressureRounds = 0;

export function setMatchMode(mode) {
  currentMode = mode === MATCH_MODES.BAND ? MATCH_MODES.BAND : MATCH_MODES.WINDOW;
  safeSetLocal('match_mode', currentMode);
}

export function getMatchMode() {
  return currentMode;
}

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

/* ========================= Helpers ========================= */

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function stddev(arr) {
  if (!arr.length) return 0;
  const mean = arr.reduce((s, x) => s + x, 0) / arr.length;
  const variance = arr.reduce((s, x) => s + (x - mean) * (x - mean), 0) / arr.length;
  return Math.sqrt(variance);
}

function by(fn) {
  return (a, b) => {
    const x = fn(a);
    const y = fn(b);
    if (x < y) return -1;
    if (x > y) return 1;
    return 0;
  };
}

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) {
    out.push(arr.slice(i, i + n));
  }
  return out;
}

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

export function scoreForMatch(player) {
  const explicit = Number(player?.match_score);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;

  const elo = Number(player?.elo_rating);
  if (Number.isFinite(elo) && elo > 0) return elo;

  const skill = Number(player?.skill_level);
  if (Number.isFinite(skill) && skill > 0) {
    return 700 + skill * 100;
  }

  return 1000;
}

export function eloToTier(elo) {
  const value = Number(elo) || 1000;
  return clamp(Math.round((value - 700) / 100), 1, 10);
}

export function displayTier(player) {
  return eloToTier(scoreForMatch(player));
}

function averageElo(players) {
  if (!players?.length) return 1000;
  return (
    players.reduce((sum, p) => sum + scoreForMatch(p), 0) / players.length
  );
}

/* ========================= Player selection ========================= */

/**
 * Select 4*courts players using fairness.
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
  const need = Math.min(total - (total % 4), maxSlots);
  if (need <= 0) return { playing: [], benched: present.slice() };

  const biasMap = loadBiasMap();

  const ranked = present.slice().sort((a, b) => {
    const benchA = Number(a.bench_count || 0);
    const benchB = Number(b.bench_count || 0);

    const debtA = lastRoundBenched?.has(a.id) ? 0.5 : 0;
    const debtB = lastRoundBenched?.has(b.id) ? 0.5 : 0;

    const biasA = biasMap[a.id] || 0;
    const biasB = biasMap[b.id] || 0;

    const scoreA = benchA + debtA + biasA;
    const scoreB = benchB + debtB + biasB;

    if (scoreA !== scoreB) return scoreB - scoreA;

    const lpa = Number(a.last_played_round || 0);
    const lpb = Number(b.last_played_round || 0);
    if (lpa !== lpb) return lpa - lpb;

    return Math.random() - 0.5;
  });

  const benchCounts = present.map((p) => Number(p.bench_count || 0));
  const avgBench =
    benchCounts.reduce((sum, x) => sum + x, 0) / Math.max(1, benchCounts.length);
  const sdBench = stddev(benchCounts);

  if (sdBench > 2.0) {
    fairnessPressure = 2;
    fairnessPressureRounds = 2;
  } else if (sdBench > 1.5) {
    fairnessPressure = 1;
    fairnessPressureRounds = 1;
  } else {
    if (fairnessPressureRounds > 0) {
      fairnessPressureRounds -= 1;
      if (fairnessPressureRounds <= 0) fairnessPressure = 0;
    } else {
      fairnessPressure = 0;
    }
  }

  const laggingIds = new Set(
    present
      .filter((p) => Number(p.bench_count || 0) > avgBench + FAIRNESS_LAG_TOLERANCE)
      .map((p) => p.id)
  );

  const playing = [];

  for (const p of ranked) {
    if (laggingIds.has(p.id) && playing.length < need) {
      playing.push({ ...p, _mustPlay: true });
    }
  }

  for (const p of ranked) {
    if (playing.length >= need) break;
    if (!playing.find((x) => x.id === p.id)) {
      playing.push({ ...p });
    }
  }

  const playingIds = new Set(playing.map((p) => p.id));
  const benched = present.filter((p) => !playingIds.has(p.id));

  if (benched.length > 0 && MAX_CONSECUTIVE_BENCH > 0 && lastRoundBenched?.size > 0) {
    for (let i = 0; i < benched.length; i++) {
      const b = benched[i];
      if (!lastRoundBenched.has(b.id)) continue;

      const swap = playing.find(
        (p) => !laggingIds.has(p.id) && !lastRoundBenched.has(p.id)
      );

      if (swap) {
        benched[i] = swap;
        const idx = playing.findIndex((x) => x.id === swap.id);
        playing[idx] = { ...b };
      }
    }
  }

  for (const p of benched) {
    const cur = biasMap[p.id] || 0;
    biasMap[p.id] = Math.min(MAX_BIAS, cur + BOOST_BENCH);
  }

  for (const p of playing) {
    const cur = biasMap[p.id] || 0;
    const next = Math.max(0, cur - DECAY_PLAY);
    if (next === 0) delete biasMap[p.id];
    else biasMap[p.id] = next;
  }

  saveBiasMap(biasMap);

  return { playing, benched };
}

/* ========================= Match building ========================= */

export function buildMatchesFromPlayers(players, teammateHistory = new Map(), courtsCount = 4) {
  if (!players || players.length < 4) return [];

  const sorted = players.slice().sort((a, b) => scoreForMatch(a) - scoreForMatch(b));
  const totalCourts = Math.min(courtsCount, Math.floor(sorted.length / 4));

  let groups = [];

  if (currentMode === MATCH_MODES.BAND) {
    groups = makeGroupsBand(sorted, totalCourts, fairnessPressure);
  } else {
    groups = makeGroupsWindow(sorted, totalCourts, fairnessPressure);
  }

  if (groups.length !== totalCourts) {
    const prioritized = players
      .slice()
      .sort((a, b) => {
        const am = a._mustPlay ? -1 : 0;
        const bm = b._mustPlay ? -1 : 0;
        if (am !== bm) return am - bm;
        return scoreForMatch(a) - scoreForMatch(b);
      });

    groups = chunk(prioritized, 4).slice(0, totalCourts);
  }

  const matches = [];
  let courtNo = 1;

  for (const g of groups) {
    const quad = g.slice().sort((a, b) => scoreForMatch(a) - scoreForMatch(b));
    const team1 = [quad[0], quad[3]];
    const team2 = [quad[1], quad[2]];

    addPair(team1[0], team1[1], teammateHistory);
    addPair(team2[0], team2[1], teammateHistory);
    trimHistory(teammateHistory, REMATCH_MEMORY);

    const allScores = [...team1, ...team2].map(scoreForMatch);
    matches.push({
      court: courtNo++,
      team1,
      team2,
      avg1: averageElo(team1),
      avg2: averageElo(team2),
      span: Math.max(...allScores) - Math.min(...allScores),
    });
  }

  return matches;
}

function makeGroupsWindow(sortedPlayers, courtCount, pressure = 0) {
  const extra = Math.min(pressure, 2) * 40;

  for (
    let window = START_SCORE_WINDOW;
    window <= MAX_SCORE_WINDOW + extra;
    window += 20
  ) {
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
    const rootScore = scoreForMatch(root);
    const pickIdx = [i];

    for (let j = i + 1; j < sortedPlayers.length && pickIdx.length < 4; j++) {
      if (used.has(j) || pickIdx.includes(j)) continue;

      const candidate = sortedPlayers[j];
      const s = scoreForMatch(candidate);
      const allowExtra = root._mustPlay || candidate._mustPlay ? 40 : 0;

      if (Math.abs(s - rootScore) <= window + allowExtra + pressureExtra) {
        pickIdx.push(j);
      }
    }

    for (let j = sortedPlayers.length - 1; j > i && pickIdx.length < 4; j--) {
      if (used.has(j) || pickIdx.includes(j)) continue;

      const candidate = sortedPlayers[j];
      const s = scoreForMatch(candidate);
      const allowExtra = root._mustPlay || candidate._mustPlay ? 40 : 0;

      if (Math.abs(s - rootScore) <= window + allowExtra + pressureExtra) {
        pickIdx.push(j);
      }
    }

    if (pickIdx.length >= 4) {
      pickIdx.sort((a, b) => a - b);
      const quad = pickIdx.slice(0, 4).map((ix) => sortedPlayers[ix]);
      for (const ix of pickIdx.slice(0, 4)) used.add(ix);
      groups.push(quad);
    }
  }

  return groups;
}

function makeGroupsBand(sortedPlayers, courtCount, pressure = 0) {
  const withBand = sortedPlayers.map((p) => ({ ...p, _band: bandOf(scoreForMatch(p)) }));
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

    for (let j = i + 1; j < playersWithBand.length && pickIdx.length < 4; j++) {
      if (used.has(j) || pickIdx.includes(j)) continue;

      const candidate = playersWithBand[j];
      const bj = candidate._band;
      const allowExtra = root._mustPlay || candidate._mustPlay ? 1 : 0;

      if (Math.abs(bj - minBand) <= bandWindow + allowExtra + pressureExtra) {
        pickIdx.push(j);
      }
    }

    for (let j = playersWithBand.length - 1; j > i && pickIdx.length < 4; j--) {
      if (used.has(j) || pickIdx.includes(j)) continue;

      const candidate = playersWithBand[j];
      const bj = candidate._band;
      const allowExtra = root._mustPlay || candidate._mustPlay ? 1 : 0;

      if (Math.abs(bj - minBand) <= bandWindow + allowExtra + pressureExtra) {
        pickIdx.push(j);
      }
    }

    if (pickIdx.length >= 4) {
      pickIdx.sort((a, b) => a - b);
      const quad = pickIdx.slice(0, 4).map((ix) => stripBand(playersWithBand[ix]));
      for (const ix of pickIdx.slice(0, 4)) used.add(ix);
      groups.push(quad);
    }
  }

  return groups;
}

function bandOf(score) {
  return Math.max(0, Math.floor((score - 700) / BAND_SIZE));
}

function stripBand(p) {
  const { _band, ...rest } = p;
  return rest;
}

/* ========================= ELO helpers ========================= */

export function expectedScore(teamAvgA, teamAvgB) {
  return 1 / (1 + Math.pow(10, (teamAvgB - teamAvgA) / 400));
}

export function calculateMatchElo(match, winnerTeam, kFactor = 24) {
  if (!match || (winnerTeam !== 1 && winnerTeam !== 2)) {
    return { updates: [] };
  }

  const team1Avg = averageElo(match.team1);
  const team2Avg = averageElo(match.team2);

  const exp1 = expectedScore(team1Avg, team2Avg);
  const exp2 = expectedScore(team2Avg, team1Avg);

  const score1 = winnerTeam === 1 ? 1 : 0;
  const score2 = winnerTeam === 2 ? 1 : 0;

  const delta1 = Math.round(kFactor * (score1 - exp1));
  const delta2 = Math.round(kFactor * (score2 - exp2));

  const updates = [
    ...match.team1.map((p) => ({
      id: p.id,
      old_elo: scoreForMatch(p),
      new_elo: scoreForMatch(p) + delta1,
      elo_delta: delta1,
      result: winnerTeam === 1 ? 'win' : 'loss',
    })),
    ...match.team2.map((p) => ({
      id: p.id,
      old_elo: scoreForMatch(p),
      new_elo: scoreForMatch(p) + delta2,
      elo_delta: delta2,
      result: winnerTeam === 2 ? 'win' : 'loss',
    })),
  ];

  return {
    team1Avg,
    team2Avg,
    exp1,
    exp2,
    delta1,
    delta2,
    updates,
  };
}

/* ========================= Pair history ========================= */

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
    if (arr.length > keep) {
      map.set(k, arr.slice(arr.length - keep));
    }
  }
}

/* ========================= Timer util ========================= */

export function formatTime(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds || 0));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}