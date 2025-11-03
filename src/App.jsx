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

/* ============ UI helpers ============ */
const Button = ({ children, onClick, kind='ghost', disabled, title, className }) => (
  <button
    title={title}
    onClick={onClick}
    disabled={disabled}
    className={`btn btn-${kind} ${className||''}`}
  >
    {children}
  </button>
);

const Chip = ({ children, gender }) => (
  <span className={`chip ${gender === 'F' ? 'chip-f' : 'chip-m'}`}>{children}</span>
);

/* ============ Settings dialog (sticky until Save/Close) ============ */
function SettingsDialog({ open, initial, onSave, onClose, matchMode, setMatchMode }) {
  const [form, setForm] = useState(initial);
  useEffect(() => { if (open) setForm(initial); }, [open, initial]);
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
              type="number" min={1}
              value={form.roundMinutes}
              onChange={e => update('roundMinutes', Math.max(1, Number(e.target.value||0)))}
            />
          </label>

          <label className="vcol">
            <span>Warn at last (seconds)</span>
            <input
              className="input"
              type="number" min={5}
              value={form.warnSeconds}
              onChange={e => update('warnSeconds', Math.max(5, Number(e.target.value||0)))}
            />
          </label>

          <label className="hrow">
            <input
              type="checkbox"
              checked={form.autoAdvance}
              onChange={e => update('autoAdvance', e.target.checked)}
            />
            <span>Auto-advance to next round when timer ends</span>
          </label>

          <label className="hrow">
            <input
              type="checkbox"
              checked={form.autoRebuild}
              onChange={e => update('autoRebuild', e.target.checked)}
            />
            <span>Rebuild matches each round</span>
          </label>

          <label className="vcol">
            <span>Matchmaking mode</span>
            <select
              className="input"
              value={matchMode}
              onChange={e => setMatchMode(e.target.value)}
            >
              <option value={MATCH_MODES.BAND}>Band Mode (1–2, 3–4, 5–6, 7–8, 9–10)</option>
              <option value={MATCH_MODES.WINDOW}>Window Mode (±2 → expand)</option>
            </select>
          </label>
        </div>

        <div className="modal-actions">
          <Button onClick={onClose}>Close</Button>
          <Button kind="primary" onClick={() => onSave(form)}>Save</Button>
        </div>
      </div>
    </div>
  );
}

/* ============ Court card ============ */
const Court = ({ court, match, showAverages }) => {
  const { team1, team2, avg1, avg2 } = match;
  return (
    <div className="card">
      <div className="card-head">Court {court}</div>
      {showAverages && (
        <div className="muted tcenter" style={{marginBottom:6}}>
          Team 1 Avg <b>{avg1.toFixed(1)}</b> &nbsp; &nbsp;
          Team 2 Avg <b>{avg2.toFixed(1)}</b>
        </div>
      )}
      <div className="court-row">
        {team1.map(p => (
          <Chip key={p.id} gender={p.gender}>
            {p.name}{showAverages ? ` · L${p.skill_level}` : ''}
          </Chip>
        ))}
      </div>

      <div className="court-divider" />

      <div className="court-row">
        {team2.map(p => (
          <Chip key={p.id} gender={p.gender}>
            {p.name}{showAverages ? ` · L${p.skill_level}` : ''}
          </Chip>
        ))}
      </div>
    </div>
  );
};

/* ============ Full-screen Display ============ */
function DisplayView({
  round, secondsLeft, warnSeconds, blink,
  matches, benched, presentCount
}) {
  const timerClass = secondsLeft === 0
    ? (blink ? 'display-timer blink' : 'display-timer')
    : (secondsLeft <= warnSeconds ? 'display-timer warn' : 'display-timer');

  return (
    <div className="display-root">
      <div className="display-header">
        <div className="display-title">🏸 TheFLOminton System</div>
        <div className="display-center">
          <div className="display-round">Round {round}</div>
          <div className={timerClass}>{formatTime(secondsLeft)}</div>
          <div className="display-present">{presentCount} present</div>
        </div>
      </div>

      <div className="display-courts">
        {matches.map(m => (
          <div key={m.court} className="display-court">
            <div className="display-court-title">Court {m.court}</div>
            <div className="display-team-row">
              {m.team1.map(p => <span key={p.id} className={`display-chip ${p.gender==='F'?'f':'m'}`}>{p.name}</span>)}
            </div>
            <div className="display-divider" />
            <div className="display-team-row">
              {m.team2.map(p => <span key={p.id} className={`display-chip ${p.gender==='F'?'f':'m'}`}>{p.name}</span>)}
            </div>
          </div>
        ))}
        {matches.length === 0 && (
          <div className="display-wait">Waiting for matches…</div>
        )}
      </div>

      <div className="display-benched">
        {benched.map(p => (
          <span key={p.id} className={`display-benched-chip ${p.gender==='F'?'f':'m'}`}>{p.name}</span>
        ))}
      </div>
    </div>
  );
}

/* ============ Summary / Diagnostics (unchanged) ============ */
function SummaryModal({ open, onClose, isAdmin, history, playersSnapshot }) {
  const [tab, setTab] = useState('summary');
  if (!open) return null;

  const rounds = history.length;
  const participants = new Set();
  const benchesByPlayer = new Map();
  const playedByPlayer = new Map();
  const teammatePairs = new Map();
  const opponentPairs = new Map();

  for (const h of history) {
    h.matches.forEach(m => {
      [...m.team1, ...m.team2].forEach(p => { participants.add(p.id); });
      const t1 = m.team1.map(p=>p.id);
      const t2 = m.team2.map(p=>p.id);
      for (let i=0;i<t1.length;i++) for (let j=i+1;j<t1.length;j++){
        const k = [t1[i],t1[j]].sort().join('-'); teammatePairs.set(k,(teammatePairs.get(k)||0)+1);
      }
      for (let i=0;i<t2.length;i++) for (let j=i+1;j<t2.length;j++){
        const k = [t2[i],t2[j]].sort().join('-'); teammatePairs.set(k,(teammatePairs.get(k)||0)+1);
      }
      t1.forEach(a => t2.forEach(b => {
        const k = [a,b].sort().join('-'); opponentPairs.set(k,(opponentPairs.get(k)||0)+1);
      }));
      [...t1, ...t2].forEach(id => playedByPlayer.set(id, (playedByPlayer.get(id)||0)+1));
    });
    h.benchedIds.forEach(id => benchesByPlayer.set(id, (benchesByPlayer.get(id)||0)+1));
  }

  const summaryRows = playersSnapshot.map(p => ({
    id: p.id, name: p.name, lvl: p.skill_level,
    played: playedByPlayer.get(p.id)||0,
    benched: benchesByPlayer.get(p.id)||0,
  })).sort((a,b)=> b.played - a.played || a.name.localeCompare(b.name));

  const uniqueTeammatesCount = (id) => {
    const s = new Set();
    teammatePairs.forEach((v,k) => {
      const [a,b] = k.split('-');
      if (a===id) s.add(b);
      if (b===id) s.add(a);
    });
    return s.size;
  };
  const uniqueOpponentsCount = (id) => {
    const s = new Set();
    opponentPairs.forEach((v,k) => {
      const [a,b] = k.split('-');
      if (a===id) s.add(b);
      if (b===id) s.add(a);
    });
    return s.size;
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card wide" onClick={e=>e.stopPropagation()}>
        <div className="hrow" style={{justifyContent:'space-between', alignItems:'center'}}>
          <h3 className="modal-title">Smart Session Summary</h3>
          <div className="hrow" style={{gap:8}}>
            <Button onClick={()=>setTab('summary')} kind={tab==='summary'?'primary':'ghost'}>Summary</Button>
            {isAdmin && <Button onClick={()=>setTab('diagnostics')} kind={tab==='diagnostics'?'primary':'ghost'}>Diagnostics</Button>}
            <Button onClick={onClose}>Close</Button>
          </div>
        </div>

        {tab === 'summary' && (
          <div>
            <div className="two-col">
              <div>
                <h4>Overview</h4>
                <div>Rounds: <b>{rounds}</b></div>
                <div>Participants: <b>{participants.size}</b></div>
              </div>
              <div>
                <h4>Fairness</h4>
                <div>Avg benches / player: <b>{
                  (playersSnapshot.length
                    ? (Array.from(benchesByPlayer.values()).reduce((s,x)=>s+x,0) / playersSnapshot.length).toFixed(2)
                    : '0.00')
                }</b></div>
              </div>
            </div>

            <div className="table">
              <div className="thead">
                <div>Name</div><div>Lvl</div><div>Played</div><div>Benched</div><div>Uniq teammates</div><div>Uniq opponents</div>
              </div>
              {summaryRows.map(r => (
                <div key={r.id} className="trow">
                  <div>{r.name}</div>
                  <div>{r.lvl}</div>
                  <div>{r.played}</div>
                  <div>{r.benched}</div>
                  <div>{uniqueTeammatesCount(r.id)}</div>
                  <div>{uniqueOpponentsCount(r.id)}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {tab === 'diagnostics' && isAdmin && (
          <div>
            <h4>System Diagnostics</h4>
            <div className="muted">Rounds logged: {history.length}.</div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ============ Main App ============ */
export default function App() {
  const API = '/.netlify/functions/players';

  const [players, setPlayers] = useState([]);
  const [loading, setLoading] = useState(true);

  const [round, setRound] = useState(1);
  const [courts, setCourts] = useState(4);
  const [matches, setMatches] = useState([]);
  const [benched, setBenched] = useState([]);

  const [secondsLeft, setSecondsLeft] = useState(12*60);
  const [running, setRunning] = useState(false);
  const [blink, setBlink] = useState(false);

  const [isAdmin, setIsAdmin] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [displayOpen, setDisplayOpen] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);

  const [settings, setSettings] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('flo.settings') || '{}');
      return {
        roundMinutes: saved.roundMinutes ?? 12,
        warnSeconds:  saved.warnSeconds  ?? 30,
        autoAdvance:  saved.autoAdvance  ?? true,
        autoRebuild:  saved.autoRebuild  ?? true,
      };
    } catch { return { roundMinutes: 12, warnSeconds: 30, autoAdvance: true, autoRebuild: true }; }
  });

  const [matchMode, setMatchModeState] = useState(getMatchMode());
  const setMatchMode = (m) => { setMatchModeState(m); persistMatchMode(m); };

  const lastRoundBenched = useRef(new Set());
  const [history, setHistory] = useState([]);

  const audioCtxRef = useRef(null);
  const beep = useRef(()=>{});
  useEffect(() => {
    beep.current = (hz=880, ms=140) => {
      if (!audioCtxRef.current) audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
      const ctx = audioCtxRef.current, t = ctx.currentTime;
      const osc = ctx.createOscillator(); const g = ctx.createGain();
      osc.type='sine'; osc.frequency.setValueAtTime(hz, t);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.25, t+0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t+ms/1000);
      osc.connect(g); g.connect(ctx.destination);
      osc.start(t); osc.stop(t+ms/1000);
    };
  }, []);

  const fetchPlayers = async () => {
    setLoading(true);
    try {
      const res = await fetch(API);
      const data = await res.json();
      const norm = data.map(p => ({
        id: p.id, name: p.name, gender: p.gender || 'M',
        skill_level: Number(p.skill_level || 1),
        is_present: !!p.is_present,
        bench_count: Number(p.bench_count || 0),
        last_played_round: Number(p.last_played_round || 0),
        created_at: p.created_at
      }));
      setPlayers(norm.sort((a,b)=>a.name.localeCompare(b.name)));
    } catch (e) {
      alert('Supabase error: ' + (e?.message || 'Failed to fetch'));
    } finally { setLoading(false); }
  };
  useEffect(() => { fetchPlayers(); }, []);

  const present = useMemo(() => players.filter(p => p.is_present), [players]);

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => {
      setSecondsLeft(s => {
        if (s <= 1) {
          clearInterval(id);
          setRunning(false);
          setBlink(true);
          beep.current(1000, 220); setTimeout(()=>beep.current(700, 220), 260); setTimeout(()=>beep.current(500, 320), 560);
          if (settings.autoAdvance) setTimeout(() => nextRound(true), 800);
          return 0;
        }
        if (s-1 === settings.warnSeconds) beep.current(1300, 120);
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [running, settings.autoAdvance, settings.warnSeconds]);

  const buildRound = () => {
    const { playing, benched: justBenched } =
      selectPlayersForRound(present, round, lastRoundBenched.current, courts);
    lastRoundBenched.current = new Set(justBenched.map(p => p.id));
    const built = buildMatchesFrom16(playing, undefined, courts);
    setMatches(built);
    setBenched(justBenched);

    const byIdPlaying = new Set(playing.map(p=>p.id));
    setPlayers(prev => prev.map(p => {
      if (byIdPlaying.has(p.id)) return { ...p, last_played_round: round };
      if (justBenched.find(x => x.id === p.id)) return { ...p, bench_count: (p.bench_count|0) + 1 };
      return p;
    }));

    setHistory(prev => prev.concat([{
      round,
      matches: built.map(m => ({
        court: m.court,
        team1: m.team1.map(p => ({ id:p.id, name:p.name, gender:p.gender, skill_level:p.skill_level })),
        team2: m.team2.map(p => ({ id:p.id, name:p.name, gender:p.gender, skill_level:p.skill_level })),
      })),
      benchedIds: justBenched.map(p=>p.id),
    }]));
  };

  const startNight = () => {
    setRound(1);
    setSecondsLeft(settings.roundMinutes * 60);
    setBlink(false);
    setHistory([]);
    setPlayers(prev => prev.map(p => ({ ...p, bench_count: 0, last_played_round: 0 })));
    setTimeout(() => { buildRound(); setRunning(true); }, 60);
  };
  const pause = () => setRunning(false);
  const resume = () => {
    if (secondsLeft === 0) nextRound(true);
    else { setBlink(false); setRunning(true); }
  };
  const nextRound = (auto=false) => {
    setBlink(false);
    setRound(r => r + 1);
    setSecondsLeft(settings.roundMinutes * 60);
    if (settings.autoRebuild || auto) buildRound();
    setRunning(true);
  };
  const endNight = () => {
    setRunning(false);
    setBlink(false);
    setSummaryOpen(true);
  };

  const togglePresent = (p) => {
    setPlayers(prev => prev.map(x => x.id === p.id ? { ...x, is_present: !x.is_present } : x));
  };

  const [saving, setSaving] = useState(false);
  const saveAll = async () => {
    setSaving(true);
    try {
      const body = {
        updates: players.map(p => ({
          id: p.id,
          fields: {
            is_present: !!p.is_present,
            bench_count: p.bench_count|0,
            last_played_round: p.last_played_round|0,
            skill_level: p.skill_level|0,
          }
        }))
      };
      const res = await fetch('/.netlify/functions/players', {
        method:'PATCH', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error('Failed to save round updates: ' + txt.slice(0,300));
      }
    } catch (e) {
      alert(e.message);
    } finally { setSaving(false); }
  };

  const timerClass = useMemo(() => {
    if (secondsLeft === 0) return blink ? 'timer blink' : 'timer';
    if (secondsLeft <= settings.warnSeconds) return 'timer warn';
    return 'timer';
  }, [secondsLeft, settings.warnSeconds, blink]);

  return (
    <div className="page">
      {/* Toolbar */}
      <div className="toolbar">
        <div className="toolbar-left">
          <div className="app-title-left">🏸 TheFLOminton System</div>
          <div className="hrow" style={{gap:8}}>
            <Button kind="primary" onClick={startNight}>Start Night</Button>
            <Button onClick={pause}>Pause</Button>
            <Button onClick={resume}>Resume</Button>
            <Button onClick={() => nextRound(false)}>Next Round</Button>
            <Button kind="danger" onClick={endNight}>End Night</Button>
          </div>
        </div>

        <div className="toolbar-center">
          <div className="round-pill">Round {round}</div>
          <div className={timerClass}>{formatTime(secondsLeft)}</div>
        </div>

        <div className="toolbar-right">
          <Button onClick={()=>setDisplayOpen(true)}>Open Display</Button>
          {isAdmin && (
            <div className="hrow" style={{gap:8}}>
              <label className="muted">Mode:</label>
              <select className="input sm" value={matchMode} onChange={e => setMatchMode(e.target.value)}>
                <option value={MATCH_MODES.BAND}>Band</option>
                <option value={MATCH_MODES.WINDOW}>Window</option>
              </select>
            </div>
          )}
          <Button onClick={() => setSettingsOpen(true)}>Settings</Button>
          <Button onClick={() => setIsAdmin(a=>!a)}>{isAdmin ? 'Admin ON' : 'Admin'}</Button>
        </div>
      </div>

      {/* Courts */}
      <div className="grid2 grid-courts">
        {matches.map(m => (
          <Court key={m.court} court={m.court} match={m} showAverages={isAdmin} />
        ))}
        {matches.length === 0 && (
          <div className="muted" style={{gridColumn:'1 / -1', textAlign:'center', padding:20}}>
            {loading ? 'Loading…' : 'No matches yet — click Start Night.'}
          </div>
        )}
      </div>

      {/* Benched */}
      <div className="card">
        <div className="card-head">Benched Players</div>
        <div className="benched-strip">
          {benched.map(p => (
            <Chip key={p.id} gender={p.gender}>
              {p.name}{isAdmin ? ` · ${p.bench_count|0}` : ''}
            </Chip>
          ))}
          {benched.length === 0 && <span className="muted">No one benched this round</span>}
        </div>
      </div>

      {/* Player lists */}
      <div className="grid2 gap16">
        <div className="card">
          <div className="card-head">
            All Players <span className="badge">{players.length - present.length}</span>
          </div>
          <div className="list">
            {players.filter(p=>!p.is_present).map(p => (
              <div key={p.id} className="list-row" onDoubleClick={() => togglePresent(p)} title="Double-click to mark present">
                <Chip gender={p.gender}>{p.name}</Chip>
                <div className="spacer" />
                {isAdmin && <span className="muted">Benched {p.bench_count|0}</span>}
              </div>
            ))}
          </div>
        </div>

        <div className="card">
          <div className="card-head">
            Present Today <span className="badge">{present.length}</span>
          </div>
          <div className="list">
            {present.map(p => (
              <div key={p.id} className="list-row" onDoubleClick={() => togglePresent(p)} title="Double-click to unmark">
                <Chip gender={p.gender}>{p.name}</Chip>
                <div className="spacer" />
                {isAdmin && <span className="muted">Benched {p.bench_count|0}</span>}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Admin area */}
      {isAdmin && (
        <div className="card">
          <div className="card-head">Admin Controls</div>
          <div className="hrow wrap" style={{gap:8}}>
            <Button onClick={saveAll} disabled={saving}>{saving ? 'Saving…' : 'Save All'}</Button>
            <Button onClick={buildRound}>Rebuild Matches</Button>
            <label className="hrow" style={{gap:8}}>
              Courts:
              <input
                className="input sm"
                type="number" min={1} max={8}
                value={courts}
                onChange={e => setCourts(Math.max(1, Math.min(8, Number(e.target.value||1))))}
              />
            </label>
          </div>
        </div>
      )}

      {/* Settings */}
      <SettingsDialog
        open={settingsOpen}
        initial={settings}
        onSave={(next) => {
          setSettings(next);
          try { localStorage.setItem('flo.settings', JSON.stringify(next)); } catch {}
          setSettingsOpen(false);
          if (!running) setSecondsLeft(next.roundMinutes * 60);
        }}
        onClose={() => setSettingsOpen(false)}
        matchMode={matchMode}
        setMatchMode={setMatchMode}
      />

      {/* Display overlay */}
      {displayOpen && (
        <div className="display-overlay">
          <div className="display-close">
            <Button onClick={()=>setDisplayOpen(false)} kind="primary">Close Display</Button>
          </div>
          <DisplayView
            round={round}
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
        onClose={()=>setSummaryOpen(false)}
        isAdmin={isAdmin}
        history={history}
        playersSnapshot={players}
      />
    </div>
  );
}
