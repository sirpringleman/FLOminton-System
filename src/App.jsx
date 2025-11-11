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
  /* ---------- club gate ---------- */
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

  // snapshot to show at end night
  const [summaryPayload, setSummaryPayload] = useState(null);

  // sounds
  const volumeRef = useRef(LS.getNum('flo.volume', 0.3, 0, 1));
  const { beep } = useBeep(volumeRef);

  // swap state
  const [swapSource, setSwapSource] = useState(null);

  /* ---------- derived ---------- */
  const present = useMemo(() => players.filter((p) => p.is_present), [players]);
  const notPresent = useMemo(() => players.filter((p) => !p.is_present), [players]);

  /* ---------- load players on club change ---------- */
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

  /* ---------- timer visuals ---------- */
  const isWarn = phase === 'round' && running && timerLeft <= warnSeconds;
  const isBlink = phase === 'transition' && running;

  /* =========================================================
     TIMER / PHASE
     ========================================================= */
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
          beep(1150, 5000);
        }
        if (next <= 0) {
          clearTick();
          setRunning(false);
          // end-of-round
          beep(550, 5000);
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
          beep(850, 5000);
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

    /* =========================================================
     ROUND BUILD
     ========================================================= */
     async function buildNextRoundInternal(manual = false) {
      if (!present.length) {
        setMatches([]);
        setBenched([]);
        return;
      }
  
      const t0 = performance.now();
  
      const { playing, benched: newBenched } = selectPlayersForRound(
        present,
        roundRef.current + 1,
        lastRoundBenched.current,
        courtsCount
      );
  
      const newMatches = buildMatchesFrom16(playing, teammateHistory.current, courtsCount);
  
      // update local players (bench / last_played_round)
      const playingIds = new Set(playing.map((p) => p.id));
      const benchedIds = new Set(newBenched.map((p) => p.id));
  
      const updatedPlayers = players.map((p) => {
        if (!p.is_present) return p;
        if (playingIds.has(p.id)) {
          return { ...p, last_played_round: roundRef.current + 1 };
        }
        if (benchedIds.has(p.id)) {
          return { ...p, bench_count: (p.bench_count || 0) + 1 };
        }
        return p;
      });
  
      setPlayers(updatedPlayers);
      setMatches(newMatches);
      setBenched(newBenched);
  
      // fairness memory
      lastRoundBenched.current = new Set(newBenched.map((b) => b.id));
  
      // diagnostics
      const t1 = performance.now();
      setDiag((prev) => ({
        roundBuildTimes: [...prev.roundBuildTimes, t1 - t0],
        usedCourts: [...prev.usedCourts, newMatches.length],
        teamImbalances: [
          ...prev.teamImbalances,
          ...newMatches.map((m) => Math.abs((m.avg1 || 0) - (m.avg2 || 0))),
        ],
        spanPerMatch: [
          ...prev.spanPerMatch,
          ...newMatches.map((m) => {
            const all = [...m.team1, ...m.team2];
            const max = Math.max(...all.map((x) => x.skill_level));
            const min = Math.min(...all.map((x) => x.skill_level));
            return max - min;
          }),
        ],
        outOfBandCounts: [...prev.outOfBandCounts, 0],
      }));
  
      // session stats
      setSessionStats((prev) => {
        const next = new Map(prev);
        // only present players
        for (const p of updatedPlayers.filter((x) => x.is_present)) {
          const base = next.get(p.id) || {
            id: p.id,
            name: p.name,
            lvl: p.skill_level,
            played: 0,
            benched: 0,
            worstBenchStreak: 0,
            currentBenchStreak: 0,
            teammates: new Set(),
            opponents: new Set(),
          };
          // was he playing this round?
          if (playingIds.has(p.id)) {
            base.played += 1;
            base.currentBenchStreak = 0;
          } else {
            base.benched += 1;
            base.currentBenchStreak = (base.currentBenchStreak || 0) + 1;
            if (base.currentBenchStreak > (base.worstBenchStreak || 0)) {
              base.worstBenchStreak = base.currentBenchStreak;
            }
          }
          next.set(p.id, base);
        }
        // teammates/opponents
        for (const m of newMatches) {
          const t1ids = m.team1.map((x) => x.id);
          const t2ids = m.team2.map((x) => x.id);
          // team1
          for (const a of t1ids) {
            const rec = next.get(a);
            if (!rec) continue;
            for (const b of t1ids) {
              if (a === b) continue;
              rec.teammates.add(b);
            }
            for (const b of t2ids) {
              rec.opponents.add(b);
            }
          }
          // team2
          for (const a of t2ids) {
            const rec = next.get(a);
            if (!rec) continue;
            for (const b of t2ids) {
              if (a === b) continue;
              rec.teammates.add(b);
            }
            for (const b of t1ids) {
              rec.opponents.add(b);
            }
          }
        }
        return next;
      });
  
      // bump round counter
      roundRef.current = roundRef.current + 1;
      setRound(roundRef.current);
  
      // sync to DB (best-effort)
      if (adminKey) {
        try {
          const updates = [];
          for (const p of updatedPlayers.filter((x) => x.is_present)) {
            updates.push({
              id: p.id,
              fields: {
                bench_count: p.bench_count,
                last_played_round: p.last_played_round,
                is_present: p.is_present,
              },
            });
          }
          if (updates.length) await APIClient.patch(updates, adminKey);
        } catch (err) {
          console.warn('Failed to save round updates:', err);
        }
      }
  
      return { matches: newMatches, benched: newBenched };
    }
  
    /* =========================================================
       EVENT HANDLERS
       ========================================================= */
    const handleTogglePresent = async (player) => {
      // local update
      const next = players.map((p) =>
        p.id === player.id ? { ...p, is_present: !p.is_present } : p
      );
      setPlayers(next);
  
      if (adminKey) {
        try {
          await APIClient.patch(
            [{ id: player.id, fields: { is_present: !player.is_present } }],
            adminKey
          );
        } catch (e) {
          console.warn('could not persist present flag', e);
        }
      }
    };
  
    const handleBeginNight = () => {
      setView('session');
    };
  
    const handleBuildOrResume = async () => {
      // if we already have matches & phase is paused → resume
      if (matches.length && !running && phase === 'round') {
        startRoundTimer();
        return;
      }
      // otherwise build from current present
      await buildNextRoundInternal(true);
      setTimerLeft(timerTotal);
      startRoundTimer();
    };
  
    const handleNextRound = async () => {
      // build new round immediately (no transition)
      await buildNextRoundInternal(true);
      // reset round timer straight away
      setTimerLeft(timerTotal);
      setPhase('round');
      setRunning(true);
      clearTick();
      tickRef.current = setInterval(() => {
        setTimerLeft((prev) => {
          const next = prev - 1;
          if (next === warnSeconds) {
            beep(1150, 5000);
          }
          if (next <= 0) {
            clearTick();
            setRunning(false);
            beep(550, 5000);
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
    };
  
    const handleEndNight = () => {
      clearTick();
      setRunning(false);
      setPhase('stopped');
  
      // capture snapshot for modal
      const presentIds = new Set(players.filter((p) => p.is_present).map((p) => p.id));
      const rows = [...sessionStats.values()]
        .filter((r) => presentIds.has(r.id))
        .map((r) => ({
          ...r,
          uniqueTeammates: r.teammates ? r.teammates.size : 0,
          uniqueOpponents: r.opponents ? r.opponents.size : 0,
        }));
  
      setSummaryPayload({
        rounds: roundRef.current,
        players: players.filter((p) => p.is_present),
        rows,
        diag,
      });
      setShowSummary(true);
  
      // reset players is_present + bench_count
      const resetPlayers = players.map((p) => ({
        ...p,
        is_present: false,
        bench_count: 0,
        last_played_round: 0,
      }));
      setPlayers(resetPlayers);
  
      // clear session states
      setMatches([]);
      setBenched([]);
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
      lastRoundBenched.current = new Set();
      teammateHistory.current = new Map();
    };
  
    const openDisplay = () => setView('display');
  
    /* =========================================================
       SWAP HANDLING
       ========================================================= */
    const handleCourtPlayerClick = (player) => {
      // toggle selection
      if (swapSource && swapSource.id === player.id) {
        setSwapSource(null);
      } else {
        setSwapSource(player);
      }
    };
  
    const handleBenchClickForSwap = (benchPlayer) => {
      if (!swapSource) return;
      // we have a source on court and we clicked a bench → swap
      // find which match & team contains swapSource
      const mIdx = matches.findIndex(
        (m) => m.team1.some((p) => p.id === swapSource.id) || m.team2.some((p) => p.id === swapSource.id)
      );
      if (mIdx === -1) {
        setSwapSource(null);
        return;
      }
      const match = matches[mIdx];
      const isTeam1 = match.team1.some((p) => p.id === swapSource.id);
  
      const newMatches = matches.map((m, idx) => {
        if (idx !== mIdx) return m;
        if (isTeam1) {
          const newTeam1 = m.team1.map((p) => (p.id === swapSource.id ? benchPlayer : p));
          return { ...m, team1: newTeam1 };
        } else {
          const newTeam2 = m.team2.map((p) => (p.id === swapSource.id ? benchPlayer : p));
          return { ...m, team2: newTeam2 };
        }
      });
  
      // adjust benched list: remove chosen bench player, add swapped-out
      const newBenched = benched
        .filter((b) => b.id !== benchPlayer.id)
        .concat([{ ...swapSource }]);
  
      // update players list bench_count
      const updatedPlayers = players.map((p) => {
        if (p.id === benchPlayer.id) {
          // was benched, now playing → decrease bench_count by 1 (not below 0)
          return { ...p, bench_count: Math.max(0, (p.bench_count || 0) - 1) };
        }
        if (p.id === swapSource.id) {
          // was playing, now benched
          return { ...p, bench_count: (p.bench_count || 0) + 1 };
        }
        return p;
      });
  
      setPlayers(updatedPlayers);
      setMatches(newMatches);
      setBenched(newBenched);
      setSwapSource(null);
    };
  
    /* =========================================================
       RENDER HELPERS
       ========================================================= */
    const presentCount = present.length;
  
    const courtsDisplay = matches.slice(0, courtsCount).map((m) => (
      <div key={m.court} className="court-card">
        <div className="court-head">
          <div className="court-title">Court {m.court}</div>
          {isAdmin && (
            <div className="court-averages">
              Team 1 Avg <b>{(m.avg1 || 0).toFixed(1)}</b> &nbsp; Team 2 Avg{' '}
              <b>{(m.avg2 || 0).toFixed(1)}</b>
            </div>
          )}
        </div>
        <div className="court-body">
          <div className="court-team-row">
            {m.team1.map((p) => (
              <PlayerChip
                key={p.id}
                player={p}
                onClick={() => handleCourtPlayerClick(p)}
                active={swapSource && swapSource.id === p.id}
                dim={!!swapSource && swapSource.id !== p.id}
                showLevel={isAdmin}
              />
            ))}
          </div>
          <div className="court-net" />
          <div className="court-team-row">
            {m.team2.map((p) => (
              <PlayerChip
                key={p.id}
                player={p}
                onClick={() => handleCourtPlayerClick(p)}
                active={swapSource && swapSource.id === p.id}
                dim={!!swapSource && swapSource.id !== p.id}
                showLevel={isAdmin}
              />
            ))}
          </div>
        </div>
      </div>
    ));
  
    /* =========================================================
       MAIN RENDER
       ========================================================= */
    if (!club) {
      return (
        <div className="app-shell">
          <div className="club-gate">
            <h1>The FLOminton System</h1>
            <p>Select your club</p>
            <ClubGate onClub={(c) => setClub(c)} />
          </div>
        </div>
      );
    }
  
    return (
      <div className="app-shell">
        {/* top bar */}
        <header className="top-bar">
          <div className="brand">The FLOminton System ({club})</div>
          <div className="actions-row">
            {view === 'home' ? (
              <button className="btn primary" onClick={handleBeginNight}>
                Begin Night
              </button>
            ) : (
              <>
                <button className="btn" onClick={() => setView('home')}>
                  Home
                </button>
                <button className="btn primary" onClick={handleBuildOrResume}>
                  Build/Resume
                </button>
                <button className="btn" onClick={pauseTimer}>
                  Pause
                </button>
                <button className="btn" onClick={handleNextRound}>
                  Next Round
                </button>
                <button className="btn danger" onClick={handleEndNight}>
                  End Night
                </button>
                <button className="btn" onClick={openDisplay}>
                  Open Display
                </button>
              </>
            )}
            <button className="btn" onClick={() => setShowSettings(true)}>
              Settings
            </button>
            <button className="btn" onClick={() => setShowAdminModal(true)}>
              Admin
            </button>
            {view !== 'home' && (
              <div
                className={`round-indicator ${
                  phase === 'round' && running && timerLeft <= warnSeconds ? 'warn' : ''
                } ${phase === 'transition' && running ? 'blink' : ''}`}
              >
                Round {round || 1} · {phase === 'round' ? formatTime(timerLeft) : formatTime(transitionLeft)}
              </div>
            )}
          </div>
        </header>
  
        {/* main body */}
        {view === 'home' && (
          <div className="home-screen">
            <button className="home-btn primary" onClick={handleBeginNight}>
              Begin Night
            </button>
            <button className="home-btn" onClick={() => setShowSettings(true)}>
              Settings
            </button>
            <button className="home-btn" onClick={() => setShowAdminModal(true)}>
              Admin
            </button>
            <button className="home-btn danger" onClick={handleEndNight}>
              End Night
            </button>
          </div>
        )}
  
        {view === 'session' && (
          <div className="session-body">
            <div className="courts-grid">{courtsDisplay}</div>
  
            <div className="benched-strip">
              <div className="section-title">Benched Players</div>
              <div className="benched-row">
                {benched.map((b) => (
                  <PlayerChip
                    key={b.id}
                    player={b}
                    onClick={() => handleBenchClickForSwap(b)}
                    showLevel={isAdmin}
                    dim={false}
                  />
                ))}
              </div>
            </div>
  
            <div className="lists-row">
              <div className="list-col">
                <div className="list-head">
                  <span>All Players</span>
                  <span className="count-badge">{notPresent.length}</span>
                </div>
                <div className="list-body scroll">
                  {notPresent.map((p) => (
                    <div key={p.id} className="list-line">
                      <PlayerChip
                        player={p}
                        onDoubleClick={() => handleTogglePresent(p)}
                        showLevel={isAdmin}
                      />
                      {isAdmin && (
                        <button
                          className="tiny-del"
                          onClick={async () => {
                            if (!window.confirm('Delete this player?')) return;
                            try {
                              await APIClient.remove([p.id], adminKey);
                              setPlayers((prev) => prev.filter((x) => x.id !== p.id));
                            } catch (e) {
                              alert('Delete failed');
                            }
                          }}
                        >
                          ×
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </div>
  
              <div className="list-col">
                <div className="list-head">
                  <span>Present Today</span>
                  <span className="count-badge">{present.length}</span>
                </div>
                <div className="list-body scroll">
                  {present.map((p) => (
                    <div key={p.id} className="list-line">
                      <PlayerChip
                        player={p}
                        onDoubleClick={() => handleTogglePresent(p)}
                        showLevel={isAdmin}
                      />
                      {isAdmin && (
                        <span className="bench-counter">Benched {p.bench_count || 0}</span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            </div>
  
            {isAdmin && (
              <div className="admin-foot">
                <button className="btn" onClick={() => setShowAddPlayerModal(true)}>
                  Add player
                </button>
                <div className="mode-toggle">
                  <span>Mode:</span>
                  <button
                    className={matchMode === MATCH_MODES.BAND ? 'btn mini primary' : 'btn mini'}
                    onClick={() => {
                      setMatchMode(MATCH_MODES.BAND);
                      setMatchModeState(MATCH_MODES.BAND);
                    }}
                  >
                    Band
                  </button>
                  <button
                    className={matchMode === MATCH_MODES.WINDOW ? 'btn mini primary' : 'btn mini'}
                    onClick={() => {
                      setMatchMode(MATCH_MODES.WINDOW);
                      setMatchModeState(MATCH_MODES.WINDOW);
                    }}
                  >
                    Window
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
  
        {view === 'display' && (
          <div className="display-shell">
            <div className="display-top">
              <h2>The FLOminton System ({club})</h2>
              <div
                className={`display-timer ${
                  phase === 'round' && running && timerLeft <= warnSeconds ? 'warn' : ''
                } ${phase === 'transition' && running ? 'blink' : ''}`}
              >
                {phase === 'round' ? formatTime(timerLeft) : formatTime(transitionLeft)}
              </div>
              <div className="display-round">Round {round || 1}</div>
              <button className="btn" onClick={() => setView('session')}>
                Back
              </button>
            </div>
            <div className="display-courts">{courtsDisplay}</div>
            <div className="display-benched">
              <div className="section-title">Benched</div>
              <div className="benched-row">
                {benched.map((b) => (
                  <PlayerChip key={b.id} player={b} />
                ))}
              </div>
            </div>
          </div>
        )}
  
        {showSettings && (
          <SettingsModal
            onClose={() => setShowSettings(false)}
            timerTotal={timerTotal}
            setTimerTotal={(v) => {
              setTimerTotal(v);
              LS.set('flo.round.minutes', v / 60);
            }}
            warnSeconds={warnSeconds}
            setWarnSeconds={(v) => {
              setWarnSeconds(v);
              LS.set('flo.warn.seconds', v);
            }}
            transitionSeconds={transitionSeconds}
            setTransitionSeconds={(v) => {
              setTransitionSeconds(v);
              LS.set('flo.transition.seconds', v);
            }}
            courtsCount={courtsCount}
            setCourtsCount={(v) => {
              setCourtsCount(v);
              LS.set('flo.courts', v);
            }}
            volume={volumeRef.current}
            setVolume={(v) => {
              volumeRef.current = v;
              LS.set('flo.volume', v);
            }}
          />
        )}
  
        {showAdminModal && (
          <AdminModal
            onClose={() => setShowAdminModal(false)}
            onSubmit={(key) => {
              setAdminKey(key);
              sessionStorage.setItem('adminKey', key);
              setShowAdminModal(false);
            }}
          />
        )}
  
        {showAddPlayerModal && (
          <AddPlayerModal
            onClose={() => setShowAddPlayerModal(false)}
            onSubmit={async (newPlayer) => {
              try {
                await APIClient.upsert([newPlayer], adminKey, club);
                const refreshed = await APIClient.listPlayers(club);
                setPlayers(refreshed);
              } catch (e) {
                alert('Add failed');
              } finally {
                setShowAddPlayerModal(false);
              }
            }}
          />
        )}
  
        {showSummary && summaryPayload && (
          <RundownModal payload={summaryPayload} onClose={() => setShowSummary(false)} />
        )}
      </div>
    );
  }
  
  /* =========================================================
     SMALL COMPONENTS
     ========================================================= */
  
  function PlayerChip({ player, onClick, onDoubleClick, active, dim, showLevel }) {
    const gender = player.gender === 'F' ? 'F' : 'M';
    return (
      <div
        className={`player-chip ${gender === 'F' ? 'pink' : 'blue'} ${
          active ? 'chip-active' : ''
        } ${dim ? 'chip-dim' : ''}`}
        onClick={onClick}
        onDoubleClick={onDoubleClick}
      >
        <span className="chip-gender">{gender}</span>
        <span className="chip-name">{player.name}</span>
        {showLevel && <span className="chip-level">L{player.skill_level}</span>}
      </div>
    );
  }
  
  function ClubGate({ onClub }) {
    const [code, setCode] = useState('');
    const [pass, setPass] = useState('');
    const [error, setError] = useState('');
  
    const clubs = [
      { code: 'ABC', pass: 'abc2025', label: 'Axis Badminton Club' },
      { code: 'EMBC', pass: '2025embc', label: 'East Meath Badminton Club' },
    ];
  
    const handle = () => {
      const found = clubs.find((c) => c.code === code);
      if (!found) {
        setError('Pick a club');
        return;
      }
      if (pass !== found.pass) {
        setError('Wrong password for this club');
        return;
      }
      try {
        sessionStorage.setItem('club_code', found.code);
      } catch {}
      onClub(found.code);
    };
  
    return (
      <div className="club-modal">
        <label>Club</label>
        <select value={code} onChange={(e) => setCode(e.target.value)}>
          <option value="">Select…</option>
          {clubs.map((c) => (
            <option key={c.code} value={c.code}>
              {c.label} ({c.code})
            </option>
          ))}
        </select>
        <label>Password</label>
        <input value={pass} onChange={(e) => setPass(e.target.value)} type="password" />
        {error && <div className="error-text">{error}</div>}
        <button className="btn primary full" onClick={handle}>
          Enter
        </button>
      </div>
    );
  }
  
  function SettingsModal({
    onClose,
    timerTotal,
    setTimerTotal,
    warnSeconds,
    setWarnSeconds,
    transitionSeconds,
    setTransitionSeconds,
    courtsCount,
    setCourtsCount,
    volume,
    setVolume,
  }) {
    const [roundMins, setRoundMins] = useState(timerTotal / 60);
    const [warn, setWarn] = useState(warnSeconds);
    const [trans, setTrans] = useState(transitionSeconds);
    const [courts, setCourts] = useState(courtsCount);
    const [vol, setVol] = useState(volume);
  
    const save = () => {
      setTimerTotal(roundMins * 60);
      setWarnSeconds(warn);
      setTransitionSeconds(trans);
      setCourtsCount(courts);
      setVolume(vol);
      onClose();
    };
  
    return (
      <div className="modal-overlay">
        <div className="modal settings">
          <h2>Settings</h2>
          <label>Round length (minutes)</label>
          <input
            type="number"
            min="3"
            max="60"
            value={roundMins}
            onChange={(e) => setRoundMins(Number(e.target.value))}
          />
  
          <label>Warn at (seconds remaining)</label>
          <input
            type="number"
            min="5"
            max="120"
            value={warn}
            onChange={(e) => setWarn(Number(e.target.value))}
          />
  
          <label>Transition time (seconds)</label>
          <input
            type="number"
            min="5"
            max="120"
            value={trans}
            onChange={(e) => setTrans(Number(e.target.value))}
          />
  
          <label>Courts available</label>
          <input
            type="number"
            min="1"
            max="12"
            value={courts}
            onChange={(e) => setCourts(Number(e.target.value))}
          />
  
          <label>Sound volume</label>
          <input
            type="range"
            min="0"
            max="1"
            step="0.05"
            value={vol}
            onChange={(e) => setVol(Number(e.target.value))}
          />
  
          <div className="modal-actions">
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
            <button className="btn primary" onClick={save}>
              Save
            </button>
          </div>
        </div>
      </div>
    );
  }
  
  function AdminModal({ onClose, onSubmit }) {
    const [pass, setPass] = useState('');
  
    const submit = () => {
      if (pass === 'flomintonsys') {
        onSubmit(pass);
      } else {
        alert('Wrong admin password');
      }
    };
  
    return (
      <div className="modal-overlay">
        <div className="modal admin">
          <h2>Admin password</h2>
          <input
            type="password"
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
          <div className="modal-actions">
            <button className="btn" onClick={onClose}>
              Close
            </button>
            <button className="btn primary" onClick={submit}>
              Enter
            </button>
          </div>
        </div>
      </div>
    );
  }
  
  function AddPlayerModal({ onClose, onSubmit }) {
    const [name, setName] = useState('');
    const [gender, setGender] = useState('M');
    const [level, setLevel] = useState(5);
  
    const save = () => {
      if (!name.trim()) return;
      onSubmit({
        name: name.trim(),
        gender,
        skill_level: Number(level) || 1,
        is_present: false,
        bench_count: 0,
        last_played_round: 0,
      });
    };
  
    return (
      <div className="modal-overlay">
        <div className="modal add-player">
          <h2>Add Player</h2>
          <label>Name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} />
          <label>Gender</label>
          <select value={gender} onChange={(e) => setGender(e.target.value)}>
            <option value="M">Male</option>
            <option value="F">Female</option>
          </select>
          <label>Skill level (1-10)</label>
          <input
            type="number"
            min="1"
            max="10"
            value={level}
            onChange={(e) => setLevel(e.target.value)}
          />
          <div className="modal-actions">
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
            <button className="btn primary" onClick={save}>
              Save
            </button>
          </div>
        </div>
      </div>
    );
  }
  
  function RundownModal({ payload, onClose }) {
    const { rounds, players, rows, diag } = payload;
  
    const presentCount = players.length;
    const mostPlayed = [...rows].sort((a, b) => b.played - a.played)[0] || null;
    const leastPlayed = [...rows].sort((a, b) => a.played - b.played)[0] || null;
    const mostBenched = [...rows].sort((a, b) => b.benched - a.benched)[0] || null;
    const worstStreak = [...rows].sort((a, b) => b.worstBenchStreak - a.worstBenchStreak)[0] || null;
  
    return (
      <div className="modal-overlay">
        <div className="modal rundown">
          <div className="rundown-head">
            <h2>Session Overview</h2>
            <button className="btn" onClick={onClose}>
              ×
            </button>
          </div>
          <div className="tabs-row">
            <button className="tab active">Smart Session Summary</button>
            <button className="tab">System Diagnostics</button>
          </div>
  
          <div className="summary-cards">
            <div className="summary-card">
              <div className="sum-label">Rounds played</div>
              <div className="sum-value">{rounds}</div>
            </div>
            <div className="summary-card">
              <div className="sum-label">Players present</div>
              <div className="sum-value">{presentCount}</div>
            </div>
            <div className="summary-card">
              <div className="sum-label">Most played</div>
              <div className="sum-value">
                {mostPlayed ? `${mostPlayed.name} (${mostPlayed.played})` : '—'}
              </div>
            </div>
            <div className="summary-card">
              <div className="sum-label">Least played</div>
              <div className="sum-value">
                {leastPlayed ? `${leastPlayed.name} (${leastPlayed.played})` : '—'}
              </div>
            </div>
            <div className="summary-card">
              <div className="sum-label">Most benched</div>
              <div className="sum-value">
                {mostBenched ? `${mostBenched.name} (${mostBenched.benched})` : '—'}
              </div>
            </div>
            <div className="summary-card">
              <div className="sum-label">Worst bench streak</div>
              <div className="sum-value">
                {worstStreak ? `${worstStreak.name} (${worstStreak.worstBenchStreak})` : '—'}
              </div>
            </div>
          </div>
  
          <div className="table-wrap">
            <table>
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
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>{r.name}</td>
                    <td>{r.lvl}</td>
                    <td>{r.played}</td>
                    <td>{r.benched}</td>
                    <td>{r.worstBenchStreak || 0}</td>
                    <td>{r.teammates ? r.teammates.size : 0}</td>
                    <td>{r.opponents ? r.opponents.size : 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
  
          <div className="modal-actions right">
            <button className="btn" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    );
  }
  