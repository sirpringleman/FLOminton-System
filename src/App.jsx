import React, {
  useEffect,
  useState,
  useMemo,
  useRef,
} from 'react'
import {
  formatTime,
  getMatchMode,
  setMatchMode,
  MATCH_MODES,
  selectPlayersForRound,
  buildMatchesFrom16,
} from './logic'

const NETLIFY_PLAYERS_FN = '/.netlify/functions/players'
const NETLIFY_ADMIN_FN = '/.netlify/functions/checkAdmin'

// small helper so we don’t explode if something is undefined
const safe = (v, d) => (v === undefined || v === null ? d : v)

// consistent chip for courts / bench / lists
function PlayerChip({ player, onClick, highlight = false, dim = false, showBench = false }) {
  if (!player) return null
  const genderClass = player.gender === 'F' ? 'chip-f' : 'chip-m'
  const classes = [
    'player-chip',
    genderClass,
    highlight ? 'chip-highlight' : '',
    dim ? 'chip-dim' : '',
  ]
    .filter(Boolean)
    .join(' ')
  return (
    <button className={classes} onClick={onClick}>
      <span className="chip-name">{player.name}</span>
      {player.skill_level ? <span className="chip-level">L{player.skill_level}</span> : null}
      {showBench ? <span className="chip-bench">B{player.bench_count || 0}</span> : null}
    </button>
  )
}

export default function App() {
  /* ─────────────────────────────
     top-level state
  ───────────────────────────── */
  const [clubCode, setClubCode] = useState(null) // 'ABC' | 'EMBC'
  const [showClubModal, setShowClubModal] = useState(true)

  const [players, setPlayers] = useState([])
  const [loading, setLoading] = useState(false)

  const [isAdmin, setIsAdmin] = useState(false)
  const [showAdminModal, setShowAdminModal] = useState(false)

  const [isSession, setIsSession] = useState(false) // Begin Night -> true
  const [roundNumber, setRoundNumber] = useState(1)

  const [presentIds, setPresentIds] = useState(new Set())
  const [benchedLastRound, setBenchedLastRound] = useState(new Set())

  const [matches, setMatches] = useState([])

  const [roundSeconds, setRoundSeconds] = useState(12 * 60)
  const [transitionSeconds, setTransitionSeconds] = useState(30)
  const [remaining, setRemaining] = useState(12 * 60)
  const [phase, setPhase] = useState('idle') // 'idle' | 'round' | 'transition'
  const timerRef = useRef(null)

  const [showSettings, setShowSettings] = useState(false)
  const [settingsDraft, setSettingsDraft] = useState({
    roundMinutes: 12,
    transitionSeconds: 30,
    courts: 4,
  })

  const [showRundown, setShowRundown] = useState(false)
  const [rundownTab, setRundownTab] = useState('summary')

  // runtime session metrics
  const [sessionMetrics, setSessionMetrics] = useState({
    rounds: [],
    perPlayer: {}, // id -> {played, benched, worstBenchStreak, uniqTeam, uniqOpp}
  })

  // swap mode: click player on court -> choose bench player
  const [swapSource, setSwapSource] = useState(null) // {court, team, idx, playerId} | null

  // match mode (window/band)
  const [matchMode, setMatchModeState] = useState(getMatchMode())

  /* ─────────────────────────────
     fetch players for club
  ───────────────────────────── */
  useEffect(() => {
    if (!clubCode) return
    let cancelled = false
    ;(async () => {
      setLoading(true)
      try {
        const res = await fetch(`${NETLIFY_PLAYERS_FN}?club=${clubCode}`)
        const data = await res.json()
        if (!cancelled) {
          const normalized = (data || []).map((p) => ({
            ...p,
            bench_count: p.bench_count || 0,
            last_played_round: p.last_played_round || 0,
          }))
          setPlayers(normalized)
          // mark present based on is_present in db
          const pres = new Set(
            normalized.filter((p) => p.is_present).map((p) => p.id)
          )
          setPresentIds(pres)
        }
      } catch (err) {
        console.error('Could not load players (Netlify function).', err)
        alert('Could not load players (Netlify function). Check logs / env.')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [clubCode])

  /* ─────────────────────────────
     timer effect
  ───────────────────────────── */
  useEffect(() => {
    if (phase === 'round' || phase === 'transition') {
      timerRef.current = setInterval(() => {
        setRemaining((prev) => {
          if (prev > 1) return prev - 1
          // 0 reached
          clearInterval(timerRef.current)
          if (phase === 'round') {
            // move to transition, but we keep the new matches we already built
            setPhase('transition')
            return transitionSeconds
          } else {
            // transition ended -> start new round
            handleNextRound() // will rebuild matches + start round
            return roundSeconds
          }
        })
      }, 1000)
    }
    return () => clearInterval(timerRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, transitionSeconds, roundSeconds])

  /* ─────────────────────────────
     derived lists
  ───────────────────────────── */
  const presentPlayers = useMemo(
    () => players.filter((p) => presentIds.has(p.id)),
    [players, presentIds]
  )
  const absentPlayers = useMemo(
    () => players.filter((p) => !presentIds.has(p.id)),
    [players, presentIds]
  )

  /* ─────────────────────────────
     club chooser
  ───────────────────────────── */
  const handleClubSubmit = (code, pwd) => {
    const norm = code.toUpperCase()
    if (norm === 'ABC' && pwd === 'abc2025') {
      setClubCode('ABC')
      setShowClubModal(false)
    } else if (norm === 'EMBC' && pwd === '2025embc') {
      setClubCode('EMBC')
      setShowClubModal(false)
    } else {
      alert('Wrong club password')
    }
  }

  /* ─────────────────────────────
     admin check
  ───────────────────────────── */
  const openAdmin = () => setShowAdminModal(true)
  const handleAdminSubmit = async (pwd) => {
    try {
      const res = await fetch(
        `${NETLIFY_ADMIN_FN}?password=${encodeURIComponent(pwd)}`
      )
      const data = await res.json()
      if (data && data.ok) {
        setIsAdmin(true)
        setShowAdminModal(false)
      } else {
        alert('Wrong admin password')
      }
    } catch (e) {
      console.error(e)
      alert('Admin check failed')
    }
  }

  /* ─────────────────────────────
     present toggle  (this is where we now use PlayerChip style)
  ───────────────────────────── */
  const togglePresent = async (player) => {
    const next = new Set(presentIds)
    const willBePresent = !next.has(player.id)
    if (willBePresent) {
      next.add(player.id)
    } else {
      next.delete(player.id)
    }
    setPresentIds(next)
    // persist
    try {
      await fetch(`${NETLIFY_PLAYERS_FN}?club=${clubCode}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([
          {
            id: player.id,
            fields: {
              is_present: willBePresent,
            },
          },
        ]),
      })
    } catch (err) {
      console.error('Failed to save presence', err)
    }
  }

  /* ─────────────────────────────
     build / resume
  ───────────────────────────── */
  const handleBuildResume = () => {
    if (!isSession) return
    // if we already have matches and phase is paused -> just resume timer
    if (matches && matches.length > 0 && phase === 'idle') {
      setPhase('round')
      setRemaining(roundSeconds)
      return
    }
    handleNextRound(true)
  }

  const handleNextRound = (fromResume = false) => {
    // select fair players
    const sel = selectPlayersForRound(
      presentPlayers,
      roundNumber,
      benchedLastRound,
      settingsDraft.courts
    )
    const newMatches = buildMatchesFrom16(
      sel.playing,
      new Map(),
      settingsDraft.courts
    )
    setMatches(newMatches)
    setBenchedLastRound(new Set(sel.benched.map((b) => b.id)))
    // update per-player metrics
    setSessionMetrics((prev) => {
      const np = structuredClone(prev.perPlayer || {})
      const playedIds = new Set(sel.playing.map((p) => p.id))
      const benchedIds = new Set(sel.benched.map((p) => p.id))
      for (const p of presentPlayers) {
        if (!np[p.id]) {
          np[p.id] = {
            name: p.name,
            skill_level: p.skill_level,
            played: 0,
            benched: 0,
            worstBenchStreak: 0,
            curBenchStreak: 0,
            uniqTeam: new Set(),
            uniqOpp: new Set(),
          }
        }
        const slot = np[p.id]
        if (playedIds.has(p.id)) {
          slot.played += 1
          slot.curBenchStreak = 0
        } else if (benchedIds.has(p.id)) {
          slot.benched += 1
          slot.curBenchStreak += 1
          slot.worstBenchStreak = Math.max(
            slot.worstBenchStreak,
            slot.curBenchStreak
          )
        }
      }
      // fill teammate/opponent sets
      for (const m of newMatches) {
        const t1 = m.team1.map((p) => p.id)
        const t2 = m.team2.map((p) => p.id)
        const all = [...t1, ...t2]
        for (const id of all) {
          const slot = np[id]
          if (!slot) continue
          const others = all.filter((x) => x !== id)
          // team mates
          const tm = t1.includes(id) ? t1 : t2
          tm.filter((x) => x !== id).forEach((o) => slot.uniqTeam.add(o))
          // opponents
          const opp = t1.includes(id) ? t2 : t1
          opp.forEach((o) => slot.uniqOpp.add(o))
        }
      }
      const newRounds = [...(prev.rounds || []), { matches: newMatches.length }]
      return {
        rounds: newRounds,
        perPlayer: np,
      }
    })
    // start round
    setPhase('round')
    setRemaining(roundSeconds)
    if (!fromResume) {
      setRoundNumber((r) => r + 1)
    } else {
      // from initial resume, we want the roundNumber to advance too
      setRoundNumber((r) => r + 1)
    }
  }

    /* ─────────────────────────────
     swap mode
  ───────────────────────────── */
  const handleCourtPlayerClick = (courtIdx, teamKey, playerObj) => {
    // toggle
    if (
      swapSource &&
      swapSource.court === courtIdx &&
      swapSource.teamKey === teamKey &&
      swapSource.playerId === playerObj.id
    ) {
      setSwapSource(null)
      return
    }
    setSwapSource({
      court: courtIdx,
      teamKey,
      playerId: playerObj.id,
    })
  }

  const handleBenchClickForSwap = (benchPlayer) => {
    if (!swapSource) return
    // clone matches
    const nextMatches = matches.map((m) => ({ ...m, team1: [...m.team1], team2: [...m.team2] }))
    const m = nextMatches[swapSource.court]
    if (!m) return
    const teamArr = swapSource.teamKey === 'team1' ? m.team1 : m.team2
    const idx = teamArr.findIndex((p) => p.id === swapSource.playerId)
    if (idx === -1) {
      setSwapSource(null)
      return
    }
    const playerOut = teamArr[idx]
    // swap
    teamArr[idx] = benchPlayer
    // update benched list: remove benchPlayer, add playerOut
    const newBenched = players.filter(
      (p) => presentIds.has(p.id) && !nextMatches.some((mm) => mm.team1.concat(mm.team2).some((x) => x.id === p.id))
    )
    setMatches(nextMatches)
    setSwapSource(null)
    // also adjust bench_count in local players
    setPlayers((prev) =>
      prev.map((p) => {
        if (p.id === benchPlayer.id) {
          // was benched, now playing
          return { ...p, bench_count: Math.max(0, (p.bench_count || 0) - 1) }
        }
        if (p.id === playerOut.id) {
          // was playing, now benched
          return { ...p, bench_count: (p.bench_count || 0) + 1 }
        }
        return p
      })
    )
    // recompute benched view from current players
    setBenchedLastRound(new Set(newBenched.map((b) => b.id)))
  }

  /* ─────────────────────────────
     view helpers
  ───────────────────────────── */
  const presentCount = presentPlayers.length

  // players currently NOT in any match = benched view
  const benchedPlayers = players.filter(
    (p) =>
      presentIds.has(p.id) &&
      !matches.some((m) => m.team1.concat(m.team2).some((x) => x.id === p.id))
  )

  /* ─────────────────────────────
     session UI
  ───────────────────────────── */
  const renderCourts = () => {
    if (!matches || matches.length === 0) {
      return <div className="empty-note">No matches yet. Click Build/Resume.</div>
    }
    return (
      <div className="courts-grid">
        {matches.map((m, idx) => (
          <div key={idx} className="court">
            <div className="court-head">
              <div className="court-title">Court {m.court || idx + 1}</div>
              {isAdmin ? (
                <div className="court-avg">
                  <span>Team 1: {(m.avg1 || 0).toFixed(1)}</span>
                  <span>Team 2: {(m.avg2 || 0).toFixed(1)}</span>
                </div>
              ) : null}
            </div>
            <div className="team-row">
              {m.team1.map((p) => (
                <PlayerChip
                  key={p.id}
                  player={p}
                  onClick={() => handleCourtPlayerClick(idx, 'team1', p)}
                  highlight={
                    swapSource &&
                    swapSource.court === idx &&
                    swapSource.teamKey === 'team1' &&
                    swapSource.playerId === p.id
                  }
                  dim={
                    !!swapSource &&
                    !(
                      swapSource.court === idx &&
                      swapSource.teamKey === 'team1' &&
                      swapSource.playerId === p.id
                    )
                  }
                  showBench={isAdmin}
                />
              ))}
            </div>
            <div className="net-divider" />
            <div className="team-row">
              {m.team2.map((p) => (
                <PlayerChip
                  key={p.id}
                  player={p}
                  onClick={() => handleCourtPlayerClick(idx, 'team2', p)}
                  highlight={
                    swapSource &&
                    swapSource.court === idx &&
                    swapSource.teamKey === 'team2' &&
                    swapSource.playerId === p.id
                  }
                  dim={
                    !!swapSource &&
                    !(
                      swapSource.court === idx &&
                      swapSource.teamKey === 'team2' &&
                      swapSource.playerId === p.id
                    )
                  }
                  showBench={isAdmin}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    )
  }

  const renderBenched = () => (
    <div className="benched-strip">
      <div className="panel-head">
        <div>Benched Players</div>
        <div className="badge">{benchedPlayers.length}</div>
      </div>
      <div className="bench-row">
        {benchedPlayers.map((p) => (
          <PlayerChip
            key={p.id}
            player={p}
            onClick={() => handleBenchClickForSwap(p)}
            showBench={isAdmin}
          />
        ))}
        {benchedPlayers.length === 0 ? <div className="muted">No one is benched.</div> : null}
      </div>
    </div>
  )

  // ✅ THIS is the change you asked for:
  // All Players + Present Today now use PlayerChip so they match the court/bench style.
  const renderLists = () => (
    <div className="lists-row">
      <div className="list-panel">
        <div className="panel-head">
          <span>All Players</span>
          <span className="badge">{absentPlayers.length}</span>
        </div>
        <div className="list-body">
          {absentPlayers.map((p) => (
            <div key={p.id} className="list-line">
              <PlayerChip
                player={p}
                onClick={() => togglePresent(p)}
              />
              {isAdmin ? (
                <button
                  className="list-del"
                  onClick={async () => {
                    if (!window.confirm('Delete this player?')) return
                    try {
                      await fetch(`${NETLIFY_PLAYERS_FN}?club=${clubCode}`, {
                        method: 'DELETE',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ id: p.id }),
                      })
                      setPlayers((prev) => prev.filter((x) => x.id !== p.id))
                      setPresentIds((prev) => {
                        const next = new Set(prev)
                        next.delete(p.id)
                        return next
                      })
                    } catch (err) {
                      alert('Delete failed')
                    }
                  }}
                >
                  ×
                </button>
              ) : null}
            </div>
          ))}
        </div>
      </div>
      <div className="list-panel">
        <div className="panel-head">
          <span>Present Today</span>
          <span className="badge">{presentPlayers.length}</span>
        </div>
        <div className="list-body">
          {presentPlayers.map((p) => (
            <div key={p.id} className="list-line">
              <PlayerChip
                player={p}
                onClick={() => togglePresent(p)}
                showBench={isAdmin}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  )

  /* ─────────────────────────────
     display mode (same courts)
  ───────────────────────────── */
  const renderDisplay = () => (
    <div className="display-overlay">
      <div className="display-head">
        <div className="display-title">The FLOminton System ({clubCode})</div>
        <div
          className={
            phase === 'round' && remaining <= 30
              ? 'bigtime warn'
              : phase === 'transition'
                ? 'bigtime blink'
                : 'bigtime'
          }
        >
          {formatTime(remaining)}
        </div>
        <div className="display-meta">
          <span>Round {roundNumber}</span>
          <span>{presentCount} present</span>
        </div>
        <button className="btn" onClick={() => setIsSession(true)}>
          Back
        </button>
      </div>
      <div className="display-courts">
        {matches.map((m, idx) => (
          <div key={idx} className="display-court">
            <div className="display-court-title">Court {m.court || idx + 1}</div>
            <div className="display-team-row">
              {m.team1.map((p) => (
                <PlayerChip key={p.id} player={p} />
              ))}
            </div>
            <div className="net-divider" />
            <div className="display-team-row">
              {m.team2.map((p) => (
                <PlayerChip key={p.id} player={p} />
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="display-benched">
        <h3>Benched</h3>
        <div className="bench-row">
          {benchedPlayers.map((p) => (
            <PlayerChip key={p.id} player={p} />
          ))}
        </div>
      </div>
    </div>
  )

  /* ─────────────────────────────
     home screen
  ───────────────────────────── */
  const renderHome = () => (
    <div className="home-screen">
      <button className="btn primary" onClick={() => setIsSession(true)}>
        Begin Night
      </button>
      <button className="btn" onClick={() => setShowSettings(true)}>
        Settings
      </button>
      <button className="btn" onClick={openAdmin}>
        Admin
      </button>
      <button
        className="btn danger"
        onClick={() => {
          // end night here if needed
          setIsSession(false)
          setMatches([])
          setPresentIds(new Set())
          setRoundNumber(1)
        }}
      >
        End Night
      </button>
    </div>
  )

    /* ─────────────────────────────
     settings modal save
  ───────────────────────────── */
  const handleSaveSettings = () => {
    setRoundSeconds(settingsDraft.roundMinutes * 60)
    setTransitionSeconds(settingsDraft.transitionSeconds)
    setShowSettings(false)
  }

  /* ─────────────────────────────
     top bar
  ───────────────────────────── */
  const renderTopBar = () => (
    <header className="top-bar">
      <div className="brand">The FLOminton System ({clubCode})</div>
      <div className="top-actions">
        {!isSession ? (
          <button className="btn primary" onClick={() => setIsSession(true)}>
            Begin Night
          </button>
        ) : (
          <>
            <button className="btn primary" onClick={handleBuildResume}>
              Build/Resume
            </button>
            <button className="btn" onClick={() => setPhase('idle')}>
              Pause
            </button>
            <button className="btn" onClick={() => handleNextRound(true)}>
              Next Round
            </button>
            <button className="btn danger" onClick={() => setShowRundown(true)}>
              End Night
            </button>
            <button className="btn" onClick={() => setIsSession(false)}>
              Home
            </button>
            <button className="btn" onClick={() => setShowSettings(true)}>
              Settings
            </button>
            <button className="btn" onClick={openAdmin}>
              Admin
            </button>
            <div
              className={
                phase === 'round' && remaining <= 30
                  ? 'round-pill warn'
                  : phase === 'transition'
                    ? 'round-pill blink'
                    : 'round-pill'
              }
            >
              R{roundNumber} · {formatTime(remaining)}
            </div>
          </>
        )}
      </div>
    </header>
  )

  /* ─────────────────────────────
     main JSX return
  ───────────────────────────── */
  return (
    <div className="app-shell">
      {/* CLUB GATE */}
      {showClubModal && (
        <ClubModal
          onSubmit={handleClubSubmit}
        />
      )}

      {!showClubModal && renderTopBar()}

      {!showClubModal && (
        <>
          {!isSession ? (
            renderHome()
          ) : (
            <>
              {/* session page */}
              <main className="session-shell">
                {renderCourts()}
                {renderBenched()}
                {renderLists()}
              </main>
            </>
          )}
        </>
      )}

      {/* display mode lives inside session in this version */}
      {/* (if you wanted separate view toggle, you can conditionally render renderDisplay() instead) */}

      {showSettings && (
        <SettingsModal
          draft={settingsDraft}
          setDraft={setSettingsDraft}
          onClose={() => setShowSettings(false)}
          onSave={handleSaveSettings}
        />
      )}

      {showAdminModal && (
        <AdminModal
          onClose={() => setShowAdminModal(false)}
          onSubmit={handleAdminSubmit}
        />
      )}

      {showRundown && (
        <RundownModal
          onClose={() => setShowRundown(false)}
          rounds={sessionMetrics.rounds}
          perPlayer={sessionMetrics.perPlayer}
        />
      )}
    </div>
  )
}

/* ─────────────────────────────
   MODALS
───────────────────────────── */

function ClubModal({ onSubmit }) {
  const [club, setClub] = useState('ABC')
  const [pwd, setPwd] = useState('')
  return (
    <div className="modal-overlay">
      <div className="modal">
        <h2>Select club</h2>
        <label>Club</label>
        <select value={club} onChange={(e) => setClub(e.target.value)}>
          <option value="ABC">Axis Badminton Club (ABC)</option>
          <option value="EMBC">East Meath Badminton Club (EMBC)</option>
        </select>
        <label>Password</label>
        <input
          type="password"
          value={pwd}
          onChange={(e) => setPwd(e.target.value)}
        />
        <div className="modal-actions">
          <button className="btn" onClick={() => onSubmit(club, pwd)}>
            Enter
          </button>
        </div>
      </div>
    </div>
  )
}

function AdminModal({ onClose, onSubmit }) {
  const [pwd, setPwd] = useState('')
  return (
    <div className="modal-overlay">
      <div className="modal">
        <h2>Admin password</h2>
        <input
          type="password"
          value={pwd}
          onChange={(e) => setPwd(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && onSubmit(pwd)}
        />
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => onSubmit(pwd)}>
            Enter
          </button>
        </div>
      </div>
    </div>
  )
}

function SettingsModal({ draft, setDraft, onClose, onSave }) {
  return (
    <div className="modal-overlay">
      <div className="modal settings">
        <h2>Settings</h2>
        <label>Round length (minutes)</label>
        <input
          type="number"
          min="3"
          max="60"
          value={draft.roundMinutes}
          onChange={(e) =>
            setDraft((prev) => ({ ...prev, roundMinutes: Number(e.target.value) }))
          }
        />
        <label>Transition time (seconds)</label>
        <input
          type="number"
          min="5"
          max="120"
          value={draft.transitionSeconds}
          onChange={(e) =>
            setDraft((prev) => ({ ...prev, transitionSeconds: Number(e.target.value) }))
          }
        />
        <label>Courts</label>
        <input
          type="number"
          min="1"
          max="12"
          value={draft.courts}
          onChange={(e) => setDraft((prev) => ({ ...prev, courts: Number(e.target.value) }))}
        />
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={onSave}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

function RundownModal({ onClose, rounds, perPlayer }) {
  const roundCount = rounds?.length || 0
  const players = Object.values(perPlayer || {})

  return (
    <div className="modal-overlay">
      <div className="modal rundown">
        <div className="rundown-head">
          <h2>Smart Session Summary</h2>
          <button className="btn" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="summary-grid">
          <div className="summary-card">
            <div className="summary-label">Rounds played</div>
            <div className="summary-value">{roundCount}</div>
          </div>
          <div className="summary-card">
            <div className="summary-label">Players present</div>
            <div className="summary-value">{players.length}</div>
          </div>
        </div>
        <div className="summary-table-wrap">
          <table className="summary-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Lvl</th>
                <th>Played</th>
                <th>Benched</th>
                <th>Worst bench streak</th>
                <th>Unique teammates</th>
                <th>Unique opponents</th>
              </tr>
            </thead>
            <tbody>
              {players.map((p) => (
                <tr key={p.name}>
                  <td>{p.name}</td>
                  <td>{p.skill_level}</td>
                  <td>{p.played || 0}</td>
                  <td>{p.benched || 0}</td>
                  <td>{p.worstBenchStreak || 0}</td>
                  <td>{p.uniqTeam ? p.uniqTeam.size : 0}</td>
                  <td>{p.uniqOpp ? p.uniqOpp.size : 0}</td>
                </tr>
              ))}
              {players.length === 0 ? (
                <tr>
                  <td colSpan="7" className="muted">
                    No data for this session
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
        <div className="modal-actions right">
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
