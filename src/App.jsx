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
    return (data || []).map((p) => ({
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
  const [players, setPlayers] = useState([]);
  const [loading, setLoading] = useState(true);

  const [round, setRound] = useState(0);
  const roundRef = useRef(0);

  const [matches, setMatches] = useState([]);
  const [benched, setBenched] = useState([]);

  const [view, setView] = useState(() => getInitialView());

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

  const [sessionStats, setSessionStats] = useState(() => new Map());

  const teammateHistory = useRef(new Map());
  const lastRoundBenched = useRef(new Set());

  const volumeRef = useRef(LS.getNum('flo.volume', 0.3, 0, 1));
  const { beep } = useBeep(volumeRef);

  useEffect(() => {
    (async () => {
      try {
        const list = await APIClient.listPlayers();
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
  }, [view]);

  const present = useMemo(() => players.filter((p) => p.is_present), [players]);
  const notPresent = useMemo(() => players.filter((p) => !p.is_present), [players]);

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

  const isWarn = phase === 'round' && running && timerLeft <= warnSeconds;

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
        if (next === warnSeconds) beep(1200, 350);
        if (next <= 0) {
          clearTick();
          setRunning(false);
          beep(500, 700);
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
          beep(850, 400);
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

    const ms = buildMatchesFrom16(playing, teammateHistory.current, courtsCount);
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
  }

  async function nextRoundInternal() {
    const next = roundRef.current + 1;
    roundRef.current = next;
    setRound(next);
    await buildNextRound(next);
  }

  function onBeginNight() {
    setView('session');
  }

  async function onBuildResume() {
    if (matches.length === 0) {
      await nextRoundInternal();
      setTimerLeft(timerTotal);
      setPhase('stopped');
    } else {
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

  async function onNextRound() {
    await nextRoundInternal();
    setTimerLeft(timerTotal);
    setPhase('round');
    startRoundTimer();
  }

  async function onEndNight() {
    setShowRundown(true);
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
    setView('home');
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
    setView('display');
  }

  function toggleMode() {
    const next = matchMode === MATCH_MODES.WINDOW ? MATCH_MODES.BAND : MATCH_MODES.WINDOW;
    setMatchModeState(next);
    setMatchMode(next);
    if (view !== 'display' && round > 0) {
      nextRoundInternal();
    }
  }

  function openSettings() {
    setShowSettings(true);
  }

  function saveSettings(mins, warn, vol, transitionSec, courts) {
    LS.set('flo.round.minutes', mins);
    LS.set('flo.warn.seconds', warn);
    LS.set('flo.volume', vol);
    LS.set('flo.transition.seconds', transitionSec);
    LS.set('flo.courts', courts);
    setTimerTotal(mins * 60);
    setTimerLeft(mins * 60);
    setWarnSeconds(warn);
    setTransitionSeconds(transitionSec);
    setCourtsCount(courts);
    volumeRef.current = vol;
    setShowSettings(false);
  }

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

  const [newPlayerName, setNewPlayerName] = useState('');
  const [newPlayerGender, setNewPlayerGender] = useState('M');
  const [newPlayerLevel, setNewPlayerLevel] = useState(5);

  async function saveAllPlayers() {
    if (!isAdmin) {
      alert('Admin key required.');
      return;
    }
    try {
      await APIClient.upsert(players, adminKey);
      alert('Saved.');
    } catch (e) {
      console.error(e);
      alert('Failed to save players.');
    }
  }

  async function addPlayer() {
    if (!isAdmin) {
      alert('Admin key required.');
      return;
    }
    const name = newPlayerName.trim();
    if (!name) return;
    const tempId = 'temp-' + Math.random().toString(36).slice(2);
    const newP = {
      id: tempId,
      name,
      gender: newPlayerGender,
      skill_level: Number(newPlayerLevel) || 1,
      is_present: false,
      bench_count: 0,
      last_played_round: 0,
    };
    const nextPlayers = [...players, newP];
    setPlayers(nextPlayers);
    setNewPlayerName('');
    try {
      await APIClient.upsert([newP], adminKey);
      const refreshed = await APIClient.listPlayers();
      setPlayers(refreshed);
    } catch (e) {
      console.error(e);
      alert('Failed to add player.');
    }
  }

  async function deletePlayer(id) {
    if (!isAdmin) {
      alert('Admin key required.');
      return;
    }
    if (!window.confirm('Delete this player?')) return;
    setPlayers((prev) => prev.filter((p) => p.id !== id));
    try {
      await APIClient.remove([id], adminKey);
    } catch (e) {
      console.error(e);
      alert('Failed to delete player on server.');
    }
  }

  function updatePlayerLocal(id, field, value) {
    setPlayers((prev) =>
      prev.map((p) => (p.id === id ? { ...p, [field]: value } : p))
    );
  }

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
      const skills = [...m.team1, ...m.team2]
        .map((p) => Number(p.skill_level || 0))
        .sort((a, b) => a - b);
      if (skills.length < 4) return acc;
      const mid = (skills[1] + skills[2]) / 2;
      return acc + skills.filter((s) => Math.abs(s - mid) > 2).length;
    }, 0);
    return { used, avgImbalance, avgSpan, outOfBand };
  }

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
        <div className="court-body">
          <div className="team-side">{m.team1.map(Tag)}</div>
          {/* badminton net style (vertical) */}
          <div
            className="court-net"
            style={{
              width: '5px',
              backgroundImage:
                'linear-gradient(to bottom, rgba(255,255,255,0.8) 50%, rgba(255,255,255,0) 50%)',
              backgroundSize: '5px 10px',
              backgroundColor: 'rgba(255,255,255,0.15)',
              borderRadius: '3px',
              alignSelf: 'stretch',
            }}
          />
          <div className="team-side">{m.team2.map(Tag)}</div>
        </div>
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
    const [courts, setCourts] = useState(courtsCount);
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
              <label>Courts available</label>
              <input
                className="input"
                type="number"
                min="1"
                max="12"
                value={courts}
                onChange={(e) => setCourts(Number(e.target.value))}
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
            <button className="btn" onClick={() => saveSettings(mins, warn, vol, trans, courts)}>
              Save
            </button>
          </div>
        </div>
      </div>
    );
  }

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
      rounds: roundRef.current,
      participantsCount: players.length,
      males: players.filter((p) => p.gender !== 'F').length,
      females: players.filter((p) => p.gender === 'F').length,
      per,
      meanPlays: mean,
      stdDev,
      spread,
      fairnessRatio,
      copyText: `FLOminton Summary\nRounds: ${roundRef.current}\nParticipants: ${
        players.length
      }\nFairness: mean=${mean.toFixed(2)} stdev=${stdDev.toFixed(2)} spread=${spread}`,
      csvRows: [
        [
          'name',
          'level',
          'played',
          'benched',
          'avg_bench_gap',
          'worst_bench_streak',
          'unique_teammates',
          'unique_opponents',
        ],
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
                    Mean plays: <b>{S.meanPlays.toFixed(2)}</b> &nbsp; StdDev:{' '}
                    <b>{S.stdDev.toFixed(2)}</b> &nbsp; Spread: <b>{S.spread}</b> &nbsp; Ratio:{' '}
                    <b>{S.fairnessRatio.toFixed(2)}</b>
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

  function DisplayView() {
    const activeTime = phase === 'round' ? timerLeft : transitionLeft;
    return (
      <div className="display page">
        <div className="display-head">
          <div className="display-title centered">The FLOminton System</div>
          <div
            className={`display-meta centered ${isWarn ? 'warn' : ''} ${
              phase === 'transition' ? 'blink-redwhite' : ''
            }`}
          >
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
          <div className="display-hint centered">
            <button className="btn ghost" onClick={() => setView('session')}>
              ← Back to Session
            </button>
          </div>
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

  if (loading) {
    return (
      <div className="page centered">
        <div className="muted">Loading players…</div>
      </div>
    );
  }

  if (view === 'display') {
    return (
      <>
        <DisplayView />
        {showSettings && <SettingsPanel />}
        {showRundown && <RundownModal />}
      </>
    );
  }

  if (view === 'home') {
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
      <div className="toolbar glass">
        <div className="toolbar-left">
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

      {isAdmin && (
        <div className="panel glass" style={{ marginTop: 16 }}>
          <div className="panel-head">
            <h3>Admin Controls</h3>
          </div>
          <div className="admin-add-row">
            <input
              className="input"
              placeholder="New player name"
              value={newPlayerName}
              onChange={(e) => setNewPlayerName(e.target.value)}
            />
            <select
              className="input"
              value={newPlayerGender}
              onChange={(e) => setNewPlayerGender(e.target.value)}
            >
              <option value="M">M</option>
              <option value="F">F</option>
            </select>
            <input
              className="input"
              type="number"
              min="1"
              max="10"
              value={newPlayerLevel}
              onChange={(e) => setNewPlayerLevel(Number(e.target.value))}
            />
            <button className="btn" onClick={addPlayer}>
              Add
            </button>
            <button className="btn" onClick={saveAllPlayers}>
              Save All
            </button>
          </div>
          <div className="admin-table">
            <table className="table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Gender</th>
                  <th>Level</th>
                  <th>Present</th>
                  <th>Delete</th>
                </tr>
              </thead>
              <tbody>
                {players.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <input
                        className="input"
                        value={p.name}
                        onChange={(e) => updatePlayerLocal(p.id, 'name', e.target.value)}
                      />
                    </td>
                    <td>
                      <select
                        className="input"
                        value={p.gender}
                        onChange={(e) => updatePlayerLocal(p.id, 'gender', e.target.value)}
                      >
                        <option value="M">M</option>
                        <option value="F">F</option>
                      </select>
                    </td>
                    <td>
                      <input
                        className="input"
                        type="number"
                        min="1"
                        max="10"
                        value={p.skill_level}
                        onChange={(e) =>
                          updatePlayerLocal(p.id, 'skill_level', Number(e.target.value))
                        }
                      />
                    </td>
                    <td>
                      <input
                        type="checkbox"
                        checked={p.is_present}
                        onChange={() => togglePresent(p)}
                      />
                    </td>
                    <td>
                      <button className="btn danger" onClick={() => deletePlayer(p.id)}>
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {showSettings && <SettingsPanel />}
      {showRundown && <RundownModal />}
    </div>
  );
}

function getInitialView() {
  const url = new URL(window.location.href);
  return url.searchParams.get('display') === '1' ? 'display' : 'home';
}
