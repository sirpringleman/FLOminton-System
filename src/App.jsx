// src/App.jsx
import React, { useEffect, useMemo, useRef, useState } from 'react';
import './App.css';
import { buildMatches } from './logic';

// ----------------------
// Netlify Functions URLs
// ----------------------
const API = '/.netlify/functions/players';

// simple beep helpers
const beep = (freq=880, ms=140) => {
  try{
    const ctx = new (window.AudioContext||window.webkitAudioContext)();
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.type = 'sine'; o.frequency.value = freq; o.connect(g); g.connect(ctx.destination);
    o.start(); g.gain.exponentialRampToValueAtTime(0.00001, ctx.currentTime + ms/1000);
    setTimeout(()=>{o.stop(); ctx.close();}, ms+40);
  }catch{}
};

// ----------------------
// Small utilities
// ----------------------
const fmt = n => (n<10 ? `0${n}` : `${n}`);

function secondsToMMSS(s){
  const m = Math.floor(s/60), r = s%60;
  return `${fmt(m)}:${fmt(r)}`;
}

// ----------------------
// App
// ----------------------
export default function App(){
  const [view, setView] = useState('home'); // 'home' | 'session' | 'display'
  const [players, setPlayers] = useState([]);
  const [admin, setAdmin] = useState(false);
  const [adminPassword, setAdminPassword] = useState('');
  const [showLevels, setShowLevels] = useState(true); // can be toggled in Admin panel
  const [resetBenchOnEnd, setResetBenchOnEnd] = useState(false);

  // session
  const [round, setRound] = useState(1);
  const [maxCourts, setMaxCourts] = useState(4);
  const [mode, setMode] = useState('band'); // 'band'|'window'
  const [windowSize, setWindowSize] = useState(2);

  const [matches, setMatches] = useState([]);        // current round matches
  const [benched, setBenched] = useState([]);        // list of benched players this round

  const [timer, setTimer] = useState(12*60);         // round duration in seconds
  const [transition, setTransition] = useState(0);   // 0 (none) or 30 during red/white phase
  const [running, setRunning] = useState(false);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [diagOpen, setDiagOpen] = useState(false);

  const timerRef = useRef(null);
  const nextMatchesRef = useRef(null); // precomputed during transition

  // ----------------------
  // Data IO
  // ----------------------
  async function loadPlayers(){
    try{
      const res = await fetch(API);
      const data = await res.json();
      setPlayers(Array.isArray(data) ? data : []);
    }catch(e){
      alert('Failed to load players.');
    }
  }

  async function savePlayers(newList){
    setPlayers(newList);
    try{
      await fetch(API, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ players:newList })});
    }catch(e){
      console.error(e);
    }
  }

  async function bulkPatch(updates){
    try{
      await fetch(API, { method:'PATCH', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ updates })});
    }catch(e){
      // ok offline
    }
  }

  useEffect(()=>{ loadPlayers(); },[]);

  // derived
  const allPlayers = players.slice().sort((a,b)=>a.name.localeCompare(b.name));
  const present = useMemo(()=> allPlayers.filter(p => p.is_present), [allPlayers]);

  const lastPlayedMap = useMemo(()=>{
    const m = new Map();
    for(const p of allPlayers) m.set(p.id, p.last_played_round||0);
    return m;
  },[allPlayers]);

  const benchCountMap = useMemo(()=>{
    const m = new Map();
    for(const p of allPlayers) m.set(p.id, p.bench_count||0);
    return m;
  },[allPlayers]);

  // ----------------------
  // Admin
  // ----------------------
  function requestAdmin(){
    const pwd = prompt('Enter admin password:');
    if (!pwd) return;
    setAdminPassword(pwd);
    setAdmin(true);
  }
  function exitAdmin(){ setAdmin(false); }

  // Add/Edit/Delete player UI state
  const [editName, setEditName] = useState('');
  const [editGender, setEditGender] = useState('M');
  const [editLevel, setEditLevel] = useState(5);
  const [editId, setEditId] = useState('');

  function startNewPlayer(){
    setEditId('');
    setEditName('');
    setEditGender('M');
    setEditLevel(5);
  }
  function selectPlayerForEdit(p){
    setEditId(p.id);
    setEditName(p.name);
    setEditGender(p.gender || 'M');
    setEditLevel(p.skill_level || 5);
  }
  function savePlayerForm(){
    if (!editName.trim()) return;
    if (editId){
      // update existing
      const updated = players.map(p => p.id === editId ? { ...p, name:editName.trim(), gender:editGender, skill_level: Number(editLevel) } : p );
      savePlayers(updated);
    } else {
      const id = crypto.randomUUID();
      const p = { id, name:editName.trim(), gender:editGender, skill_level:Number(editLevel), is_present:false, bench_count:0, last_played_round:0, created_at:new Date().toISOString() };
      savePlayers([p, ...players]);
    }
    startNewPlayer();
  }
  function deletePlayer(id){
    if (!confirm('Delete this player?')) return;
    const updated = players.filter(p => p.id !== id);
    savePlayers(updated);
    if (editId===id) startNewPlayer();
  }

  // ----------------------
  // Session control
  // ----------------------
  function goHome(){ setView('home'); }
  function beginNight(){
    // unstarted session welcome -> session screen, no matches built
    setRound(1);
    setMatches([]);
    setBenched([]);
    setTransition(0);
    setRunning(false);
    setView('session');
  }

  function buildOrResume(){
    // If matches exist and timer paused -> resume
    if (matches.length && !running && !transition) {
      setRunning(true);
      return;
    }
    // Otherwise build a round (or rebuild next round) and start timer immediately
    buildNextRound(true);
  }

  function nextRoundManual() {
    // manual button: immediately go to transition phase to show next matches
    if (transition) return; // already transitioning
    startTransition();
  }

  async function endNight(){
    try{
      // Unmark present for everyone, reset last_played_round; bench counter optional
      const updates = players.map(p => ({
        id: p.id,
        fields: {
          is_present: false,
          last_played_round: 0,
          ...(resetBenchOnEnd ? { bench_count: 0 } : {})
        }
      }));
      await bulkPatch(updates);
    }finally{
      // local reset
      setPlayers(prev => prev.map(p=>({
        ...p,
        is_present:false,
        last_played_round:0,
        ...(resetBenchOnEnd ? { bench_count:0 } : {})
      })));
      setRound(1);
      setMatches([]);
      setBenched([]);
      setTransition(0);
      setRunning(false);
      setView('home');
    }
  }

  function togglePresent(p){
    const updated = players.map(x => x.id===p.id? { ...x, is_present: !x.is_present } : x);
    savePlayers(updated);
  }

  // ----------------------
  // Building logic
  // ----------------------
  function computeMatchesForRound(nextRoundNo){
    // choose who plays (balance fairness)
    const lastRoundBenched = new Set(benched.map(b => b.id));

    const built = buildMatches({
      present,
      maxCourts,
      mode,
      windowSize,
      roundNo: nextRoundNo,
      lastPlayedMap,
      benchCountMap,
      lastRoundBenchedSet: lastRoundBenched,
      recentTeammates: new Map(), // optional: can thread from session metrics
      recentOpponents: new Map()
    });

    // who is benched?
    const playingIds = new Set(built.flatMap(m => [...m.team1, ...m.team2].map(p=>p.id)));
    const newBenched = present.filter(p => !playingIds.has(p.id));

    return { built, newBenched };
  }

  function startTransition(){
    // Precompute next matches and show them during the 30s red/white blink
    const { built, newBenched } = computeMatchesForRound(round+1);
    nextMatchesRef.current = { built, newBenched };
    setTransition(30);
    setRunning(false);
    beep(700,120);
  }

  function buildNextRound(startTimer){
    // build immediately and start timer if asked
    const { built, newBenched } = computeMatchesForRound(round);
    setMatches(built);
    setBenched(newBenched);

    // update per-player last_played_round and bench_count
    const playIds = new Set(built.flatMap(m => [...m.team1, ...m.team2].map(p=>p.id)));
    const updates = players.map(p=>{
      const playing = playIds.has(p.id);
      return {
        id:p.id,
        fields:{
          last_played_round: playing ? round : (p.last_played_round||0),
          bench_count: playing ? (p.bench_count||0) : ( (p.bench_count||0)+1 )
        }
      };
    });
    bulkPatch(updates);
    setPlayers(prev=>prev.map(p=>{
      const upd = updates.find(u=>u.id===p.id);
      return upd ? { ...p, ...upd.fields } : p;
    }));

    if (startTimer) {
      setRunning(true);
    }
  }

  // transition + main timer tick
  useEffect(()=>{
    if (!running && !transition) return;
    timerRef.current && clearInterval(timerRef.current);
    timerRef.current = setInterval(()=>{
      if (transition){
        setTransition(t => {
          if (t <= 1){
            // transition done -> commit next matches and start round
            const nm = nextMatchesRef.current;
            if (nm){
              setMatches(nm.built);
              setBenched(nm.newBenched);

              // update round no, counters
              const playIds = new Set(nm.built.flatMap(m => [...m.team1, ...m.team2].map(p=>p.id)));
              const updates = players.map(p=>{
                const playing = playIds.has(p.id);
                return {
                  id:p.id,
                  fields:{
                    last_played_round: playing ? (round+1) : (p.last_played_round||0),
                    bench_count: playing ? (p.bench_count||0) : ((p.bench_count||0)+1)
                  }
                };
              });
              bulkPatch(updates);
              setPlayers(prev=>prev.map(p=>{
                const upd = updates.find(u=>u.id===p.id);
                return upd ? { ...p, ...upd.fields } : p;
              }));
            }
            setRound(r=>r+1);
            setTransition(0);
            setRunning(true);
            beep(990,160);
            return 0;
          }
          return t-1;
        });
      } else if (running){
        setTimer(s=>{
          if (s<=1){
            // round finished -> enter transition mode
            setRunning(false);
            setTimer(s); // keep 00:00
            startTransition();
            return 0;
          }
          return s-1;
        });
      }
    },1000);
    return ()=> clearInterval(timerRef.current);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, transition, round, players, present, maxCourts, mode, windowSize]);

  // ----------------------
  // UI helpers
  // ----------------------
  const isYellow = (!transition && running && timer <= 30 && timer > 0);
  const isFlashing = (transition > 0) || (!running && timer===0);

  const title = 'TheFLOminton System';

  const currentMatches = transition ? (nextMatchesRef.current?.built || []) : matches;
  const currentBenched = transition ? (nextMatchesRef.current?.newBenched || []) : benched;

  // ----------------------
  // Render
  // ----------------------
  if (view === 'home'){
    return (
      <div className="container">
        <div className="toolbar">
          <div className="title">{title}</div>
          <div className="actions">
            <button className="btn btn-primary" onClick={beginNight}>Begin Night</button>
            <button className="btn" onClick={()=>setSettingsOpen(true)}>Settings</button>
            {!admin ? (
              <button className="btn" onClick={requestAdmin}>Admin</button>
            ) : (
              <button className="btn" onClick={exitAdmin}>Exit Admin</button>
            )}
            <button className="btn" onClick={()=>setView('display')}>Open Display</button>
          </div>
        </div>
        <SessionLists
          players={allPlayers}
          present={present}
          showLevels={admin && showLevels}
          onTogglePresent={togglePresent}
          admin={admin}
          adminPanel={
            <AdminPanel
              admin={admin}
              showLevels={showLevels}
              setShowLevels={setShowLevels}
              resetBenchOnEnd={resetBenchOnEnd}
              setResetBenchOnEnd={setResetBenchOnEnd}
              players={players}
              onSavePlayers={savePlayers}
              editId={editId} editName={editName} editGender={editGender} editLevel={editLevel}
              setEditId={setEditId} setEditName={setEditName} setEditGender={setEditGender} setEditLevel={setEditLevel}
              onStartNew={startNewPlayer}
              onSelectEdit={selectPlayerForEdit}
              onSaveOne={savePlayerForm}
              onDeleteOne={deletePlayer}
            />
          }
        />
      </div>
    );
  }

  if (view === 'display'){
    return (
      <div className="displayPage">
        <div className="displayHeader">
          <div className="displayRound">Round {round}</div>
          <div className={`displayTimer ${isYellow?'yellow':''} ${isFlashing?'flash':''}`}>
            {transition? secondsToMMSS(transition) : secondsToMMSS(timer)}
          </div>
        </div>

        <div className="grid bigNames">
          {currentMatches.map(m=>(
            <div className="panel" key={m.court}>
              <div className="courtTitle">Court {m.court}</div>
              <div className="teamAverages">&nbsp;</div>
              <div className="chips">
                {m.team1.map(p=> <span key={p.id} className={`chip ${p.gender==='F'?'f':'m'}`}>{p.name}</span>)}
              </div>
              <div className="dividerLine" />
              <div className="chips">
                {m.team2.map(p=> <span key={p.id} className={`chip ${p.gender==='F'?'f':'m'}`}>{p.name}</span>)}
              </div>
            </div>
          ))}
        </div>

        <div className="panel" style={{marginTop:12}}>
          <div className="sectionTitle">Benched Players</div>
          <div className="benchedRow">
            {currentBenched.map(p=>(
              <span key={p.id} className={`chip ${p.gender==='F'?'f':'m'}`}>{p.name}</span>
            ))}
          </div>
        </div>

        <div className="container" style={{marginTop:12}}>
          <button className="btn" onClick={()=>setView('session')}>Back</button>
        </div>
      </div>
    );
  }

  // Session page
  return (
    <div className="container">
      <div className="toolbar">
        <div className="actions">
          {/* Begin Night removed here as requested */}
          <button className="btn" onClick={()=>setRunning(false)}>Pause</button>
          <button className="btn btn-primary" onClick={buildOrResume}>Build/Resume</button>
          <button className="btn" onClick={nextRoundManual}>Next Round</button>
          <button className="btn btn-danger" onClick={endNight}>End Night</button>
          <button className="btn" onClick={()=>setView('display')}>Open Display</button>

          {admin && (
            <div className="modeToggle">
              <button
                className={mode==='band' ? 'active' : ''}
                onClick={()=>setMode('band')}
                title="Band Mode"
              >Band</button>
              <button
                className={mode==='window' ? 'active' : ''}
                onClick={()=>setMode('window')}
                title="Window Mode"
              >Window</button>
            </div>
          )}

          <button className="btn" onClick={()=>setSettingsOpen(true)}>Settings</button>
          {!admin ? (
            <button className="btn" onClick={requestAdmin}>Admin</button>
          ) : (
            <button className="btn" onClick={exitAdmin}>Exit Admin</button>
          )}
        </div>

        <div className="rightInfo">
          <div className="centerBar">
            <div className="sub">Round</div>
            <div className="title">{round}</div>
          </div>
          <div className={`timer big ${isYellow?'yellow':''} ${isFlashing?'flash':''}`}>
            {transition? secondsToMMSS(transition) : secondsToMMSS(timer)}
          </div>
          <div className="centerBar">
            <div className="sub">Present</div>
            <div className="title">{present.length}</div>
          </div>
        </div>
      </div>

      {/* Courts */}
      <div className="grid" style={{marginTop:12}}>
        {currentMatches.map(m=>(
          <div className="panel" key={m.court}>
            <div className="courtHeader">
              <h3>Court {m.court}</h3>
              {admin && showLevels && (
                <div className="teamAverages">Team 1 Avg <b>{m.team1Avg.toFixed(1)}</b>&nbsp;&nbsp; Team 2 Avg <b>{m.team2Avg.toFixed(1)}</b></div>
              )}
            </div>
            <div className="chips">
              {m.team1.map(p=>
                <span key={p.id} className={`chip ${p.gender==='F'?'f':'m'}`}>
                  {p.name}{showLevels?` · L${p.skill_level}`:''}
                </span>
              )}
            </div>
            <div className="rail" />
            <div className="chips">
              {m.team2.map(p=>
                <span key={p.id} className={`chip ${p.gender==='F'?'f':'m'}`}>
                  {p.name}{showLevels?` · L${p.skill_level}`:''}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Benched strip */}
      <div className="panel" style={{marginTop:12}}>
        <div className="sectionTitle">Benched Players</div>
        <div className="benchedRow">
          {currentBenched.map(p=>
            <span key={p.id} className={`chip ${p.gender==='F'?'f':'m'}`}>
              {p.name}{admin && showLevels?` · L${p.skill_level}`:''}
            </span>
          )}
        </div>
      </div>

      {/* Lists + Admin */}
      <SessionLists
        players={allPlayers}
        present={present}
        showLevels={admin && showLevels}
        onTogglePresent={togglePresent}
        admin={admin}
        adminPanel={
          admin && (
            <AdminPanel
              admin={admin}
              showLevels={showLevels}
              setShowLevels={setShowLevels}
              resetBenchOnEnd={resetBenchOnEnd}
              setResetBenchOnEnd={setResetBenchOnEnd}
              players={players}
              onSavePlayers={savePlayers}
              editId={editId} editName={editName} editGender={editGender} editLevel={editLevel}
              setEditId={setEditId} setEditName={setEditName} setEditGender={setEditGender} setEditLevel={setEditLevel}
              onStartNew={startNewPlayer}
              onSelectEdit={selectPlayerForEdit}
              onSaveOne={savePlayerForm}
              onDeleteOne={deletePlayer}
            />
          )
        }
      />

      {/* Settings modal */}
      {settingsOpen && (
        <Modal onClose={()=>setSettingsOpen(false)} title="Settings">
          <div className="formRow">
            <input className="input" readOnly value={`Max courts`} />
            <input className="input" type="number" min={1} max={10} value={maxCourts} onChange={e=>setMaxCourts(Number(e.target.value)||1)} />
            <div />
            <div />
          </div>
          <div className="formRow">
            <input className="input" readOnly value={`Round length (min)`} />
            <input className="input" type="number" min={3} max={60}
              value={Math.round(timer/60)} onChange={e=>setTimer((Number(e.target.value)||12)*60)} />
            <div />
            <div />
          </div>
          <div className="formRow">
            <input className="input" readOnly value={`Window size (Window Mode)`} />
            <input className="input" type="number" min={0} max={5} value={windowSize} onChange={e=>setWindowSize(Number(e.target.value)||2)} />
            <div />
            <div />
          </div>
          <div style={{display:'flex', gap:8, justifyContent:'flex-end'}}>
            <button className="btn" onClick={()=>setSettingsOpen(false)}>Close</button>
          </div>
        </Modal>
      )}

      {/* Smart Summary */}
      {summaryOpen && (
        <Modal onClose={()=>setSummaryOpen(false)} title="Smart Session Summary">
          <SmartSummary present={present} matches={matches} benched={benched} round={round} />
        </Modal>
      )}

      {/* Diagnostics */}
      {diagOpen && (
        <Modal onClose={()=>setDiagOpen(false)} title="System Diagnostics">
          <Diagnostics present={present} matches={matches} round={round} />
        </Modal>
      )}
    </div>
  );
}

// -------------
// Subcomponents
// -------------
function SessionLists({ players, present, showLevels, onTogglePresent, admin, adminPanel }){
  return (
    <div className="columns" style={{marginTop:12}}>
      <div className="list">
        <h4>All Players <span className="sub">{players.length - present.length}</span></h4>
        {players.filter(p=>!p.is_present).map(p=>(
          <div key={p.id} className="row" onDoubleClick={()=>onTogglePresent(p)}>
            {p.name}{showLevels?` · L${p.skill_level}`:''}
          </div>
        ))}
      </div>
      <div className="list">
        <h4>Present Today <span className="sub">{present.length}</span></h4>
        {present.map(p=>(
          <div key={p.id} className="row" onDoubleClick={()=>onTogglePresent(p)}>
            {p.name}{showLevels?` · L${p.skill_level}`:''}
          </div>
        ))}
      </div>

      {/* Admin controls occupy full width below */}
      <div style={{gridColumn:'1 / span 2'}}>
        {adminPanel}
      </div>
    </div>
  );
}

function AdminPanel({
  admin, showLevels, setShowLevels,
  resetBenchOnEnd, setResetBenchOnEnd,
  players, onSavePlayers,
  editId, editName, editGender, editLevel,
  setEditId, setEditName, setEditGender, setEditLevel,
  onStartNew, onSelectEdit, onSaveOne, onDeleteOne
}){
  if (!admin) return null;
  return (
    <div className="panel" style={{marginTop:12}}>
      <div className="sectionTitle">Admin Controls</div>

      <div style={{display:'flex', gap:12, flexWrap:'wrap', marginBottom:12}}>
        <label className="chip"><input type="checkbox" checked={showLevels} onChange={e=>setShowLevels(e.target.checked)} />&nbsp;Show skill levels</label>
        <label className="chip"><input type="checkbox" checked={resetBenchOnEnd} onChange={e=>setResetBenchOnEnd(e.target.checked)} />&nbsp;Reset bench counters on End Night</label>
      </div>

      <div className="formRow">
        <input className="input" placeholder="Full name" value={editName} onChange={e=>setEditName(e.target.value)} />
        <select className="select" value={editGender} onChange={e=>setEditGender(e.target.value)}>
          <option value="M">M</option>
          <option value="F">F</option>
        </select>
        <input className="input" type="number" min={1} max={10} value={editLevel} onChange={e=>setEditLevel(Number(e.target.value)||1)} />
        <div style={{display:'flex', gap:8}}>
          <button className="btn btn-primary" onClick={onSaveOne}>{editId? 'Update' : 'Add'}</button>
          <button className="btn" onClick={onStartNew}>Clear</button>
        </div>
      </div>

      <table className="table">
        <thead>
          <tr><th>Name</th><th>Gender</th><th>Level</th><th>Present</th><th>Bench</th><th>Actions</th></tr>
        </thead>
        <tbody>
          {players.map(p=>(
            <tr key={p.id}>
              <td>{p.name}</td>
              <td>{p.gender}</td>
              <td>{p.skill_level}</td>
              <td>{p.is_present?'Yes':'No'}</td>
              <td>{p.bench_count||0}</td>
              <td>
                <button className="btn" onClick={()=>onSelectEdit(p)}>Edit</button>
                <button className="btn btn-danger" onClick={()=>onDeleteOne(p.id)}>Delete</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Modal({ children, title, onClose }){
  return (
    <div className="modalOverlay" onClick={onClose}>
      <div className="modal" onClick={e=>e.stopPropagation()}>
        <h2>{title}</h2>
        {children}
        <div style={{textAlign:'right', marginTop:12}}>
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

// Stubs (smart summary / diagnostics). You already had these; restore/extend as needed.
function SmartSummary({ present, matches, benched, round }){
  // Keep simple text to confirm render; your prior metrics can be pasted back here.
  return (
    <div>
      <div className="sectionTitle">Overview</div>
      <p>Rounds played: <b>{Math.max(0, round-1)}</b></p>
      <p>Participants this session: <b>{present.length}</b></p>
      <div className="sectionTitle">Per-player</div>
      <table className="table">
        <thead><tr><th>Name</th><th>Played</th><th>Benched</th></tr></thead>
        <tbody>
          {present.map(p=>{
            const played = matches.flatMap(m=>[...m.team1, ...m.team2].map(x=>x.id)).filter(id=>id===p.id).length>0 ? '≥1' : '0';
            return <tr key={p.id}><td>{p.name}</td><td>{played}</td><td>{p.bench_count||0}</td></tr>;
          })}
        </tbody>
      </table>
    </div>
  );
}

function Diagnostics({ present, matches, round }){
  return (
    <div>
      <p>Round #: {round}</p>
      <p>Present: {present.length}</p>
      <p>Courts used: {matches.length}</p>
    </div>
  );
}
