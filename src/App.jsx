import React, { useEffect, useMemo, useRef, useState } from 'react';
import './App.css';
import {
  MATCH_MODES,
  getMatchMode,
  setMatchMode as persistMatchMode,
  selectPlayersForRound,
  buildMatchesFrom16,
  formatTime,
} from './logic';

/* -------------------- Constants -------------------- */
const API = '/.netlify/functions/players';
const TRANSITION_SEC = 30; // 30s between rounds for change-over

/* -------------------- Reusable UI -------------------- */
const Button = ({ children, onClick, kind = 'ghost', disabled, className, title }) => (
  <button
    className={`btn btn-${kind} ${className || ''}`}
    onClick={onClick}
    disabled={disabled}
    title={title}
    type="button"
  >
    {children}
  </button>
);

const Chip = ({ children, gender }) => (
  <span className={`chip ${gender === 'F' ? 'chip-f' : 'chip-m'}`}>{children}</span>
);

/* -------------------- Small helpers -------------------- */
const byName = (a, b) => a.name.localeCompare(b.name);

/* -------------------- Admin password modal -------------------- */
function AdminGate({ open, onClose, onUnlock }) {
  const [pwd, setPwd] = useState('');
  if (!open) return null;
  const check = () => {
    const key = import.meta.env.VITE_ADMIN_KEY || '';
    if (!key) {
      alert('Admin key is not set on this build (VITE_ADMIN_KEY).');
      return;
    }
    if (pwd === key) onUnlock();
    else alert('Incorrect password.');
  };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={e => e.stopPropagation()}>
        <h3 className="modal-title">Admin Access</h3>
        <div className="vcol" style={{ gap: 8 }}>
          <input
            className="input"
            type="password"
            placeholder="Enter admin password"
            value={pwd}
            onChange={e => setPwd(e.target.value)}
            onKeyDown={e => (e.key === 'Enter' ? check() : null)}
          />
          <div className="modal-actions">
            <Button onClick={onClose}>Cancel</Button>
            <Button kind="primary" onClick={check}>
              Unlock
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* -------------------- Settings dialog -------------------- */
function SettingsDialog({ open, initial, onSave, onClose, matchMode, setMatchMode }) {
  const [form, setForm] = useState(initial);
  useEffect(() => {
    if (open) setForm(initial);
  }, [open, initial]);
  if (!open) return null;

  const update = (k, v) => setForm(prev => ({ ...prev, [k]: v }));

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={e => e.stopPropagation()}>
        <h3 className="modal-title">Settings</h3>
        <div className="grid2 gap16">
          <label className="vcol">
            <span>Round length (minutes)</span>
            <input
              className="input"
              type="number"
              min={1}
              value={form.roundMinutes}
              onChange={e => update('roundMinutes', Math.max(1, Number(e.target.value || 0)))}
            />
          </label>
          <label className="vcol">
            <span>Warn at last (seconds)</span>
            <input
              className="input"
              type="number"
              min={5}
              value={form.warnSeconds}
              onChange={e => update('warnSeconds', Math.max(5, Number(e.target.value || 0)))}
            />
          </label>
          <label className="hrow">
            <input
              type="checkbox"
              checked={form.autoRebuild}
              onChange={e => update('autoRebuild', e.target.checked)}
            />
            <span>Rebuild matches each round</span>
          </label>
          <div className="vcol">
            <span>Matchmaking mode</span>
            <div className="pill-toggle">
              <button
                type="button"
                className={`pill ${matchMode === MATCH_MODES.BAND ? 'active' : ''}`}
                onClick={() => setMatchMode(MATCH_MODES.BAND)}
              >
                Band
              </button>
              <button
                type="button"
                className={`pill ${matchMode === MATCH_MODES.WINDOW ? 'active' : ''}`}
                onClick={() => setMatchMode(MATCH_MODES.WINDOW)}
              >
                Window
              </button>
            </div>
          </div>
        </div>
        <div className="modal-actions">
          <Button onClick={onClose}>Close</Button>
          <Button kind="primary" onClick={() => onSave(form)}>
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}

/* -------------------- Court Card -------------------- */
const Court = ({ court, match, showAverages, showSkill }) => {
  const { team1, team2, avg1, avg2 } = match;
  const label = p => (showSkill ? `${p.name} · L${p.skill_level}` : p.name);
  return (
    <div className="card">
      <div className="card-head">Court {court}</div>
      {showAverages && (
        <div className="muted tcenter" style={{ marginBottom: 6 }}>
          Team 1 Avg <b>{avg1.toFixed(1)}</b> &nbsp;&nbsp; Team 2 Avg <b>{avg2.toFixed(1)}</b>
        </div>
      )}
      <div className="court-row">
        {team1.map(p => (
          <Chip key={p.id} gender={p.gender}>
            {label(p)}
          </Chip>
        ))}
      </div>
      <div className="court-divider" />
      <div className="court-row">
        {team2.map(p => (
          <Chip key={p.id} gender={p.gender}>
            {label(p)}
          </Chip>
        ))}
      </div>
    </div>
  );
};

/* -------------------- Full-screen Display -------------------- */
function DisplayView({
  round,
  phase,
  secondsLeft,
  warnSeconds,
  blink,
  matches,
  benched,
  presentCount,
}) {
  const timerClass =
    secondsLeft === 0 || phase === 'transition'
      ? blink
        ? 'display-timer blink'
        : 'display-timer'
      : secondsLeft <= warnSeconds
      ? 'display-timer warn'
      : 'display-timer';

  return (
    <div className="display-root">
      <div className="display-header">
        <div className="display-title">🏸 TheFLOminton System</div>
        <div className="display-center">
          <div className="display-round">Round {round}</div>
          <div className={timerClass}>{formatTime(secondsLeft)}</div>
          <div className="display-present">{presentCount} present</div>
        </div>
        <div />
      </div>

      <div className="display-courts">
        {matches.map(m => (
          <div key={m.court} className="display-court">
            <div className="display-court-title">Court {m.court}</div>
            <div className="display-team-row">
              {m.team1.map(p => (
                <span key={p.id} className={`display-chip ${p.gender === 'F' ? 'f' : 'm'}`}>
                  {p.name}
                </span>
              ))}
            </div>
            <div className="display-divider" />
            <div className="display-team-row">
              {m.team2.map(p => (
                <span key={p.id} className={`display-chip ${p.gender === 'F' ? 'f' : 'm'}`}>
                  {p.name}
                </span>
              ))}
            </div>
          </div>
        ))}
        {matches.length === 0 && (
          <div className="display-wait">Waiting for matches…</div>
        )}
      </div>

      <div className="display-benched">
        {benched.map(p => (
          <span key={p.id} className={`display-benched-chip ${p.gender === 'F' ? 'f' : 'm'}`}>
            {p.name}
          </span>
        ))}
      </div>
    </div>
  );
}

/* -------------------- Summary + Diagnostics -------------------- */
function SummaryModal({ open, onClose, isAdmin, history, playersSnapshot, presentIds }) {
  const [tab, setTab] = useState('summary');
  if (!open) return null;

  // Build metrics
  const rounds = history.length;
  const presentPlayers = useMemo(
    () => playersSnapshot.filter(p => presentIds.has(p.id)),
    [playersSnapshot, presentIds]
  );

  // Aggregate helpers
  const benchesByPlayer = new Map();
  const playedByPlayer = new Map();
  const teammatePairs = new Map(); // key: "a-b" sorted
  const opponentPairs = new Map();

  const teamImbalances = []; // per round avg |avg1-avg2|
  const skillSpans = []; // per match (max-min)
  const courtsUsed = []; // per round count

  for (const h of history) {
    let roundImbalances = [];
    let usedCourts = 0;

    h.matches.forEach(m => {
      usedCourts++;
      // played
      [...m.team1, ...m.team2].forEach(p => {
        playedByPlayer.set(p.id, (playedByPlayer.get(p.id) || 0) + 1);
      });

      // teams pairs
      const t1 = m.team1.map(p => p.id);
      const t2 = m.team2.map(p => p.id);
      for (let i = 0; i < t1.length; i++)
        for (let j = i + 1; j < t1.length; j++) {
          const k = [t1[i], t1[j]].sort().join('-');
          teammatePairs.set(k, (teammatePairs.get(k) || 0) + 1);
        }
      for (let i = 0; i < t2.length; i++)
        for (let j = i + 1; j < t2.length; j++) {
          const k = [t2[i], t2[j]].sort().join('-');
          teammatePairs.set(k, (teammatePairs.get(k) || 0) + 1);
        }

      // opponent pairs
      t1.forEach(a =>
        t2.forEach(b => {
          const k = [a, b].sort().join('-');
          opponentPairs.set(k, (opponentPairs.get(k) || 0) + 1);
        })
      );

      // imbalance
      const sum1 = m.team1.reduce((s, p) => s + p.skill_level, 0) / m.team1.length;
      const sum2 = m.team2.reduce((s, p) => s + p.skill_level, 0) / m.team2.length;
      roundImbalances.push(Math.abs(sum1 - sum2));

      // skill span
      const quad = [...m.team1, ...m.team2].map(p => p.skill_level);
      skillSpans.push(Math.max(...quad) - Math.min(...quad));
    });

    teamImbalances.push(roundImbalances.length ? roundImbalances.reduce((a, b) => a + b, 0) / roundImbalances.length : 0);
    courtsUsed.push(usedCourts);

    // benches
    h.benchedIds.forEach(id => benchesByPlayer.set(id, (benchesByPlayer.get(id) || 0) + 1));
  }

  // bench gap + worst streak
  const benchGaps = new Map(); // id -> [gaps...]
  const worstStreak = new Map(); // id -> num

  // Build per player round indices where they were benched
  const benchedRoundsByPlayer = new Map();
  history.forEach((h, idx) => {
    h.benchedIds.forEach(id => {
      const arr = benchedRoundsByPlayer.get(id) || [];
      arr.push(idx + 1); // rounds are 1-based
      benchedRoundsByPlayer.set(id, arr);
    });
  });
  // compute gaps and worst streak
  presentPlayers.forEach(p => {
    const arr = benchedRoundsByPlayer.get(p.id) || [];
    if (arr.length > 1) {
      const gaps = [];
      for (let i = 1; i < arr.length; i++) gaps.push(arr[i] - arr[i - 1]);
      benchGaps.set(p.id, gaps);
    } else benchGaps.set(p.id, []);
    // worst streak (consecutive benches inside session)
    let maxStreak = 0;
    let cur = 0;
    for (let r = 1; r <= rounds; r++) {
      if (arr.includes(r)) cur += 1;
      else {
        if (cur > maxStreak) maxStreak = cur;
        cur = 0;
      }
    }
    if (cur > maxStreak) maxStreak = cur;
    worstStreak.set(p.id, maxStreak);
  });

  // fairness metrics
  const playedVals = presentPlayers.map(p => playedByPlayer.get(p.id) || 0);
  const benchedVals = presentPlayers.map(p => benchesByPlayer.get(p.id) || 0);
  const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const stddev = a => {
    if (!a.length) return 0;
    const m = mean(a);
    return Math.sqrt(mean(a.map(x => (x - m) ** 2)));
  };
  const fairness = {
    meanBenches: mean(benchedVals),
    stdBenches: stddev(benchedVals),
    spreadBenches: benchedVals.length ? Math.max(...benchedVals) - Math.min(...benchedVals) : 0,
    fairnessRatio: (() => {
      const m = mean(benchedVals) || 1;
      return (stddev(benchedVals) / m).toFixed(2);
    })(),
    avgBenchGap: mean(
      presentPlayers.map(p => {
        const g = benchGaps.get(p.id) || [];
        return g.length ? mean(g) : 0;
      })
    ),
    worstBenchStreak: Math.max(...presentPlayers.map(p => worstStreak.get(p.id) || 0), 0),
  };

  // skill coverage histogram by bands (1–2, 3–4, 5–6, 7–8, 9–10) over matches
  const bandIndex = lvl => (lvl <= 2 ? 0 : lvl <= 4 ? 1 : lvl <= 6 ? 2 : lvl <= 8 ? 3 : 4);
  const bandCounts = [0, 0, 0, 0, 0];
  let totalQuads = 0;
  history.forEach(h => {
    h.matches.forEach(m => {
      totalQuads++;
      const all = [...m.team1, ...m.team2].map(p => bandIndex(p.skill_level));
      // determine the dominant band in this quad (median)
      const med = all.sort((a, b) => a - b)[2] ?? all[0];
      bandCounts[med] += 1;
    });
  });
  const bandPct = bandCounts.map(c =>
    totalQuads ? `${((c / totalQuads) * 100).toFixed(1)}%` : '0.0%'
  );

  const presentRows = presentPlayers
    .map(p => {
      // unique teammate/opponent counts
      const uniqT = new Set();
      const uniqO = new Set();
      teammatePairs.forEach((v, k) => {
        const [a, b] = k.split('-');
        if (a === p.id) uniqT.add(b);
        if (b === p.id) uniqT.add(a);
      });
      opponentPairs.forEach((v, k) => {
        const [a, b] = k.split('-');
        if (a === p.id) uniqO.add(b);
        if (b === p.id) uniqO.add(a);
      });

      // repeats in last N (N = rounds)
      let repeatTeammates = 0;
      let repeatOpponents = 0;
      teammatePairs.forEach(v => {
        if (v > 1) repeatTeammates += v - 1;
      });
      opponentPairs.forEach(v => {
        if (v > 1) repeatOpponents += v - 1;
      });

      const gaps = benchGaps.get(p.id) || [];
      return {
        id: p.id,
        name: p.name,
        lvl: p.skill_level,
        played: playedByPlayer.get(p.id) || 0,
        benched: benchesByPlayer.get(p.id) || 0,
        avgGap: gaps.length ? mean(gaps).toFixed(2) : '—',
        worstStreak: worstStreak.get(p.id) || 0,
        uniqT: uniqT.size,
        uniqO: uniqO.size,
        repT: repeatTeammates,
        repO: repeatOpponents,
      };
    })
    .sort((a, b) => b.played - a.played || a.name.localeCompare(b.name));

  const exportCSV = () => {
    const headers = [
      'Name',
      'Level',
      'Played',
      'Benched',
      'AvgBenchGap',
      'WorstBenchStreak',
      'UniqueTeammates',
      'UniqueOpponents',
      'RepeatTeammates',
      'RepeatOpponents',
    ];
    const lines = [headers.join(',')].concat(
      presentRows.map(r =>
        [
          r.name,
          r.lvl,
          r.played,
          r.benched,
          r.avgGap,
          r.worstStreak,
          r.uniqT,
          r.uniqO,
          r.repT,
          r.repO,
        ].join(',')
      )
    );
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'session_summary.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  const copySummary = async () => {
    const text = `
Rounds: ${rounds}
Participants (present): ${presentPlayers.length}
Avg courts used/round: ${mean(courtsUsed).toFixed(2)}
Skill coverage (by quads): 1-2 ${bandPct[0]}, 3-4 ${bandPct[1]}, 5-6 ${bandPct[2]}, 7-8 ${bandPct[3]}, 9-10 ${bandPct[4]}

Fairness
- Mean benches/player: ${fairness.meanBenches.toFixed(2)}
- StdDev benches: ${fairness.stdBenches.toFixed(2)}
- Spread: ${fairness.spreadBenches}
- Fairness ratio: ${fairness.fairnessRatio}
- Avg bench gap: ${fairness.avgBenchGap.toFixed(2)}
- Worst bench streak: ${fairness.worstBenchStreak}
`.trim();
    try {
      await navigator.clipboard.writeText(text);
      alert('Summary copied to clipboard.');
    } catch {
      alert('Copy failed.');
    }
  };

  // Diagnostics table rows
  const diag = {
    roundBuildTimes: history.map(h => h.buildMs || 0),
    usedCourts: courtsUsed,
    teamImbalances,
    spanPerMatch: skillSpans,
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card wide" onClick={e => e.stopPropagation()}>
        <div className="hrow" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 className="modal-title">Smart Session Summary</h3>
          <div className="hrow" style={{ gap: 8 }}>
            <Button onClick={() => setTab('summary')} kind={tab === 'summary' ? 'primary' : 'ghost'}>
              Summary
            </Button>
            <Button
              onClick={() => setTab('diagnostics')}
              kind={tab === 'diagnostics' ? 'primary' : 'ghost'}
            >
              Diagnostics
            </Button>
            <Button onClick={onClose}>Close</Button>
          </div>
        </div>

        {tab === 'summary' && (
          <div>
            <div className="two-col">
              <div>
                <h4>Overview</h4>
                <div>Rounds: <b>{rounds}</b></div>
                <div>Participants (present): <b>{presentPlayers.length}</b></div>
                <div>Avg courts used/round: <b>{mean(courtsUsed).toFixed(2)}</b></div>
                <div>Skill coverage (quads): 1–2 <b>{bandPct[0]}</b>, 3–4 <b>{bandPct[1]}</b>, 5–6 <b>{bandPct[2]}</b>, 7–8 <b>{bandPct[3]}</b>, 9–10 <b>{bandPct[4]}</b></div>
              </div>
              <div>
                <h4>Fairness</h4>
                <div>Mean benches/player: <b>{fairness.meanBenches.toFixed(2)}</b></div>
                <div>StdDev benches: <b>{fairness.stdBenches.toFixed(2)}</b></div>
                <div>Spread: <b>{fairness.spreadBenches}</b></div>
                <div>Fairness ratio: <b>{fairness.fairnessRatio}</b></div>
                <div>Avg bench gap: <b>{fairness.avgBenchGap.toFixed(2)}</b></div>
                <div>Worst bench streak: <b>{fairness.worstBenchStreak}</b></div>
              </div>
            </div>

            <div className="table">
              <div className="thead">
                <div>Name</div>
                <div>Lvl</div>
                <div>Played</div>
                <div>Benched</div>
                <div>Avg Gap</div>
                <div>Worst Streak</div>
                <div>Uniq T</div>
                <div>Uniq O</div>
                <div>Rep T</div>
                <div>Rep O</div>
              </div>
              {presentRows.map(r => (
                <div key={r.id} className="trow">
                  <div>{r.name}</div>
                  <div>{r.lvl}</div>
                  <div>{r.played}</div>
                  <div>{r.benched}</div>
                  <div>{r.avgGap}</div>
                  <div>{r.worstStreak}</div>
                  <div>{r.uniqT}</div>
                  <div>{r.uniqO}</div>
                  <div>{r.repT}</div>
                  <div>{r.repO}</div>
                </div>
              ))}
            </div>

            <div className="hrow" style={{ gap: 8, marginTop: 10, justifyContent: 'flex-end' }}>
              <Button onClick={exportCSV}>Export CSV</Button>
              <Button onClick={copySummary}>Copy Summary</Button>
            </div>
          </div>
        )}

        {tab === 'diagnostics' && (
          <div>
            <div className="two-col">
              <div>
                <h4>Round Build Performance</h4>
                <div>Build times (ms): {diag.roundBuildTimes.join(', ') || '—'}</div>
                <div>Avg build time: <b>{mean(diag.roundBuildTimes).toFixed(1)}</b> ms</div>
                <div>Courts used per round: {diag.usedCourts.join(', ') || '—'}</div>
              </div>
              <div>
                <h4>Match Quality</h4>
                <div>Avg team imbalance / round: {diag.teamImbalances.map(x => x.toFixed(2)).join(', ') || '—'}</div>
                <div>Skill span per match: {diag.spanPerMatch.join(', ') || '—'}</div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* -------------------- Main App -------------------- */
export default function App() {
  /* ----- Core state ----- */
  const [players, setPlayers] = useState([]);
  const [loading, setLoading] = useState(true);

  const [view, setView] = useState('home'); // 'home' | 'session'
  const [round, setRound] = useState(1);
  const [courts, setCourts] = useState(4);
  const [matches, setMatches] = useState([]);
  const [benched, setBenched] = useState([]);

  // timer phases: 'idle' | 'running' | 'transition'
  const [phase, setPhase] = useState('idle');
  const [secondsLeft, setSecondsLeft] = useState(12 * 60);
  const [blink, setBlink] = useState(false);

  const [isAdmin, setIsAdmin] = useState(false);
  const [wantAdmin, setWantAdmin] = useState(false); // show password modal
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [displayOpen, setDisplayOpen] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);

  const [showSkill, setShowSkill] = useState(false); // admin toggle in control panel

  const [settings, setSettings] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('flo.settings') || '{}');
      return {
        roundMinutes: saved.roundMinutes ?? 12,
        warnSeconds: saved.warnSeconds ?? 30,
        autoRebuild: saved.autoRebuild ?? true,
      };
    } catch {
      return { roundMinutes: 12, warnSeconds: 30, autoRebuild: true };
    }
  });

  const [matchMode, setMatchModeState] = useState(getMatchMode());
  const setMatchMode = m => {
    setMatchModeState(m);
    persistMatchMode(m);
  };

  const audioCtxRef = useRef(null);
  const beep = useRef(() => {});
  useEffect(() => {
    beep.current = (hz = 880, ms = 140) => {
      if (!audioCtxRef.current) audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
      const ctx = audioCtxRef.current, t = ctx.currentTime;
      const osc = ctx.createOscillator(); const g = ctx.createGain();
      osc.type = 'sine'; osc.frequency.setValueAtTime(hz, t);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.25, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
      osc.connect(g); g.connect(ctx.destination);
      osc.start(t); osc.stop(t + ms / 1000);
    };
  }, []);

  const lastRoundBenched = useRef(new Set());
  const [history, setHistory] = useState([]);
  const [saving, setSaving] = useState(false);

  /* ----- Data ----- */
  const fetchPlayers = async () => {
    setLoading(true);
    try {
      const res = await fetch(API);
      const data = await res.json();
      const norm = data.map(p => ({
        id: p.id,
        name: p.name,
        gender: p.gender || 'M',
        skill_level: Number(p.skill_level || 1),
        is_present: !!p.is_present,
        bench_count: Number(p.bench_count || 0),
        last_played_round: Number(p.last_played_round || 0),
        created_at: p.created_at,
      }));
      setPlayers(norm.sort(byName));
    } catch (e) {
      alert('Supabase error: ' + (e?.message || 'Failed to fetch'));
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    fetchPlayers();
  }, []);

  const present = useMemo(() => players.filter(p => p.is_present), [players]);
  const presentIds = useMemo(() => new Set(present.map(p => p.id)), [present]);

  /* ----- Timer engine ----- */
  useEffect(() => {
    if (phase === 'running') {
      const id = setInterval(() => {
        setSecondsLeft(s => {
          if (s <= 1) {
            clearInterval(id);
            // enter 30s transition window
            setPhase('transition');
            setSecondsLeft(TRANSITION_SEC);
            setBlink(true);
            // end-of-round triple beep
            beep.current(1000, 200);
            setTimeout(() => beep.current(700, 200), 260);
            setTimeout(() => beep.current(500, 300), 560);
            return 0;
          }
          if (s - 1 === settings.warnSeconds) beep.current(1300, 120);
          return s - 1;
        });
      }, 1000);
      return () => clearInterval(id);
    }

    if (phase === 'transition') {
      const id = setInterval(() => {
        setSecondsLeft(s => {
          if (s <= 1) {
            clearInterval(id);
            setBlink(false);
            // start next round automatically
            nextRound(true);
            return 0;
          }
          return s - 1;
        });
      }, 1000);
      return () => clearInterval(id);
    }
  }, [phase, settings.warnSeconds]);

  /* ----- Build round ----- */
  const buildRound = () => {
    // choose 16 (or 8/12/…) with fairness priority
    const t0 = performance.now();
    const { playing, benched: justBenched } = selectPlayersForRound(
      present,
      round,
      lastRoundBenched.current,
      courts
    );
    // enforce uniqueness + freeze copy
    const ids = new Set();
    playing.forEach(p => ids.add(p.id));
    if (ids.size !== playing.length) console.warn('Duplicate players selected for round!');

    lastRoundBenched.current = new Set(justBenched.map(p => p.id));

    const built = buildMatchesFrom16(playing, undefined, courts).map(m => ({
      court: m.court,
      team1: m.team1.map(p => ({ ...p })),
      team2: m.team2.map(p => ({ ...p })),
      avg1: m.avg1,
      avg2: m.avg2,
    }));

    setMatches(built);
    setBenched(justBenched);

    const playingIdSet = new Set(playing.map(p => p.id));
    setPlayers(prev =>
      prev.map(p => {
        if (playingIdSet.has(p.id)) return { ...p, last_played_round: round };
        if (justBenched.find(x => x.id === p.id)) return { ...p, bench_count: (p.bench_count | 0) + 1 };
        return p;
      })
    );

    const buildMs = performance.now() - t0;
    setHistory(prev =>
      prev.concat([
        {
          round,
          buildMs,
          matches: built.map(m => ({
            court: m.court,
            team1: m.team1.map(p => ({ id: p.id, name: p.name, gender: p.gender, skill_level: p.skill_level })),
            team2: m.team2.map(p => ({ id: p.id, name: p.name, gender: p.gender, skill_level: p.skill_level })),
          })),
          benchedIds: justBenched.map(p => p.id),
        },
      ])
    );
  };

  /* ----- Controls ----- */

  // Begin Night: go to session, reset round/time/history, **do not** reset benches, **do not** build matches
  const beginNight = () => {
    setView('session');
    setRound(1);
    setMatches([]);
    setBenched([]);
    setHistory([]);
    lastRoundBenched.current = new Set();
    setPhase('idle');
    setSecondsLeft(settings.roundMinutes * 60);
    setBlink(false);
  };

  // Build/Resume: build if empty; else unpause
  const buildOrResume = () => {
    if (view !== 'session') setView('session');
    setBlink(false);
    if (!matches.length) {
      buildRound();
    }
    setPhase('running');
    setSecondsLeft(prev => (prev === 0 ? settings.roundMinutes * 60 : prev));
  };

  // Next round: round++, rebuild (autoRebuild), start 'running'
  const nextRound = (fromTransition = false) => {
    setRound(r => r + 1);
    setBlink(false);
    setSecondsLeft(settings.roundMinutes * 60);
    if (settings.autoRebuild || fromTransition) buildRound();
    setPhase('running');
  };

  // End Night: open summary & reset benches
  const endNight = () => {
    setPhase('idle');
    setBlink(false);
    setSummaryOpen(true);
    // reset bench counters for a fresh future session
    setPlayers(prev => prev.map(p => ({ ...p, bench_count: 0, last_played_round: 0 })));
  };

  const togglePresent = p => {
    setPlayers(prev => prev.map(x => (x.id === p.id ? { ...x, is_present: !x.is_present } : x)));
  };

  /* ----- Save/CRUD ----- */
  const saveAll = async () => {
    setSaving(true);
    try {
      const body = {
        updates: players.map(p => ({
          id: p.id,
          fields: {
            name: p.name,
            gender: p.gender,
            skill_level: p.skill_level | 0,
            is_present: !!p.is_present,
            bench_count: p.bench_count | 0,
            last_played_round: p.last_played_round | 0,
          },
        })),
      };
      const res = await fetch(API, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`Save failed: ${await res.text()}`);
      alert('Saved.');
    } catch (e) {
      alert(e.message);
    } finally {
      setSaving(false);
    }
  };

  const addPlayer = async () => {
    const name = prompt('New player name:')?.trim();
    if (!name) return;
    const gender = prompt("Gender (M/F):", "M")?.trim().toUpperCase() === "F" ? "F" : "M";
    const skill = Number(prompt('Skill level (1-10):', '5') || 5);
    const p = {
      name,
      gender,
      skill_level: Math.min(10, Math.max(1, skill)),
      is_present: false,
      bench_count: 0,
      last_played_round: 0,
    };
    try {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ players: [p] }),
      });
      if (!res.ok) throw new Error(`Add failed: ${await res.text()}`);
      await fetchPlayers();
    } catch (e) {
      alert(e.message);
    }
  };

  const editPlayer = async p => {
    const name = prompt('Name:', p.name);
    if (!name) return;
    const gender = prompt('Gender (M/F):', p.gender) || p.gender;
    const skill = Number(prompt('Skill level (1-10):', String(p.skill_level)) || p.skill_level);
    const updated = {
      ...p,
      name: name.trim(),
      gender: gender.trim().toUpperCase() === 'F' ? 'F' : 'M',
      skill_level: Math.min(10, Math.max(1, skill)),
    };
    try {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ players: [updated] }),
      });
      if (!res.ok) throw new Error(`Edit failed: ${await res.text()}`);
      await fetchPlayers();
    } catch (e) {
      alert(e.message);
    }
  };

  const deletePlayer = async p => {
    if (!confirm(`Delete ${p.name}?`)) return;
    try {
      const res = await fetch(`${API}?id=${encodeURIComponent(p.id)}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`Delete failed: ${await res.text()}`);
      await fetchPlayers();
    } catch (e) {
      alert(e.message);
    }
  };

  /* ----- Derived visuals ----- */
  const timerClass =
    phase === 'transition' || secondsLeft === 0
      ? blink
        ? 'timer blink'
        : 'timer'
      : secondsLeft <= settings.warnSeconds
      ? 'timer warn'
      : 'timer';

  /* -------------------- Render -------------------- */
  return (
    <div className="page">
      {/* Toolbar */}
      <div className="toolbar">
        <div className="toolbar-left">
          <div className="app-title-left">🏸 TheFLOminton System</div>
        </div>

        <div className="toolbar-center">
          {view === 'session' && (
            <>
              <div className="round-pill">Round {round}</div>
              <div className={timerClass}>{formatTime(secondsLeft)}</div>
            </>
          )}
        </div>

        <div className="toolbar-right">
          {view === 'home' ? (
            <>
              <Button kind="primary" onClick={beginNight}>
                Begin Night
              </Button>
              <Button onClick={() => setSettingsOpen(true)}>Settings</Button>
              <Button onClick={() => setWantAdmin(true)}>Admin</Button>
            </>
          ) : (
            <>
              <Button kind="primary" onClick={beginNight} title="Reset to start of session (no match build)">
                Begin Night
              </Button>
              <Button onClick={buildOrResume}>Build/Resume</Button>
              <Button onClick={() => nextRound(false)}>Next Round</Button>
              <Button kind="danger" onClick={endNight}>
                End Night
              </Button>
              <Button onClick={() => setDisplayOpen(true)}>Open Display</Button>

              {isAdmin && (
                <div className="pill-toggle">
                  <button
                    type="button"
                    className={`pill ${matchMode === MATCH_MODES.BAND ? 'active' : ''}`}
                    onClick={() => setMatchMode(MATCH_MODES.BAND)}
                  >
                    Band
                  </button>
                  <button
                    type="button"
                    className={`pill ${matchMode === MATCH_MODES.WINDOW ? 'active' : ''}`}
                    onClick={() => setMatchMode(MATCH_MODES.WINDOW)}
                  >
                    Window
                  </button>
                </div>
              )}

              <Button onClick={() => setSettingsOpen(true)}>Settings</Button>
              <Button onClick={() => (isAdmin ? setIsAdmin(false) : setWantAdmin(true))}>
                {isAdmin ? 'Admin ON' : 'Admin'}
              </Button>
            </>
          )}
        </div>
      </div>

      {/* HOME */}
      {view === 'home' && (
        <div className="home-wrap">
          <div className="home-grid">
            <Button kind="primary" className="home-btn" onClick={beginNight}>
              Begin Night
            </Button>
            <Button className="home-btn" onClick={() => setSettingsOpen(true)}>
              Settings
            </Button>
            <Button className="home-btn" onClick={() => setWantAdmin(true)}>
              Admin
            </Button>
            <Button className="home-btn" onClick={endNight}>
              End Night
            </Button>
          </div>
        </div>
      )}

      {/* SESSION */}
      {view === 'session' && (
        <>
          {/* Courts */}
          <div className="grid2 grid-courts">
            {matches.map(m => (
              <Court
                key={m.court}
                court={m.court}
                match={m}
                showAverages={isAdmin}
                showSkill={isAdmin && showSkill}
              />
            ))}
            {!matches.length && (
              <div className="muted" style={{ gridColumn: '1 / -1', textAlign: 'center', padding: 20 }}>
                {loading ? 'Loading…' : 'No matches yet — click Build/Resume.'}
              </div>
            )}
          </div>

          {/* Benched */}
          <div className="card">
            <div className="card-head">Benched Players</div>
            <div className="benched-strip">
              {benched.map(p => (
                <Chip key={p.id} gender={p.gender}>
                  {p.name}
                </Chip>
              ))}
              {!benched.length && <span className="muted">No one benched this round</span>}
            </div>
          </div>

          {/* Lists */}
          <div className="grid2 gap16">
            <div className="card">
              <div className="card-head">
                All Players <span className="badge">{players.length - present.length}</span>
              </div>
              <div className="list">
                {players
                  .filter(p => !p.is_present)
                  .sort(byName)
                  .map(p => (
                    <div
                      key={p.id}
                      className="list-row"
                      onDoubleClick={() => togglePresent(p)}
                      title="Double-click to mark present"
                    >
                      <Chip gender={p.gender}>{p.name}</Chip>
                      <div className="spacer" />
                      {isAdmin && <span className="muted">Benched {p.bench_count | 0}</span>}
                    </div>
                  ))}
              </div>
            </div>

            <div className="card">
              <div className="card-head">
                Present Today <span className="badge">{present.length}</span>
              </div>
              <div className="list">
                {present.sort(byName).map(p => (
                  <div
                    key={p.id}
                    className="list-row"
                    onDoubleClick={() => togglePresent(p)}
                    title="Double-click to unmark"
                  >
                    <Chip gender={p.gender}>{p.name}</Chip>
                    <div className="spacer" />
                    {isAdmin && <span className="muted">Benched {p.bench_count | 0}</span>}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Admin Controls */}
          {isAdmin && (
            <div className="card">
              <div className="card-head">Admin Controls</div>
              <div className="hrow wrap" style={{ gap: 8, marginBottom: 12 }}>
                <label className="hrow" style={{ gap: 8 }}>
                  <input
                    type="checkbox"
                    checked={showSkill}
                    onChange={e => setShowSkill(e.target.checked)}
                  />
                  <span>Show skill levels on courts</span>
                </label>
                <label className="hrow" style={{ gap: 8 }}>
                  Courts:
                  <input
                    className="input sm"
                    type="number"
                    min={1}
                    max={8}
                    value={courts}
                    onChange={e => setCourts(Math.max(1, Math.min(8, Number(e.target.value || 1))))}
                  />
                </label>
                <Button onClick={saveAll} disabled={saving}>
                  {saving ? 'Saving…' : 'Save All'}
                </Button>
                <Button onClick={addPlayer}>Add Player</Button>
              </div>

              <div className="table">
                <div className="thead">
                  <div>Name</div>
                  <div>Gender</div>
                  <div>Level</div>
                  <div>Present</div>
                  <div>Actions</div>
                </div>
                {players.sort(byName).map(p => (
                  <div key={p.id} className="trow">
                    <div>{p.name}</div>
                    <div>{p.gender}</div>
                    <div>{p.skill_level}</div>
                    <div>{p.is_present ? 'Yes' : 'No'}</div>
                    <div className="hrow" style={{ gap: 6 }}>
                      <Button onClick={() => editPlayer(p)}>Edit</Button>
                      <Button kind="danger" onClick={() => deletePlayer(p)}>
                        Delete
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* Settings */}
      <SettingsDialog
        open={settingsOpen}
        initial={settings}
        onSave={next => {
          setSettings(next);
          try {
            localStorage.setItem('flo.settings', JSON.stringify(next));
          } catch {}
          setSettingsOpen(false);
          if (phase === 'idle') setSecondsLeft(next.roundMinutes * 60);
        }}
        onClose={() => setSettingsOpen(false)}
        matchMode={matchMode}
        setMatchMode={setMatchMode}
      />

      {/* Admin password modal */}
      <AdminGate
        open={wantAdmin && !isAdmin}
        onClose={() => setWantAdmin(false)}
        onUnlock={() => {
          setIsAdmin(true);
          setWantAdmin(false);
        }}
      />

      {/* Display overlay */}
      {displayOpen && (
        <div className="display-overlay">
          <div className="display-close">
            <Button onClick={() => setDisplayOpen(false)} kind="primary">
              Close Display
            </Button>
          </div>
          <DisplayView
            round={round}
            phase={phase}
            secondsLeft={secondsLeft}
            warnSeconds={settings.warnSeconds}
            blink={blink}
            matches={matches}
            benched={benched}
            presentCount={present.length}
          />
        </div>
      )}

      {/* Summary */}
      <SummaryModal
        open={summaryOpen}
        onClose={() => setSummaryOpen(false)}
        isAdmin={isAdmin}
        history={history}
        playersSnapshot={players}
        presentIds={presentIds}
      />
    </div>
  );
}
