/* ===========================================================
   TheFLOminton System — Matchmaking Logic (Deluxe Version)
   =========================================================== */

/* ------------------- MODES ------------------- */
export const MATCH_MODES = {
  WINDOW: 'window', // base ±2 skill window, expand if needed
  BAND: 'band',     // 1–2 / 3–4 / 5–6 / 7–8 / 9–10 bands, expand if needed
};

const MODE_KEY = 'flo.match.mode';

export function getMatchMode() {
  try {
    return localStorage.getItem(MODE_KEY) || MATCH_MODES.WINDOW;
  } catch {
    return MATCH_MODES.WINDOW;
  }
}

export function setMatchMode(mode) {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {}
}

/* ------------------- UTILITIES ------------------- */
const idOf = (p) => String(p?.id);
export function formatTime(sec) {
  sec = Math.max(0, sec | 0);
  const m = (sec / 60) | 0;
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function uniqueById(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const k = idOf(x);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(x);
    }
  }
  return out;
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const avg = (arr, pick) => (arr.length ? arr.reduce((s, x) => s + pick(x), 0) / arr.length : 0);

function bandOf(level) {
  if (level <= 2) return 1;
  if (level <= 4) return 2;
  if (level <= 6) return 3;
  if (level <= 8) return 4;
  return 5;
}

function hasDuplicate(arr) {
  const s = new Set();
  for (const x of arr) {
    if (s.has(x)) return true;
    s.add(x);
  }
  return false;
}

/* ------------------- PLAYER SELECTION -------------------
   Priority:
   1. Highest bench_count (played least)
   2. Was benched last round (play now)
   3. Lowest last_played_round (waited longest)
   4. Random tie-break
---------------------------------------------------------- */
export function selectPlayersForRound(presentPlayers, round, lastRoundBenchedSet, courts) {
  const need = courts * 4;
  const base = uniqueById(presentPlayers);

  const sorted = base.slice().sort((a, b) => {
    // 1) Highest bench_count first
    const bcA = a.bench_count | 0;
    const bcB = b.bench_count | 0;
    if (bcB !== bcA) return bcB - bcA;

    // 2) Was benched last round
    const aWas = lastRoundBenchedSet?.has?.(a.id) ? 1 : 0;
    const bWas = lastRoundBenchedSet?.has?.(b.id) ? 1 : 0;
    if (aWas !== bWas) return bWas - aWas;

    // 3) Lowest last_played_round
    const lA = a.last_played_round | 0;
    const lB = b.last_played_round | 0;
    if (lA !== lB) return lA - lB;

    // 4) Random
    return Math.random() - 0.5;
  });

  let playing = uniqueById(sorted.slice(0, need));

  // Backfill if dedup removed players
  if (playing.length < need) {
    const used = new Set(playing.map((p) => p.id));
    for (const p of sorted) {
      if (playing.length >= need) break;
      if (!used.has(p.id)) {
        used.add(p.id);
        playing.push(p);
      }
    }
  }

  const usedIds = new Set(playing.map((p) => p.id));
  const benched = base.filter((p) => !usedIds.has(p.id));

  return { playing, benched };
}

/* ------------------- BUILD QUADS -------------------
   Builds groups of 4 players based on similarity:
   - BAND mode: group by band ±N
   - WINDOW mode: group by skill ±N
---------------------------------------------------- */
function buildQuads(pool, mode, courts) {
  pool = pool.slice().sort((a, b) => (a.skill_level || 0) - (b.skill_level || 0));
  const quads = [];

  const removeByIdx = (arr, idxs) => idxs.sort((a, b) => b - a).forEach((i) => arr.splice(i, 1));

  while (pool.length >= 4 && quads.length < courts) {
    const seed = pool[0];
    const seedLvl = seed.skill_level | 0;
    const seedBand = bandOf(seedLvl);

    let pickedIdx = [0];
    let win = mode === MATCH_MODES.BAND ? 0 : 2;
    let expandSteps = 0;

    const fits = (p) =>
      mode === MATCH_MODES.BAND
        ? Math.abs(bandOf(p.skill_level | 0) - seedBand) <= win
        : Math.abs((p.skill_level | 0) - seedLvl) <= win;

    while (pickedIdx.length < 4) {
      const tryIdx = [];
      for (let i = 1; i < pool.length; i++) {
        if (pickedIdx.includes(i)) continue;
        if (fits(pool[i])) tryIdx.push(i);
        if (tryIdx.length + pickedIdx.length >= 4) break;
      }

      if (tryIdx.length) {
        const need = 4 - pickedIdx.length;
        pickedIdx.push(...tryIdx.slice(0, need));
      } else {
        expandSteps++;
        win += 1;
        if (expandSteps > 3) {
          const need = 4 - pickedIdx.length;
          const fallback = [];
          for (let i = 1; i < pool.length; i++) {
            if (pickedIdx.includes(i)) continue;
            fallback.push(i);
            if (fallback.length >= need) break;
          }
          pickedIdx.push(...fallback);
        }
      }
    }

    const quad = pickedIdx.map((i) => pool[i]);
    removeByIdx(pool, pickedIdx);
    quads.push(quad);
  }

  return quads;
}

/* ------------------- BUILD MATCHES -------------------
   - Builds courts (each court = 4 players)
   - Team1 = [0,1] vs Team2 = [2,3]
   - Ensures global uniqueness (no duplicate IDs)
   - Retries up to 10x with reshuffle if duplicate
------------------------------------------------------ */
export function buildMatchesFrom16(playersIn, teammateHistory, courts) {
  const need = courts * 4;
  let base = uniqueById(playersIn).slice(0, need);

  for (let attempt = 0; attempt < 10; attempt++) {
    const mode = getMatchMode();
    const quads = buildQuads(base, mode, courts);

    const matches = [];
    for (let c = 0; c < Math.min(courts, quads.length); c++) {
      const q = quads[c];
      if (q.length < 4) break;
      const team1 = [q[0], q[1]];
      const team2 = [q[2], q[3]];
      const avg1 = avg(team1, (p) => Number(p.skill_level || 0));
      const avg2 = avg(team2, (p) => Number(p.skill_level || 0));
      matches.push({ court: c + 1, team1, team2, avg1, avg2 });
    }

    const allIds = [];
    matches.forEach((m) => {
      m.team1.forEach((p) => allIds.push(p.id));
      m.team2.forEach((p) => allIds.push(p.id));
    });

    if (!hasDuplicate(allIds)) return matches;
    base = shuffle(base.slice());
  }

  // Fallback: simple sequential grouping
  base = base.slice().sort((a, b) => (a.skill_level || 0) - (b.skill_level || 0));
  const matches = [];
  for (let c = 0; c < courts; c++) {
    const q = base.slice(c * 4, c * 4 + 4);
    if (q.length < 4) break;
    const team1 = [q[0], q[1]];
    const team2 = [q[2], q[3]];
    matches.push({
      court: c + 1,
      team1,
      team2,
      avg1: avg(team1, (p) => p.skill_level || 0),
      avg2: avg(team2, (p) => p.skill_level || 0),
    });
  }
  return matches;
}
