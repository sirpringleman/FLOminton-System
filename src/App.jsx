import React, { useEffect, useMemo, useRef, useState } from 'react'
import { formatTime, selectPlayersForRound, buildMatchesFrom16 } from './logic'
import './App.css' // ← new polished styles

// -------------------- localStorage helpers
const LS = {
  getRound() { return clampInt(localStorage.getItem('flo.roundMinutes'), 12, 3, 40) },
  setRound(v) { localStorage.setItem('flo.roundMinutes', String(v)) },
  getWarn()  { return clampInt(localStorage.getItem('flo.warnSeconds'), 30, 5, 120) },
  setWarn(v) { localStorage.setItem('flo.warnSeconds', String(v)) },
  getVol()   { return clampFloat(localStorage.getItem('flo.volume'), 0.3, 0, 1) },
  setVol(v)  { localStorage.setItem('flo.volume', String(v)) },

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

// -------------------- Beeper
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

// -------------------- Netlify Functions API
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

// -------------------- public chunked persistence (no admin key needed)
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
  // Screens: 'home' | 'session' | 'display'
  const [ui, setUi] = useState(getInitialUi())
  const isDisplay = ui === 'display'

  // Data
  const [players, setPlayers] = useState([])
  const [loading, setLoading] = useState(!isDisplay)

  // Session state
  const [matches, setMatches] = useState([])
  const [round, setRound] = useState(0)
  const [timeLeft, setTimeLeft] = useState(LS.getRound() * 60)
  const [running, setRunning] = useState(false)

  // Settings
  const [roundMinutes, setRoundMinutes] = useState(LS.getRound())
  const [warnSeconds, setWarnSeconds] = useState(LS.getWarn())
  const [volume, setVolume] = useState(LS.getVol())
  const [showSettings, setShowSettings] = useState(false)

  // Admin
  const [adminKey, setAdminKey] = useState(sessionStorage.getItem('adminKey') || '')
  const isAdmin = !!adminKey

  // Rundown
  const [showRundown, setShowRundown] = useState(false)
  const [rundown, setRundown] = useState({ rounds: 0, plays: {}, benches: {}, history: [] })

  // Helpers
  const volumeRef = useRef(volume)
  useEffect(() => { volumeRef.current = volume }, [volume])

  const timerRef = useRef(null)
  const lastRoundBenched = useRef(new Set())
  const teammateHistory = useRef(new Map())
  const { beep } = useBeep(volumeRef)

  // ---------- DISPLAY SYNC ----------
  const lastTsRef = useRef(0)
  const [displaySeen, setDisplaySeen] = useState(false)
  const [displayPresentCount, setDisplayPresentCount] = useState(0)

  const pushDisplay = (override) => {
    const payload = {
      kind: 'flo-display-v1',
      ts: Date.now(),
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

  useEffect(() => {
    if (!isDisplay) return

    const apply = (payload) => {
      if (!payload || payload.kind !== 'flo-display-v1') return
      if (payload.ts && payload.ts <= lastTsRef.current) return
      lastTsRef.current = payload.ts || Date.now()

      setDisplaySeen(true)
      setRound(payload.round || 0)
      setRunning(!!payload.running)
      setTimeLeft(Number(payload.timeLeft || 0))
      setDisplayPresentCount(Number(payload.presentCount || 0))

      if (Array.isArray(payload.matches)) {
        const incoming = payload.matches
        const activeSession = !!payload.running || (payload.round || 0) > 0
        if (activeSession && incoming.length === 0) {
          // ignore clearing during active session
        } else {
          setMatches(incoming.map(m => ({
            court: m.court,
            avg1: m.avg1, avg2: m.avg2,
            team1: m.team1 || [],
            team2: m.team2 || [],
          })))
        }
      }
    }

    apply(LS.getDisplay())

    const onStorage = (e) => {
      if (e.key === 'flo.display.payload') {
        try { apply(JSON.parse(e.newValue)) } catch {}
      }
    }
    window.addEventListener('storage', onStorage)

    const poll = setInterval(() => {
      const snap = LS.getDisplay()
      if (snap) apply(snap)
    }, 800)

    return () => { window.removeEventListener('storage', onStorage); clearInterval(poll) }
  }, [isDisplay])

  // ---------- LOAD PLAYERS (controller only)
  useEffect(() => {
    if (isDisplay) return
    (async () => {
      try {
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
      } catch (e) {
        console.error(e)
        alert(e.message || String(e))
      } finally {
        setLoading(false)
      }
    })()
  }, [isDisplay])

  const present = useMemo(() => players.filter(p => p.is_present), [players])
  const notPresent = useMemo(() => players.filter(p => !p.is_present), [players])

  // ---------- Presence toggle
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

  // ---------- Build next round
  const buildNextRound = async () => {
    if (present.length < 4) { alert('Not enough players present.'); return }

    const roundNumber = round + 1
    const { playing, benched } = selectPlayersForRound(present, roundNumber, lastRoundBenched.current)
    lastRoundBenched.current = new Set(benched.map(b => b.id))

    const newMatches = buildMatchesFrom16(playing, teammateHistory.current)
    setMatches(newMatches)
    setRound(roundNumber)

    const updates = []
    for (const b of benched) updates.push({ id: b.id, bench_count: (b.bench_count || 0) + 1 })
    for (const pl of playing) updates.push({ id: pl.id, last_played_round: roundNumber })
    try { await saveUpdatesPublic(updates) } catch (e) { console.error(e); alert('Failed to save round updates: ' + (e.message || String(e))) }

    try {
      const data = await API.listPlayers()
      setPlayers((data||[]).map(p=>({
        id:p.id,name:p.name,gender:p.gender||'M',skill_level:Number(p.skill_level||1),
        is_present:!!p.is_present,bench_count:Number(p.bench_count||0),last_played_round:Number(p.last_played_round||0)
      })))
    } catch {}

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

    pushDisplay({ round: roundNumber, matches: newMatches, presentCount: present.length })
  }

  // ---------- Timer controls
  const startTimerInternal = () => {
    clearInterval(timerRef.current)
    setTimeLeft(roundMinutes * 60)
    setRunning(true)
    pushDisplay({ timeLeft: roundMinutes * 60, running: true, presentCount: present.length })

    timerRef.current = setInterval(() => {
      setTimeLeft(prev => {
        const next = prev - 1
        pushDisplay({ timeLeft: next, running: true, presentCount: present.length })
        if (next === warnSeconds) beep(1200, 320)
        if (next <= 0) {
          clearInterval(timerRef.current)
          beep(500, 700)
          setRunning(false)
          pushDisplay({ timeLeft: 0, running: false, presentCount: present.length })
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

  // ---------- Toolbar actions
  const onStartNight = () => setUi('session')

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
      pushDisplay({ running: false, presentCount: present.length })
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
    pushDisplay({ running: false, matches: [], timeLeft: 0, round: 0, presentCount: present.length })
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
    pushDisplay({ round: 0, matches: [], timeLeft: 0, running: false, presentCount: present.length })
  }

  // ---------- Admin
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

  // ---------- Open Display
  const openDisplay = () => {
    pushDisplay({ presentCount: players.filter(p => p.is_present).length })
    const url = new URL(window.location.href)
    url.searchParams.set('display', '1')
    window.open(url.toString(), '_blank', 'noopener,noreferrer')
  }

  // Fullscreen hotkey on display
  useEffect(() => {
    if (!isDisplay) return
    const onKey = (e) => {
      if (e.key === 'f' || e.key === 'F') {
        const el = document.documentElement
        if (!document.fullscreenElement) el.requestFullscreen?.()
        else document.exitFullscreen?.()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isDisplay])

  if (!isDisplay && loading) {
    return (
      <div className="page">
        <div className="loader">Loading…</div>
      </div>
    )
  }

  const isWarn = running && timeLeft <= warnSeconds

  // ---------- Render helpers
  const personRow = (p) => {
    const pill = p.gender === 'F' ? 'female' : 'male'
    return (
      <div key={p.id} className="person fade-in" onDoubleClick={() => togglePresence(p)} title="Double-click to toggle">
        <div className="person-left">
          <span className={`pill ${pill}`}>{p.gender}</span>
          <span className="person-name">{p.name}</span>
        </div>
        <div className="level">Lvl {p.skill_level}</div>
      </div>
    )
  }

  const Court = ({ m, large=false }) => {
    const tag = (pl) => {
      const pill = pl.gender === 'F' ? 'female' : 'male'
      return (
        <div className={`tag ${large ? 'lg' : ''}`} key={pl.id}>
          <span className={`pill sm ${pill}`}>{pl.gender}</span>
          {pl.name} <span className="muted">(L{pl.skill_level})</span>
        </div>
      )
    }
    return (
      <div className={`court glass ${large ? 'lg' : ''}`}>
        <div className="court-head">
          <h3>🏸 Court {m.court}</h3>
          <div className="avg-pair">
            <span className="avg">Team 1 Avg: <b>{m.avg1?.toFixed?.(1) ?? m.avg1}</b></span>
            <span className="avg">Team 2 Avg: <b>{m.avg2?.toFixed?.(1) ?? m.avg2}</b></span>
          </div>
        </div>
        <div className="team">{m.team1.map(tag)}</div>
        <div className="net"></div>
        <div className="team">{m.team2.map(tag)}</div>
      </div>
    )
  }

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
        const data = await API.listPlayers()
        setPlayers((data||[]).map(p=>({
          id:p.id,name:p.name,gender:p.gender||'M',skill_level:Number(p.skill_level||1),
          is_present:!!p.is_present,bench_count:Number(p.bench_count||0),last_played_round:Number(p.last_played_round||0)
        })))
      } catch (err) { alert(err.message || String(err)) }
    }
    const saveRow = async (id) => {
      const d = drafts[id]; if (!d) return
      try {
        await API.patch([{ id, name: d.name, gender: d.gender, skill_level: clampInt(d.skill_level, 3, 1, 10) }], adminKey)
        const data = await API.listPlayers()
        setPlayers((data||[]).map(p=>({
          id:p.id,name:p.name,gender:p.gender||'M',skill_level:Number(p.skill_level||1),
          is_present:!!p.is_present,bench_count:Number(p.bench_count||0),last_played_round:Number(p.last_played_round||0)
        })))
      } catch (e) { alert(e.message || String(e)) }
    }
    const deleteRow = async (id) => {
      if (!confirm('Delete this player?')) return
      try {
        await API.remove([id], adminKey)
        const data = await API.listPlayers()
        setPlayers((data||[]).map(p=>({
          id:p.id,name:p.name,gender:p.gender||'M',skill_level:Number(p.skill_level||1),
          is_present:!!p.is_present,bench_count:Number(p.bench_count||0),last_played_round:Number(p.last_played_round||0)
        })))
      } catch (e) { alert(e.message || String(e)) }
    }

    return (
      <div className="panel glass">
        <div className="panel-head">
          <h3>Admin Controls</h3>
          {isAdmin
            ? <button className="btn" onClick={adminLogout}>Exit Admin</button>
            : <button className="btn" onClick={adminLogin}>Admin</button>}
        </div>

        {isAdmin && (
          <>
            <form onSubmit={addPlayer} className="grid add-form">
              <input name="name" placeholder="Name" required className="input"/>
              <select name="gender" defaultValue="M" className="input">
                <option value="M">M</option>
                <option value="F">F</option>
              </select>
              <input name="skill" type="number" min="1" max="10" defaultValue="3" className="input"/>
              <button className="btn" type="submit">Add</button>
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
                  {players.map(p => {
                    const d = drafts[p.id] || { name: p.name, gender: p.gender, skill_level: p.skill_level }
                    return (
                      <tr key={p.id}>
                        <td><input value={d.name} onChange={e=>onDraftChange(p.id, 'name', e.target.value)} className="input"/></td>
                        <td>
                          <select value={d.gender} onChange={e=>onDraftChange(p.id, 'gender', e.target.value)} className="input">
                            <option value="M">M</option>
                            <option value="F">F</option>
                          </select>
                        </td>
                        <td>
                          <input type="number" min="1" max="10" value={d.skill_level}
                            onChange={e=>onDraftChange(p.id, 'skill_level', clampInt(e.target.value, d.skill_level, 1, 10))}
                            className="input"/>
                        </td>
                        <td className="center">{p.is_present ? 'Yes' : 'No'}</td>
                        <td className="center">{p.bench_count}</td>
                        <td className="center">{p.last_played_round}</td>
                        <td>
                          <div className="row-actions">
                            <button className="btn" onClick={()=>saveRow(p.id)}>Save</button>
                            <button className="btn danger" onClick={()=>deleteRow(p.id)}>Delete</button>
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

  const SettingsPanel = () => (
    <div className="modal-backdrop">
      <div className="modal glass">
        <h3>Settings</h3>
        <div className="settings-grid">
          <label className="setting">
            <span>Round length (minutes)</span>
            <input type="number" min={3} max={40} value={roundMinutes}
              onChange={e=>setRoundMinutes(clampInt(e.target.value, roundMinutes, 3, 40))}
              className="input"/>
          </label>
          <label className="setting">
            <span>Warning beep at (seconds left)</span>
            <input type="number" min={5} max={120} value={warnSeconds}
              onChange={e=>setWarnSeconds(clampInt(e.target.value, warnSeconds, 5, 120))}
              className="input"/>
          </label>
          <label className="setting">
            <span>Volume (0–1)</span>
            <input type="number" step="0.05" min={0} max={1} value={volume}
              onChange={e=>setVolume(clampFloat(e.target.value, volume, 0, 1))}
              className="input"/>
          </label>
        </div>
        <div className="right mt-16">
          <button className="btn" onClick={()=>{ LS.setRound(roundMinutes); LS.setWarn(warnSeconds); LS.setVol(volume); setTimeLeft(roundMinutes*60); setShowSettings(false) }}>Save</button>
          <button className="btn ghost" onClick={()=>setShowSettings(false)}>Close</button>
        </div>
      </div>
    </div>
  )

  const RundownModal = () => {
    const entries = players.map(p => ({
      id: p.id, name: p.name, played: rundown.plays[p.id] || 0, benched: rundown.benches[p.id] || 0
    }))
    const maxPlayed = Math.max(0, ...entries.map(e => e.played))
    const minPlayed = Math.min(...entries.map(e => e.played), maxPlayed)
    const most = entries.filter(e => e.played === maxPlayed && maxPlayed > 0)
    const least = entries.filter(e => e.played === minPlayed)

    return (
      <div className="modal-backdrop">
        <div className="modal glass">
          <h3>Session Rundown</h3>
          <p>Total rounds played: <b>{rundown.rounds}</b></p>
          <div className="two-col">
            <div>
              <h4>Most Played</h4>
              {most.length === 0 ? <div className="muted">—</div> :
                most.map(e => <div key={e.id}>{e.name} — {e.played} rounds</div>)}
            </div>
            <div>
              <h4>Least Played</h4>
              {least.length === 0 ? <div className="muted">—</div> :
                least.map(e => <div key={e.id}>{e.name} — {e.played} rounds</div>)}
            </div>
          </div>
          <div className="right mt-12">
            <button className="btn" onClick={closeRundown}>Close</button>
          </div>
        </div>
      </div>
    )
  }

  const Toolbar = () => (
    <div className="toolbar glass">
      <div className="toolbar-left">
        <button className="btn primary" onClick={onStartNight}>Start Night</button>
        <button className="btn" onClick={onPause}>Pause</button>
        <button className="btn" onClick={onResume}>Resume</button>
        <button className="btn danger" onClick={onEndNight}>End Night</button>
        <button className="btn" onClick={onNextRound}>Next Round</button>
        <button className="btn" onClick={openDisplay}>Open Display</button>
        {isAdmin
          ? <button className="btn" onClick={adminLogout}>Admin (On)</button>
          : <button className="btn" onClick={adminLogin}>Admin</button>}
        <button className="btn ghost" onClick={()=>setShowSettings(true)}>Settings</button>
      </div>
      <div className={`toolbar-right time ${isWarn ? 'warn' : ''}`}>
        {ui === 'session' ? `Round ${round || '–'} • ${formatTime(timeLeft)}` :
         ui === 'display' ? 'Display Mode' : 'Not running'}
      </div>
    </div>
  )

  const DisplayView = () => {
    return (
      <div className="display page">
        <div className="display-head">
          <div className="display-title">Badminton Club Night</div>
          <div className="display-meta">
            <span>Round {round || '–'}</span>
            <span>•</span>
            <span className={`bigtime ${isWarn ? 'warn' : ''}`}>{formatTime(timeLeft)}</span>
            <span>•</span>
            <span>{displayPresentCount} present</span>
          </div>
          <div className="display-hint">Press <b>F</b> for fullscreen • <b>Esc</b> to exit</div>
        </div>

        <div className="display-courts">
          {!displaySeen
            ? <div className="muted p-20">Waiting for controller…</div>
            : (matches.length === 0
              ? <div className="muted p-20">Waiting for matches…</div>
              : matches.map(m => <Court key={m.court} m={m} large />)
            )
          }
        </div>
      </div>
    )
  }

  return (
    <div className="page">
      <Toolbar />

      {ui === 'home' && (
        <div className="welcome fade-in">
          <h2>Welcome to Badminton Club Night</h2>
          <p>Use <b>Start Night</b> to begin check-in and matchmaking. Open <b>Display</b> on a second screen to show courts + timer.</p>
        </div>
      )}

      {ui === 'session' && (
        <>
          <div id="courts" className="courts-grid">
            {matches.map(m => <Court key={m.court} m={m} />)}
          </div>

          <div className="lists-grid">
            <div className="list-col">
              <div className="list-head">All Players <span className="badge">{notPresent.length}</span></div>
              <div id="allList" className="list-box glass">
                {notPresent.map(personRow)}
              </div>
            </div>
            <div className="list-col">
              <div className="list-head">Present Today <span className="badge">{present.length}</span></div>
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
  )
}

// -------------------- utils
function getInitialUi() {
  const url = new URL(window.location.href)
  if (url.searchParams.get('display') === '1') return 'display'
  return 'home'
}
