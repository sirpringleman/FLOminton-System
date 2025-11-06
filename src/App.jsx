import React, {
  useEffect,
  useState,
  useRef,
  useMemo,
} from 'react'
import {
  selectPlayersForRound,
  buildMatchesFrom16,
  MATCH_MODES,
  getMatchMode,
  setMatchMode,
  formatTime,
} from './logic'
import supabase from './supabaseClient'

const NETLIFY_PLAYERS_FN = '/.netlify/functions/players'
const ADMIN_PASSWORD = 'floadmin' // your admin password
const CLUBS = [
  { code: 'ABC', name: 'Axis Badminton Club', password: 'abc2025' },
  { code: 'EMBC', name: 'East Meath Badminton Club', password: '2025embc' },
]

function App() {
  /* -------------------- global state -------------------- */
  const [view, setView] = useState('home') // 'home' | 'session' | 'display'
  const [players, setPlayers] = useState([])
  const [loadingPlayers, setLoadingPlayers] = useState(false)
  const [selectedMatches, setSelectedMatches] = useState([])
  const [benched, setBenched] = useState([])
  const [roundNumber, setRoundNumber] = useState(1)
  const [secondsLeft, setSecondsLeft] = useState(600) // round timer
  const [isRunning, setIsRunning] = useState(false)
  const [isTransition, setIsTransition] = useState(false)
  const [lastRoundBenched, setLastRoundBenched] = useState(new Set())
  const [isAdmin, setIsAdmin] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showAddPlayer, setShowAddPlayer] = useState(false)
  const [showAdminPassword, setShowAdminPassword] = useState(false)
  const [showRundown, setShowRundown] = useState(false)
  const [sessionStats, setSessionStats] = useState(makeEmptySessionStats())
  const [diagStats, setDiagStats] = useState(makeEmptyDiagStats())
  const [clubModalOpen, setClubModalOpen] = useState(true)
  const [clubError, setClubError] = useState('')
  const [activeClub, setActiveClub] = useState(null)

  // settings
  const [settings, setSettings] = useState(() => ({
    roundDuration: 600,
    transitionDuration: 30,
    courts: 4,
    showSkill: false,
  }))

  // timer refs
  const timerRef = useRef(null)
  const mode = getMatchMode()

  /* -------------------- effects -------------------- */

  // load from backend once club is picked
  useEffect(() => {
    if (!activeClub) return
    fetchPlayers(activeClub)
  }, [activeClub])

  // timer tick
  useEffect(() => {
    if (!isRunning) return
    timerRef.current = setInterval(() => {
      setSecondsLeft((prev) => {
        if (prev > 1) return prev - 1
        // reached 0 -> if we were in round, go to transition
        clearInterval(timerRef.current)
        timerRef.current = null
        handleTimerEnd()
        return 0
      })
    }, 1000)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
  }, [isRunning])

  /* -------------------- core functions -------------------- */

  async function fetchPlayers(clubCode) {
    setLoadingPlayers(true)
    try {
      const res = await fetch(NETLIFY_PLAYERS_FN + `?club_code=${clubCode}`)
      const data = await res.json()
      // normalise
      const list = Array.isArray(data) ? data : []
      setPlayers(list)
    } catch (err) {
      console.error('Could not load players (Netlify function).', err)
      alert('Could not load players (Netlify function). Check logs / env.')
    } finally {
      setLoadingPlayers(false)
    }
  }

  function startSessionView() {
    setView('session')
  }

  function handleBuildOrResume() {
    // if we already have matches, just resume timer
    if (selectedMatches && selectedMatches.length > 0 && !isTransition) {
      setIsRunning(true)
      return
    }
    // otherwise build
    buildNewRound()
  }

  function handlePause() {
    setIsRunning(false)
  }

  function handleNextRound() {
    // manual next round: build immediately + start round timer (skip transition)
    buildNewRound({ skipTransition: true })
  }

  function handleEndNight() {
    // stop timers
    setIsRunning(false)
    setIsTransition(false)
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
    // show summary
    setShowRundown(true)
    // reset present flags + bench counts local-side
    const reset = players.map((p) => ({
      ...p,
      is_present: false,
      bench_count: 0,
      last_played_round: 0,
    }))
    setPlayers(reset)
    setSelectedMatches([])
    setBenched([])
    setRoundNumber(1)
    setSecondsLeft(settings.roundDuration)
  }

  function handleTimerEnd() {
    // if we were in round → go to transition
    if (!isTransition) {
      // create new matches immediately so players can see where to go
      // but do not start the round timer yet
      buildNewRound({ buildOnly: true })
      setIsTransition(true)
      setSecondsLeft(settings.transitionDuration)
      setIsRunning(true)
    } else {
      // we were in transition → start actual round
      setIsTransition(false)
      setSecondsLeft(settings.roundDuration)
      setIsRunning(true)
    }
  }

  function buildNewRound(opts = {}) {
    const { skipTransition = false, buildOnly = false } = opts
    if (!players || !players.length) return

    const present = players.filter((p) => p.is_present)
    if (present.length < 4) {
      setSelectedMatches([])
      setBenched(present.slice())
      return
    }

    const started = performance.now()
    const { playing, benched: newBenched } = selectPlayersForRound(
      present,
      roundNumber,
      lastRoundBenched,
      settings.courts
    )

    // build matches
    const matches = buildMatchesFrom16(playing, new Map(), settings.courts)

    // persist local bench + last played
    const updatedPlayers = players.map((p) => {
      const isPlaying = playing.find((x) => x.id === p.id)
      if (isPlaying) {
        return {
          ...p,
          last_played_round: roundNumber,
        }
      }
      if (newBenched.find((x) => x.id === p.id)) {
        return {
          ...p,
          bench_count: (p.bench_count || 0) + 1,
        }
      }
      return p
    })
    setPlayers(updatedPlayers)
    setSelectedMatches(matches)
    setBenched(newBenched)
    setLastRoundBenched(new Set(newBenched.map((b) => b.id)))

    // record diagnostics
    const buildMs = performance.now() - started
    setDiagStats((prev) => ({
      ...prev,
      buildTimes: [...prev.buildTimes, buildMs],
      courtsUsed: [...prev.courtsUsed, matches.length],
      teamImbalances: [
        ...prev.teamImbalances,
        ...matches.map((m) => Math.abs((m.avg1 || 0) - (m.avg2 || 0))),
      ],
      skillSpans: [
        ...prev.skillSpans,
        ...matches.map((m) => {
          const all = [...m.team1, ...m.team2].map((p) => p.skill_level || 0)
          return Math.max(...all) - Math.min(...all)
        }),
      ],
    }))

    // record session stats
    setSessionStats((prev) => accumulateSessionStats(prev, matches, newBenched, roundNumber, present))

    // manage timers
    if (buildOnly) {
      // we only needed new quads visible
      return
    }

    if (skipTransition) {
      // go straight into round timer
      setIsTransition(false)
      setSecondsLeft(settings.roundDuration)
      setIsRunning(true)
      setRoundNumber((r) => r + 1)
    } else {
      // go into transition right away
      setIsTransition(true)
      setSecondsLeft(settings.transitionDuration)
      setIsRunning(true)
      setRoundNumber((r) => r + 1)
    }
  }

  /* -------------------- helpers -------------------- */

  function togglePresent(id) {
    const updated = players.map((p) =>
      p.id === id ? { ...p, is_present: !p.is_present } : p
    )
    setPlayers(updated)
    // also send to backend
    savePlayerPatch(id, { is_present: updated.find((p) => p.id === id)?.is_present })
  }

  async function savePlayerPatch(id, fields) {
    try {
      await fetch(NETLIFY_PLAYERS_FN, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, fields }),
      })
    } catch (err) {
      console.error('patch failed', err)
    }
  }

  function openAdmin() {
    setShowAdminPassword(true)
  }

  function handleAdminPassword(pw) {
    if (pw === ADMIN_PASSWORD) {
      setIsAdmin(true)
      setShowAdminPassword(false)
    } else {
      alert('Incorrect admin password')
    }
  }

  function handleClubSelect(code, pw) {
    const club = CLUBS.find((c) => c.code === code)
    if (!club) {
      setClubError('Unknown club.')
      return
    }
    if (pw !== club.password) {
      setClubError('Incorrect club password.')
      return
    }
    setActiveClub(club.code)
    setClubModalOpen(false)
  }

  function handleSettingsSave(next) {
    setSettings(next)
    setShowSettings(false)
  }

  /* -------------------- memoised pieces -------------------- */

  const presentPlayers = useMemo(
    () => players.filter((p) => p.is_present),
    [players]
  )

  /* -------------------- render -------------------- */

  return (
    <>
      <div className="app-shell">
        <TopBar
          view={view}
          setView={setView}
          onBegin={startSessionView}
          onPause={handlePause}
          onResume={handleBuildOrResume}
          onNext={handleNextRound}
          onEnd={handleEndNight}
          onOpenDisplay={() => setView('display')}
          onOpenSettings={() => setShowSettings(true)}
          onAdmin={openAdmin}
          isAdmin={isAdmin}
          mode={mode}
          onModeToggle={() => {
            const next = mode === MATCH_MODES.BAND ? MATCH_MODES.WINDOW : MATCH_MODES.BAND
            setMatchMode(next)
          }}
          roundNumber={roundNumber}
          secondsLeft={secondsLeft}
          isTransition={isTransition}
          settings={settings}
          onHome={() => setView('home')}
        />

        {view === 'home' && (
          <HomeScreen
            onBegin={startSessionView}
            onSettings={() => setShowSettings(true)}
            onAdmin={openAdmin}
            onEnd={handleEndNight}
            disabled={!activeClub}
          />
        )}

        {view === 'session' && (
          <SessionScreen
            players={players}
            presentPlayers={presentPlayers}
            matches={selectedMatches}
            benched={benched}
            settings={settings}
            isAdmin={isAdmin}
            onTogglePresent={togglePresent}
            onAddPlayer={() => setShowAddPlayer(true)}
            onDeletePlayer={(id) => deletePlayer(id, setPlayers)}
            onUpdatePlayer={(p) => updatePlayer(p, setPlayers)}
          />
        )}

        {view === 'display' && (
          <DisplayScreen
            matches={selectedMatches}
            benched={benched}
            roundNumber={roundNumber}
            secondsLeft={secondsLeft}
            isTransition={isTransition}
            presentCount={presentPlayers.length}
            settings={settings}
          />
        )}
      </div>

      {/* modals */}
      {clubModalOpen && (
        <ClubModal
          clubs={CLUBS}
          error={clubError}
          onSubmit={handleClubSelect}
        />
      )}

      {showSettings && (
        <SettingsModal
          settings={settings}
          onClose={() => setShowSettings(false)}
          onSave={handleSettingsSave}
        />
      )}

      {showAdminPassword && (
        <AdminPasswordModal
          onClose={() => setShowAdminPassword(false)}
          onSubmit={handleAdminPassword}
        />
      )}

      {showAddPlayer && (
        <AddPlayerModal
          clubCode={activeClub}
          onClose={() => setShowAddPlayer(false)}
          onAdded={(list) => setPlayers(list)}
        />
      )}

      {showRundown && (
        <RundownModal
          onClose={() => setShowRundown(false)}
          sessionStats={sessionStats}
          diag={diagStats}
          isAdmin={isAdmin}
        />
      )}
    </>
  )
}

/* -------------------- sub components & helpers -------------------- */

function TopBar({
  view,
  setView,
  onBegin,
  onPause,
  onResume,
  onNext,
  onEnd,
  onOpenDisplay,
  onOpenSettings,
  onAdmin,
  isAdmin,
  mode,
  onModeToggle,
  roundNumber,
  secondsLeft,
  isTransition,
  settings,
  onHome,
}) {
  const timeStr = formatTime(secondsLeft)
  const warn = !isTransition && secondsLeft <= 30
  const blink = secondsLeft === 0 || isTransition

  return (
    <header className="topbar">
      <div className="topbar-left">
        <button className={view === 'home' ? 'btn btn-primary' : 'btn'} onClick={onHome}>
          Home
        </button>
        <button className={view === 'session' ? 'btn btn-primary' : 'btn'} onClick={onBegin}>
          Begin Night
        </button>
        <button className="btn" onClick={onPause}>
          Pause
        </button>
        <button className="btn btn-primary" onClick={onResume}>
          Build/Resume
        </button>
        <button className="btn" onClick={onNext}>
          Next Round
        </button>
        <button className="btn btn-danger" onClick={onEnd}>
          End Night
        </button>
        <button className={view === 'display' ? 'btn btn-primary' : 'btn'} onClick={onOpenDisplay}>
          Open Display
        </button>
        <button className="btn" onClick={onModeToggle}>
          Mode: {mode === 'band' ? 'Band' : 'Window'}
        </button>
        <button className="btn" onClick={onOpenSettings}>
          Settings
        </button>
        <button className={isAdmin ? 'btn btn-primary' : 'btn'} onClick={onAdmin}>
          Admin
        </button>
      </div>
      <div className="topbar-right">
        <div className="round-label">Round {roundNumber}</div>
        <div
          className={
            'timer' +
            (warn ? ' timer-warn' : '') +
            (blink ? ' timer-blink' : '')
          }
        >
          {isTransition ? '↻ ' : ''}
          {timeStr}
        </div>
      </div>
    </header>
  )
}

function HomeScreen({ onBegin, onSettings, onAdmin, onEnd, disabled }) {
  return (
    <main className="home-screen">
      <div className="home-card">
        <h1 className="app-title">The FLOminton System</h1>
        <p className="subtitle">Choose an action to begin</p>
        <div className="home-actions">
          <button className="btn btn-primary lg" onClick={onBegin} disabled={disabled}>
            Begin Night
          </button>
          <button className="btn lg" onClick={onSettings} disabled={disabled}>
            Settings
          </button>
          <button className="btn lg" onClick={onAdmin} disabled={disabled}>
            Admin Mode
          </button>
          <button className="btn btn-danger lg" onClick={onEnd} disabled={disabled}>
            End Night
          </button>
        </div>
        {disabled && <p className="hint">Select club first.</p>}
      </div>
    </main>
  )
}

function SessionScreen({
  players,
  presentPlayers,
  matches,
  benched,
  settings,
  isAdmin,
  onTogglePresent,
  onAddPlayer,
  onDeletePlayer,
  onUpdatePlayer,
}) {
  return (
    <main className="session-screen">
      <div className="courts-grid">
        {Array.isArray(matches) && matches.length > 0 ? (
          matches.map((m) => (
            <CourtCard key={m.court} match={m} settings={settings} isAdmin={isAdmin} />
          ))
        ) : (
          <div className="empty-courts">No matches yet. Click Build/Resume.</div>
        )}
      </div>

      <div className="benched-strip">
        <h3>Benched Players</h3>
        <div className="benched-row">
          {benched && benched.length
            ? benched.map((p) => (
                <PlayerChip key={p.id} player={p} showSkill={isAdmin && settings.showSkill} />
              ))
            : <span className="muted">None</span>}
        </div>
      </div>

      <div className="lists-row">
        <div className="list-card">
          <div className="list-header">
            <h3>All Players</h3>
            <span className="count">{players.length}</span>
          </div>
          <div className="list-body scroll-y">
            {players.map((p) => (
              <div
                key={p.id}
                className={'list-row ' + (p.is_present ? 'is-present' : '')}
                onDoubleClick={() => onTogglePresent(p.id)}
              >
                <span>{p.name}</span>
                {isAdmin && settings.showSkill && <span className="muted">L{p.skill_level}</span>}
                {isAdmin && (
                  <div className="row-actions">
                    <button onClick={() => onUpdatePlayer(p)} className="tiny-btn">Edit</button>
                    <button onClick={() => onDeletePlayer(p.id)} className="tiny-btn danger">Del</button>
                  </div>
                )}
              </div>
            ))}
          </div>
          {isAdmin && (
            <div className="list-footer">
              <button className="btn btn-primary" onClick={onAddPlayer}>
                Add Player
              </button>
            </div>
          )}
        </div>

        <div className="list-card">
          <div className="list-header">
            <h3>Present Today</h3>
            <span className="count">{presentPlayers.length}</span>
          </div>
          <div className="list-body scroll-y">
            {presentPlayers.map((p) => (
              <div
                key={p.id}
                className="list-row is-present"
                onDoubleClick={() => onTogglePresent(p.id)}
              >
                <span>{p.name}</span>
                {isAdmin && settings.showSkill && <span className="muted">L{p.skill_level}</span>}
                {isAdmin && <span className="muted">Benched {p.bench_count || 0}</span>}
              </div>
            ))}
          </div>
        </div>
      </div>

      {isAdmin && (
        <div className="admin-panel">
          <h3>Admin Controls</h3>
          <p className="muted">Skill visibility toggle is in Settings.</p>
        </div>
      )}
    </main>
  )
}

function CourtCard({ match, settings, isAdmin }) {
  const { court, team1 = [], team2 = [], avg1, avg2 } = match
  return (
    <div className="court-card">
      <div className="court-head">
        <h3>Court {court}</h3>
        {isAdmin && (
          <div className="team-avg">
            Team 1 Avg <b>{avg1?.toFixed ? avg1.toFixed(1) : avg1}</b>&nbsp;&nbsp;
            Team 2 Avg <b>{avg2?.toFixed ? avg2.toFixed(1) : avg2}</b>
          </div>
        )}
      </div>
      <div className="court-team-row">
        <div className="team-row">
          {team1.map((p) => (
            <PlayerChip key={p.id} player={p} showSkill={isAdmin && settings.showSkill} />
          ))}
        </div>
      </div>
      <div className="court-net" />
      <div className="court-team-row">
        <div className="team-row">
          {team2.map((p) => (
            <PlayerChip key={p.id} player={p} showSkill={isAdmin && settings.showSkill} />
          ))}
        </div>
      </div>
    </div>
  )
}

function PlayerChip({ player, showSkill }) {
  const genderClass = player.gender === 'F' ? 'chip female' : 'chip male'
  return (
    <div className={genderClass}>
      <span className="chip-name">{player.name}</span>
      {showSkill && <span className="chip-skill">L{player.skill_level}</span>}
    </div>
  )
}

function DisplayScreen({
  matches,
  benched,
  roundNumber,
  secondsLeft,
  isTransition,
  presentCount,
  settings,
}) {
  return (
    <main className="display-screen">
      <div className="display-topline">
        <div className="display-title">The FLOminton System</div>
        <div className="display-round">Round {roundNumber}</div>
        <div
          className={
            'display-timer' +
            (isTransition ? ' timer-blink' : '') +
            (secondsLeft <= 30 && !isTransition ? ' timer-warn' : '')
          }
        >
          {formatTime(secondsLeft)}
        </div>
        <div className="display-present">Players: {presentCount}</div>
      </div>
      <div className="display-courts-grid">
        {matches && matches.length ? (
          matches.map((m) => (
            <div key={m.court} className="display-court-card">
              <div className="dc-head">
                <h3>Court {m.court}</h3>
              </div>
              <div className="dc-team-row">
                {m.team1.map((p) => (
                  <div key={p.id} className={'dc-chip ' + (p.gender === 'F' ? 'f' : 'm')}>
                    {p.name}
                  </div>
                ))}
              </div>
              <div className="dc-net" />
              <div className="dc-team-row">
                {m.team2.map((p) => (
                  <div key={p.id} className={'dc-chip ' + (p.gender === 'F' ? 'f' : 'm')}>
                    {p.name}
                  </div>
                ))}
              </div>
            </div>
          ))
        ) : (
          <div className="display-empty">Waiting for matches...</div>
        )}
      </div>

      <div className="display-benched">
        <h4>Benched this round</h4>
        <div className="display-benched-row">
          {benched && benched.length
            ? benched.map((p) => (
                <div key={p.id} className={'dc-chip ' + (p.gender === 'F' ? 'f' : 'm')}>
                  {p.name}
                </div>
              ))
            : <span className="muted">None</span>}
        </div>
      </div>
    </main>
  )
}

function ClubModal({ clubs, error, onSubmit }) {
  const [code, setCode] = useState(clubs[0]?.code || '')
  const [pw, setPw] = useState('')
  return (
    <div className="modal-overlay">
      <div className="modal">
        <h2>Select your club</h2>
        <label className="field">
          <span>Club</span>
          <select value={code} onChange={(e) => setCode(e.target.value)}>
            {clubs.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name} ({c.code})
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Password</span>
          <input
            type="password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            placeholder="Enter club password"
          />
        </label>
        {error && <p className="error">{error}</p>}
        <div className="modal-actions">
          <button className="btn btn-primary" onClick={() => onSubmit(code, pw)}>
            Continue
          </button>
        </div>
      </div>
    </div>
  )
}

function SettingsModal({ settings, onClose, onSave }) {
  const [draft, setDraft] = useState(settings)

  return (
    <div className="modal-overlay">
      <div className="modal large">
        <div className="modal-head">
          <h2>Settings</h2>
          <button className="icon-btn" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="settings-grid">
          <label className="field">
            <span>Round duration (seconds)</span>
            <input
              type="number"
              value={draft.roundDuration}
              onChange={(e) =>
                setDraft((d) => ({ ...d, roundDuration: Number(e.target.value) || 0 }))
              }
            />
          </label>
          <label className="field">
            <span>Transition duration (seconds)</span>
            <input
              type="number"
              value={draft.transitionDuration}
              onChange={(e) =>
                setDraft((d) => ({ ...d, transitionDuration: Number(e.target.value) || 0 }))
              }
            />
          </label>
          <label className="field">
            <span>Courts available</span>
            <input
              type="number"
              min="1"
              max="10"
              value={draft.courts}
              onChange={(e) =>
                setDraft((d) => ({ ...d, courts: Number(e.target.value) || 1 }))
              }
            />
          </label>
          <label className="field checkbox">
            <input
              type="checkbox"
              checked={draft.showSkill}
              onChange={(e) => setDraft((d) => ({ ...d, showSkill: e.target.checked }))}
            />
            <span>Show skill level (when admin)</span>
          </label>
        </div>
        <div className="modal-actions right">
          <button className="btn" onClick={onClose}>
            Close
          </button>
          <button className="btn btn-primary" onClick={() => onSave(draft)}>
            Save changes
          </button>
        </div>
      </div>
    </div>
  )
}

function AdminPasswordModal({ onClose, onSubmit }) {
  const [pw, setPw] = useState('')
  return (
    <div className="modal-overlay">
      <div className="modal">
        <div className="modal-head">
          <h2>Admin password</h2>
          <button className="icon-btn" onClick={onClose}>
            ×
          </button>
        </div>
        <label className="field">
          <span>Password</span>
          <input
            type="password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && onSubmit(pw)}
          />
        </label>
        <div className="modal-actions right">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={() => onSubmit(pw)}>
            Unlock
          </button>
        </div>
      </div>
    </div>
  )
}

function AddPlayerModal({ clubCode, onClose, onAdded }) {
  const [name, setName] = useState('')
  const [gender, setGender] = useState('M')
  const [skill, setSkill] = useState(5)

  async function handleAdd() {
    try {
      const res = await fetch('/.netlify/functions/players', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          players: [
            {
              name,
              gender,
              skill_level: Number(skill),
              is_present: false,
              bench_count: 0,
              last_played_round: 0,
              club_code: clubCode,
            },
          ],
        }),
      })
      const data = await res.json()
      if (Array.isArray(data)) {
        onAdded(data)
      }
      onClose()
    } catch (err) {
      console.error(err)
      alert('Error adding player.')
    }
  }

  return (
    <div className="modal-overlay">
      <div className="modal">
        <div className="modal-head">
          <h2>Add player</h2>
          <button className="icon-btn" onClick={onClose}>
            ×
          </button>
        </div>
        <label className="field">
          <span>Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span>Gender</span>
          <select value={gender} onChange={(e) => setGender(e.target.value)}>
            <option value="M">Male</option>
            <option value="F">Female</option>
          </select>
        </label>
        <label className="field">
          <span>Skill level (1-10)</span>
          <input
            type="number"
            min="1"
            max="10"
            value={skill}
            onChange={(e) => setSkill(e.target.value)}
          />
        </label>
        <div className="modal-actions right">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={handleAdd} disabled={!name}>
            Add
          </button>
        </div>
      </div>
    </div>
  )
}

function RundownModal({ onClose, sessionStats, diag, isAdmin }) {
  const [tab, setTab] = useState('summary')
  const perPlayer = sessionStats.perPlayer || []

  return (
    <div className="modal-overlay">
      <div className="modal xl">
        <div className="modal-head">
          <h2>Session Overview</h2>
          <button className="icon-btn" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="tabs-row">
          <button
            className={tab === 'summary' ? 'tab active' : 'tab'}
            onClick={() => setTab('summary')}
          >
            Smart Session Summary
          </button>
          <button
            className={tab === 'diagnostics' ? 'tab active' : 'tab'}
            onClick={() => setTab('diagnostics')}
          >
            System Diagnostics
          </button>
        </div>

        {tab === 'summary' && (
          <div className="summary-body">
            <div className="summary-cards">
              <SummaryCard label="Rounds played" value={sessionStats.rounds} />
              <SummaryCard label="Players present" value={sessionStats.playersPresent} />
              <SummaryCard
                label="Avg courts used"
                value={
                  sessionStats.rounds
                    ? (sessionStats.totalCourtsUsed / sessionStats.rounds).toFixed(2)
                    : '—'
                }
              />
              <SummaryCard
                label="Most played"
                value={
                  sessionStats.mostPlayed
                    ? `${sessionStats.mostPlayed.name} (${sessionStats.mostPlayed.played})`
                    : '—'
                }
              />
              <SummaryCard
                label="Least played"
                value={
                  sessionStats.leastPlayed
                    ? `${sessionStats.leastPlayed.name} (${sessionStats.leastPlayed.played})`
                    : '—'
                }
              />
              <SummaryCard
                label="Worst bench streak"
                value={
                  sessionStats.worstBench
                    ? `${sessionStats.worstBench.name} (${sessionStats.worstBench.streak})`
                    : '—'
                }
              />
            </div>

            <div className="table-title">Per-player breakdown</div>
            <div className="table-wrapper">
              <table className="nice-table">
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
                  {perPlayer.map((p) => (
                    <tr key={p.id}>
                      <td>{p.name}</td>
                      <td>{p.skill_level}</td>
                      <td>{p.played}</td>
                      <td>{p.benched}</td>
                      <td>{p.worstBenchStreak}</td>
                      <td>{p.uniqueTeammates.size}</td>
                      <td>{p.uniqueOpponents.size}</td>
                    </tr>
                  ))}
                  {!perPlayer.length && (
                    <tr>
                      <td colSpan={7} className="muted center">
                        No data yet
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {tab === 'diagnostics' && (
          <div className="summary-body">
            <div className="summary-cards">
              <SummaryCard
                label="Avg build time"
                value={
                  diag.buildTimes.length
                    ? (avg(diag.buildTimes)).toFixed(2) + ' ms'
                    : '—'
                }
              />
              <SummaryCard
                label="Avg team imbalance"
                value={
                  diag.teamImbalances.length
                    ? avg(diag.teamImbalances).toFixed(2)
                    : '—'
                }
              />
              <SummaryCard
                label="Avg skill span / match"
                value={
                  diag.skillSpans.length
                    ? avg(diag.skillSpans).toFixed(2)
                    : '—'
                }
              />
              <SummaryCard
                label="Out-of-band groups"
                value={diag.outOfBand || 0}
              />
            </div>
            <div className="diag-table">
              <h4>Courts used per round</h4>
              <p>{diag.courtsUsed.join(', ') || '—'}</p>
              <h4>Build times (ms)</h4>
              <p>{diag.buildTimes.map((n) => n.toFixed(1)).join(', ') || '—'}</p>
              <h4>Imbalance (|avg1-avg2|)</h4>
              <p>{diag.teamImbalances.map((n) => n.toFixed(2)).join(', ') || '—'}</p>
            </div>
          </div>
        )}

        <div className="modal-actions right">
          <button className="btn" onClick={() => exportCSV(sessionStats)}>
            Export CSV
          </button>
          <button className="btn" onClick={() => copySummary(sessionStats, diag)}>
            Copy Summary
          </button>
          <button className="btn btn-primary" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

function SummaryCard({ label, value }) {
  return (
    <div className="summary-card">
      <div className="summary-label">{label}</div>
      <div className="summary-value">{value}</div>
    </div>
  )
}

/* -------------------- data helpers -------------------- */

function makeEmptySessionStats() {
  return {
    rounds: 0,
    playersPresent: 0,
    totalCourtsUsed: 0,
    mostPlayed: null,
    leastPlayed: null,
    worstBench: null,
    perPlayer: [],
  }
}

function makeEmptyDiagStats() {
  return {
    buildTimes: [],
    courtsUsed: [],
    teamImbalances: [],
    skillSpans: [],
    outOfBand: 0,
  }
}

function accumulateSessionStats(prev, matches, benched, roundNumber, allPresent) {
  // build per-player map from prev
  const perMap = new Map((prev.perPlayer || []).map((p) => [p.id, p]))
  // ensure all present players exist in map
  allPresent.forEach((p) => {
    if (!perMap.has(p.id)) {
      perMap.set(p.id, {
        id: p.id,
        name: p.name,
        skill_level: p.skill_level,
        played: 0,
        benched: 0,
        worstBenchStreak: 0,
        currentBenchStreak: 0,
        uniqueTeammates: new Set(),
        uniqueOpponents: new Set(),
      })
    }
  })

  // mark played
  matches.forEach((m) => {
    const t1 = m.team1 || []
    const t2 = m.team2 || []
    const team1Ids = t1.map((p) => p.id)
    const team2Ids = t2.map((p) => p.id)
    const all = [...t1, ...t2]
    all.forEach((p) => {
      const rec = perMap.get(p.id)
      if (!rec) return
      rec.played += 1
      rec.currentBenchStreak = 0
      // teammates
      team1Ids.forEach((tid) => {
        if (tid !== p.id) rec.uniqueTeammates.add(tid)
      })
      team2Ids.forEach((tid) => {
        if (tid !== p.id) rec.uniqueTeammates.add(tid)
      })
      // opponents
      const oppIds = p.id && team1Ids.includes(p.id) ? team2Ids : team1Ids
      oppIds.forEach((oid) => rec.uniqueOpponents.add(oid))
    })
  })

  // mark benched
  benched.forEach((p) => {
    const rec = perMap.get(p.id)
    if (!rec) return
    rec.benched += 1
    rec.currentBenchStreak += 1
    if (rec.currentBenchStreak > rec.worstBenchStreak) {
      rec.worstBenchStreak = rec.currentBenchStreak
    }
  })

  const perList = Array.from(perMap.values())
  // compute most/least played
  const mostPlayed = perList.reduce(
    (acc, p) => (p.played > (acc?.played || 0) ? { name: p.name, played: p.played } : acc),
    null
  )
  const leastPlayed = perList.reduce(
    (acc, p) =>
      acc == null || p.played < acc.played ? { name: p.name, played: p.played } : acc,
    null
  )
  const worstBench = perList.reduce(
    (acc, p) =>
      p.worstBenchStreak > (acc?.streak || 0)
        ? { name: p.name, streak: p.worstBenchStreak }
        : acc,
    null
  )

  return {
    rounds: prev.rounds + 1,
    playersPresent: allPresent.length,
    totalCourtsUsed: prev.totalCourtsUsed + matches.length,
    mostPlayed,
    leastPlayed,
    worstBench,
    perPlayer: perList,
  }
}

function avg(arr) {
  if (!arr || !arr.length) return 0
  return arr.reduce((a, b) => a + b, 0) / arr.length
}

function exportCSV(sessionStats) {
  const rows = [
    ['Name', 'Level', 'Played', 'Benched', 'WorstBenchStreak', 'UniqueTeammates', 'UniqueOpponents'],
  ]
  ;(sessionStats.perPlayer || []).forEach((p) => {
    rows.push([
      p.name,
      p.skill_level,
      p.played,
      p.benched,
      p.worstBenchStreak,
      p.uniqueTeammates.size,
      p.uniqueOpponents.size,
    ])
  })
  const csv = rows.map((r) => r.join(',')).join('\n')
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'session.csv'
  a.click()
  URL.revokeObjectURL(url)
}

function copySummary(sessionStats, diag) {
  const text = [
    `Rounds: ${sessionStats.rounds}`,
    `Players present: ${sessionStats.playersPresent}`,
    `Most played: ${sessionStats.mostPlayed ? sessionStats.mostPlayed.name + ' (' + sessionStats.mostPlayed.played + ')' : '-'}`,
    `Least played: ${sessionStats.leastPlayed ? sessionStats.leastPlayed.name + ' (' + sessionStats.leastPlayed.played + ')' : '-'}`,
    '',
    `Avg build time: ${diag.buildTimes.length ? avg(diag.buildTimes).toFixed(2) + ' ms' : '-'}`,
    `Avg team imbalance: ${diag.teamImbalances.length ? avg(diag.teamImbalances).toFixed(2) : '-'}`,
  ].join('\n')
  navigator.clipboard.writeText(text).catch(() => {})
}

/* -------------------- backend helpers -------------------- */

async function deletePlayer(id, setPlayers) {
  try {
    const res = await fetch('/.netlify/functions/players', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    const data = await res.json()
    if (Array.isArray(data)) setPlayers(data)
  } catch (err) {
    console.error('delete failed', err)
  }
}

async function updatePlayer(player, setPlayers) {
  // simple inline edit prompt – you may replace with nicer modal later
  const name = window.prompt('Name', player.name)
  if (!name) return
  const skill = Number(window.prompt('Skill level (1-10)', player.skill_level))
  const gender = window.prompt('Gender M/F', player.gender || 'M') || 'M'
  try {
    const res = await fetch('/.netlify/functions/players', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: player.id,
        fields: {
          name,
          skill_level: skill,
          gender,
        },
      }),
    })
    const data = await res.json()
    if (Array.isArray(data)) setPlayers(data)
  } catch (err) {
    console.error('update failed', err)
  }
}

export default App
