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
        ...(adminKey ? { 'X-Admin-Key': adminKey } : {}),
      },
      body: JSON.stringify({ updates }),
    });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { message: text };
    }
    if (!res.ok) throw new Error(data?.message || 'PATCH failed');
    return data;
  },
  async upsert(players, adminKey, club) {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey || '' },
      body: JSON.stringify({ players, club_code: club }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.message || 'UPSERT failed');
    return data;
  },
  async remove(ids, adminKey) {
    const res = await fetch(API, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey || '' },
      body: JSON.stringify({ ids }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.message || 'DELETE failed');
    return data;
  },
};

/* ================= Local Storage helpers ================= */
const LS = {
  getNum(k, def, min, max) {
    try {
      const n = Number(localStorage.getItem(k));
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

/* ================= WebAudio beeper ================= */
function useBeep(volumeRef) {
  const ctxRef = useRef(null);
  const ensure = () => {
    if (!ctxRef.current) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      ctxRef.current = new Ctor();
    }
    return ctxRef.current;
  };
  const beep = (freq = 900, ms = 250) => {
    const v = clamp(volumeRef.current ?? 0.3, 0, 1);
    const ctx = ensure();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    osc.connect(gain);
    gain.connect(ctx.destination);
    gain.gain.setValueAtTime(v, ctx.currentTime);
    osc.start();
    osc.stop(ctx.currentTime + ms / 1000);
  };
  return { beep };
}

/* =========================================================
   APP
   ========================================================= */
export default function App() {
  /* ---------- multi-club gate ---------- */
  const [club, setClub] = useState(() => {
    try {
      return sessionStorage.getItem('club_code') || '';
    } catch {
      return '';
    }
  });

  /* ---------- main state ---------- */
  const [players, setPlayers] = useState([]);
  const [loading, setLoading] = useState(true);

  const [round, setRound] = useState(0);
  const roundRef = useRef(0);

  const [matches, setMatches] = useState([]);
  const [benched, setBenched] = useState([]);

  // view: 'home' | 'session' | 'display'
  const [view, setView] = useState(() => getInitialView());

  // phase: 'stopped' | 'round' | 'transition'
  const [phase, setPhase] = useState('stopped');
  const [running, setRunning] = useState(false);

  const [timerTotal, setTimerTotal] = useState(LS.getNum('flo.round.minutes', 12, 3, 60) * 60);
  const [warnSeconds, setWarnSeconds] = useState(LS.getNum('flo.warn.seconds', 30, 5, 120));
  const [transitionSeconds, setTransitionSeconds] = useState(
    LS.getNum('flo.transition.seconds', 30, 5, 120)
  );
  const [courtsCount, setCourtsCount] = useState(LS.getNum('flo.courts', 4, 1, 12));

  const [timerLeft, setTimerLeft] = useState(LS.getNum('flo.round.minutes', 12, 3, 60) * 60);
  const [transitionLeft, setTransitionLeft] = useState(transitionSeconds);

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
    outOfBandCounts: [],
  });

  // live session metrics
  const [sessionStats, setSessionStats] = useState(() => new Map());

  // snapshots for the summary modal (so we don't show 0 after reset)
  const [sessionSnapshot, setSessionSnapshot] = useState(null);
  const [diagSnapshot, setDiagSnapshot] = useState(null);
  const [playersSnapshot, setPlayersSnapshot] = useState(null);

  const teammateHistory = useRef(new Map());
  const lastRoundBenched = useRef(new Set());

  const [roundSnapshot, setRoundSnapshot] = useState(0);

  const volumeRef = useRef(LS.getNum('flo.volume', 0.3, 0, 1));
  const { beep } = useBeep(volumeRef);

  /* ---------- load players when club chosen ---------- */
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
  }, [club, view]);

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
  const isBlink = phase === 'transition' && running && transitionLeft <= 0;

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
        if (next === warnSeconds) beep(1200, 3000);
        if (next <= 0) {
          clearTick();
          setRunning(false);
          beep(500, 5000);
          (async () => {
            await nextRoundInternal();
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
          beep(850, 5000);
          setTimerLeft(timerTotal);
          startRoundTimer();
          return 0;
        }
        return next;
      });
    }, 1000);
  }

  function stopTimer() {
    clearTick();
    setRunning(false);
  }

  /* =========================================================
     ROUND BUILD + PERSISTENCE
     ========================================================= */
  async function buildNextRound(nextRound) {
    if (present.length < 4) {
      alert('Not enough players present.');
      return;
    }
    const t0 = performance.now();

    const { playing, benched } = selectPlayersForRound(
      present,
      nextRound,
      lastRoundBenched.current,
      courtsCount
    );
    lastRoundBenched.current = new Set(benched.map((b) => b.id));
    setBenched(benched);

    const ms = buildMatchesFrom16(playing, teammateHistory.current, courtsCount, matchMode);
    setMatches(ms);

    const diagSnap = computeDiagnostics(ms);
    const t1 = performance.now();
    const buildMs = Math.max(0, t1 - t0);
    setDiag((prev) => ({
      roundBuildTimes: [...prev.roundBuildTimes, Math.round(buildMs)],
      usedCourts: [...prev.usedCourts, ms.length],
      teamImbalances: [...prev.teamImbalances, Number(diagSnap.avgImbalance.toFixed(3))],
      spanPerMatch: [...prev.spanPerMatch, Number(diagSnap.avgSpan.toFixed(3))],
      outOfBandCounts: [...prev.outOfBandCounts, diagSnap.outOfBand],
    }));

    // session per-player stats
    setSessionStats((prev) => {
      const next = new Map(prev);
      playing.forEach((p) => {
        const cur = next.get(p.id) || {
          id: p.id,
          name: p.name,
          level: p.skill_level,
          gender: p.gender,
          played: 0,
          benched: 0,
          benchGap: [],
          currentGap: 0,
          worstBenchStreak: 0,
          currentBenchStreak: 0,
          teammates: new Set(),
          opponents: new Set(),
        };
        cur.played += 1;
        cur.currentGap = 0;
        cur.currentBenchStreak = 0;
        next.set(p.id, cur);
      });
      benched.forEach((p) => {
        const cur = next.get(p.id) || {
          id: p.id,
          name: p.name,
          level: p.skill_level,
          gender: p.gender,
          played: 0,
          benched: 0,
          benchGap: [],
          currentGap: 0,
          worstBenchStreak: 0,
          currentBenchStreak: 0,
          teammates: new Set(),
          opponents: new Set(),
        };
        cur.benched += 1;
        cur.currentGap += 1;
        cur.currentBenchStreak += 1;
        if (cur.currentBenchStreak > cur.worstBenchStreak) cur.worstBenchStreak = cur.currentBenchStreak;
        cur.benchGap.push(cur.currentGap);
        next.set(p.id, cur);
      });
      ms.forEach((match) => {
        const t1 = match.team1;
        const t2 = match.team2;
        if (t1.length === 2 && t2.length === 2) {
          const [a, b] = t1;
          const [c, d] = t2;
          const up = (p, tm, op) => {
            const cur = next.get(p.id);
            tm.forEach((x) => cur.teammates.add(x.id));
            op.forEach((x) => cur.opponents.add(x.id));
          };
          up(a, [b], [c, d]);
          up(b, [a], [c, d]);
          up(c, [d], [a, b]);
          up(d, [c], [a, b]);
        }
      });
      return next;
    });

    // persist to server
    try {
      const updates = [];
      for (const pl of playing) {
        updates.push({ id: pl.id, last_played_round: nextRound });
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
  }

  async function nextRoundInternal() {
    const next = roundRef.current + 1;
    roundRef.current = next;
    setRound(next);
    setRoundSnapshot(next);
    await buildNextRound(next);
  }

    /* =========================================================
     ADMIN / CRUD
     ========================================================= */
     async function addPlayer() {
      if (!club) {
        alert('Choose club first.');
        return;
      }
      const name = prompt('Player name?');
      if (!name) return;
      const gender = prompt("Gender? (M/F)", 'M') || 'M';
      const lvl = Number(prompt('Skill level 1-10', '5') || 5);
      const newPlayer = {
        name: name.trim(),
        gender,
        skill_level: lvl,
        is_present: false,
        bench_count: 0,
        last_played_round: 0,
        club_code: club,
      };
      try {
        await APIClient.upsert([newPlayer], adminKey, club);
        const refreshed = await APIClient.listPlayers(club);
        setPlayers(refreshed);
      } catch (e) {
        console.error(e);
        alert('Failed to add player');
      }
    }
  
    async function deletePlayer(id) {
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
  
    function doAdminLogin() {
      const pwd = prompt('Admin password?');
      if (!pwd) return;
      setAdminKey(pwd);
      try {
        sessionStorage.setItem('adminKey', pwd);
      } catch {}
    }
  
    /* =========================================================
       END NIGHT
       ========================================================= */
    async function endNight() {
      // snapshot current for summary
      const snapshot = Array.from(sessionStats.values()).map((v) => ({
        ...v,
        teammates: Array.from(v.teammates || []),
        opponents: Array.from(v.opponents || []),
      }));
      setSessionSnapshot({
        rounds: roundRef.current,
        players: snapshot,
      });
      setDiagSnapshot(diag);
      setPlayersSnapshot(players);
  
      // reset players on server + local
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
  
      // reset session state
      stopTimer();
      setPhase('stopped');
      setTimerLeft(timerTotal);
      setTransitionLeft(transitionSeconds);
      setMatches([]);
      setBenched([]);
      lastRoundBenched.current = new Set();
      teammateHistory.current = new Map();
      benchDebtRef.current = {};
      setSessionStats(new Map());
      setRound(0);
      roundRef.current = 0;
  
      // show summary
      setShowRundown(true);
      setView('home');
    }
  
    /* =========================================================
       SETTINGS
       ========================================================= */
    function openSettings() {
      setShowSettings(true);
    }
  
    function closeSettings() {
      setShowSettings(false);
    }
  
    function saveSettings(next) {
      if (typeof next.roundMinutes === 'number') {
        LS.set('flo.round.minutes', next.roundMinutes);
        setTimerTotal(next.roundMinutes * 60);
        setTimerLeft(next.roundMinutes * 60);
      }
      if (typeof next.transitionSeconds === 'number') {
        LS.set('flo.transition.seconds', next.transitionSeconds);
        setTransitionSeconds(next.transitionSeconds);
        setTransitionLeft(next.transitionSeconds);
      }
      if (typeof next.warnSeconds === 'number') {
        LS.set('flo.warn.seconds', next.warnSeconds);
        setWarnSeconds(next.warnSeconds);
      }
      if (typeof next.courts === 'number') {
        LS.set('flo.courts', next.courts);
        setCourtsCount(next.courts);
      }
      if (typeof next.volume === 'number') {
        LS.set('flo.volume', next.volume);
        volumeRef.current = next.volume;
      }
      setShowSettings(false);
    }
  
    /* =========================================================
       RENDER HELPERS
       ========================================================= */
    const isDisplay = view === 'display';
    const isHome = view === 'home';
    const isSession = view === 'session';
  
    /* =========================================================
       EARLY RETURN: CLUB GATE
       ========================================================= */
    if (!club) {
      return <ClubGate onSelect={setClub} />;
    }
  
    /* =========================================================
       PAGE
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
                <button className="primary" onClick={() => setView('session')}>
                  Session
                </button>
                <button onClick={openSettings}>Settings</button>
                <button onClick={doAdminLogin}>Admin</button>
                <button className="danger" onClick={endNight}>
                  End Night
                </button>
              </>
            )}
          </div>
        </header>
  
        {isHome && (
          <main className="home-screen">
            <button className="primary big" onClick={() => setView('session')}>
              Begin Night
            </button>
            <button onClick={openSettings}>Settings</button>
            <button onClick={doAdminLogin}>Admin mode</button>
            <button className="danger" onClick={endNight}>
              End Night
            </button>
          </main>
        )}
  
        {isSession && (
          <main className="session">
            {/* top controls */}
            <div className="controls-row">
              <button
                className="primary"
                onClick={async () => {
                  if (matches.length === 0) {
                    // build first round, but don't auto-start timer
                    await nextRoundInternal();
                    setPhase('stopped');
                    setTimerLeft(timerTotal);
                  } else {
                    // resume timer
                    if (phase === 'transition') {
                      startTransitionTimer();
                    } else {
                      startRoundTimer();
                    }
                  }
                }}
              >
                Build/Resume
              </button>
              <button onClick={stopTimer}>Pause</button>
              <button
                onClick={async () => {
                  await nextRoundInternal();
                  setPhase('round');
                  setTimerLeft(timerTotal);
                  setRunning(true);
                }}
              >
                Next Round
              </button>
              <button className="danger" onClick={endNight}>
                End Night
              </button>
              <button onClick={() => setView(isDisplay ? 'session' : 'display')}>
                {isDisplay ? 'Back to Session' : 'Open Display'}
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
                  phase === 'transition'
                    ? 'blink-red'
                    : phase === 'round' && timerLeft <= warnSeconds
                    ? 'warn-orange'
                    : ''
                }`}
              >
                Round {roundRef.current} ·{' '}
                {phase === 'transition' ? formatTime(transitionLeft) : formatTime(timerLeft)}
              </div>
            </div>
  
            {/* courts display */}
            <div className="courts">
              {matches.map((m) => (
                <div key={m.court} className="court-card">
                  <div className="court-title">
                    Court {m.court}
                    {isAdmin && (
                      <span className="court-avgs">
                        Team 1 Avg: <b>{m.avg1.toFixed(1)}</b> · Team 2 Avg:{' '}
                        <b>{m.avg2.toFixed(1)}</b>
                      </span>
                    )}
                  </div>
                  <div className="team-row">
                    {m.team1.map((p) => (
                      <PlayerChip key={p.id} player={p} showSkill={isAdmin} />
                    ))}
                  </div>
                  <div className="net-divider" />
                  <div className="team-row">
                    {m.team2.map((p) => (
                      <PlayerChip key={p.id} player={p} showSkill={isAdmin} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
  
            {/* benched */}
            <div className="bench-strip">
              <h3>Benched Players</h3>
              <div className="bench-list">
                {benched.map((p) => (
                  <PlayerChip key={p.id} player={p} showSkill={isAdmin} />
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
                          onClick={(e) => {
                            e.stopPropagation();
                            deletePlayer(p.id);
                          }}
                          className="icon-btn"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                {isAdmin && (
                  <button className="full" onClick={addPlayer}>
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
                className={`big-timer ${
                  phase === 'transition'
                    ? 'blink-red'
                    : phase === 'round' && timerLeft <= warnSeconds
                    ? 'warn-orange'
                    : ''
                }`}
              >
                {phase === 'transition' ? formatTime(transitionLeft) : formatTime(timerLeft)}
              </div>
              <div className="subtitle">
                Round {roundRef.current} · Present {present.length}
              </div>
              <button onClick={() => setView('session')}>Back</button>
            </div>
            <div className="display-courts">
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
            onClose={closeSettings}
            onSave={saveSettings}
            roundMinutes={timerTotal / 60}
            transitionSeconds={transitionSeconds}
            warnSeconds={warnSeconds}
            courts={courtsCount}
            volume={volumeRef.current}
          />
        )}
  
        {showRundown && sessionSnapshot && (
          <RundownModal
            onClose={() => setShowRundown(false)}
            session={sessionSnapshot}
            diag={diagSnapshot}
            playersAtEnd={playersSnapshot}
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
        {showSkill ? <span className="skill-tag">L{player.skill_level}</span> : null}
      </span>
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
      <div className="modal-backdrop">
        <div className="modal">
          <h3>Settings</h3>
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
            Warning at (seconds)
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
          <div className="modal-actions">
            <button onClick={onClose}>Close</button>
            <button
              className="primary"
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
  
  function RundownModal({ onClose, session, diag, playersAtEnd }) {
    const rounds = session?.rounds || 0;
    const perPlayer = session?.players || [];
  
    return (
      <div className="modal-backdrop">
        <div className="modal wide">
          <h3>Smart Session Summary</h3>
          <p>
            Total rounds: <b>{rounds}</b>
          </p>
          <table className="summary-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Lvl</th>
                <th>Played</th>
                <th>Benched</th>
                <th>Unique teammates</th>
                <th>Unique opponents</th>
              </tr>
            </thead>
            <tbody>
              {playersAtEnd &&
                playersAtEnd.map((p) => {
                  const s = perPlayer.find((x) => x.id === p.id);
                  return (
                    <tr key={p.id}>
                      <td>{p.name}</td>
                      <td>{p.skill_level}</td>
                      <td>{s ? s.played : p.last_played_round || 0}</td>
                      <td>{s ? s.benched : p.bench_count || 0}</td>
                      <td>{s ? (s.teammates ? s.teammates.length : 0) : 0}</td>
                      <td>{s ? (s.opponents ? s.opponents.length : 0) : 0}</td>
                    </tr>
                  );
                })}
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
  
    const attempt = () => {
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
          <h2>Select your club</h2>
          <p>Enter your club password to continue.</p>
          <input
            value={pwd}
            onChange={(e) => setPwd(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && attempt()}
            placeholder="club password"
          />
          {err && <div className="error">{err}</div>}
          <button onClick={attempt}>Continue</button>
        </div>
      </div>
    );
  }
  
  /* =========================================================
     UTILS
     ========================================================= */
  function getInitialView() {
    return 'home';
  }
  