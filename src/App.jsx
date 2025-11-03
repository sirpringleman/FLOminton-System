import React, { useEffect, useMemo, useRef, useState } from 'react';
import './App.css';
import {
  MATCH_MODES,
  getMatchMode, setMatchMode,
  selectPlayersForRound,
  buildMatchesFrom16,
  fairnessStats,
  roundDiagnostics,
  perPlayerUniq,
  perPlayerUniqLastN,
  countBackToBackBenches,
  formatTime,
} from './logic';

// ========================== API layer (Netlify function) ==========================
const API = '/.netlify/functions/players';
// Expect the function to support:
//   GET    -> returns array of players
//   PATCH  -> body: { updates: [{ id, fields: {...} }, ...] }    (update many)
//   POST   -> body: { players: [ ... ] }                         (upsert many)
//   DELETE -> body: { id }                                       (hard delete one)

async function apiGetPlayers() {
  const r = await fetch(API);
  if (!r.ok) throw new Error(`GET ${API} failed`);
  return await r.json();
}
async function apiPatch(updates) {
  const r = await fetch(API, {
    method: 'PATCH',
    headers: { 'Content-Type':'application/json' },
    body: JSON.stringify({ updates })
  });
  if (!r.ok) throw new Error('PATCH failed');
  return await r.json();
}
async function apiUpsert(players) {
  const r = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type':'application/json' },
    body: JSON.stringify({ players })
  });
  if (!r.ok) throw new Error('POST failed');
  return await r.json();
}
async function apiDelete(id) {
  const r = await fetch(API, {
    method: 'DELETE',
    headers: { 'Content-Type':'application/json' },
    body: JSON.stringify({ id })
  });
  if (!r.ok) throw new Error('DELETE failed');
  return await r.json();
}

// ========================== Local persistence helpers ==========================
const LS = {
  showLevels: 'flo_show_levels',
  adminOn:    'flo_admin_on',
  mode:       'flomatch_mode',
  roundSecs:  'flo_round_secs',
  transSecs:  'flo_transition_secs',
  courts:     'flo_courts',
  soundOn:    'flo_sound_on',
  warnSecs:   'flo_warn_secs',
};
const getLS = (k, d=null) => {
  try { const v = localStorage.getItem(k); return v===null?d:JSON.parse(v); } catch { return d; }
};
const setLS = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

// ========================== Sound ==========================
function useBeep() {
  const ctxRef = useRef(null);
  useEffect(()=>()=>{ try{ctxRef.current && ctxRef.current.close();}catch{} },[]);
  return (freq=880, ms=160, volume=0.04) => {
    try {
      if (!ctxRef.current) ctxRef.current = new (window.AudioContext||window.webkitAudioContext)();
      const ctx = ctxRef.current;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = freq;
      g.gain.value = volume;
      o.connect(g); g.connect(ctx.destination);
      o.start();
      setTimeout(()=>{ try{o.stop();}catch{} }, ms);
    } catch {}
  };
}

// ========================== UI helpers ==========================
const badge = (txt) => <span className="badge">{txt}</span>;

const chip = (p, showLevel) => (
  <span key={p.id} className={`chip ${p.gender==='F' ? 'chipF' : 'chipM'}`}>
    {p.name}{showLevel ? ` · L${p.skill_level}` : ''}
  </span>
);

// ========================== Main App ==========================
export default function App() {
  // -------- global state
  const [view, setView] = useState('home'); // home | session | display
  const [players, setPlayers] = useState([]);
  const [loading, setLoading] = useState(true);

  // admin + visibility
  const [admin, setAdmin] = useState(getLS(LS.adminOn,false));
  const [showLevels, setShowLevels] = useState(getLS(LS.showLevels,false));
  const ADMIN_PIN = import.meta?.env?.VITE_ADMIN_PIN || '1234';

  // settings
  const [courts, setCourts] = useState(getLS(LS.courts, 4));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [roundSeconds, setRoundSeconds] = useState(getLS(LS.roundSecs, 12*60));
  const [transitionSecs, setTransitionSecs] = useState(getLS(LS.transSecs, 30));
  const [soundOn, setSoundOn] = useState(getLS(LS.soundOn, true));
  const [warnSecs, setWarnSecs] = useState(getLS(LS.warnSecs, 30));

  // session
  const [round, setRound] = useState(1);
  const [mode, _setMode] = useState(getMatchMode());
  const setMode = (m)=>{ _setMode(m); setMatchMode(m); };

  // timer
  const [timeLeft, setTimeLeft] = useState(roundSeconds);
  const [running, setRunning] = useState(false);
  const [transition, setTransition] = useState(false); // 30s inter-round
  const mainTimerRef = useRef(null);
  const transTimerRef = useRef(null);

  // session data
  const [presentIds, setPresentIds] = useState(new Set());
  const present = useMemo(()=> players.filter(p=>presentIds.has(p.id)), [players, presentIds]);
  const [matches, setMatches] = useState([]);            // current round matches (show during round AND transition)
  const [nextMatches, setNextMatches] = useState([]);    // (not used now; we prebuild directly into matches)
  const [benched, setBenched] = useState([]);            // current round bench
  const [lastBenchedSet, setLastBenchedSet] = useState(new Set());
  const [history, setHistory] = useState([]);            // [{round,court,team1,team2,avg1,avg2}]
  const [benchedSeq, setBenchedSeq] = useState([]);      // [{round, ids:Set()}]
  const teammateHistoryRef = useRef(new Map());          // pair -> timestamps
  const [diagByRound, setDiagByRound] = useState([]);    // [{round, buildMs, avgDiff, usedCourts, spans, diffs}]

  const beep = useBeep();

  // ------------- load players
  useEffect(() => {
    (async ()=>{
      setLoading(true);
      try {
        const data = await apiGetPlayers();
        setPlayers(data || []);
        // restore present from DB
        const preset = new Set((data||[]).filter(p=>p.is_present).map(p=>p.id));
        setPresentIds(preset);
      } catch (e) {
        alert('Could not load players (Netlify function). Check logs / env.');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // ------------- persist toggles
  useEffect(()=> setLS(LS.adminOn, admin), [admin]);
  useEffect(()=> setLS(LS.showLevels, showLevels), [showLevels]);
  useEffect(()=> setLS(LS.roundSecs, roundSeconds), [roundSeconds]);
  useEffect(()=> setLS(LS.transSecs, transitionSecs), [transitionSecs]);
  useEffect(()=> setLS(LS.courts, courts), [courts]);
  useEffect(()=> setLS(LS.soundOn, soundOn), [soundOn]);
  useEffect(()=> setLS(LS.warnSecs, warnSecs), [warnSecs]);

  // ------------- timer loop
  useEffect(()=>{
    clearInterval(mainTimerRef.current);
    if (!running) return;
    mainTimerRef.current = setInterval(()=>{
      setTimeLeft(prev=>{
        const nxt = prev - 1;
        if (nxt > 0) {
          // last warn?
          if (soundOn && nxt === warnSecs) beep(660,120,0.05);
          return nxt;
        }
        // reached 0 -> end-of-round (prebuild next here; show during transition)
        clearInterval(mainTimerRef.current);
        onRoundTimeExpired();
        return 0;
      });
    }, 1000);
    return ()=> clearInterval(mainTimerRef.current);
  }, [running, warnSecs, soundOn]);

  // ------------- convenience flags
  const isHome = view === 'home';
  const isSession = view === 'session';
  const isDisplay = view === 'display';
  const timerColor = !running && transition
    ? ((timeLeft % 2) ? '#ffffff' : '#ff4d6d')       // blinking red/white during transition
    : (running && timeLeft <= warnSecs ? '#ffd166' : '#e6f1ff'); // yellow in last warn window

  // ===================== Actions =====================

  function goHome() {
    setView('home');
    stopAllTimers();
    setTimeLeft(roundSeconds);
  }

  function stopAllTimers(){
    setRunning(false);
    setTransition(false);
    clearInterval(mainTimerRef.current);
    clearInterval(transTimerRef.current);
  }

  function beginNight() {
    setRound(1);
    setHistory([]);
    setBenchedSeq([]);
    setLastBenchedSet(new Set());
    // DO NOT reset bench_count here; only when End Night
    setView('session');
    stopAllTimers();
    setTimeLeft(roundSeconds);
  }

  function openDisplay(){
    setView('display');
  }

  async function endNight() {
    try {
      stopAllTimers();
      // Prepare Smart Session Summary + Diagnostics first
      const summary = buildSmartSummary();
      const diag = buildDiagnostics();

      // Show combined modal
      await showSummaryModal(summary, diag);

      // Clear session state; unmark all present; reset bench counts to 0 as requested
      const updates = players.map(p => ({
        id: p.id,
        fields: { is_present: false, bench_count: 0, last_played_round: 0 }
      }));
      await apiPatch(updates);

      // update local
      setPlayers(ps => ps.map(p => ({ ...p, is_present:false, bench_count:0, last_played_round:0 })));
      setPresentIds(new Set());
      setMatches([]);
      setBenched([]);
      setHistory([]);
      setDiagByRound([]);
      setBenchedSeq([]);
      setLastBenchedSet(new Set());
      setTimeLeft(roundSeconds);

      goHome();
    } catch (e) {
      alert('Failed to end night (save or modal). Check console.');
      console.error(e);
    }
  }

  function toggleMode() {
    setMode(mode === MATCH_MODES.BAND ? MATCH_MODES.WINDOW : MATCH_MODES.BAND);
  }

  // Build or resume:
  // - If no matches built for this round, build now and start round timer (skip transition).
  // - If paused, resume.
  async function buildOrResume() {
    try {
      if (!matches.length) {
        await buildNextRound({ viaTransition:false });
      }
      setRunning(true);
    } catch (e) {
      alert('Build/Resume failed. Check console.');
      console.error(e);
    }
  }

  // Skip transition, build next immediately
  async function nextRound() {
    try {
      await buildNextRound({ viaTransition:false, forceNextRoundIncrement:true });
      setRunning(true);
    } catch (e) {
      alert('Next Round failed.');
      console.error(e);
    }
  }

  // Core builder (also used by transition)
  async function buildNextRound({ viaTransition, forceNextRoundIncrement = false }) {
    // If viaTransition: we are building *for the upcoming round*, show immediately during transition.
    if (present.length < 4) {
      setMatches([]); setBenched(present.slice());
      return;
    }
    const targetRound = forceNextRoundIncrement ? (round + 1) : (viaTransition ? (round + 1) : round);

    const t0 = performance.now();
    // Select players fairly
    const { playing, benched: bench } = selectPlayersForRound(
      present, targetRound, lastBenchedSet, courts
    );
    // Build matches with current mode
    let ms = buildMatchesFrom16(playing, teammateHistoryRef.current, courts, mode);

    // Duplicate guard (shouldn’t happen, but protect UI)
    const idsSeen = new Set();
    ms = ms.map(m=>{
      const t1 = []; const t2 = [];
      for (const p of m.team1) if (!idsSeen.has(p.id)) { idsSeen.add(p.id); t1.push(p); }
      for (const p of m.team2) if (!idsSeen.has(p.id)) { idsSeen.add(p.id); t2.push(p); }
      return { ...m, team1:t1, team2:t2 };
    });

    // Persist bench_count++ for benched; update last_played_round for playing
    const updates = [];
    const benchIds = new Set(bench.map(b => b.id));
    for (const p of present) {
      if (benchIds.has(p.id)) {
        updates.push({ id:p.id, fields:{ bench_count: (p.bench_count||0)+1 }});
      } else if (playing.find(x=>x.id===p.id)) {
        updates.push({ id:p.id, fields:{ last_played_round: targetRound }});
      }
    }
    await apiPatch(updates);

    // Update local cache mirrors
    setPlayers(ps => ps.map(p=>{
      if (benchIds.has(p.id)) return { ...p, bench_count:(p.bench_count||0)+1 };
      if (playing.find(x=>x.id===p.id)) return { ...p, last_played_round: targetRound };
      return p;
    }));

    // Assign to UI
    setMatches(ms);
    setBenched(bench);
    setLastBenchedSet(new Set(bench.map(b=>b.id)));
    setBenchedSeq(seq => [...seq, { round: targetRound, ids: new Set(bench.map(b=>b.id)) }]);

    // Log round to history for summary/diagnostics
    const built = ms.map(m=>({
      round: targetRound, court: m.court, team1: m.team1, team2: m.team2, avg1:m.avg1, avg2:m.avg2
    }));
    setHistory(h => [...h, ...built]);

    // Per-round diagnostics
    const diag = roundDiagnostics(ms, Math.max(0, Math.round(performance.now() - t0)));
    setDiagByRound(prev=>{
      const rest = prev.filter(x=>x.round!==targetRound);
      return [...rest, { round: targetRound, ...diag }].sort((a,b)=>a.round-b.round);
    });

    if (!viaTransition) {
      // in-round build
      setTransition(false);
      setTimeLeft(roundSeconds);
      if (forceNextRoundIncrement) setRound(r=>r+1);
      setRunning(true);
    }
  }

  function onRoundTimeExpired() {
    // Round phase ended -> prebuild next round NOW so it shows during transition
    if (soundOn) beep(880,160,0.06);
    setRunning(false);
    setTransition(true);

    // Build next round for display during the 30s
    buildNextRound({ viaTransition:true }).then(()=>{
      // Begin blinking transition countdown
      setTimeLeft(transitionSecs);
      clearInterval(transTimerRef.current);
      transTimerRef.current = setInterval(()=>{
        setTimeLeft(prev=>{
          if (prev>0) return prev-1;
          clearInterval(transTimerRef.current);
          onTransitionExpired();
          return 0;
        });
      }, 1000);
    }).catch(e=>{
      console.error('Prebuild during transition failed', e);
      // Still start transition timer to avoid deadlock
      setTimeLeft(transitionSecs);
      clearInterval(transTimerRef.current);
      transTimerRef.current = setInterval(()=>{
        setTimeLeft(prev=>{
          if (prev>0) return prev-1;
          clearInterval(transTimerRef.current);
          onTransitionExpired();
          return 0;
        });
      }, 1000);
    });
  }

  async function onTransitionExpired() {
    // Transition ended -> start the new round we already built
    if (soundOn) beep(1200,220,0.07);
    setTransition(false);
    setRound(r => r+1); // increment when the new round actually starts
    setTimeLeft(roundSeconds);
    setRunning(true);
  }

  // Toggle present by double-click in either list
  function togglePresent(id) {
    const newSet = new Set(presentIds);
    if (newSet.has(id)) newSet.delete(id); else newSet.add(id);
    setPresentIds(newSet);
    // mirror to players list (is_present field)
    setPlayers(ps => ps.map(p => p.id===id ? { ...p, is_present: newSet.has(id) } : p));
    // persist small single update
    apiPatch([{ id, fields:{ is_present: newSet.has(id) }}]).catch(()=>{});
  }

  // Admin auth
  function requestAdmin() {
    const pin = window.prompt('Enter Admin PIN');
    if (pin === ADMIN_PIN) setAdmin(true);
    else alert('Wrong PIN');
  }

  // CRUD in Admin Controls (inline)
  function addPlayerInline() {
    const newPlayer = {
      id: crypto.randomUUID(),
      name: 'New Player',
      gender: 'M',
      skill_level: 5,
      is_present: false,
      bench_count: 0,
      last_played_round: 0,
      created_at: new Date().toISOString()
    };
    setPlayers(ps => [...ps, newPlayer]);
    apiUpsert([newPlayer]).catch(()=>{});
  }
  function updatePlayerField(id, field, value) {
    setPlayers(ps => ps.map(p => p.id===id ? { ...p, [field]: value } : p));
  }
  function savePlayerRow(id) {
    const p = players.find(x=>x.id===id);
    if (!p) return;
    apiUpsert([p]).catch(()=> alert('Save failed'));
  }
  async function deletePlayerRow(id) {
    if (!window.confirm('Delete this player?')) return;
    try {
      await apiDelete(id);
      setPlayers(ps => ps.filter(p=>p.id!==id));
      setPresentIds(s=>{ const n=new Set(s); n.delete(id); return n; });
    } catch (e) {
      alert('Delete failed');
    }
  }

  // ============== Smart Session Summary & Diagnostics ==============
  function buildSmartSummary() {
    const pres = players.filter(p => presentIds.has(p.id));
    const fair = fairnessStats(pres);
    const uniqAll = perPlayerUniq(history, new Set(pres.map(p=>p.id)));
    const uniqLastN = perPlayerUniqLastN(history, Infinity, new Set(pres.map(p=>p.id)));
    const streaks = countBackToBackBenches(benchedSeq);

    const rows = pres.map(p => {
      const played = history.filter(h => [...(h.team1||[]), ...(h.team2||[])].find(x=>x.id===p.id)).length;
      const bCount = p.bench_count || 0;
      const uAll = uniqAll[p.id] || { uniqTeammates:0, uniqOpponents:0 };
      const uN   = uniqLastN[p.id] || { uniqTeammates:0, uniqOpponents:0 };
      return {
        id: p.id,
        name: p.name,
        level: p.skill_level,
        played,
        benched: bCount,
        worstBenchStreak: streaks[p.id] || 0,
        uniqTeammatesAll: uAll.uniqTeammates,
        uniqOpponentsAll: uAll.uniqOpponents,
        uniqTeammatesN: uN.uniqTeammates,
        uniqOpponentsN: uN.uniqOpponents,
      };
    }).sort((a,b)=> b.played - a.played || a.name.localeCompare(b.name));

    // Aggregate diagnostics across rounds
    const diagAgg = {
      rounds: diagByRound.length,
      avgBuildMs: Number(avg(diagByRound.map(d=>d.buildMs||0)).toFixed(1)),
      avgTeamDiff: Number(avg(diagByRound.map(d=>d.avgDiff||0)).toFixed(2)),
      maxSpan: Math.max(0, ...diagByRound.flatMap(d=>d.spans||[0])),
    };

    return {
      overview: {
        rounds: round,
        presentCount: pres.length,
        mode,
        courts,
      },
      fairness: fair,
      diagAgg,
      diagPerRound: diagByRound.slice().sort((a,b)=>a.round-b.round),
      rows
    };
  }

  function buildDiagnostics() {
    // last-round diagnostic is in diagByRound already
    const last = diagByRound.length ? diagByRound[diagByRound.length-1] : {};
    return { last };
  }

  function showSummaryModal(summary, diag) {
    return new Promise((resolve)=>{
      const html = document.createElement('div');
      html.className = 'modalMask';
      html.innerHTML = `
        <div class="modalCard">
          <h2>Smart Session Summary</h2>
          <div class="grid2">
            <div>
              <h3>Overview</h3>
              <div>Rounds: <b>${summary.overview.rounds}</b></div>
              <div>Participants: <b>${summary.overview.presentCount}</b></div>
              <div>Mode: <b>${summary.overview.mode}</b> &nbsp; Courts: <b>${summary.overview.courts}</b></div>
              <h3 style="margin-top:12px;">Fairness</h3>
              <div>Mean benches: <b>${summary.fairness.mean}</b> &nbsp; StDev: <b>${summary.fairness.stdev}</b> &nbsp; Spread: <b>${summary.fairness.spread}</b></div>
            </div>
            <div>
              <h3>Diagnostics (aggregate)</h3>
              <div>Rounds analysed: <b>${summary.diagAgg.rounds}</b></div>
              <div>Avg build time: <b>${summary.diagAgg.avgBuildMs} ms</b></div>
              <div>Avg team diff: <b>${summary.diagAgg.avgTeamDiff}</b></div>
              <div>Max skill span in a quad: <b>${summary.diagAgg.maxSpan}</b></div>
              <h3 style="margin-top:12px;">Last round</h3>
              <div>Avg team diff: <b>${diag?.last?.avgDiff ?? '-'}</b></div>
              <div>Courts used: <b>${diag?.last?.usedCourts ?? '-'}</b></div>
              <div>Skill spans: <b>${(diag?.last?.spans||[]).join(', ')}</b></div>
            </div>
          </div>

          <h3 style="margin:16px 0 6px;">Per-player (Present)</h3>
          <table class="sumTable">
            <thead>
              <tr>
                <th>Name</th><th>Lvl</th><th>Played</th><th>Benched</th><th>Worst Bench Streak</th>
                <th>Uniq Tm (All)</th><th>Uniq Opp (All)</th>
                <th>Uniq Tm (N)</th><th>Uniq Opp (N)</th>
              </tr>
            </thead>
            <tbody>
              ${summary.rows.map(r=>`
                <tr>
                  <td>${r.name}</td>
                  <td>${r.level}</td>
                  <td>${r.played}</td>
                  <td>${r.benched}</td>
                  <td>${r.worstBenchStreak}</td>
                  <td>${r.uniqTeammatesAll}</td>
                  <td>${r.uniqOpponentsAll}</td>
                  <td>${r.uniqTeammatesN}</td>
                  <td>${r.uniqOpponentsN}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>

          <div style="text-align:right; margin-top:16px;">
            <button id="flo-close" class="btn primary">Close</button>
          </div>
        </div>
      `;
      document.body.appendChild(html);
      html.querySelector('#flo-close').onclick = ()=>{ document.body.removeChild(html); resolve(); };
    });
  }

  // ===================== Renders =====================

  function HeaderBar() {
    return (
      <div className="headerBar">
        <div className="leftBtns">
          {isHome ? (
            <>
              <button className="btn primary" onClick={beginNight}>Begin Night</button>
              <button className="btn" onClick={()=>setView('session')}>Session</button>
              <button className="btn" onClick={openDisplay}>Open Display</button>
              <button className="btn" onClick={()=> admin? setAdmin(false) : requestAdmin()}>{admin?'Exit Admin':'Admin'}</button>
              <button className="btn" onClick={()=>setSettingsOpen(true)}>Settings</button>
              <button className="btn" onClick={toggleMode}>Mode: {mode===MATCH_MODES.BAND?'Band':'Window'}</button>
            </>
          ) : (
            <>
              <button className="btn primary" onClick={buildOrResume}>Build/Resume</button>
              <button className="btn" onClick={()=>{ setRunning(false); }}>Pause</button>
              <button className="btn" onClick={nextRound}>Next Round</button>
              <button className="btn danger" onClick={endNight}>End Night</button>
              <button className="btn" onClick={openDisplay}>Open Display</button>
              <button className="btn" onClick={()=>setSettingsOpen(true)}>Settings</button>
              <button className="btn" onClick={toggleMode}>Mode: {mode===MATCH_MODES.BAND?'Band':'Window'}</button>
              <button className="btn" onClick={()=> admin? setAdmin(false) : requestAdmin()}>{admin?'Exit Admin':'Admin'}</button>
            </>
          )}
        </div>

        {/* Center Title + Timer + Present Count */}
        <div className="centerInfo">
          <div className="title">🏸 TheFLOminton System</div>
          <div className="timerWrap" style={{color: timerColor}}>
            {transition ? `Next in ${formatTime(timeLeft)}` : `${formatTime(timeLeft)}`} {isSession ? badge(`Round ${round}`) : null}
            &nbsp; {isSession ? badge(`${present.length} present`) : null}
          </div>
        </div>

        <div className="rightSpace" />
      </div>
    );
  }

  function CourtsGrid() {
    return (
      <div className="courtsGrid">
        {matches.map(m => (
          <div key={m.court} className="courtCard">
            <div className="courtTop">
              <div className="courtName">Court {m.court}</div>
              {admin && showLevels ? (
                <div className="avgInfo">
                  Team 1 Avg <b>{Number(m.avg1.toFixed(1))}</b> &nbsp;&nbsp;
                  Team 2 Avg <b>{Number(m.avg2.toFixed(1))}</b>
                </div>
              ) : null}
            </div>
            <div className="teamsWrap">
              <div>{m.team1.map(p=>chip(p, admin && showLevels))}</div>
              <div className="divider" />
              <div>{m.team2.map(p=>chip(p, admin && showLevels))}</div>
            </div>
          </div>
        ))}
      </div>
    );
  }

  function BenchedBar() {
    if (!benched.length) return null;
    return (
      <div className="benchedBar">
        <div className="benchedTitle">Benched Players</div>
        <div className="benchedWrap">
          {benched.map(p=>chip(p, admin && showLevels))}
        </div>
      </div>
    );
  }

  function DualLists() {
    const allList = players.filter(p=>!presentIds.has(p.id));
    const presentList = players.filter(p=>presentIds.has(p.id));

    return (
      <div className="dualGrid">
        <div className="panel">
          <div className="panelTop">
            <div className="panelTitle">All Players</div>
            <div>{badge(String(allList.length))}</div>
          </div>
          <div>
            {allList.map(p=>(
              <div key={p.id}
                   onDoubleClick={()=>togglePresent(p.id)}
                   className="rowClickable"
              >
                {chip(p, admin && showLevels)}
                {admin ? <span className="muted">Benched {p.bench_count||0}</span> : null}
              </div>
            ))}
          </div>
        </div>

        <div className="panel">
          <div className="panelTop">
            <div className="panelTitle">Present Today</div>
            <div>{badge(String(presentList.length))}</div>
          </div>
          <div>
            {presentList.map(p=>(
              <div key={p.id}
                   onDoubleClick={()=>togglePresent(p.id)}
                   className="rowClickable"
              >
                {chip(p, admin && showLevels)}
                {admin ? <span className="muted">Benched {p.bench_count||0}</span> : null}
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  function AdminPanel() {
    if (!admin) return null;
    return (
      <div className="adminPanel">
        <div className="adminTop">
          <div className="panelTitle">Admin Controls</div>
          <div className="adminBtns">
            <label className="toggleRow">
              <input type="checkbox" checked={showLevels} onChange={e=>setShowLevels(e.target.checked)} />
              <span>Show levels</span>
            </label>
            <label className="toggleRow">
              <input type="checkbox" checked={soundOn} onChange={e=>setSoundOn(e.target.checked)} />
              <span>Sound on</span>
            </label>
            <button className="btn" onClick={addPlayerInline}>Add Player</button>
          </div>
        </div>

        <div className="tableWrap">
          <table className="adminTable">
            <thead>
              <tr>
                <th>Name</th>
                <th>Gender</th>
                <th>Skill</th>
                <th>Present</th>
                <th>Benched</th>
                <th>Last Round</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {players.map(p=>(
                <tr key={p.id}>
                  <td><input className="txt" value={p.name} onChange={e=>updatePlayerField(p.id,'name',e.target.value)} /></td>
                  <td>
                    <select className="txt" value={p.gender||'M'} onChange={e=>updatePlayerField(p.id,'gender',e.target.value)}>
                      <option value="M">M</option>
                      <option value="F">F</option>
                    </select>
                  </td>
                  <td><input className="txt" type="number" min={1} max={10} value={p.skill_level} onChange={e=>updatePlayerField(p.id,'skill_level',Number(e.target.value||1))} /></td>
                  <td><input type="checkbox" checked={!!p.is_present} onChange={e=>updatePlayerField(p.id,'is_present',e.target.checked)} /></td>
                  <td>{p.bench_count||0}</td>
                  <td>{p.last_played_round||0}</td>
                  <td>
                    <button className="btn small" onClick={()=>savePlayerRow(p.id)}>Save</button>
                    <button className="btn small danger" onClick={()=>deletePlayerRow(p.id)}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  function SessionScreen() {
    return (
      <div className="screenPad">
        <CourtsGrid/>
        <BenchedBar/>
        <DualLists/>
        <AdminPanel/>
      </div>
    );
  }

  function HomeScreen() {
    return (
      <div className="screenPad">
        <div className="homeBtns">
          <button className="btn primary" onClick={beginNight}>Begin Night</button>
          <button className="btn" onClick={()=>setView('session')}>Session</button>
          <button className="btn" onClick={openDisplay}>Open Display</button>
          <button className="btn" onClick={()=> admin? setAdmin(false) : requestAdmin()}>{admin?'Exit Admin':'Admin'}</button>
          <button className="btn" onClick={()=>setSettingsOpen(true)}>Settings</button>
          <button className="btn" onClick={toggleMode}>Mode: {mode===MATCH_MODES.BAND?'Band':'Window'}</button>
        </div>
      </div>
    );
  }

  function DisplayScreen() {
    return (
      <div className="screenPad">
        {/* Timer centered, big, with present count */}
        <div className="displayHeader" style={{color: timerColor}}>
          <div className="displayTimer">
            {transition ? `Next in ${formatTime(timeLeft)}` : `${formatTime(timeLeft)}`}
          </div>
          <div className="displaySubline">
            {badge(`Round ${round}`)} &nbsp; {badge(`${present.length} present`)}
          </div>
        </div>
        {/* Courts only */}
        <div className="courtsGrid displayNamesBig">
          {matches.map(m => (
            <div key={m.court} className="courtCard">
              <div className="courtTop">
                <div className="courtName">Court {m.court}</div>
              </div>
              <div className="teamsWrap">
                <div>{m.team1.map(p=>chip(p, false /* never show levels on display */))}</div>
                <div className="divider" />
                <div>{m.team2.map(p=>chip(p, false))}</div>
              </div>
            </div>
          ))}
        </div>
        {/* Benched visible at bottom, wrapped without scroll */}
        <BenchedBar/>
      </div>
    );
  }

  function SettingsModal({ open, onClose }) {
    if (!open) return null;
    const [locRound, setLocRound] = React.useState(Math.max(1, Math.round(roundSeconds/60)));
    const [locTrans, setLocTrans] = React.useState(transitionSecs);
    const [locCourts, setLocCourts] = React.useState(courts);
    const [locWarn, setLocWarn] = React.useState(warnSecs);
    const [locSound, setLocSound] = React.useState(soundOn);

    const save = () => {
      const roundSecs = Math.max(30, locRound*60);
      const transSecs = Math.max(5, Number(locTrans)||30);
      const cts = Math.min(8, Math.max(1, Number(locCourts)||4));
      const wsecs = Math.min(roundSecs, Math.max(5, Number(locWarn)||30));
      setRoundSeconds(roundSecs);
      setTransitionSecs(transSecs);
      setCourts(cts);
      setWarnSecs(wsecs);
      setSoundOn(locSound);
      if (!running && !transition) setTimeLeft(roundSecs);
      onClose();
    };

    return (
      <div className="modalMask">
        <div className="modalCard">
          <h3>Settings</h3>
          <div className="formGrid">
            <label className="formRow">
              <span>Round length (minutes)</span>
              <input className="txt" type="number" min={1} max={90} value={locRound} onChange={e=>setLocRound(Number(e.target.value||1))}/>
            </label>
            <label className="formRow">
              <span>Transition length (seconds)</span>
              <input className="txt" type="number" min={5} max={120} value={locTrans} onChange={e=>setLocTrans(Number(e.target.value||30))}/>
            </label>
            <label className="formRow">
              <span>Courts (1–8)</span>
              <input className="txt" type="number" min={1} max={8} value={locCourts} onChange={e=>setLocCourts(Number(e.target.value||4))}/>
            </label>
            <label className="formRow">
              <span>Warn threshold (seconds)</span>
              <input className="txt" type="number" min={5} max={3600} value={locWarn} onChange={e=>setLocWarn(Number(e.target.value||30))}/>
            </label>
            <label className="toggleRow">
              <input type="checkbox" checked={locSound} onChange={e=>setLocSound(e.target.checked)} />
              <span>Enable sounds</span>
            </label>
          </div>
          <div className="modalActions">
            <button className="btn" onClick={onClose}>Close</button>
            <button className="btn primary" onClick={save}>Save</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="appRoot">
      <HeaderBar/>
      {loading ? <div className="screenPad">Loading...</div> :
       isHome ? <HomeScreen/> :
       isSession ? <SessionScreen/> :
       <DisplayScreen/>}

      <SettingsModal open={settingsOpen} onClose={()=>setSettingsOpen(false)} />
    </div>
  );
}
