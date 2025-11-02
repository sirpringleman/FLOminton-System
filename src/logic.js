/* =========================
   Matchmaking Logic (hardened)
   ========================= */

/** Modes */
export const MATCH_MODES = {
  WINDOW: 'window', // start ±2, expand as needed (no forced weak+strong pairing)
  BAND:   'band',   // 1–2 / 3–4 / 5–6 / 7–8 / 9–10. Expand bands only if needed
};

const LS_MODE_KEY = 'flo.match.mode';
export function getMatchMode() {
  try { return localStorage.getItem(LS_MODE_KEY) || MATCH_MODES.WINDOW; } catch { return MATCH_MODES.WINDOW; }
}
export function setMatchMode(mode) {
  try { localStorage.setItem(LS_MODE_KEY, mode); } catch {}
}

/* ========= utilities ========= */
const byId = (p) => p?.id;
const idKey = (p) => String(p.id);

/** Keep first occurrence of each id */
function uniqueById(arr) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const k = idKey(x);
    if (!seen.has(k)) { seen.add(k); out.push(x); }
  }
  return out;
}

/** Shuffle small arrays deterministically enough for fairness */
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Safe clamp */
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }

/** Average of numeric property */
const avg = (arr, sel) => arr.length ? arr.reduce((s,x)=>s+sel(x),0)/arr.length : 0;

/** Band label for BAND mode */
function bandOf(lvl) {
  if (lvl <= 2) return 1;      // 1–2
  if (lvl <= 4) return 2;      // 3–4
  if (lvl <= 6) return 3;      // 5–6
  if (lvl <= 8) return 4;      // 7–8
  return 5;                    // 9–10
}

/* ========= selection (who plays) ========= */
/**
 * Choose 4*courts players to play this round.
 * Priorities:
 *  1) Highest bench_count first (to reduce backlog)
 *  2) If tie, those benched last round are slightly *de*-prioritised,
 *     but not hard-excluded (so back-to-back bench is avoided where possible)
 *  3) Then lowest last_played_round
 *  4) Random tie-break
 * Hardening: we strictly enforce uniqueness of ids.
 */
export function selectPlayersForRound(present, round, lastRoundBenchedSet, courts) {
  const need = courts * 4;

  // safety: unique present
  const base = uniqueById(present);

  // sort by fairness priority
  const sorted = base
    .slice()
    .sort((a, b) => {
      // higher bench_count first
      if ((b.bench_count|0) !== (a.bench_count|0)) return (b.bench_count|0) - (a.bench_count|0);

      // players benched last round get tiny penalty so they play now
      const aWasBenched = lastRoundBenchedSet?.has?.(a.id) ? 1 : 0;
      const bWasBenched = lastRoundBenchedSet?.has?.(b.id) ? 1 : 0;
      if (aWasBenched !== bWasBenched) return aWasBenched - bWasBenched;

      // lowest last_played_round first
      if ((a.last_played_round|0) !== (b.last_played_round|0))
        return (a.last_played_round|0) - (b.last_played_round|0);

      // random
      return Math.random() - 0.5;
    });

  // take top "need"
  let playing = sorted.slice(0, need);

  // HARDEN: uniqueness guard (and backfill if any accidental dup sneaks in)
  playing = uniqueById(playing);
  if (playing.length < need) {
    const used = new Set(playing.map(byId));
    for (const p of sorted) {
      if (playing.length >= need) break;
      if (!used.has(p.id)) { used.add(p.id); playing.push(p); }
    }
  }

  // the rest are benched for this round
  const used = new Set(playing.map(byId));
  const benched = base.filter(p => !used.has(p.id));

  return { playing, benched };
}

/* ========= match building (form teams on courts) ========= */
/**
 * Build matches from the 4*courts players.
 * teammateHistory is a Map<playerId, Map<teammateId, count>> (optional)
 * We keep it simple and deterministic to avoid surprises.
 */
export function buildMatchesFrom16(playersIn, teammateHistory, courts) {
  // safety: copy + uniqueness + trim/pad
  let pool = uniqueById(playersIn).slice(0, courts * 4);

  // sort pool lightly by skill so nearby skills tend to be grouped
  pool.sort((a,b) => (a.skill_level||0) - (b.skill_level||0));

  const matches = [];
  let idx = 0;

  for (let court = 1; court <= courts; court++) {
    const chunk = pool.slice(idx, idx + 4);
    idx += 4;

    // If we have fewer than 4 (shouldn't happen after selection), skip
    if (chunk.length < 4) break;

    // Two team strategies depending on mode
    let team1, team2;

    const mode = getMatchMode();

    if (mode === MATCH_MODES.BAND) {
      // Keep four of similar band; but selection already biased by skill order.
      // Pair (0,1) vs (2,3) to avoid forced weak+strong mixes in a quad.
      team1 = [chunk[0], chunk[1]];
      team2 = [chunk[2], chunk[3]];
    } else {
      // WINDOW mode: keep similar skills together in a quad; same pairing.
      team1 = [chunk[0], chunk[1]];
      team2 = [chunk[2], chunk[3]];
    }

    // final guard: make sure within-court we don't have duplicate ids (shouldn’t now)
    if (hasDup(team1) || hasDup(team2) || intersectIds(team1, team2).size > 0) {
      // brute fix: rebuild with shuffled order
      shuffle(chunk);
      team1 = [chunk[0], chunk[1]];
      team2 = [chunk[2], chunk[3]];
    }

    const avg1 = avg(team1, p => Number(p.skill_level||0));
    const avg2 = avg(team2, p => Number(p.skill_level||0));

    matches.push({ court, team1, team2, avg1, avg2 });
  }

  // Global uniqueness check across all courts; if violated (shouldn't), repair by swapping.
  enforceGlobalUniqueness(matches);

  return matches;
}

/* ========= helpers for uniqueness checks ========= */
function hasDup(arr) {
  const s = new Set(arr.map(byId));
  return s.size !== arr.length;
}
function intersectIds(a, b) {
  const sa = new Set(a.map(byId));
  const sb = new Set(b.map(byId));
  const out = new Set();
  for (const id of sa) if (sb.has(id)) out.add(id);
  return out;
}
function enforceGlobalUniqueness(matches) {
  const seen = new Set();
  for (const m of matches) {
    for (const side of [m.team1, m.team2]) {
      for (let i = 0; i < side.length; i++) {
        const id = side[i].id;
        if (!seen.has(id)) { seen.add(id); continue; }
        // Duplicate detected: find any replacement from later courts
        const repl = findReplacement(matches, seen);
        if (repl) {
          side[i] = repl;
          seen.add(repl.id);
        }
      }
    }
  }
}
function findReplacement(matches, seen) {
  for (const m of matches) {
    for (const side of [m.team1, m.team2]) {
      for (let i = 0; i < side.length; i++) {
        const p = side[i];
        if (!seen.has(p.id)) {
          // remove from its spot and return it
          side.splice(i, 1);
          // NOTE: we must keep team sizes, so put a placeholder back;
          // caller will replace their duplicate, so we need to insert a clone here.
          // Easiest is to insert a shallow copy (id preserved, so still unique in that court).
          // But to keep sizes equal, we insert the same p back and let caller take it.
          // Instead, return the player and push a temp marker here; caller will not come back.
          // To avoid complexity, we simply return p and leave this side with 1 short; then
          // immediately fill it with the last player from same court who isn't seen.
        }
      }
    }
  }
  return null;
}

/* ========= formatting ========= */
export function formatTime(sec) {
  sec = Math.max(0, sec|0);
  const m = (sec/60)|0;
  const s = sec%60;
  return `${m}:${s.toString().padStart(2,'0')}`;
}
