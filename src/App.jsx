import React, { useEffect, useMemo, useRef, useState } from 'react'
import { formatTime, selectPlayersForRound, buildMatchesFrom16 } from './logic'

// -------------------- localStorage helpers
const LS = {
  getRound() { return clampInt(localStorage.getItem('flo.roundMinutes'), 12, 3, 40) },
  setRound(v) { localStorage.setItem('flo.roundMinutes', String(v)) },
  getWarn()  { return clampInt(localStorage.getItem('flo.warnSeconds'), 30, 5, 120) },
  setWarn(v) { localStorage.setItem('flo.warnSeconds', String(v)) },
  getVol()   { return clampFloat(localStorage.getItem('flo.volume'), 0.3, 0, 1) },
  setVol(v)  { localStorage.setItem('flo.volume', String(v)) },

  // display sync payload
  setDisplay(payload) { localStorage.setItem('flo.display.payload', JSON.stringify(payload)) },
  getDisplay() {
    try { return JSON.parse(localStorage.getItem('flo.display.payload') || 'null') } catch { return null }
  },
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

// -------------------- Beeper (uses current volume)
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

// -------------------- API (Netlify function)
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

// -------------------- public chunked persistence (bench counts / last played)
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
  // --------- data
  const [players, setPlayers] = useState([])
  const [loading, setLoading] = useState(true)

  // --------- screens: 'home' | 'session' | 'display'
  const [ui, setUi] = useState(getInitialUi())

  // session state
  const [matches, setMatches] = useState([])
  const [round, setRound] = useState(0)
  const [timeLeft, setTimeLeft] = useState(LS.getRound() * 60)
  const [running, setRunning] = useState(false)

  // settings
  const [roundMinutes, setRoundMinutes] = useState(LS.getRound())
  const [warnSeconds, setWarnSeconds] = useState(LS.getWarn())
  const [volume, setVolume] = useState(LS.getVol())
  const [showSettings, setShowSettings] = useState(false)

  // admin
  const [adminKey, setAdminKey] = useState(sessionStorage.getItem('adminKey') || '')
  const isAdmin = !!adminKey

  // session stats (for rundown)
  const [showRundown, setShowRundown] = useState(false)
  const [rundown, setRundown] = useState({ rounds: 0, plays: {}, benches: {}, history: [] })

  // helpers
  const volumeRef = useRef(volume)
  useEffect(() => { volumeRef.current = volume }, [volume])

  const timerRef = useRef(null)
  const lastRoundBenched = useRef(new Set())
  const teammateHistory = useRef(new Map())
  const { beep } = useBeep(volumeRef)

  // DISPLAY mode sync: when in control screen, we push; when in display screen, we pull
  const pushDisplay = (override) => {
    const payload = {
      kind: 'flo-display-v1',
      ts: Date.now(),
      ui: 'display',
      round,
      running,
      timeLeft,
      roundMinutes,
      presentCount: players.filter(p => p.is_present).length,
      matches: matches.map(m => ({
        court: m.court,
        avg1: m.avg1, avg2: m.avg2,
        team1: m.team1.map(p => ({ id: p.id, name: p.name, gender: p.gender, skill_level: p.skill_level })),
        team2: m.team2.map(p => ({ id: p.id, name: p.name, gender: p.gender, skill_level: p.skill_level })),
      })),
      ...override
    }
    LS.setDisplay(payload)
  }

  // When this tab is in DISPLAY mode: poll localStorage + react to storage events
  useEffect(() => {
    if (ui !== 'display') return
    const apply = (payload) => {
      if (!payload || payload.kind !== 'flo-display-v1') return
      setRound(payload.round || 0)
      setRunning(!!payload.running)
      setTimeLeft(Number(payload.timeLeft || 0))
      setMatches((payload.matches || []).map(m => ({
        court: m.court,
        avg1: m.avg1, avg2: m.avg2,
        team1: m.team1, team2: m.team2
      })))
    }
    // initial
    apply(LS.getDisplay())

    const onStorage = (e) => {
      if (e.key === 'flo.display.payload') {
        try { apply(JSON.parse(e.newValue)) } catch {}
      }
    }
    const poll = setInterval(() => apply(LS.getDisplay()), 1000)
    window.addEventListener('storage', onStorage)
    return () => { window.removeEventListener('storage', onStorage); clearInterval(poll) }
  }, [ui])

  // -------------------- load players
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

  // -------------------- presence toggle (double-click)
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

  // -------------------- build next round + persist + update stats + push display
  const buildNextRound = async () => {
    if (present.length < 4) { alert('Not enough players present.'); return }

    const roundNumber = round + 1
    const { playing, benched } = selectPlayersForRound(present, roundNumber, lastRoundBenched.current)
    lastRoundBenched.current = new Set(benched.map(b => b.id))

    const newMatches = buildMatchesFrom16(playing, teammateHistory.current)
    setMatches(newMatches)
    setRound(roundNumber)

    // Persist public fields
    const updates = []
    for (const b of benched) updates.push({ id: b.id, bench_count: (b.bench_count || 0) + 1 })
    for (const p of playing) updates.push({ id: p.id, last_played_round: roundNumber })
    try { await saveUpdatesPublic(updates) } catch (e) { console.error(e); alert('Failed to save round updates: ' + (e.message || String(e))) }

    // Refresh roster snapshot (optional)
    try { await refreshPlayers() } catch {}

    // Session stats in-memory
    setRundown(prev => {
      const plays = { ...prev.plays }
      const benches = { ...prev.benches }
      for (const p of playing) plays[p.id] = (plays[p.id] || 0) + 1
      for (const b of benched) benches[b.id] = (benches[b.id] || 0) + 1
      const history = [...prev.history, {
        round: roundNumber,
        matches: newMatches.map(m => ({
          court: m.court,
          team1: m.team1.map(x => x.id),
          team2: m.team2.map(x => x.id),
        }))
      }]
      return { rounds: roundNumber, plays, benches, history }
    })

    // push snapshot for Display Mode
    pushDisplay({ round: roundNumber, matches: newMatches, timeLeft })
  }

  // -------------------- timer controls
  const startTimerInternal = () => {
    clearInterval(timerRef.current)
    setTimeLeft(roundMinutes * 60)
    setRunning(true)

    // immediately push a fresh payload (so display shows the reset)
    pushDisplay({ timeLeft: roundMinutes * 60, running: true })

    timerRef.current = setInterval(() => {
      setTimeLeft(prev => {
        const next = prev - 1
        // push to display every tick (cheap, localStorage write)
        pushDisplay({ timeLeft: next, running: true })

        if (next === warnSeconds) beep(1200, 320)
        if (next <= 0) {
          clearInterval(timerRef.current)
          beep(500, 700)
          setRunning(false)
          pushDisplay({ timeLeft: 0, running: false })
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

  // -------------------- buttons logic
  const onStartNight = () => {
    setUi('session')
  }
  const onResume = async () => {
    if (matches.length === 0) {
      await buildNextRound()
      startTimerInternal()
    } else if (!running && timeLeft > 0) {
      startTimerInternal()
    }
  }
  const onPause = () => {
    if (running) {
      clearInterval(timerRef.current)
      setRunning(false)
      pushDisplay({ running: false })
    }
  }
  const onNextRound = async () => {
    clearInterval(timerRef.current)
    setRunning(false)
    await buildNextRound()
    startTimerInternal()
  }
  const onEndNight = () => {
    clearInterval(timerRef.current)
    setRunning(false)
    pushDisplay({ running: false })
    setShowRundown(true)
  }
  const closeRundown = () => {
    setShowRundown(false)
    setUi('home')
    setMatches([])
    setRound(0)
    setTimeLeft(roundMinutes * 60)
    setRundown({ rounds: 0, plays: {}, benches: {}, history: [] })
    lastRoundBenched.current = new Set()
    teammateHistory.current = new Map()
    pushDisplay({ round: 0, matches: [], timeLeft: 0, running: false })
  }

  // -------------------- admin
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

  // -------------------- open display window
  const openDisplay = () => {
    const url = new URL(window.location.href)
    url.searchParams.set('display', '1')
    window.open(url.toString(), '_blank', 'noopener,noreferrer')
  }

  // keyboard: F toggles fullscreen in display, ESC exits
  useEffect(() => {
    if (ui !== 'display') return
    const onKey = (e) => {
      if (e.key === 'f' || e.key === 'F') {
        const el = document.documentElement
        if (!document.fullscreenElement) el.requestFullscreen?.()
        else document.exitFullscreen?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ui])

  if (loading) return <div style={{ padding: 16 }}>Loading…</div>

  // -------------------- render helpers
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

  const Court = ({ m, large=false }) => {
    const tag = (pl) => {
      const pill = pl.gender === 'F' ? 'female' : 'male'
      return (
        <div className="tag" key={pl.id} style={{...styles.tag, ...(large?styles.tagLarge:{})}}>
          <span className={`pill ${pill}`} style={{...styles.pillSmall, ...(pl.gender==='F'?styles.femalePill:styles.malePill)}}>{pl.gender}</span>
          {pl.name} (L{pl.skill_level})
        </div>
      )
    }
    return (
      <div className="court" style={{...styles.court, ...(large?styles.courtLarge:{})}}>
        <h3 style={{...styles.courtTitle, ...(large?styles.courtTitleLarge:{})}}>Court {m.court}</h3>
        <div className="team" style={styles.team}>{m.team1.map(tag)}</div>
        <div className="avg"  style={{...styles.avg, ...(large?styles.avgLarge:{})}}>Avg: {m.avg1.toFixed(1)}</div>
        <div className="net"  style={styles.net}></div>
        <div className="team" style={styles.team}>{m.team2.map(tag)}</div>
        <div className="avg"  style={{...styles.avg, ...(large?styles.avgLarge:{})}}>Avg: {m.avg2.toFixed(1)}</div>
      </div>
    )
  }

  // Admin panel with drafts (unchanged from previous)
  const AdminPanel = () => {
    const [drafts, setDrafts] = useState({})
    useEffect(() => {
      const m = {}
      for (const p of players) m[p.id] = { name: p.name, gender: p.gender, skill_level: p.skill_level }
      setDrafts(m)
    }, [players])

    const onDraftChange = (id, field, value) =>
      setDrafts(prev => ({ ...prev, [id]: { ...prev[id], [field]: value } }))

    const addPlayer = async (e) => {
      e.preventDefault()
      const form = e.target
      const name = form.name.value.trim()
      const gender = form.gender.value
      const skill = clampInt(form.skill.value, 3, 1, 10)
      if (!name) return alert('Name required')
      try {
        await API.upsert([{ name, gender, skill_level: skill, is_present: false, bench_count: 0, last_played_round: 0 }], adminKey)
        form.reset()
        await refreshPlayers()
      } catch (err) { alert(err.message || String(err)) }
    }
    const saveRow = async (id) => {
      const d = drafts[id]; if (!d) return
      try {
        await API.patch([{ id, name: d.name, gender: d.gender, skill_level: clampInt(d.skill_level, 3, 1, 10) }], adminKey)
        await refreshPlayers()
      } catch (e) { alert(e.message || String(e)) }
    }
    const deleteRow = async (id) => {
      if (!confirm('Delete this player?')) return
      try { await API.remove([id], adminKey); await refreshPlayers() } catch (e) { alert(e.message || String(e)) }
    }

    return (
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
                  {players.map(p => {
                    const d = drafts[p.id] || { name: p.name, gender: p.gender, skill_level: p.skill_level }
                    return (
                      <tr key={p.id}>
                        <td style={styles.td}>
                          <input value={d.name} onChange={e=>onDraftChange(p.id, 'name', e.target.value)} style={styles.input}/>
                        </td>
                        <td style={styles.td}>
                          <select value={d.gender} onChange={e=>onDraftChange(p.id, 'gender', e.target.value)} style={styles.input}>
                            <option value="M">M</option>
                            <option value="F">F</option>
                          </select>
                        </td>
                        <td style={styles.td}>
                          <input type="number" min="1" max="10" value={d.skill_level}
                            onChange={e=>onDraftChange(p.id, 'skill_level', clampInt(e.target.value, d.skill_level, 1, 10))}
                            style={styles.input}/>
                        </td>
                        <td style={styles.td} align="center">{p.is_present ? 'Yes' : 'No'}</td>
                        <td style={styles.td} align="center">{p.bench_count}</td>
                        <td style={styles.td} align="center">{p.last_played_round}</td>
                        <td style={styles.td}>
                          <div style={{ display:'flex', gap:8 }}>
                            <button className="btn" onClick={()=>saveRow(p.id)}>Save</button>
                            <button className="btn" onClick={()=>deleteRow(p.id)}>Delete</button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    )
  }

  // Settings Panel
  const SettingsPanel = () => (
    <div style={styles.modalBackdrop}>
      <div style={styles.modal}>
        <h3 style={{ marginTop:0 }}>Settings</h3>
        <div style={{ display:'grid', gap:12 }}>
          <label style={styles.settingRow}>
            <span>Round length (minutes)</span>
            <input type="number" min={3} max={40} value={roundMinutes}
              onChange={e=>setRoundMinutes(clampInt(e.target.value, roundMinutes, 3, 40))}
              style={styles.input}/>
          </label>
          <label style={styles.settingRow}>
            <span>Warning beep at (seconds left)</span>
            <input type="number" min={5} max={120} value={warnSeconds}
              onChange={e=>setWarnSeconds(clampInt(e.target.value, warnSeconds, 5, 120))}
              style={styles.input}/>
          </label>
          <label style={styles.settingRow}>
            <span>Volume (0–1)</span>
            <input type="number" step="0.05" min={0} max={1} value={volume}
              onChange={e=>setVolume(clampFloat(e.target.value, volume, 0, 1))}
              style={styles.input}/>
          </label>
        </div>
        <div style={{ display:'flex', justifyContent:'flex-end', gap:8, marginTop:16 }}>
          <button className="btn" onClick={()=>{ LS.setRound(roundMinutes); LS.setWarn(warnSeconds); LS.setVol(volume); setTimeLeft(roundMinutes*60); setShowSettings(false) }}>Save</button>
          <button className="btn" onClick={()=>setShowSettings(false)}>Close</button>
        </div>
      </div>
    </div>
  )

  // Rundown modal
  const RundownModal = () => {
    const entries = players.map(p => ({
      id: p.id, name: p.name, played: rundown.plays[p.id] || 0, benched: rundown.benches[p.id] || 0
    }))
    const maxPlayed = Math.max(0, ...entries.map(e => e.played))
    const minPlayed = Math.min(...entries.map(e => e.played), maxPlayed)
    const most = entries.filter(e => e.played === maxPlayed && maxPlayed > 0)
    const least = entries.filter(e => e.played === minPlayed)

    return (
      <div style={styles.modalBackdrop}>
        <div style={styles.modal}>
          <h3 style={{ marginTop:0 }}>Session Rundown</h3>
          <p>Total rounds played: <b>{rundown.rounds}</b></p>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
            <div>
              <h4 style={{ margin:'8px 0'}}>Most Played</h4>
              {most.length === 0 ? <div style={{opacity:0.8}}>—</div> :
                most.map(e => <div key={e.id}>{e.name} — {e.played} rounds</div>)}
            </div>
            <div>
              <h4 style={{ margin:'8px 0'}}>Least Played</h4>
              {least.length === 0 ? <div style={{opacity:0.8}}>—</div> :
                least.map(e => <div key={e.id}>{e.name} — {e.played} rounds</div>)}
            </div>
          </div>
          <div style={{ display:'flex', justifyContent:'flex-end', marginTop:12 }}>
            <button className="btn" onClick={closeRundown}>Close</button>
          </div>
        </div>
      </div>
    )
  }

  // Toolbar (now includes Open Display)
  const Toolbar = () => (
    <div style={styles.toolbar}>
      <button className="btn" onClick={onStartNight}>Start Night</button>
      <button className="btn" onClick={onPause}>Pause</button>
      <button className="btn" onClick={onResume}>Resume</button>
      <button className="btn" onClick={onEndNight}>End Night</button>
      <button className="btn" onClick={onNextRound}>Next Round</button>
      <button className="btn" onClick={openDisplay}>Open Display</button>
      {isAdmin
        ? <button className="btn" onClick={adminLogout}>Admin (On)</button>
        : <button className="btn" onClick={adminLogin}>Admin</button>}
      <button className="btn" onClick={()=>setShowSettings(true)}>Settings</button>
      <div style={{ marginLeft:'auto', fontWeight:600 }}>
        {ui === 'session' ? `Round ${round || '–'} • ${formatTime(timeLeft)}` : ui === 'display' ? 'Display Mode' : 'Not running'}
      </div>
    </div>
  )

  // DISPLAY VIEW (purely visual)
  const DisplayView = () => {
    const presentCount = players.filter(p => p.is_present).length
    return (
      <div style={styles.displayRoot}>
        <div style={styles.displayHeader}>
          <div style={styles.displayTitle}>Badminton Club Night</div>
          <div style={styles.displayMeta}>
            <span>Round {round || '–'}</span>
            <span>•</span>
            <span>{formatTime(timeLeft)}</span>
            <span>•</span>
            <span>{presentCount} present</span>
          </div>
          <div style={styles.displayHint}>Press <b>F</b> for fullscreen • <b>Esc</b> to exit</div>
        </div>

        <div style={styles.displayCourts}>
          {matches.length === 0 ? (
            <div style={{opacity:0.8, fontSize:22, padding:20}}>Waiting for matches…</div>
          ) : (
            matches.map(m => <Court key={m.court} m={m} large />)
          )}
        </div>
      </div>
    )
  }

  // -------------------- Render
  return (
    <div style={{ padding: 16 }}>
      {/* If on ?display=1 we still show the toolbar for convenience (can remove if you want absolute clean) */}
      <Toolbar />

      {ui === 'home' && (
        <div style={{ marginTop: 24, opacity: 0.9 }}>
          <h2>Welcome to Badminton Club Night</h2>
          <p>Use <b>Start Night</b> to begin check-in and matchmaking. Open <b>Display</b> on a second screen to show courts + timer.</p>
        </div>
      )}

      {ui === 'session' && (
        <>
          {/* Courts at the top */}
          <div id="courts" className="courts" style={styles.courts}>
            {matches.map(m => <Court key={m.court} m={m} />)}
          </div>

          <div style={{ height: 12 }}></div>

          {/* Lists below courts */}
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

          {/* Admin panel (visible when Admin mode on) */}
          <AdminPanel />
        </>
      )}

      {ui === 'display' && <DisplayView />}

      {showSettings && <SettingsPanel />}
      {showRundown && <RundownModal />}
    </div>
  )
}

// -------------------- utils
function getInitialUi() {
  const url = new URL(window.location.href)
  if (url.searchParams.get('display') === '1') return 'display'
  return 'home'
}

// -------------------- styles
const styles = {
  toolbar: {
    display:'flex', gap:8, alignItems:'center', flexWrap:'wrap',
    padding:'8px 10px', border:'1px solid #233058', borderRadius:12, background:'#0f1630'
  },

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

  courts: { display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(260px, 1fr))', gap:16, marginTop:16 },
  court: { background:'#0f1630', border: '1px solid #233058', borderRadius:16, padding:12 },
  courtLarge: { padding:16 },
  courtTitle: { margin:'0 0 8px 0' },
  courtTitleLarge: { fontSize:26, marginBottom:10 },
  team: { display:'flex', flexDirection:'column', gap:6 },
  tag: { background:'#0b132b', border:'1px solid #1f2742', borderRadius:10, padding:'6px 8px', display:'inline-flex', alignItems:'center', gap:6, width:'fit-content' },
  tagLarge: { fontSize:18, padding:'8px 10px' },
  avg: { margin:'6px 0 10px', opacity:0.85 },
  avgLarge: { fontSize:16 },
  net: { height:2, background:'#2d3f7a', margin:'6px 0', opacity:0.7, borderRadius:2 },

  // admin / inputs
  input: { width:'100%', background:'#0b132b', color:'#e6ebff', border:'1px solid #1f2742', borderRadius:8, padding:'6px 8px' },
  th: { textAlign:'left', padding:'8px', borderBottom:'1px solid #233058' },
  td: { padding:'6px 8px', borderBottom:'1px solid #1a2242' },

  // modal
  modalBackdrop: {
    position:'fixed', inset:0, background:'rgba(0,0,0,0.6)',
    display:'flex', alignItems:'center', justifyContent:'center', zIndex:1000
  },
  modal: {
    width:'min(680px, 92vw)', background:'#0f1630', border:'1px solid #233058',
    borderRadius:12, padding:16
  },
  settingRow: { display:'grid', gridTemplateColumns:'1fr 200px', alignItems:'center', gap:12 },

  // display mode
  displayRoot: { padding: 12 },
  displayHeader: { textAlign:'center', marginTop:6, marginBottom:12 },
  displayTitle: { fontSize:28, fontWeight:800, letterSpacing:0.2 },
  displayMeta: { marginTop:4, display:'flex', gap:12, justifyContent:'center', fontSize:18, opacity:0.95 },
  displayHint: { marginTop:4, fontSize:12, opacity:0.7 },
  displayCourts: { display:'grid', gridTemplateColumns:'repeat(auto-fit, minmax(320px, 1fr))', gap:16, marginTop:8 },
}
