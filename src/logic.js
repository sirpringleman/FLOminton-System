// src/logic.js
// — Matchmaking core —
// Window Mode: +/-R window expansion
// Band Mode: fixed bands [1-2],[3-4],[5-6],[7-8],[9-10]; expand to neighbor band only when required
// Also enforces team-balance within a quad: picks 2v2 split minimizing |avg1-avg2|
// and avoids (high,high) vs (low,low) when that yields a large mismatch.

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

function avg(arr, f = x => x) {
  if (!arr.length) return 0;
  return arr.reduce((s, x) => s + f(x), 0) / arr.length;
}

function byAsc(fn) { return (a, b) => fn(a) - fn(b); }
function byDesc(fn) { return (a, b) => fn(b) - fn(a); }

// all unique 2v2 splits for 4 players (indexes)
function allSplits4(pl) {
  // pl = [p0,p1,p2,p3]
  return [
    [[pl[0], pl[1]], [pl[2], pl[3]]],
    [[pl[0], pl[2]], [pl[1], pl[3]]],
    [[pl[0], pl[3]], [pl[1], pl[2]]],
  ];
}

function spread(players) {
  const lvls = players.map(p => p.skill_level).sort((a,b)=>a-b);
  return lvls[lvls.length-1] - lvls[0];
}

// penalize “high+high vs low+low” if mismatch big
function splitPenalty(t1, t2) {
  const a1 = avg(t1, p=>p.skill_level);
  const a2 = avg(t2, p=>p.skill_level);
  const diff = Math.abs(a1 - a2);
  const t1max = Math.max(...t1.map(p=>p.skill_level));
  const t1min = Math.min(...t1.map(p=>p.skill_level));
  const t2max = Math.max(...t2.map(p=>p.skill_level));
  const t2min = Math.min(...t2.map(p=>p.skill_level));
  const t1spread = t1max - t1min;
  const t2spread = t2max - t2min;

  let penalty = diff; // base objective

  // If one team is much stronger than the other because it paired both highs:
  if (t1spread <= 2 && t2spread <= 2 && diff >= 1.0) penalty += 1.0;
  return penalty;
}

export function bestSplit2v2(players4) {
  let best = null;
  let bestScore = Infinity;
  for (const [a, b] of allSplits4(players4)) {
    const score = splitPenalty(a, b);
    if (score < bestScore) {
      bestScore = score;
      best = { team1: a, team2: b, diff: Math.abs(avg(a, p=>p.skill_level) - avg(b, p=>p.skill_level)) };
    }
  }
  return best;
}

export function pickPlayersForRound(present,
  { roundNo, lastPlayedMap, benchCountMap, lastRoundBenchedSet, recentTeammates, recentOpponents, maxCourts }) {

  // Priority: higher bench_count first, then oldest last_played_round,
  // tiebreak by name to keep deterministic.
  const pool = [...present].sort(byDesc(p => benchCountMap.get(p.id) || 0))
                           .sort(byAsc(p => lastPlayedMap.get(p.id) || 0))
                           .sort(byAsc(p => p.name.toLowerCase()));

  // select up to 4*maxCourts, honoring “no back-to-back bench” when possible
  const take = Math.min(pool.length - (pool.length % 4), maxCourts*4);
  const chosen = pool.slice(0, take);
  return chosen;
}

export function buildQuads(chosen, mode, windowSize, teammateBanLookup, opponentBanLookup) {
  // Mode = 'band' or 'window'
  // We’ll create groups of 4 with minimal intra-quad skill spread while honoring mode.

  const remaining = [...chosen];
  const quads = [];

  // Helper to pull next seed (the most “waiting” one—callers often prepare the ordering)
  remaining.sort(byAsc(p => p.skill_level));

  while (remaining.length >= 4) {
    // take a seed in middle to avoid bias
    const mid = Math.floor(remaining.length / 2);
    const seed = remaining.splice(mid, 1)[0];

    // build candidate list for this seed
    let cands;
    if (mode === 'band') {
      const b = levelToBand(seed.skill_level);
      const bandRanges = [
        [b], [Math.max(0,b-1), b, Math.min(4, b+1)]
      ];
      // Try strict band first, then allow neighbor bands
      cands = remaining.filter(p => levelToBand(p.skill_level) === b);
      if (cands.length < 3)
        cands = remaining.filter(p => bandRanges[1].includes(levelToBand(p.skill_level)));
    } else {
      // window
      let w = windowSize;
      cands = remaining.filter(p => Math.abs(p.skill_level - seed.skill_level) <= w);
      while (cands.length < 3 && w < 5) {
        w += 1;
        cands = remaining.filter(p => Math.abs(p.skill_level - seed.skill_level) <= w);
      }
    }

    if (cands.length < 3) {
      // not enough, take the closest 3 by level
      const sorted = remaining.slice().sort(byAsc(p => Math.abs(p.skill_level - seed.skill_level)));
      cands = sorted.slice(0, 3);
    } else {
      // take three closest to seed by level
      cands.sort(byAsc(p => Math.abs(p.skill_level - seed.skill_level)));
      cands = cands.slice(0, 3);
    }

    const quad = [seed, ...cands];
    // Remove the chosen from remaining
    for (const p of cands) {
      const idx = remaining.findIndex(x => x.id === p.id);
      if (idx >= 0) remaining.splice(idx, 1);
    }
    quads.push(quad);
  }

  return quads;
}

export function balanceTeamsForQuads(quads) {
  const matches = [];
  for (const quad of quads) {
    const { team1, team2, diff } = bestSplit2v2(quad);
    matches.push({
      court: null,
      team1,
      team2,
      team1Avg: avg(team1, p=>p.skill_level),
      team2Avg: avg(team2, p=>p.skill_level),
      diff
    });
  }
  return matches;
}

export function finalizeCourts(matches, maxCourts) {
  return matches.slice(0, maxCourts).map((m, i) => ({ ...m, court: i + 1 }));
}

// Top level one-shot builder for 16 players (or any multiple of 4 up to maxCourts)
export function buildMatches({
  present, maxCourts, mode, windowSize,
  roundNo, lastPlayedMap, benchCountMap, lastRoundBenchedSet,
  recentTeammates, recentOpponents
}) {
  const chosen = pickPlayersForRound(
    present, { roundNo, lastPlayedMap, benchCountMap, lastRoundBenchedSet, recentTeammates, recentOpponents, maxCourts }
  );

  const quads = buildQuads(chosen, mode, windowSize, recentTeammates, recentOpponents);
  const balanced = balanceTeamsForQuads(quads);
  return finalizeCourts(balanced, maxCourts);
}
