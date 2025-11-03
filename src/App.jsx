import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  MATCH_MODES,
  getMatchMode, setMatchMode,
  selectPlayersForRound,
  buildMatchesFrom16,
  fairnessStats,
  roundDiagnostics,
  perPlayerUniq,
  countBackToBackBenches,
  formatTime,
} from './logic';

// ========================== API layer (Netlify function) ==========================
const API = '/.netlify/functions/players';
// Expect the function to support:
//   GET    -> returns array of players
//   PATCH  -> body: { updates: [{ id, fields: {...} }, ...] }    (update many)
//   POST   -> body: { players: [ ... ] }                         (upsert many)

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

// ========================== Local persistence helpers ==========================
const LS = {
  showLevels: 'flo_show_levels',
  adminOn:    'flo_admin_on',
  mode:       'flomatch_mode', // same key used in logic.js for convenience
};
const getLS = (k, d=null) => {
  try { const v = localStorage.getItem(k); return v===null?d:JSON.parse(v); } catch { return d; }
};
const setLS = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

// ========================== Sound ==========================
function useBeep() {
  const ctxRef = useRef(null);
  useEffect(()=>()=>{ try{ctxRef.current && ctxRef.current.close();}catch{} },[]);
  return (freq=880, ms=160) => {
    try {
      if (!ctxRef.current) ctxRef.current = new (window.AudioContext||window.webkitAudioContext)();
      const ctx = ctxRef.current;
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = freq;
      g.gain.value = 0.03;
      o.connect(g); g.connect(ctx.destination);
      o.start();
      setTimeout(()=>{ try{o.stop();}catch{} }, ms);
    } catch {}
  };
}

// ========================== UI helpers ==========================
const badge = (txt) => <span style={{
  display:'inline-block', padding:'2px 8px', borderRadius:999, background:'#0b2a43', color:'#a7c8ff', fontSize:12
}}>{txt}</span>;

const chip = (p, showLevel) => (
  <span key={p.id} style={{
    display:'inline-flex', alignItems:'center',
    padding:'6px 10px', borderRadius:18, margin:'4px 6px 4px 0',
    background: p.gender === 'F' ? '#ff8fb1' : '#8bb2ff', // darker pink/blue
    color: '#0b1420', fontWeight:600
  }}>
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

  // session
  const [round, setRound] = useState(1);
  const [mode, _setMode] = useState(getMatchMode());
  const setMode = (m)=>{ _setMode(m); setMatchMode(m); };

  // timer
  const [roundSeconds, setRoundSeconds] = useState(12*60);
  const [transitionSecs, setTransitionSecs] = useState(30);
  const [timeLeft, setTimeLeft] = useState(roundSeconds);
  const [running, setRunning] = useState(false);
  const [transition, setTransition] = useState(false); // 30s inter-round
  const timerRef = useRef(null);

  // session data
  const [presentIds, setPresentIds] = useState(new Set());
  const present = useMemo(()=> players.filter(p=>presentIds.has(p.id)), [players, presentIds]);
  const [matches, setMatches] = useState([]);            // current round matches
  const [benched, setBenched] = useState([]);            // current round bench
  const [lastBenchedSet, setLastBenchedSet] = useState(new Set());
  const [history, setHistory] = useState([]);            // list of {round,court,team1,team2,avg1,avg2}
  const [benchedSeq, setBenchedSeq] = useState([]);      // [{round, ids:Set()}] for streak diagnostics
  const teammateHistoryRef = useRef(new Map());          // pair -> timestamps

  const beep = useBeep();

  // ------------- load players
  useEffect(() => {
    (async ()=>{
      setLoading(true);
      try {
        const data = await apiGetPlayers();
        setPlayers(data || []);
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

  // ------------- timer loop
  useEffect(()=>{
    if (!running) return;
    timerRef.current = setInterval(()=>{
      setTimeLeft(prev=>{
        if (prev > 0) return prev - 1;
        // prev == 0 -> end-of-round
        clearInterval(timerRef.current);
        onRoundTimeExpired();
        return 0;
      });
    }, 1000);
    return ()=> clearInterval(timerRef.current);
  }, [running]);

  // ------------- convenience
  const isHome = view === 'home';
  const isSession = view === 'session';
  const isDisplay = view === 'display';

  // ===================== Actions =====================

  function goHome() {
    setView('home');
    setRunning(false);
    setTransition(false);
    setTimeLeft(roundSeconds);
  }

  function beginNight() {
    setRound(1);
    setHistory([]);
    setBenchedSeq([]);
    setLastBenchedSet(new Set());
    // DO NOT reset bench_count here; only when End Night
    setView('session');
    setRunning(false);
    setTransition(false);
    setTimeLeft(roundSeconds);
  }

  function openDisplay(){
    setView('display');
  }

  async function endNight() {
    try {
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
      setBenchedSeq([]);
      setLastBenchedSet(new Set());
      setRunning(false);
      setTransition(false);
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
      await buildNextRound({ viaTransition:false });
      setRunning(true);
    } catch (e) {
      alert('Next Round failed.');
      console.error(e);
    }
  }

  async function buildNextRound({ viaTransition }) {
    if (present.length < 4) {
      setMatches([]); setBenched(present.slice());
      return;
    }
    const t0 = performance.now();
    // Select players fairly
    const { playing, benched: bench } = selectPlayersForRound(
      present, round, lastBenchedSet, 4
    );
    // Build matches with current mode
    const ms = buildMatchesFrom16(playing, teammateHistoryRef.current, 4, mode);

    // Persist bench_count++ for benched; update last_played_round for playing
    const nowRound = round;
    const updates = [];
    const benchIds = new Set(bench.map(b => b.id));
    for (const p of present) {
      if (benchIds.has(p.id)) {
        updates.push({ id:p.id, fields:{ bench_count: (p.bench_count||0)+1 }});
      } else {
        updates.push({ id:p.id, fields:{ last_played_round: nowRound }});
      }
    }
    await apiPatch(updates);

    // Update local cache mirrors
    setPlayers(ps => ps.map(p=>{
      if (benchIds.has(p.id)) return { ...p, bench_count:(p.bench_count||0)+1 };
      if (playing.find(x=>x.id===p.id)) return { ...p, last_played_round: nowRound };
      return p;
    }));

    setMatches(ms);
    setBenched(bench);
    setLastBenchedSet(new Set(bench.map(b=>b.id)));
    setBenchedSeq(seq => [...seq, { round: nowRound, ids: new Set(bench.map(b=>b.id)) }]);

    // Log to history for summary/diagnostics
    setHistory(h => [
      ...h,
      ...ms.map(m=>({
        round: nowRound, court: m.court, team1: m.team1, team2: m.team2, avg1:m.avg1, avg2:m.avg2
      }))
    ]);

    // Prepare timers
    const buildMs = Math.max(0, Math.round(performance.now() - t0));
    console.debug('Round built in', buildMs, 'ms');
    if (!viaTransition) {
      setTransition(false);
      setTimeLeft(roundSeconds);
      setRunning(true);
    }
  }

  function onRoundTimeExpired() {
    // Round phase ended -> transition phase begins (30s)
    setRunning(false);
    setTransition(true);
    setTimeLeft(transitionSecs);
    beep(880,140);

    // Start transition countdown
    const id = setInterval(()=>{
      setTimeLeft(prev=>{
        if (prev>0) return prev-1;
        clearInterval(id);
        onTransitionExpired();
        return 0;
      });
    }, 1000);
  }

  async function onTransitionExpired() {
    // Build next matches while showing them during transition; then start next round
    setTransition(false);
    setRound(r => r+1);
    try{
      await buildNextRound({ viaTransition:true });
      setTimeLeft(roundSeconds);
      setRunning(true);
      beep(1200,200);
    }catch(e){
      alert('Auto-build after transition failed.');
      console.error(e);
    }
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

  // CRUD in Admin Controls (inline, no browser prompts for create/edit)
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
  function deletePlayer(id) {
    // soft-delete: mark exclude (if your function supports hard delete, you can switch)
    setPlayers(ps => ps.filter(p => p.id!==id));
    // A simple upsert-less delete is not shown here; if needed, extend Netlify function to DELETE.
  }

  // ============== Smart Session Summary & Diagnostics ==============
  function buildSmartSummary() {
    const pres = players.filter(p => presentIds.has(p.id));
    const fair = fairnessStats(pres);
    const uniq = perPlayerUniq(history, new Set(pres.map(p=>p.id)));
    const streaks = countBackToBackBenches(benchedSeq);

    // Per-player table rows for *all present*, even if never played
    const rows = pres.map(p => {
      const played = history.filter(h => [...(h.team1||[]), ...(h.team2||[])].find(x=>x.id===p.id)).length;
      const bCount = p.bench_count || 0;
      const uniqRow = uniq[p.id] || { uniqTeammates:0, uniqOpponents:0 };
      return {
        id: p.id,
        name: p.name,
        level: p.skill_level,
        played,
        benched: bCount,
        worstBenchStreak: streaks[p.id] || 0,
        uniqTeammates: uniqRow.uniqTeammates,
        uniqOpponents: uniqRow.uniqOpponents,
      };
    }).sort((a,b)=> b.played - a.played || a.name.localeCompare(b.name));

    return {
      overview: {
        rounds: round,
        presentCount: pres.length,
      },
      fairness: fair,
      rows
    };
  }

  function buildDiagnostics() {
    // aggregate last round build metrics
    if (!history.length) return { last:{} };
    const byRound = new Map();
    for (const h of history) {
      if (!byRound.has(h.round)) byRound.set(h.round, []);
      byRound.get(h.round).push(h);
    }
    const lastR = Math.max(...byRound.keys());
    const mats = byRound.get(lastR) || [];
    const diag = roundDiagnostics(mats);
    return { last: diag };
  }

  function showSummaryModal(summary, diag) {
    return new Promise((resolve)=>{
      // super-simple modal
      const html = document.createElement('div');
      html.style.position='fixed'; html.style.inset='0';
      html.style.background='rgba(0,0,0,0.6)';
      html.style.zIndex='9999'; html.style.display='flex';
      html.style.alignItems='center'; html.style.justifyContent='center';
      html.innerHTML = `
        <div style="width: min(1100px, 95vw); max-height: 90vh; overflow:auto; background:#0e1621; color:#cfe6ff; border-radius:16px; padding:20px; border:1px solid #203247">
          <h2 style="margin:0 0 10px 0;">Smart Session Summary</h2>
          <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px;">
            <div>
              <h3>Overview</h3>
              <div>Rounds: <b>${summary.overview.rounds}</b></div>
              <div>Participants: <b>${summary.overview.presentCount}</b></div>
              <h3 style="margin-top:12px;">Fairness</h3>
              <div>Mean benches: <b>${summary.fairness.mean}</b> &nbsp; StDev: <b>${summary.fairness.stdev}</b> &nbsp; Spread: <b>${summary.fairness.spread}</b></div>
            </div>
            <div>
              <h3>Diagnostics (last round)</h3>
              <div>Avg team diff: <b>${diag?.last?.avgDiff ?? '-'}</b></div>
              <div>Courts used: <b>${diag?.last?.usedCourts ?? '-'}</b></div>
              <div>Skill spans: <b>${(diag?.last?.spans||[]).join(', ')}</b></div>
            </div>
          </div>
          <h3 style="margin:16px 0 6px;">Per-player (Present)</h3>
          <table style="width:100%; border-collapse:collapse; font-size:14px;">
            <thead>
              <tr style="text-align:left; background:#0b2033">
                <th style="padding:6px 8px;border-bottom:1px solid #1e3146;">Name</th>
                <th style="padding:6px 8px;border-bottom:1px solid #1e3146;">Lvl</th>
                <th style="padding:6px 8px;border-bottom:1px solid #1e3146;">Played</th>
                <th style="padding:6px 8px;border-bottom:1px solid #1e3146;">Benched</th>
                <th style="padding:6px 8px;border-bottom:1px solid #1e3146;">Worst Bench Streak</th>
                <th style="padding:6px 8px;border-bottom:1px solid #1e3146;">Unique Teammates</th>
                <th style="padding:6px 8px;border-bottom:1px solid #1e3146;">Unique Opponents</th>
              </tr>
            </thead>
            <tbody>
              ${summary.rows.map(r=>`
                <tr>
                  <td style="padding:6px 8px;border-bottom:1px solid #142335;">${r.name}</td>
                  <td style="padding:6px 8px;border-bottom:1px solid #142335;">${r.level}</td>
                  <td style="padding:6px 8px;border-bottom:1px solid #142335;">${r.played}</td>
                  <td style="padding:6px 8px;border-bottom:1px solid #142335;">${r.benched}</td>
                  <td style="padding:6px 8px;border-bottom:1px solid #142335;">${r.worstBenchStreak}</td>
                  <td style="padding:6px 8px;border-bottom:1px solid #142335;">${r.uniqTeammates}</td>
                  <td style="padding:6px 8px;border-bottom:1px solid #142335;">${r.uniqOpponents}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
          <div style="text-align:right; margin-top:16px;">
            <button id="flo-close" style="background:#2a6bff;color:white;border:none;border-radius:10px;padding:8px 14px;cursor:pointer;">Close</button>
          </div>
        </div>
      `;
      document.body.appendChild(html);
      html.querySelector('#flo-close').onclick = ()=>{ document.body.removeChild(html); resolve(); };
    });
  }

  // ===================== Renders =====================

  function HeaderBar() {
    const isBlinking = (!running && transition && timeLeft<=transitionSecs);
    return (
      <div style={{
        display:'grid', gridTemplateColumns:'1fr auto 1fr', alignItems:'center',
        background:'#0a1220', padding:'10px 12px', borderBottom:'1px solid #1b2b40',
        position:'sticky', top:0, zIndex:10
      }}>
        <div style={{display:'flex', gap:8}}>
          {isHome ? (
            <>
              <button className="btn" onClick={beginNight}>Begin Night</button>
              <button className="btn" onClick={()=>setView('session')}>Session</button>
              <button className="btn" onClick={openDisplay}>Open Display</button>
              <button className="btn" onClick={()=> admin? setAdmin(false) : requestAdmin()}>{admin?'Exit Admin':'Admin'}</button>
            </>
          ) : (
            <>
              <button className="btn" onClick={buildOrResume} style={{background:'#2a6bff', color:'#fff'}}>Build/Resume</button>
              <button className="btn" onClick={()=>{ setRunning(false); }}>Pause</button>
              <button className="btn" onClick={nextRound}>Next Round</button>
              <button className="btn danger" onClick={endNight}>End Night</button>
              <button className="btn" onClick={openDisplay}>Open Display</button>
              <button className="btn" onClick={toggleMode}>Mode: {mode===MATCH_MODES.BAND?'Band':'Window'}</button>
              <button className="btn" onClick={()=> admin? setAdmin(false) : requestAdmin()}>{admin?'Exit Admin':'Admin'}</button>
            </>
          )}
        </div>

        {/* Center Title + Timer */}
        <div style={{textAlign:'center'}}>
          <div style={{fontWeight:700}}>🏸 TheFLOminton System</div>
          <div style={{
            fontVariantNumeric:'tabular-nums',
            fontSize: isDisplay? 44 : 24,
            color: (running ? '#cfe6ff' : (transition ? (timeLeft%2? '#fff':'#ff4d6d') : '#cfe6ff')),
            transition:'color 120ms linear'
          }}>
            {transition ? `Next in ${formatTime(timeLeft)}` : `${formatTime(timeLeft)}`} {isSession ? badge(`Round ${round}`) : null}
          </div>
        </div>

        <div style={{textAlign:'right'}}>
          {/* reserved for future right-side buttons */}
        </div>
      </div>
    );
  }

  function CourtsGrid() {
    return (
      <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginTop:12}}>
        {matches.map(m => (
          <div key={m.court} style={{background:'#0e1621', border:'1px solid #1b2b40', borderRadius:14, padding:12}}>
            <div style={{display:'flex', justifyContent:'space-between', marginBottom:6}}>
              <div style={{fontWeight:700}}>Court {m.court}</div>
              {admin && showLevels ? (
                <div style={{opacity:0.85}}>
                  Team 1 Avg <b>{Number(m.avg1.toFixed(1))}</b> &nbsp;&nbsp;
                  Team 2 Avg <b>{Number(m.avg2.toFixed(1))}</b>
                </div>
              ) : null}
            </div>
            <div style={{
              display:'grid', gridTemplateColumns:'1fr', rowGap:10
            }}>
              <div>{m.team1.map(p=>chip(p, admin && showLevels))}</div>
              {/* prominent divider */}
              <div style={{
                height:8, borderRadius:6,
                background:'repeating-linear-gradient(90deg,#a3b9d9 0 12px, #233853 12px 20px)'
              }} />
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
      <div style={{marginTop:12, background:'#0e1621', border:'1px solid #1b2b40', borderRadius:14, padding:'10px 12px'}}>
        <div style={{fontWeight:700, marginBottom:6}}>Benched Players</div>
        <div style={{display:'flex', flexWrap:'wrap'}}>
          {benched.map(p=>chip(p, admin && showLevels))}
        </div>
      </div>
    );
  }

  function DualLists() {
    const allList = players.filter(p=>!presentIds.has(p.id));
    const presentList = players.filter(p=>presentIds.has(p.id));

    return (
      <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginTop:12}}>
        <div style={{background:'#0e1621', border:'1px solid #1b2b40', borderRadius:14, padding:12}}>
          <div style={{display:'flex',justifyContent:'space-between',marginBottom:6}}>
            <div style={{fontWeight:700}}>All Players</div>
            <div>{badge(String(allList.length))}</div>
          </div>
          <div>
            {allList.map(p=>(
              <div key={p.id}
                   onDoubleClick={()=>togglePresent(p.id)}
                   style={{padding:'6px 4px', cursor:'pointer'}}
              >
                {chip(p, admin && showLevels)}
                {admin ? <span style={{opacity:0.7, marginLeft:8}}>Benched {p.bench_count||0}</span> : null}
              </div>
            ))}
          </div>
        </div>

        <div style={{background:'#0e1621', border:'1px solid #1b2b40', borderRadius:14, padding:12}}>
          <div style={{display:'flex',justifyContent:'space-between',marginBottom:6}}>
            <div style={{fontWeight:700}}>Present Today</div>
            <div>{badge(String(presentList.length))}</div>
          </div>
          <div>
            {presentList.map(p=>(
              <div key={p.id}
                   onDoubleClick={()=>togglePresent(p.id)}
                   style={{padding:'6px 4px', cursor:'pointer'}}
              >
                {chip(p, admin && showLevels)}
                {admin ? <span style={{opacity:0.7, marginLeft:8}}>Benched {p.bench_count||0}</span> : null}
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
      <div style={{marginTop:14, background:'#0e1621', border:'1px solid #1b2b40', borderRadius:14, padding:12}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
          <div style={{fontWeight:700}}>Admin Controls</div>
          <div style={{display:'flex',gap:10}}>
            <label style={{display:'inline-flex', alignItems:'center', gap:6}}>
              <input type="checkbox" checked={showLevels} onChange={e=>setShowLevels(e.target.checked)} />
              Show levels
            </label>
            <button className="btn" onClick={addPlayerInline}>Add Player</button>
          </div>
        </div>

        <div style={{marginTop:8, overflowX:'auto'}}>
          <table style={{width:'100%', borderCollapse:'collapse'}}>
            <thead>
              <tr style={{textAlign:'left', background:'#0b2033', color:'#bfe0ff'}}>
                <th style={th}>Name</th>
                <th style={th}>Gender</th>
                <th style={th}>Skill</th>
                <th style={th}>Present</th>
                <th style={th}>Benched</th>
                <th style={th}>Last Round</th>
                <th style={th}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {players.map(p=>(
                <tr key={p.id} style={{borderBottom:'1px solid #142335'}}>
                  <td style={td}><input className="txt" value={p.name} onChange={e=>updatePlayerField(p.id,'name',e.target.value)} /></td>
                  <td style={td}>
                    <select className="txt" value={p.gender||'M'} onChange={e=>updatePlayerField(p.id,'gender',e.target.value)}>
                      <option value="M">M</option>
                      <option value="F">F</option>
                    </select>
                  </td>
                  <td style={td}><input className="txt" type="number" min={1} max={10} value={p.skill_level} onChange={e=>updatePlayerField(p.id,'skill_level',Number(e.target.value||1))} /></td>
                  <td style={td}><input type="checkbox" checked={!!p.is_present} onChange={e=>updatePlayerField(p.id,'is_present',e.target.checked)} /></td>
                  <td style={td}>{p.bench_count||0}</td>
                  <td style={td}>{p.last_played_round||0}</td>
                  <td style={td}>
                    <button className="btn small" onClick={()=>savePlayerRow(p.id)}>Save</button>
                    <button className="btn small danger" onClick={()=>deletePlayer(p.id)}>Delete</button>
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
      <div style={{padding:'12px'}}>
        <CourtsGrid/>
        <BenchedBar/>
        <DualLists/>
        <AdminPanel/>
      </div>
    );
  }

  function HomeScreen() {
    return (
      <div style={{padding:'14px'}}>
        <div style={{display:'flex', gap:10, justifyContent:'center'}}>
          <button className="btn" onClick={beginNight} style={{background:'#2a6bff',color:'#fff'}}>Begin Night</button>
          <button className="btn" onClick={()=>setView('session')}>Session</button>
          <button className="btn" onClick={openDisplay}>Open Display</button>
          <button className="btn" onClick={()=> admin? setAdmin(false) : requestAdmin()}>{admin?'Exit Admin':'Admin'}</button>
        </div>
      </div>
    );
  }

  function DisplayScreen() {
    return (
      <div style={{padding:'12px'}}>
        {/* Timer centered, big */}
        <div style={{textAlign:'center', margin:'8px 0 12px'}}>
          <div style={{fontSize:48, fontVariantNumeric:'tabular-nums',
            color: (running ? '#cfe6ff' : (transition ? (timeLeft%2? '#fff':'#ff4d6d') : '#cfe6ff'))}}>
            {transition ? `Next in ${formatTime(timeLeft)}` : `${formatTime(timeLeft)}`} &nbsp; {badge(`Round ${round}`)}
          </div>
        </div>
        {/* Courts only */}
        <CourtsGrid/>
        {/* Benched visible at bottom, wrapped without scroll */}
        <BenchedBar/>
      </div>
    );
  }

  return (
    <div style={{background:'#0b1420', color:'#cfe6ff', minHeight:'100vh'}}>
      <HeaderBar/>
      {loading ? <div style={{padding:12}}>Loading...</div> :
       isHome ? <HomeScreen/> :
       isSession ? <SessionScreen/> :
       <DisplayScreen/>}
    </div>
  );
}

// table cell styles
const th = { padding:'8px 10px', borderBottom:'1px solid #1b2b40' };
const td = { padding:'6px 8px', verticalAlign:'middle' };

// ------------------- tiny CSS (scoped via classNames here) -------------------
/* You can move this into App.css if you prefer */
const style = document.createElement('style');
style.textContent = `
  .btn{
    background:#18283c; color:#cfe6ff; border:1px solid #243b58; border-radius:10px;
    padding:8px 12px; cursor:pointer;
  }
  .btn:hover{ filter:brightness(1.08); }
  .btn.danger{ background:#ff5b6b; color:#111; border-color:#ff7d89; }
  .btn.small{ padding:6px 10px; font-size:12px; }

  .txt{
    background:#0f1a29; color:#d8ebff; border:1px solid #22364e; border-radius:8px; padding:6px 8px; width:100%;
  }
`;
document.head.appendChild(style);
