import React, { useEffect, useMemo, useRef, useState } from 'react';
import './App.css';
import {
  buildMatches,
  fairnessStats,
  roundDiagnostics,
  perPlayerUniq,
  countBackToBackBenches,
} from './logic';

const API = '/.netlify/functions/players';

// ---- sounds / time ----
const beep = (f = 880, ms = 120) => {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.value = f;
    o.connect(g);
    g.connect(ctx.destination);
    o.start();
    g.gain.exponentialRampToValueAtTime(0.00001, ctx.currentTime + ms / 1000);
    setTimeout(() => {
      o.stop();
      ctx.close();
    }, ms + 40);
  } catch {}
};
const chime = () => {
  beep(880, 120);
  setTimeout(() => beep(1200, 120), 140);
};
const fmt2 = (n) => (n < 10 ? `0${n}` : `${n}`);
const toMMSS = (s) => `${fmt2((s / 60) | 0)}:${fmt2(s % 60)}`;

// =========================================================

export default function App() {
  // Views
  const [view, setView] = useState('home'); // 'home'|'session'|'display'

  // Data
  const [players, setPlayers] = useState([]);

  // Settings
  const [maxCourts, setMaxCourts] = useState(4);
  const [mode, setMode] = useState('band'); // 'band'|'window'
  const [windowSize, setWindowSize] = useState(2);
  const [roundSeconds, setRoundSeconds] = useState(12 * 60);
  const [transitionSeconds, setTransitionSeconds] = useState(30);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Admin lock + show levels toggle
  const [admin, setAdmin] = useState(false);
  const [adminPassword, setAdminPassword] = useState('');
  const [adminModal, setAdminModal] = useState(false);
  const [passwordInput, setPasswordInput] = useState('');
  const [showLevels, setShowLevels] = useState(true);

  // Session runtime
  const [round, setRound] = useState(1);
  const [matches, setMatches] = useState([]);
  const [benched, setBenched] = useState([]);
  const [running, setRunning] = useState(false);
  const [timer, setTimer] = useState(roundSeconds);
  const [transition, setTransition] = useState(0);
  const tRef = useRef(null);
  const nextMatchesRef = useRef(null);

  // Session analytics
  const [sessionRounds, setSessionRounds] = useState([]);
  const [summaryModal, setSummaryModal] = useState(null); // shows End Night summary

  // API
  async function fetchPlayers() {
    try {
      const res = await fetch(API);
      const data = await res.json();
      setPlayers(Array.isArray(data) ? data : []);
    } catch {
      alert('Failed to load players.');
    }
  }
  async function savePlayers(list) {
    setPlayers(list);
    try {
      await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ players: list }),
      });
    } catch {}
  }
  async function patchPlayers(updates) {
    try {
      await fetch(API, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates }),
      });
    } catch {}
  }

  useEffect(() => {
    fetchPlayers();
  }, []);

  // Derived sets/maps
  const allPlayers = useMemo(
    () => players.slice().sort((a, b) => a.name.localeCompare(b.name)),
    [players]
  );
  const present = useMemo(
    () => allPlayers.filter((p) => p.is_present),
    [allPlayers]
  );

  const lastPlayedMap = useMemo(
    () => new Map(allPlayers.map((p) => [p.id, p.last_played_round || 0])),
    [allPlayers]
  );
  const benchCountMap = useMemo(
    () => new Map(allPlayers.map((p) => [p.id, p.bench_count || 0])),
    [allPlayers]
  );

  // Admin lock
  function openAdmin() {
    setPasswordInput('');
    setAdminModal(true);
  }
  function closeAdmin() {
    setAdminModal(false);
  }
  function submitAdmin() {
    if (!adminPassword || passwordInput === adminPassword) {
      setAdmin(true);
      setAdminModal(false);
      return;
    }
    alert('Wrong password.');
  }
  function exitAdmin() {
    setAdmin(false);
  }

  // Home -> Session
  function beginNight() {
    setView('session');
    setRound(1);
    setMatches([]);
    setBenched([]);
    setSessionRounds([]);
    setTransition(0);
    setTimer(roundSeconds);
    setRunning(false);
  }

  // Toggling present
  function togglePresent(p) {
    const updated = players.map((x) =>
      x.id === p.id ? { ...x, is_present: !x.is_present } : x
    );
    savePlayers(updated);
  }

  // Build round
  function buildRound(roundNo, startTimer) {
    const t0 = performance.now();

    const built = buildMatches({
      present,
      maxCourts,
      mode,
      windowSize,
      roundNo,
      lastPlayedMap,
      benchCountMap,
      lastRoundBenchedSet: new Set(benched.map((x) => x.id)),
    });

    const playIds = new Set(
      built.flatMap((m) => [...m.team1, ...m.team2].map((p) => p.id))
    );
    const newBenched = present.filter((p) => !playIds.has(p.id));

    setMatches(built);
    setBenched(newBenched);

    const updates = players.map((p) => {
      const playing = playIds.has(p.id);
      return {
        id: p.id,
        fields: {
          last_played_round: playing ? roundNo : p.last_played_round || 0,
          bench_count: playing ? p.bench_count || 0 : (p.bench_count || 0) + 1,
        },
      };
    });
    patchPlayers(updates);
    setPlayers((prev) =>
      prev.map((p) => {
        const u = updates.find((x) => x.id === p.id);
        return u ? { ...p, ...u.fields } : p;
      })
    );

    const t1 = performance.now();
    setSessionRounds((prev) => [
      ...prev,
      { round: roundNo, matches: built, meta: { buildMs: Math.round(t1 - t0) } },
    ]);

    if (startTimer) {
      setTimer(roundSeconds);
      setRunning(true);
    }
  }

  // Build/Resume
  function buildOrResume() {
    if (matches.length && !transition && !running) {
      setRunning(true);
      return;
    }
    buildRound(round, true);
  }

  // Immediate next round (skip transition)
  function nextRound() {
    const nextNo = round + 1;
    const t0 = performance.now();

    const built = buildMatches({
      present,
      maxCourts,
      mode,
      windowSize,
      roundNo: nextNo,
      lastPlayedMap,
      benchCountMap,
      lastRoundBenchedSet: new Set(benched.map((x) => x.id)),
    });

    const playIds = new Set(
      built.flatMap((m) => [...m.team1, ...m.team2].map((p) => p.id))
    );
    const newBenched = present.filter((p) => !playIds.has(p.id));

    setMatches(built);
    setBenched(newBenched);

    // update players
    const updates = players.map((p) => {
      const playing = playIds.has(p.id);
      return {
        id: p.id,
        fields: {
          last_played_round: playing ? nextNo : p.last_played_round || 0,
          bench_count: playing ? p.bench_count || 0 : (p.bench_count || 0) + 1,
        },
      };
    });
    patchPlayers(updates);
    setPlayers((prev) =>
      prev.map((p) => {
        const u = updates.find((x) => x.id === p.id);
        return u ? { ...p, ...u.fields } : p;
      })
    );

    setSessionRounds((prev) => [
      ...prev,
      { round: nextNo, matches: built, meta: { buildMs: Math.round(performance.now() - t0) } },
    ]);

    setRound(nextNo);
    setTransition(0);
    setTimer(roundSeconds);
    setRunning(true);
    chime();
  }

  // Prepare next (used when round timer hits 0 -> 30s transition)
  function prepareNext() {
    const nextNo = round + 1;
    const t0 = performance.now();

    const built = buildMatches({
      present,
      maxCourts,
      mode,
      windowSize,
      roundNo: nextNo,
      lastPlayedMap,
      benchCountMap,
      lastRoundBenchedSet: new Set(benched.map((x) => x.id)),
    });

    const playIds = new Set(
      built.flatMap((m) => [...m.team1, ...m.team2].map((p) => p.id))
    );
    const newBenched = present.filter((p) => !playIds.has(p.id));

    nextMatchesRef.current = {
      built,
      newBenched,
      buildMs: Math.round(performance.now() - t0),
    };

    setTransition(transitionSeconds);
    setRunning(false);
    beep(700, 120);
  }

  // End Night -> show summary, then reset on Close
  async function endNight() {
    // Compose summary first from current sessionRounds/present
    const presentIds = new Set(present.map((p) => p.id));
    const baseSummary = computeSummary(sessionRounds, presentIds, present);

    setSummaryModal({
      summary: baseSummary.summary,
      perPlayerRows: baseSummary.perPlayerRows,
      diag: baseSummary.diag,
      onClose: async () => {
        setSummaryModal(null);
        try {
          const updates = players.map((p) => ({
            id: p.id,
            fields: { is_present: false, last_played_round: 0 },
          }));
          await patchPlayers(updates);
        } finally {
          setPlayers((prev) =>
            prev.map((p) => ({ ...p, is_present: false, last_played_round: 0 }))
          );
          setRound(1);
          setMatches([]);
          setBenched([]);
          setSessionRounds([]);
          setTransition(0);
          setTimer(roundSeconds);
          setRunning(false);
          setView('home');
        }
      },
    });
  }

  // Timer engine
  useEffect(() => {
    if (!running && !transition) return;
    clearInterval(tRef.current);
    tRef.current = setInterval(() => {
      if (transition) {
        setTransition((s) => {
          if (s <= 1) {
            const nm = nextMatchesRef.current;
            const built = nm?.built || [];
            const newBenched = nm?.newBenched || [];

            const nextNo = round + 1;
            const playIds = new Set(
              built.flatMap((m) => [...m.team1, ...m.team2].map((p) => p.id))
            );

            const updates = players.map((p) => {
              const playing = playIds.has(p.id);
              return {
                id: p.id,
                fields: {
                  last_played_round: playing ? nextNo : p.last_played_round || 0,
                  bench_count: playing ? p.bench_count || 0 : (p.bench_count || 0) + 1,
                },
              };
            });
            patchPlayers(updates);
            setPlayers((prev) =>
              prev.map((p) => {
                const u = updates.find((x) => x.id === p.id);
                return u ? { ...p, ...u.fields } : p;
              })
            );

            setSessionRounds((prev) => [
              ...prev,
              { round: nextNo, matches: built, meta: { buildMs: nm?.buildMs ?? null } },
            ]);

            setMatches(built);
            setBenched(newBenched);
            setRound(nextNo);
            setTransition(0);
            setTimer(roundSeconds);
            setRunning(true);
            chime();
            return 0;
          }
          return s - 1;
        });
      } else if (running) {
        setTimer((s) => {
          if (s <= 1) {
            setRunning(false);
            prepareNext(); // enter 30s transition with new quads visible
            return 0;
          }
          return s - 1;
        });
      }
    }, 1000);
    return () => clearInterval(tRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    running,
    transition,
    round,
    players,
    present,
    maxCourts,
    mode,
    windowSize,
    roundSeconds,
    transitionSeconds,
  ]);

  const isYellow = !transition && running && timer <= 30 && timer > 0;
  const isFlashing = transition > 0 || (!running && timer === 0);

  // =========================== RENDER ===========================

  if (view === 'home') {
    return (
      <div className="container">
        <div className="toolbar" style={{ justifyContent: 'center' }}>
          <div className="brand">🏸 TheFLOminton System</div>
        </div>

        <div className="welcome">
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
            <button className="btn btn-primary" onClick={beginNight}>
              Begin Night
            </button>
            <button className="btn" onClick={() => setView('display')}>
              Open Display
            </button>
            <button className="btn" onClick={() => setSettingsOpen(true)}>
              Settings
            </button>
            {!admin ? (
              <button className="btn" onClick={openAdmin}>
                Admin
              </button>
            ) : (
              <button className="btn" onClick={exitAdmin}>
                Exit Admin
              </button>
            )}
          </div>
        </div>

        {adminModal && (
          <LockModal
            title="Admin Access"
            passwordInput={passwordInput}
            setPasswordInput={setPasswordInput}
            onClose={closeAdmin}
            onSubmit={submitAdmin}
          />
        )}
        {settingsOpen && (
          <SettingsModal
            open={settingsOpen}
            setOpen={setSettingsOpen}
            maxCourts={maxCourts}
            setMaxCourts={setMaxCourts}
            roundSeconds={roundSeconds}
            setRoundSeconds={setRoundSeconds}
            transitionSeconds={transitionSeconds}
            setTransitionSeconds={setTransitionSeconds}
            mode={mode}
            setMode={setMode}
            windowSize={windowSize}
            setWindowSize={setWindowSize}
          />
        )}
      </div>
    );
  }

  if (view === 'display') {
    return (
      <div className="displayPage">
        <div className="displayHeader">
          <div className="displayRound">Round {round}</div>
          <div className={`displayTimer ${isYellow ? 'yellow' : ''} ${isFlashing ? 'flash' : ''}`}>
            {transition ? toMMSS(transition) : toMMSS(timer)}
          </div>
        </div>

        <div className="grid bigNames">
          {(transition ? nextMatchesRef.current?.built || [] : matches).map((m) => (
            <div className="panel" key={m.court}>
              <div className="courtHeader">
                <h3>Court {m.court}</h3>
                <div />
              </div>
              <div className="chips">
                {m.team1.map((p) => (
                  <span key={p.id} className={`chip ${p.gender === 'F' ? 'f' : 'm'}`}>
                    {p.name}
                  </span>
                ))}
              </div>
              <div className="dividerLine" />
              <div className="chips">
                {m.team2.map((p) => (
                  <span key={p.id} className={`chip ${p.gender === 'F' ? 'f' : 'm'}`}>
                    {p.name}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="panel" style={{ marginTop: 12 }}>
          <div className="sectionTitle">Benched Players</div>
          <div className="benchedRow">
            {(transition ? nextMatchesRef.current?.newBenched || [] : benched).map((p) => (
              <span key={p.id} className={`chip ${p.gender === 'F' ? 'f' : 'm'}`}>
                {p.name}
              </span>
            ))}
          </div>
        </div>

        <div className="container" style={{ marginTop: 10 }}>
          <button className="btn" onClick={() => setView('session')}>
            Back
          </button>
        </div>
      </div>
    );
  }

  // SESSION
  return (
    <div className="container">
      <div className="toolbar">
        <div className="actions">
          <button className="btn" onClick={() => setRunning(false)}>
            Pause
          </button>
          <button className="btn btn-primary" onClick={buildOrResume}>
            Build/Resume
          </button>
          <button className="btn" onClick={nextRound}>
            Next Round
          </button>
          <button className="btn btn-danger" onClick={endNight}>
            End Night
          </button>
          <button className="btn" onClick={() => setView('display')}>
            Open Display
          </button>
          <div className="modeToggle">
            <button className={mode === 'band' ? 'active' : ''} onClick={() => setMode('band')}>
              Band
            </button>
            <button
              className={mode === 'window' ? 'active' : ''}
              onClick={() => setMode('window')}
            >
              Window
            </button>
          </div>
          <button className="btn" onClick={() => setSettingsOpen(true)}>
            Settings
          </button>
          {!admin ? (
            <button className="btn" onClick={openAdmin}>
              Admin
            </button>
          ) : (
            <button className="btn" onClick={exitAdmin}>
              Exit Admin
            </button>
          )}
        </div>

        <div className="actions">
          <div className="centerBar">
            <div className="sub">Round</div>
            <div className="title">{round}</div>
          </div>
          <div className={`timer big ${isYellow ? 'yellow' : ''} ${isFlashing ? 'flash' : ''}`}>
            {transition ? toMMSS(transition) : toMMSS(timer)}
          </div>
          <div className="centerBar">
            <div className="sub">Present</div>
            <div className="title">{present.length}</div>
          </div>
        </div>
      </div>

      {/* Courts */}
      <div className="grid" style={{ marginTop: 12 }}>
        {(transition ? nextMatchesRef.current?.built || [] : matches).map((m) => (
          <div className="panel" key={m.court}>
            <div className="courtHeader">
              <h3>Court {m.court}</h3>
              {admin && showLevels && (
                <div className="teamAverages">
                  Team 1 Avg <b>{m.team1Avg.toFixed(1)}</b> &nbsp; | &nbsp; Team 2 Avg{' '}
                  <b>{m.team2Avg.toFixed(1)}</b>
                </div>
              )}
            </div>
            <div className="chips">
              {m.team1.map((p) => (
                <span key={p.id} className={`chip ${p.gender === 'F' ? 'f' : 'm'}`}>
                  {p.name}
                  {admin && showLevels ? ` · L${p.skill_level}` : ''}
                </span>
              ))}
            </div>
            <div className="rail" />
            <div className="chips">
              {m.team2.map((p) => (
                <span key={p.id} className={`chip ${p.gender === 'F' ? 'f' : 'm'}`}>
                  {p.name}
                  {admin && showLevels ? ` · L${p.skill_level}` : ''}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Benched */}
      <div className="panel" style={{ marginTop: 12 }}>
        <div className="sectionTitle">Benched Players</div>
        <div className="benchedRow">
          {(transition ? nextMatchesRef.current?.newBenched || [] : benched).map((p) => (
            <span key={p.id} className={`chip ${p.gender === 'F' ? 'f' : 'm'}`}>
              {p.name}
              {admin && showLevels ? ` · L${p.skill_level}` : ''}
            </span>
          ))}
        </div>
      </div>

      {/* Lists + Admin Panel */}
      <div className="columns" style={{ marginTop: 12 }}>
        <div className="list">
          <h4>
            All Players <span className="sub">{allPlayers.length - present.length}</span>
          </h4>
          {allPlayers
            .filter((p) => !p.is_present)
            .map((p) => (
              <div key={p.id} className="row" onDoubleClick={() => togglePresent(p)}>
                {p.name}
                {admin && showLevels ? ` · L${p.skill_level}` : ''}
              </div>
            ))}
        </div>
        <div className="list">
          <h4>
            Present Today <span className="sub">{present.length}</span>
          </h4>
          {present.map((p) => (
            <div key={p.id} className="row" onDoubleClick={() => togglePresent(p)}>
              {p.name}
              {admin && showLevels ? ` · L${p.skill_level}` : ''}
            </div>
          ))}
        </div>
      </div>

      {/* Admin Controls */}
      {admin && (
        <AdminPanel
          admin={admin}
          adminPassword={adminPassword}
          setAdminPassword={setAdminPassword}
          showLevels={showLevels}
          setShowLevels={setShowLevels}
          players={players}
          onSavePlayers={savePlayers}
          present={present}
          sessionRounds={sessionRounds}
        />
      )}

      {/* Modals */}
      {adminModal && (
        <LockModal
          title="Admin Access"
          passwordInput={passwordInput}
          setPasswordInput={setPasswordInput}
          onClose={closeAdmin}
          onSubmit={submitAdmin}
        />
      )}
      {settingsOpen && (
        <SettingsModal
          open={settingsOpen}
          setOpen={setSettingsOpen}
          maxCourts={maxCourts}
          setMaxCourts={setMaxCourts}
          roundSeconds={roundSeconds}
          setRoundSeconds={setRoundSeconds}
          transitionSeconds={transitionSeconds}
          setTransitionSeconds={setTransitionSeconds}
          mode={mode}
          setMode={setMode}
          windowSize={windowSize}
          setWindowSize={setWindowSize}
        />
      )}
      {summaryModal && (
        <SummaryModal
          summary={summaryModal.summary}
          perPlayerRows={summaryModal.perPlayerRows}
          diag={summaryModal.diag}
          onClose={summaryModal.onClose}
        />
      )}
    </div>
  );
}

// -------------------- Modals / Panels --------------------

function LockModal({ title, passwordInput, setPasswordInput, onSubmit, onClose }) {
  return (
    <div className="modalOverlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header><h2>{title}</h2></header>
        <div className="formRow">
          <input
            className="input"
            type="password"
            placeholder="Password (blank allowed if unset)"
            value={passwordInput}
            onChange={(e) => setPasswordInput(e.target.value)}
          />
          <div/><div/><div/>
        </div>
        <footer>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={onSubmit}>Unlock</button>
        </footer>
      </div>
    </div>
  );
}

function SettingsModal({
  open, setOpen,
  maxCourts, setMaxCourts,
  roundSeconds, setRoundSeconds,
  transitionSeconds, setTransitionSeconds,
  mode, setMode,
  windowSize, setWindowSize,
}) {
  if (!open) return null;
  return (
    <div className="modalOverlay" onClick={() => setOpen(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header><h2>Settings</h2></header>

        <div className="formRow">
          <input className="input" readOnly value="Max courts"/>
          <input className="input" type="number" min={1} max={12}
                 value={maxCourts}
                 onChange={(e)=>setMaxCourts(Number(e.target.value)||1)}/>
          <div/><div/>
        </div>

        <div className="formRow">
          <input className="input" readOnly value="Round length (minutes)"/>
          <input className="input" type="number" min={5} max={60}
                 value={Math.round(roundSeconds/60)}
                 onChange={(e)=>setRoundSeconds((Number(e.target.value)||12)*60)}/>
          <div/><div/>
        </div>

        <div className="formRow">
          <input className="input" readOnly value="Transition (seconds)"/>
          <input className="input" type="number" min={10} max={120}
                 value={transitionSeconds}
                 onChange={(e)=>setTransitionSeconds(Number(e.target.value)||30)}/>
          <div/><div/>
        </div>

        <div className="formRow">
          <input className="input" readOnly value="Matchmaking mode"/>
          <select className="select" value={mode} onChange={(e)=>setMode(e.target.value)}>
            <option value="band">Band (1–2 / 3–4 / 5–6 / 7–8 / 9–10)</option>
            <option value="window">Window (±R expand)</option>
          </select>
          <div/><div/>
        </div>

        <div className="formRow">
          <input className="input" readOnly value="Window size R"/>
          <input className="input" type="number" min={0} max={5}
                 value={windowSize}
                 onChange={(e)=>setWindowSize(Number(e.target.value)||2)}/>
          <div/><div/>
        </div>

        <footer>
          <button className="btn" onClick={()=>setOpen(false)}>Close</button>
        </footer>
      </div>
    </div>
  );
}

function SummaryModal({ summary, perPlayerRows, diag, onClose }) {
  return (
    <div className="modalOverlay" onClick={onClose}>
      <div className="modal" onClick={(e)=>e.stopPropagation()}>
        <header><h2>Smart Session Summary</h2></header>

        <div className="panelHi">
          <div><b>Rounds:</b> {summary.rounds}</div>
          <div><b>Participants:</b> {summary.participants}</div>
          <div><b>Courts avg used:</b> {summary.courtsAvg.toFixed(2)}</div>
          <div><b>Fairness</b> — mean played {summary.mean.toFixed(2)}, sd {summary.sd.toFixed(2)}, spread {summary.spread}, ratio {summary.ratio.toFixed(2)}</div>
        </div>

        <div className="panelHi" style={{marginTop:8}}>
          <h3>Per-Player</h3>
          <table className="table">
            <thead><tr>
              <th>Name</th><th>Lvl</th><th>Played</th><th>Benched</th>
              <th>Worst Bench Streak</th><th>Unique Teammates</th><th>Unique Opponents</th>
            </tr></thead>
            <tbody>
              {perPlayerRows.map(r=>(
                <tr key={r.id}>
                  <td>{r.name}</td><td>{r.lvl}</td><td>{r.played}</td>
                  <td>{r.benched}</td><td>{r.worst}</td>
                  <td>{r.uniqT}</td><td>{r.uniqO}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="panelHi" style={{marginTop:8}}>
          <h3>System Diagnostics</h3>
          <div>Build times (ms): {diag.buildTimes.length ? diag.buildTimes.join(', ') : '-'}</div>
          <div>Courts used per round: {diag.usedCourts.join(', ') || '-'}</div>
          <div>Team average diffs: {diag.diffs.map(d=>d.toFixed(2)).join(', ') || '-'}</div>
        </div>

        <footer>
          <button className="btn btn-primary" onClick={onClose}>Close & Reset</button>
        </footer>
      </div>
    </div>
  );
}

function AdminPanel({
  admin, adminPassword, setAdminPassword,
  showLevels, setShowLevels,
  players, onSavePlayers,
  present, sessionRounds
}) {
  const [name,setName]=useState('');
  const [gender,setGender]=useState('M');
  const [level,setLevel]=useState(5);
  const [bench,setBench]=useState(0);

  function addPlayer(){
    if(!name.trim()) return;
    const id = crypto.randomUUID();
    const p = {
      id, name:name.trim(), gender, skill_level:Number(level),
      is_present:false, bench_count:Number(bench)||0, last_played_round:0,
      created_at:new Date().toISOString()
    };
    onSavePlayers([p, ...players]);
    setName(''); setGender('M'); setLevel(5); setBench(0);
  }
  function removePlayer(id){
    if(!confirm('Delete player?')) return;
    onSavePlayers(players.filter(p=>p.id!==id));
  }
  function togglePresentAdmin(p){
    onSavePlayers(players.map(x=>x.id===p.id?{...x,is_present:!x.is_present}:x));
  }

  // Summary preview numbers
  const presentIds = new Set(present.map(p=>p.id));
  const { playedMap, benchedMap, meanPlayed, sdPlayed, spread, fairnessRatio } =
    fairnessStats(sessionRounds, presentIds);
  const { buildTimes, usedCourts, diffs } = roundDiagnostics(sessionRounds);

  return (
    <div className="panel" style={{marginTop:12}}>
      <div className="sectionTitle">Admin Controls</div>

      <div style={{display:'flex',gap:8,flexWrap:'wrap',marginBottom:8}}>
        <label className="chip">
          <input type="checkbox" checked={showLevels} onChange={e=>setShowLevels(e.target.checked)}/>
          &nbsp;Show player levels
        </label>
        <span className="chip">Admin password set: <b>{adminPassword ? 'Yes' : 'No'}</b></span>
        <span className="chip">Rounds: <b>{sessionRounds.length}</b></span>
      </div>

      <div className="formRow">
        <input className="input" placeholder="Set/change admin password (blank = none)"
               value={adminPassword} onChange={e=>setAdminPassword(e.target.value)}/>
        <div/><div/><div/>
      </div>

      <div className="formRow">
        <input className="input" placeholder="New player name" value={name} onChange={e=>setName(e.target.value)}/>
        <select className="select" value={gender} onChange={e=>setGender(e.target.value)}>
          <option value="M">M</option><option value="F">F</option>
        </select>
        <input className="input" type="number" min={1} max={10} value={level} onChange={e=>setLevel(Number(e.target.value)||1)}/>
        <div>
          <button className="btn btn-primary" onClick={addPlayer}>Add</button>
        </div>
      </div>

      <table className="table">
        <thead><tr>
          <th>Name</th><th>G</th><th>Lvl</th><th>Present</th><th>Bench</th><th>Actions</th>
        </tr></thead>
        <tbody>
          {players.map(p=>(
            <tr key={p.id}>
              <td>{p.name}</td>
              <td>{p.gender}</td>
              <td>{p.skill_level}</td>
              <td><button className="btn" onClick={()=>togglePresentAdmin(p)}>{p.is_present?'Yes':'No'}</button></td>
              <td>{p.bench_count||0}</td>
              <td><button className="btn btn-danger" onClick={()=>removePlayer(p.id)}>Delete</button></td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="panelHi" style={{marginTop:8}}>
        <h3>Smart Session Summary (live preview)</h3>
        <div>Build times: {buildTimes.join(', ') || '-'}</div>
        <div>Courts used: {usedCourts.join(', ') || '-'}</div>
        <div>Team diff avg: {diffs.length ? (diffs.reduce((s,x)=>s+x,0)/diffs.length).toFixed(2) : '-'}</div>
        <div>Fairness — mean {meanPlayed.toFixed(2)} sd {sdPlayed.toFixed(2)} spread {spread} ratio {fairnessRatio.toFixed(2)}</div>
      </div>
    </div>
  );
}

// -------------------- helpers --------------------

function computeSummary(sessionRounds, presentIdSet, presentList){
  const { playedMap, benchedMap, meanPlayed, sdPlayed, spread, fairnessRatio } =
    fairnessStats(sessionRounds, presentIdSet);
  const { buildTimes, usedCourts, diffs } = roundDiagnostics(sessionRounds);

  const perPlayerRows = presentList.map(p=>{
    const worst = countBackToBackBenches(p.id, sessionRounds);
    const { uniqTeammates, uniqOpponents } = perPlayerUniq(p.id, sessionRounds);
    return {
      id:p.id, name:p.name, lvl:p.skill_level,
      played: playedMap.get(p.id)||0,
      benched: benchedMap.get(p.id)||0,
      worst, uniqT: uniqTeammates, uniqO: uniqOpponents
    };
  }).sort((a,b)=> b.played - a.played || a.name.localeCompare(b.name));

  return {
    summary:{
      rounds: sessionRounds.length,
      participants: presentList.length,
      courtsAvg: usedCourts.length ? usedCourts.reduce((s,x)=>s+x,0)/usedCourts.length : 0,
      mean: meanPlayed, sd: sdPlayed, spread, ratio: fairnessRatio,
    },
    perPlayerRows,
    diag:{ buildTimes, usedCourts, diffs }
  };
}
