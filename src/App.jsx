// src/App.jsx
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

/* ========================================================================== */
/* Netlify Functions API                                                      */
/* ========================================================================== */
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
    try { data = JSON.parse(text); } catch { data = { message: text }; }
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

/* ========================================================================== */
/* Local Storage helpers                                                      */
/* ========================================================================== */
const LS = {
  getNum(k, def, min, max) {
    try {
      const n = Number(localStorage.getItem(k));
      if (Number.isFinite(n)) return clamp(n, min, max);
    } catch {}
    return def;
  },
  set(k, v) { try { localStorage.setItem(k, String(v)); } catch {} },

  setDisplay(payload) {
    try { localStorage.setItem('flo.display.payload', JSON.stringify(payload)); } catch {}
  },
  getDisplay() {
    try {
      const raw = localStorage.getItem('flo.display.payload');
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  },
};

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }

/* ========================================================================== */
/* WebAudio Beeper                                                            */
/* ========================================================================== */
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

/* ========================================================================== */
/* App                                                                        */
/* ========================================================================== */
export default function App() {
  /* ------------ Core State ------------ */
  const [players, setPlayers] = useState([]);
  const [loading, setLoading] = useState(true);

  const [round, setRound] = useState(0);
  const roundRef = useRef(0);

  const [matches, setMatches] = useState([]);
  const [benched, setBenched] = useState([]);

  const [running, setRunning] = useState(false);
  const [timerTotal, setTimerTotal] = useState(LS.getNum('flo.round.minutes', 12, 3, 60) * 60);
  const [warnSeconds, setWarnSeconds] = useState(LS.getNum('flo.warn.seconds', 30, 5, 120));
  const [timerLeft, setTimerLeft] = useState(timerTotal);

  const [volume, setVolume] = useState(LS.getNum('flo.volume', 0.3, 0, 1));
  const volumeRef = useRef(volume);
  useEffect(() => { volumeRef.current = volume; }, [volume]);

  const [matchMode, setMatchModeState] = useState(getMatchMode());

  // UI panels
  const [showSettings, setShowSettings] = useState(false);
  const [showRundown, setShowRundown] = useState(false);
  const [isDisplay, setIsDisplay] = useState(getInitialUiIsDisplay());

  // Admin
  const [adminKey, setAdminKey] = useState(sessionStorage.getItem('adminKey') || '');
  const isAdmin = !!adminKey;

  // Diagnostics/Summary caches
  const [diag, setDiag] = useState({
    roundBuildTimes: [],
    usedCourts: [],
    teamImbalances: [],
    spanPerMatch: [],
    outOfBandCounts: [],
  });
  const [rundown, setRundown] = useState({ rounds: 0, plays: {}, benches: {}, history: [] });

  // Fairness helpers
  const lastRoundBenched = useRef(new Set());
  const teammateHistory = useRef(new Map());

  const tickRef = useRef(null);
  const lastDisplayTs = useRef(0);
  const { beep } = useBeep(volumeRef);

  /* ------------ Load roster ------------ */
  useEffect(() => {
    if (isDisplay) return; // display reads from localStorage feed
    (async () => {
      try {
        const data = await APIClient.listPlayers();
        setPlayers(data);
      } catch (e) {
        console.error(e);
        alert(e.message || String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [isDisplay]);

  /* ------------ Derived lists ------------ */
  const present = useMemo(() => players.filter(p => p.is_present), [players]);
  const notPresent = useMemo(() => players.filter(p => !p.is_present), [players]);

  /* ------------ Display sync ------------ */
  const pushDisplay = (override = {}) => {
    const payload = {
      kind: 'flo-display-v1',
      ts: Date.now(),
      round,
      running,
      timeLeft: timerLeft,
      timerTotal,
      warnSeconds,
      presentCount: present.length,
      matches: matches.map(m => ({
        court: m.court,
        avg1: m.avg1,
        avg2: m.avg2,
        team1: m.team1.map(p => ({ id: p.id, name: p.name, gender: p.gender, skill_level: p.skill_level })),
        team2: m.team2.map(p => ({ id: p.id, name: p.name, gender: p.gender, skill_level: p.skill_level })),
      })),
      ...override,
    };
    LS.setDisplay(payload);
  };

  useEffect(() => {
    if (!isDisplay) return;
    const apply = (payload) => {
      if (!payload || payload.kind !== 'flo-display-v1') return;
      if (payload.ts && payload.ts <= lastDisplayTs.current) return;
      lastDisplayTs.current = payload.ts || Date.now();

      setRound(Number(payload.round || 0));
      setRunning(!!payload.running);
      setTimerLeft(Number(payload.timeLeft || 0));
      setTimerTotal(Number(payload.timerTotal || (12 * 60)));
      setWarnSeconds(Number(payload.warnSeconds || 30));

      if (Array.isArray(payload.matches)) {
        const active = !!payload.running || (payload.round || 0) > 0;
        if (active && payload.matches.length === 0) {
          // ignore empty replacement mid-round to avoid flicker
        } else {
          setMatches(
            payload.matches.map(m => ({
              court: m.court,
              avg1: m.avg1,
              avg2: m.avg2,
              team1: m.team1 || [],
              team2: m.team2 || [],
            }))
          );
        }
      }
    };

    // initial snapshot + listeners
    apply(LS.getDisplay());
    const onStorage = (e) => {
      if (e.key === 'flo.display.payload' && e.newValue) {
        try { apply(JSON.parse(e.newValue)); } catch {}
      }
    };
    window.addEventListener('storage', onStorage);
    const poll = setInterval(() => apply(LS.getDisplay()), 800);

    return () => {
      window.removeEventListener('storage', onStorage);
      clearInterval(poll);
    };
  }, [isDisplay]);

  /* ------------ Mode toggle ------------ */
  function toggleMode() {
    const next = matchMode === MATCH_MODES.WINDOW ? MATCH_MODES.BAND : MATCH_MODES.WINDOW;
    setMatchModeState(next);
    setMatchMode(next);
    if (!isDisplay && round > 0) buildNextRound(roundRef.current); // rebuild with new mode
  }

  /* ------------ Presence toggle ------------ */
  async function togglePresent(p) {
    const nv = !p.is_present;
    setPlayers(prev => prev.map(x => x.id === p.id ? { ...x, is_present: nv } : x));
    try {
      await APIClient.patch([{ id: p.id, is_present: nv }]);
    } catch (e) {
      console.error(e);
      alert('Failed to save presence toggle');
    }
  }

  /* ------------ Timer ------------ */
  function startTimer() {
    if (tickRef.current) return;
    setRunning(true);
    tickRef.current = setInterval(() => {
      setTimerLeft(prev => {
        const next = prev - 1;
        pushDisplay({ timeLeft: next, running: true });
        if (next === warnSeconds) beep(1200, 350);
        if (next <= 0) {
          clearInterval(tickRef.current);
          tickRef.current = null;
          setRunning(false);
          beep(500, 700);
          // advance & restart
          setTimeout(async () => {
            await nextRoundInternal();
            setTimerLeft(timerTotal);
            startTimer();
          }, 350);
          return 0;
        }
        return next;
      });
    }, 1000);
  }
  function stopTimer() {
    setRunning(false);
    if (tickRef.current) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
    pushDisplay({ running: false });
  }

  /* ------------ Round build + persistence ------------ */
  async function buildNextRound(nextRound) {
    if (present.length < 4) {
      alert('Not enough players present.');
      return;
    }
    const t0 = performance.now();

    const { playing, benched } = selectPlayersForRound(
      present, nextRound, lastRoundBenched.current, 4
    );
    lastRoundBenched.current = new Set(benched.map(b => b.id));
    setBenched(benched);

    const ms = buildMatchesFrom16(playing, teammateHistory.current, 4);
    setMatches(ms);

    // Diagnostics snapshot
    const diagSnap = computeDiagnostics(ms);
    const t1 = performance.now();
    const buildMs = Math.max(0, t1 - t0);
    setDiag(prev => ({
      roundBuildTimes: [...prev.roundBuildTimes, Math.round(buildMs)],
      usedCourts: [...prev.usedCourts, ms.length],
      teamImbalances: [...prev.teamImbalances, Number(diagSnap.avgImbalance.toFixed(3))],
      spanPerMatch: [...prev.spanPerMatch, Number(diagSnap.avgSpan.toFixed(3))],
      outOfBandCounts: [...prev.outOfBandCounts, diagSnap.outOfBand],
    }));

    // Summary bookkeeping
    setRundown(prev => {
      const plays = { ...prev.plays };
      const benches = { ...prev.benches };
      for (const m of ms) {
        for (const p of m.team1) plays[p.id] = (plays[p.id] || 0) + 1;
        for (const p of m.team2) plays[p.id] = (plays[p.id] || 0) + 1;
      }
      for (const b of benched) benches[b.id] = (benches[b.id] || 0) + 1;
      const history = [
        ...prev.history,
        {
          round: nextRound,
          matches: ms.map(m => ({
            court: m.court,
            team1: m.team1.map(x => x.id),
            team2: m.team2.map(x => x.id),
          })),
        },
      ];
      return { rounds: nextRound, plays, benches, history };
    });

    // Push to display
    pushDisplay({ round: nextRound, matches: ms, presentCount: present.length });
  }

  async function saveRoundUpdatesFor(roundNum) {
    // derive playing/benched IDs from current state
    const playingIds = new Set();
    for (const m of matches) {
      for (const p of m.team1) playingIds.add(p.id);
      for (const p of m.team2) playingIds.add(p.id);
    }
    const benchIds = new Set(benched.map(b => b.id));

    const updates = [];
    for (const id of playingIds) updates.push({ id, last_played_round: roundNum });
    for (const id of benchIds) {
      const pl = players.find(p => p.id === id);
      updates.push({ id, bench_count: (pl?.bench_count || 0) + 1 });
    }
    if (!updates.length) return;

    await APIClient.patch(updates);
    // local mirror
    setPlayers(prev => prev.map(p => {
      if (playingIds.has(p.id)) return { ...p, last_played_round: roundNum };
      if (benchIds.has(p.id)) return { ...p, bench_count: (p.bench_count || 0) + 1 };
      return p;
    }));
  }

  async function nextRoundInternal() {
    // persist last round
    if (roundRef.current > 0) {
      try { await saveRoundUpdatesFor(roundRef.current); }
      catch (e) { console.error(e); alert('Failed to save round updates'); }
    }
    // increment and build
    const next = (roundRef.current || 0) + 1;
    setRound(next);
    roundRef.current = next;
    await buildNextRound(next);
  }

  /* ------------ Toolbar actions ------------ */
  function onStartNight() {
    stopTimer();
    setRound(1);
    roundRef.current = 1;
    setTimerLeft(timerTotal);
    setMatches([]);
    setBenched([]);
    lastRoundBenched.current = new Set();
    teammateHistory.current = new Map();
    setRundown({ rounds: 0, plays: {}, benches: {}, history: [] });
    setDiag({ roundBuildTimes: [], usedCourts: [], teamImbalances: [], spanPerMatch: [], outOfBandCounts: [] });
    buildNextRound(1);
    pushDisplay({ round: 1, running: false, timeLeft: timerLeft, matches: [] });
  }
  function onPause() { stopTimer(); }
  function onResume() {
    if (round === 0) { onStartNight(); }
    if (matches.length === 0) { buildNextRound(roundRef.current || 1); }
    startTimer();
  }
  async function onNextRound() {
    stopTimer();
    await nextRoundInternal();
    setTimerLeft(timerTotal);
  }
  function onEndNight() {
    stopTimer();
    setShowRundown(true);
  }
  function closeRundown() {
    // hard reset session
    setShowRundown(false);
    setRound(0);
    roundRef.current = 0;
    setMatches([]);
    setBenched([]);
    lastRoundBenched.current = new Set();
    teammateHistory.current = new Map();
    pushDisplay({ round: 0, matches: [], running: false, timeLeft: 0 });
  }

  /* ------------ Admin Mode ------------ */
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

  /* ------------ Settings ------------ */
  function openSettings() { setShowSettings(true); }
  function saveSettings(mins, warn, vol) {
    LS.set('flo.round.minutes', mins);
    LS.set('flo.warn.seconds', warn);
    LS.set('flo.volume', vol);
    setTimerTotal(mins * 60);
    setTimerLeft(mins * 60);
    setWarnSeconds(warn);
    setVolume(vol);
    setShowSettings(false);
    pushDisplay({ timerTotal: mins * 60, warnSeconds: warn, timeLeft: mins * 60 });
  }

  /* ------------ Display window ------------ */
  function openDisplay() {
    pushDisplay(); // send latest
    const url = new URL(window.location.href);
    url.searchParams.set('display', '1');
    window.open(url.toString(), '_blank', 'noopener,noreferrer');
  }

  /* ------------ Diagnostics helpers ------------ */
  function computeDiagnostics(roundMatches) {
    const used = roundMatches.length;
    const imbalances = roundMatches.map(m => Math.abs((m.avg1 || 0) - (m.avg2 || 0)));
    const avgImbalance = imbalances.length ? imbalances.reduce((a,b) => a + b, 0) / imbalances.length : 0;
    const spans = roundMatches.map(m => {
      const all = [...m.team1, ...m.team2].map(p => Number(p.skill_level || 0));
      if (all.length < 1) return 0;
      return Math.max(...all) - Math.min(...all);
    });
    const avgSpan = spans.length ? spans.reduce((a,b) => a + b, 0) / spans.length : 0;

    // helper: count players outside ±2 from median of the 4
    const outOfBand = roundMatches.reduce((acc, m) => {
      const skills = [...m.team1, ...m.team2].map(p => Number(p.skill_level || 0)).sort((a,b)=>a-b);
      if (skills.length < 4) return acc;
      const mid = (skills[1] + skills[2]) / 2;
      const c = skills.filter(s => Math.abs(s - mid) > 2).length;
      return acc + c;
    }, 0);

    return { used, avgImbalance, avgSpan, outOfBand };
  }

  /* ------------ Rendering helpers ------------ */
  const isWarn = running && timerLeft <= warnSeconds;

  function Court({ m, large = false }) {
    const Tag = (pl) => (
      <div className={`tag ${large ? 'lg' : ''}`} key={pl.id}>
        <span className={`pill sm ${pl.gender === 'F' ? 'female' : 'male'}`}>{pl.gender}</span>
        {pl.name} <span className="muted">(L{pl.skill_level})</span>
      </div>
    );
    return (
      <div className={`court glass ${large ? 'lg' : ''}`}>
        <div className="court-head">
          <h3>Court {m.court}</h3>
          <div className="avg-pair">
            <span className="avg">Team 1 Avg: <b>{m.avg1?.toFixed ? m.avg1.toFixed(1) : m.avg1}</b></span>
            <span className="avg">Team 2 Avg: <b>{m.avg2?.toFixed ? m.avg2.toFixed(1) : m.avg2}</b></span>
          </div>
        </div>
        <div className="team">{m.team1.map(Tag)}</div>
        <div className="net"></div>
        <div className="team">{m.team2.map(Tag)}</div>
      </div>
    );
  }

  function RowPlayer({ p, onDoubleClick }) {
    return (
      <div
        className={`row-player ${p.is_present ? 'present' : ''} ${p.gender === 'F' ? 'female' : 'male'}`}
        onDoubleClick={onDoubleClick}
        title="Double-click to toggle present"
      >
        <div className="name">{p.name}</div>
        <div className="meta">
          <span className="badge">Lvl {p.skill_level}</span>
          <span className="sub">Benched {p.bench_count}</span>
        </div>
      </div>
    );
  }

  /* ------------ Admin Panel ------------ */
  function AdminPanel() {
    const [drafts, setDrafts] = useState({});
    useEffect(() => {
      const m = {};
      for (const p of players) m[p.id] = { name: p.name, gender: p.gender, skill_level: p.skill_level };
      setDrafts(m);
    }, [players]);

    const onDraft = (id, field, value) => setDrafts(prev => ({ ...prev, [id]: { ...prev[id], [field]: value } }));

    async function addPlayer(e) {
      e.preventDefault();
      const form = e.target;
      const name = form.name.value.trim();
      const gender = form.gender.value;
      const lvl = clamp(Number(form.skill.value || 3), 1, 10);
      if (!name) return alert('Name required');
      try {
        await APIClient.upsert([{ name, gender, skill_level: lvl, is_present: false, bench_count: 0, last_played_round: 0 }], adminKey);
        form.reset();
        const data = await APIClient.listPlayers();
        setPlayers(data);
      } catch (e) {
        alert(e.message || String(e));
      }
    }
    async function saveRow(id) {
      const d = drafts[id];
      if (!d) return;
      try {
        await APIClient.patch([{ id, name: d.name, gender: d.gender, skill_level: clamp(Number(d.skill_level || 3), 1, 10) }], adminKey);
        const data = await APIClient.listPlayers();
        setPlayers(data);
      } catch (e) { alert(e.message || String(e)); }
    }
    async function deleteRow(id) {
      if (!confirm('Delete this player?')) return;
      try {
        await APIClient.remove([id], adminKey);
        const data = await APIClient.listPlayers();
        setPlayers(data);
      } catch (e) { alert(e.message || String(e)); }
    }

    return (
      <div className="panel glass">
        <div className="panel-head">
          <h3>Admin Controls</h3>
          {isAdmin ? (
            <button className="btn" onClick={adminLogout}>Exit Admin</button>
          ) : (
            <button className="btn" onClick={adminLogin}>Admin</button>
          )}
        </div>

        {isAdmin && (
          <>
            <form onSubmit={addPlayer} className="grid add-form">
              <input name="name" placeholder="Name" required className="input" />
              <select name="gender" defaultValue="M" className="input">
                <option value="M">M</option>
                <option value="F">F</option>
              </select>
              <input name="skill" type="number" min="1" max="10" defaultValue="3" className="input" />
              <button className="btn" type="submit">Add</button>
            </form>

            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Gender</th>
                    <th>Level</th>
                    <th>Present</th>
                    <th>Bench</th>
                    <th>Last Round</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {players.map(p => {
                    const d = drafts[p.id] || { name: p.name, gender: p.gender, skill_level: p.skill_level };
                    return (
                      <tr key={p.id}>
                        <td><input value={d.name} onChange={e => onDraft(p.id, 'name', e.target.value)} className="input" /></td>
                        <td>
                          <select value={d.gender} onChange={e => onDraft(p.id, 'gender', e.target.value)} className="input">
                            <option value="M">M</option>
                            <option value="F">F</option>
                          </select>
                        </td>
                        <td>
                          <input
                            type="number" min="1" max="10"
                            value={d.skill_level}
                            onChange={e => onDraft(p.id, 'skill_level', clamp(Number(e.target.value || 3), 1, 10))}
                            className="input"
                          />
                        </td>
                        <td className="center">{p.is_present ? 'Yes' : 'No'}</td>
                        <td className="center">{p.bench_count}</td>
                        <td className="center">{p.last_played_round}</td>
                        <td>
                          <div className="row-actions">
                            <button className="btn" onClick={() => saveRow(p.id)}>Save</button>
                            <button className="btn danger" onClick={() => deleteRow(p.id)}>Delete</button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    );
  }

  /* ------------ Settings Panel ------------ */
  function SettingsPanel() {
    const [mins, setMins] = useState(Math.round(timerTotal / 60));
    const [warn, setWarn] = useState(warnSeconds);
    const [vol, setVol] = useState(volume);
    const [modeLocal, setModeLocal] = useState(matchMode);

    return (
      <div className="modal-backdrop">
        <div className="modal glass">
          <h3>Settings</h3>
          <div className="settings-grid">
            <label className="setting">
              <span>Round length (minutes)</span>
              <input type="number" min="3" max="60" value={mins} onChange={e => setMins(clamp(Number(e.target.value||12),3,60))} className="input" />
            </label>
            <label className="setting">
              <span>Warning beep at (seconds left)</span>
              <input type="number" min="5" max="120" value={warn} onChange={e => setWarn(clamp(Number(e.target.value||30),5,120))} className="input" />
            </label>
            <label className="setting">
              <span>Volume (0–1)</span>
              <input type="number" step="0.05" min="0" max="1" value={vol} onChange={e => setVol(clamp(Number(e.target.value||0.3),0,1))} className="input" />
            </label>
            <div className="setting">
              <span>Matchmaking Mode</span>
              <div className="modes">
                <label className="radio">
                  <input type="radio" checked={modeLocal === MATCH_MODES.WINDOW} onChange={() => setModeLocal(MATCH_MODES.WINDOW)} />
                  Window (±2 start)
                </label>
                <label className="radio">
                  <input type="radio" checked={modeLocal === MATCH_MODES.BAND} onChange={() => setModeLocal(MATCH_MODES.BAND)} />
                  Band (1–2 / 3–4 / 5–6 / 7–10 / 9–10)
                </label>
              </div>
            </div>
          </div>

          <div className="right mt-16">
            <button className="btn" onClick={() => {
              saveSettings(mins, warn, vol);
              if (modeLocal !== matchMode) {
                setMatchModeState(modeLocal);
                setMatchMode(modeLocal);
                if (round > 0) buildNextRound(roundRef.current);
              }
            }}>Save</button>
            <button className="btn ghost" onClick={() => setShowSettings(false)}>Close</button>
          </div>
        </div>
      </div>
    );
  }

  /* ------------ Summary / Diagnostics ------------ */
  function buildSmartSummary() {
    const byId = Object.fromEntries(players.map(p => [p.id, p]));
    const rounds = rundown.rounds;
    const hist = rundown.history || [];

    const playRoundsMap = new Map();
    const teamSets = new Map();
    const oppSets = new Map();

    let maxCourtsLocal = 0;
    const usedCourtsPerRoundLocal = [];

    for (const entry of hist) {
      const r = entry.round;
      const used = entry.matches.length;
      usedCourtsPerRoundLocal.push(used);
      maxCourtsLocal = Math.max(maxCourtsLocal, used);

      for (const m of entry.matches) {
        const t1 = m.team1;
        const t2 = m.team2;

        for (const id of [...t1, ...t2]) {
          if (!playRoundsMap.has(id)) playRoundsMap.set(id, []);
          playRoundsMap.get(id).push(r);
        }

        for (const a of t1) {
          if (!teamSets.has(a)) teamSets.set(a, new Set());
          if (!oppSets.has(a)) oppSets.set(a, new Set());
          for (const b of t1) if (b !== a) teamSets.get(a).add(b);
          for (const b of t2) oppSets.get(a).add(b);
        }
        for (const a of t2) {
          if (!teamSets.has(a)) teamSets.set(a, new Set());
          if (!oppSets.has(a)) oppSets.set(a, new Set());
          for (const b of t2) if (b !== a) teamSets.get(a).add(b);
          for (const b of t1) oppSets.get(a).add(b);
        }
      }
    }

    const participants = Array.from(
      new Set([].concat(...hist.flatMap(h => h.matches.flatMap(m => [...m.team1, ...m.team2]))))
    ).map(id => byId[id]).filter(Boolean);

    const per = participants.map(p => {
      const roundsPlayed = (playRoundsMap.get(p.id) || []).sort((a,b)=>a-b);
      const played = roundsPlayed.length;
      const benched = rundown.benches[p.id] || 0;

      // avg bench gap
      const gaps = [];
      for (let i = 1; i < roundsPlayed.length; i++) {
        const gap = roundsPlayed[i] - roundsPlayed[i-1] - 1;
        if (gap >= 0) gaps.push(gap);
      }
      const avgBenchGap = gaps.length ? gaps.reduce((a,b)=>a+b,0)/gaps.length : played ? 0 : 0;

      // worst bench streak
      let worstStreak = 0, cur = 0;
      const playSet = new Set(roundsPlayed);
      for (let r = 1; r <= rounds; r++) {
        if (playSet.has(r)) cur = 0; else { cur++; worstStreak = Math.max(worstStreak, cur); }
      }

      const teammates = teamSets.get(p.id)?.size || 0;
      const opponents = oppSets.get(p.id)?.size || 0;

      return {
        id: p.id, name: p.name, level: p.skill_level, gender: p.gender,
        played, benched, avgBenchGap, worstBenchStreak: worstStreak,
        teammates, opponents,
      };
    });

    const plays = per.map(x => x.played);
    const meanPlays = plays.length ? plays.reduce((a,b)=>a+b,0)/plays.length : 0;
    const stdDev = plays.length ? Math.sqrt(plays.reduce((a,b)=>a+(b-meanPlays)**2,0)/plays.length) : 0;
    const spread = plays.length ? Math.max(...plays) - Math.min(...plays) : 0;
    const fairnessRatio = plays.length ? (Math.min(...plays)/Math.max(...plays||[1])) : 0;

    const maxCourts = Math.max(1, ...diag.usedCourts, 4);
    const avgUsed = diag.usedCourts.length ? diag.usedCourts.reduce((a,b)=>a+b,0)/diag.usedCourts.length : 0;
    const utilization = maxCourts ? avgUsed/maxCourts : 0;

    // bands coverage
    const band = (lvl) => (lvl <= 3 ? '1-3' : lvl <= 6 ? '4-6' : '7-10');
    const byBand = { '1-3': 0, '4-6': 0, '7-10': 0 };
    for (const p of participants) byBand[band(p.skill_level)]++;

    // CSV rows
    const csvRows = [
      ['Name','Level','Played','Benched','AvgBenchGap','WorstBenchStreak','UniqueTeammates','UniqueOpponents'],
      ...per
        .sort((a,b)=> b.played - a.played || a.name.localeCompare(b.name))
        .map(x => [x.name, x.level, x.played, x.benched, x.avgBenchGap.toFixed(2), x.worstBenchStreak, x.teammates, x.opponents]),
    ];

    const playsHist = {};
    for (const v of plays) playsHist[v] = (playsHist[v] || 0) + 1;
    const playsHistText = Object.keys(playsHist).sort((a,b)=>Number(a)-Number(b)).map(k => `${k}:${playsHist[k]}`).join('  ');

    const copyText =
      `Session Summary\n` +
      `Rounds: ${rundown.rounds}\n` +
      `Participants: ${participants.length}\n` +
      `Courts (avg used): ${avgUsed.toFixed(2)} / ${maxCourts} (${(utilization*100).toFixed(1)}%)\n` +
      `Skill coverage: 1-3 ${(byBand['1-3']/Math.max(participants.length,1)*100).toFixed(1)}% • 4-6 ${(byBand['4-6']/Math.max(participants.length,1)*100).toFixed(1)}% • 7-10 ${(byBand['7-10']/Math.max(participants.length,1)*100).toFixed(1)}%\n\n` +
      `Fairness\n` +
      `Mean plays: ${meanPlays.toFixed(2)}   StdDev: ${stdDev.toFixed(2)}   Spread: ${spread}   Fairness ratio: ${fairnessRatio.toFixed(2)}\n` +
      `Avg bench gap: ${per.length ? (per.map(x=>x.avgBenchGap).reduce((a,b)=>a+b,0)/per.length).toFixed(2) : '0.00'} rounds\n` +
      `Worst bench streak (overall): ${per.length ? Math.max(...per.map(x=>x.worstBenchStreak)) : 0}\n\n` +
      `Plays histogram: ${playsHistText}\n`;

    return {
      per, csvRows, copyText,
      rounds: rundown.rounds, participantsCount: participants.length,
      males: participants.filter(p=>p.gender==='M').length,
      females: participants.filter(p=>p.gender==='F').length,
      maxCourts, avgUsed, utilization,
      meanPlays, stdDev, spread, fairnessRatio,
      bands: byBand,
    };
  }

  function downloadCSV(rows, filename = 'session-summary.csv') {
    const csv = rows.map(r =>
      r.map(v => {
        const s = String(v ?? '');
        return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
      }).join(',')
    ).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      alert('Summary copied to clipboard');
    } catch { alert('Copy failed'); }
  }

  function RundownModal() {
    const S = buildSmartSummary();
    const [tab, setTab] = useState('summary');

    return (
      <div className="modal-backdrop">
        <div className="modal glass">
          <div className="tabs">
            <button className={`tab ${tab==='summary'?'active':''}`} onClick={()=>setTab('summary')}>Smart Session Summary</button>
            <button className={`tab ${tab==='diagnostics'?'active':''}`} onClick={()=>setTab('diagnostics')}>System Diagnostics</button>
          </div>

          {tab === 'summary' && (
            <>
              <div className="two-col">
                <div>
                  <h4>Overview</h4>
                  <div>Rounds: <b>{S.rounds}</b></div>
                  <div>Participants: <b>{S.participantsCount}</b> (M {S.males} • F {S.females})</div>
                  <div>Courts (avg used): <b>{S.avgUsed.toFixed(2)}</b> / {S.maxCourts} ({(S.utilization*100).toFixed(1)}%)</div>
                  <div>Skill coverage: 1-3 <b>{((S.bands['1-3']/Math.max(S.participantsCount,1))*100).toFixed(1)}%</b> • 4-6 <b>{((S.bands['4-6']/Math.max(S.participantsCount,1))*100).toFixed(1)}%</b> • 7-10 <b>{((S.bands['7-10']/Math.max(S.participantsCount,1))*100).toFixed(1)}%</b></div>
                </div>
                <div>
                  <h4>Fairness</h4>
                  <div>Mean plays: <b>{S.meanPlays.toFixed(2)}</b> &nbsp; StdDev: <b>{S.stdDev.toFixed(2)}</b> &nbsp; Spread: <b>{S.spread}</b> &nbsp; Fairness ratio: <b>{S.fairnessRatio.toFixed(2)}</b></div>
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
                      .sort((a,b)=> b.played - a.played || a.name.localeCompare(b.name))
                      .map(x => (
                        <tr key={x.id}>
                          <td>{x.name}</td>
                          <td className="center">{x.level}</td>
                          <td className="center"><b>{x.played}</b></td>
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
                <button className="btn" onClick={() => downloadCSV(S.csvRows)}>Export CSV</button>
                <button className="btn" onClick={() => copyToClipboard(S.copyText)}>Copy Summary</button>
                <button className="btn" onClick={closeRundown}>Close</button>
              </div>
            </>
          )}

          {tab === 'diagnostics' && (
            <>
              <div className="two-col">
                <div>
                  <h4>Round Build Performance</h4>
                  <div>Build times (ms): {(diag.roundBuildTimes || []).join(', ') || '-'}</div>
                  <div>
                    Avg build time:{' '}
                    <b>
                      {(
                        ((diag.roundBuildTimes || []).reduce((a,b)=>a+b,0) / Math.max(1,(diag.roundBuildTimes||[]).length))
                      ).toFixed(1)}
                    </b>{' '}ms
                  </div>
                  <div>Courts used per round: {(diag.usedCourts || []).join(', ') || '-'}</div>
                </div>
                <div>
                  <h4>Match Quality</h4>
                  <div>Avg team imbalance per round: {(diag.teamImbalances || []).join(', ') || '-'}</div>
                  <div>Avg skill span per match (round avg): {(diag.spanPerMatch || []).join(', ') || '-'}</div>
                  <div>Out-of-band players / round (+/-2 from median): {(diag.outOfBandCounts || []).join(', ') || '-'}</div>
                </div>
              </div>

              <div className="right mt-12">
                <button className="btn" onClick={closeRundown}>Close</button>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  /* ------------ Display View ------------ */
  function DisplayView() {
    return (
      <div className="display page">
        <div className="display-head">
          <div className="display-title">Badminton Club Night</div>
          <div className="display-meta">
            <span>Round {round || '-'}</span>
            <span>•</span>
            <span className={`bigtime ${isWarn ? 'warn' : ''}`}>{formatTime(timerLeft)}</span>
            <span>•</span>
            <span>{present.length} present</span>
            <span>•</span>
            <span>Mode: {matchMode === MATCH_MODES.BAND ? 'Band' : 'Window'}</span>
          </div>
          <div className="display-hint">Press F for fullscreen</div>
        </div>

        <div className="display-courts">
          {matches.length === 0 ? (
            <div className="muted p-20">Waiting for matches…</div>
          ) : (
            matches.map(m => <Court key={m.court} m={m} large />)
          )}
        </div>
      </div>
    );
  }

  /* ------------ Render ------------ */
  if (isDisplay) {
    useEffect(() => {
      const onKey = (e) => {
        if (e.key === 'f' || e.key === 'F') {
          const el = document.documentElement;
          if (!document.fullscreenElement) el.requestFullscreen?.(); else document.exitFullscreen?.();
        }
      };
      window.addEventListener('keydown', onKey);
      return () => window.removeEventListener('keydown', onKey);
    }, []);
    return <DisplayView />;
  }

  return (
    <div className="page">
      {/* Toolbar */}
      <div className="toolbar glass">
        <div className="toolbar-left">
          <button className="btn primary" onClick={onStartNight}>Start Night</button>
          <button className="btn" onClick={onPause} disabled={!running}>Pause</button>
          <button className="btn" onClick={onResume}>Resume</button>
          <button className="btn" onClick={onNextRound}>Next Round</button>
          <button className="btn danger" onClick={onEndNight}>End Night</button>
          <button className="btn" onClick={openDisplay}>Open Display</button>
          <button className="btn" onClick={toggleMode}>Mode: {matchMode === MATCH_MODES.BAND ? 'Band' : 'Window'}</button>
          <button className="btn ghost" onClick={openSettings}>Settings</button>
          {isAdmin ? (
            <button className="btn" onClick={adminLogout}>Admin (On)</button>
          ) : (
            <button className="btn" onClick={adminLogin}>Admin</button>
          )}
        </div>
        <div className={`toolbar-right time ${isWarn ? 'warn' : ''}`}>
          {round > 0 ? `Round ${round} • ${formatTime(timerLeft)}` : 'Not running'}
        </div>
      </div>

      {/* Courts */}
      <div id="courts" className="courts-grid">
        {matches.map(m => <Court key={m.court} m={m} />)}
        {matches.length === 0 && <div className="muted p-12">No matches yet. Click <b>Resume</b> to build.</div>}
      </div>

      {/* Benched strip */}
      <div className="panel glass">
        <div className="panel-head"><h3>Benched Players</h3></div>
        {benched.length === 0 ? (
          <div className="muted p-8">No one benched this round.</div>
        ) : (
          <div className="bench-row">
            {benched.map(p => (
              <div className="tag" key={p.id} title={`Lvl ${p.skill_level}`}>
                <span className={`pill sm ${p.gender === 'F' ? 'female' : 'male'}`}>{p.gender}</span>
                {p.name}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Rosters */}
      <div className="lists-grid">
        <div className="list-col">
          <div className="list-head">
            All Players <span className="badge">{notPresent.length}</span>
          </div>
          <div id="allList" className="list-box glass">
            {notPresent.map(p => <RowPlayer key={p.id} p={p} onDoubleClick={() => togglePresent(p)} />)}
          </div>
        </div>
        <div className="list-col">
          <div className="list-head">
            Present Today <span className="badge">{present.length}</span>
          </div>
          <div id="presentList" className="list-box glass">
            {present.map(p => <RowPlayer key={p.id} p={p} onDoubleClick={() => togglePresent(p)} />)}
          </div>
        </div>
      </div>

      {/* Admin controls */}
      <AdminPanel />

      {/* Settings / Summary */}
      {showSettings && <SettingsPanel />}
      {showRundown && <RundownModal />}
    </div>
  );
}

/* ========================================================================== */
/* Utilities                                                                  */
/* ========================================================================== */
function getInitialUiIsDisplay() {
  const url = new URL(window.location.href);
  return url.searchParams.get('display') === '1';
}
