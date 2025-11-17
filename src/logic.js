// src/logic.js
// FLOMINTON ELO + MATCHMAKING LOGIC (v2)
//
// Exports:
//  - selectPlayersForRound(presentPlayers, roundNumber, lastRoundBenchedSet, courtCount)
//  - buildMatchesFrom16(players, teammateHistory, courtCount)
//  - applyMatchResults(matches, winners, players, kFactor)
//  - applyAttendanceForSession(matches, players, attendedSet)
//  - resetAllStats(players)
//  - formatTime(seconds)
//
// Notes:
//  - ELO-based grouping using a window starting at 200 and expanding up to 500
//  - Balanced pairing inside each quad (low+high vs mid+mid)
//  - ELO update uses a K-factor (configurable from Settings)
//  - Win-streak bonus (up to +20% gain)
//  - Loss-streak extra penalty for players ≥ 2000 ELO (up to +20% loss)
//  - Attendance increments on first match in a session

/* ============================================================
   HELPERS
   ============================================================ */

   const START_ELO_WINDOW = 200;
   const MAX_ELO_WINDOW = 500;
   const ELO_WINDOW_STEP = 25;
   
   const BASE_ELO = 1000;
   
   const REMATCH_MEMORY = 10; // not heavily used now, but kept for future teammate tracking
   
   const by = (fn) => (a, b) => {
     const va = fn(a);
     const vb = fn(b);
     if (va < vb) return -1;
     if (va > vb) return 1;
     return 0;
   };
   
   function chunk(arr, size) {
     const out = [];
     for (let i = 0; i < arr.length; i += size) {
       out.push(arr.slice(i + 0, i + size));
     }
     return out;
   }
   
   function addPair(a, b, map) {
     if (!map.has(a.id)) map.set(a.id, new Set());
     if (!map.has(b.id)) map.set(b.id, new Set());
     map.get(a.id).add(b.id);
     map.get(b.id).add(a.id);
   }
   
   function trimHistory(map, maxSize) {
     // placeholder for future more complex teammate-history limiting
     return map;
   }
   
   /* ============================================================
      TIME FORMATTER
      ============================================================ */
   
   export function formatTime(seconds) {
     const s = Math.max(0, Math.floor(seconds));
     const m = Math.floor(s / 60);
     const r = s % 60;
     return `${m.toString().padStart(2, "0")}:${r.toString().padStart(2, "0")}`;
   }
   
   /* ============================================================
      PLAYER SELECTION (WHO PLAYS THIS ROUND)
      ============================================================ */
   /**
    * presentPlayers: array of player objects (with bench_count, last_played_round)
    * roundNumber: current round index (1-based)
    * lastRoundBenchedSet: Set of ids benched last round (currently unused, but API-compatible)
    * courtCount: desired number of courts
    *
    * Returns:
    *   { playing: Player[], benched: Player[] }
    */
   export function selectPlayersForRound(
     presentPlayers,
     roundNumber,
     lastRoundBenchedSet,
     courtCount
   ) {
     const neededPlayers = courtCount * 4;
     if (presentPlayers.length <= neededPlayers) {
       return {
         playing: presentPlayers.slice(),
         benched: [],
       };
     }
   
     // Clone and ensure defaults
     const players = presentPlayers.map((p) => ({
       ...p,
       bench_count: p.bench_count || 0,
       last_played_round: p.last_played_round || 0,
     }));
   
     // Sort by: bench_count ASC, last_played_round ASC, name ASC
     const sorted = players.slice().sort((a, b) => {
       if (a.bench_count !== b.bench_count) {
         return a.bench_count - b.bench_count;
       }
       if (a.last_played_round !== b.last_played_round) {
         return a.last_played_round - b.last_played_round;
       }
       return a.name.localeCompare(b.name);
     });
   
     const playing = sorted.slice(0, neededPlayers);
     const benched = sorted.slice(neededPlayers);
   
     // Update bench_count + last_played_round in playing/benched arrays only.
     // (App is responsible for persisting these if desired.)
     for (const p of playing) {
       p.last_played_round = roundNumber;
     }
     for (const p of benched) {
       p.bench_count = (p.bench_count || 0) + 1;
     }
   
     return { playing, benched };
   }
   
   /* ============================================================
      GROUPING ENGINE — ELO WINDOW MODE
      ============================================================ */
   /**
    * Build matches (courts) from selected players.
    * Input array should have at least 4 players.
    *
    *  - Groups players into quads using ELO window rules
    *  - Splits each quad into balanced teams (low+high vs mid+mid)
    *  - Applies basic duplicate-player safety
    *
    * teammateHistory param is kept for future enhancements; currently not used.
    */
   export function buildMatchesFrom16(players, teammateHistory = new Map(), courtCount = 4) {
     if (!players || players.length < 4) return [];
   
     // Sort by ELO ascending
     const sorted = players
       .map((p) => ({ ...p, elo_rating: p.elo_rating || BASE_ELO }))
       .sort(by((p) => p.elo_rating));
   
     const maxCourtsPossible = Math.floor(sorted.length / 4);
     const totalCourts = Math.min(courtCount, maxCourtsPossible);
   
     if (totalCourts <= 0) return [];
   
     // Try grouping with increasing ELO window
     let groups = [];
     for (
       let window = START_ELO_WINDOW;
       window <= MAX_ELO_WINDOW;
       window += ELO_WINDOW_STEP
     ) {
       groups = makeEloWindowGroups(sorted, totalCourts, window);
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
       const quad = g.slice().sort(by((p) => p.elo_rating));
   
       const team1 = [quad[0], quad[3]];
       const team2 = [quad[1], quad[2]];
   
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
   
   /**
    * Try to build `courtCount` groups of 4 players each
    * such that each group’s spread <= window.
    */
   function makeEloWindowGroups(sortedPlayers, courtCount, window) {
     const used = new Set();
     const groups = [];
   
     for (let i = 0; i < sortedPlayers.length && groups.length < courtCount; i++) {
       if (used.has(i)) continue;
   
       const root = sortedPlayers[i];
       const minElo = root.elo_rating;
       const picks = [i];
   
       // forward
       for (let j = i + 1; j < sortedPlayers.length && picks.length < 4; j++) {
         if (used.has(j)) continue;
         const candidate = sortedPlayers[j];
         if (candidate.elo_rating - minElo <= window) {
           picks.push(j);
         } else {
           break;
         }
       }
   
       // backward (fill remaining from the top of the list)
       for (let j = sortedPlayers.length - 1; j > i && picks.length < 4; j--) {
         if (used.has(j)) continue;
         const candidate = sortedPlayers[j];
         if (candidate.elo_rating - minElo <= window) {
           picks.push(j);
         }
       }
   
       if (picks.length >= 4) {
         picks.sort((a, b) => a - b);
         const quad = picks.slice(0, 4).map((ix) => sortedPlayers[ix]);
         for (const ix of picks.slice(0, 4)) used.add(ix);
         groups.push(quad);
       }
     }
   
     return groups;
   }
   
   /**
    * Ensures no duplicates appear in the court groups.
    * If duplicates found, rebuild groups via simple chunking.
    */
   function ensureUniqueAssignments(groups, originalPlayers) {
     const flat = groups.flat();
     const ids = flat.map((p) => p.id);
     const unique = new Set(ids);
   
     if (unique.size === ids.length) return groups;
   
     console.warn("[logic] Duplicate-player detected — applying fallback grouping.");
   
     const totalPlayers = groups.length * 4;
     const slice = originalPlayers.slice(0, totalPlayers).map((p) => ({
       ...p,
       elo_rating: p.elo_rating || BASE_ELO,
     }));
   
     return chunk(slice, 4);
   }
   
   /* ============================================================
      ELO CALCULATION
      ============================================================ */
   
   function getWinStreakMultiplier(winStreak) {
     if (winStreak >= 6) return 1.2;
     if (winStreak >= 5) return 1.15;
     if (winStreak >= 4) return 1.1;
     if (winStreak >= 3) return 1.05;
     return 1.0;
   }
   
   function getLossStreakPenalty(lossStreak) {
     if (lossStreak >= 6) return 1.2;
     if (lossStreak >= 5) return 1.15;
     if (lossStreak >= 4) return 1.1;
     if (lossStreak >= 3) return 1.05;
     return 1.0;
   }
   
   /**
    * Compute ELO delta for one player given the opponent average.
    *
    * K-factor: passed in; if missing, defaults to 32.
    */
   export function computeEloDelta(
     player,
     opponentAvgElo,
     didWin,
     winStreak,
     lossStreak,
     kFactor = 32
   ) {
     const rating = player.elo_rating || BASE_ELO;
     const opp = opponentAvgElo || BASE_ELO;
   
     const expected = 1 / (1 + Math.pow(10, (opp - rating) / 400));
     const score = didWin ? 1 : 0;
   
     let K = kFactor || 32;
   
     // Win streak bonus
     if (didWin) {
       const multi = getWinStreakMultiplier(winStreak);
       K *= multi;
     }
   
     // Loss streak extra penalty for players ≥ 2000 ELO
     if (!didWin && rating >= 2000) {
       const multi = getLossStreakPenalty(lossStreak);
       K *= multi;
     }
   
     const delta = K * (score - expected);
     return delta;
   }
   
   /* ============================================================
      MATCH RESULT APPLICATION (ELO UPDATES)
      ============================================================ */
   /**
    * Given matches + winners, returns updated players array.
    *
    * matches: [{ court, team1:[players], team2:[players], avg1, avg2 }]
    * winners: { [courtNumber]: "team1" | "team2" }
    * players: full players array (from DB / app state)
    * kFactor: numeric K value from settings
    */
   export function applyMatchResults(matches, winners, players, kFactor = 32) {
     const updated = players.map((p) => ({
       ...p,
       elo_rating: p.elo_rating || BASE_ELO,
       wins: p.wins || 0,
       losses: p.losses || 0,
       matches_played: p.matches_played || 0,
       win_streak: p.win_streak || 0,
       loss_streak: p.loss_streak || 0,
       elo_delta_session: p.elo_delta_session || 0,
       elo_delta_total: p.elo_delta_total || 0,
       attendance_count: p.attendance_count || 0,
     }));
   
     const indexById = Object.fromEntries(updated.map((p, idx) => [p.id, idx]));
   
     for (const match of matches) {
       const decision = winners[match.court];
       if (!decision) continue;
   
       const team1 = match.team1;
       const team2 = match.team2;
   
       const t1Win = decision === "team1";
       const t2Win = !t1Win;
   
       const team1Avg = match.avg1;
       const team2Avg = match.avg2;
   
       // Update team1 players
       for (const p of team1) {
         const idx = indexById[p.id];
         if (idx == null) continue;
         const ref = updated[idx];
   
         const didWin = t1Win;
         const delta = computeEloDelta(
           ref,
           team2Avg,
           didWin,
           ref.win_streak,
           ref.loss_streak,
           kFactor
         );
   
         ref.elo_rating = Math.round(ref.elo_rating + delta);
         ref.elo_delta_session += delta;
         ref.elo_delta_total += delta;
         ref.matches_played += 1;
         ref.last_seen_at = new Date().toISOString();
   
         if (didWin) {
           ref.wins += 1;
           ref.win_streak += 1;
           ref.loss_streak = 0;
         } else {
           ref.losses += 1;
           ref.loss_streak += 1;
           ref.win_streak = 0;
         }
       }
   
       // Update team2 players
       for (const p of team2) {
         const idx = indexById[p.id];
         if (idx == null) continue;
         const ref = updated[idx];
   
         const didWin = t2Win;
         const delta = computeEloDelta(
           ref,
           team1Avg,
           didWin,
           ref.win_streak,
           ref.loss_streak,
           kFactor
         );
   
         ref.elo_rating = Math.round(ref.elo_rating + delta);
         ref.elo_delta_session += delta;
         ref.elo_delta_total += delta;
         ref.matches_played += 1;
         ref.last_seen_at = new Date().toISOString();
   
         if (didWin) {
           ref.wins += 1;
           ref.win_streak += 1;
           ref.loss_streak = 0;
         } else {
           ref.losses += 1;
           ref.loss_streak += 1;
           ref.win_streak = 0;
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
    * Returns:
    *   { updatedPlayers, updatedAttendanceSet }
    */
   export function applyAttendanceForSession(matches, players, attendedSet) {
     const updated = players.map((p) => ({
       ...p,
       attendance_count: p.attendance_count || 0,
     }));
     const indexById = Object.fromEntries(updated.map((p, idx) => [p.id, idx]));
   
     const appearingNow = new Set();
   
     for (const match of matches) {
       const all = [...match.team1, ...match.team2];
       for (const p of all) {
         if (p && p.id != null) {
           appearingNow.add(p.id);
         }
       }
     }
   
     const newSet = new Set(attendedSet);
   
     for (const id of appearingNow) {
       if (!newSet.has(id)) {
         const idx = indexById[id];
         if (idx != null) {
           updated[idx].attendance_count += 1;
         }
         newSet.add(id);
       }
     }
   
     return { updatedPlayers: updated, updatedAttendanceSet: newSet };
   }
   
   /* ============================================================
      RESET HELPERS (ADMIN ONLY)
      ============================================================ */
   /**
    * Returns a version of players array with ALL stats reset.
    * (Used only for “Reset All Stats” admin action)
    */
   export function resetAllStats(players) {
     return players.map((p) => ({
       ...p,
       elo_rating: BASE_ELO,
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
       // keep: name, gender, handedness, notes, status, is_present
     }));
   }
   
   /* ============================================================
      DEFAULT EXPORT (OPTIONAL)
      ============================================================ */
   
   export default {
     selectPlayersForRound,
     buildMatchesFrom16,
     applyMatchResults,
     applyAttendanceForSession,
     resetAllStats,
     formatTime,
     computeEloDelta,
   };
   