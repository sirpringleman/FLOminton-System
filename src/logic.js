// logic.js — matchmaking + analytics (Band / Window modes)

/**
 * Player shape (expected):
 * {
 *   id, name, gender: 'M'|'F',
 *   skill_level: 1..10,
 *   is_present: bool,
 *   bench_count: number,
 *   last_played_round: number
 * }
 */

const rnd = (min, max) => Math.random() * (max - min) + min;
const shuffle = (arr) => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0;
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

function bandOf(level) {
  if (level <= 2) return 1;
  if (level <= 4) return 2;
  if (level <= 6) return 3;
  if (level <= 8) return 4;
  return 5; // 9-10
}

function avgTeam(players) {
  if (!players.length) return 0;
  return players.reduce((s, p) => s + (p.skill_level || 0), 0) / players.length;
}

function splitPenalty(t1, t2) {
  // Encourage balanced averages across teams
  const d = Math.abs(avgTeam(t1) - avgTeam(t2));
  // 0 => perfect, grows with difference
  return d;
}

function fairnessScore(p) {
  // Higher score => higher priority to play now
  // Prioritize highest bench_count; if tie, older last_played goes first
  const bc = p.bench_count || 0;
  const last = p.last_played_round || 0;
  return bc * 1000 - last; // big weight on bench_count
}

function groupByBand(players) {
  const map = new Map();
  for (const p of players) {
    const b = bandOf(p.skill_level || 5);
    if (!map.has(b)) map.set(b, []);
    map.get(b).push(p);
  }
  for (const [b, list] of map) {
    list.sort((a, b) => fairnessScore(b) - fairnessScore(a));
  }
  return map;
}

function takeN(arr, n) {
  const out = arr.splice(0, n);
  return out.length === n ? out : null;
}

function buildBandMatches(input) {
  const {
    present,
    maxCourts,
    roundNo,
    lastPlayedMap,
    benchCountMap,
    lastRoundBenchedSet,
  } = input;

  // Sort present by bench priority first
  const pool = present
    .slice()
    .sort(
      (a, b) =>
        fairnessScore(b) - fairnessScore(a) || a.name.localeCompare(b.name)
    );

  const byBand = groupByBand(pool);
  const courts = [];
  const used = new Set();

  // Helper: try form one court from a band +/- 1 neighbor with expansion
  function formCourt() {
    // Select highest-need players first by band blocks
    const bands = [1, 2, 3, 4, 5];

    // For each band, try strict band, then expand to neighbors if needed
    for (const b of bands) {
      for (let expand = 0; expand <= 3; expand++) {
        // Build candidate list from band +/- expand
        const candidates = [];
        for (let k = b - expand; k <= b + expand; k++) {
          if (k >= 1 && k <= 5 && byBand.get(k)?.length) {
            // add a copy (we won't mutate storage lists yet)
            candidates.push(...byBand.get(k).filter((p) => !used.has(p.id)));
          }
        }
        if (candidates.length < 4) continue;

        // We will pick 4 by highest fairness, but keep them near b
        candidates.sort(
          (a, b) =>
            fairnessScore(b) - fairnessScore(a) ||
            Math.abs(bandOf(a.skill_level) - b) -
              Math.abs(bandOf(b.skill_level) - b)
        );

        // pick top 4
        const four = candidates.slice(0, 4);
        // test team splits minimizing avg diff
        const combos = [
          [ [four[0], four[3]], [four[1], four[2]] ],
          [ [four[0], four[1]], [four[2], four[3]] ],
          [ [four[0], four[2]], [four[1], four[3]] ],
        ];

        let best = null;
        let bestCost = 1e9;
        for (const [t1, t2] of combos) {
          const cost = splitPenalty(t1, t2);
          if (cost < bestCost) {
            bestCost = cost;
            best = [t1, t2];
          }
        }
        if (!best) continue;

        // lock these four
        for (const p of four) used.add(p.id);

        return {
          team1: best[0],
          team2: best[1],
          team1Avg: avgTeam(best[0]),
          team2Avg: avgTeam(best[1]),
        };
      }
    }
    return null;
  }

  for (let c = 1; c <= maxCourts; c++) {
    const court = formCourt();
    if (!court) break;
    courts.push({ court: c, ...court });
  }

  return courts;
}

function buildWindowMatches(input) {
  const {
    present,
    maxCourts,
    roundNo,
    windowSize,
    lastPlayedMap,
    benchCountMap,
    lastRoundBenchedSet,
  } = input;

  const pool = present
    .slice()
    .sort(
      (a, b) =>
        fairnessScore(b) - fairnessScore(a) || a.name.localeCompare(b.name)
    );

  // Build a graph of possible links within current radius, expanding as needed
  function feasibleQuad(radius) {
    // Find top four that can be grouped within ±radius
    for (let i = 0; i < pool.length; i++) {
      const a = pool[i];
      if (!a || a.__used) continue;
      const group = [a];
      for (let j = i + 1; j < pool.length && group.length < 4; j++) {
        const b = pool[j];
        if (!b || b.__used) continue;
        if (Math.abs(a.skill_level - b.skill_level) <= radius) {
          group.push(b);
        }
      }
      if (group.length === 4) {
        // decide best split
        const [p0, p1, p2, p3] = group;
        const combos = [
          [[p0, p3], [p1, p2]],
          [[p0, p1], [p2, p3]],
          [[p0, p2], [p1, p3]],
        ];
        let best = null;
        let bestCost = 1e9;
        for (const [t1, t2] of combos) {
          const cost = splitPenalty(t1, t2);
          if (cost < bestCost) {
            bestCost = cost;
            best = [t1, t2];
          }
        }
        for (const p of group) p.__used = true;
        return {
          team1: best[0],
          team2: best[1],
          team1Avg: avgTeam(best[0]),
          team2Avg: avgTeam(best[1]),
        };
      }
    }
    return null;
  }

  const courts = [];
  let radius = windowSize ?? 2;
  for (let c = 1; c <= maxCourts; c++) {
    let court = feasibleQuad(radius);
    // expand gradually if we can't fill
    while (!court && radius < 10) {
      radius += 1;
      court = feasibleQuad(radius);
    }
    if (!court) break;
    courts.push({ court: c, ...court });
  }

  // cleanup marks
  for (const p of pool) delete p.__used;
  return courts;
}

/**
 * buildMatches(input)
 * input = {
 *   present, maxCourts, mode: 'band'|'window', windowSize,
 *   roundNo, lastPlayedMap, benchCountMap, lastRoundBenchedSet
 * }
 */
export function buildMatches(input) {
  const mode = input.mode || 'band';
  if (mode === 'window') return buildWindowMatches(input);
  return buildBandMatches(input);
}

// -------------------- Analytics / diagnostics --------------------

export function fairnessStats(sessionRounds, presentIdSet) {
  // count per player played & benched
  const playedMap = new Map();
  const benchedMap = new Map();

  for (const id of presentIdSet) {
    playedMap.set(id, 0);
    benchedMap.set(id, 0);
  }

  for (const r of sessionRounds) {
    const onCourt = new Set();
    for (const m of r.matches) {
      for (const p of [...m.team1, ...m.team2]) {
        onCourt.add(p.id);
      }
    }
    for (const id of presentIdSet) {
      if (onCourt.has(id)) {
        playedMap.set(id, (playedMap.get(id) || 0) + 1);
      } else {
        benchedMap.set(id, (benchedMap.get(id) || 0) + 1);
      }
    }
  }

  const playedArr = [...playedMap.values()];
  const meanPlayed =
    playedArr.reduce((s, x) => s + x, 0) / (playedArr.length || 1);
  const sdPlayed = Math.sqrt(
    (playedArr.reduce((s, x) => s + (x - meanPlayed) ** 2, 0) /
      (playedArr.length || 1)) || 0
  );
  const spread =
    (playedArr.length ? Math.max(...playedArr) - Math.min(...playedArr) : 0) ||
    0;
  const fairnessRatio = meanPlayed ? sdPlayed / meanPlayed : 0;

  return { playedMap, benchedMap, meanPlayed, sdPlayed, spread, fairnessRatio };
}

export function roundDiagnostics(sessionRounds) {
  const buildTimes = [];
  const usedCourts = [];
  const diffs = []; // team avg diffs
  const oobCounts = []; // not critical here, placeholder to keep UI happy

  for (const r of sessionRounds) {
    const ms = r.meta?.buildMs;
    if (typeof ms === 'number') buildTimes.push(ms);
    usedCourts.push(r.matches.length);
    for (const m of r.matches) {
      diffs.push(Math.abs((m.team1Avg || 0) - (m.team2Avg || 0)));
    }
    oobCounts.push(0); // we can compute band-expansion counts if needed later
  }
  return { buildTimes, usedCourts, diffs, oobCounts };
}

export function countBackToBackBenches(playerId, sessionRounds) {
  let best = 0;
  let cur = 0;
  for (const r of sessionRounds) {
    const on = r.matches.some(
      (m) =>
        m.team1.some((p) => p.id === playerId) ||
        m.team2.some((p) => p.id === playerId)
    );
    if (on) cur = 0;
    else cur++;
    if (cur > best) best = cur;
  }
  return best;
}

export function perPlayerUniq(playerId, sessionRounds) {
  const teamSet = new Set();
  const oppSet = new Set();
  for (const r of sessionRounds) {
    for (const m of r.matches) {
      const onT1 = m.team1.some((p) => p.id === playerId);
      const onT2 = m.team2.some((p) => p.id === playerId);
      if (!onT1 && !onT2) continue;
      const myTeam = onT1 ? m.team1 : m.team2;
      const oppTeam = onT1 ? m.team2 : m.team1;
      for (const p of myTeam) if (p.id !== playerId) teamSet.add(p.id);
      for (const p of oppTeam) oppSet.add(p.id);
    }
  }
  return { uniqTeammates: teamSet.size, uniqOpponents: oppSet.size };
}
