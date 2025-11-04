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
  async listPlayers() {
    const res = await fetch(API, { method: 'GET' });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.message || 'Failed to load players');
    return (data || []).map(p => ({
      id: p.id,
      name: p.name,
      gender: p.gender || 'M',
      skill_level: Number(p.skill_level) || 1,
      is_present: !!p.is_present,
      bench_count: Number(p.bench_count) || 0,
      last_played_round: Number(p.last_played_round) || 0,
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
  async upsert(players, adminKey) {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey || '' },
      body: JSON.stringify({ players }),
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

  setDisplay(payload) {
    try {
      localStorage.setItem('flo.display.payload', JSON.stringify(payload));
    } catch {}
  },
  getDisplay() {
    try {
      const raw = localStorage.getItem('flo.display.payload');
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
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
  /* ---------- core state ---------- */
  const [players, setPlayers] = useState([]);
  const [loading, setLoading] = useState(true);

  const [round, setRound] = useState(0);
  const roundRef = useRef(0);

  const [matches, setMatches] = useState([]);
  const [benched, setBenched] = useState([]);

  // view: home vs session vs display
  const [showHome, setShowHome] = useState(() => !getInitialUiIsDisplay());
  const [isDisplay, setIsDisplay] = useState(() => getInitialUiIsDisplay());

  // timer + phases
  // phase: 'stopped' | 'round' | 'transition'
  const [phase, setPhase] = useState('stopped');
  const [running, setRunning] = useState(false);
  const [timerTotal, setTimerTotal] = useState(LS.getNum('flo.round.minutes', 12, 3, 60) * 60);
  const [warnSeconds, setWarnSeconds] = useState(LS.getNum('flo.warn.seconds', 30, 5, 120));
  const [transitionSeconds, setTransitionSeconds] = useState(
    LS.getNum('flo.transition.seconds', 30, 5, 120)
  );
  const [timerLeft, setTimerLeft] = useState(LS.getNum('flo.round.minutes', 12, 3, 60) * 60);
  const [transitionLeft, setTransitionLeft] = useState(transitionSeconds);

  const tickRef = useRef(null);

  // settings / admin
  const [showSettings, setShowSettings] = useState(false);
  const [showRundown, setShowRundown] = useState(false);
  const [adminKey, setAdminKey] = useState(() => sessionStorage.getItem('adminKey') || '');
  const isAdmin = !!adminKey;

  // match mode shown even if not admin (per latest instructions)
  const [matchMode, setMatchModeState] = useState(() => getMatchMode());

  // display syncing
  const lastDisplayTs = useRef(0);

  // diagnostics store (for System Diagnostics tab)
  const [diag, setDiag] = useState({
    roundBuildTimes: [],
    usedCourts: [],
    teamImbalances: [],
    spanPerMatch: [],
    outOfBandCounts: [],
  });

  // per-player session stats (for Smart Session Summary)
  const [sessionStats, setSessionStats] = useState(() => new Map());

  // rematch memory (logic.js uses it but we keep it here)
  const teammateHistory = useRef(new Map());

  // last round's benched IDs (fairness)
  const lastRoundBenched = useRef(new Set());

  // sound
  const volumeRef = useRef(LS.getNum('flo.volume', 0.3, 0, 1));
  const { beep } = useBeep(volumeRef);

  /* ---------- load players on mount ---------- */
  useEffect(() => {
    if (isDisplay) return; // display page pulls from localStorage
    (async () => {
      try {
        const list = await APIClient.listPlayers();
        setPlayers(list);
      } catch (e) {
        console.error(e);
        alert('Could not load players (Netlify function). Check logs / env.');
      } finally {
        setLoading(false);
      }
    })();
  }, [isDisplay]);

  /* ---------- derived lists ---------- */
  const present = useMemo(() => players.filter((p) => p.is_present), [players]);
  const notPresent = useMemo(() => players.filter((p) => !p.is_present), [players]);

  /* ---------- display sync ---------- */
  const pushDisplay = (override = {}) => {
    const payload = {
      kind: 'flo-display-v1',
      ts: Date.now(),
      round,
      running,
      phase,
      timeLeft: phase === 'round' ? timerLeft : transitionLeft,
      timerTotal,
      transitionSeconds,
      warnSeconds,
      presentCount: present.length,
      matches: matches.map((m) => ({
        court: m.court,
        avg1: m.avg1,
        avg2: m.avg2,
        team1: m.team1.map((p) => ({
          id: p.id,
          name: p.name,
          gender: p.gender,
          skill_level: p.skill_level,
        })),
        team2: m.team2.map((p) => ({
          id: p.id,
          name: p.name,
          gender: p.gender,
          skill_level: p.skill_level,
        })),
      })),
      benched: benched.map((p) => ({
        id: p.id,
        name: p.name,
        gender: p.gender,
        skill_level: p.skill_level,
      })),
      ...override,
    };
    LS.setDisplay(payload);
  };

  // display-mode reader
  useEffect(() => {
    if (!isDisplay) return;
    const apply = (payload) => {
      if (!payload || payload.kind !== 'flo-display-v1') return;
      if (payload.ts && payload.ts <= lastDisplayTs.current) return;
      lastDisplayTs.current = payload.ts || Date.now();

      setRound(Number(payload.round || 0));
      setRunning(!!payload.running);
      setPhase(payload.phase || 'stopped');
      setTimerTotal(Number(payload.timerTotal || 12 * 60));
      setTransitionSeconds(Number(payload.transitionSeconds || 30));
      setWarnSeconds(Number(payload.warnSeconds || 30));
      if (payload.phase === 'round') {
        setTimerLeft(Number(payload.timeLeft || 0));
      } else {
        setTransitionLeft(Number(payload.timeLeft || 0));
      }

      if (Array.isArray(payload.matches)) {
        const active = !!payload.running || (payload.round || 0) > 0;
        if (active && payload.matches.length === 0) {
          // ignore empty to avoid flicker
        } else {
          setMatches(
            payload.matches.map((m) => ({
              court: m.court,
              avg1: m.avg1,
              avg2: m.avg2,
              team1: m.team1 || [],
              team2: m.team2 || [],
            }))
          );
        }
      }
      if (Array.isArray(payload.benched)) {
        setBenched(payload.benched);
      }
    };

    // initial
    apply(LS.getDisplay());
    const onStorage = (e) => {
      if (e.key === 'flo.display.payload' && e.newValue) {
        try {
          apply(JSON.parse(e.newValue));
        } catch {}
      }
    };
    window.addEventListener('storage', onStorage);
    const poll = setInterval(() => apply(LS.getDisplay()), 800);
    return () => {
      window.removeEventListener('storage', onStorage);
      clearInterval(poll);
    };
  }, [isDisplay]);

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
  const isBlink = (phase === 'transition' && running) || (phase === 'round' && !running && timerLeft === 0);

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
    pushDisplay({ phase: 'round', running: true, timeLeft: timerLeft });
    tickRef.current = setInterval(() => {
      setTimerLeft((prev) => {
        const next = prev - 1;
        pushDisplay({ phase: 'round', running: true, timeLeft: next });
        if (next === warnSeconds) beep(1200, 350);
        if (next <= 0) {
          clearTick();
          setRunning(false);
          beep(500, 700);
          // build next round immediately, THEN start transition timer
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
    pushDisplay({ phase: 'transition', running: true, timeLeft: transitionSeconds });
    tickRef.current = setInterval(() => {
      setTransitionLeft((prev) => {
        const next = prev - 1;
        pushDisplay({ phase: 'transition', running: true, timeLeft: next });
        if (next <= 0) {
          clearTick();
          setRunning(false);
          beep(850, 400); // "start playing" beep
          // start real round timer (matches are already built)
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
    pushDisplay({ running: false });
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
      4
    );
    lastRoundBenched.current = new Set(benched.map((b) => b.id));
    setBenched(benched);

    const ms = buildMatchesFrom16(playing, teammateHistory.current, 4);
    setMatches(ms);

    // diagnostics snapshot
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

    // per-player session stats
    setSessionStats((prev) => {
      const next = new Map(prev);
      // playing => +1 played, reset benched gap
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
      // benched => +1 benched, increment gap
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
      // teammates/opponents
      ms.forEach((match) => {
        const t1 = match.team1;
        const t2 = match.team2;
        if (t1.length === 2 && t2.length === 2) {
          const [a, b] = t1;
          const [c, d] = t2;
          const up = (p, teamMates, opps) => {
            const cur = next.get(p.id);
            teamMates.forEach((tm) => cur.teammates.add(tm.id));
            opps.forEach((op) => cur.opponents.add(op.id));
          };
          up(a, [b], [c, d]);
          up(b, [a], [c, d]);
          up(c, [d], [a, b]);
          up(d, [c], [a, b]);
        }
      });
      return next;
    });

    // send to display
    pushDisplay({ matches: ms, benched });
  }

  async function nextRoundInternal() {
    const next = roundRef.current + 1;
    roundRef.current = next;
    setRound(next);
    await buildNextRound(next);
  }

  /* =========================================================
     UI ACTIONS (top toolbar)
     ========================================================= */

  // Begin Night: just enter Session view — NO building
  function onBeginNight() {
    setShowHome(false);
    // we stay in stopped phase until user hits Build/Resume
  }

  // Build/Resume: if no matches -> build; else resume timer
  async function onBuildResume() {
    if (matches.length === 0) {
      // build but do NOT auto start transition — user wants manual resume to start timer?
      await nextRoundInternal();
      // keep phase stopped; user can now hit Build/Resume again to start round
      setTimerLeft(timerTotal);
      setPhase('stopped');
      pushDisplay({ matches, benched, phase: 'stopped', running: false });
    } else {
      // just resume current phase — always to round timer
      if (phase === 'transition') {
        startTransitionTimer();
      } else {
        startRoundTimer();
      }
    }
  }

  function onPause() {
    stopTimer();
  }

  // Next Round: force new quads, skip transition, start round timer directly
  async function onNextRound() {
    await nextRoundInternal();
    setTimerLeft(timerTotal);
    setPhase('round');
    startRoundTimer();
  }

  async function onEndNight() {
    // open summary
    setShowRundown(true);
    // reset present + bench_count on frontend
    const resetPlayers = players.map((p) => ({
      ...p,
      is_present: false,
      bench_count: 0,
      last_played_round: 0,
    }));
    setPlayers(resetPlayers);
    setMatches([]);
    setBenched([]);
    setRound(0);
    roundRef.current = 0;
    stopTimer();
    setPhase('stopped');
    setShowHome(true);
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
    // persist reset
    try {
      await APIClient.patch(
        resetPlayers.map((p) => ({
          id: p.id,
          is_present: false,
          bench_count: 0,
          last_played_round: 0,
        })),
        adminKey
      );
    } catch (e) {
      console.warn('Failed to reset players on end night', e);
    }
  }

  function openDisplay() {
    pushDisplay();
    const url = new URL(window.location.href);
    url.searchParams.set('display', '1');
    window.open(url.toString(), '_blank', 'noopener,noreferrer');
  }

  // mode toggle is public
  function toggleMode() {
    const next = matchMode === MATCH_MODES.WINDOW ? MATCH_MODES.BAND : MATCH_MODES.WINDOW;
    setMatchModeState(next);
    setMatchMode(next);
    // if we're mid-night and have matches, rebuild to reflect new mode
    if (!isDisplay && round > 0) {
      nextRoundInternal();
    }
  }

  /* =========================================================
     SETTINGS
     ========================================================= */
  function openSettings() {
    setShowSettings(true);
  }
  function saveSettings(mins, warn, vol, transitionSec) {
    LS.set('flo.round.minutes', mins);
    LS.set('flo.warn.seconds', warn);
    LS.set('flo.volume', vol);
    LS.set('flo.transition.seconds', transitionSec);
    setTimerTotal(mins * 60);
    setTimerLeft(mins * 60);
    setWarnSeconds(warn);
    setTransitionSeconds(transitionSec);
    volumeRef.current = vol;
    setShowSettings(false);
    pushDisplay({
      timerTotal: mins * 60,
      warnSeconds: warn,
      transitionSeconds: transitionSec,
      timeLeft: mins * 60,
    });
  }

  /* =========================================================
     ADMIN
     ========================================================= */
  function adminLogin() {
    const key = prompt('Enter admin key:');
    if (!key) return;
    sessionStorage.setItem('adminKey', key);
    setAdminKey(key);
    alert('Admin mode enabled');
  }
  function adminLogout() {
    sessionStorage.removeItem('adminKey');
    setAdminKey('');
    alert('Admin mode disabled');
  }

  /* =========================================================
     DIAGNOSTICS HELPERS
     ========================================================= */
  function computeDiagnostics(roundMatches) {
    const used = roundMatches.length;
    const imbalances = roundMatches.map((m) => Math.abs((m.avg1 || 0) - (m.avg2 || 0)));
    const avgImbalance = imbalances.length
      ? imbalances.reduce((a, b) => a + b, 0) / imbalances.length
      : 0;
    const spans = roundMatches.map((m) => {
      const all = [...m.team1, ...m.team2].map((p) => Number(p.skill_level || 0));
      if (!all.length) return 0;
      return Math.max(...all) - Math.min(...all);
    });
    const avgSpan = spans.length ? spans.reduce((a, b) => a + b, 0) / spans.length : 0;
    const outOfBand = roundMatches.reduce((acc, m) => {
      const skills = [...m.team1, ...m.team2].map((p) => Number(p.skill_level || 0)).sort((a, b) => a - b);
      if (skills.length < 4) return acc;
      const mid = (skills[1] + skills[2]) / 2;
      return acc + skills.filter((s) => Math.abs(s - mid) > 2).length;
    }, 0);
    return { used, avgImbalance, avgSpan, outOfBand };
  }

  /* =========================================================
     RENDER HELPERS
     ========================================================= */
  function Court({ m, large = false, showLevels, showAverages }) {
    const Tag = (pl) => (
      <div className={`tag ${large ? 'lg' : ''}`} key={pl.id}>
        <span className={`pill sm ${pl.gender === 'F' ? 'female' : 'male'}`}>{pl.gender}</span>
        {pl.name} {showLevels ? <span className="muted">(L{pl.skill_level})</span> : null}
      </div>
    );
    return (
      <div className={`court glass ${large ? 'lg' : ''}`}>
        <div className="court-head">
          <h3>Court {m.court}</h3>
          {showAverages && (
            <div className="avg-pair">
              <span className="avg">
                Team 1 Avg: <b>{m.avg1?.toFixed ? m.avg1.toFixed(1) : m.avg1}</b>
              </span>
              <span className="avg">
                Team 2 Avg: <b>{m.avg2?.toFixed ? m.avg2.toFixed(1) : m.avg2}</b>
              </span>
            </div>
          )}
        </div>
        <div className="team-row">{m.team1.map(Tag)}</div>
        <div className="team-divider" />
        <div className="team-row">{m.team2.map(Tag)}</div>
      </div>
    );
  }

  function RowPlayer({ p, onDoubleClick, showLevels, showBenchCount }) {
    return (
      <div
        className={`row-player ${p.is_present ? 'present' : ''}`}
        onDoubleClick={onDoubleClick}
        title="Double-click to toggle presence"
      >
        <span className="name">{p.name}</span>
        <span className="meta">
          {showLevels ? <span>L{p.skill_level}</span> : null}
          {showBenchCount ? <span>Benched {p.bench_count || 0}</span> : null}
        </span>
      </div>
    );
  }

  function SettingsPanel() {
    const [mins, setMins] = useState(timerTotal / 60);
    const [warn, setWarn] = useState(warnSeconds);
    const [vol, setVol] = useState(volumeRef.current);
    const [trans, setTrans] = useState(transitionSeconds);
    return (
      <div className="modal-backdrop">
        <div className="modal glass">
          <h3>Settings</h3>
          <div className="settings-grid">
            <div className="setting">
              <label>Round length (minutes)</label>
              <input
                className="input"
                type="number"
                min="3"
                max="60"
                value={mins}
                onChange={(e) => setMins(Number(e.target.value))}
              />
            </div>
            <div className="setting">
              <label>Warn at (seconds left)</label>
              <input
                className="input"
                type="number"
                min="5"
                max="120"
                value={warn}
                onChange={(e) => setWarn(Number(e.target.value))}
              />
            </div>
            <div className="setting">
              <label>Transition timer (seconds)</label>
              <input
                className="input"
                type="number"
                min="5"
                max="120"
                value={trans}
                onChange={(e) => setTrans(Number(e.target.value))}
              />
            </div>
            <div className="setting">
              <label>Sound volume (0–1)</label>
              <input
                className="input"
                type="number"
                min="0"
                max="1"
                step="0.05"
                value={vol}
                onChange={(e) => setVol(Number(e.target.value))}
              />
            </div>
          </div>

          <div className="right mt-12">
            <button className="btn ghost" onClick={() => setShowSettings(false)}>
              Cancel
            </button>
            <button className="btn" onClick={() => saveSettings(mins, warn, vol, trans)}>
              Save
            </button>
          </div>
        </div>
      </div>
    );
  }

  /* ---------- Smart Session Summary / Diagnostics ---------- */
  function buildSmartSummary() {
    const per = Array.from(sessionStats.values()).map((p) => {
      const gaps = p.benchGap.length ? p.benchGap : [0];
      const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;
      return {
        id: p.id,
        name: p.name,
        level: p.level,
        played: p.played,
        benched: p.benched,
        avgBenchGap: avgGap,
        worstBenchStreak: p.worstBenchStreak,
        teammates: p.teammates.size,
        opponents: p.opponents.size,
      };
    });
    const totalRounds = roundRef.current;
    const presentCount = present.length; // current
    let males = 0,
      females = 0;
    players.forEach((p) => {
      if (p.gender === 'F') females++;
      else males++;
    });

    const plays = per.map((p) => p.played);
    const mean = plays.length ? plays.reduce((a, b) => a + b, 0) / plays.length : 0;
    const variance =
      plays.length > 1
        ? plays.reduce((acc, v) => acc + Math.pow(v - mean, 2), 0) / (plays.length - 1)
        : 0;
    const stdDev = Math.sqrt(variance);
    const spread = plays.length ? Math.max(...plays) - Math.min(...plays) : 0;
    const fairnessRatio = mean ? stdDev / mean : 0;

    return {
      rounds: totalRounds,
      participantsCount: players.length,
      males,
      females,
      per,
      meanPlays: mean,
      stdDev,
      spread,
      fairnessRatio,
      copyText: `FLOminton Summary\nRounds: ${totalRounds}\nParticipants: ${players.length}\nFairness: mean=${mean.toFixed(
        2
      )} stdev=${stdDev.toFixed(2)} spread=${spread}`,
      csvRows: [
        ['name', 'level', 'played', 'benched', 'avg_bench_gap', 'worst_bench_streak', 'unique_teammates', 'unique_opponents'],
        ...per.map((p) => [
          p.name,
          p.level,
          p.played,
          p.benched,
          p.avgBenchGap.toFixed(2),
          p.worstBenchStreak,
          p.teammates,
          p.opponents,
        ]),
      ],
    };
  }

  function downloadCSV(rows) {
    const csv = rows.map((r) => r.map((x) => `"${String(x).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'flo-session.csv';
    a.click();
  }
  function copyToClipboard(text) {
    navigator.clipboard?.writeText(text);
  }

  function RundownModal() {
    const S = buildSmartSummary();
    const [tab, setTab] = useState('summary');
    return (
      <div className="modal-backdrop">
        <div className="modal glass">
          <div className="tabs">
            <button className={`tab ${tab === 'summary' ? 'active' : ''}`} onClick={() => setTab('summary')}>
              Smart Session Summary
            </button>
            <button
              className={`tab ${tab === 'diagnostics' ? 'active' : ''}`}
              onClick={() => setTab('diagnostics')}
            >
              System Diagnostics
            </button>
          </div>

          {tab === 'summary' && (
            <>
              <div className="two-col">
                <div>
                  <h4>Overview</h4>
                  <div>
                    Rounds: <b>{S.rounds}</b>
                  </div>
                  <div>
                    Participants: <b>{S.participantsCount}</b> (M {S.males} • F {S.females})
                  </div>
                </div>
                <div>
                  <h4>Fairness</h4>
                  <div>
                    Mean plays: <b>{S.meanPlays.toFixed(2)}</b> &nbsp; StdDev: <b>{S.stdDev.toFixed(2)}</b> &nbsp;
                    Spread: <b>{S.spread}</b> &nbsp; Ratio: <b>{S.fairnessRatio.toFixed(2)}</b>
                  </div>
                </div>
              </div>

              <div className="table-wrap" style={{ marginTop: 12 }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Lvl</th>
                      <th>Played</th>
                      <th>Benched</th>
                      <th>Avg Bench Gap</th>
                      <th>Worst Bench Streak</th>
                      <th>Unique Teammates</th>
                      <th>Unique Opponents</th>
                    </tr>
                  </thead>
                  <tbody>
                    {S.per
                      .sort((a, b) => b.played - a.played || a.name.localeCompare(b.name))
                      .map((x) => (
                        <tr key={x.id}>
                          <td>{x.name}</td>
                          <td className="center">{x.level}</td>
                          <td className="center">
                            <b>{x.played}</b>
                          </td>
                          <td className="center">{x.benched}</td>
                          <td className="center">{x.avgBenchGap.toFixed(2)}</td>
                          <td className="center">{x.worstBenchStreak}</td>
                          <td className="center">{x.teammates}</td>
                          <td className="center">{x.opponents}</td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>

              <div className="right mt-12" style={{ gap: 8 }}>
                <button className="btn" onClick={() => downloadCSV(S.csvRows)}>
                  Export CSV
                </button>
                <button className="btn" onClick={() => copyToClipboard(S.copyText)}>
                  Copy Summary
                </button>
                <button className="btn" onClick={() => setShowRundown(false)}>
                  Close
                </button>
              </div>
            </>
          )}

          {tab === 'diagnostics' && (
            <>
              <div className="two-col">
                <div>
                  <h4>Round Build Performance</h4>
                  <div>Build times (ms): {(diag.roundBuildTimes || []).join(', ') || '-'}</div>
                  <div>Courts used per round: {(diag.usedCourts || []).join(', ') || '-'}</div>
                </div>
                <div>
                  <h4>Match Quality</h4>
                  <div>Avg team imbalance / round: {(diag.teamImbalances || []).join(', ') || '-'}</div>
                  <div>Avg skill span / match (round avg): {(diag.spanPerMatch || []).join(', ') || '-'}</div>
                  <div>Out-of-band (±2 from median): {(diag.outOfBandCounts || []).join(', ') || '-'}</div>
                </div>
              </div>

              <div className="right mt-12">
                <button className="btn" onClick={() => setShowRundown(false)}>
                  Close
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  /* ---------- Display view ---------- */
  function DisplayView() {
    const activeTime = phase === 'round' ? timerLeft : transitionLeft;
    const headerClasses = `display-meta centered ${isWarn ? 'warn' : ''} ${
      phase === 'transition' ? 'blink-redwhite' : ''
    }`;
    return (
      <div className="display page">
        <div className="display-head">
          <div className="display-title centered">The FLOminton System</div>
          <div className={headerClasses}>
            <span>Round {round || '-'}</span>
            <span>•</span>
            <span
              className={`bigtime ${isWarn ? 'warn' : ''} ${
                phase === 'transition' ? 'blink-redwhite' : ''
              }`}
            >
              {formatTime(activeTime)}
            </span>
            <span>•</span>
            <span>{present.length} present</span>
          </div>
          <div className="display-hint centered">Press F for fullscreen</div>
        </div>

        <div className="display-courts">
          {matches.length === 0 ? (
            <div className="muted p-20 centered">Waiting for matches…</div>
          ) : (
            matches.map((m) => (
              <Court key={m.court} m={m} large showLevels={false} showAverages={false} />
            ))
          )}
        </div>

        {/* benched bottom */}
        <div className="panel glass display-benched">
          <div className="panel-head centered">
            <h3>Benched Players</h3>
          </div>
          {benched.length === 0 ? (
            <div className="muted p-8 centered">No one benched this round.</div>
          ) : (
            <div className="bench-row centered">
              {benched.map((p) => (
                <div className="tag lg display-name" key={p.id}>
                  <span className={`pill sm ${p.gender === 'F' ? 'female' : 'male'}`}>{p.gender}</span>
                  {p.name}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  /* ---------- HOME view ---------- */
  function HomeView() {
    return (
      <div className="page centered" style={{ flexDirection: 'column', gap: 12 }}>
        <h2>The FLOminton System</h2>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button className="btn primary" onClick={onBeginNight}>
            Begin Night
          </button>
          <button className="btn" onClick={openSettings}>
            Settings
          </button>
          {isAdmin ? (
            <button className="btn" onClick={adminLogout}>
              Admin (On)
            </button>
          ) : (
            <button className="btn" onClick={adminLogin}>
              Admin
            </button>
          )}
          <button className="btn danger" onClick={onEndNight}>
            End Night
          </button>
        </div>
      </div>
    );
  }

  /* ---------- MAIN RENDER ---------- */
  if (isDisplay) {
    // allow fullscreen hotkey
    useEffect(() => {
      const onKey = (e) => {
        if (e.key === 'f' || e.key === 'F') {
          const el = document.documentElement;
          if (!document.fullscreenElement) el.requestFullscreen?.();
          else document.exitFullscreen?.();
        }
      };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, []);
    return <DisplayView />;
  }

  if (loading) {
    return (
      <div className="page centered">
        <div className="muted">Loading players…</div>
      </div>
    );
  }

  if (showHome) {
    return (
      <>
        <HomeView />
        {showSettings && <SettingsPanel />}
        {showRundown && <RundownModal />}
      </>
    );
  }

  return (
    <div className="page">
      {/* Toolbar */}
      <div className="toolbar glass">
        <div className="toolbar-left">
          {/* Begin Night lives on home only; here we show session controls */}
          <button className="btn" onClick={onPause} disabled={!running}>
            Pause
          </button>
          <button className="btn primary" onClick={onBuildResume}>
            Build/Resume
          </button>
          <button className="btn" onClick={onNextRound}>
            Next Round
          </button>
          <button className="btn danger" onClick={onEndNight}>
            End Night
          </button>
          <button className="btn" onClick={openDisplay}>
            Open Display
          </button>
          {/* mode toggle stays public */}
          <button className="btn" onClick={toggleMode}>
            Mode: {matchMode === MATCH_MODES.BAND ? 'Band' : 'Window'}
          </button>
          <button className="btn ghost" onClick={openSettings}>
            Settings
          </button>
          {isAdmin ? (
            <button className="btn" onClick={adminLogout}>
              Admin (On)
            </button>
          ) : (
            <button className="btn" onClick={adminLogin}>
              Admin
            </button>
          )}
        </div>
        <div
          className={`toolbar-right time ${isWarn ? 'warn' : ''} ${
            phase === 'transition' ? 'blink-redwhite' : ''
          }`}
        >
          {round > 0
            ? `Round ${round} • ${formatTime(phase === 'round' ? timerLeft : transitionLeft)}`
            : 'Not running'}
        </div>
      </div>

      {/* Courts */}
      <div id="courts" className="courts-grid">
        {matches.map((m) => (
          <Court key={m.court} m={m} showLevels={isAdmin} showAverages={isAdmin} />
        ))}
        {matches.length === 0 && (
          <div className="muted p-12">
            No matches yet. Click <b>Build/Resume</b> to build.
          </div>
        )}
      </div>

      {/* Benched fixed rows (no scroll) */}
      <div className="panel glass">
        <div className="panel-head">
          <h3>Benched Players</h3>
        </div>
        {benched.length === 0 ? (
          <div className="muted p-8">No one benched this round.</div>
        ) : (
          <div className="bench-row">
            {benched.map((p) => (
              <div className="tag" key={p.id}>
                <span className={`pill sm ${p.gender === 'F' ? 'female' : 'male'}`}>{p.gender}</span>
                {p.name} {isAdmin ? <span className="muted">(L{p.skill_level})</span> : null}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Lists */}
      <div className="lists-grid">
        <div className="list-col">
          <div className="list-head">
            All Players <span className="badge">{notPresent.length}</span>
          </div>
          <div id="allList" className="list-box glass">
            {notPresent.map((p) => (
              <RowPlayer
                key={p.id}
                p={p}
                onDoubleClick={() => togglePresent(p)}
                showLevels={isAdmin}
                showBenchCount={isAdmin}
              />
            ))}
          </div>
        </div>
        <div className="list-col">
          <div className="list-head">
            Present Today <span className="badge">{present.length}</span>
          </div>
          <div id="presentList" className="list-box glass">
            {present.map((p) => (
              <RowPlayer
                key={p.id}
                p={p}
                onDoubleClick={() => togglePresent(p)}
                showLevels={isAdmin}
                showBenchCount={isAdmin}
              />
            ))}
          </div>
        </div>
      </div>

      {/* Admin controls could go here if you later re-enable the full panel */}

      {showSettings && <SettingsPanel />}
      {showRundown && <RundownModal />}
    </div>
  );
}

/* ================= Utilities ================= */
function getInitialUiIsDisplay() {
  const url = new URL(window.location.href);
  return url.searchParams.get('display') === '1';
}
