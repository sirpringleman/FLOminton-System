import React, { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from './supabaseClient'
import { formatTime, selectPlayersForRound, buildMatchesFrom16 } from './logic'

console.log('ENV CHECK => URL:', supabase?.rest?.url)

// simple audio beeps via WebAudio (works after first user click)
function useBeep() {
  const ctxRef = useRef(null)
  const ensure = () => {
    if (!ctxRef.current) ctxRef.current = new (window.AudioContext || window.webkitAudioContext)()
    return ctxRef.current
  }
  const beep = (freq=800, ms=250) => {
    const ctx = ensure()
    const o = ctx.createOscillator()
    const g = ctx.createGain()
    o.connect(g); g.connect(ctx.destination)
    o.type = 'sine'; o.frequency.value = freq
    o.start()
    g.gain.setValueAtTime(0.2, ctx.currentTime)
    o.stop(ctx.currentTime + ms/1000)
  }
  return { beep }
}

export default function App() {
  const [players, setPlayers] = useState([])
  const [loading, setLoading] = useState(true)
  const [round, setRound] = useState(0)
  const [timeLeft, setTimeLeft] = useState(12*60) // 12 minutes
  const [running, setRunning] = useState(false)
  const [matches, setMatches] = useState([])
  const timerRef = useRef(null)
  const lastRoundBenched = useRef(new Set()) // for fairness tie-break
  const teammateHistory = useRef(new Map())  // to reduce teammate repeats
  const { beep } = useBeep()

  // Load players
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/.netlify/functions/players', { method: 'GET' })
        const data = await res.json()
        if (!res.ok) throw new Error(data.message || 'Failed to load players via function')
        setPlayers(data || [])
      } catch (e) {
        alert(e.message || String(e))
        console.error('Function load error:', e)
      } finally {
        setLoading(false)
      }
    })()
  }, [])  
  

  const present = useMemo(() => players.filter(p => p.is_present), [players])
  const notPresent = useMemo(() => players.filter(p => !p.is_present), [players])

  // Double-click toggle presence
  const togglePresence = async (p) => {
    const newVal = !p.is_present
    try {
      const res = await fetch('/.netlify/functions/players', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates: [{ id: p.id, is_present: newVal }] }),
      })
      const out = await res.json()
      if (!res.ok) throw new Error(out.message || 'Failed to update presence')
      setPlayers(prev => prev.map(x => x.id===p.id ? {...x, is_present:newVal} : x))
    } catch (e) {
      alert(e.message || String(e))
    }
  }
  

  // Build next round (select players, generate matches, update DB)
  const buildNextRound = async () => {
    if (present.length < 4) return alert('Not enough players present.')
    const roundNumber = round + 1

    // Select 16 to play, rest benched
    const { playing, benched } = selectPlayersForRound(present, roundNumber, lastRoundBenched.current)
    lastRoundBenched.current = new Set(benched.map(b => b.id))

    // Generate balanced matches (±2 first, else balance by average)
    const newMatches = buildMatchesFrom16(playing, teammateHistory.current)
    setMatches(newMatches)
    setRound(roundNumber)


// 3) persist bench_count / last_played_round via Netlify function
const updates = []

// For each benched player, increment bench_count by 1
for (const b of benched) {
  updates.push({ id: b.id, bench_count: (b.bench_count || 0) + 1 })
}

// For each player who played, stamp the round number
for (const p of playing) {
  updates.push({ id: p.id, last_played_round: roundNumber })
}

if (updates.length) {
  try {
    const res = await fetch('/.netlify/functions/players', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updates }),
    })
    const out = await res.json()
    if (!res.ok) throw new Error(out.message || 'Failed to persist round updates')
  } catch (e) {
    console.error(e)
    alert('Failed to save round updates: ' + (e.message || String(e)))
  }
}

// 4) refresh local state from server (optional but recommended)
try {
  const ref = await fetch('/.netlify/functions/players', { method: 'GET' })
  const fresh = await ref.json()
  if (!ref.ok) throw new Error(fresh.message || 'Failed to refresh players')
  setPlayers(Array.isArray(fresh) ? fresh : [])
} catch (e) {
  console.error('Refresh after persist failed:', e)
  // not fatal for UI
}
  }

  // Timer control
  const startTimer = () => {
    clearInterval(timerRef.current)
    setTimeLeft(12*60)
    setRunning(true)
    timerRef.current = setInterval(() => {
      setTimeLeft(prev => {
        const next = prev - 1
        if (next === 30) beep(1200, 300) // 30s warning
        if (next <= 0) {
          clearInterval(timerRef.current)
          beep(500, 500)   // end round
          setRunning(false)
          // Auto next round
          setTimeout(() => {
            buildNextRound().then(() => startTimer())
          }, 400)
          return 0
        }
        return next
      })
    }, 1000)
  }

  const handleStart = async () => {
    // make sure we have players loaded
    if (present.length < 16) {
      const proceed = confirm(`Only ${present.length} present; less than 16 means fewer courts.\nProceed anyway?`)
      if (!proceed) return
    }
    await buildNextRound()
    startTimer()
  }
  const handlePause = () => { if (running) { clearInterval(timerRef.current); setRunning(false) } }
  const handleResume = () => { if (!running && timeLeft>0) { startTimer() } }
  const handleEnd = () => { clearInterval(timerRef.current); setRunning(false); setTimeLeft(12*60); setMatches([]); setRound(0) }
  const handleNext = async () => { clearInterval(timerRef.current); setRunning(false); await buildNextRound(); startTimer() }

  // Render helpers
  const personRow = (p) => {
    const pill = p.gender === 'F' ? 'female' : 'male'
    return (
      <div key={p.id} className="person" onDoubleClick={()=>togglePresence(p)} title="Double-click to toggle">
        <div>{p.name} <span className={`pill ${pill}`}>{p.gender}</span></div>
        <div>Lvl {p.skill_level}</div>
      </div>
    )
  }

  const Court = ({ m }) => {
    const tag = (pl) => {
      const pill = pl.gender === 'F' ? 'female' : 'male'
      return <div className="tag"><span className={`pill ${pill}`}>{pl.gender}</span>{pl.name} (L{pl.skill_level})</div>
    }
    return (
      <div className="court">
        <h3>Court {m.court}</h3>
        <div className="team">{m.team1.map(tag)}</div>
        <div className="avg">Avg: {m.avg1.toFixed(1)}</div>
        <div className="net"></div>
        <div className="team">{m.team2.map(tag)}</div>
        <div className="avg">Avg: {m.avg2.toFixed(1)}</div>
      </div>
    )
  }

  // wire up header buttons by id (since header is outside React root in this simple template)
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
    return () => { s.onclick=p.onclick=r.onclick=e.onclick=n.onclick=null }
  }, [present, timeLeft, running])

  // update timer text outside react for snappy display
  useEffect(() => {
    const el = document.getElementById('timerText')
    el.textContent = formatTime(timeLeft)
  }, [timeLeft])

  if (loading) return <div style={{padding:16}}>Loading…</div>

  return (
    <div style={{padding:16}}>
      <div style={{marginBottom:8}}>Round: <b>{round === 0 ? '–' : round}</b></div>
      <div className="lists">
        <div id="allList" className="list">
          {notPresent.map(personRow)}
        </div>
        <div id="presentList" className="list">
          {present.map(personRow)}
        </div>
      </div>

      <div style={{height:8}}></div>

      <div id="courts" className="courts">
        {matches.map(m => <Court key={m.court} m={m} />)}
      </div>
    </div>
  )
}