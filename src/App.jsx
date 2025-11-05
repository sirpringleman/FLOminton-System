import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  MATCH_MODES,
  getMatchMode,
  setMatchMode,
  selectPlayersForRound,
  buildMatchesFrom16,
  formatTime,
} from './logic';
import './App.css';

/* ================= Netlify Functions API ================= */
const API = '/.netlify/functions/players';

const APIClient = {
  async listPlayers(club) {
    const res = await fetch(club ? `${API}?club=${encodeURIComponent(club)}` : API, {
      method: 'GET',
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.message || 'Failed to load players');
    return (data || []).map((p) => ({
      id: p.id,
      name: p.name,
      gender: p.gender || 'M',
      skill_level: Number(p.skill_level) || 1,
      is_present: !!p.is_present,
      bench_count: Number(p.bench_count) || 0,
      last_played_round: Number(p.last_played_round) || 0,
      club_code: p.club_code || null,
    }));
  },
  async patch(updates, adminKey) {
    const res = await fetch(API, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-key': adminKey || '',
      },
      body: JSON.stringify({ updates }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.message || 'PATCH failed');
    return data;
  },
  async upsert(players, adminKey, club) {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey || '' },
      body: JSON.stringify({ players, club_code: club }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.message || 'UPSERT failed');
    return data;
  },
  async remove(ids, adminKey) {
    const res = await fetch(API, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', 'x-admin-key': adminKey || '' },
      body: JSON.stringify({ ids }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.message || 'DELETE failed');
    return data;
  },
};

/* ================= Local Storage helpers ================= */
const LS = {
  getNumber(k, def, min = -Infinity, max = Infinity) {
    try {
      const raw = localStorage.getItem(k);
      if (raw == null) return def;
      const n = Number(raw);
      if (Number.isFinite(n)) return clamp(n, min, max);
    } catch {}
    return def;
  },
  set(k, v) {
    try {
      localStorage.setItem(k, String(v));
    } catch {}
  },
};

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

/* ================= tiny audio for timer ================= */
function useBeep() {
  const ctxRef = useRef(null);
  const ensureCtx = () => {
    if (!ctxRef.current) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx) ctxRef.current = new Ctx();
    }
    return ctxRef.current;
  };
  const beep = (freq = 880, ms = 200, volume = 0.3) => {
    const ctx = ensureCtx();
    if (!ctx) return;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    osc.connect(gain);
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(volume, ctx.currentTime);
    osc.start();
    osc.stop(ctx.currentTime + ms / 1000);
  };
  return { beep };
}

/* =========================================================
   APP
   ========================================================= */
export default function App() {
  /* ---------- high-level view ---------- */
  const [view, setView] = useState('home');

  /* ---------- club selection (multi-club) ---------- */
  const [club, setClub] = useState(() => {
    try {
      return sessionStorage.getItem('club_code') || '';
    } catch {
      return '';
    }
  });

  /* ---------- data ---------- */
  const [players, setPlayers] = useState([]);
  const [loading, setLoading] = useState(true);

  /* ---------- session state ---------- */
  const [sessionActive, setSessionActive] = useState(false);
  const [roundNumber, setRoundNumber] = useState(1);
  const [currentMatches, setCurrentMatches] = useState([]);
  const [currentBenched, setCurrentBenched] = useState([]);
  const [lastBenchedIds, setLastBenchedIds] = useState(new Set());

  /* ---------- timer state ---------- */
  const [phase, setPhase] = useState('stopped'); // 'stopped' | 'round' | 'transition'
  const [timerLeft, setTimerLeft] = useState(0);
  const [running, setRunning] = useState(false);

  /* ---------- settings ---------- */
  const [roundMinutes, setRoundMinutes] = useState(() => LS.getNumber('roundMinutes', 12, 1, 60));
  const [transitionSeconds, setTransitionSeconds] = useState(() =>
    LS.getNumber('transitionSeconds', 30, 5, 120)
  );
  const [warnSeconds, setWarnSeconds] = useState(() => LS.getNumber('warnSeconds', 30, 5, 120));
  const [courts, setCourts] = useState(() => LS.getNumber('courts', 4, 1, 12));
  const [showSkill, setShowSkill] = useState(() => {
    try {
      return localStorage.getItem('showSkill') === '1';
    } catch {
      return false;
    }
  });

  const tickRef = useRef(null);

  const [showSettings, setShowSettings] = useState(false);
  const [showRundown, setShowRundown] = useState(false);
  const [adminKey, setAdminKey] = useState(() => sessionStorage.getItem('adminKey') || '');
  const isAdmin = !!adminKey;

  const [matchMode, setMatchModeState] = useState(() => getMatchMode());

  const [diag, setDiag] = useState({
    roundBuildTimes: [],
    usedCourts: [],
    teamImbalances: [],
    spanPerMatch: [],
  });

  const teammateHistoryRef = useRef(new Map());
  const benchDebtRef = useRef({}); // playerId -> debt
  const { beep } = useBeep();

  /* =========================================================
     LOAD PLAYERS
     ========================================================= */
  useEffect(() => {
    if (!club) return;
    (async () => {
      setLoading(true);
      try {
        const list = await APIClient.listPlayers(club);
        setPlayers(list);
      } catch (e) {
        console.error(e);
        if (view !== 'display') {
          alert('Could not load players (Netlify function). Check logs / env.');
        }
      } finally {
        setLoading(false);
      }
    })();
  }, [view, club]);

  /* ---------- derived lists ---------- */
  const present = useMemo(() => players.filter((p) => p.is_present), [players]);
  const notPresent = useMemo(() => players.filter((p) => !p.is_present), [players]);

  /* ---------- presence toggle ---------- */
  async function togglePresent(p) {
    const nv = !p.is_present;
    setPlayers((prev) => prev.map((x) => (x.id === p.id ? { ...x, is_present: nv } : x)));
    try {
      await APIClient.patch([{ id: p.id, is_present: nv }], adminKey);
    } catch (e) {
      console.error(e);
      alert('Failed to save presence toggle');
    }
  }

  /* =========================================================
     TIMER / PHASE LOGIC
     ========================================================= */
  const isWarn = phase === 'round' && running && timerLeft <= warnSeconds;
  const isBlink = (phase === 'round' || phase === 'transition') && timerLeft <= 0;

  useEffect(() => {
    if (!running) return;
    tickRef.current = setInterval(() => {
      setTimerLeft((old) => {
        if (old <= 1) {
          clearInterval(tickRef.current);
          if (phase === 'round') {
            // end round → start transition
            beep(600, 250, 0.5);
            startTransitionTimer();
          } else if (phase === 'transition') {
            // end transition → set up actual round
            beep(900, 180, 0.4);
            startRoundTimer();
          }
          return 0;
        }
        return old - 1;
      });
    }, 1000);
    return () => clearInterval(tickRef.current);
  }, [running, phase, beep]);

  function startRoundTimer() {
    setPhase('round');
    const secs = roundMinutes * 60;
    setTimerLeft(secs);
    setRunning(true);
  }

  function startTransitionTimer() {
    setPhase('transition');
    setTimerLeft(transitionSeconds);
    setRunning(true);
  }

  /* =========================================================
     ROUND BUILDING
     ========================================================= */
  async function nextRoundInternal() {
    const t0 = performance.now();

    // fairness-aware selection
    const { playing, benched } = selectPlayersForRound(
      present,
      roundNumber,
      lastBenchedIds,
      courts,
      benchDebtRef.current
    );

    // build matches with chosen mode
    const matches = buildMatchesFrom16(playing, teammateHistoryRef.current, courts, matchMode);

    // update local state
    setCurrentMatches(matches);
    setCurrentBenched(benched);
    setLastBenchedIds(new Set(benched.map((b) => b.id)));

    // update bench debt
    const newDebt = { ...benchDebtRef.current };
    for (const p of present) {
      const benchedThisTime = !!benched.find((b) => b.id === p.id);
      if (benchedThisTime) {
        newDebt[p.id] = (newDebt[p.id] || 0) + 1;
      } else {
        newDebt[p.id] = Math.max(0, (newDebt[p.id] || 0) - 1);
      }
    }
    benchDebtRef.current = newDebt;

    // update per-player round counters in memory
    setPlayers((prev) =>
      prev.map((p) => {
        const played = !!playing.find((pp) => pp.id === p.id);
        const benchedNow = !!benched.find((bb) => bb.id === p.id);
        return {
          ...p,
          last_played_round: played ? roundNumber : p.last_played_round,
          bench_count: benchedNow ? (p.bench_count || 0) + 1 : p.bench_count || 0,
        };
      })
    );

    // and persist to supabase
    try {
      const updates = [];
      for (const pl of playing) {
        updates.push({ id: pl.id, last_played_round: roundNumber });
      }
      for (const bn of benched) {
        updates.push({ id: bn.id, bench_count: (bn.bench_count || 0) + 1 });
      }
      if (updates.length > 0) {
        await APIClient.patch(updates, adminKey);
      }
    } catch (e) {
      console.error('Failed to persist round stats', e);
    }

    const t1 = performance.now();
    setDiag((d) => ({
      ...d,
      roundBuildTimes: [...d.roundBuildTimes, t1 - t0],
      usedCourts: [...d.usedCourts, matches.length],
      teamImbalances: [
        ...d.teamImbalances,
        ...matches.map((m) => Math.abs(m.avg1 - m.avg2)),
      ],
      spanPerMatch: [
        ...d.spanPerMatch,
        ...matches.map((m) => {
          const all = [...m.team1, ...m.team2].map((x) => x.skill_level);
          return Math.max(...all) - Math.min(...all);
        }),
      ],
    }));
  }

  async function onBuildResume() {
    if (currentMatches.length === 0) {
      // build first round
      await nextRoundInternal();
      setPhase('stopped');
      setRunning(false);
      setTimerLeft(roundMinutes * 60);
    } else {
      // just resume current phase timer
      if (phase === 'transition') {
        startTransitionTimer();
      } else {
        startRoundTimer();
      }
    }
  }

  function onPause() {
    setRunning(false);
  }

  async function onNextRound() {
    const next = roundNumber + 1;
    setRoundNumber(next);
    await nextRoundInternal();
    // skip transition if using manual next
    setPhase('round');
    setTimerLeft(roundMinutes * 60);
    setRunning(true);
  }

  async function onEndNight() {
    // reset everyone
    const resetPayload = players.map((p) => ({
      id: p.id,
      is_present: false,
      bench_count: 0,
      last_played_round: 0,
    }));
    setPlayers((prev) =>
      prev.map((p) => ({
        ...p,
        is_present: false,
        bench_count: 0,
        last_played_round: 0,
      }))
    );
    try {
      if (resetPayload.length > 0) {
        await APIClient.patch(resetPayload, adminKey);
      }
    } catch (e) {
      console.error(e);
    }

    setSessionActive(false);
    setRoundNumber(1);
    setCurrentMatches([]);
    setCurrentBenched([]);
    setLastBenchedIds(new Set());
    setPhase('stopped');
    setTimerLeft(roundMinutes * 60);
    setRunning(false);
    setShowRundown(true);
    setView('home');
  }

  async function onAddPlayer() {
    const name = prompt('Player name?');
    if (!name) return;
    const gender = prompt("Gender (M/F)?", 'M') || 'M';
    const skill = Number(prompt('Skill level 1-10?', '5') || 5);
    const newP = {
      name: name.trim(),
      gender,
      skill_level: skill,
      is_present: false,
      bench_count: 0,
      last_played_round: 0,
      club_code: club,
    };
    try {
      await APIClient.upsert([newP], adminKey, club);
      const refreshed = await APIClient.listPlayers(club);
      setPlayers(refreshed);
    } catch (e) {
      console.error(e);
      alert('Failed to add player');
    }
  }

  async function onDeletePlayer(id) {
    if (!window.confirm('Delete player?')) return;
    try {
      await APIClient.remove([id], adminKey);
      const refreshed = await APIClient.listPlayers(club);
      setPlayers(refreshed);
    } catch (e) {
      console.error(e);
      alert('Failed to delete player');
    }
  }

  function onAdmin() {
    const pwd = prompt('Admin password?');
    if (!pwd) return;
    setAdminKey(pwd);
    try {
      sessionStorage.setItem('adminKey', pwd);
    } catch {}
  }

  function onBeginNight() {
    setSessionActive(true);
    setView('session');
  }

  function onOpenDisplay() {
    setView((v) => (v === 'display' ? 'session' : 'display'));
  }

  const timerTotal = roundMinutes * 60;
  const transTotal = transitionSeconds;

  /* ========= CLUB GATE (early return) ========= */
  if (!club) {
    return <ClubGate onSelect={setClub} />;
  }

  /* =========================================================
     RENDER
     ========================================================= */
  return (
    <div className="app-shell">
      <header className="top-bar">
        <div className="left">
          <div className="brand">🏸 The FLOminton System ({club})</div>
        </div>
        <div className="right">
          {view !== 'home' && (
            <>
              <button className="primary" onClick={onBeginNight}>
                Session
              </button>
              <button onClick={() => setShowSettings(true)}>Settings</button>
              <button onClick={onAdmin}>Admin</button>
              <button className="danger" onClick={onEndNight}>
                End Night
              </button>
            </>
          )}
        </div>
      </header>

      {view === 'home' && (
        <main className="home-screen">
          <button className="primary big" onClick={onBeginNight}>
            Begin Night
          </button>
          <button onClick={() => setShowSettings(true)}>Settings</button>
          <button onClick={onAdmin}>Admin mode</button>
          <button className="danger" onClick={onEndNight}>
            End Night
          </button>
        </main>
      )}

      {view === 'session' && (
        <main className="session">
          <div className="controls-row">
            <button className="primary" onClick={onBuildResume}>
              Build/Resume
            </button>
            <button onClick={onPause}>Pause</button>
            <button onClick={onNextRound}>Next Round</button>
            <button className="danger" onClick={onEndNight}>
              End Night
            </button>
            <button onClick={onOpenDisplay}>
              {view === 'display' ? 'Back to Session' : 'Open Display'}
            </button>
            <button
              onClick={() => {
                const next =
                  matchMode === MATCH_MODES.BAND ? MATCH_MODES.WINDOW : MATCH_MODES.BAND;
                setMatchModeState(next);
                setMatchMode(next);
              }}
            >
              Mode: {matchMode === MATCH_MODES.BAND ? 'Band' : 'Window'}
            </button>
            <div
              className={`round-counter ${
                isBlink ? 'blink-red' : isWarn ? 'warn-orange' : ''
              }`}
            >
              Round {roundNumber} · {formatTime(timerLeft)}
            </div>
          </div>

          {/* courts */}
          <div className="courts">
            {currentMatches.map((m) => (
              <div key={m.court} className="court-card">
                <div className="court-title">
                  Court {m.court}
                  {isAdmin && (
                    <span className="court-avgs">
                      Team 1 Avg <b>{m.avg1.toFixed(1)}</b> · Team 2 Avg 
                      <b>{m.avg2.toFixed(1)}</b>
                    </span>
                  )}
                </div>
                <div className="team-row">
                  {m.team1.map((p) => (
                    <PlayerChip key={p.id} player={p} showSkill={showSkill} />
                  ))}
                </div>
                <div className="net-divider" />
                <div className="team-row">
                  {m.team2.map((p) => (
                    <PlayerChip key={p.id} player={p} showSkill={showSkill} />
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* benched */}
          <div className="bench-strip">
            <h3>Benched Players</h3>
            <div className="bench-list">
              {currentBenched.map((p) => (
                <PlayerChip key={p.id} player={p} showSkill={showSkill} />
              ))}
            </div>
          </div>

          {/* lists */}
          <div className="lists-row">
            <div className="list-panel">
              <div className="panel-head">
                All Players <span className="pill">{players.length}</span>
              </div>
              <div className="list-body">
                {notPresent.map((p) => (
                  <div
                    key={p.id}
                    className="list-item"
                    onDoubleClick={() => togglePresent(p)}
                  >
                    {p.name}
                    {isAdmin && (
                      <button
                        onClick={() => onDeletePlayer(p.id)}
                        className="icon-btn"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                ))}
              </div>
              {isAdmin && (
                <button className="full" onClick={onAddPlayer}>
                  + Add player
                </button>
              )}
            </div>

            <div className="list-panel">
              <div className="panel-head">
                Present Today <span className="pill">{present.length}</span>
              </div>
              <div className="list-body">
                {present.map((p) => (
                  <div
                    key={p.id}
                    className="list-item"
                    onDoubleClick={() => togglePresent(p)}
                  >
                    {p.name}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </main>
      )}

      {view === 'display' && (
        <div className="display-overlay">
          <div className="display-top">
            <div className="title">🏸 The FLOminton System ({club})</div>
            <div
              className={`big-timer ${
                isBlink ? 'blink-red' : isWarn ? 'warn-orange' : ''
              }`}
            >
              {formatTime(timerLeft)}
            </div>
            <div className="subtitle">
              Round {roundNumber} · Present {present.length}
            </div>
            <button onClick={onOpenDisplay}>Back</button>
          </div>

          <div className="display-courts">
            {currentMatches.map((m) => (
              <div key={m.court} className="display-court">
                <div className="display-court-title">Court {m.court}</div>
                <div className="display-team-row">
                  {m.team1.map((p) => (
                    <PlayerChip key={p.id} player={p} showSkill={showSkill} />
                  ))}
                </div>
                <div className="net-divider" />
                <div className="display-team-row">
                  {m.team2.map((p) => (
                    <PlayerChip key={p.id} player={p} showSkill={showSkill} />
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="display-bench">
            {currentBenched.map((p) => (
              <PlayerChip key={p.id} player={p} showSkill={showSkill} />
            ))}
          </div>
        </div>
      )}

      {showSettings && (
        <SettingsModal
          onClose={() => setShowSettings(false)}
          roundMinutes={roundMinutes}
          setRoundMinutes={setRoundMinutes}
          transitionSeconds={transitionSeconds}
          setTransitionSeconds={setTransitionSeconds}
          warnSeconds={warnSeconds}
          setWarnSeconds={setWarnSeconds}
          courts={courts}
          setCourts={setCourts}
          showSkill={showSkill}
          setShowSkill={setShowSkill}
        />
      )}

      {showRundown && (
        <RundownModal
          onClose={() => setShowRundown(false)}
          players={players}
          rounds={roundNumber - 1}
        />
      )}
    </div>
  );
}

/* =========================================================
   COMPONENTS
   ========================================================= */

function PlayerChip({ player, showSkill }) {
  return (
    <span className={`player-chip ${player.gender === 'F' ? 'f' : 'm'}`}>
      {player.name}
      {showSkill && <span className="skill-tag">L{player.skill_level}</span>}
    </span>
  );
}

function SettingsModal({
  onClose,
  roundMinutes,
  setRoundMinutes,
  transitionSeconds,
  setTransitionSeconds,
  warnSeconds,
  setWarnSeconds,
  courts,
  setCourts,
  showSkill,
  setShowSkill,
}) {
  const [rd, setRd] = useState(roundMinutes);
  const [tr, setTr] = useState(transitionSeconds);
  const [wr, setWr] = useState(warnSeconds);
  const [ct, setCt] = useState(courts);
  const [sk, setSk] = useState(showSkill);

  const save = () => {
    setRoundMinutes(rd);
    setTransitionSeconds(tr);
    setWarnSeconds(wr);
    setCourts(ct);
    setShowSkill(sk);
    LS.set('roundMinutes', rd);
    LS.set('transitionSeconds', tr);
    LS.set('warnSeconds', wr);
    LS.set('courts', ct);
    localStorage.setItem('showSkill', sk ? '1' : '0');
    onClose();
  };

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h3>Settings</h3>
        <label>
          Round duration (min)
          <input
            type="number"
            value={rd}
            min="1"
            onChange={(e) => setRd(Number(e.target.value))}
          />
        </label>
        <label>
          Transition (seconds)
          <input
            type="number"
            value={tr}
            min="5"
            onChange={(e) => setTr(Number(e.target.value))}
          />
        </label>
        <label>
          Warn at (seconds)
          <input
            type="number"
            value={wr}
            min="5"
            onChange={(e) => setWr(Number(e.target.value))}
          />
        </label>
        <label>
          Courts available
          <input
            type="number"
            value={ct}
            min="1"
            onChange={(e) => setCt(Number(e.target.value))}
          />
        </label>
        <label className="inline">
          <input
            type="checkbox"
            checked={sk}
            onChange={(e) => setSk(e.target.checked)}
          />
          Show skill on chips
        </label>
        <div className="modal-actions">
          <button onClick={onClose}>Close</button>
          <button className="primary" onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function RundownModal({ onClose, players, rounds }) {
  return (
    <div className="modal-backdrop">
      <div className="modal wide">
        <h3>Smart Session Summary</h3>
        <p>
          Total Rounds: <b>{rounds}</b>
        </p>
        <table className="summary-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Level</th>
              <th>Played</th>
              <th>Benched</th>
            </tr>
          </thead>
          <tbody>
            {players.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td>{p.skill_level}</td>
                <td>{p.last_played_round || 0}</td>
                <td>{p.bench_count || 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="modal-actions">
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

function ClubGate({ onSelect }) {
  const [pwd, setPwd] = useState('');
  const [err, setErr] = useState('');

  const tryClub = () => {
    const trimmed = pwd.trim();
    if (trimmed === 'abc2025') {
      onSelect('ABC');
      sessionStorage.setItem('club_code', 'ABC');
    } else if (trimmed === '2025embc') {
      onSelect('EMBC');
      sessionStorage.setItem('club_code', 'EMBC');
    } else {
      setErr('Invalid club password');
    }
  };

  return (
    <div className="club-gate">
      <div className="club-gate-card">
        <h2>Select Your Club</h2>
        <input
          type="password"
          value={pwd}
          onChange={(e) => setPwd(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && tryClub()}
          placeholder="Club password"
        />
        {err && <div className="error">{err}</div>}
        <button onClick={tryClub}>Continue</button>
      </div>
    </div>
  );
}
