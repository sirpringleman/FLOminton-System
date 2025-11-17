// src/Leaderboards.jsx
// FLOMINTON LEADERBOARDS PAGE
//
// Shows multiple leaderboard categories:
//   - Highest ELO
//   - Most Improved (Session)
//   - Most Improved (Lifetime)
//   - Most Wins
//   - Best Win%
//   - Attendance Hero
//   - Most Unique Teammates (via match_results)
//   - Most Unique Opponents
//   - Giant Killer (upset wins)
//   - Most Consistent (lowest ELO variance)
//
// Integrates with:
//   - /netlify/functions/players.js
//   - /netlify/functions/match_results.js

import React, { useEffect, useState } from "react";

const API_PLAYERS = "/.netlify/functions/players";
const API_RESULTS = "/.netlify/functions/match_results";

export default function Leaderboards() {
  const [players, setPlayers] = useState([]);
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(true);

  /* --------------------------------------------------------
     Load all data
     -------------------------------------------------------- */
  async function loadData() {
    setLoading(true);
    try {
      const pRes = await fetch(API_PLAYERS);
      const pJson = await pRes.json();

      const rRes = await fetch(`${API_RESULTS}?fetch=all`, {
        method: "GET"
      });
      let rJson = [];
      try {
        rJson = await rRes.json();
      } catch {
        rJson = [];
      }

      setPlayers(pJson || []);
      setResults(rJson || []);
    } catch (err) {
      console.error(err);
      alert("Failed to load leaderboard data.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadData();
  }, []);

  /* --------------------------------------------------------
     Utility helpers
     -------------------------------------------------------- */

  const pct = (n) => Math.round(n * 100);
  const by = (f) => (a, b) => f(b) - f(a);

  function getPlayerById(id) {
    return players.find((p) => p.id === id) || null;
  }

  /* ========================================================
     LEADERBOARDS CALCULATIONS
     ======================================================== */

  /* ---------------- Highest ELO ---------------- */
  const highestElo = players
    .slice()
    .sort(by((p) => p.elo_rating))
    .slice(0, 10);

  /* ---------------- Most Improved (Session) ---------------- */
  const mostImprovedSession = players
    .slice()
    .sort(by((p) => p.elo_delta_session || 0))
    .slice(0, 10);

  /* ---------------- Most Improved (Lifetime) ---------------- */
  const mostImprovedLifetime = players
    .slice()
    .sort(by((p) => p.elo_delta_total || 0))
    .slice(0, 10);

  /* ---------------- Most Wins ---------------- */
  const mostWins = players
    .slice()
    .sort(by((p) => p.wins || 0))
    .slice(0, 10);

  /* ---------------- Best Win% (min 10 matches) ---------------- */
  const bestWinPct = players
    .filter((p) => (p.matches_played || 0) >= 10)
    .map((p) => ({
      ...p,
      win_pct: p.matches_played ? p.wins / p.matches_played : 0
    }))
    .sort(by((p) => p.win_pct))
    .slice(0, 10);

  /* ---------------- Attendance Hero ---------------- */
  const attendanceHero = players
    .slice()
    .sort(by((p) => p.attendance_count || 0))
    .slice(0, 10);

  /* ---------------- History Aggregation ---------------- */

  // Build teammate/opponent maps
  const teammateMap = {}; // id -> Set of teammates
  const opponentMap = {}; // id -> Set of opponents
  const eloHistory = {}; // id -> array of elo_after values

  for (const p of players) {
    teammateMap[p.id] = new Set();
    opponentMap[p.id] = new Set();
    eloHistory[p.id] = [];
  }

  for (const row of results) {
    const current = getPlayerById(row.player_id);
    if (!current) continue;

    // Track elo progression
    if (row.elo_after !== undefined) {
      eloHistory[current.id].push(row.elo_after);
    }

    // Teammates / Opponents
    // We need to find all players in this match: same session, round, court
    const sameMatch = results.filter(
      (r) =>
        r.session_id === row.session_id &&
        r.round_number === row.round_number &&
        r.court_number === row.court_number
    );

    const myTeam = row.team;
    for (const r of sameMatch) {
      if (r.player_id === row.player_id) continue;

      if (r.team === myTeam) {
        teammateMap[row.player_id].add(r.player_id);
      } else {
        opponentMap[row.player_id].add(r.player_id);
      }
    }
  }

  /* ---------------- Most Unique Teammates ---------------- */
  const mostUniqueTeammates = players
    .map((p) => ({
      ...p,
      count: teammateMap[p.id]?.size || 0
    }))
    .sort(by((p) => p.count))
    .slice(0, 10);

  /* ---------------- Most Unique Opponents ---------------- */
  const mostUniqueOpponents = players
    .map((p) => ({
      ...p,
      count: opponentMap[p.id]?.size || 0
    }))
    .sort(by((p) => p.count))
    .slice(0, 10);

  /* ---------------- Giant Killer ---------------- */
  const giantKiller = players
    .map((p) => {
      const upsets = results.filter(
        (r) =>
          r.player_id === p.id &&
          r.result === "win" &&
          Number(r.elo_before) < Number(r.opponent_avg_elo)
      ).length;

      return { ...p, upsets };
    })
    .sort(by((p) => p.upsets))
    .slice(0, 10);

  /* ---------------- Most Consistent (lowest ELO variance) ---------------- */
  function variance(arr) {
    if (!arr.length) return Infinity;
    const mean = arr.reduce((s, x) => s + x, 0) / arr.length;
    const sq =
      arr.reduce((s, x) => s + Math.pow(x - mean, 2), 0) / arr.length;
    return sq;
  }

  const mostConsistent = players
    .map((p) => ({
      ...p,
      var: variance(eloHistory[p.id] || [])
    }))
    .filter((p) => p.var !== Infinity)
    .sort((a, b) => a.var - b.var)
    .slice(0, 10);

  /* --------------------------------------------------------
     RENDER PANEL COMPONENT
     -------------------------------------------------------- */

  function LeaderPanel({ title, list, renderItem }) {
    return (
      <div className="panel glass" style={{ marginBottom: 16 }}>
        <div className="panel-head">
          <h3>{title}</h3>
        </div>
        <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {list.map((p, i) => (
            <li
              key={p.id}
              style={{
                padding: "6px 0",
                borderBottom: "1px solid rgba(255,255,255,0.08)"
              }}
            >
              <b>{i + 1}.</b> {renderItem(p)}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  /* --------------------------------------------------------
     PAGE RENDER
     -------------------------------------------------------- */

  if (loading) {
    return (
      <div className="page centered">
        <div className="muted">Loading leaderboards…</div>
      </div>
    );
  }

  return (
    <div className="page" style={{ padding: "16px", maxWidth: "900px", margin: "0 auto" }}>
      <h2>Leaderboards</h2>

      {/* Highest ELO */}
      <LeaderPanel
        title="Highest ELO"
        list={highestElo}
        renderItem={(p) => `${p.name} — ${p.elo_rating}`}
      />

      {/* Most Improved Session */}
      <LeaderPanel
        title="Most Improved (Session)"
        list={mostImprovedSession}
        renderItem={(p) =>
          `${p.name} — ${p.elo_delta_session > 0 ? "+" : ""}${p.elo_delta_session}`
        }
      />

      {/* Most Improved Lifetime */}
      <LeaderPanel
        title="Most Improved (Lifetime)"
        list={mostImprovedLifetime}
        renderItem={(p) =>
          `${p.name} — ${p.elo_delta_total > 0 ? "+" : ""}${p.elo_delta_total}`
        }
      />

      {/* Most Wins */}
      <LeaderPanel
        title="Most Wins"
        list={mostWins}
        renderItem={(p) => `${p.name} — ${p.wins} wins`}
      />

      {/* Best Win% */}
      <LeaderPanel
        title="Best Win % (min 10 matches)"
        list={bestWinPct}
        renderItem={(p) => `${p.name} — ${pct(p.win_pct)}%`}
      />

      {/* Attendance Hero */}
      <LeaderPanel
        title="Attendance Hero"
        list={attendanceHero}
        renderItem={(p) => `${p.name} — ${p.attendance_count}`}
      />

      {/* Most Unique Teammates */}
      <LeaderPanel
        title="Most Unique Teammates"
        list={mostUniqueTeammates}
        renderItem={(p) => `${p.name} — ${p.count} teammates`}
      />

      {/* Most Unique Opponents */}
      <LeaderPanel
        title="Most Unique Opponents"
        list={mostUniqueOpponents}
        renderItem={(p) => `${p.name} — ${p.count} opponents`}
      />

      {/* Giant Killer */}
      <LeaderPanel
        title="Giant Killer"
        list={giantKiller}
        renderItem={(p) => `${p.name} — ${p.upsets} upset wins`}
      />

      {/* Most Consistent */}
      <LeaderPanel
        title="Most Consistent (lowest ELO variance)"
        list={mostConsistent}
        renderItem={(p) => `${p.name} — variance ${p.var.toFixed(1)}`}
      />
    </div>
  );
}
