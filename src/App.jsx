// src/App.jsx
// FLOMINTON — FULL ELO SYSTEM REWRITE
// -----------------------------------
// This file replaces the old skill-based system with:
// - ELO-based matchmaking
// - WinnerInput phase
// - Transition countdown
// - Result confirmation
// - match_results + players Netlify function integration
// - Top tab navigation (Session / Player Management / Leaderboards)
// - Presence system retained
// - Display mode retained
// - All UI reconnected cleanly

import React, { useEffect, useState, useRef } from "react";
import "./App.css";

import PlayerManagement from "./PlayerManagement";
import Leaderboards from "./Leaderboards";

import {
  selectPlayersForRound,
  buildMatchesFrom16,
  applyMatchResults,
  applyAttendanceForSession,
  resetAllStats,
  formatTime
} from "./logic";

// Backend endpoints
const API_PLAYERS = "/.netlify/functions/players";
const API_RESULTS = "/.netlify/functions/match_results";

// Round duration (10 minutes = 600 seconds)
const ROUND_SECONDS = 600;
const TRANSITION_SECONDS = 60;

export default function App() {
  // --------------------------------------------------------
  // GLOBAL STATE
  // --------------------------------------------------------
  const [players, setPlayers] = useState([]);
  const [present, setPresent] = useState([]);
  const [benched, setBenched] = useState([]);

  const [currentMatches, setCurrentMatches] = useState([]);
  const [roundNumber, setRoundNumber] = useState(1);

  // New phases:
  // "round" → playing round
  // "winnerInput" → choose winners
  // "transition" → countdown before next round
  const [phase, setPhase] = useState("round");

  // Winner selection
  const [winners, setWinners] = useState({});

  // Timer
  const [roundTimeLeft, setRoundTimeLeft] = useState(ROUND_SECONDS);
  const [transitionTime, setTransitionTime] = useState(TRANSITION_SECONDS);

  const timerRef = useRef(null);
  const transitionRef = useRef(null);

  // Attendance: track players who already counted for this session
  const [attendanceSet, setAttendanceSet] = useState(new Set());

  // Admin key
  const [adminKey, setAdminKey] = useState(() => sessionStorage.getItem("adminKey") || "");

  // Navigation tab
  const [tab, setTab] = useState("session"); // "session" / "players" / "leaderboards"

  // Display mode
  const [displayMode, setDisplayMode] = useState(false);

  // --------------------------------------------------------
  // LOAD PLAYERS AT START
  // --------------------------------------------------------
  async function loadPlayers() {
    try {
      const res = await fetch(API_PLAYERS);
      const data = await res.json();
      if (!Array.isArray(data)) throw new Error("Invalid players format");
      setPlayers(data);
      setPresent(data.filter(p => p.is_present));
      setBenched([]);
    } catch (err) {
      console.error(err);
      alert("Failed to load players.");
    }
  }

  useEffect(() => {
    loadPlayers();
  }, []);

  // --------------------------------------------------------
  // PRESENCE TOGGLE
  // --------------------------------------------------------
  async function togglePresence(id) {
    const updated = players.map(p =>
      p.id === id ? { ...p, is_present: !p.is_present } : p
    );
    setPlayers(updated);

    try {
      await fetch(API_PLAYERS, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Admin-Key": adminKey
        },
        body: JSON.stringify({
          updates: [{ id, is_present: updated.find(p => p.id === id).is_present }]
        })
      });
    } catch (err) {
      console.error(err);
      alert("Failed to update presence.");
    }

    const nowPresent = updated.filter(p => p.is_present);
    setPresent(nowPresent);
  }

  // --------------------------------------------------------
  // START NEW ROUND (main matchmaking engine)
  // --------------------------------------------------------
  function startNewRound() {
    if (present.length < 4) {
      alert("Not enough players present.");
      return;
    }

    // Fairness selection (who plays)
    const { playing, benched: newBenched } = selectPlayersForRound(
      present,
      roundNumber,
      new Set(), // lastRoundBenched (not tracked separately now)
      4 // courts
    );

    setBenched(newBenched);

    // Actual match building
    const matches = buildMatchesFrom16(playing, new Map(), 4);
    setCurrentMatches(matches);

    // Attendance count
    const { updatedPlayers, updatedAttendanceSet } = applyAttendanceForSession(
      matches,
      players,
      attendanceSet
    );

    setPlayers(updatedPlayers);
    setAttendanceSet(updatedAttendanceSet);

    // Reset winner selection
    setWinners({});

    // Reset and start timer
    setRoundTimeLeft(ROUND_SECONDS);
    setPhase("round");
  }

  // --------------------------------------------------------
  // ROUND TIMER HANDLING
  // --------------------------------------------------------
  useEffect(() => {
    if (phase !== "round") return;

    if (timerRef.current) clearInterval(timerRef.current);

    timerRef.current = setInterval(() => {
      setRoundTimeLeft(prev => {
        if (prev <= 1) {
          clearInterval(timerRef.current);
          // End round
          setPhase("winnerInput");
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timerRef.current);
  }, [phase]);

  // --------------------------------------------------------
  // WINNER SELECTION HANDLING
  // --------------------------------------------------------
  function selectWinner(courtNumber, team) {
    setWinners(prev => ({
      ...prev,
      [courtNumber]: team
    }));
  }

  function allCourtsHaveWinners() {
    if (!currentMatches.length) return false;
    for (const m of currentMatches) {
      if (!winners[m.court]) return false;
    }
    return true;
  }

  // --------------------------------------------------------
  // APPLY RESULTS (ELO, stats, DB sync)
  // --------------------------------------------------------
  async function confirmResults() {
    if (!allCourtsHaveWinners()) return;

    // Local updates via logic.js
    const updatedLocalPlayers = applyMatchResults(
      currentMatches,
      winners,
      players
    );

    setPlayers(updatedLocalPlayers);

    // Prepare batch updates for backend
    const updates = updatedLocalPlayers.map(p => ({
      id: p.id,
      elo_rating: p.elo_rating,
      elo_delta_session: p.elo_delta_session,
      elo_delta_total: p.elo_delta_total,
      wins: p.wins,
      losses: p.losses,
      matches_played: p.matches_played,
      attendance_count: p.attendance_count,
      win_streak: p.win_streak,
      loss_streak: p.loss_streak,
      last_seen_at: p.last_seen_at
    }));

    // Write player stats
    try {
      await fetch(API_PLAYERS, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Admin-Key": adminKey
        },
        body: JSON.stringify({ updates })
      });
    } catch (err) {
      console.error(err);
      alert("Failed to update player stats.");
    }

    // Write match_results rows
    const resultsRows = [];
    for (const m of currentMatches) {
      const result = winners[m.court];
      if (!result) continue;

      const t1Win = result === "team1";
      const t2Win = !t1Win;

      const team1 = m.team1;
      const team2 = m.team2;

      const avg1 = m.avg1;
      const avg2 = m.avg2;

      const all = [...team1, ...team2];

      for (const p of all) {
        const before = p.elo_rating || 1000;
        const after = updatedLocalPlayers.find(x => x.id === p.id)?.elo_rating || before;
        const delta = after - before;

        resultsRows.push({
          session_id: new Date().toISOString().slice(0, 10),
          round_number: roundNumber,
          court_number: m.court,
          player_id: p.id,
          team: team1.includes(p) ? "team1" : "team2",
          result:
            (team1.includes(p) && t1Win) || (team2.includes(p) && t2Win)
              ? "win"
              : "loss",
          elo_before: before,
          elo_after: after,
          elo_change: delta,
          opponent_avg_elo: team1.includes(p) ? avg2 : avg1
        });
      }
    }

    try {
      await fetch(API_RESULTS, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Admin-Key": adminKey
        },
        body: JSON.stringify({ results: resultsRows })
      });
    } catch (err) {
      console.error(err);
      alert("Failed to write match results.");
    }

    // Move to transition phase
    setPhase("transition");
    setTransitionTime(TRANSITION_SECONDS);
  }

  // --------------------------------------------------------
  // TRANSITION TIMER
  // --------------------------------------------------------
  useEffect(() => {
    if (phase !== "transition") return;

    if (transitionRef.current) clearInterval(transitionRef.current);

    transitionRef.current = setInterval(() => {
      setTransitionTime(prev => {
        if (prev <= 1) {
          clearInterval(transitionRef.current);
          // Start next round
          setRoundNumber(r => r + 1);
          startNewRound();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(transitionRef.current);
  }, [phase]);

  // --------------------------------------------------------
  // RENDER (Session UI, courts, winner input, transition)
  // Will continue in PART 2
  // --------------------------------------------------------

  return (
    <div className="app-container">
      {/* Top Navigation Tabs */}
      <div className="top-tabs">
        <button
          className={tab === "session" ? "tab active" : "tab"}
          onClick={() => setTab("session")}
        >
          Session
        </button>
        <button
          className={tab === "players" ? "tab active" : "tab"}
          onClick={() => setTab("players")}
        >
          Player Management
        </button>
        <button
          className={tab === "leaderboards" ? "tab active" : "tab"}
          onClick={() => setTab("leaderboards")}
        >
          Leaderboards
        </button>
      </div>

      {/* Render content (continued in PART 2) */}

      {/* MAIN RENDER SWITCH */}
      {tab === "session" && (
        <div className="session-view">
          {phase === "round" && (
            <>
              <div className="session-header">
                <h2>Round {roundNumber}</h2>
                <div className="timer">{formatTime(roundTimeLeft)}</div>
              </div>

              {/* COURTS IN ROUND MODE */}
              <div className="courts-grid">
                {currentMatches.map(match => (
                  <div key={match.court} className="court-card">
                    <div className="court-title">Court {match.court}</div>

                    {/* Team 1 */}
                    <div className="team-box team-round">
                      {match.team1.map(p => (
                        <div key={p.id} className="player-chip">
                          {p.name}
                        </div>
                      ))}
                    </div>

                    <div className="vs-line">vs</div>

                    {/* Team 2 */}
                    <div className="team-box team-round">
                      {match.team2.map(p => (
                        <div key={p.id} className="player-chip">
                          {p.name}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* WINNER INPUT MODE */}
          {phase === "winnerInput" && (
            <div className="winner-input-container">
              <h2>Select Winners — Round {roundNumber}</h2>

              <div className="courts-grid">
                {currentMatches.map(match => {
                  const selected = winners[match.court];
                  const t1Selected = selected === "team1";
                  const t2Selected = selected === "team2";

                  return (
                    <div key={match.court} className="court-card winner-mode">
                      <div className="court-title">Court {match.court}</div>

                      {/* TEAM 1 CLICK AREA */}
                      <div
                        className={
                          "team-box clickable " +
                          (t1Selected
                            ? "winner-selected"
                            : t2Selected
                            ? "loser-dim"
                            : "")
                        }
                        onClick={() => selectWinner(match.court, "team1")}
                      >
                        {match.team1.map(p => (
                          <div key={p.id} className="player-chip">
                            {p.name}
                          </div>
                        ))}
                      </div>

                      <div className="vs-line">vs</div>

                      {/* TEAM 2 CLICK AREA */}
                      <div
                        className={
                          "team-box clickable " +
                          (t2Selected
                            ? "winner-selected"
                            : t1Selected
                            ? "loser-dim"
                            : "")
                        }
                        onClick={() => selectWinner(match.court, "team2")}
                      >
                        {match.team2.map(p => (
                          <div key={p.id} className="player-chip">
                            {p.name}
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* CONFIRM RESULTS BUTTON */}
              <div className="winner-submit-area">
                <button
                  className={
                    allCourtsHaveWinners()
                      ? "btn confirm"
                      : "btn confirm disabled"
                  }
                  disabled={!allCourtsHaveWinners()}
                  onClick={confirmResults}
                >
                  Confirm Results
                </button>
              </div>
            </div>
          )}

          {/* TRANSITION MODE */}
          {phase === "transition" && (
            <div className="transition-container">
              <h2>Next Round Starting Soon…</h2>
              <div className="transition-timer">
                {formatTime(transitionTime)}
              </div>

              {/* Show upcoming matches */}
              <div className="courts-grid">
                {currentMatches.map(match => (
                  <div key={match.court} className="court-card upcoming">
                    <div className="court-title">Court {match.court}</div>

                    <div className="team-box upcoming-team">
                      {match.team1.map(p => (
                        <div key={p.id} className="player-chip">
                          {p.name}
                        </div>
                      ))}
                    </div>

                    <div className="vs-line">vs</div>

                    <div className="team-box upcoming-team">
                      {match.team2.map(p => (
                        <div key={p.id} className="player-chip">
                          {p.name}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* PRESENCE PANEL */}
          <div className="presence-section">
            <h3>Present Players</h3>
            <div className="presence-list">
              {players.map(p => (
                <div
                  key={p.id}
                  className={
                    "presence-pill " + (p.is_present ? "present" : "absent")
                  }
                  onDoubleClick={() => togglePresence(p.id)}
                >
                  {p.name}
                </div>
              ))}
            </div>
          </div>

          {/* SESSION CONTROL BUTTONS */}
          <div className="session-controls">
            <button className="btn" onClick={startNewRound}>
              Start / Next Round
            </button>

            <button
              className="btn"
              onClick={() => setDisplayMode(true)}
            >
              Display Mode
            </button>
          </div>
        </div>
      )}

      {/* PLAYER MANAGEMENT TAB */}
      {tab === "players" && (
        <div className="players-tab">
          <PlayerManagement />
        </div>
      )}

      {/* LEADERBOARDS TAB */}
      {tab === "leaderboards" && (
        <div className="leaderboards-tab">
          <Leaderboards />
        </div>
      )}

      {/* DISPLAY MODE OVERLAY */}
      {displayMode && (
        <div className="display-overlay">
          <button
            className="btn small close-display"
            onClick={() => setDisplayMode(false)}
          >
            Exit Display Mode
          </button>

          <div className="display-courts">
            {currentMatches.map(match => (
              <div key={match.court} className="court-card display">
                <div className="court-title">Court {match.court}</div>

                <div className="team-box display-team">
                  {match.team1.map(p => (
                    <div key={p.id} className="player-chip display-chip">
                      {p.name}
                    </div>
                  ))}
                </div>

                <div className="vs-line">vs</div>

                <div className="team-box display-team">
                  {match.team2.map(p => (
                    <div key={p.id} className="player-chip display-chip">
                      {p.name}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ADD PLAYER MODAL — (reduced since skill removed) */}
      {false && (
        <div className="modal-backdrop">
          <div className="modal">
            <div className="modal-head">
              <h3>Add Player</h3>
              <button className="close-btn">×</button>
            </div>

            <div className="modal-body">
              {/* Your project previously had player-add logic here.  
                  Because the new ELO system gives everyone a default 1000 rating,
                  no extra logic is needed here for skill groups. */}
            </div>

            <div className="modal-foot">
              <button className="btn">Add</button>
            </div>
          </div>
        </div>
      )}

      {/* SETTINGS MODAL — MINIMAL */}
      {false && (
        <div className="modal-backdrop">
          <div className="modal">
            <div className="modal-head">
              <h3>Settings</h3>
              <button className="close-btn">×</button>
            </div>

            <div className="modal-body">
              <div className="setting-row">
                <label>Round Duration (minutes)</label>
                <input className="input" type="number" />
              </div>

              <div className="setting-row">
                <label>Transition Time (seconds)</label>
                <input className="input" type="number" />
              </div>
            </div>

            <div className="modal-foot">
              <button className="btn">Save</button>
            </div>
          </div>
        </div>
      )}

      {/* ADMIN KEY INPUT MODAL */}
      {!adminKey && (
        <div className="modal-backdrop">
          <div className="modal">
            <div className="modal-head">
              <h3>Admin Access</h3>
            </div>

            <div className="modal-body">
              <p>Enter admin key to enable editing, resets, and presence updates.</p>
              <input
                className="input"
                type="password"
                onChange={(e) => setAdminKey(e.target.value)}
                placeholder="Admin key"
              />
            </div>

            <div className="modal-foot">
              <button
                className="btn"
                onClick={() => {
                  sessionStorage.setItem("adminKey", adminKey);
                }}
              >
                Enter
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// END OF APP COMPONENT

/*
===========================================================
FINAL NOTES FOR APP.JSX REWRITE
===========================================================

✔ Completely removes skill-based logic
✔ Fully replaces it with ELO-based matchmaking
✔ Adds WinnerInput phase with full-side click (WinnerInput=1)
✔ Adds green winner highlight + dim loser sides (LoserDim=1)
✔ Adds 60-second transition countdown between rounds
✔ Adds top-tab navigation (Session / Player Management / Leaderboards)
✔ Integrates with new backend:
    - /players.js
    - /match_results.js
✔ Calls applyMatchResults() from logic.js
✔ Tracks attendance on first match participation
✔ Rebuilds presence system to be compatible with new flow
✔ Keeps Display Mode for big screen use
✔ Keeps Player Chips styling
✔ Safely handles admin key storage
✔ Prepares future extensibility (reset stats, diagnostics, etc.)

===========================================================
END OF FILE
===========================================================
*/

