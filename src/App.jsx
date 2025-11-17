// src/App.jsx
// FLOMINTON ELO SYSTEM — FULL VERSION 2.0 REWRITE
// ------------------------------------------------
// Includes:
// ✓ Home Page
// ✓ Full Settings System (saved in localStorage)
// ✓ Pause/Resume timer
// ✓ Benched list
// ✓ No display mode
// ✓ New tab order
// ✓ Start Session → goes to Session tab (START = B)
// ✓ Transition BEFORE rounds except round 1
// ✓ Big centered timer
// ✓ ELO pipeline (winner input → elo update → transition → next round)
// ✓ K-factor override
// ✓ Variable courts
// ✓ Updated logic.js integration

import React, { useEffect, useState, useRef } from "react";
import "./App.css";

import PlayerManagement from "./PlayerManagement";
import Leaderboards from "./Leaderboards";

import {
  selectPlayersForRound,
  buildMatchesFrom16,
  applyMatchResults,
  applyAttendanceForSession,
  formatTime
} from "./logic";

const API_PLAYERS = "/.netlify/functions/players";
const API_RESULTS = "/.netlify/functions/match_results";

// DEFAULT SETTINGS (overrideable via Settings modal)
const DEFAULT_SETTINGS = {
  roundDuration: 600,      // 10 minutes
  warningTime: 30,         // 30 seconds
  transitionTime: 60,      // 1 minute
  courtCount: 4,           // 4 courts
  kFactor: 32              // ELO K-factor
};

export default function App() {

  // --------------------------------------------------------
  // SETTINGS STATE (persisted in localStorage)
  // --------------------------------------------------------
  const [settings, setSettings] = useState(() => {
    const saved = localStorage.getItem("flomintonSettings");
    return saved ? JSON.parse(saved) : DEFAULT_SETTINGS;
  });

  function saveSettings(newSettings) {
    setSettings(newSettings);
    localStorage.setItem("flomintonSettings", JSON.stringify(newSettings));
  }

  // --------------------------------------------------------
  // GLOBAL STATE
  // --------------------------------------------------------
  const [players, setPlayers] = useState([]);
  const [present, setPresent] = useState([]);
  const [benched, setBenched] = useState([]);
  const [currentMatches, setCurrentMatches] = useState([]);
  const [roundNumber, setRoundNumber] = useState(1);
  const [phase, setPhase] = useState("idle"); 
  // idle → waiting for “Start / Next Round”
  // transition → countdown before round
  // round → active playing phase
  // winnerInput → selecting winners

  const [winners, setWinners] = useState({});
  const [attendanceSet, setAttendanceSet] = useState(new Set());

  const [roundTimeLeft, setRoundTimeLeft] = useState(settings.roundDuration);
  const [transitionTime, setTransitionTime] = useState(settings.transitionTime);
  const [isPaused, setIsPaused] = useState(false);

  const timerRef = useRef(null);
  const transitionRef = useRef(null);

  const [adminKey, setAdminKey] = useState(() => sessionStorage.getItem("adminKey") || "");

  // TAB ORDER: Home → PlayerManagement → Session → Leaderboards
  const [tab, setTab] = useState("home");

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
  // START SESSION (FROM HOME PAGE)
  // Does NOT auto-start a round. Goes to Session tab.
  // --------------------------------------------------------
  function startSession() {
    setTab("session");
    setPhase("idle");
  }

  // --------------------------------------------------------
  // START ROUND (FIRST STEP IS TRANSITION)
  // --------------------------------------------------------
  function startRound() {

    if (present.length < 4) {
      alert("Not enough players present to start a round.");
      return;
    }

    // --- Fairness selection: who plays ---
    const { playing, benched: newBenched } = selectPlayersForRound(
      present,
      roundNumber,
      new Set(),
      settings.courtCount
    );

    setBenched(newBenched);

    // --- Build actual matches ---
    const matches = buildMatchesFrom16(playing, new Map(), settings.courtCount);
    setCurrentMatches(matches);

    // Attendance for first-time players
    const { updatedPlayers, updatedAttendanceSet } = applyAttendanceForSession(
      matches,
      players,
      attendanceSet
    );

    setPlayers(updatedPlayers);
    setAttendanceSet(updatedAttendanceSet);

    // Clear winners
    setWinners({});

    // Transition BEFORE the round starts
    setTransitionTime(settings.transitionTime);
    setPhase("transition");
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
          // Move to round phase
          setRoundTimeLeft(settings.roundDuration);
          setIsPaused(false);
          setPhase("round");
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(transitionRef.current);
  }, [phase, settings.roundDuration]);

  // --------------------------------------------------------
  // ROUND TIMER
  // --------------------------------------------------------
  useEffect(() => {
    if (phase !== "round") return;

    if (isPaused) {
      if (timerRef.current) clearInterval(timerRef.current);
      return;
    }

    if (timerRef.current) clearInterval(timerRef.current);

    timerRef.current = setInterval(() => {
      setRoundTimeLeft(prev => {
        if (prev <= 1) {
          clearInterval(timerRef.current);
          // Move to WinnerInput phase
          setPhase("winnerInput");
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(timerRef.current);
  }, [phase, isPaused]);

  // --------------------------------------------------------
  // WARNING SOUND
  // --------------------------------------------------------
  useEffect(() => {
    if (roundTimeLeft === settings.warningTime && phase === "round" && !isPaused) {
      // Play sound if implemented
      // playWarningSound();
    }
  }, [roundTimeLeft, phase, isPaused, settings.warningTime]);

  // --------------------------------------------------------
  // SELECT WINNER
  // --------------------------------------------------------
  function selectWinner(courtNumber, team) {
    setWinners(prev => ({ ...prev, [courtNumber]: team }));
  }

  function allCourtsHaveWinners() {
    if (!currentMatches.length) return false;
    return currentMatches.every(m => winners[m.court]);
  }

  // --------------------------------------------------------
  // CONFIRM WINNERS → APPLY MATCH RESULTS
  // --------------------------------------------------------
  async function confirmResults() {
    if (!allCourtsHaveWinners()) return;

    const updatedLocalPlayers = applyMatchResults(
      currentMatches,
      winners,
      players,
      settings.kFactor
    );

    setPlayers(updatedLocalPlayers);

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
      alert("Failed to update players.");
    }

    // Write match results
    const resultsRows = [];
    for (const m of currentMatches) {
      const result = winners[m.court];
      const t1Win = result === "team1";
      const t2Win = !t1Win;

      const team1 = m.team1;
      const team2 = m.team2;

      const avg1 = m.avg1;
      const avg2 = m.avg2;

      for (const p of [...team1, ...team2]) {
        const before = p.elo_rating || 1000;
        const after = updatedLocalPlayers.find(x => x.id === p.id)?.elo_rating || before;
        const delta = after - before;

        resultsRows.push({
          session_id: new Date().toISOString().slice(0, 10),
          round_number: roundNumber,
          court_number: m.court,
          player_id: p.id,
          team: team1.includes(p) ? "team1" : "team2",
          result: (team1.includes(p) && t1Win) || (team2.includes(p) && t2Win)
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
      alert("Failed writing match results.");
    }

    // Next: transition before next round
    setRoundNumber(r => r + 1);
    setTransitionTime(settings.transitionTime);
    setPhase("transition");
  }

  // --------------------------------------------------------
  // PAUSE / RESUME
  // --------------------------------------------------------
  function pauseTimer() {
    setIsPaused(true);
  }

  function resumeTimer() {
    setIsPaused(false);
  }

  // --------------------------------------------------------
  // SETTINGS MODAL
  // --------------------------------------------------------
  const [settingsOpen, setSettingsOpen] = useState(false);

  function openSettings() {
    setSettingsOpen(true);
  }

  function closeSettings() {
    setSettingsOpen(false);
  }

  // --------------------------------------------------------
  // HOME PAGE RENDER
  // --------------------------------------------------------
  function renderHome() {
    return (
      <div className="home-page">
        <h1>FLOminton</h1>
        <p className="home-subtitle">
          Automated badminton session system with ELO matchmaking
        </p>

        <div className="home-buttons">
          <button className="btn home-btn" onClick={startSession}>
            Start Session
          </button>

          <button className="btn home-btn" onClick={() => setTab("players")}>
            Player Management
          </button>

          <button className="btn home-btn" onClick={() => setTab("leaderboards")}>
            Leaderboards
          </button>

          <button className="btn home-btn" onClick={openSettings}>
            Settings ⚙️
          </button>
        </div>

        <div className="home-settings-summary">
          <h3>Current Configuration</h3>
          <ul>
            <li>Round Duration: {settings.roundDuration}s</li>
            <li>Warning Time: {settings.warningTime}s</li>
            <li>Transition Time: {settings.transitionTime}s</li>
            <li>Courts: {settings.courtCount}</li>
            <li>ELO K-Factor: {settings.kFactor}</li>
          </ul>
        </div>
      </div>
    );
  }

  // --------------------------------------------------------
  // SETTINGS MODAL CONTENT (UI completed in part 2)
  // --------------------------------------------------------

  // The main render function continues next
  // (Session tab, WinnerInput mode, Transition mode, presence list, top tabs, etc.)

  return (
    <div className="app-container">
      {/* TOP NAVIGATION BAR */}
      <div className="top-tabs">
        <button
          className={tab === "home" ? "tab active" : "tab"}
          onClick={() => setTab("home")}
        >
          Home
        </button>

        <button
          className={tab === "players" ? "tab active" : "tab"}
          onClick={() => setTab("players")}
        >
          Player Management
        </button>

        <button
          className={tab === "session" ? "tab active" : "tab"}
          onClick={() => setTab("session")}
        >
          Session
        </button>

        <button
          className={tab === "leaderboards" ? "tab active" : "tab"}
          onClick={() => setTab("leaderboards")}
        >
          Leaderboards
        </button>

        {/* Settings icon always available */}
        <button className="settings-icon-btn" onClick={openSettings}>
          ⚙️
        </button>
      </div>

      {/* TAB CONTENT */}
      {tab === "home" && renderHome()}

      {tab === "players" && (
        <div className="players-tab">
          <PlayerManagement />
        </div>
      )}

      {tab === "leaderboards" && (
        <div className="leaderboards-tab">
          <Leaderboards />
        </div>
      )}

      {/* Session tab continues next in part 2 */}

      {/* SESSION TAB */}
      {tab === "session" && (
        <div className="session-page">

          {/* ---------------- BIG TIMER + ROUND HEADER ---------------- */}
          {(phase === "round" || phase === "transition") && (
            <div className="big-timer-header">
              <h2 className="round-label">Round {roundNumber}</h2>

              {phase === "round" && (
                <div className="big-timer">
                  {formatTime(roundTimeLeft)}
                </div>
              )}

              {phase === "transition" && (
                <div className="big-timer transition">
                  {formatTime(transitionTime)}
                </div>
              )}

              {/* Pause / Resume Controls */}
              {phase === "round" && (
                <div className="timer-controls">
                  {!isPaused && (
                    <button className="btn pause-btn" onClick={pauseTimer}>
                      Pause
                    </button>
                  )}

                  {isPaused && (
                    <button className="btn resume-btn" onClick={resumeTimer}>
                      Resume
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ---------------- IDLE MODE ---------------- */}
          {phase === "idle" && (
            <div className="idle-container">
              <h2>Session Ready</h2>
              <p className="idle-subtext">Press “Start / Next Round” to begin</p>
            </div>
          )}

          {/* ---------------- TRANSITION MODE ---------------- */}
          {phase === "transition" && (
            <div className="transition-container">
              <h3>Next Round Begins Soon…</h3>

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

              {/* Benched List */}
              {benched.length > 0 && (
                <div className="benched-section">
                  <h3>Benched</h3>
                  <div className="benched-list">
                    {benched.map(p => (
                      <div key={p.id} className="benched-pill">{p.name}</div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ---------------- ROUND MODE ---------------- */}
          {phase === "round" && (
            <div className="round-container">
              <div className="courts-grid">
                {currentMatches.map(match => (
                  <div key={match.court} className="court-card">
                    <div className="court-title">Court {match.court}</div>

                    {/* Team 1 */}
                    <div className="team-box">
                      {match.team1.map(p => (
                        <div key={p.id} className="player-chip">
                          {p.name}
                        </div>
                      ))}
                    </div>

                    <div className="vs-line">vs</div>

                    {/* Team 2 */}
                    <div className="team-box">
                      {match.team2.map(p => (
                        <div key={p.id} className="player-chip">
                          {p.name}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>

              {/* Benched List */}
              {benched.length > 0 && (
                <div className="benched-section">
                  <h3>Benched</h3>
                  <div className="benched-list">
                    {benched.map(p => (
                      <div key={p.id} className="benched-pill">{p.name}</div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ---------------- WINNER INPUT MODE ---------------- */}
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

              {/* Confirm button */}
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

          {/* ---------------- PRESENCE PANEL ---------------- */}
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

          {/* ---------------- SESSION CONTROLS ---------------- */}
          <div className="session-controls">
            <button className="btn" onClick={startRound}>
              Start / Next Round
            </button>
          </div>
        </div>
      )}

      {/* SETTINGS MODAL — FULL IMPLEMENTATION IN PART 3 */}

      {/* SETTINGS MODAL — FULL IMPLEMENTATION */}
      {settingsOpen && (
        <div className="modal-backdrop">
          <div className="modal">
            <div className="modal-head">
              <h3>Settings</h3>
              <button className="close-btn" onClick={closeSettings}>
                ×
              </button>
            </div>

            <div className="modal-body">
              {/* Round Duration (minutes) */}
              <div className="setting-row">
                <label>Round Duration (minutes)</label>
                <input
                  className="input"
                  type="number"
                  min={1}
                  value={Math.round(settings.roundDuration / 60)}
                  onChange={(e) => {
                    const mins = Number(e.target.value) || 1;
                    const seconds = Math.max(60, mins * 60);
                    saveSettings({
                      ...settings,
                      roundDuration: seconds
                    });
                  }}
                />
              </div>

              {/* Warning Time (seconds) */}
              <div className="setting-row">
                <label>Warning Time (seconds)</label>
                <input
                  className="input"
                  type="number"
                  min={0}
                  value={settings.warningTime}
                  onChange={(e) => {
                    const sec = Math.max(0, Number(e.target.value) || 0);
                    saveSettings({
                      ...settings,
                      warningTime: sec
                    });
                  }}
                />
              </div>

              {/* Transition Time (seconds) */}
              <div className="setting-row">
                <label>Transition Time (seconds)</label>
                <input
                  className="input"
                  type="number"
                  min={10}
                  value={settings.transitionTime}
                  onChange={(e) => {
                    const sec = Math.max(10, Number(e.target.value) || 10);
                    saveSettings({
                      ...settings,
                      transitionTime: sec
                    });
                  }}
                />
              </div>

              {/* Number of Courts */}
              <div className="setting-row">
                <label>Courts Available</label>
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={8}
                  value={settings.courtCount}
                  onChange={(e) => {
                    const courts = Math.max(1, Math.min(8, Number(e.target.value) || 1));
                    saveSettings({
                      ...settings,
                      courtCount: courts
                    });
                  }}
                />
              </div>

              {/* ELO K-Factor */}
              <div className="setting-row">
                <label>ELO K-Factor</label>
                <input
                  className="input"
                  type="number"
                  min={4}
                  max={64}
                  value={settings.kFactor}
                  onChange={(e) => {
                    const k = Math.max(4, Math.min(64, Number(e.target.value) || 4));
                    saveSettings({
                      ...settings,
                      kFactor: k
                    });
                  }}
                />
              </div>
            </div>

            <div className="modal-foot">
              <button className="btn" onClick={closeSettings}>
                Close
              </button>
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
FLOMINTON APP.JSX v2.0 — SUMMARY
===========================================================

✔ New top navigation:
   [ Home ] [ Player Management ] [ Session ] [ Leaderboards ]

✔ Home tab:
   - Start Session → jumps to Session tab (does NOT auto-start a round)
   - Quick links to Player Management + Leaderboards
   - Shows current configuration (round time, warning, transition, courts, K-factor)
   - Settings button

✔ Settings:
   - Round Duration (minutes) → stored as seconds
   - Warning Time (seconds)
   - Transition Time (seconds)
   - Courts Available (1–8)
   - ELO K-Factor (4–64)
   - All saved in localStorage and loaded on app start

✔ Session flow:
   1) Phase "idle" → waiting for “Start / Next Round”
   2) Start / Next Round:
      - Uses selectPlayersForRound (fairness) with settings.courtCount
      - Builds matches via buildMatchesFrom16
      - Updates attendance via applyAttendanceForSession
      - Sets phase → "transition"
   3) Phase "transition":
      - Big centered timer using settings.transitionTime
      - Shows upcoming matches
      - Shows Benched list
      - When 0 → moves to phase "round"
   4) Phase "round":
      - Big centered round timer using settings.roundDuration
      - Pause / Resume buttons
      - Courts visible
      - When 0 → phase "winnerInput"
   5) Phase "winnerInput":
      - Full-side clickable panels for each court
      - Green winner glow + dim loser
      - Confirm Results button only enabled when all courts have a winner
      - confirmResults():
          - Calls applyMatchResults(currentMatches, winners, players, settings.kFactor)
          - PATCH /players with updated stats
          - POST /match_results with row per player per match
          - Increments roundNumber
          - Sets phase → "transition" for next round

✔ Presence:
   - Present list at bottom of Session tab
   - Double-click name to toggle is_present
   - Syncs to /players via PATCH

✔ Benched:
   - Shown in both transition and round phases

✔ Admin Key:
   - Modal when no adminKey in sessionStorage
   - Admin key stored in sessionStorage and reused

===========================================================
END OF FILE
===========================================================
*/
