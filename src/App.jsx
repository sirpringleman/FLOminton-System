import React, { useEffect, useMemo, useRef, useState } from 'react'
import { formatTime, selectPlayersForRound, buildMatchesFrom16 } from './logic'

// ---------- localStorage helpers
const LS = {
  getRound() { return clampInt(localStorage.getItem('flo.roundMinutes'), 12, 3, 40) },
  setRound(v) { localStorage.setItem('flo.roundMinutes', String(v)) },
  getWarn()  { return clampInt(localStorage.getItem('flo.warnSeconds'), 30, 5, 120) },
  setWarn(v) { localStorage.setItem('flo.warnSeconds', String(v)) },
  getVol()   { return clampFloat(localStorage.getItem('flo.volume'), 0.3, 0, 1) },
  setVol(v)  { localStorage.setItem('flo.volume', String(v)) },
}
function clampInt(raw, def, min, max) {
  const n = parseInt(raw ?? '', 10)
  if (Number.isFinite(n)) return Math.max(min, Math.min(max, n))
  return def
}
function clampFloat(raw, def, min, max) {
  const n = parseFloat(raw ?? '')
  if (Number.isFinite(n)) return Math.max(min, Math.min(max, n))
  return def
}

// ---------- SIMPLE BEEP uses current volume (ref)
function useBeep(volumeRef) {
  const ctxRef = useRef(null)
  const ensure = () => {
    if (!ctxRef.current) ctxRef.current = new (window.AudioContext || window.webkitAudioContext)()
    return ctxRef.current
  }
  const beep = (freq = 800, ms = 250) => {
    const vol = Math.max(0, Math.min(1, volumeRef.current ?? 0.3))
    const ctx = ensure()
    const o = ctx.createOscillator()
    const g = ctx.createGain()
    o.connect(g); g.connect(ctx.destination)
    o.type = 'sine'
    o.frequency.value = freq
    g.gain.setValueAtTime(vol, ctx.currentTime)
    o.start()
    o.stop(ctx.currentTime + ms / 1000)
  }
  return { beep }
}

// ---------- API (Netlify function)
const API = {
  async listPlayers() {
    const res = await fetch('/.netlify/functions/players', { method: 'GET' })
    const data = await res.json()
    if (!res.ok) throw new Error(data.message || 'Failed to load players')
    return data
  },
  async patch(updates, adminKey) {
    const res = await fetch('/.netlify/functions/players', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...(adminKey ? { 'X-Admin-Key': adminKey } : {}),
      },
      body: JSON.stringify({ updates }),
    })
    // attempt JSON, fallback text
    const text = await res.text()
    let data
    try { data = JSON.parse(text) } catch { data = { message: text } }
    if (!res.ok) throw new Error(data.message || 'Failed to save updates')
    return data
  },
  async upsert(players, adminKey) {
    const res = await fetch('/.netlify/functions/players', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Key': adminKey || '',
      },
      body: JSON.stringify({ players }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.message || 'Failed to upsert players')
    return data
  },
  async remove(ids, adminKey) {
    const res = await fetch('/.netlify/functions/players', {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        'X-Admin-Key': adminKey || '',
      },
      body: JSON.stringify({ ids }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.message || 'Failed to delete players')
    return data
  },
}

// ---------- robust chunked updater (public)
async function saveUpdatesPublic(updates) {
  if (!updates?.length) return { ok: true }
  const CHUNK = 25
  for (let i = 0; i < updates.length; i += CHUNK) {
    const part = updates.slice(i, i + CHUNK)
    const res = await fetch('/.netlify/functions/players', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updates: part }),
    })
    const text = await res.text()
    let payload
    try { payload = JSON.parse(text) } catch { payload = { message: text } }
    if (!res.ok) throw new Error(payload?.message || `PATCH failed (${res.status})`)
    if (payload && payload.ok === false && payload.errors?.length) {
      console.warn('Partial update errors:', payload.errors)
      alert('Some rows failed to save. Check Functions logs for details.')
    }
  }
  return { ok: true }
}

export default function App() {
  const [players, setPlayers] = useState([])
  const [loading, setLoading] = useState(true)
  const [round, setRound] = useState(0)
  const [timeLeft, setTimeLeft] = useState(LS.getRound() * 60)
  const [running, setRunning] = useState(false)
  const [matches, setMatches] = useState([])

  // settings (existing)
  const [roundMinutes, setRoundMinutes] = useState(LS.getRound())
  const [warnSeconds, setWarnSeconds] = useState(LS.getWarn())
  const [volume, setVolume] = useState(LS.getVol())
  const volumeRef = useRef(volume)
  useEffect(()=>{ volumeRef.current = volume }, [volume])

  // admin
  const [adminKey, setAdminKey] = useState(sessionStorage.getItem('adminKey') || '')
  const isAdmin = !!adminKey

  const timerRef = useRef(null)
  const lastRoundBenched = useRef(new Set())
  const teammateHistory = useRef(new Map())
  const { beep } = useBeep(volumeRef)

  // ---------- LOAD / REFRESH
  const refreshPlayers = async () => {
    const data = await API.listPlayers()
    const safe = (data || []).map(p => ({
      id: p.id,
      name: p.name,
      gender: p.gender || 'M',
      skill_level: Number(p.skill_level || 1),
      is_present: !!p.is_present,
      bench_count: Number(p.bench_count || 0),
      last_played_round: Number(p.last_played_round || 0),
    }))
    setPlayers(safe)
  }

  useEffect(() => {
    (async () => {
      try {
        await refreshPlayers()
      } catch (e) {
        console.error(e)
        alert(e.message || String(e))
      } finally {
        setLoading(false)
      }
    })()
  }, [])

  const present = useMemo(() => players.filter(p => p.is_present), [players])
  const notPresent = useMemo(() => players.filter(p => !p.is_present), [players])

  // ---------- TOGGLE PRESENCE (double-click)
  const togglePresence = async (p) => {
    const newVal = !p.is_present
    try {
      await API.patch([{ id: p.id, is_present: newVal }])
      setPlayers(prev => prev.map(x => x.id === p.id ? { ...x, is_present: newVal } : x))
    } catch (e) {
      console.error(e)
      alert(e.message || String(e))
    }
  }

  // ---------- BUILD NEXT ROUND (select 16 fairly → 4 balanced courts → persist)
  const buildNextRound = async () => {
    if (present.length < 4) {
      alert('Not enough players present.')
      return
    }
    const roundNumber = round + 1

    // 1) select who plays + who benches
    const { playing, benched } = selectPlayersForRound(present, roundNumber, lastRoundBenched.current)
    lastRoundBenched.current = new Set(benched.map(b => b.id))

    // 2) make balanced matches
    const newMatches = buildMatchesFrom16(playing, teammateHistory.current)
    setMatches(newMatches)
    setRound(roundNumber)

    // 3) persist bench_count / last_played_round via Netlify function (public)
    const updates = []
    for (const b of benched) updates.push({ id: b.id, bench_count: (b.bench_count || 0) + 1 })
    for (const p of playing) updates.push({ id: p.id, last_played_round: roundNumber })
    try {
      await saveUpdatesPublic(updates)
    } catch (e) {
      console.error(e)
      alert('Failed to save round updates: ' + (e.message || String(e)))
    }

    // 4) refresh local state from server
    try {
      await refreshPlayers()
    } catch (e) {
      console.error(e)
    }
  }

  // ---------- TIMER CONTROL
  const startTimerInternal = () => {
    clearInterval(timerRef.current)
    setTimeLeft(roundMinutes * 60)
    setRunning(true)
    timerRef.current = setInterval(() => {
      setTimeLeft(prev => {
        const next = prev - 1
        if (next === warnSeconds) beep(1200, 320) // warning
        if (next <= 0) {
          clearInterval(timerRef.current)
          beep(500, 700)                 // round end
          setRunning(false)
          setTimeout(async () => {
            await buildNextRound()
            startTimerInternal()
          }, 350)
          return 0
        }
        return next
      })
    }, 1000)
  }
  const handleStart  = async () => {
    if (present.length < 16) {
      const ok = confirm(`Only ${present.length} present. Proceed anyway?`)
      if (!ok) return
    }
    await buildNextRound()
    startTimerInternal()
  }
  const handlePause  = () => { if (running) { clearInterval(timerRef.current); setRunning(false) } }
  const handleResume = () => { if (!running && timeLeft > 0) { startTimerInternal() } }
  const handleEnd    = () => { clearInterval(timerRef.current); setRunning(false); setTimeLeft(roundMinutes*60); setMatches([]); setRound(0) }
  const handleNext   = async () => { clearInterval(timerRef.current); setRunning(false); await buildNextRound(); startTimerInternal() }

  // bind header buttons (outside React root)
  useEffect(() => {
    const s = document.getElementById('startBtn')
    const p = document.getElementById('pauseBtn')
    const r = document.getElementById('resumeBtn')
    const e = document.getElementById('endBtn')
    const n = document.getElementById('nextBtn')
    const settingsBtn = document.getElementById('settingsBtn')
    s.onclick = handleStart
    p.onclick = handlePause
    r.onclick = handleResume
    e.onclick = handleEnd
    n.onclick = handleNext
    settingsBtn.onclick = () => {
      const mins = prompt('Round length (minutes):', String(LS.getRound()))
      if (mins !== null) { const v = clampInt(mins, LS.getRound(), 3, 40); setRoundMinutes(v); LS.setRound(v); if (!running) setTimeLeft(v*60) }
      const warn = prompt('Warning beep at (seconds left):', String(LS.getWarn()))
      if (warn !== null) { const v2 = clampInt(warn, LS.getWarn(), 5, 120); setWarnSeconds(v2) ; LS.setWarn(v2) }
      const vol = prompt('Volume 0..1:', String(LS.getVol()))
      if (vol !== null) { const v3 = clampFloat(vol, LS.getVol(), 0, 1); setVolume(v3); LS.setVol(v3) }
    }
    return () => { s.onclick = p.onclick = r.onclick = e.onclick = n.onclick = settingsBtn.onclick = null }
  }, [present, timeLeft, running])

  // keep timer text fresh
  useEffect(() => {
    const el = document.getElementById('timerText')
    if (el) el.textContent = formatTime(timeLeft)
  }, [timeLeft])

  // ---------- ADMIN ACTIONS
  const adminLogin = () => {
    const key = prompt('Enter admin key:')
    if (!key) return
    sessionStorage.setItem('adminKey', key)
    setAdminKey(key)
    alert('Admin mode enabled')
  }
  const adminLogout = () => {
    sessionStorage.removeItem('adminKey')
    setAdminKey('')
    alert('Admin mode disabled')
  }

  const addPlayer = async (e) => {
    e.preventDefault()
    const form = e.target
    const name = form.name.value.trim()
    const gender = form.gender.value
    const skill = clampInt(form.skill.value, 1, 1, 10)
    if (!name) return alert('Name required')
    try {
      await API.upsert([{ name, gender, skill_level: skill, is_present: false, bench_count: 0, last_played_round: 0 }], adminKey)
      form.reset()
      await refreshPlayers()
    } catch (err) {
      alert(err.message || String(err))
    }
  }

  const saveRow = async (p) => {
    try {
      await API.patch([{ id: p.id, name: p.name, gender: p.gender, skill_level: p.skill_level }], adminKey)
      await refreshPlayers()
    } catch (e) {
      alert(e.message || String(e))
    }
  }

  const deleteRow = async (id) => {
    if (!confirm('Delete this player?')) return
    try {
      await API.remove([id], adminKey)
      await refreshPlayers()
    } catch (e) {
      alert(e.message || String(e))
    }
  }

  if (loading) return <div style={{ padding: 16 }}>Loading…</div>

  // ---------- RENDER HELPERS
  const personRow = (p) => {
    const pill = p.gender === 'F' ? 'female' : 'male'
    return (
      <div key={p.id} className="person" onDoubleClick={() => togglePresence(p)} title="Double-click to toggle" style={styles.person}>
        <div style={{ display:'flex', gap:8, alignItems:'center' }}>
          <span className={`pill ${pill}`} style={{...styles.pill, ...(p.gender==='F'?styles.femalePill:styles.malePill)}}>{p.gender}</span>
          <span>{p.name}</span>
        </div>
        <div style={styles.level}>Lvl {p.skill_level}</div>
      </div>
    )
  }

  const Court = ({ m }) => {
    const tag = (pl) => {
      const pill = pl.gender === 'F' ? 'female' : 'male'
      return (
        <div className="tag" key={pl.id} style={styles.tag}>
          <span className={`pill ${pill}`} style={{...styles.pillSmall, ...(pl.gender==='F'?styles.femalePill:styles.malePill)}}>{pl.gender}</span>
          {pl.name} (L{pl.skill_level})
        </div>
      )
    }
    return (
      <div className="court" style={styles.court}>
        <h3 style={styles.courtTitle}>Court {m.court}</h3>
        <div className="team" style={styles.team}>{m.team1.map(tag)}</div>
        <div className="avg"  style={styles.avg}>Avg: {m.avg1.toFixed(1)}</div>
        <div className="net"  style={styles.net}></div>
        <div className="team" style={styles.team}>{m.team2.map(tag)}</div>
        <div className="avg"  style={styles.avg}>Avg: {m.avg2.toFixed(1)}</div>
      </div>
    )
  }

  // Admin table editable copy of roster
  const AdminPanel = () => (
    <div style={{ marginTop: 18, padding: 12, border: '1px solid #233058', borderRadius: 12, background: '#0f1630' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={{ margin: 0 }}>Admin Controls</h3>
        {isAdmin
          ? <button className="btn" onClick={adminLogout}>Exit Admin</button>
          : <button className="btn" onClick={adminLogin}>Admin</button>}
      </div>

      {isAdmin && (
        <>
          <form onSubmit={addPlayer} style={{ display:'grid', gridTemplateColumns:'2fr 1fr 1fr auto', gap:8, marginTop:12 }}>
            <input name="name" placeholder="Name" required style={styles.input}/>
            <select name="gender" defaultValue="M" style={styles.input}>
              <option value="M">M</option>
              <option value="F">F</option>
            </select>
            <input name="skill" type="number" min="1" max="10" defaultValue="3" style={styles.input}/>
            <button className="btn" type="submit">Add</button>
          </form>

          <div style={{ marginTop: 12, overflowX: 'auto' }}>
            <table style={{ width:'100%', borderCollapse:'collapse' }}>
              <thead>
                <tr>
                  <th style={styles.th}>Name</th>
                  <th style={styles.th}>Gender</th>
                  <th style={styles.th}>Level</th>
                  <th style={styles.th}>Present</th>
                  <th style={styles.th}>Bench</th>
                  <th style={styles.th}>Last Round</th>
                  <th style={styles.th}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {players.map(p => (
                  <tr key={p.id}>
                    <td style={styles.td}>
                      <input value={p.name} onChange={e=>setPlayers(prev=>prev.map(x=>x.id===p.id?{...x,name:e.target.value}:x))} style={styles.input}/>
                    </td>
                    <td style={styles.td}>
                      <select value={p.gender} onChange={e=>setPlayers(prev=>prev.map(x=>x.id===p.id?{...x,gender:e.target.value}:x))} style={styles.input}>
                        <option value="M">M</option>
                        <option value="F">F</option>
                      </select>
                    </td>
                    <td style={styles.td}>
                      <input type="number" min="1" max="10" value={p.skill_level}
                        onChange={e=>setPlayers(prev=>prev.map(x=>x.id===p.id?{...x,skill_level:clampInt(e.target.value, p.skill_level, 1, 10)}:x))}
                        style={styles.input}/>
                    </td>
                    <td style={styles.td} align="center">{p.is_present ? 'Yes' : 'No'}</td>
                    <td style={styles.td} align="center">{p.bench_count}</td>
                    <td style={styles.td} align="center">{p.last_played_round}</td>
                    <td style={styles.td}>
                      <div style={{ display:'flex', gap:8 }}>
                        <button className="btn" onClick={()=>saveRow(p)}>Save</button>
                        <button className="btn" onClick={()=>deleteRow(p.id)}>Delete</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )

  return (
    <div style={{ padding: 16 }}>
      <div style={{ marginBottom: 8, fontSize: 16 }}>
        Round: <b>{round === 0 ? '–' : round}</b> &nbsp;•&nbsp;
        Length: <b>{LS.getRound()}m</b> &nbsp;•&nbsp;
        Warn at: <b>{LS.getWarn()}s</b> &nbsp;•&nbsp;
        Volume: <b>{Math.round(volume*100)}%</b> &nbsp;•&nbsp;
        {isAdmin ? <b>Admin Mode</b> : <button className="btn" onClick={adminLogin}>Admin</button>}
      </div>

      {/* Lists */}
      <div className="lists" style={styles.lists}>
        <div className="listCol" style={styles.listCol}>
          <div style={styles.listHeader}>All Players <span style={styles.countBadge}>{notPresent.length}</span></div>
          <div id="allList" className="list" style={styles.listBox}>
            {notPresent.map(personRow)}
          </div>
        </div>
        <div className="listCol" style={styles.listCol}>
          <div style={styles.listHeader}>Present Today <span style={styles.countBadge}>{present.length}</span></div>
          <div id="presentList" className="list" style={styles.listBox}>
            {present.map(personRow)}
          </div>
        </div>
      </div>

      <div style={{ height: 12 }}></div>

      {/* Courts */}
      <div id="courts" className="courts" style={styles.courts}>
        {matches.map(m => <Court key={m.court} m={m} />)}
      </div>

      {/* Admin panel */}
      <AdminPanel />
    </div>
  )
}

// ---------- inline styles
const styles = {
  lists: { display:'grid', gridTemplateColumns:'1fr 1fr', gap:16 },
  listCol: {},
  listHeader: { fontWeight:700, marginBottom:6, display:'flex', alignItems:'center', gap:8 },
  countBadge: { background:'#1e2a55', border:'1px solid #2d3f7a', borderRadius:999, padding:'2px 8px', fontSize:12 },
  listBox: { minHeight:240, border:'1px solid #233058', borderRadius:12, padding:8, background:'#0f1630' },

  person: { display:'flex', alignItems:'center', justifyContent:'space-between', padding:'8px 10px', borderRadius:10, margin:'6px 2px', background:'#0b132b', border:'1px solid #1f2742', cursor:'pointer' },
  pill: { minWidth:22, textAlign:'center', padding:'2px 6px', borderRadius:999, fontSize:12, fontWeight:700, color:'#001b44', background:'#bcdcff' },
  pillSmall: { minWidth:18, textAlign:'center', padding:'1px 6px', borderRadius:999, fontSize:11, fontWeight:700, color:'#001b44', background:'#bcdcff', marginRight:6 },
  malePill: { background:'#add8e6', color:'#002b7f' },
  femalePill: { background:'#ffc0cb', color:'#b0005a' },
  level: { opacity:0.9, fontVariantNumeric:'tabular-nums' },

  courts: { display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(260px, 1fr))', gap:16 },
  court: { background:'#0f1630', border:'1px solid '#233058', borderRadius:16, padding:12 },
  courtTitle: { margin:'0 0 8px 0' },
  team: { display:'flex', flexDirection:'column', gap:6 },
  tag: { background:'#0b132b', border:'1px solid #1f2742', borderRadius:10, padding:'6px 8px', display:'inline-flex', alignItems:'center', gap:6, width:'fit-content' },
  avg: { margin:'6px 0 10px', opacity:0.85 },
  net: { height:2, background:'#2d3f7a', margin:'6px 0', opacity:0.7, borderRadius:2 },

  // admin
  input: { width:'100%', background:'#0b132b', color:'#e6ebff', border:'1px solid #1f2742', borderRadius:8, padding:'6px 8px' },
  th: { textAlign:'left', padding:'8px', borderBottom:'1px solid #233058' },
  td: { padding:'6px 8px', borderBottom:'1px solid #1a2242' },
}
