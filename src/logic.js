// ---------- Helpers
const rand = () => Math.random()

export function formatTime(seconds) {
  const m = Math.floor(seconds / 60).toString().padStart(2,'0')
  const s = Math.floor(seconds % 60).toString().padStart(2,'0')
  return `${m}:${s}`
}

// key for teammate pair regardless of order
const pairKey = (a,b) => [a,b].sort().join('|')

// ---------- BENCH / PLAY SELECTION (FAIRNESS)
export function selectPlayersForRound(presentPlayers, roundNumber, lastRoundBenchedIds) {
  // Priority:
  // 1) highest bench_count first
  // 2) longest since last played (smaller last_played_round = higher priority)
  // 3) avoid back-to-back bench (i.e., prefer those who were benched last round)
  // 4) random tie-break
  const scored = presentPlayers.map(p => ({
    ...p,
    sinceLastPlayed: roundNumber - (p.last_played_round || 0),
    wasBenchedLastRound: lastRoundBenchedIds.has(p.id) ? 1 : 0
  }))

  scored.sort((a,b) => {
    // bench_count desc
    if (b.bench_count !== a.bench_count) return b.bench_count - a.bench_count
    // sinceLastPlayed desc
    if (b.sinceLastPlayed !== a.sinceLastPlayed) return b.sinceLastPlayed - a.sinceLastPlayed
    // prefer those who were benched last round
    if (b.wasBenchedLastRound !== a.wasBenchedLastRound) return b.wasBenchedLastRound - a.wasBenchedLastRound
    // random
    return rand() - 0.5
  })

  // pick top 16 to play
  const playing = scored.slice(0, 16)
  const playingIds = new Set(playing.map(p => p.id))

  const benched = presentPlayers.filter(p => !playingIds.has(p.id))
  return { playing, benched }
}

// ---------- GROUP INTO 4S (±2 band, expand if needed)
export function groupIntoFours(playing) {
  // sort by skill desc to sweep windows
  const sorted = [...playing].sort((a,b) => b.skill_level - a.skill_level)
  const groups = []

  const takeGroup = (indices) => {
    const picked = indices.map(i => sorted[i]).filter(Boolean)
    // remove them from sorted by marking
    indices.sort((a,b)=>b-a).forEach(i => sorted.splice(i,1))
    groups.push(picked)
  }

  // First pass: try windows where max-min <= 2
  const tryWindows = () => {
    let i = 0
    while (sorted.length >= 4 && groups.length < 4) {
      // Find a window of 4 with range <= 2
      let found = false
      for (let start = 0; start <= sorted.length - 4; start++) {
        const window = sorted.slice(start, start+4)
        const max = window[0].skill_level
        const min = window[3].skill_level
        if (max - min <= 2) {
          takeGroup([start, start+1, start+2, start+3])
          found = true
          break
        }
      }
      if (!found) break
    }
  }

  tryWindows()

  // If not enough groups, allow expansion: just take next 4 by proximity
  while (sorted.length >= 4 && groups.length < 4) {
    takeGroup([0,1,2,3])
  }

  return groups.slice(0,4)
}

// ---------- TEAM SPLIT (minimize average difference; also avoid recent teammates)
export function bestTeamSplit(group, teammateHistory) {
  // three unique splits for 4 items [0,1,2,3]:
  // (0,1) vs (2,3) | (0,2) vs (1,3) | (0,3) vs (1,2)
  const picks = [
    [[0,1],[2,3]],
    [[0,2],[1,3]],
    [[0,3],[1,2]]
  ]

  let best = null
  let bestScore = Infinity

  const scoreSplit = (g, split) => {
    const teamA = split[0].map(i => g[i])
    const teamB = split[1].map(i => g[i])
    const avgA = (teamA[0].skill_level + teamA[1].skill_level)/2
    const avgB = (teamB[0].skill_level + teamB[1].skill_level)/2
    const diff = Math.abs(avgA - avgB)

    // soft penalty for recent teammates
    const tAKey = pairKey(teamA[0].id, teamA[1].id)
    const tBKey = pairKey(teamB[0].id, teamB[1].id)
    const teammatePenalty = (teammateHistory.get(tAKey) || 0) + (teammateHistory.get(tBKey) || 0)

    return diff * 10 + teammatePenalty // weight avg diff strongly
  }

  for (const s of picks) {
    const sc = scoreSplit(group, s)
    if (sc < bestScore) {
      bestScore = sc
      best = s
    }
  }
  const teamA = best[0].map(i => group[i])
  const teamB = best[1].map(i => group[i])
  const avgA = (teamA[0].skill_level + teamA[1].skill_level)/2
  const avgB = (teamB[0].skill_level + teamB[1].skill_level)/2
  return { teamA, teamB, avgA, avgB }
}

export function buildMatchesFrom16(playing, teammateHistory) {
  const groups = groupIntoFours(playing)
  const matches = groups.map((g,i) => {
    const { teamA, teamB, avgA, avgB } = bestTeamSplit(g, teammateHistory)
    // update teammate history
    const k1 = pairKey(teamA[0].id, teamA[1].id)
    const k2 = pairKey(teamB[0].id, teamB[1].id)
    teammateHistory.set(k1, (teammateHistory.get(k1)||0)+1)
    teammateHistory.set(k2, (teammateHistory.get(k2)||0)+1)
    return { court: i+1, team1: teamA, team2: teamB, avg1: avgA, avg2: avgB }
  })
  return matches
}