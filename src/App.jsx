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

// ------- sound helpers -------
const beep = (freq = 880, ms = 130) => {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.value = freq;
    o.connect(g);
    g.connect(ctx.destination);
    o.start();
    g.gain.exponentialRampToValueAtTime(0.00001, ctx.currentTime + ms / 1000);
    setTimeout(() => {
      try {
        o.stop();
        ctx.close();
      } catch {}
    }, ms + 40);
  } catch {}
};
const chime = () => {
  beep(880, 120);
  setTimeout(() => beep(1200, 120), 140);
};

const fmt2 = (n) => (n < 10 ? `0${n}` : `${n}`);
const toMMSS = (s) => `${fmt2(Math.floor(s / 60))}:${fmt2(s % 60)}`;

// ============================================================
//                         APP
// ============================================================

export default function App() {
  // Views
  const [view, setView] = useState('home'); // 'home' | 'session' | 'display'

  // Data
  const [players, setPlayers] = useState([]);

  // Settings (local state; no context)
  const [maxCourts, setMaxCourts] = useState(4);
  const [mode, setMode] = useState('band'); // 'band' | 'window'
  const [windowSize, setWindowSize] = useState(2);
  const [roundSeconds, setRoundSeconds] = useState(12 * 60);
  const [transitionSeconds, setTransitionSeconds] = useState(30);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Admin
  const [admin, setAdmin] = useState(false);
  const [adminPassword, setAdminPassword] = useState(''); // optional
  const [adminModal, setAdminModal] = useState(false);
  const [passwordInput, setPasswordInput] = useState('');
  const [showLevels, setShowLevels] = useState(true); // toggle inside Admin Panel

  // Run state
  const [round, setRound] = useState(1);
  const [matches, setMatches] = useState([]);
  const [benched, setBenched] = useState([]);
  const [running, setRunning] = useState(false);
  const [timer, setTimer] = useState(roundSeconds);
  const [transition, setTransition] = useState(0);
  const tRef = useRef(null);

  // For prebuilt “next” matches during transition
  const nextMatchesRef = useRef(null);

  // Session analytics
  const [sessionRounds, setSessionRounds] = useState([]); // [{round, matches, meta}]

  // --------------- API ---------------
  async function fetchPlayers() {
    try {
      const res = await fetch(API);
      const data = await res.json();
      setPlayers(Array.isArray(data) ? data : []);
    } catch {
      alert('Could not load players from server.');
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

  // Derived lists/maps
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

  // --------------- Admin Lock ---------------
  function openAdmin() {
    setPasswordInput('');
    setAdminModal(true);
  }
  function closeAdminModal() {
    setAdminModal(false);
  }
  function submitAdmin() {
    if (!adminPassword || passwordInput === adminPassword) {
      setAdmin(true);
      setAdminModal(false);
    } else {
      alert('Incorrect password.');
    }
  }
  function exitAdmin() {
    setAdmin(false);
  }

  // --------------- Player CRUD ---------------
  const [editId, setEditId] = useState('');
  const [editName, setEditName] = useState('');
  const [editGender, setEditGender] = useState('M');
  const [editLevel, setEditLevel] = useState(5);
  const [editBench, setEditBench] = useState(0);

  function startNew() {
    setEditId('');
    setEditName('');
    setEditGender('M');
    setEditLevel(5);
    setEditBench(0);
  }
  function selectEdit(p) {
    setEditId(p.id);
    setEditName(p.name);
    setEditGender(p.gender || 'M');
    setEditLevel(p.skill_level || 5);
    setEditBench(p.bench_count || 0);
  }
  function saveOne() {
    if (!editName.trim()) return;
    if (editId) {
      const updated = players.map((p) =>
        p.id === editId
          ? {
              ...p,
              name: editName.trim(),
              gender: editGender,
              skill_level: Number(editLevel),
              bench_count: Number(editBench),
            }
          : p
      );
      savePlayers(updated);
    } else {
      const id = crypto.randomUUID();
      const p = {
        id,
        name: editName.trim(),
        gender: editGender,
        skill_level: Number(editLevel),
        is_present: false,
        bench_count: Number(editBench) || 0,
        last_played_round: 0,
        created_at: new Date().toISOString(),
      };
      savePlayers([p, ...players]);
    }
    startNew();
  }
  function deleteOne(id) {
    if (!confirm('Delete player?')) return;
    const updated = players.filter((p) => p.id !== id);
    savePlayers(updated);
    if (editId === id) startNew();
  }

  // --------------- Session flow ---------------
  function beginNight() {
    setRound(1);
    setMatches([]);
    setBenched([]);
    setSessionRounds([]);
    setTransition(0);
    setTimer(roundSeconds);
    setRunning(false);
    setView('session');
  }

  function togglePresent(p) {
    const updated = players.map((x) =>
      x.id === p.id ? { ...x, is_present: !x.is_present } : x
    );
    savePlayers(updated);
  }

  // Build/Resume: if we already have matches and are paused, resume; otherwise build & start
  function buildOrResume() {
    if (matches.length && !transition && !running) {
      setRunning(true);
      return;
    }
    buildRound(round, true);
  }

  function nextRound() {
    if (transition) return;
    prepareNext();
  }

  async function endNight() {
    // Unmark everyone present; keep bench counters (unless manually changed)
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
      setRunning(false);
      setTimer(roundSeconds);
      setView('home');
    }
  }

  // Build helpers
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

    // compute benched
    const playIds = new Set(
      built.flatMap((m) => [...m.team1, ...m.team2].map((p) => p.id))
    );
    const newBenched = present.filter((p) => !playIds.has(p.id));

    setMatches(built);
    setBenched(newBenched);

    // update bench_count & last_played_round
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

  // Timer / transition engine
  useEffect(() => {
    if (!running && !transition) return;
    tRef.current && clearInterval(tRef.current);
    tRef.current = setInterval(() => {
      if (transition) {
        setTransition((s) => {
          if (s <= 1) {
            const nm = nextMatchesRef.current;
            const built = nm?.built || [];
            const newBenched = nm?.newBenched || [];

            setMatches(built);
            setBenched(newBenched);

            // update per-player stats for *new* round
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
            // start fixed 30s transition before new round
            prepareNext();
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

  // ========================= VIEWS =========================

  // HOME
  if (view === 'home') {
    return (
      <div className="container">
        <div className="welcome panel">
          <div className="brand">🏸 TheFLOminton System</div>
          <div style={{ marginTop: 10, color: 'var(--muted)' }}>
            Automated, fair doubles matchmaking for club night.
          </div>
          <div
            style={{
              marginTop: 14,
              display: 'flex',
              gap: 8,
              justifyContent: 'center',
              flexWrap: 'wrap',
            }}
          >
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

        <SessionLists
          players={allPlayers}
          present={present}
          showLevels={admin && showLevels}
          onTogglePresent={togglePresent}
          admin={admin}
          adminPanel={
            admin && (
              <AdminPanel
                admin={admin}
                adminPassword={adminPassword}
                setAdminPassword={setAdminPassword}
                showLevels={showLevels}
                setShowLevels={setShowLevels}
                players={players}
                onSavePlayers={savePlayers}
                editId={editId}
                editName={editName}
                editGender={editGender}
                editLevel={editLevel}
                editBench={editBench}
                setEditId={setEditId}
                setEditName={setEditName}
                setEditGender={setEditGender}
                setEditLevel={setEditLevel}
                setEditBench={setEditBench}
                onStartNew={startNew}
                onSelectEdit={selectEdit}
                onSaveOne={saveOne}
                onDeleteOne={deleteOne}
                sessionRounds={sessionRounds}
                present={present}
              />
            )
          }
        />

        {adminModal && (
          <LockModal
            title="Admin Access"
            passwordInput={passwordInput}
            setPasswordInput={setPasswordInput}
            onClose={closeAdminModal}
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

  // DISPLAY (big centered timer, flashing at transition, benched row at bottom)
  if (view === 'display') {
    return (
      <div className="displayPage">
        <div className="displayHeader">
          <div className="displayRound">Round {round}</div>
          <div
            className={`displayTimer ${isYellow ? 'yellow' : ''} ${
              isFlashing ? 'flash' : ''
            }`}
          >
            {transition ? toMMSS(transition) : toMMSS(timer)}
          </div>
        </div>

        <div className="grid bigNames">
          {!matches.length && !transition && (
            <div
              className="panel"
              style={{ gridColumn: '1 / span 2', textAlign: 'center', color: 'var(--muted)' }}
            >
              Waiting for matches…
            </div>
          )}
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

        <div className="container" style={{ marginTop: 12 }}>
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
            <button
              className={mode === 'band' ? 'active' : ''}
              onClick={() => setMode('band')}
            >
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
                  {showLevels ? ` · L${p.skill_level}` : ''}
                </span>
              ))}
            </div>
            <div className="rail" />
            <div className="chips">
              {m.team2.map((p) => (
                <span key={p.id} className={`chip ${p.gender === 'F' ? 'f' : 'm'}`}>
                  {p.name}
                  {showLevels ? ` · L${p.skill_level}` : ''}
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
      <SessionLists
        players={allPlayers}
        present={present}
        showLevels={admin && showLevels}
        onTogglePresent={togglePresent}
        admin={admin}
        adminPanel={
          admin && (
            <AdminPanel
              admin={admin}
              adminPassword={adminPassword}
              setAdminPassword={setAdminPassword}
              showLevels={showLevels}
              setShowLevels={setShowLevels}
              players={players}
              onSavePlayers={savePlayers}
              editId={editId}
              editName={editName}
              editGender={editGender}
              editLevel={editLevel}
              editBench={editBench}
              setEditId={setEditId}
              setEditName={setEditName}
              setEditGender={setEditGender}
              setEditLevel={setEditLevel}
              setEditBench={setEditBench}
              onStartNew={startNew}
              onSelectEdit={selectEdit}
              onSaveOne={saveOne}
              onDeleteOne={deleteOne}
              sessionRounds={sessionRounds}
              present={present}
            />
          )
        }
      />

      {/* Modals */}
      {adminModal && (
        <LockModal
          title="Admin Access"
          passwordInput={passwordInput}
          setPasswordInput={setPasswordInput}
          onClose={() => setAdminModal(false)}
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

// ========================= SUB-COMPONENTS =========================

function SettingsModal({
  open,
  setOpen,
  maxCourts,
  setMaxCourts,
  roundSeconds,
  setRoundSeconds,
  transitionSeconds,
  setTransitionSeconds,
  mode,
  setMode,
  windowSize,
  setWindowSize,
}) {
  if (!open) return null;
  return (
    <div className="modalOverlay" onClick={() => setOpen(false)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>Settings</h2>
        </header>

        <div className="formRow">
          <input className="input" readOnly value="Max courts" />
          <input
            className="input"
            type="number"
            min={1}
            max={12}
            value={maxCourts}
            onChange={(e) => setMaxCourts(Number(e.target.value) || 1)}
          />
          <div />
          <div />
        </div>

        <div className="formRow">
          <input className="input" readOnly value="Round length (minutes)" />
          <input
            className="input"
            type="number"
            min={5}
            max={60}
            value={Math.round(roundSeconds / 60)}
            onChange={(e) => setRoundSeconds((Number(e.target.value) || 12) * 60)}
          />
          <div />
          <div />
        </div>

        <div className="formRow">
          <input className="input" readOnly value="Transition length (seconds)" />
          <input
            className="input"
            type="number"
            min={10}
            max={120}
            value={transitionSeconds}
            onChange={(e) => setTransitionSeconds(Number(e.target.value) || 30)}
          />
          <div />
          <div />
        </div>

        <div className="formRow">
          <input className="input" readOnly value="Matchmaking mode" />
          <select className="select" value={mode} onChange={(e) => setMode(e.target.value)}>
            <option value="band">Band (1–2/3–4/5–6/7–8/9–10)</option>
            <option value="window">Window (±R expand)</option>
          </select>
          <div />
          <div />
        </div>

        <div className="formRow">
          <input className="input" readOnly value="Window size R (Window mode)" />
          <input
            className="input"
            type="number"
            min={0}
            max={5}
            value={windowSize}
            onChange={(e) => setWindowSize(Number(e.target.value) || 2)}
          />
          <div />
          <div />
        </div>

        <footer>
          <button className="btn" onClick={() => setOpen(false)}>
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}

function SessionLists({ players, present, showLevels, onTogglePresent, admin, adminPanel }) {
  return (
    <div className="columns" style={{ marginTop: 12 }}>
      <div className="list">
        <h4>
          All Players <span className="sub">{players.length - present.length}</span>
        </h4>
        {players
          .filter((p) => !p.is_present)
          .map((p) => (
            <div key={p.id} className="row" onDoubleClick={() => onTogglePresent(p)}>
              {p.name}
              {showLevels ? ` · L${p.skill_level}` : ''}
            </div>
          ))}
      </div>
      <div className="list">
        <h4>
          Present Today <span className="sub">{present.length}</span>
        </h4>
        {present.map((p) => (
          <div key={p.id} className="row" onDoubleClick={() => onTogglePresent(p)}>
            {p.name}
            {showLevels ? ` · L${p.skill_level}` : ''}
          </div>
        ))}
      </div>
      <div style={{ gridColumn: '1 / span 2' }}>{adminPanel}</div>
    </div>
  );
}

function AdminPanel({
  admin,
  adminPassword,
  setAdminPassword,
  showLevels,
  setShowLevels,
  players,
  onSavePlayers,
  editId,
  editName,
  editGender,
  editLevel,
  editBench,
  setEditId,
  setEditName,
  setEditGender,
  setEditLevel,
  setEditBench,
  onStartNew,
  onSelectEdit,
  onSaveOne,
  onDeleteOne,
  sessionRounds,
  present,
}) {
  if (!admin) return null;

  // Smart Session Summary
  const presentIds = new Set(present.map((p) => p.id));
  const { playedMap, benchedMap, meanPlayed, sdPlayed, spread, fairnessRatio } =
    fairnessStats(sessionRounds, presentIds);
  const { buildTimes, usedCourts, diffs, oobCounts } = roundDiagnostics(sessionRounds);

  const perPlayerRows = present
    .map((p) => {
      const worstBenchStreak = countBackToBackBenches(p.id, sessionRounds);
      const { uniqTeammates, uniqOpponents } = perPlayerUniq(p.id, sessionRounds);
      return {
        id: p.id,
        name: p.name,
        lvl: p.skill_level,
        played: playedMap.get(p.id) || 0,
        benched: benchedMap.get(p.id) || 0,
        worstBenchStreak,
        uniqTeammates,
        uniqOpponents,
      };
    })
    .sort((a, b) => b.played - a.played || a.name.localeCompare(b.name));

  function exportCSV() {
    const header = [
      'Name',
      'Level',
      'Played',
      'Benched',
      'WorstBenchStreak',
      'UniqueTeammates',
      'UniqueOpponents',
    ];
    const rows = perPlayerRows.map((r) => [
      r.name,
      r.lvl,
      r.played,
      r.benched,
      r.worstBenchStreak,
      r.uniqTeammates,
      r.uniqOpponents,
    ]);
    const csv = [header, ...rows].map((a) => a.join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'session_summary.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  function copySummary() {
    const lines = [];
    lines.push(`Rounds: ${sessionRounds.length}`);
    lines.push(`Participants: ${present.length}`);
    lines.push(`Courts avg used: ${avg(usedCourts).toFixed(2)}`);
    lines.push(
      `Fairness — mean played ${meanPlayed.toFixed(2)}, sd ${sdPlayed.toFixed(
        2
      )}, spread ${spread}, ratio ${fairnessRatio.toFixed(2)}`
    );
    navigator.clipboard.writeText(lines.join('\n'));
    alert('Summary copied to clipboard.');
  }

  return (
    <div className="panel">
      <div className="sectionTitle">Admin Controls</div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
        <label className="chip">
          <input
            type="checkbox"
            checked={showLevels}
            onChange={(e) => setShowLevels(e.target.checked)}
          />
          &nbsp;Show player levels
        </label>
        <span className="chip">
          Admin password set: <b>{adminPassword ? 'Yes' : 'No'}</b>
        </span>
        <span className="chip">
          Rounds this session: <b>{sessionRounds.length}</b>
        </span>
      </div>

      <div className="formRow">
        <input
          className="input"
          placeholder="Set/Change admin password (blank = no password)"
          value={adminPassword}
          onChange={(e) => setAdminPassword(e.target.value)}
        />
        <div />
        <div />
        <div />
      </div>

      {/* CRUD form */}
      <div className="formRow">
        <input
          className="input"
          placeholder="Full name"
          value={editName}
          onChange={(e) => setEditName(e.target.value)}
        />
        <select
          className="select"
          value={editGender}
          onChange={(e) => setEditGender(e.target.value)}
        >
          <option value="M">M</option>
          <option value="F">F</option>
        </select>
        <input
          className="input"
          type="number"
          min={1}
          max={10}
          value={editLevel}
          onChange={(e) => setEditLevel(Number(e.target.value) || 1)}
        />
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            className="input"
            type="number"
            min={0}
            max={999}
            value={editBench}
            onChange={(e) => setEditBench(Number(e.target.value) || 0)}
            title="Bench counter (manual override)"
          />
          <button className="btn btn-primary" onClick={saveOne}>
            {editId ? 'Update' : 'Add'}
          </button>
          <button className="btn" onClick={onStartNew}>
            Clear
          </button>
        </div>
      </div>

      <table className="table">
        <thead>
          <tr>
            <th>Name</th>
            <th>G</th>
            <th>Level</th>
            <th>Present</th>
            <th>Bench</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {players.map((p) => (
            <tr key={p.id}>
              <td>{p.name}</td>
              <td>{p.gender}</td>
              <td>{p.skill_level}</td>
              <td>{p.is_present ? 'Yes' : 'No'}</td>
              <td>{p.bench_count || 0}</td>
              <td>
                <button className="btn" onClick={() => onSelectEdit(p)}>
                  Edit
                </button>
                <button className="btn btn-danger" onClick={() => onDeleteOne(p.id)}>
                  Delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Smart Session Summary */}
      <div className="panelHi" style={{ marginTop: 12 }}>
        <h3>Smart Session Summary</h3>
        <div className="sectionTitle">Overview</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          <div>
            <div>
              Rounds: <b>{sessionRounds.length}</b>
            </div>
            <div>
              Participants (present): <b>{present.length}</b>
            </div>
            <div>
              Courts used (avg): <b>{avg(usedCourts).toFixed(2)}</b>
            </div>
            <div>
              Build times (ms): <i>{buildTimes.length ? buildTimes.join(', ') : '-'}</i>
            </div>
          </div>
          <div>
            <div>
              Fairness — mean played: <b>{meanPlayed.toFixed(2)}</b>, sd:{' '}
              <b>{sdPlayed.toFixed(2)}</b>
            </div>
            <div>
              Spread (max-min played): <b>{spread}</b>
            </div>
            <div>
              Fairness ratio (sd/mean): <b>{fairnessRatio.toFixed(2)}</b>
            </div>
            <div>
              Avg team diff per round:{' '}
              <i>{diffs.map((v) => v.toFixed(2)).join(', ') || '-'}</i>
            </div>
          </div>
        </div>

        <div className="sectionTitle" style={{ marginTop: 10 }}>
          Per-Player
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Lvl</th>
              <th>Played</th>
              <th>Benched</th>
              <th>Worst Bench Streak</th>
              <th>Unique Teammates</th>
              <th>Unique Opponents</th>
            </tr>
          </thead>
          <tbody>
            {perPlayerRows.map((r) => (
              <tr key={r.id}>
                <td>{r.name}</td>
                <td>{r.lvl}</td>
                <td>{r.played}</td>
                <td>{r.benched}</td>
                <td>{r.worstBenchStreak}</td>
                <td>{r.uniqTeammates}</td>
                <td>{r.uniqOpponents}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <div style={{ textAlign: 'right', marginTop: 8 }}>
          <button className="btn" onClick={copySummary}>
            Copy Summary
          </button>
          <button className="btn btn-primary" onClick={exportCSV} style={{ marginLeft: 8 }}>
            Export CSV
          </button>
        </div>
      </div>

      {/* Diagnostics */}
      <div className="panelHi" style={{ marginTop: 12 }}>
        <h3>System Diagnostics</h3>
        <div>
          Mode: <b>{mode}</b>
          {mode === 'window' ? ` (±${windowSize})` : ''}
        </div>
        <div>
          Courts configured: <b>{maxCourts}</b>
        </div>
        <div>
          Round length: <b>{Math.round(roundSeconds / 60)} min</b>; Transition:{' '}
          <b>{transitionSeconds}s</b>
        </div>
        <div>
          Out-of-band (Band expands &gt; neighbor) per round:{' '}
          <i>{(roundDiagnostics(sessionRounds).oobCounts || []).join(', ') || '-'}</i>
        </div>
      </div>
    </div>
  );
}

// -------------- small helpers --------------

function LockModal({ title, passwordInput, setPasswordInput, onSubmit, onClose }) {
  return (
    <div className="modalOverlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>{title}</h2>
        </header>
        <div className="formRow">
          <input
            className="input"
            type="password"
            placeholder="Password (blank allowed if unset)"
            value={passwordInput}
            onChange={(e) => setPasswordInput(e.target.value)}
          />
          <div />
          <div />
          <div />
        </div>
        <footer>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={onSubmit} style={{ marginLeft: 8 }}>
            Unlock
          </button>
        </footer>
      </div>
    </div>
  );
}

function avg(arr) {
  return arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0;
}
