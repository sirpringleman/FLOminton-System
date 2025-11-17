// src/PlayerManagement.jsx
// FLOMINTON PLAYER MANAGEMENT PAGE
//
// Displays:
//   - ELO rating
//   - Wins/losses/matches/win%
//   - Session ELO change
//   - Lifetime ELO change
//   - Attendance count
//   - Streaks
//   - Handedness, Notes, Status
//   - Date joined, Last seen
//
// Features:
//   - Filters (gender, status, handedness, ELO range, attendance)
//   - Sorting (name, ELO, wins, win%, attendance)
//   - Admin editing (handedness, notes, status, name, gender)
//   - Reset Stats button (admin-only)
//   - Refresh button
//
// Integrates with:
//   - /netlify/functions/players.js
//   - logic.js for reset helper (App.jsx will eventually call resetAllStats)

import React, { useEffect, useState } from "react";

const API = "/.netlify/functions/players";
const API_RESET = "/.netlify/functions/players/reset";

export default function PlayerManagement() {
  const [players, setPlayers] = useState([]);
  const [loading, setLoading] = useState(true);

  // Filters
  const [filterGender, setFilterGender] = useState("all");
  const [filterStatus, setFilterStatus] = useState("all");
  const [filterHandedness, setFilterHandedness] = useState("all");
  const [filterMinElo, setFilterMinElo] = useState("");
  const [filterMaxElo, setFilterMaxElo] = useState("");
  const [filterMinAttendance, setFilterMinAttendance] = useState("");

  // Sorting
  const [sortKey, setSortKey] = useState("name");
  const [sortDir, setSortDir] = useState("asc");

  // Admin key
  const [adminKey] = useState(() => sessionStorage.getItem("adminKey") || "");

  /* --------------------------------------------------------
     Load players
     -------------------------------------------------------- */
  async function loadPlayers() {
    setLoading(true);
    try {
      const res = await fetch(API);
      const data = await res.json();
      setPlayers(data || []);
    } catch (err) {
      console.error(err);
      alert("Failed to load players.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadPlayers();
  }, []);

  /* --------------------------------------------------------
     Update player field
     -------------------------------------------------------- */
  async function updateField(id, field, value) {
    try {
      await fetch(API, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Admin-Key": adminKey || ""
        },
        body: JSON.stringify({
          updates: [{ id, [field]: value }]
        })
      });

      setPlayers(prev =>
        prev.map(p => (p.id === id ? { ...p, [field]: value } : p))
      );
    } catch (e) {
      console.error(e);
      alert("Failed to update field.");
    }
  }

  /* --------------------------------------------------------
     Reset ALL stats
     -------------------------------------------------------- */
  async function resetAllStats() {
    if (!adminKey) {
      alert("Admin key required.");
      return;
    }
    if (!window.confirm("Reset ALL player stats? This cannot be undone.")) {
      return;
    }

    try {
      const res = await fetch(API_RESET, {
        method: "POST",
        headers: { "X-Admin-Key": adminKey }
      });
      const data = await res.json();

      if (!res.ok) {
        alert("Failed to reset stats: " + (data.error || ""));
        return;
      }

      alert("All stats reset.");
      loadPlayers();
    } catch (e) {
      console.error(e);
      alert("Reset failed.");
    }
  }

  /* --------------------------------------------------------
     Filtered & Sorted Players
     -------------------------------------------------------- */
  function applyFilters(list) {
    return list.filter(p => {
      if (filterGender !== "all" && p.gender !== filterGender) return false;
      if (filterStatus !== "all" && p.status !== filterStatus) return false;
      if (filterHandedness !== "all" && (p.handedness || "unknown") !== filterHandedness)
        return false;

      if (filterMinElo && p.elo_rating < Number(filterMinElo)) return false;
      if (filterMaxElo && p.elo_rating > Number(filterMaxElo)) return false;

      if (filterMinAttendance && (p.attendance_count || 0) < Number(filterMinAttendance))
        return false;

      return true;
    });
  }

  function applySorting(list) {
    const sorted = [...list].sort((a, b) => {
      let A = a[sortKey];
      let B = b[sortKey];

      if (sortKey === "win_rate") {
        A = a.matches_played ? a.wins / a.matches_played : 0;
        B = b.matches_played ? b.wins / b.matches_played : 0;
      }

      if (A < B) return sortDir === "asc" ? -1 : 1;
      if (A > B) return sortDir === "asc" ? 1 : -1;
      return a.name.localeCompare(b.name);
    });
    return sorted;
  }

  const filtered = applyFilters(players);
  const sorted = applySorting(filtered);

  /* --------------------------------------------------------
     Helpers
     -------------------------------------------------------- */
  const fmtDate = (d) => {
    if (!d) return "-";
    try {
      return new Date(d).toLocaleDateString();
    } catch {
      return d;
    }
  };

  const pct = (n) => Math.round(n * 100);

  /* --------------------------------------------------------
     RENDER
     -------------------------------------------------------- */
  if (loading) {
    return (
      <div className="page centered">
        <div className="muted">Loading players…</div>
      </div>
    );
  }

  return (
    <div className="page" style={{ padding: "16px" }}>
      <h2>Player Management</h2>

      {/* ---------- FILTERS ---------- */}
      <div className="panel glass" style={{ marginBottom: "16px" }}>
        <div className="panel-head">
          <h3>Filters</h3>
          <button className="btn" onClick={loadPlayers}>Refresh</button>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit,minmax(180px,1fr))",
            gap: "10px",
          }}
        >
          <select
            className="input"
            value={filterGender}
            onChange={(e) => setFilterGender(e.target.value)}
          >
            <option value="all">All Genders</option>
            <option value="M">Male</option>
            <option value="F">Female</option>
          </select>

          <select
            className="input"
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
          >
            <option value="all">All Statuses</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
            <option value="guest">Guest</option>
          </select>

          <select
            className="input"
            value={filterHandedness}
            onChange={(e) => setFilterHandedness(e.target.value)}
          >
            <option value="all">All Handedness</option>
            <option value="R">Right-handed</option>
            <option value="L">Left-handed</option>
            <option value="unknown">Unknown</option>
          </select>

          <input
            className="input"
            type="number"
            placeholder="Min ELO"
            value={filterMinElo}
            onChange={(e) => setFilterMinElo(e.target.value)}
          />
          <input
            className="input"
            type="number"
            placeholder="Max ELO"
            value={filterMaxElo}
            onChange={(e) => setFilterMaxElo(e.target.value)}
          />
          <input
            className="input"
            type="number"
            placeholder="Min Attendance"
            value={filterMinAttendance}
            onChange={(e) => setFilterMinAttendance(e.target.value)}
          />
        </div>
      </div>

      {/* ---------- SORTING ---------- */}
      <div className="panel glass" style={{ marginBottom: "16px" }}>
        <div className="panel-head">
          <h3>Sort</h3>
        </div>

        <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
          <select
            className="input"
            value={sortKey}
            onChange={(e) => setSortKey(e.target.value)}
          >
            <option value="name">Name</option>
            <option value="elo_rating">ELO</option>
            <option value="wins">Wins</option>
            <option value="matches_played">Matches Played</option>
            <option value="win_rate">Win %</option>
            <option value="attendance_count">Attendance</option>
          </select>

          <select
            className="input"
            value={sortDir}
            onChange={(e) => setSortDir(e.target.value)}
          >
            <option value="asc">Ascending</option>
            <option value="desc">Descending</option>
          </select>
        </div>
      </div>

      {/* ---------- RESET BUTTON ---------- */}
      {adminKey && (
        <div className="panel glass" style={{ marginBottom: "16px" }}>
          <button className="btn danger" onClick={resetAllStats}>
            RESET ALL STATS (Admin Only)
          </button>
        </div>
      )}

      {/* ---------- PLAYER TABLE ---------- */}
      <div className="panel glass">
        <div className="panel-head">
          <h3>All Players ({sorted.length})</h3>
        </div>

        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>ELO</th>
                <th>Δ Session</th>
                <th>Δ Total</th>
                <th>Wins</th>
                <th>Losses</th>
                <th>Win %</th>
                <th>Matches</th>
                <th>Attendance</th>
                <th>Streak</th>
                <th>Handed</th>
                <th>Status</th>
                <th>Joined</th>
                <th>Last Seen</th>
                <th>Notes</th>
              </tr>
            </thead>

            <tbody>
              {sorted.map((p) => {
                const winRate =
                  p.matches_played > 0
                    ? p.wins / p.matches_played
                    : 0;

                const streak =
                  p.win_streak > 0
                    ? `W${p.win_streak}`
                    : p.loss_streak > 0
                    ? `L${p.loss_streak}`
                    : "-";

                return (
                  <tr key={p.id}>
                    <td>
                      <input
                        className="input"
                        value={p.name}
                        onChange={(e) => updateField(p.id, "name", e.target.value)}
                      />
                    </td>

                    <td>{p.elo_rating}</td>

                    <td
                      style={{
                        color: p.elo_delta_session > 0 ? "#45d48a" : p.elo_delta_session < 0 ? "#ff5a6d" : "inherit"
                      }}
                    >
                      {p.elo_delta_session > 0 ? "+" : ""}
                      {p.elo_delta_session}
                    </td>

                    <td
                      style={{
                        color: p.elo_delta_total > 0 ? "#45d48a" : p.elo_delta_total < 0 ? "#ff5a6d" : "inherit"
                      }}
                    >
                      {p.elo_delta_total > 0 ? "+" : ""}
                      {p.elo_delta_total}
                    </td>

                    <td>{p.wins}</td>
                    <td>{p.losses}</td>
                    <td>{pct(winRate)}%</td>
                    <td>{p.matches_played}</td>
                    <td>{p.attendance_count}</td>

                    <td>{streak}</td>

                    <td>
                      <select
                        className="input"
                        value={p.handedness || "unknown"}
                        onChange={(e) =>
                          updateField(p.id, "handedness", e.target.value)
                        }
                      >
                        <option value="unknown">?</option>
                        <option value="R">R</option>
                        <option value="L">L</option>
                      </select>
                    </td>

                    <td>
                      <select
                        className="input"
                        value={p.status || "active"}
                        onChange={(e) =>
                          updateField(p.id, "status", e.target.value)
                        }
                      >
                        <option value="active">Active</option>
                        <option value="inactive">Inactive</option>
                        <option value="guest">Guest</option>
                      </select>
                    </td>

                    <td>{fmtDate(p.date_joined)}</td>
                    <td>{fmtDate(p.last_seen_at)}</td>

                    <td>
                      <textarea
                        className="input"
                        value={p.notes || ""}
                        onChange={(e) => updateField(p.id, "notes", e.target.value)}
                        style={{ height: "40px" }}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
