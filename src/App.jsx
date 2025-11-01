import React, { useEffect, useMemo, useRef, useState } from 'react';
import { formatTime, selectPlayersForRound, buildMatchesFrom16 } from './logic';
import './App.css';

/* ============================================================================
   Local storage helpers
============================================================================ */
const LS = {
  getRound() {
    return clampInt(localStorage.getItem('flo.roundMinutes'), 12, 3, 40);
  },
  setRound(v) {
    localStorage.setItem('flo.roundMinutes', String(v));
  },
  getWarn() {
    return clampInt(localStorage.getItem('flo.warnSeconds'), 30, 5, 120);
  },
  setWarn(v) {
    localStorage.setItem('flo.warnSeconds', String(v));
  },
  getVol() {
    return clampFloat(localStorage.getItem('flo.volume'), 0.3, 0, 1);
  },
  setVol(v) {
    localStorage.setItem('flo.volume', String(v));
  },

  setDisplay(payload) {
    localStorage.setItem('flo.display.payload', JSON.stringify(payload));
  },
  getDisplay() {
    try {
      return JSON.parse(localStorage.getItem('flo.display.payload') || 'null');
    } catch {
      return null;
    }
  },
};

function clampInt(raw, def, min, max) {
  const n = parseInt(raw ?? '', 10);
  if (Number.isFinite(n)) return Math.max(min, Math.min(max, n));
  return def;
}
function clampFloat(raw, def, min, max) {
  const n = parseFloat(raw ?? '');
  if (Number.isFinite(n)) return Math.max(min, Math.min(max, n));
  return def;
}
const fmtPct = (x) => (isFinite(x) ? (x * 100).toFixed(1) + '%' : '-');

/* ============================================================================
   WebAudio Beeper
============================================================================ */
function useBeep(volumeRef) {
  const ctxRef = useRef(null);
  const ensure = () => {
    if (!ctxRef.current) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      ctxRef.current = new Ctor();
    }
    return ctxRef.current;
  };
  const beep = (freq = 800, ms = 250) => {
    const vol = Math.max(0, Math.min(1, volumeRef.current ?? 0.3));
    const ctx = ensure();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(vol, ctx.currentTime);
    osc.start();
    osc.stop(ctx.currentTime + ms / 1000);
  };
  return { beep };
}

/* ============================================================================
   Netlify Functions API
============================================================================ */
const API = {
  async listPlayers() {
    const res = await fetch('/.netlify/functions/players', { method: 'GET' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Failed to load players');
    return data;
  },
  async patch(updates, adminKey) {
    const res = await fetch('/.netlify/functions/players', {
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
    if (!res.ok) throw new Error(data.message || 'Failed to save updates');
    return data;
  },
  async upsert(players, adminKey) {
    const res = await fetch('/.netlify/functions/players', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Key': adminKey || '',
      },
      body: JSON.stringify({ players }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Failed to upsert players');
    return data;
  },
  async remove(ids, adminKey) {
    const res = await fetch('/.netlify/functions/players', {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Key': adminKey || '',
      },
      body: JSON.stringify({ ids }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Failed to delete players');
    return data;
  },
};

/* Batch public save (avoids CORS preflight pain for big payloads) */
async function saveUpdatesPublic(updates) {
  if (!updates?.length) return { ok: true };
  const BATCH = 25;
  for (let i = 0; i < updates.length; i += BATCH) {
    const part = updates.slice(i, i + BATCH);
    const res = await fetch('/.netlify/functions/players', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updates: part }),
    });
    const text = await res.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { message: text };
    }
    if (!res.ok) throw new Error(payload.message || `PATCH failed (${res.status})`);
    if (payload.ok === false && payload.errors?.length) {
      console.warn('Partial update errors:', payload.errors);
      alert('Some rows failed to save (see Functions logs).');
    }
  }
  return { ok: true };
}

/* ============================================================================
   App
============================================================================ */
export default function App() {
  // Modes: home | session | display
  const [ui, setUi] = useState(getInitialUi());
  const isDisplay = ui === 'display';

  // Data
  const [players, setPlayers] = useState([]);
  const [loading, setLoading] = useState(!isDisplay);

  // Session state
  const [matches, setMatches] = useState([]);
  const [round, setRound] = useState(0);
  const [timeLeft, setTimeLeft] = useState(LS.getRound() * 60);
  const [running, setRunning] = useState(false);

  // Settings
  const [roundMinutes, setRoundMinutes] = useState(LS.getRound());
  const [warnSeconds, setWarnSeconds] = useState(LS.getWarn());
  const [volume, setVolume] = useState(LS.getVol());
  const [showSettings, setShowSettings] = useState(false);

  // Admin mode
  const [adminKey, setAdminKey] = useState(sessionStorage.getItem('adminKey') || '');
  const isAdmin = !!adminKey;

  // Summary & Diagnostics
  const [showRundown, setShowRundown] = useState(false);
  const [rundown, setRundown] = useState({ rounds: 0, plays: {}, benches: {}, history: [] });
  const [diag, setDiag] = useState({
    roundBuildTimes: [],
    usedCourts: [],
    teamImbalances: [],
    spanPerMatch: [],
    outOfBandCounts: [],
  });

  // Refs
  const timerRef = useRef(null);
  const volumeRef = useRef(volume);
  useEffect(() => {
    volumeRef.current = volume;
  }, [volume]);

  const lastRoundBenched = useRef(new Set()); // fairness tie-breaker
  const teammateHistory = useRef(new Map());  // reduce teammate repeats

  const { beep } = useBeep(volumeRef);

  /* ============================================================================
     DISPLAY sync across windows (controller writes, display reads)
  ============================================================================ */
  const lastTsRef = useRef(0);
  const [displaySeen, setDisplaySeen] = useState(false);
  const [displayPresentCount, setDisplayPresentCount] = useState(0);

  const pushDisplay = (override) => {
    const payload = {
      kind: 'flo-display-v1',
      ts: Date.now(),
      round,
      running,
      timeLeft,
      roundMinutes,
      presentCount: players.filter((p) => p.is_present).length,
      matches: matches.map((m) => ({
        court: m.court,
        avg1: m.avg1,
        avg2: m.avg2,
        team1: m.team1.map((p) => ({ id: p.id, name: p.name, gender: p.gender, skill_level: p.skill_level })),
        team2: m.team2.map((p) => ({ id: p.id, name: p.name, gender: p.gender, skill_level: p.skill_level })),
      })),
      ...override,
    };
    LS.setDisplay(payload);
  };

  useEffect(() => {
    if (!isDisplay) return;

    const apply = (payload) => {
      if (!payload || payload.kind !== 'flo-display-v1') return;
      if (payload.ts && payload.ts <= lastTsRef.current) return;
      lastTsRef.current = payload.ts || Date.now();

      setDisplaySeen(true);
      setRound(Number(payload.round || 0));
      setRunning(!!payload.running);
      setTimeLeft(Number(payload.timeLeft || 0));
      setDisplayPresentCount(Number(payload.presentCount || 0));

      if (Array.isArray(payload.matches)) {
        const incoming = payload.matches;
        const active = !!payload.running || (payload.round || 0) > 0;
        if (active && incoming.length === 0) {
          // ignore clear while active
        } else {
          setMatches(
            incoming.map((m) => ({
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

    apply(LS.getDisplay());

    const onStorage = (e) => {
      if (e.key === 'flo.display.payload') {
        try {
          apply(JSON.parse(e.newValue));
        } catch {}
      }
    };
    window.addEventListener('storage', onStorage);

    const poll = setInterval(() => {
      const snap = LS.getDisplay();
      if (snap) apply(snap);
    }, 800);

    return () => {
      window.removeEventListener('storage', onStorage);
      clearInterval(poll);
    };
  }, [isDisplay]);

  /* ============================================================================
     Load players (only on controller)
  ============================================================================ */
  useEffect(() => {
    if (isDisplay) return;
    (async () => {
      try {
        const data = await API.listPlayers();
        const safe = (data || []).map((p) => ({
          id: p.id,
          name: p.name,
          gender: p.gender || 'M',
          skill_level: Number(p.skill_level || 1),
          is_present: !!p.is_present,
          bench_count: Number(p.bench_count || 0),
          last_played_round: Number(p.last_played_round || 0),
        }));
        setPlayers(safe);
      } catch (e) {
        console.error(e);
        alert(e.message || String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, [isDisplay]);

  /* ============================================================================
     Derived lists
  ============================================================================ */
  const present = useMemo(() => players.filter((p) => p.is_present), [players]);
  const notPresent = useMemo(() => players.filter((p) => !p.is_present), [players]);

  /* ============================================================================
     Toggle presence
  ============================================================================ */
  const togglePresence = async (p) => {
    const newVal = !p.is_present;
    try {
      await API.patch([{ id: p.id, is_present: newVal }]);
      setPlayers((prev) => prev.map((x) => (x.id === p.id ? { ...x, is_present: newVal } : x)));
    } catch (e) {
      console.error(e);
      alert(e.message || String(e));
    }
  };

  /* ============================================================================
     Diagnostics computation for each round
  ============================================================================ */
  const computeRoundDiagnostics = (roundMatches) => {
    const used = roundMatches.length;
    const imbalances = roundMatches.map((m) => Math.abs((m.avg1 || 0) - (m.avg2 || 0)));
    const avgImbalance = imbalances.length ? imbalances.reduce((a, b) => a + b, 0) / imbalances.length : 0;
    const spans = roundMatches.map((m) => {
      const skills = [...m.team1, ...m.team2].map((p) => Number(p.skill_level || 0));
      if (!skills.length) return 0;
      return Math.max(...skills) - Math.min(...skills);
    });
    const avgSpan = spans.length ? spans.reduce((a, b) => a + b, 0) / spans.length : 0;
    const outOfBand = roundMatches.reduce((acc, m) => {
      const all = [...m.team1, ...m.team2].map((p) => Number(p.skill_level || 0)).sort((a, b) => a - b);
      if (all.length < 4) return acc;
      const mid = (all[1] + all[2]) / 2;
      const count = all.filter((v) => Math.abs(v - mid) > 2).length;
      return acc + count;
    }, 0);
    return { used, avgImbalance, avgSpan, outOfBand };
  };

  /* ============================================================================
     Build next round (selection + matchmaking + persistence + summary)
  ============================================================================ */
  const buildNextRound = async () => {
    if (present.length < 4) {
      alert('Not enough players present.');
      return;
    }

    const roundNumber = round + 1;
    const t0 = performance.now();

    const { playing, benched } = selectPlayersForRound(present, roundNumber, lastRoundBenched.current);
    lastRoundBenched.current = new Set(benched.map((b) => b.id));

    const newMatches = buildMatchesFrom16(playing, teammateHistory.current);

    const t1 = performance.now();
    const buildMs = Math.max(0, t1 - t0);

    // Diagnostics
    const d = computeRoundDiagnostics(newMatches);
    setDiag((prev) => ({
      roundBuildTimes: [...prev.roundBuildTimes, Math.round(buildMs)],
      usedCourts: [...prev.usedCourts, d.used],
      teamImbalances: [...prev.teamImbalances, Number(d.avgImbalance.toFixed(3))],
      spanPerMatch: [...prev.spanPerMatch, Number(d.avgSpan.toFixed(3))],
      outOfBandCounts: [...prev.outOfBandCounts, d.outOfBand],
    }));

    setMatches(newMatches);
    setRound(roundNumber);

    // Persist bench_count and last_played_round
    const updates = [];
    for (const b of benched) updates.push({ id: b.id, bench_count: (b.bench_count || 0) + 1 });
    for (const pl of playing) updates.push({ id: pl.id, last_played_round: roundNumber });
    try {
      await saveUpdatesPublic(updates);
    } catch (e) {
      console.error(e);
      alert('Failed to save round updates: ' + (e.message || String(e)));
    }

    // Refresh players
    try {
      const data = await API.listPlayers();
      setPlayers(
        (data || []).map((p) => ({
          id: p.id,
          name: p.name,
          gender: p.gender || 'M',
          skill_level: Number(p.skill_level || 1),
          is_present: !!p.is_present,
          bench_count: Number(p.bench_count || 0),
          last_played_round: Number(p.last_played_round || 0),
        }))
      );
    } catch {}

    // Summary
    setRundown((prev) => {
      const plays = { ...prev.plays };
      const benches = { ...prev.benches };
      for (const p of playing) plays[p.id] = (plays[p.id] || 0) + 1;
      for (const b of benched) benches[b.id] = (benches[b.id] || 0) + 1;
      const history = [
        ...prev.history,
        {
          round: roundNumber,
          matches: newMatches.map((m) => ({
            court: m.court,
            team1: m.team1.map((x) => x.id),
            team2: m.team2.map((x) => x.id),
          })),
        },
      ];
      return { rounds: roundNumber, plays, benches, history };
    });

    // Push to display
    pushDisplay({ round: roundNumber, matches: newMatches, presentCount: present.length });
  };

  /* ============================================================================
     Timer (warning + end beeps, auto-next-round)
  ============================================================================ */
  const startTimerInternal = () => {
    clearInterval(timerRef.current);
    const start = roundMinutes * 60;
    setTimeLeft(start);
    setRunning(true);
    pushDisplay({ timeLeft: start, running: true, presentCount: present.length });

    timerRef.current = setInterval(() => {
      setTimeLeft((prev) => {
        const next = prev - 1;
        pushDisplay({ timeLeft: next, running: true, presentCount: present.length });
        if (next === warnSeconds) beep(1200, 320);
        if (next <= 0) {
          clearInterval(timerRef.current);
          beep(500, 700);
          setRunning(false);
          pushDisplay({ timeLeft: 0, running: false, presentCount: present.length });
          setTimeout(async () => {
            await buildNextRound();
            startTimerInternal();
          }, 350);
          return 0;
        }
        return next;
      });
    }, 1000);
  };

  /* ============================================================================
     Toolbar actions
  ============================================================================ */
  const onStartNight = () => setUi('session');

  const onResume = async () => {
    if (matches.length === 0) {
      await buildNextRound();
      startTimerInternal();
    } else if (!running && timeLeft > 0) {
      startTimerInternal();
    }
  };

  const onPause = () => {
    if (running) {
      clearInterval(timerRef.current);
      setRunning(false);
      pushDisplay({ running: false, presentCount: present.length });
    }
  };

  const onNextRound = async () => {
    clearInterval(timerRef.current);
    setRunning(false);
    await buildNextRound();
    startTimerInternal();
  };

  const onEndNight = () => {
    clearInterval(timerRef.current);
    setRunning(false);
    pushDisplay({ running: false, matches: [], timeLeft: 0, round: 0, presentCount: present.length });
    setShowRundown(true);
  };

  const closeRundown = () => {
    setShowRundown(false);
    setUi('home');
    setMatches([]);
    setRound(0);
    setTimeLeft(roundMinutes * 60);
    setRundown({ rounds: 0, plays: {}, benches: {}, history: [] });
    setDiag({ roundBuildTimes: [], usedCourts: [], teamImbalances: [], spanPerMatch: [], outOfBandCounts: [] });
    lastRoundBenched.current = new Set();
    teammateHistory.current = new Map();
    pushDisplay({ round: 0, matches: [], timeLeft: 0, running: false, presentCount: present.length });
  };

  /* ============================================================================
     Admin login/logout
  ============================================================================ */
  const adminLogin = () => {
    const key = prompt('Enter admin key:');
    if (!key) return;
    sessionStorage.setItem('adminKey', key);
    setAdminKey(key);
    alert('Admin mode enabled');
  };
  const adminLogout = () => {
    sessionStorage.removeItem('adminKey');
    setAdminKey('');
    alert('Admin mode disabled');
  };

  /* ============================================================================
     Open Display window
  ============================================================================ */
  const openDisplay = () => {
    pushDisplay({ presentCount: players.filter((p) => p.is_present).length });
    const url = new URL(window.location.href);
    url.searchParams.set('display', '1');
    window.open(url.toString(), '_blank', 'noopener,noreferrer');
  };

  /* ============================================================================
     Display hotkeys (fullscreen)
  ============================================================================ */
  useEffect(() => {
    if (!isDisplay) return;
    const onKey = (e) => {
      if (e.key === 'f' || e.key === 'F') {
        const el = document.documentElement;
        if (!document.fullscreenElement) el.requestFullscreen?.();
        else document.exitFullscreen?.();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isDisplay]);

  /* ============================================================================
     Rendering helpers
  ============================================================================ */
  if (!isDisplay && loading) {
    return (
      <div className="page">
        <div className="loader">Loading...</div>
      </div>
    );
  }
  const isWarn = running && timeLeft <= warnSeconds;

  const personRow = (p) => {
    const pill = p.gender === 'F' ? 'female' : 'male';
    return (
      <div
        key={p.id}
        className="person fade-in"
        onDoubleClick={() => togglePresence(p)}
        title="Double-click to toggle"
      >
        <div className="person-left">
          <span className={`pill ${pill}`}>{p.gender}</span>
          <span className="person-name">{p.name}</span>
        </div>
        <div className="level">Lvl {p.skill_level}</div>
      </div>
    );
  };

  const Court = ({ m, large = false }) => {
    const tag = (pl) => {
      const pill = pl.gender === 'F' ? 'female' : 'male';
      return (
        <div className={`tag ${large ? 'lg' : ''}`} key={pl.id}>
          <span className={`pill sm ${pill}`}>{pl.gender}</span>
          {pl.name} <span className="muted">(L{pl.skill_level})</span>
        </div>
      );
    };
    return (
      <div className={`court glass ${large ? 'lg' : ''}`}>
        <div className="court-head">
          <h3>Court {m.court}</h3>
          <div className="avg-pair">
            <span className="avg">Team 1 Avg: <b>{m.avg1?.toFixed ? m.avg1.toFixed(1) : m.avg1}</b></span>
            <span className="avg">Team 2 Avg: <b>{m.avg2?.toFixed ? m.avg2.toFixed(1) : m.avg2}</b></span>
          </div>
        </div>
        <div className="team">{m.team1.map(tag)}</div>
        <div className="net"></div>
        <div className="team">{m.team2.map(tag)}</div>
      </div>
    );
  };

  /* ============================================================================
     Admin Panel
  ============================================================================ */
  const AdminPanel = () => {
    const [drafts, setDrafts] = useState({});
    useEffect(() => {
      const m = {};
      for (const p of players) m[p.id] = { name: p.name, gender: p.gender, skill_level: p.skill_level };
      setDrafts(m);
    }, [players]);

    const onDraftChange = (id, field, value) =>
      setDrafts((prev) => ({ ...prev, [id]: { ...prev[id], [field]: value } }));

    const addPlayer = async (e) => {
      e.preventDefault();
      const form = e.target;
      const name = form.name.value.trim();
      const gender = form.gender.value;
      const skill = clampInt(form.skill.value, 3, 1, 10);
      if (!name) return alert('Name required');
      try {
        await API.upsert(
          [{ name, gender, skill_level: skill, is_present: false, bench_count: 0, last_played_round: 0 }],
          adminKey
        );
        form.reset();
        const data = await API.listPlayers();
        setPlayers(
          (data || []).map((p) => ({
            id: p.id,
            name: p.name,
            gender: p.gender || 'M',
            skill_level: Number(p.skill_level || 1),
            is_present: !!p.is_present,
            bench_count: Number(p.bench_count || 0),
            last_played_round: Number(p.last_played_round || 0),
          }))
        );
      } catch (err) {
        alert(err.message || String(err));
      }
    };

    const saveRow = async (id) => {
      const d = drafts[id];
      if (!d) return;
      try {
        await API.patch(
          [{ id, name: d.name, gender: d.gender, skill_level: clampInt(d.skill_level, 3, 1, 10) }],
          adminKey
        );
        const data = await API.listPlayers();
        setPlayers(
          (data || []).map((p) => ({
            id: p.id,
            name: p.name,
            gender: p.gender || 'M',
            skill_level: Number(p.skill_level || 1),
            is_present: !!p.is_present,
            bench_count: Number(p.bench_count || 0),
            last_played_round: Number(p.last_played_round || 0),
          }))
        );
      } catch (e) {
        alert(e.message || String(e));
      }
    };

    const deleteRow = async (id) => {
      if (!confirm('Delete this player?')) return;
      try {
        await API.remove([id], adminKey);
        const data = await API.listPlayers();
        setPlayers(
          (data || []).map((p) => ({
            id: p.id,
            name: p.name,
            gender: p.gender || 'M',
            skill_level: Number(p.skill_level || 1),
            is_present: !!p.is_present,
            bench_count: Number(p.bench_count || 0),
            last_played_round: Number(p.last_played_round || 0),
          }))
        );
      } catch (e) {
        alert(e.message || String(e));
      }
    };

    return (
      <div className="panel glass">
        <div className="panel-head">
          <h3>Admin Controls</h3>
          {isAdmin ? (
            <button className="btn" onClick={adminLogout}>
              Exit Admin
            </button>
          ) : (
            <button className="btn" onClick={adminLogin}>
              Admin
            </button>
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
              <button className="btn" type="submit">
                Add
              </button>
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
                  {players.map((p) => {
                    const d = drafts[p.id] || { name: p.name, gender: p.gender, skill_level: p.skill_level };
                    return (
                      <tr key={p.id}>
                        <td>
                          <input
                            value={d.name}
                            onChange={(e) => onDraftChange(p.id, 'name', e.target.value)}
                            className="input"
                          />
                        </td>
                        <td>
                          <select
                            value={d.gender}
                            onChange={(e) => onDraftChange(p.id, 'gender', e.target.value)}
                            className="input"
                          >
                            <option value="M">M</option>
                            <option value="F">F</option>
                          </select>
                        </td>
                        <td>
                          <input
                            type="number"
                            min="1"
                            max="10"
                            value={d.skill_level}
                            onChange={(e) =>
                              onDraftChange(p.id, 'skill_level', clampInt(e.target.value, d.skill_level, 1, 10))
                            }
                            className="input"
                          />
                        </td>
                        <td className="center">{p.is_present ? 'Yes' : 'No'}</td>
                        <td className="center">{p.bench_count}</td>
                        <td className="center">{p.last_played_round}</td>
                        <td>
                          <div className="row-actions">
                            <button className="btn" onClick={() => saveRow(p.id)}>
                              Save
                            </button>
                            <button className="btn danger" onClick={() => deleteRow(p.id)}>
                              Delete
                            </button>
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
  };

  /* ============================================================================
     Settings
  ============================================================================ */
  const SettingsPanel = () => (
    <div className="modal-backdrop">
      <div className="modal glass">
        <h3>Settings</h3>
        <div className="settings-grid">
          <label className="setting">
            <span>Round length (minutes)</span>
            <input
              type="number"
              min={3}
              max={40}
              value={roundMinutes}
              onChange={(e) => setRoundMinutes(clampInt(e.target.value, roundMinutes, 3, 40))}
              className="input"
            />
          </label>
          <label className="setting">
            <span>Warning beep at (seconds left)</span>
            <input
              type="number"
              min={5}
              max={120}
              value={warnSeconds}
              onChange={(e) => setWarnSeconds(clampInt(e.target.value, warnSeconds, 5, 120))}
              className="input"
            />
          </label>
          <label className="setting">
            <span>Volume (0-1)</span>
            <input
              type="number"
              step="0.05"
              min={0}
              max={1}
              value={volume}
              onChange={(e) => setVolume(clampFloat(e.target.value, volume, 0, 1))}
              className="input"
            />
          </label>
        </div>
        <div className="right mt-16">
          <button
            className="btn"
            onClick={() => {
              LS.setRound(roundMinutes);
              LS.setWarn(warnSeconds);
              LS.setVol(volume);
              setTimeLeft(roundMinutes * 60);
              setShowSettings(false);
            }}
          >
            Save
          </button>
          <button className="btn ghost" onClick={() => setShowSettings(false)}>
            Close
          </button>
        </div>
      </div>
    </div>
  );

  /* ============================================================================
     Smart Session Summary + Diagnostics
  ============================================================================ */
  const buildSmartSummary = () => {
    const byId = Object.fromEntries(players.map((p) => [p.id, p]));
    const rounds = rundown.rounds;
    const hist = rundown.history || [];

    const playRoundsMap = new Map(); // id -> [rounds]
    const teamSets = new Map(); // id -> Set(teammates)
    const oppSets = new Map(); // id -> Set(opponents)

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
      new Set([].concat(...hist.flatMap((h) => h.matches.flatMap((m) => [...m.team1, ...m.team2]))))
    )
      .map((id) => byId[id])
      .filter(Boolean);

    const per = participants.map((p) => {
      const roundsPlayed = (playRoundsMap.get(p.id) || []).sort((a, b) => a - b);
      const played = roundsPlayed.length;
      const benched = rundown.benches[p.id] || 0;

      let gaps = [];
      for (let i = 1; i < roundsPlayed.length; i++) {
        const gap = roundsPlayed[i] - roundsPlayed[i - 1] - 1;
        if (gap >= 0) gaps.push(gap);
      }
      const avgBenchGap = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : played > 0 ? 0 : NaN;

      let worstStreak = 0;
      let cur = 0;
      const playSet = new Set(roundsPlayed);
      for (let r = 1; r <= rounds; r++) {
        if (playSet.has(r)) {
          cur = 0;
        } else {
          cur++;
          worstStreak = Math.max(worstStreak, cur);
        }
      }

      const teammates = (teamSets.get(p.id)?.size) || 0;
      const opponents = (oppSets.get(p.id)?.size) || 0;

      return {
        id: p.id,
        name: p.name,
        gender: p.gender,
        level: p.skill_level,
        played,
        benched,
        avgBenchGap: isFinite(avgBenchGap) ? avgBenchGap : 0,
        worstBenchStreak: worstStreak,
        teammates,
        opponents,
      };
    });

    const plays = per.map((x) => x.played);
    const meanPlays = plays.length ? plays.reduce((a, b) => a + b, 0) / plays.length : 0;
    const stdDev = plays.length ? Math.sqrt(plays.reduce((a, b) => a + (b - meanPlays) ** 2, 0) / plays.length) : 0;
    const spread = plays.length ? Math.max(...plays) - Math.min(...plays) : 0;
    const fairnessRatio = plays.length ? Math.min(...plays) / Math.max(...plays || [1]) : 0;

    const benchGaps = per.map((x) => x.avgBenchGap).filter((x) => isFinite(x));
    const avgBenchGapOverall = benchGaps.length ? benchGaps.reduce((a, b) => a + b, 0) / benchGaps.length : 0;
    const worstBenchStreakOverall = per.length ? Math.max(...per.map((x) => x.worstBenchStreak)) : 0;

    const maxCourts = Math.max(1, maxCourtsLocal);
    const avgUsed = usedCourtsPerRoundLocal.length
      ? usedCourtsPerRoundLocal.reduce((a, b) => a + b, 0) / usedCourtsPerRoundLocal.length
      : 0;
    const utilization = maxCourts ? avgUsed / maxCourts : 0;

    const males = participants.filter((p) => p.gender === 'M').length;
    const females = participants.filter((p) => p.gender === 'F').length;
    const totalPart = participants.length || 1;
    const band = (lvl) => (lvl <= 3 ? '1-3' : lvl <= 6 ? '4-6' : '7-10');
    const byBand = { '1-3': 0, '4-6': 0, '7-10': 0 };
    for (const p of participants) byBand[band(p.skill_level)]++;

    const histPlays = {};
    for (const v of plays) histPlays[v] = (histPlays[v] || 0) + 1;

    const rep = per.map((x) => ({
      id: x.id,
      name: x.name,
      teammateRepRatio: x.played ? Math.max(0, (x.played - x.teammates) / x.played) : 0,
      opponentRepRatio: x.played ? Math.max(0, (x.played - x.opponents) / x.played) : 0,
    }));

    const csvRows = [
      ['Name', 'Level', 'Played', 'Benched', 'AvgBenchGap', 'WorstBenchStreak', 'UniqueTeammates', 'UniqueOpponents'],
    ].concat(
      per
        .sort((a, b) => b.played - a.played || a.name.localeCompare(b.name))
        .map((x) => [
          x.name,
          x.level,
          x.played,
          x.benched,
          x.avgBenchGap.toFixed(2),
          x.worstBenchStreak,
          x.teammates,
          x.opponents,
        ])
    );

    const playsHistText = Object.keys(histPlays)
      .sort((a, b) => Number(a) - Number(b))
      .map((k) => k + ':' + histPlays[k])
      .join('  ');

    const copyText =
      'Session Summary\n' +
      `Rounds: ${rounds}\n` +
      `Participants: ${participants.length}\n` +
      `Courts (avg used): ${avgUsed.toFixed(2)} / ${maxCourts}  (${fmtPct(utilization)})\n` +
      `Gender: M ${males} • F ${females}\n` +
      `Skill coverage: 1-3 ${fmtPct(byBand['1-3'] / totalPart)}, 4-6 ${fmtPct(byBand['4-6'] / totalPart)}, 7-10 ${fmtPct(byBand['7-10'] / totalPart)}\n\n` +
      'Fairness\n' +
      `Mean plays: ${meanPlays.toFixed(2)}   StdDev: ${stdDev.toFixed(2)}   Spread (max-min): ${spread}   Fairness ratio: ${fairnessRatio.toFixed(2)}\n` +
      `Avg bench gap: ${avgBenchGapOverall.toFixed(2)} rounds\n` +
      `Worst bench streak: ${worstBenchStreakOverall} rounds\n\n` +
      `Plays histogram: ${playsHistText}\n`;

    return {
      rounds,
      participantsCount: participants.length,
      males,
      females,
      bands: byBand,
      totalPart,
      maxCourts,
      avgUsed,
      utilization,
      meanPlays,
      stdDev,
      spread,
      fairnessRatio,
      avgBenchGapOverall,
      worstBenchStreakOverall,
      perPlayer: per,
      repetition: rep,
      csvRows,
      copyText,
      usedCourtsPerRound: usedCourtsPerRoundLocal,
    };
  };

  const downloadCSV = (rows, filename = 'session-summary.csv') => {
    const csv = rows
      .map((r) =>
        r
          .map((v) => {
            const s = String(v ?? '');
            return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
          })
          .join(',')
      )
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const copyToClipboard = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      alert('Summary copied to clipboard.');
    } catch {
      alert('Copy failed. Select and copy manually.');
    }
  };

  const RundownModal = () => {
    const S = buildSmartSummary();
    const [tab, setTab] = useState('summary'); // summary | diagnostics
    const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);

    const cov13 = fmtPct(((S.bands['1-3'] || 0) / (S.totalPart || 1)));
    const cov46 = fmtPct(((S.bands['4-6'] || 0) / (S.totalPart || 1)));
    const cov710 = fmtPct(((S.bands['7-10'] || 0) / (S.totalPart || 1)));

    return (
      <div className="modal-backdrop">
        <div className="modal glass">
          <div className="tabs">
            <button className={`tab ${tab === 'summary' ? 'active' : ''}`} onClick={() => setTab('summary')}>
              Smart Session Summary
            </button>
            {isAdmin && (
              <button className={`tab ${tab === 'diagnostics' ? 'active' : ''}`} onClick={() => setTab('diagnostics')}>
                System Diagnostics
              </button>
            )}
          </div>

          {tab === 'summary' && (
            <>
              <div className="two-col">
                <div>
                  <h4>Overview</h4>
                  <div>Rounds: <b>{S.rounds}</b></div>
                  <div>Participants: <b>{S.participantsCount}</b> (M {S.males} &bull; F {S.females})</div>
                  <div>Courts (avg used): <b>{S.avgUsed.toFixed(2)}</b> / {S.maxCourts} ({fmtPct(S.utilization)})</div>
                  <div>Skill coverage: 1-3 <b>{cov13}</b> &bull; 4-6 <b>{cov46}</b> &bull; 7-10 <b>{cov710}</b></div>
                </div>
                <div>
                  <h4>Fairness</h4>
                  <div>
                    Mean plays: <b>{S.meanPlays.toFixed(2)}</b> &nbsp; StdDev: <b>{S.stdDev.toFixed(2)}</b> &nbsp;
                    Spread: <b>{S.spread}</b> &nbsp; Fairness ratio: <b>{S.fairnessRatio.toFixed(2)}</b>
                  </div>
                  <div>Avg bench gap: <b>{S.avgBenchGapOverall.toFixed(2)}</b> rounds</div>
                  <div>Worst bench streak: <b>{S.worstBenchStreakOverall}</b> rounds</div>
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
                    {S.perPlayer
                      .sort((a, b) => b.played - a.played || a.name.localeCompare(b.name))
                      .map((x) => (
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

          {tab === 'diagnostics' && isAdmin && (
            <>
              <div className="two-col">
                <div>
                  <h4>Round Build Performance</h4>
                  <div>
                    Build times (ms): {(diag.roundBuildTimes || []).join(', ') || '-'}
                  </div>
                  <div>
                    Avg build time:{' '}
                    <b>
                      {(
                        ((diag.roundBuildTimes || []).reduce((a, b) => a + b, 0) /
                          Math.max(1, (diag.roundBuildTimes || []).length))
                      ).toFixed(1)}
                    </b>{' '}
                    ms
                  </div>
                  <div>
                    Courts used per round: {(diag.usedCourts || []).join(', ') || '-'}
                  </div>
                </div>

                <div>
                  <h4>Match Quality</h4>
                  <div>
                    Avg team imbalance per round (abs(avg1 - avg2)):
                    {' '}{(diag.teamImbalances || []).join(', ') || '-'}
                  </div>
                  <div>
                    Avg skill span per match (round avg):
                    {' '}{(diag.spanPerMatch || []).join(', ') || '-'}
                  </div>
                  <div>
                    Out-of-band players count per round (+/- 2 from median):
                    {' '}{(diag.outOfBandCounts || []).join(', ') || '-'}
                  </div>
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
  };

  /* ============================================================================
     Toolbar
  ============================================================================ */
  const Toolbar = () => (
    <div className="toolbar glass">
      <div className="toolbar-left">
        <button className="btn primary" onClick={onStartNight}>Start Night</button>
        <button className="btn" onClick={onPause}>Pause</button>
        <button className="btn" onClick={onResume}>Resume</button>
        <button className="btn danger" onClick={onEndNight}>End Night</button>
        <button className="btn" onClick={onNextRound}>Next Round</button>
        <button className="btn" onClick={openDisplay}>Open Display</button>
        {isAdmin ? (
          <button className="btn" onClick={adminLogout}>Admin (On)</button>
        ) : (
          <button className="btn" onClick={adminLogin}>Admin</button>
        )}
        <button className="btn ghost" onClick={() => setShowSettings(true)}>Settings</button>
      </div>
      <div className={`toolbar-right time ${isWarn ? 'warn' : ''}`}>
        {ui === 'session' ? `Round ${round || '-'} • ${formatTime(timeLeft)}` : ui === 'display' ? 'Display Mode' : 'Not running'}
      </div>
    </div>
  );

  const DisplayView = () => (
    <div className="display page">
      <div className="display-head">
        <div className="display-title">Badminton Club Night</div>
        <div className="display-meta">
          <span>Round {round || '-'}</span>
          <span>•</span>
          <span className={`bigtime ${isWarn ? 'warn' : ''}`}>{formatTime(timeLeft)}</span>
          <span>•</span>
          <span>{displayPresentCount} present</span>
        </div>
        <div className="display-hint">Press F for fullscreen</div>
      </div>

      <div className="display-courts">
        {!displaySeen ? (
          <div className="muted p-20">Waiting for controller...</div>
        ) : matches.length === 0 ? (
          <div className="muted p-20">Waiting for matches...</div>
        ) : (
          matches.map((m) => <Court key={m.court} m={m} large />)
        )}
      </div>
    </div>
  );

  /* ============================================================================
     Final render
  ============================================================================ */
  return (
    <div className="page">
      <Toolbar />

      {ui === 'home' && (
        <div className="welcome fade-in">
          <h2>Welcome to Badminton Club Night</h2>
          <p>
            Use <b>Start Night</b> to begin check-in and matchmaking. Open <b>Display</b> on a second screen to show
            courts and timer.
          </p>
        </div>
      )}

      {ui === 'session' && (
        <>
          <div id="courts" className="courts-grid">
            {matches.map((m) => (
              <Court key={m.court} m={m} />
            ))}
          </div>

          <div className="lists-grid">
            <div className="list-col">
              <div className="list-head">
                All Players <span className="badge">{notPresent.length}</span>
              </div>
              <div id="allList" className="list-box glass">
                {notPresent.map(personRow)}
              </div>
            </div>
            <div className="list-col">
              <div className="list-head">
                Present Today <span className="badge">{present.length}</span>
              </div>
              <div id="presentList" className="list-box glass">
                {present.map(personRow)}
              </div>
            </div>
          </div>

          <AdminPanel />
        </>
      )}

      {ui === 'display' && <DisplayView />}

      {showSettings && <SettingsPanel />}
      {showRundown && <RundownModal />}
    </div>
  );
}

/* ============================================================================
   Utilities
============================================================================ */
function getInitialUi() {
  const url = new URL(window.location.href);
  if (url.searchParams.get('display') === '1') return 'display';
  return 'home';
}
