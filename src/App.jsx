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

const API = '/.netlify/functions/players';

const APIClient = {
  async listPlayers(club) {
    const res = await fetch(club ? `${API}?club=${encodeURIComponent(club)}` : API, {
      method: 'GET',
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || 'Failed to load players');
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
        ...(adminKey ? { 'X-Admin-Key': adminKey } : {}),
      },
      body: JSON.stringify({ updates }),
    });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }
    if (!res.ok) throw new Error(data?.error || 'PATCH failed');
    return data;
  },
  async upsert(players, adminKey, club) {
    const res = await fetch(API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(adminKey ? { 'X-Admin-Key': adminKey } : {}),
      },
      body: JSON.stringify({ players, club_code: club }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || 'UPSERT failed');
    return data;
  },
  async remove(ids, adminKey) {
    const res = await fetch(API, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', ...(adminKey ? { 'X-Admin-Key': adminKey } : {}) },
      body: JSON.stringify({ id: ids[0] }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.error || 'DELETE failed');
    return data;
  },
};

const LS = {
  getNum(k, def, min, max) {
    try {
      const v = Number(localStorage.getItem(k));
      if (Number.isFinite(v)) return Math.max(min, Math.min(max, v));
    } catch {}
    return def;
  },
  set(k, v) {
    try {
      localStorage.setItem(k, String(v));
    } catch {}
  },
};

function useBeep(volumeRef) {
  const ctxRef = useRef(null);
  const ensure = () => {
    if (!ctxRef.current) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      ctxRef.current = new Ctx();
    }
    return ctxRef.current;
  };
  const beep = (freq = 900, ms = 250) => {
    const ctx = ensure();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const vol = Math.max(0, Math.min(1, volumeRef.current ?? 0.3));
    osc.frequency.value = freq;
    osc.connect(gain);
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(vol, ctx.currentTime);
    osc.start();
    osc.stop(ctx.currentTime + ms / 1000);
  };
  return { beep };
}

export default function App() {
  // club gate
  const [club, setClub] = useState(() => {
    try {
      return sessionStorage.getItem('club_code') || '';
    } catch {
      return '';
    }
  });

  // main state
  const [players, setPlayers] = useState([]);
  const [loading, setLoading] = useState(true);

  const [view, setView] = useState('home'); // home | session | display

  const [round, setRound] = useState(0);
  const roundRef = useRef(0);

  const [matches, setMatches] = useState([]);
  const [benched, setBenched] = useState([]);

  const [phase, setPhase] = useState('stopped'); // stopped | round | transition
  const [running, setRunning] = useState(false);
  const [timerLeft, setTimerLeft] = useState(LS.getNum('flo.round.minutes', 12, 3, 60) * 60);
  const [transitionLeft, setTransitionLeft] = useState(LS.getNum('flo.transition.seconds', 30, 5, 120));
  const [timerTotal, setTimerTotal] = useState(LS.getNum('flo.round.minutes', 12, 3, 60) * 60);
  const [warnSeconds, setWarnSeconds] = useState(LS.getNum('flo.warn.seconds', 30, 5, 120));
  const [transitionSeconds, setTransitionSeconds] = useState(
    LS.getNum('flo.transition.seconds', 30, 5, 120)
  );
  const [courtsCount, setCourtsCount] = useState(LS.getNum('flo.courts', 4, 1, 12));
  const [matchMode, setMatchModeState] = useState(() => getMatchMode());

  const [showSettings, setShowSettings] = useState(false);
  const [showSummary, setShowSummary] = useState(false);
  const [showAdminModal, setShowAdminModal] = useState(false);
  const [showAddPlayerModal, setShowAddPlayerModal] = useState(false);

  const [adminKey, setAdminKey] = useState(() => sessionStorage.getItem('adminKey') || '');
  const isAdmin = !!adminKey;

  const tickRef = useRef(null);
  const lastRoundBenched = useRef(new Set());
  const teammateHistory = useRef(new Map());

  // session stats
  const [sessionStats, setSessionStats] = useState(() => new Map());
  const [diag, setDiag] = useState({
    roundBuildTimes: [],
    usedCourts: [],
    teamImbalances: [],
    spanPerMatch: [],
    outOfBandCounts: [],
  });

  const [summaryPayload, setSummaryPayload] = useState(null);

  const volumeRef = useRef(LS.getNum('flo.volume', 0.3, 0, 1));
  const { beep } = useBeep(volumeRef);

  const present = useMemo(() => players.filter((p) => p.is_present), [players]);
  const notPresent = useMemo(() => players.filter((p) => !p.is_present), [players]);

  // load players for club
  useEffect(() => {
    if (!club) return;
    (async () => {
      setLoading(true);
      try {
        const list = await APIClient.listPlayers(club);
        setPlayers(list);
      } catch (e) {
        console.error(e);
        alert('Could not load players for this club');
      } finally {
        setLoading(false);
      }
    })();
  }, [club]);

  // timer utils
  function clearTick() {
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
  }

  function startRoundTimer() {
    clearTick();
    setPhase('round');
    setRunning(true);
    tickRef.current = setInterval(() => {
      setTimerLeft((prev) => {
        const next = prev - 1;
        if (next === warnSeconds) {
          beep(1150, 450);
        }
        if (next <= 0) {
          clearTick();
          setRunning(false);
          beep(550, 600);
          (async () => {
            await buildNextRoundInternal();
            setTransitionLeft(transitionSeconds);
            startTransitionTimer();
          })();
          return 0;
        }
        return next;
      });
    }, 1000);
  }

  function startTransitionTimer() {
    clearTick();
    setPhase('transition');
    setRunning(true);
    tickRef.current = setInterval(() => {
      setTransitionLeft((prev) => {
        const next = prev - 1;
        if (next <= 0) {
          clearTick();
          setRunning(false);
          beep(850, 450);
          setTimerLeft(timerTotal);
          startRoundTimer();
          return 0;
        }
        return next;
      });
    }, 1000);
  }

  function pauseTimer() {
    clearTick();
    setRunning(false);
  }

  // build next round
  async function buildNextRoundInternal() {
    const nextRound = roundRef.current + 1;
    roundRef.current = nextRound;
    setRound(nextRound);

    if (present.length < 4) {
      setMatches([]);
      setBenched(present.slice());
      return;
    }

    const t0 = performance.now();
    const { playing, benched: bs } = selectPlayersForRound(
      present,
      nextRound,
      lastRoundBenched.current,
      courtsCount
    );
    lastRoundBenched.current = new Set(bs.map((b) => b.id));
    setBenched(bs);

    const matchesBuilt = buildMatchesFrom16(playing, teammateHistory.current, courtsCount);
    setMatches(matchesBuilt);
    const diagSnap = computeDiagnostics(matchesBuilt);
    const t1 = performance.now();

    setDiag((prev) => ({
      roundBuildTimes: [...prev.roundBuildTimes, Math.round(t1 - t0)],
      usedCourts: [...prev.usedCourts, matchesBuilt.length],
      teamImbalances: [...prev.teamImbalances, Number(diagSnap.avgImbalance.toFixed(3))],
      spanPerMatch: [...prev.spanPerMatch, Number(diagSnap.avgSpan.toFixed(3))],
      outOfBandCounts: [...prev.outOfBandCounts, diagSnap.outOfBand],
    }));

    // per-player stats
    setSessionStats((prev) => {
      const next = new Map(prev);
      playing.forEach((p) => {
        const cur = next.get(p.id) || makeEmptySessionRow(p.id, p.name, p.skill_level, p.gender);
        cur.played += 1;
        cur.currentBenchStreak = 0;
        cur.currentBenchGap = 0;
        next.set(p.id, cur);
      });
      bs.forEach((p) => {
        const cur = next.get(p.id) || makeEmptySessionRow(p.id, p.name, p.skill_level, p.gender);
        cur.benched += 1;
        cur.currentBenchStreak += 1;
        if (cur.currentBenchStreak > cur.worstBenchStreak) {
          cur.worstBenchStreak = cur.currentBenchStreak;
        }
        cur.currentBenchGap += 1;
        cur.benchGaps.push(cur.currentBenchGap);
        next.set(p.id, cur);
      });
      matchesBuilt.forEach((m) => {
        if (!m.team1 || !m.team2) return;
        const [a, b] = m.team1;
        const [c, d] = m.team2;
        addTeammateOpponent(next, a.id, [b], [c, d]);
        addTeammateOpponent(next, b.id, [a], [c, d]);
        addTeammateOpponent(next, c.id, [d], [a, b]);
        addTeammateOpponent(next, d.id, [c], [a, b]);
      });
      return next;
    });

    // persist
    try {
      const updates = [];
      playing.forEach((p) => {
        updates.push({ id: p.id, last_played_round: nextRound });
      });
      bs.forEach((p) => {
        updates.push({ id: p.id, bench_count: (p.bench_count || 0) + 1 });
      });
      if (updates.length) {
        await APIClient.patch(updates, adminKey);
      }
    } catch (e) {
      console.error('persist round stats failed', e);
    }
  }

  // end night
  async function endNight() {
    const snapshotPlayers = players.map((p) => ({ ...p }));
    const sessionRows = Array.from(sessionStats.values()).map((r) => ({
      ...r,
      teammates: Array.from(r.teammates),
      opponents: Array.from(r.opponents),
    }));
    const summary = {
      rounds: roundRef.current,
      sessionRows,
      diag,
      players: snapshotPlayers,
    };
    setSummaryPayload(summary);
    setShowSummary(true);

    const resetUpdates = players.map((p) => ({
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
      if (resetUpdates.length) {
        await APIClient.patch(resetUpdates, adminKey);
      }
    } catch (e) {
      console.error('endNight persist failed', e);
    }

    clearTick();
    setRunning(false);
    setPhase('stopped');
    setTimerLeft(timerTotal);
    setTransitionLeft(transitionSeconds);
    setMatches([]);
    setBenched([]);
    lastRoundBenched.current = new Set();
    teammateHistory.current = new Map();
    setSessionStats(new Map());
    setDiag({
      roundBuildTimes: [],
      usedCourts: [],
      teamImbalances: [],
      spanPerMatch: [],
      outOfBandCounts: [],
    });
    setRound(0);
    roundRef.current = 0;
    setView('home');
  }

  // toggles
  async function togglePresent(p) {
    const nv = !p.is_present;
    setPlayers((prev) => prev.map((x) => (x.id === p.id ? { ...x, is_present: nv } : x)));
    try {
      await APIClient.patch([{ id: p.id, is_present: nv }], adminKey);
    } catch (e) {
      console.error(e);
      alert('Failed to save presence');
    }
  }

  function openAddPlayer() {
    if (!isAdmin) {
      setShowAdminModal(true);
      return;
    }
    setShowAddPlayerModal(true);
  }

  async function handleAddPlayerSubmit(newPlayer) {
    try {
      await APIClient.upsert([newPlayer], adminKey, club);
      const refreshed = await APIClient.listPlayers(club);
      setPlayers(refreshed);
    } catch (e) {
      console.error(e);
      alert('Failed to add player');
    } finally {
      setShowAddPlayerModal(false);
    }
  }

  async function deletePlayer(id) {
    if (!isAdmin) {
      setShowAdminModal(true);
      return;
    }
    if (!window.confirm('Delete player?')) return;
    try {
      await APIClient.remove([id], adminKey);
      const refreshed = await APIClient.listPlayers(club);
      setPlayers(refreshed);
    } catch (e) {
      console.error(e);
      alert('Failed to delete');
    }
  }

  function openAdminLogin() {
    setShowAdminModal(true);
  }

  function handleAdminLogin(pwd) {
    if (!pwd) return;
    setAdminKey(pwd);
    try {
      sessionStorage.setItem('adminKey', pwd);
    } catch {}
    setShowAdminModal(false);
  }

  const isHome = view === 'home';
  const isSession = view === 'session';
  const isDisplay = view === 'display';

  if (!club) {
    return <ClubGate onSelect={setClub} />;
  }

  return (
    <div className="app-shell">
      <header className="top-bar">
        <div className="brand">🏸 The FLOminton System ({club})</div>
        <div className="top-actions">
          {isSession && (
            <>
              <button
                className="btn primary"
                onClick={async () => {
                  if (matches.length === 0) {
                    await buildNextRoundInternal();
                  }
                  if (phase === 'transition') {
                    startTransitionTimer();
                  } else {
                    startRoundTimer();
                  }
                }}
              >
                Build / Resume
              </button>
              <button className="btn" onClick={pauseTimer}>
                Pause
              </button>
              <button
                className="btn"
                onClick={async () => {
                  await buildNextRoundInternal();
                  setPhase('round');
                  setTimerLeft(timerTotal);
                  startRoundTimer();
                }}
              >
                Next Round
              </button>
              <button
                className="btn"
                onClick={() => {
                  const next =
                    matchMode === MATCH_MODES.BAND ? MATCH_MODES.WINDOW : MATCH_MODES.BAND;
                  setMatchModeState(next);
                  setMatchMode(next);
                }}
              >
                Mode: {matchMode === MATCH_MODES.BAND ? 'Band' : 'Window'}
              </button>
            </>
          )}
          <button className="btn" onClick={() => setShowSettings(true)}>
            Settings
          </button>
          <button className="btn" onClick={openAdminLogin}>
            Admin
          </button>
          <button className="btn danger" onClick={endNight}>
            End Night
          </button>
        </div>
      </header>

      {isHome && (
        <main className="home-screen">
          <button className="btn primary big" onClick={() => setView('session')}>
            Begin Night
          </button>
          <button className="btn" onClick={() => setShowSettings(true)}>
            Settings
          </button>
          <button className="btn" onClick={openAdminLogin}>
            Admin Mode
          </button>
          <button className="btn danger" onClick={endNight}>
            End Night
          </button>
        </main>
      )}

      {isSession && (
        <main className="session">
          <div className="controls-row">
            <div
              className={
                phase === 'transition'
                  ? 'round-counter blink-red'
                  : phase === 'round' && timerLeft <= warnSeconds
                  ? 'round-counter warn-orange'
                  : 'round-counter'
              }
            >
              Round {roundRef.current} ·{' '}
              {phase === 'transition' ? formatTime(transitionLeft) : formatTime(timerLeft)}
            </div>
            <button className="btn" onClick={() => setView('display')}>
              Open Display
            </button>
          </div>

          <div className="courts">
            {matches.map((m) => (
              <div key={m.court} className="court-card">
                <div className="court-title">
                  <span>Court {m.court}</span>
                  {isAdmin && (
                    <span className="court-avgs">
                      T1 {m.avg1.toFixed(1)} · T2 {m.avg2.toFixed(1)}
                    </span>
                  )}
                </div>
                <div className="team-row">
                  {m.team1.map((p) => (
                    <PlayerChip key={p.id} player={p} showSkill={isAdmin} showBench={isAdmin} />
                  ))}
                </div>
                <div className="net-divider" />
                <div className="team-row">
                  {m.team2.map((p) => (
                    <PlayerChip key={p.id} player={p} showSkill={isAdmin} showBench={isAdmin} />
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="bench-strip">
            <h3>Benched Players</h3>
            <div className="bench-list">
              {benched.map((p) => (
                <PlayerChip key={p.id} player={p} showSkill={isAdmin} showBench={isAdmin} />
              ))}
            </div>
          </div>

          <div className="lists-row">
            <div className="list-panel">
              <div className="panel-head">
                <span>
                  All Players <span className="pill">{players.length}</span>
                </span>
                {isAdmin && (
                  <button className="btn" onClick={openAddPlayer}>
                    + Add
                  </button>
                )}
              </div>
              <div className="list-body">
                {notPresent.map((p) => (
                  <div
                    key={p.id}
                    className="list-item"
                    onDoubleClick={() => togglePresent(p)}
                  >
                    <span>{p.name}</span>
                    {isAdmin && (
                      <button
                        className="icon-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          deletePlayer(p.id);
                        }}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                ))}
              </div>
            </div>
            <div className="list-panel">
              <div className="panel-head">
                <span>
                  Present Today <span className="pill">{present.length}</span>
                </span>
              </div>
              <div className="list-body">
                {present.map((p) => (
                  <div key={p.id} className="list-item" onDoubleClick={() => togglePresent(p)}>
                    {p.name}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </main>
      )}

      {isDisplay && (
        <div className="display-overlay">
          <div className="display-top">
            <div className="title">🏸 The FLOminton System ({club})</div>
            <div
              className={
                phase === 'transition'
                  ? 'big-timer blink-red'
                  : phase === 'round' && timerLeft <= warnSeconds
                  ? 'big-timer warn-orange'
                  : 'big-timer'
              }
            >
              {phase === 'transition' ? formatTime(transitionLeft) : formatTime(timerLeft)}
            </div>
            <div className="subtitle">
              Round {roundRef.current} · Present {present.length}
            </div>
            <button className="btn" onClick={() => setView('session')}>
              Back
            </button>
          </div>
          <div className="display-courts display-grid-2x2">
            {matches.map((m) => (
              <div key={m.court} className="display-court">
                <div className="display-court-title">Court {m.court}</div>
                <div className="display-team-row">
                  {m.team1.map((p) => (
                    <PlayerChip key={p.id} player={p} showSkill={false} />
                  ))}
                </div>
                <div className="net-divider" />
                <div className="display-team-row">
                  {m.team2.map((p) => (
                    <PlayerChip key={p.id} player={p} showSkill={false} />
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="display-bench">
            {benched.map((p) => (
              <PlayerChip key={p.id} player={p} showSkill={false} />
            ))}
          </div>
        </div>
      )}

      {showSettings && (
        <SettingsModal
          onClose={() => setShowSettings(false)}
          onSave={(vals) => {
            if (typeof vals.roundMinutes === 'number') {
              LS.set('flo.round.minutes', vals.roundMinutes);
              setTimerTotal(vals.roundMinutes * 60);
              setTimerLeft(vals.roundMinutes * 60);
            }
            if (typeof vals.transitionSeconds === 'number') {
              LS.set('flo.transition.seconds', vals.transitionSeconds);
              setTransitionSeconds(vals.transitionSeconds);
              setTransitionLeft(vals.transitionSeconds);
            }
            if (typeof vals.warnSeconds === 'number') {
              LS.set('flo.warn.seconds', vals.warnSeconds);
              setWarnSeconds(vals.warnSeconds);
            }
            if (typeof vals.courts === 'number') {
              LS.set('flo.courts', vals.courts);
              setCourtsCount(vals.courts);
            }
            if (typeof vals.volume === 'number') {
              LS.set('flo.volume', vals.volume);
              volumeRef.current = vals.volume;
            }
            setShowSettings(false);
          }}
          roundMinutes={timerTotal / 60}
          transitionSeconds={transitionSeconds}
          warnSeconds={warnSeconds}
          courts={courtsCount}
          volume={volumeRef.current}
        />
      )}

      {showAdminModal && (
        <AdminModal
          onClose={() => setShowAdminModal(false)}
          onSubmit={handleAdminLogin}
        />
      )}

      {showAddPlayerModal && (
        <AddPlayerModal
          onClose={() => setShowAddPlayerModal(false)}
          onSubmit={handleAddPlayerSubmit}
          defaultGender="M"
          club={club}
        />
      )}

      {showSummary && summaryPayload && (
        <RundownModal
          onClose={() => setShowSummary(false)}
          payload={summaryPayload}
        />
      )}
    </div>
  );
}

// components

function PlayerChip({ player, showSkill, showBench }) {
  return (
    <span className={`player-chip ${player.gender === 'F' ? 'f' : 'm'}`}>
      {player.name}
      {showSkill ? <span className="skill-tag">L{player.skill_level}</span> : null}
      {showBench ? <span className="skill-tag">B{player.bench_count ?? 0}</span> : null}
    </span>
  );
}

function ClubGate({ onSelect }) {
  const [pwd, setPwd] = useState('');
  const [err, setErr] = useState('');
  const tryClub = () => {
    const t = pwd.trim();
    if (t === 'abc2025') {
      onSelect('ABC');
      sessionStorage.setItem('club_code', 'ABC');
    } else if (t === '2025embc') {
      onSelect('EMBC');
      sessionStorage.setItem('club_code', 'EMBC');
    } else {
      setErr('Invalid club password');
    }
  };
  return (
    <div className="club-gate">
      <div className="club-gate-card">
        <h2>Select your club</h2>
        <p>Enter club password to continue</p>
        <input
          value={pwd}
          onChange={(e) => setPwd(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && tryClub()}
          placeholder="club password"
        />
        {err && <div className="error">{err}</div>}
        <button onClick={tryClub}>Continue</button>
      </div>
    </div>
  );
}

function SettingsModal({
  onClose,
  onSave,
  roundMinutes,
  transitionSeconds,
  warnSeconds,
  courts,
  volume,
}) {
  const [rm, setRm] = useState(roundMinutes);
  const [ts, setTs] = useState(transitionSeconds);
  const [ws, setWs] = useState(warnSeconds);
  const [ct, setCt] = useState(courts);
  const [vol, setVol] = useState(volume);

  return (
    <div className="modal-backdrop opaque">
      <div className="modal modern">
        <div className="modal-head">
          <h3>Settings</h3>
          <button className="btn" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body settings-grid">
          <label>
            Round length (minutes)
            <input
              type="number"
              min="1"
              value={rm}
              onChange={(e) => setRm(Number(e.target.value))}
            />
          </label>
          <label>
            Transition (seconds)
            <input
              type="number"
              min="5"
              value={ts}
              onChange={(e) => setTs(Number(e.target.value))}
            />
          </label>
          <label>
            Warn at (seconds)
            <input
              type="number"
              min="5"
              value={ws}
              onChange={(e) => setWs(Number(e.target.value))}
            />
          </label>
          <label>
            Courts available
            <input
              type="number"
              min="1"
              value={ct}
              onChange={(e) => setCt(Number(e.target.value))}
            />
          </label>
          <label>
            Sound volume (0–1)
            <input
              type="number"
              step="0.05"
              min="0"
              max="1"
              value={vol}
              onChange={(e) => setVol(Number(e.target.value))}
            />
          </label>
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Close
          </button>
          <button
            className="btn primary"
            onClick={() =>
              onSave({
                roundMinutes: rm,
                transitionSeconds: ts,
                warnSeconds: ws,
                courts: ct,
                volume: vol,
              })
            }
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function AdminModal({ onClose, onSubmit }) {
  const [pwd, setPwd] = useState('');
  return (
    <div className="modal-backdrop opaque">
      <div className="modal small">
        <h3>Admin mode</h3>
        <p>Enter admin password.</p>
        <input
          value={pwd}
          onChange={(e) => setPwd(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && onSubmit(pwd)}
          placeholder="admin password"
        />
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Close
          </button>
          <button className="btn primary" onClick={() => onSubmit(pwd)}>
            Enter
          </button>
        </div>
      </div>
    </div>
  );
}

function AddPlayerModal({ onClose, onSubmit, defaultGender = 'M', club }) {
  const [name, setName] = useState('');
  const [gender, setGender] = useState(defaultGender);
  const [level, setLevel] = useState(5);

  return (
    <div className="modal-backdrop opaque">
      <div className="modal small">
        <h3>Add Player ({club})</h3>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          Gender
          <select value={gender} onChange={(e) => setGender(e.target.value)}>
            <option value="M">Male</option>
            <option value="F">Female</option>
          </select>
        </label>
        <label>
          Skill level (1–10)
          <input
            type="number"
            min="1"
            max="10"
            value={level}
            onChange={(e) => setLevel(Number(e.target.value))}
          />
        </label>
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Close
          </button>
          <button
            className="btn primary"
            onClick={() =>
              onSubmit({
                name: name.trim(),
                gender,
                skill_level: level,
                is_present: false,
                bench_count: 0,
                last_played_round: 0,
                club_code: club,
              })
            }
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

function RundownModal({ onClose, payload }) {
  const [tab, setTab] = useState('summary');

  const rounds = payload?.rounds || 0;
  const sessionRows = Array.isArray(payload?.sessionRows) ? payload.sessionRows : [];
  const diag = payload?.diag || {
    roundBuildTimes: [],
    usedCourts: [],
    teamImbalances: [],
    spanPerMatch: [],
    outOfBandCounts: [],
  };
  const players = Array.isArray(payload?.players) ? payload.players : [];

  const perPlayer = players.map((p) => {
    const s = sessionRows.find((r) => r.id === p.id);
    return {
      id: p.id,
      name: p.name,
      gender: p.gender,
      skill_level: p.skill_level,
      played: s ? s.played : 0,
      benched: s ? s.benched : 0,
      worstBenchStreak: s ? s.worstBenchStreak : 0,
      teammates: s ? s.teammates : [],
      opponents: s ? s.opponents : [],
    };
  });

  const totalPlayers = perPlayer.length;
  const mostPlayed = [...perPlayer].sort((a, b) => b.played - a.played)[0] || null;
  const leastPlayed = [...perPlayer].sort((a, b) => a.played - b.played)[0] || null;
  const mostBenched = [...perPlayer].sort((a, b) => b.benched - a.benched)[0] || null;
  const worstStreak = [...perPlayer].sort((a, b) => b.worstBenchStreak - a.worstBenchStreak)[0] || null;

  const avgBuild = diag.roundBuildTimes.length ? Math.round(avg(diag.roundBuildTimes)) : 0;
  const avgCourts = diag.usedCourts.length ? avg(diag.usedCourts).toFixed(2) : '—';
  const avgImbalance = diag.teamImbalances.length ? avg(diag.teamImbalances).toFixed(2) : '—';
  const avgSpan = diag.spanPerMatch.length ? avg(diag.spanPerMatch).toFixed(2) : '—';
  const totalOutOfBand = diag.outOfBandCounts.reduce((s, x) => s + x, 0);

  return (
    <div className="modal-backdrop opaque">
      <div className="modal wide">
        <div className="modal-head">
          <h3>Session Overview</h3>
          <button className="btn" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="tabs">
          <button
            className={tab === 'summary' ? 'tab active' : 'tab'}
            onClick={() => setTab('summary')}
          >
            Smart Session Summary
          </button>
          <button
            className={tab === 'diag' ? 'tab active' : 'tab'}
            onClick={() => setTab('diag')}
          >
            System Diagnostics
          </button>
        </div>

        {tab === 'summary' && (
          <>
            <div className="summary-grid">
              <div className="summary-card">
                <div className="label">Rounds played</div>
                <div className="value big">{rounds}</div>
              </div>
              <div className="summary-card">
                <div className="label">Players present</div>
                <div className="value big">{totalPlayers}</div>
              </div>
              <div className="summary-card">
                <div className="label">Avg courts used</div>
                <div className="value">{avgCourts}</div>
              </div>
              <div className="summary-card">
                <div className="label">Most played</div>
                <div className="value">
                  {mostPlayed ? `${mostPlayed.name} (${mostPlayed.played})` : '—'}
                </div>
              </div>
              <div className="summary-card">
                <div className="label">Least played</div>
                <div className="value">
                  {leastPlayed ? `${leastPlayed.name} (${leastPlayed.played})` : '—'}
                </div>
              </div>
              <div className="summary-card">
                <div className="label">Most benched</div>
                <div className="value">
                  {mostBenched ? `${mostBenched.name} (${mostBenched.benched})` : '—'}
                </div>
              </div>
              <div className="summary-card">
                <div className="label">Worst bench streak</div>
                <div className="value">
                  {worstStreak ? `${worstStreak.name} (${worstStreak.worstBenchStreak})` : '—'}
                </div>
              </div>
            </div>

            <h4 style={{ marginTop: '14px' }}>Per-player breakdown</h4>
            <div className="table-wrap" style={{ maxHeight: '220px' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Lvl</th>
                    <th>Played</th>
                    <th>Benched</th>
                    <th>Worst bench streak</th>
                    <th>Unique teammates</th>
                    <th>Unique opponents</th>
                  </tr>
                </thead>
                <tbody>
                  {perPlayer.map((p) => (
                    <tr key={p.id}>
                      <td>{p.name}</td>
                      <td>{p.skill_level}</td>
                      <td>{p.played}</td>
                      <td>{p.benched}</td>
                      <td>{p.worstBenchStreak}</td>
                      <td>{p.teammates ? p.teammates.length : 0}</td>
                      <td>{p.opponents ? p.opponents.length : 0}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {tab === 'diag' && (
          <>
            <div className="summary-grid">
              <div className="summary-card">
                <div className="label">Avg build time</div>
                <div className="value">{avgBuild ? `${avgBuild} ms` : '—'}</div>
              </div>
              <div className="summary-card">
                <div className="label">Avg team imbalance</div>
                <div className="value">{avgImbalance}</div>
              </div>
              <div className="summary-card">
                <div className="label">Avg skill span / match</div>
                <div className="value">{avgSpan}</div>
              </div>
              <div className="summary-card">
                <div className="label">Out-of-band groups</div>
                <div className="value">{totalOutOfBand}</div>
              </div>
            </div>

            <div className="diag-rows">
              <div>
                <h5>Courts used per round</h5>
                <p className="muted">{diag.usedCourts.join(', ') || '—'}</p>
              </div>
              <div>
                <h5>Build times (ms)</h5>
                <p className="muted">{diag.roundBuildTimes.join(', ') || '—'}</p>
              </div>
              <div>
                <h5>Imbalance (|avg1-avg2|)</h5>
                <p className="muted">{diag.teamImbalances.join(', ') || '—'}</p>
              </div>
              <div>
                <h5>Skill span per match</h5>
                <p className="muted">{diag.spanPerMatch.join(', ') || '—'}</p>
              </div>
            </div>
          </>
        )}

        <div className="modal-actions" style={{ marginTop: '18px' }}>
          <button className="btn primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

function makeEmptySessionRow(id, name, skill, gender) {
  return {
    id,
    name,
    gender,
    skill_level: skill,
    played: 0,
    benched: 0,
    worstBenchStreak: 0,
    currentBenchStreak: 0,
    currentBenchGap: 0,
    benchGaps: [],
    teammates: new Set(),
    opponents: new Set(),
  };
}

function addTeammateOpponent(map, id, teammates = [], opponents = []) {
  const cur = map.get(id);
  if (!cur) return;
  teammates.forEach((t) => cur.teammates.add(t.id || t));
  opponents.forEach((o) => cur.opponents.add(o.id || o));
}

function avg(arr) {
  if (!arr || !arr.length) return 0;
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

function computeDiagnostics(matches) {
  if (!matches || !matches.length) {
    return {
      avgImbalance: 0,
      avgSpan: 0,
      outOfBand: 0,
    };
  }
  let imbalances = [];
  let spans = [];
  let outOfBand = 0;
  matches.forEach((m) => {
    const span =
      Math.max(
        m.team1[0].skill_level,
        m.team1[1].skill_level,
        m.team2[0].skill_level,
        m.team2[1].skill_level
      ) -
      Math.min(
        m.team1[0].skill_level,
        m.team1[1].skill_level,
        m.team2[0].skill_level,
        m.team2[1].skill_level
      );
    spans.push(span);
    const imb = Math.abs(m.avg1 - m.avg2);
    imbalances.push(imb);
    if (span > 5) outOfBand += 1;
  });
  return {
    avgImbalance: avg(imbalances),
    avgSpan: avg(spans),
    outOfBand,
  };
}
