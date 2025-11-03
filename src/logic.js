// src/logic.js
// Deluxe matchmaking + helpers with Band/Window modes,
// fairness-first selection, team balancing, and light repeat-avoidance scoring.

export const BANDS = [
  [1, 2], [3, 4], [5, 6], [7, 8], [9, 10]
];

export function levelToBand(lvl) {
  if (lvl <= 2) return 0;
  if (lvl <= 4) return 1;
  if (lvl <= 6) return 2;
  if (lvl <= 8) return 3;
  return 4;
}

export const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
export const avg = (arr, f = x => x) => arr.length ? arr.reduce((s,x)=>s+f(x),0)/arr.length : 0;
const byAsc  = fn => (a,b)=> fn(a)-fn(b);
const byDesc = fn => (a,b)=> fn(b)-fn(a);

// ---------- 2v2 splitting ----------

function allSplits4(pl) {
  // three unique ways to split 4 into 2v2
  return [
    [[pl[0], pl[1]], [pl[2], pl[3]]],
    [[pl[0], pl[2]], [pl[1], pl[3]]],
    [[pl[0], pl[3]], [pl[1], pl[2]]],
  ];
}

function splitPenalty(t1, t2) {
  // primary objective: minimize team-average difference
  const a1 = avg(t1, p=>p.skill_level);
  const a2 = avg(t2, p=>p.skill_level);
  const diff = Math.abs(a1-a2);

  // discourage “high+high vs low+low” when it creates big diff
  const s1 = Math.max(...t1.map(p=>p.skill_level)) - Math.min(...t1.map(p=>p.skill_level));
  const s2 = Math.max(...t2.map(p=>p.skill_level)) - Math.min(...t2.map(p=>p.skill_level));
  let penalty = diff;
  if (s1 <= 2 && s2 <= 2 && diff >= 1.0) penalty += 1.0;

  return penalty;
}

export function bestSplit2v2(players4) {
  let best=null, bestScore=Infinity;
  for (const [a,b] of allSplits4(players4)) {
    const score = splitPenalty(a,b);
    if (score < bestScore) {
      bestScore = score;
      best = {
        team1: a, team2: b,
        team1Avg: avg(a,p=>p.skill_level),
        team2Avg: avg(b,p=>p.skill_level),
        diff: Math.abs(avg(a,p=>p.skill_level)-avg(b,p=>p.skill_level)),
      };
    }
  }
  return best;
}

// ---------- player selection (fairness first) ----------

export function pickPlayersForRound(
  present,
  {
    roundNo,
    lastPlayedMap,     // Map<id, last_round_played>
    benchCountMap,     // Map<id, bench_count>
    lastRoundBenchedSet, // Set<id> (tie-break: those benched last round are not penalized further)
    maxCourts,
  }
) {
  // Sort by fairness priority:
  //  1) Highest bench_count first (those benched more get picked first)
  //  2) Oldest last_played_round (haven't played in longer)
  //  3) Name tiebreak for determinism
  const pool = [...present]
    .sort(byAsc(p => p.name.toLowerCase()))
    .sort(byAsc(p => lastPlayedMap.get(p.id) || 0))
    .sort(byDesc(p => benchCountMap.get(p.id) || 0));

  const target = Math.min(pool.length - (pool.length % 4), maxCourts * 4);
  return pool.slice(0, target);
}

// ---------- quad building (Band or Window logic) ----------

export function buildQuads(chosen, mode, windowSize) {
  const remaining = [...chosen].sort(byAsc(p=>p.skill_level));
  const quads = [];

  while (remaining.length >= 4) {
    // seed from center for stability
    const mid = Math.floor(remaining.length/2);
    const seed = remaining.splice(mid,1)[0];

    let cands;
    if (mode === 'band') {
      const b = levelToBand(seed.skill_level);
      cands = remaining.filter(p => levelToBand(p.skill_level) === b);

      // expand to neighbor bands only if short
      if (cands.length < 3) {
        const neigh = new Set([clamp(b-1,0,4), b, clamp(b+1,0,4)]);
        cands = remaining.filter(p => neigh.has(levelToBand(p.skill_level)));
      }
    } else {
      // window mode (+/-R, expanding if short)
      let w = windowSize;
      cands = remaining.filter(p => Math.abs(p.skill_level - seed.skill_level) <= w);
      while (cands.length < 3 && w < 5) {
        w += 1;
        cands = remaining.filter(p => Math.abs(p.skill_level - seed.skill_level) <= w);
      }
    }

    if (cands.length < 3) {
      // absolute fallback: nearest three by skill
      cands = remaining.slice().sort(byAsc(p=>Math.abs(p.skill_level-seed.skill_level))).slice(0,3);
    } else {
      // choose the three closest by skill
      cands.sort(byAsc(p=>Math.abs(p.skill_level-seed.skill_level)));
      cands = cands.slice(0,3);
    }

    const quad = [seed, ...cands];
    // remove chosen from remaining
    for (const p of cands) {
      const i = remaining.findIndex(x => x.id===p.id);
      if (i>=0) remaining.splice(i,1);
    }

    quads.push(quad);
  }

  return quads;
}

// ---------- team balancing for each quad ----------

export function balanceTeamsForQuads(quads) {
  return quads.map(quad => bestSplit2v2(quad));
}

// ---------- finalize to courts ----------

export function finalizeCourts(matches, maxCourts) {
  return matches.slice(0, maxCourts).map((m,i)=>({ ...m, court:i+1 }));
}

// ---------- main build entry ----------

export function buildMatches({
  present, maxCourts, mode, windowSize,
  roundNo, lastPlayedMap, benchCountMap, lastRoundBenchedSet,
}) {
  const chosen = pickPlayersForRound(present, {
    roundNo, lastPlayedMap, benchCountMap, lastRoundBenchedSet, maxCourts
  });

  const quads     = buildQuads(chosen, mode, windowSize);
  const balanced  = balanceTeamsForQuads(quads);
  const finalized = finalizeCourts(balanced, maxCourts);
  return finalized;
}

// ---------- analytics helpers (used by App.jsx) ----------

export function perPlayerUniq(pId, rounds) {
  // rounds: [{matches:[{team1:[p], team2:[p]}]}]
  const teammates = new Set();
  const opponents = new Set();
  for (const r of rounds) {
    for (const m of r.matches) {
      const team1Ids = m.team1.map(x=>x.id);
      const team2Ids = m.team2.map(x=>x.id);
      if (team1Ids.includes(pId)) {
        m.team1.forEach(x=>{ if (x.id!==pId) teammates.add(x.id); });
        m.team2.forEach(x=> opponents.add(x.id));
      } else if (team2Ids.includes(pId)) {
        m.team2.forEach(x=>{ if (x.id!==pId) teammates.add(x.id); });
        m.team1.forEach(x=> opponents.add(x.id));
      }
    }
  }
  return { uniqTeammates: teammates.size, uniqOpponents: opponents.size };
}

export function countBackToBackBenches(playerId, rounds) {
  // worst bench streak (consecutive rounds not in any match)
  let best = 0, cur = 0;
  for (const r of rounds) {
    const played = r.matches.some(m =>
      m.team1.some(p=>p.id===playerId) || m.team2.some(p=>p.id===playerId)
    );
    if (played) { best = Math.max(best, cur); cur = 0; }
    else cur += 1;
  }
  return Math.max(best, cur);
}

export function fairnessStats(rounds, presentSet) {
  // bench count / played count per present player during the session
  const playedMap = new Map(); // id -> played count
  const benchedMap = new Map(); // id -> benched count
  for (const id of presentSet) { playedMap.set(id,0); benchedMap.set(id,0); }

  for (const r of rounds) {
    const playedIds = new Set(r.matches.flatMap(m=>[...m.team1,...m.team2].map(x=>x.id)));
    for (const id of presentSet) {
      if (playedIds.has(id)) playedMap.set(id, (playedMap.get(id)||0)+1);
      else benchedMap.set(id, (benchedMap.get(id)||0)+1);
    }
  }

  const playedArr  = [...playedMap.values()];
  const benchedArr = [...benchedMap.values()];
  const meanPlayed = avg(playedArr);
  const sdPlayed   = Math.sqrt(avg(playedArr, x=>(x-meanPlayed)**2));
  const spread     = (Math.max(...playedArr)-Math.min(...playedArr)) || 0;
  const fairnessRatio = meanPlayed > 0 ? sdPlayed/meanPlayed : 0;

  return { playedMap, benchedMap, meanPlayed, sdPlayed, spread, fairnessRatio };
}

export function roundDiagnostics(rounds){
  // per-round: build time (ms), courts used, avg team diff per match, out-of-band count (how many players used outside strict band pairing)
  const buildTimes = rounds.map(r => r.meta?.buildMs ?? null).filter(x=>x!=null);
  const usedCourts = rounds.map(r => r.matches.length);
  const diffs = rounds.map(r => avg(r.matches, m=>Math.abs(m.team1Avg - m.team2Avg)));
  // "out-of-band" is tracked in meta by App when Band mode had to expand beyond neighbor bands.
  const oobCounts = rounds.map(r => r.meta?.outOfBand ?? 0);

  return { buildTimes, usedCourts, diffs, oobCounts };
}
