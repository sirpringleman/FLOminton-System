// src/logic.js

export function formatTime(totalSeconds) {
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`
}

/**
 * Select who plays fairly:
 * - Hard constraint: no one benches twice before everyone benches once (where possible)
 * - Priority: highest bench_count first (those who sat more play next)
 * - Tie-break: who benched last round, then random
 */
export function selectPlayersForRound(present, roundNumber, lastRoundBenchedSet = new Set()) {
  const copy = present.map(p => ({ ...p }))

  // Sort by fairness priority
  copy.sort((a, b) => {
    // More benched → higher priority
    if ((b.bench_count ?? 0) !== (a.bench_count ?? 0)) {
      return (b.bench_count ?? 0) - (a.bench_count ?? 0)
    }
    // If both recently benched last round, prefer them slightly to play
    const aBenchedLast = lastRoundBenchedSet.has(a.id) ? 1 : 0
    const bBenchedLast = lastRoundBenchedSet.has(b.id) ? 1 : 0
    if (aBenchedLast !== bBenchedLast) return bBenchedLast - aBenchedLast
    // Otherwise random
    return Math.random() - 0.5
  })

  // Choose up to 16 to play (or all if <16 but >=4)
  const target = Math.min(16, Math.max(4, copy.length))
  const playing = copy.slice(0, target)
  const playingIds = new Set(playing.map(p => p.id))
  const benched = copy.filter(p => !playingIds.has(p.id))

  return { playing, benched }
}

/**
 * Build 4 doubles matches from 16 players:
 * - Prefer forming within +/-2 skill bands
 * - If not possible, minimize difference between team averages
 * - Keep teams of 2 vs 2
 */
export function buildMatchesFrom16(playing, teammateHistoryMap = new Map()) {
  // Sort by skill to help grouping
  const pool = [...playing].sort((a,b) => (b.skill_level||0) - (a.skill_level||0))
  const matches = []

  // Helper to take and remove by index
  const take = (arr, i) => arr.splice(i,1)[0]

  // Try to make 4 courts
  for (let court = 1; court <= 4 && pool.length >= 4; court++) {
    // Try to find four players within ±2 if we can
    let group = tryBandGroup(pool, 2)
    if (!group) {
      group = tryBandGroup(pool, 3) || pool.splice(0,4) // stretch gradually
    }

    // Now split 4 into 2v2 to balance team averages
    const teamSplit = bestTeamSplit(group)
    matches.push({
      court,
      team1: teamSplit.t1,
      team2: teamSplit.t2,
      avg1: avg(teamSplit.t1),
      avg2: avg(teamSplit.t2),
    })
  }

  return matches

  // ---- helpers
  function tryBandGroup(arr, band) {
    if (arr.length < 4) return null
    for (let i=0;i<=arr.length-4;i++) {
      const a = arr[i]
      // find three others within band
      const groupIdx = [i]
      for (let j=i+1;j<arr.length && groupIdx.length<4;j++) {
        if (Math.abs((arr[j].skill_level||0) - (a.skill_level||0)) <= band) {
          groupIdx.push(j)
        }
      }
      if (groupIdx.length === 4) {
        // extract by descending indices to avoid reindex issues
        const picked = groupIdx.sort((x,y)=>y-x).map(idx => take(arr, idx)).reverse()
        return picked
      }
    }
    return null
  }

  function bestTeamSplit(four) {
    // all splits of [a,b,c,d] into [2,2] (3 combos)
    const [a,b,c,d] = four
    const options = [
      [ [a,b], [c,d] ],
      [ [a,c], [b,d] ],
      [ [a,d], [b,c] ],
    ]
    let best = options[0]
    let bestDiff = Math.abs(avg(options[0][0]) - avg(options[0][1]))
    for (let k=1;k<options.length;k++) {
      const diff = Math.abs(avg(options[k][0]) - avg(options[k][1]))
      if (diff < bestDiff) { best = options[k]; bestDiff = diff }
    }
    return { t1: best[0], t2: best[1] }
  }

  function avg(team) {
    return team.reduce((s,p)=>s+(p.skill_level||0),0) / team.length
  }
}