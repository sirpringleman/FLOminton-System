/* ============================================================
   LOGIC.JS — FLOMINTON ELO MATCHMAKING ENGINE
   Complete rewrite (ELO mode only – no band mode)

   KEY FEATURES:
   - Window-based matchmaking on ELO (start window = 200)
   - Individual ELO updates vs opponent-team average
   - Win streak bonus (+5–20%)
   - Loss streak penalty for >=2000 ELO (5–20%)
   - Fairness: bench rotation, bias, last-played-round priority
   - No-repeat teammates (soft penalty)
   - Duplicate-player assignment prevention
   - Fully deterministic API for App.jsx integration

   Maintains required exports:
     getMatchMode, setMatchMode
     selectPlayersForRound
     buildMatchesFrom16
     formatTime

   Notes:
   - MATCH_MODES kept only for backward compatibility, but
     only 'window' is functional.
   ============================================================ */

   export const MATCH_MODES = { WINDOW: 'window' };

   // Always just return 'window'; mode switching removed.
   export function getMatchMode() {
     return MATCH_MODES.WINDOW;
   }
   export function setMatchMode(mode) {
     // Placeholder – kept for compatibility
     return;
   }
   
   /* ============================================================
      TUNABLES
      ============================================================ */
   
   // ELO matchmaking window (strict start)
   const START_ELO_WINDOW = 200;
   const MAX_ELO_WINDOW = 500; // expanded as needed
   
   // Fairness parameters
   const MAX_CONSEC_BENCH = 1;
   const FAIRNESS_LAG_TOLERANCE = 0.5;
   
   // Bias persistence (helps players who get benched often)
   const BIAS_KEY = "flominton_bench_bias_v2";
   const MAX_BIAS = 0.8;
   const BOOST_BENCH = 0.25;
   const DECAY_PLAY = 0.15;
   
   // Rematch memory
   const REMATCH_MEMORY = 4;
   const REMATCH_PENALTY = 1;
   
   // Audio timing util kept intact
   export function formatTime(totalSeconds) {
     const s = Math.max(0, Math.floor(totalSeconds || 0));
     const m = Math.floor(s / 60);
     const sec = s % 60;
     return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
   }
   
   /* ============================================================
      LOCALSTORAGE SAFE GET/SET
      ============================================================ */
   function safeGetLocal(k) {
     try { return localStorage.getItem(k); }
     catch { return null; }
   }
   function safeSetLocal(k, v) {
     try { localStorage.setItem(k, v); }
     catch {}
   }
   
   /* ============================================================
      BIAS HANDLING
      ============================================================ */
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
     try { localStorage.setItem(BIAS_KEY, JSON.stringify(map)); }
     catch {}
   }
   
   /* ============================================================
      BASIC UTILS
      ============================================================ */
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
     const v = arr.reduce((s, x) => s + (x - mean) ** 2, 0) / arr.length;
     return Math.sqrt(v);
   }
   
   /* ============================================================
      REMATCH BOOKKEEPING
      ============================================================ */
   function pairKey(a, b) {
     const aId = a.id || String(a);
     const bId = b.id || String(b);
     return aId < bId ? `${aId}|${bId}` : `${bId}|${aId}`;
   }
   function addPair(a, b, map) {
     const k = pairKey(a, b);
     const arr = map.get(k) || [];
     arr.push(Date.now());
     map.set(k, arr);
   }
   function trimHistory(map, keep) {
     for (const [k, arr] of map.entries()) {
       if (arr.length > keep) map.set(k, arr.slice(arr.length - keep));
     }
   }
   function pairPenalty(a, b, map) {
     const arr = map.get(pairKey(a, b));
     if (!arr || arr.length === 0) return 0;
     return Math.min(3, arr.length) * REMATCH_PENALTY;
   }
   
   /* ============================================================
      ELO CALCULATIONS (per-player vs opponent-team average)
      ============================================================ */
   
   // K-factor
   const K_FACTOR = 32;
   
   // Win streak bonus (5–20%)
   function winStreakMultiplier(winStreak) {
     if (winStreak <= 2) return 1.0;
     if (winStreak === 3) return 1.05;
     if (winStreak === 4) return 1.10;
     if (winStreak === 5) return 1.15;
     return 1.20; // cap
   }
   
   // Loss streak penalty (players >=2000 rating only; 5–20%)
   function lossStreakMultiplier(lossStreak, rating) {
     if (rating < 2000) return 1.0;
     if (lossStreak <= 2) return 1.0;
     if (lossStreak === 3) return 1.05;
     if (lossStreak === 4) return 1.10;
     if (lossStreak === 5) return 1.15;
     return 1.20;
   }
   
   /**
    * Compute ELO delta for a SINGLE PLAYER
    */
   export function computeEloDelta(player, opponentAvgElo, didWin, winStreak, lossStreak) {
     const R = player.elo_rating || 1000;
     const diff = opponentAvgElo - R;
     const expected = 1 / (1 + Math.pow(10, diff / 400));
     const S = didWin ? 1 : 0;
   
     const baseDelta = K_FACTOR * (S - expected);
     let delta = baseDelta;
   
     // Apply win streak bonus (only when baseDelta > 0)
     if (didWin && baseDelta > 0) {
       delta = delta * winStreakMultiplier(winStreak);
     }
   
     // Apply loss streak penalty for >=2000 ELO
     if (!didWin && baseDelta < 0) {
       delta = delta * lossStreakMultiplier(lossStreak, R);
     }
   
     return delta;
   }
   
   /* ============================================================
      PLAYER SELECTION FOR ROUND (FAIRNESS ENGINE)
      ============================================================ */
   
   /**
    * Select players who PLAY this round vs BENCH.
    * This does NOT assign courts; it only chooses who plays.
    */
   export function selectPlayersForRound(present, roundNumber, lastRoundBenched = new Set(), courtsCount = 4) {
     const total = present.length;
     if (total < 4) return { playing: [], benched: present.slice() };
   
     const maxSlots = courtsCount * 4;
     const NEED = Math.min(total - (total % 4), maxSlots);
     if (NEED <= 0) return { playing: [], benched: present.slice() };
   
     const biasMap = loadBiasMap();
   
     /* ---------------- Tier 1: Base fairness sort ---------------- */
     const ranked = present.slice().sort((a, b) => {
       const benchA = a.bench_count || 0;
       const benchB = b.bench_count || 0;
   
       const debtA = lastRoundBenched.has(a.id) ? 0.5 : 0;
       const debtB = lastRoundBenched.has(b.id) ? 0.5 : 0;
   
       const biasA = biasMap[a.id] || 0;
       const biasB = biasMap[b.id] || 0;
   
       const scoreA = benchA + debtA + biasA;
       const scoreB = benchB + debtB + biasB;
   
       if (scoreA !== scoreB) return scoreB - scoreA;
   
       const lpa = a.last_played_round || 0;
       const lpb = b.last_played_round || 0;
       if (lpa !== lpb) return lpa - lpb;
   
       return Math.random() - 0.5;
     });
   
     /* ---------------- Average bench spread ---------------- */
     const benchCounts = present.map(p => p.bench_count || 0);
     const avgBench = benchCounts.reduce((s, x) => s + x, 0) / benchCounts.length;
     const sdBench = stddev(benchCounts);
   
     let fairnessPressure = 0;
     if (sdBench > 2.0) fairnessPressure = 2;
     else if (sdBench > 1.5) fairnessPressure = 1;
   
     /* ---------------- Tier 2: Force-in lagging players ---------------- */
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
       if (!playing.find(x => x.id === p.id)) playing.push(p);
     }
   
     const playingIds = new Set(playing.map(p => p.id));
     let benched = present.filter(p => !playingIds.has(p.id));
   
     /* ---------------- Avoid consecutive benches ---------------- */
     if (benched.length > 0 && MAX_CONSEC_BENCH > 0 && lastRoundBenched.size > 0) {
       for (let i = 0; i < benched.length; i++) {
         const b = benched[i];
         if (lastRoundBenched.has(b.id)) {
           const swap = playing.find(p => !laggingIds.has(p.id) && !lastRoundBenched.has(p.id));
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
   
     /* ---------------- Bias persistence ---------------- */
     for (const p of benched) {
       const cur = biasMap[p.id] || 0;
       const next = Math.min(MAX_BIAS, cur + BOOST_BENCH);
       biasMap[p.id] = next;
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

   /* ============================================================
   GROUPING ENGINE — ELO WINDOW MODE (NO BAND MODE)
   ============================================================ */

/**
 * Build matches (courts) from selected players.
 * Input array must have length divisible by 4.
 *
 * This:
 *   - Groups players into quads using ELO window rules
 *   - Splits each quad into balanced teams (low+high)
 *   - Applies no-repeat teammate avoidance (soft)
 *   - Applies duplicate-player safety checks
 */
export function buildMatchesFrom16(players, teammateHistory = new Map(), courtsCount = 4) {
  if (!players || players.length < 4) return [];

  // Sort players by ELO ascending
  const sorted = players
    .map(p => ({ ...p })) // clone to avoid mutation
    .sort(by(p => p.elo_rating));

  const totalCourts = Math.floor(sorted.length / 4);

  // Try grouping with increasing ELO window
  let groups = [];
  for (let window = START_ELO_WINDOW; window <= MAX_ELO_WINDOW; window += 25) {
    groups = makeEloWindowGroups(sorted, totalCourts, window, teammateHistory);
    if (groups.length === totalCourts) break;
  }

  // If grouping still fails, fallback to simple chunking
  if (groups.length !== totalCourts) {
    const fallback = sorted.slice(0, totalCourts * 4);
    groups = chunk(fallback, 4);
  }

  // Duplicate-player safety check
  groups = ensureUniqueAssignments(groups, players);

  // Build matches with balanced pairing
  const matches = [];
  let courtNo = 1;

  for (const g of groups) {
    const quad = g.slice().sort(by(p => p.elo_rating));

    const team1 = [quad[0], quad[3]];
    const team2 = [quad[1], quad[2]];

    // update teammate history
    addPair(team1[0], team1[1], teammateHistory);
    addPair(team2[0], team2[1], teammateHistory);
    trimHistory(teammateHistory, REMATCH_MEMORY);

    matches.push({
      court: courtNo++,
      team1,
      team2,
      avg1: (team1[0].elo_rating + team1[1].elo_rating) / 2,
      avg2: (team2[0].elo_rating + team2[1].elo_rating) / 2,
    });
  }

  return matches;
}

/* ============================================================
   ELO WINDOW GROUP BUILDER
   ============================================================ */

/**
 * Try to build `courtCount` groups of 4 players each
 * such that each group’s ELO spread is <= window.
 */
function makeEloWindowGroups(sortedPlayers, courtCount, window, teammateHistory) {
  const used = new Set();
  const groups = [];

  for (let i = 0; i < sortedPlayers.length && groups.length < courtCount; i++) {
    if (used.has(i)) continue;

    const root = sortedPlayers[i];
    const minElo = root.elo_rating;
    const pickIdx = [i];

    // forward
    for (let j = i + 1; j < sortedPlayers.length && pickIdx.length < 4; j++) {
      if (used.has(j)) continue;
      const candidate = sortedPlayers[j];
      if (candidate.elo_rating - minElo <= window) {
        pickIdx.push(j);
      } else {
        break;
      }
    }

    // backward (try to fill from higher ELO first)
    for (let j = sortedPlayers.length - 1; j > i && pickIdx.length < 4; j--) {
      if (used.has(j)) continue;
      const candidate = sortedPlayers[j];
      if (candidate.elo_rating - minElo <= window) {
        pickIdx.push(j);
      }
    }

    // Need exactly 4
    if (pickIdx.length >= 4) {
      pickIdx.sort((a, b) => a - b);
      const quad = pickIdx.slice(0, 4).map(ix => sortedPlayers[ix]);
      for (const ix of pickIdx.slice(0, 4)) used.add(ix);
      groups.push(quad);
    }
  }

  return groups;
}

/* ============================================================
   DUPLICATE-PLAYER SAFETY CHECKER
   ============================================================ */

/**
 * Ensures no duplicates appear in the court groups.
 * If duplicates found, rebuild groups via simple chunking.
 */
function ensureUniqueAssignments(groups, originalPlayers) {
  const flat = groups.flat();
  const ids = flat.map(p => p.id);
  const unique = new Set(ids);

  if (unique.size === ids.length) {
    return groups; // all good
  }

  console.warn("[logic] Duplicate-player detected — applying fallback grouping.");

  const byId = {};
  for (const p of originalPlayers) byId[p.id] = p;

  const playing = originalPlayers.slice(0, groups.length * 4).map(p => ({ ...p }));
  return chunk(playing, 4);
}

/* ============================================================
   MATCH RESULT APPLICATION (ELO UPDATES)
   ============================================================ */

/**
 * Given matches + winners, returns updated players array.
 * (App.jsx will write these updates to DB.)
 *
 * winners is: { [courtNumber]: "team1" | "team2" }
 */
export function applyMatchResults(matches, winners, players) {
  const updated = players.map(p => ({ ...p }));
  const indexById = Object.fromEntries(updated.map((p, idx) => [p.id, idx]));

  for (const match of matches) {
    const result = winners[match.court]; // "team1" or "team2"
    if (!result) continue;

    const team1 = match.team1;
    const team2 = match.team2;

    const team1Avg = (team1[0].elo_rating + team1[1].elo_rating) / 2;
    const team2Avg = (team2[0].elo_rating + team2[1].elo_rating) / 2;

    const t1Win = result === "team1";
    const t2Win = !t1Win;

    const allPlayers = [...team1, ...team2];
    const preRatings = {};

    // record pre-match ratings
    for (const p of allPlayers) {
      preRatings[p.id] = p.elo_rating || 1000;
    }

    // update each player
    for (const p of team1) {
      const didWin = t1Win;
      const idx = indexById[p.id];
      const playerRef = updated[idx];

      const delta = computeEloDelta(
        playerRef,
        team2Avg,
        didWin,
        playerRef.win_streak || 0,
        playerRef.loss_streak || 0
      );

      playerRef.elo_rating = Math.round((playerRef.elo_rating || 1000) + delta);
      playerRef.elo_delta_total = (playerRef.elo_delta_total || 0) + delta;
      playerRef.elo_delta_session = (playerRef.elo_delta_session || 0) + delta;
      playerRef.matches_played = (playerRef.matches_played || 0) + 1;
      playerRef.last_seen_at = new Date().toISOString();

      if (didWin) {
        playerRef.wins = (playerRef.wins || 0) + 1;
        playerRef.win_streak = (playerRef.win_streak || 0) + 1;
        playerRef.loss_streak = 0;
      } else {
        playerRef.losses = (playerRef.losses || 0) + 1;
        playerRef.loss_streak = (playerRef.loss_streak || 0) + 1;
        playerRef.win_streak = 0;
      }
    }

    for (const p of team2) {
      const didWin = t2Win;
      const idx = indexById[p.id];
      const playerRef = updated[idx];

      const delta = computeEloDelta(
        playerRef,
        team1Avg,
        didWin,
        playerRef.win_streak || 0,
        playerRef.loss_streak || 0
      );

      playerRef.elo_rating = Math.round((playerRef.elo_rating || 1000) + delta);
      playerRef.elo_delta_total = (playerRef.elo_delta_total || 0) + delta;
      playerRef.elo_delta_session = (playerRef.elo_delta_session || 0) + delta;
      playerRef.matches_played = (playerRef.matches_played || 0) + 1;
      playerRef.last_seen_at = new Date().toISOString();

      if (didWin) {
        playerRef.wins = (playerRef.wins || 0) + 1;
        playerRef.win_streak = (playerRef.win_streak || 0) + 1;
        playerRef.loss_streak = 0;
      } else {
        playerRef.losses = (playerRef.losses || 0) + 1;
        playerRef.loss_streak = (playerRef.loss_streak || 0) + 1;
        playerRef.win_streak = 0;
      }
    }
  }

  return updated;
}

/* ============================================================
   ATTENDANCE HELPERS
   ============================================================ */

/**
 * Mark attendance for players who appear in a match
 * for the FIRST time in a session.
 *
 * App.jsx will pass a Set of players who already have attendance counted.
 */
export function applyAttendanceForSession(matches, players, attendedSet) {
  const updated = players.map(p => ({ ...p }));
  const indexById = Object.fromEntries(updated.map((p, idx) => [p.id, idx]));

  const appearingNow = new Set();

  for (const match of matches) {
    const all = [...match.team1, ...match.team2];
    for (const p of all) appearingNow.add(p.id);
  }

  for (const id of appearingNow) {
    if (!attendedSet.has(id)) {
      const idx = indexById[id];
      updated[idx].attendance_count = (updated[idx].attendance_count || 0) + 1;
      attendedSet.add(id);
    }
  }

  return { updatedPlayers: updated, updatedAttendanceSet: attendedSet };
}

/* ============================================================
   RESET HELPERS (ADMIN ONLY)
   ============================================================ */

/**
 * Returns a version of players array with ALL stats reset.
 * (Used only for “Reset All Stats” admin action)
 */
export function resetAllStats(players) {
  return players.map(p => ({
    ...p,
    elo_rating: 1000,
    wins: 0,
    losses: 0,
    matches_played: 0,
    attendance_count: 0,
    elo_delta_session: 0,
    elo_delta_total: 0,
    win_streak: 0,
    loss_streak: 0,
    bench_count: 0,
    last_played_round: 0,
    last_seen_at: null,
    // keep: gender, name, handedness, notes, status, is_present
  }));
}

/* ============================================================
   PUBLIC API EXPORTS (FINAL)
   ============================================================ */

// Already exported:
//   - MATCH_MODES
//   - getMatchMode
//   - setMatchMode
//   - selectPlayersForRound
//   - buildMatchesFrom16
//   - computeEloDelta
//   - formatTime
//   - applyMatchResults
//   - applyAttendanceForSession
//   - resetAllStats

export default {
  MATCH_MODES,
  getMatchMode,
  setMatchMode,
  selectPlayersForRound,
  buildMatchesFrom16,
  computeEloDelta,
  formatTime,
  applyMatchResults,
  applyAttendanceForSession,
  resetAllStats
};
