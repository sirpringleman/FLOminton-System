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

    /* ---------- timer loop ---------- */
    useEffect(() => {
      if (tickRef.current) {
        clearInterval(tickRef.current);
        tickRef.current = null;
      }
      if (!(phase === 'round' || phase === 'transition') || !running) return;
      tickRef.current = setInterval(() => {
        setTimerLeft((prev) => {
          if (phase !== 'round') return prev;
          const next = prev - 1;
          if (next <= 0) {
            // round ended -> build summary tick & start transition
            handleRoundEnded();
            return 0;
          }
          return next;
        });
        setTransitionLeft((prev) => {
          if (phase !== 'transition') return prev;
          const next = prev - 1;
          if (next <= 0) {
            startNextRound();
            return transitionSeconds;
          }
          return next;
        });
      }, 1000);
  
      return () => {
        if (tickRef.current) {
          clearInterval(tickRef.current);
          tickRef.current = null;
        }
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [phase, running, transitionSeconds]);
  
    /* ---------- mode change ---------- */
    const changeMatchMode = () => {
      const next = matchMode === MATCH_MODES.BAND ? MATCH_MODES.WINDOW : MATCH_MODES.BAND;
      setMatchMode(next);
      setMatchModeState(next);
    };
  
    /* ---------- round build ---------- */
    const buildRound = (roundNo, presentPlayers) => {
      const t0 = performance.now();
      const { playing, benched: nowBenched } = selectPlayersForRound(
        presentPlayers,
        roundNo,
        lastRoundBenched.current,
        courtsCount
      );
      const matchesBuilt = buildMatchesFrom16(playing, teammateHistory.current, courtsCount);
      const t1 = performance.now();
  
      // update diag
      setDiag((prev) => ({
        roundBuildTimes: [...prev.roundBuildTimes, t1 - t0],
        usedCourts: [...prev.usedCourts, matchesBuilt.length],
        teamImbalances: [
          ...prev.teamImbalances,
          ...matchesBuilt.map((m) => Math.abs((m.avg1 || 0) - (m.avg2 || 0))),
        ],
        spanPerMatch: [
          ...prev.spanPerMatch,
          ...matchesBuilt.map((m) => {
            const all = [...m.team1, ...m.team2].map((p) => p.skill_level);
            return Math.max(...all) - Math.min(...all);
          }),
        ],
        outOfBandCounts: [...prev.outOfBandCounts, 0],
      }));
  
      // update session stats (per-player) for present players only
      setSessionStats((prev) => {
        const next = new Map(prev);
        // playing
        for (const m of matchesBuilt) {
          for (const p of [...m.team1, ...m.team2]) {
            const row = next.get(p.id) || {
              id: p.id,
              name: p.name,
              skill: p.skill_level,
              played: 0,
              benched: 0,
              worstBenchStreak: 0,
              benchStreak: 0,
              teammates: new Set(),
              opponents: new Set(),
            };
            row.played += 1;
            row.benchStreak = 0;
            // teammates/opponents
            const mates = m.team1.some((x) => x.id === p.id) ? m.team1 : m.team2;
            const opps = m.team1.some((x) => x.id === p.id) ? m.team2 : m.team1;
            mates
              .filter((x) => x.id !== p.id)
              .forEach((x) => row.teammates.add(x.id));
            opps.forEach((x) => row.opponents.add(x.id));
            next.set(p.id, row);
          }
        }
        // benched
        for (const b of nowBenched) {
          const row = next.get(b.id) || {
            id: b.id,
            name: b.name,
            skill: b.skill_level,
            played: 0,
            benched: 0,
            worstBenchStreak: 0,
            benchStreak: 0,
            teammates: new Set(),
            opponents: new Set(),
          };
          row.benched += 1;
          row.benchStreak = (row.benchStreak || 0) + 1;
          row.worstBenchStreak = Math.max(row.worstBenchStreak || 0, row.benchStreak);
          next.set(b.id, row);
        }
        return next;
      });
  
      // push to UI
      setMatches(matchesBuilt);
      setBenched(nowBenched);
      lastRoundBenched.current = new Set(nowBenched.map((b) => b.id));
      // update players list bench_count / last_played_round
      setPlayers((prev) =>
        prev.map((p) => {
          const wasPlaying = playing.find((x) => x.id === p.id);
          const wasBenched = nowBenched.find((x) => x.id === p.id);
          if (wasPlaying) {
            return { ...p, last_played_round: roundNo };
          }
          if (wasBenched) {
            return { ...p, bench_count: (p.bench_count || 0) + 1 };
          }
          return p;
        })
      );
  
      return { playing, nowBenched };
    };
  
    const startNextRound = () => {
      const nextRound = roundRef.current + 1;
      roundRef.current = nextRound;
      setRound(nextRound);
      const { nowBenched } = buildRound(nextRound, present);
      // new round timer
      setPhase('round');
      setTimerLeft(timerTotal);
      setTransitionLeft(transitionSeconds);
      setRunning(true);
  
      // persist to netlify
      persistRound(nextRound, nowBenched);
    };
  
    const persistRound = async (roundNo, nowBenched) => {
      if (!isAdmin) return; // only admin can write
      try {
        const updates = [];
        // benched updates
        for (const b of nowBenched) {
          updates.push({
            id: b.id,
            fields: {
              bench_count: (b.bench_count || 0) + 1,
              last_played_round: b.last_played_round || 0,
            },
          });
        }
        // playing updates
        for (const p of matches.flatMap((m) => [...m.team1, ...m.team2])) {
          updates.push({
            id: p.id,
            fields: { last_played_round: roundNo },
          });
        }
        if (updates.length) {
          await APIClient.patch(updates, adminKey);
        }
      } catch (e) {
        console.warn('Failed to save round updates', e);
      }
    };
  
    const handleRoundEnded = () => {
      // start transition
      setPhase('transition');
      setRunning(true);
      setTransitionLeft(transitionSeconds);
      beep(400, 400);
    };
  
    /* ---------- basic actions ---------- */
    const beginNight = () => {
      setView('session');
    };
  
    const handleBuildResume = () => {
      // if no matches yet -> build first
      if (!matches.length) {
        startNextRound();
      } else {
        // just resume current phase
        setRunning(true);
      }
    };
  
    const handlePause = () => {
      setRunning(false);
    };
  
    const handleNextRound = () => {
      startNextRound();
    };
  
    const handleEndNight = () => {
      // snapshot summary
      const allRows = Array.from(sessionStats.values());
      setSummaryPayload({
        rounds: roundRef.current,
        rows: allRows,
        diag,
        presentCount: present.length,
      });
      // reset runtime
      setPhase('stopped');
      setRunning(false);
      setRound(0);
      roundRef.current = 0;
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
      // unmark everyone present
      setPlayers((prev) => prev.map((p) => ({ ...p, is_present: false, bench_count: 0, last_played_round: 0 })));
      setShowSummary(true);
    };
  
    /* ---------- swap handling ---------- */
    const handleCourtChipClick = (player) => {
      // non-admin swap STILL allowed per your last instruction
      if (!swapSource) {
        setSwapSource(player);
        return;
      }
      // clicking same again cancels
      if (swapSource.id === player.id) {
        setSwapSource(null);
        return;
      }
    };
  
    const handleBenchSwapTarget = (benchPlayer) => {
      if (!swapSource) return;
      // swap benchPlayer <-> swapSource
      // 1) update matches: replace swapSource with benchPlayer
      setMatches((prev) =>
        prev.map((m) => {
          const t1 = m.team1.map((p) => (p.id === swapSource.id ? benchPlayer : p));
          const t2 = m.team2.map((p) => (p.id === swapSource.id ? benchPlayer : p));
          const all = [...t1, ...t2];
          return {
            ...m,
            team1: t1,
            team2: t2,
            avg1: (t1[0].skill_level + t1[1].skill_level) / 2,
            avg2: (t2[0].skill_level + t2[1].skill_level) / 2,
          };
        })
      );
      // 2) update benched list
      setBenched((prev) =>
        prev
          .map((b) => (b.id === benchPlayer.id ? swapSource : b))
          .map((b) => ({ ...b }))
      );
      // 3) update players array bench counts
      setPlayers((prev) =>
        prev.map((p) => {
          if (p.id === benchPlayer.id) {
            // bench player now played -> reduce bench_count by 1
            return { ...swapSource, bench_count: Math.max(0, (swapSource.bench_count || 1) - 1) };
          }
          if (p.id === swapSource.id) {
            // court player now benched -> add 1
            return { ...benchPlayer, bench_count: (benchPlayer.bench_count || 0) + 1 };
          }
          return p;
        })
      );
      setSwapSource(null);
    };
  
    /* ---------- admin prompt ---------- */
    const openAdminModal = () => {
      setShowAdminModal(true);
    };
    const handleAdminSubmit = (pwd) => {
      if (pwd === 'flomintonsys') {
        sessionStorage.setItem('adminKey', pwd);
        setAdminKey(pwd);
        setShowAdminModal(false);
      } else {
        alert('Wrong admin password');
      }
    };
  
    /* ---------- add player ---------- */
    const handleAddPlayer = async (player) => {
      try {
        await APIClient.upsert([player], adminKey, club);
        const list = await APIClient.listPlayers(club);
        setPlayers(list);
      } catch (e) {
        alert('Failed to add player');
      }
    };
  
    /* ---------- render ---------- */
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
          onBegin={beginNight}
          onPause={handlePause}
          onResume={handleBuildResume}
          onNext={handleNextRound}
          onEnd={handleEndNight}
          onSettings={() => setShowSettings(true)}
          onAdmin={openAdminModal}
          matchMode={matchMode}
          onToggleMode={changeMatchMode}
          round={round}
          phase={phase}
          timerLeft={timerLeft}
          transitionLeft={transitionLeft}
          warn={isWarn}
          blink={phase === 'transition'}
          presentCount={present.length}
        />
        {view === 'home' && <HomeScreen onBegin={beginNight} onSettings={() => setShowSettings(true)} onAdmin={openAdminModal} />}
        {view === 'session' && (
          <SessionScreen
            players={players}
            present={present}
            notPresent={notPresent}
            matches={matches}
            benched={benched}
            courtsCount={courtsCount}
            isAdmin={isAdmin}
            onTogglePresent={async (p) => {
              const next = players.map((x) => (x.id === p.id ? { ...x, is_present: !x.is_present } : x));
              setPlayers(next);
              try {
                await APIClient.patch(
                  [
                    {
                      id: p.id,
                      fields: { is_present: !p.is_present },
                    },
                  ],
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
            onSwapCourt={handleCourtChipClick}
            swapSource={swapSource}
            onSwapTarget={handleBenchSwapTarget}
          />
        )}
        {view === 'display' && (
          <DisplayScreen matches={matches} benched={benched} round={round} timerLeft={timerLeft} phase={phase} present={present} />
        )}
  
        {showSettings && (
          <SettingsModal
            onClose={() => setShowSettings(false)}
            timerTotal={timerTotal}
            warnSeconds={warnSeconds}
            transitionSeconds={transitionSeconds}
            courtsCount={courtsCount}
            onSave={({ roundMins, warn, transition, courts }) => {
              const secs = roundMins * 60;
              setTimerTotal(secs);
              setTimerLeft(secs);
              setWarnSeconds(warn);
              setTransitionSeconds(transition);
              setTransitionLeft(transition);
              setCourtsCount(courts);
              LS.set('flo.round.minutes', roundMins);
              LS.set('flo.warn.seconds', warn);
              LS.set('flo.transition.seconds', transition);
              LS.set('flo.courts', courts);
              setShowSettings(false);
            }}
          />
        )}
  
        {showSummary && (
          <RundownModal payload={summaryPayload} onClose={() => setShowSummary(false)} players={players} present={present} />
        )}
  
        {showAdminModal && <AdminModal onSubmit={handleAdminSubmit} onClose={() => setShowAdminModal(false)} />}
  
        {showAddPlayerModal && (
          <AddPlayerModal
            onClose={() => setShowAddPlayerModal(false)}
            onSave={(p) => {
              handleAddPlayer(p);
              setShowAddPlayerModal(false);
            }}
          />
        )}
      </div>
    );
  }
  
  /* ----------------- small components ----------------- */
  
  function PlayerChip({ player, onClick, active, dimmed, showBench, benchCount }) {
    const genderClass = player.gender === 'F' ? 'chip-f' : 'chip-m';
    return (
      <div
        className={`player-chip ${genderClass} ${active ? 'chip-active' : ''} ${dimmed ? 'chip-dim' : ''}`}
        onClick={onClick}
      >
        <span className="chip-name">{player.name}</span>
        <span className="chip-level">L{player.skill_level}</span>
        {showBench ? <span className="chip-bench">B{benchCount || 0}</span> : null}
      </div>
    );
  }
  
  /* the rest of your components (TopBar, SessionScreen, DisplayScreen, SettingsModal,
     RundownModal, AdminModal, AddPlayerModal, HomeScreen, ClubGate) stay exactly as in your
     current file – no other intentional edits */
  