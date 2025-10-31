import React, { useEffect, useMemo, useRef, useState } from 'react'
import { formatTime, selectPlayersForRound, buildMatchesFrom16 } from './logic'

// ---------- SIMPLE BEEP (works after first user interaction)
function useBeep() {
  const ctxRef = useRef(null)
  const ensure = () => {
    if (!ctxRef.current) ctxRef.current = new (window.AudioContext || window.webkitAudioContext)()
    return ctxRef.current
  }
  const beep = (freq = 800, ms = 250) => {
    const ctx = ensure()
    const o = ctx.createOscillator()
    const g = ctx.createGain()
    o.connect(g); g.connect(ctx.destination)
    o.type = 'sine'
    o.frequency.value = freq
    g.gain.setValueAtTime(0.2, ctx.currentTime)
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
  async patch(updates) {
    const res = await fetch('/.netlify/functions/players', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updates }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.message || 'Failed to save updates')
    return data
  },
  async upsert(players) {
    const res = await fetch('/.netlify/functions/players', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ players }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.message || 'Failed to upsert players')
    return data
  }
}

export default function App() {
  const [players, setPlayers] = useState([])
  const [loading, setLoading] = useState(true)
  const [round, setRound] = useState(0)
  const [timeLeft, setTimeLeft] = useState(12 * 60) // 12:00
  const [running, setRunning] = useState(false)
  const [matches, setMatches] = useState([])

  const timerRef = useRef(null)
  const lastRoundBenched = useRef(new Set())
  const teammateHistory = useRef(new Map())
  const { beep } = useBeep()

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

    // 2) make balanced matches (±2 band first, else minimize team avg diff)
    const newMatches = buildMatchesFrom16(playing, teammateHistory.current)
    setMatches(newMatches)
    setRound(roundNumber)

    // 3) persist bench_count / last_played_round via Netlify function
    const updates = []
    for (const b of benched) updates.push({ id: b.id, bench_count: (b.bench_count || 0) + 1 })
    for (const p of playing) updates.push({ id: p.id, last_played_round: roundNumber })
    if (updates.length) {
      try {
        await API.patch(updates)
      } catch (e) {
        console.error(e)
        alert('Failed to save round updates: ' + (e.message || String(e)))
      }
    }

    // 4) refresh local state from server
    try {
      await refreshPlayers()
    } catch (e) {
      console.error(e)
    }
  }

  // ---------- TIMER CONTROL
  const startTimer = () => {
    clearInterval(timerRef.current)
    setTimeLeft(12 * 60)
    setRunning(true)
    timerRef.current = setInterval(() => {
      setTimeLeft(prev => {
        const next = prev - 1
        if (next === 30) beep(1200, 300) // 30s warning
        if (next <= 0) {
          clearInterval(timerRef.current)
          beep(500, 600)                 // round end
          setRunning(false)
          setTimeout(async () => {
            await buildNextRound()
            startTimer()
          }, 350)
          return 0
        }
        return next
      })
    }, 1000)
  }

  const handleStart = async () => {
    if (present.length < 16) {
      const ok = confirm(`Only ${present.length} present. Proceed anyway?`)
      if (!ok) return
    }
    await buildNextRound()
    startTimer()
  }
  const handlePause  = () => { if (running) { clearInterval(timerRef.current); setRunning(false) } }
  const handleResume = () => { if (!running && timeLeft > 0) { startTimer() } }
  const handleEnd    = () => { clearInterval(timerRef.current); setRunning(false); setTimeLeft(12*60); setMatches([]); setRound(0) }
  const handleNext   = async () => { clearInterval(timerRef.current); setRunning(false); await buildNextRound(); startTimer() }

  // bind header buttons by id (header is outside React root in our template)
  useEffect(() => {
    const s = document.getElementById('startBtn')
    const p = document.getElementById('pauseBtn')
    const r = document.getElementById('resumeBtn')
    const e = document.getElementById('endBtn')
    const n = document.getElementById('nextBtn')
    s.onclick = handleStart
    p.onclick = handlePause
    r.onclick = handleResume
    e.onclick = handleEnd
    n.onclick = handleNext
    return () => { s.onclick = p.onclick = r.onclick = e.onclick = n.onclick = null }
  }, [present, timeLeft, running])

  // keep timer text in header fresh
  useEffect(() => {
    const el = document.getElementById('timerText')
    if (el) el.textContent = formatTime(timeLeft)
  }, [timeLeft])

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

  return (
    <div style={{ padding: 16 }}>
      <div style={{ marginBottom: 8, fontSize: 16 }}>Round: <b>{round === 0 ? '–' : round}</b></div>

      {/* Lists with headers */}
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
    </div>
  )
}

// ---------- inline styles (quick polish)
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
  court: { background:'#0f1630', border:'1px solid #233058', borderRadius:16, padding:12 },
  courtTitle: { margin:'0 0 8px 0' },
  team: { display:'flex', flexDirection:'column', gap:6 },
  tag: { background:'#0b132b', border:'1px solid #1f2742', borderRadius:10, padding:'6px 8px', display:'inline-flex', alignItems:'center', gap:6, width:'fit-content' },
  avg: { margin:'6px 0 10px', opacity:0.85 },
  net: { height:2, background:'#2d3f7a', margin:'6px 0', opacity:0.7, borderRadius:2 },
}
