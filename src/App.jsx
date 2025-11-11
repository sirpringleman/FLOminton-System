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
     BUILD ROUND
     ========================================================= */
  async function buildNextRoundInternal() {
    setSwapSource(null);

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

    setSessionStats((prev) => {
      const next = new Map(prev);
      playing.forEach((p) => {
        const cur =
          next.get(p.id) ||
          makeEmptySessionRow(p.id, p.name, p.skill_level, p.gender);
        cur.played += 1;
        cur.currentBenchStreak = 0;
        cur.currentBenchGap = 0;
        next.set(p.id, cur);
      });
      bs.forEach((p) => {
        const cur =
          next.get(p.id) ||
          makeEmptySessionRow(p.id, p.name, p.skill_level, p.gender);
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

  /* =========================================================
     END NIGHT → snapshot + reset
     ========================================================= */
  async function endNight() {
    // only present players should appear in the summary
    const snapshotPlayers = players.filter((p) => p.is_present).map((p) => ({ ...p }));
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
    setSwapSource(null);
  }

    /* =========================================================
     RENDER ROOT
     ========================================================= */
     if (!club) {
      return (
        <ClubGate
          onChoose={async (code) => {
            try {
              const list = await APIClient.listPlayers(code);
              sessionStorage.setItem('club_code', code);
              setClub(code);
              setPlayers(list);
            } catch (e) {
              alert('Wrong club password or no players for this club');
            }
          }}
        />
      );
    }
  
    return (
      <div className="app-shell">
        <TopBar
          view={view}
          onView={setView}
          onBegin={() => setView('session')}
          onResume={() => {
            if (!matches.length) {
              buildNextRoundInternal().then(() => {
                setTimerLeft(timerTotal);
                startRoundTimer();
              });
            } else {
              startRoundTimer();
            }
          }}
          onPause={pauseTimer}
          onNext={() => {
            pauseTimer();
            setTimerLeft(timerTotal);
            buildNextRoundInternal().then(() => {
              startRoundTimer();
            });
          }}
          onEnd={endNight}
          onSettings={() => setShowSettings(true)}
          onAdmin={() => setShowAdminModal(true)}
          matchMode={matchMode}
          onToggleMode={() => {
            const next = matchMode === MATCH_MODES.BAND ? MATCH_MODES.WINDOW : MATCH_MODES.BAND;
            setMatchMode(next);
            setMatchModeState(next);
          }}
          round={round}
          phase={phase}
          timerLeft={timerLeft}
          transitionLeft={transitionLeft}
          warn={isWarn}
          blink={isBlink}
          presentCount={present.length}
        />
  
        {view === 'home' && (
          <HomeScreen
            onBegin={() => setView('session')}
            onSettings={() => setShowSettings(true)}
            onAdmin={() => setShowAdminModal(true)}
          />
        )}
  
        {view === 'session' && (
          <SessionScreen
            isAdmin={isAdmin}
            players={players}
            present={present}
            notPresent={notPresent}
            matches={matches}
            benched={benched}
            courtsCount={courtsCount}
            swapSource={swapSource}
            onSwapSource={setSwapSource}
            onSwapTarget={(p) => handleBenchSwapTarget(p)}
            onTogglePresent={async (p) => {
              const updated = players.map((x) =>
                x.id === p.id ? { ...x, is_present: !x.is_present } : x
              );
              setPlayers(updated);
              try {
                await APIClient.patch(
                  [{ id: p.id, fields: { is_present: !p.is_present } }],
                  adminKey
                );
              } catch (e) {
                console.warn(e);
              }
            }}
            onDelete={async (p) => {
              if (!window.confirm('Delete this player?')) return;
              try {
                await APIClient.remove([p.id], adminKey);
                const list = await APIClient.listPlayers(club);
                setPlayers(list);
              } catch (e) {
                alert('Delete failed');
              }
            }}
            onEdit={async (p, patch) => {
              try {
                await APIClient.patch([{ id: p.id, fields: patch }], adminKey);
                const list = await APIClient.listPlayers(club);
                setPlayers(list);
              } catch (e) {
                alert('Edit failed');
              }
            }}
            onCourtChipClick={(player) => {
              // allow swap even when not admin, as per your earlier instruction
              if (!swapSource) {
                setSwapSource(player);
              } else if (swapSource.id === player.id) {
                setSwapSource(null);
              }
            }}
          />
        )}
  
        {view === 'display' && (
          <DisplayScreen
            matches={matches}
            benched={benched}
            round={round}
            timerLeft={timerLeft}
            phase={phase}
            present={present}
          />
        )}
  
        {showSettings && (
          <SettingsModal
            timerTotal={timerTotal}
            warnSeconds={warnSeconds}
            transitionSeconds={transitionSeconds}
            courtsCount={courtsCount}
            onClose={() => setShowSettings(false)}
            onSave={({ roundMins, warnSecs, transitionSecs, courts }) => {
              const totalSecs = roundMins * 60;
              setTimerTotal(totalSecs);
              setTimerLeft(totalSecs);
              setWarnSeconds(warnSecs);
              setTransitionSeconds(transitionSecs);
              setTransitionLeft(transitionSecs);
              setCourtsCount(courts);
              LS.set('flo.round.minutes', roundMins);
              LS.set('flo.warn.seconds', warnSecs);
              LS.set('flo.transition.seconds', transitionSecs);
              LS.set('flo.courts', courts);
              setShowSettings(false);
            }}
          />
        )}
  
        {showSummary && summaryPayload && (
          <RundownModal
            payload={summaryPayload}
            onClose={() => setShowSummary(false)}
          />
        )}
  
        {showAdminModal && (
          <AdminModal
            onClose={() => setShowAdminModal(false)}
            onSubmit={(pwd) => {
              if (pwd === 'flomintonsys') {
                sessionStorage.setItem('adminKey', pwd);
                setAdminKey(pwd);
                setShowAdminModal(false);
              } else {
                alert('Wrong admin password');
              }
            }}
          />
        )}
  
        {showAddPlayerModal && (
          <AddPlayerModal
            onClose={() => setShowAddPlayerModal(false)}
            onSave={async (player) => {
              try {
                await APIClient.upsert([player], adminKey, club);
                const list = await APIClient.listPlayers(club);
                setPlayers(list);
                setShowAddPlayerModal(false);
              } catch (e) {
                alert('Failed to add player');
              }
            }}
          />
        )}
      </div>
    );
  }
  
  /* =========================================================
     SUBCOMPONENTS
     ========================================================= */
  
  function TopBar({
    view,
    onView,
    onBegin,
    onResume,
    onPause,
    onNext,
    onEnd,
    onSettings,
    onAdmin,
    matchMode,
    onToggleMode,
    round,
    phase,
    timerLeft,
    transitionLeft,
    warn,
    blink,
    presentCount,
  }) {
    return (
      <header className="top-bar">
        <div className="top-left">
          <h1 className="app-title">The FLOminton System 🏸</h1>
          <div className="round-pill">Round {round}</div>
          <div
            className={`timer-pill ${warn ? 'timer-warn' : ''} ${
              blink ? 'timer-blink' : ''
            }`}
          >
            {phase === 'transition'
              ? `Transition ${formatTime(transitionLeft)}`
              : formatTime(timerLeft)}
          </div>
          <div className="present-pill">{presentCount} present</div>
        </div>
        <div className="top-right">
          <button
            className={view === 'home' ? 'btn-top active' : 'btn-top'}
            onClick={() => onView('home')}
          >
            Home
          </button>
          <button className="btn-top primary" onClick={onBegin}>
            Begin Night
          </button>
          <button className="btn-top" onClick={onResume}>
            Build/Resume
          </button>
          <button className="btn-top" onClick={onPause}>
            Pause
          </button>
          <button className="btn-top" onClick={onNext}>
            Next Round
          </button>
          <button className="btn-top danger" onClick={onEnd}>
            End Night
          </button>
          <button className="btn-top" onClick={onSettings}>
            Settings
          </button>
          <button className="btn-top" onClick={onAdmin}>
            Admin
          </button>
          <button className="btn-top mode-toggle" onClick={onToggleMode}>
            {matchMode === MATCH_MODES.BAND ? 'Band Mode' : 'Window Mode'}
          </button>
        </div>
      </header>
    );
  }
  
  function HomeScreen({ onBegin, onSettings, onAdmin }) {
    return (
      <div className="home-screen">
        <div className="home-actions">
          <button className="home-btn primary" onClick={onBegin}>
            Begin Night
          </button>
          <button className="home-btn" onClick={onSettings}>
            Settings
          </button>
          <button className="home-btn" onClick={onAdmin}>
            Admin
          </button>
        </div>
      </div>
    );
  }
  
  function SessionScreen({
    isAdmin,
    players,
    present,
    notPresent,
    matches,
    benched,
    courtsCount,
    swapSource,
    onSwapSource,
    onSwapTarget,
    onTogglePresent,
    onDelete,
    onEdit,
    onCourtChipClick,
  }) {
    return (
      <div className="session-shell">
        <div className="courts-area">
          <h2 className="section-title">Courts</h2>
          <div className="courts-grid">
            {matches.length === 0 ? (
              <div className="empty-state">No matches yet. Click Build/Resume.</div>
            ) : (
              matches.map((m) => (
                <div key={m.court} className="court-card">
                  <div className="court-header">Court {m.court}</div>
                  <div className="court-body">
                    <div className="team-row">
                      {m.team1.map((p) => (
                        <PlayerChip
                          key={p.id}
                          player={p}
                          onClick={() => onCourtChipClick(p)}
                          active={swapSource && swapSource.id === p.id}
                          dimmed={!!swapSource && swapSource.id !== p.id}
                          showBench={isAdmin}
                          benchCount={p.bench_count || 0}
                        />
                      ))}
                    </div>
                    <div className="net-divider" />
                    <div className="team-row">
                      {m.team2.map((p) => (
                        <PlayerChip
                          key={p.id}
                          player={p}
                          onClick={() => onCourtChipClick(p)}
                          active={swapSource && swapSource.id === p.id}
                          dimmed={!!swapSource && swapSource.id !== p.id}
                          showBench={isAdmin}
                          benchCount={p.bench_count || 0}
                        />
                      ))}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
          <div className="benched-bar">
            <h3>Benched this round</h3>
            <div className="benched-row">
              {benched.length === 0 ? (
                <span className="muted">No one benched</span>
              ) : (
                benched.map((p) => (
                  <PlayerChip
                      key={p.id}
                      player={p}
                      onClick={() => {
                        if (swapSource) {
                          onSwapTarget(p);
                        }
                      }}
                      active={swapSource && swapSource.id === p.id}
                      dimmed={false}
                      showBench={isAdmin}
                      benchCount={p.bench_count || 0}
                  />
                ))
              )}
            </div>
          </div>
        </div>
  
        <div className="players-area">
          <div className="present-list">
            <h2 className="section-title">Present Today</h2>
            <div className="player-list-scroll">
              {present.map((p) => (
                <PlayerChip
                  key={p.id}
                  player={p}
                  onClick={() => onTogglePresent(p)}
                  showBench={isAdmin}
                  benchCount={p.bench_count || 0}
                />
              ))}
            </div>
          </div>
          <div className="allplayers-list">
            <h2 className="section-title">All Players</h2>
            <div className="player-list-scroll">
              {notPresent.map((p) => (
                <PlayerChip
                  key={p.id}
                  player={p}
                  onClick={() => onTogglePresent(p)}
                  showBench={isAdmin}
                  benchCount={p.bench_count || 0}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }
  
  function DisplayScreen({ matches, benched, round, timerLeft, phase, present }) {
    return (
      <div className="display-shell">
        <div className="display-header">
          <div className="display-title">The FLOminton System 🏸</div>
          <div className="display-round">Round {round}</div>
          <div
            className={`display-timer ${phase === 'transition' ? 'timer-blink' : ''}`}
          >
            {formatTime(timerLeft)}
          </div>
          <div className="display-present">Present: {present.length}</div>
        </div>
        <div className="display-courts">
          {matches.map((m) => (
            <div key={m.court} className="display-court">
              <div className="display-court-title">Court {m.court}</div>
              <div className="display-team-row">
                {m.team1.map((p) => (
                  <div key={p.id} className="display-chip">
                    {p.name}
                  </div>
                ))}
              </div>
              <div className="display-net" />
              <div className="display-team-row">
                {m.team2.map((p) => (
                  <div key={p.id} className="display-chip">
                    {p.name}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="display-benched">
          <h3>Benched</h3>
          <div className="display-benched-row">
            {benched.map((p) => (
              <div key={p.id} className="display-chip small">
                {p.name}
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  function SettingsModal({
    timerTotal,
    warnSeconds,
    transitionSeconds,
    courtsCount,
    onClose,
    onSave,
  }) {
    const [roundMins, setRoundMins] = useState(Math.floor(timerTotal / 60));
    const [warnSecs, setWarnSecs] = useState(warnSeconds);
    const [transitionSecs, setTransitionSecs] = useState(transitionSeconds);
    const [courts, setCourts] = useState(courtsCount);
  
    return (
      <div className="modal-backdrop">
        <div className="modal-panel">
          <h2>Settings</h2>
          <label className="field">
            <span>Round length (minutes)</span>
            <input
              type="number"
              min="3"
              max="60"
              value={roundMins}
              onChange={(e) => setRoundMins(Number(e.target.value))}
            />
          </label>
          <label className="field">
            <span>Warn at (seconds left)</span>
            <input
              type="number"
              min="5"
              max="120"
              value={warnSecs}
              onChange={(e) => setWarnSecs(Number(e.target.value))}
            />
          </label>
          <label className="field">
            <span>Transition length (seconds)</span>
            <input
              type="number"
              min="5"
              max="120"
              value={transitionSecs}
              onChange={(e) => setTransitionSecs(Number(e.target.value))}
            />
          </label>
          <label className="field">
            <span>Courts available</span>
            <input
              type="number"
              min="1"
              max="12"
              value={courts}
              onChange={(e) => setCourts(Number(e.target.value))}
            />
          </label>
          <div className="modal-actions">
            <button onClick={onClose}>Close</button>
            <button
              className="primary"
              onClick={() =>
                onSave({
                  roundMins,
                  warnSecs,
                  transitionSecs,
                  courts,
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
      <div className="modal-backdrop">
        <div className="modal-panel">
          <h2>Admin Password</h2>
          <input
            type="password"
            value={pwd}
            onChange={(e) => setPwd(e.target.value)}
            placeholder="Enter admin password"
          />
          <div className="modal-actions">
            <button onClick={onClose}>Cancel</button>
            <button
              className="primary"
              onClick={() => {
                onSubmit(pwd);
              }}
            >
              Enter
            </button>
          </div>
        </div>
      </div>
    );
  }
  
  function AddPlayerModal({ onClose, onSave }) {
    const [name, setName] = useState('');
    const [gender, setGender] = useState('M');
    const [skill, setSkill] = useState(5);
  
    return (
      <div className="modal-backdrop">
        <div className="modal-panel">
          <h2>Add Player</h2>
          <label className="field">
            <span>Name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field">
            <span>Gender</span>
            <select value={gender} onChange={(e) => setGender(e.target.value)}>
              <option value="M">Male</option>
              <option value="F">Female</option>
            </select>
          </label>
          <label className="field">
            <span>Skill level (1–10)</span>
            <input
              type="number"
              min="1"
              max="10"
              value={skill}
              onChange={(e) => setSkill(Number(e.target.value))}
            />
          </label>
          <div className="modal-actions">
            <button onClick={onClose}>Cancel</button>
            <button
              className="primary"
              onClick={() => {
                if (!name.trim()) return;
                onSave({
                  name: name.trim(),
                  gender,
                  skill_level: skill,
                });
              }}
            >
              Save
            </button>
          </div>
        </div>
      </div>
    );
  }
  
  function RundownModal({ payload, onClose }) {
    if (!payload) return null;
    const { rounds, sessionRows, diag, players } = payload;
    return (
      <div className="modal-backdrop">
        <div className="modal-panel large">
          <h2>Session Summary</h2>
          <p>{rounds} rounds played.</p>
          <h3>Players (present this night)</h3>
          <div className="summary-table">
            <div className="summary-row header">
              <div>Name</div>
              <div>Skill</div>
              <div>Played</div>
              <div>Benched</div>
              <div>Worst Bench Streak</div>
            </div>
            {players.map((p) => {
              const row = sessionRows.find((r) => r.id === p.id);
              return (
                <div key={p.id} className="summary-row">
                  <div>{p.name}</div>
                  <div>{p.skill_level}</div>
                  <div>{row ? row.played : 0}</div>
                  <div>{row ? row.benched : 0}</div>
                  <div>{row ? row.worstBenchStreak || 0 : 0}</div>
                </div>
              );
            })}
          </div>
          <h3>System Diagnostics</h3>
          <p>Round build times (ms): {diag.roundBuildTimes.join(', ')}</p>
          <p>Courts used: {diag.usedCourts.join(', ')}</p>
          <p>Team imbalance: {diag.teamImbalances.join(', ')}</p>
          <p>Span per match: {diag.spanPerMatch.join(', ')}</p>
          <div className="modal-actions">
            <button onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    );
  }
  
  /* =========================================================
     CLUB GATE
     ========================================================= */
  function ClubGate({ onChoose }) {
    const [code, setCode] = useState('');
    return (
      <div className="gate-shell">
        <div className="gate-card">
          <h2>Select club</h2>
          <p>Enter club password:</p>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="abc2025 or 2025embc"
          />
          <button className="primary" onClick={() => onChoose(code)}>
            Continue
          </button>
        </div>
      </div>
    );
  }
  
  /* =========================================================
     UTILITIES
     ========================================================= */
  function makeEmptySessionRow(id, name, skill, gender) {
    return {
      id,
      name,
      skill,
      gender,
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
  
  function addTeammateOpponent(map, id, mates, opps) {
    const row = map.get(id);
    if (!row) return;
    mates.forEach((m) => row.teammates.add(m.id));
    opps.forEach((o) => row.opponents.add(o.id));
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
    matches.forEach((m) => {
      const im = Math.abs((m.avg1 || 0) - (m.avg2 || 0));
      imbalances.push(im);
      const all = [...m.team1, ...m.team2].map((p) => p.skill_level);
      spans.push(Math.max(...all) - Math.min(...all));
    });
    return {
      avgImbalance:
        imbalances.reduce((a, b) => a + b, 0) / (imbalances.length || 1),
      avgSpan: spans.reduce((a, b) => a + b, 0) / (spans.length || 1),
      outOfBand: 0,
    };
  }
  
  /* =========================================================
     PLAYER CHIP (with bench pill when admin)
     ========================================================= */
  function PlayerChip({ player, onClick, active, dimmed, showBench, benchCount }) {
    if (!player) return null;
    const isFemale = (player.gender || '').toUpperCase() === 'F';
    return (
      <div
        className={`player-chip ${isFemale ? 'chip-f' : 'chip-m'} ${active ? 'chip-active' : ''} ${
          dimmed ? 'chip-dim' : ''
        }`}
        onClick={onClick}
      >
        <span className="chip-name">{player.name}</span>
        <span className="chip-level">L{player.skill_level}</span>
        {showBench ? <span className="chip-bench">B{benchCount || 0}</span> : null}
      </div>
    );
  }
  