import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  MATCH_MODES,
  buildMatchesFromPlayers,
  calculateMatchElo,
  displayTier,
  formatTime,
  getMatchMode,
  selectPlayersForRound,
  setMatchMode,
} from './logic';
import './App.css';

/* ================= API ================= */

const PLAYERS_API = '/.netlify/functions/players';
const SESSIONS_API = '/.netlify/functions/sessions';

const APIClient = {
  async listPlayers() {
    const res = await fetch(PLAYERS_API, { method: 'GET' });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = [];
    }
    if (!res.ok) throw new Error(data?.error || data?.message || 'Failed to load players');
    return Array.isArray(data) ? data.map(normalizePlayer) : [];
  },

  async patchPlayers(updates, adminKey = '') {
    const res = await fetch(PLAYERS_API, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...(adminKey ? { 'X-Admin-Key': adminKey } : {}),
      },
      body: JSON.stringify({ updates }),
    });

    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { message: text };
    }

    if (!res.ok) {
      throw new Error(data?.error || data?.message || 'PATCH failed');
    }

    return data;
  },

  async upsertPlayers(players, adminKey = '') {
    const res = await fetch(PLAYERS_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(adminKey ? { 'X-Admin-Key': adminKey } : {}),
      },
      body: JSON.stringify({ players }),
    });

    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { message: text };
    }

    if (!res.ok) {
      throw new Error(data?.error || data?.message || 'UPSERT failed');
    }

    return data;
  },

  async removePlayers(ids, adminKey = '') {
    const res = await fetch(PLAYERS_API, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        ...(adminKey ? { 'X-Admin-Key': adminKey } : {}),
      },
      body: JSON.stringify({ ids }),
    });

    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { message: text };
    }

    if (!res.ok) {
      throw new Error(data?.error || data?.message || 'DELETE failed');
    }

    return data;
  },

  async startSession(players, adminKey = '') {
    const res = await fetch(SESSIONS_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(adminKey ? { 'X-Admin-Key': adminKey } : {}),
      },
      body: JSON.stringify({
        action: 'start_session',
        players,
      }),
    });

    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { message: text };
    }

    if (!res.ok) {
      throw new Error(data?.error || data?.message || 'Failed to start session');
    }

    return data;
  },

  async logRoundResults(payload, adminKey = '') {
    const res = await fetch(SESSIONS_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(adminKey ? { 'X-Admin-Key': adminKey } : {}),
      },
      body: JSON.stringify({
        action: 'log_round_results',
        ...payload,
      }),
    });

    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { message: text };
    }

    if (!res.ok) {
      throw new Error(data?.error || data?.message || 'Failed to log round results');
    }

    return data;
  },

  async endSession(payload, adminKey = '') {
    const res = await fetch(SESSIONS_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(adminKey ? { 'X-Admin-Key': adminKey } : {}),
      },
      body: JSON.stringify({
        action: 'end_session',
        ...payload,
      }),
    });

    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { message: text };
    }

    if (!res.ok) {
      throw new Error(data?.error || data?.message || 'Failed to end session');
    }

    return data;
  },

  async listSessions() {
    const res = await fetch(SESSIONS_API, { method: 'GET' });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = [];
    }

    if (!res.ok) {
      throw new Error(data?.error || data?.message || 'Failed to load sessions');
    }

    return Array.isArray(data) ? data : [];
  },

  async getSessionDetails(sessionId) {
    const res = await fetch(`${SESSIONS_API}?session_id=${encodeURIComponent(sessionId)}`, {
      method: 'GET',
    });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = {};
    }

    if (!res.ok) {
      throw new Error(data?.error || data?.message || 'Failed to load session details');
    }

    return data;
  },
};

/* ================= Local Storage ================= */

const LS = {
  getNum(key, def, min = -Infinity, max = Infinity) {
    try {
      const value = Number(localStorage.getItem(key));
      if (Number.isFinite(value)) return clamp(value, min, max);
    } catch {}
    return def;
  },
  set(key, value) {
    try {
      localStorage.setItem(key, String(value));
    } catch {}
  },
};

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function normalizePlayer(p) {
  const seededSkill = Number(p?.skill_level);
  const inferredElo =
    Number.isFinite(seededSkill) && seededSkill > 0 ? 700 + seededSkill * 100 : 1000;

  const elo = Number(p?.elo_rating);
  const finalElo = Number.isFinite(elo) && elo > 0 ? elo : inferredElo;

  const player = {
    id: p?.id ?? cryptoRandomId(),
    name: String(p?.name || '').trim(),
    gender: p?.gender === 'F' ? 'F' : 'M',
    is_present: !!p?.is_present,
    elo_rating: finalElo,
    skill_level:
      Number.isFinite(seededSkill) && seededSkill > 0
        ? seededSkill
        : displayTier({ elo_rating: finalElo }),
    bench_count: Number(p?.bench_count) || 0,
    last_played_round: Number(p?.last_played_round) || 0,
    wins: Number(p?.wins) || 0,
    losses: Number(p?.losses) || 0,
    matches_played: Number(p?.matches_played) || 0,
    current_streak: Number(p?.current_streak) || 0,
    best_streak: Number(p?.best_streak) || 0,
    best_session_elo_gain: Number(p?.best_session_elo_gain) || 0,
  };

  if (p?.created_at) player.created_at = p.created_at;
  if (p?.updated_at) player.updated_at = p.updated_at;

  return player;
}

function cryptoRandomId() {
  try {
    return crypto.randomUUID();
  } catch {
    return 'p-' + Math.random().toString(36).slice(2);
  }
}

/* ================= Audio ================= */

function useBeep(volumeRef) {
  const ctxRef = useRef(null);

  function ensure() {
    if (!ctxRef.current) {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      ctxRef.current = new Ctor();
    }
    return ctxRef.current;
  }

  function beep(freq = 900, ms = 250) {
    const ctx = ensure();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const volume = clamp(volumeRef.current ?? 0.35, 0, 1);
  
    osc.type = 'sine';
    osc.frequency.value = freq;
  
    osc.connect(gain);
    gain.connect(ctx.destination);
  
    gain.gain.setValueAtTime(volume, ctx.currentTime);
  
    osc.start();
    osc.stop(ctx.currentTime + ms / 1000);
  }
  return { beep };
}

/* ================= App constants ================= */

const TABS = {
  HOME: 'home',
  PLAYERS: 'players',
  SESSION: 'session',
  LEADERBOARD: 'leaderboard',
  HISTORY: 'history',
  SETTINGS: 'settings',
};

const PHASES = {
  IDLE: 'idle',
  PRE_ROUND: 'pre_round',
  MATCH: 'match',
  TRANSITION: 'transition',
};

/* ================= Main App ================= */

export default function App() {
  const [players, setPlayers] = useState([]);
  const [loading, setLoading] = useState(true);

  const [tab, setTab] = useState(TABS.HOME);

  const [adminKey, setAdminKey] = useState(() => sessionStorage.getItem('adminKey') || '');
  const isAdmin = !!adminKey;

  const [matchMode, setMatchModeState] = useState(() => getMatchMode());

  const [matchMinutes, setMatchMinutes] = useState(LS.getNum('flo.match.minutes', 10, 3, 60));
  const [warningSeconds, setWarningSeconds] = useState(LS.getNum('flo.warning.seconds', 30, 5, 120));
  const [transitionSeconds, setTransitionSeconds] = useState(
    LS.getNum('flo.transition.seconds', 60, 10, 180)
  );
  const [preRoundSeconds, setPreRoundSeconds] = useState(
    LS.getNum('flo.preround.seconds', 30, 5, 180)
  );
  const [courtsCount, setCourtsCount] = useState(LS.getNum('flo.courts', 4, 1, 12));
  const [kFactor, setKFactor] = useState(LS.getNum('flo.kfactor', 24, 8, 64));
  const [volume, setVolume] = useState(LS.getNum('flo.volume', 0.35, 0, 1));

  const volumeRef = useRef(volume);
  const { beep } = useBeep(volumeRef);

  const [sessionActive, setSessionActive] = useState(false);
  const [activeSessionId, setActiveSessionId] = useState(null);

  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState(PHASES.IDLE);
  const [phaseRemaining, setPhaseRemaining] = useState(0);
  const [roundNumber, setRoundNumber] = useState(0);

  const [matches, setMatches] = useState([]);
  const [benched, setBenched] = useState([]);
  const [winnerSelections, setWinnerSelections] = useState({});
  const [sessionHistory, setSessionHistory] = useState([]);
  const [sessionSummary, setSessionSummary] = useState(null);

  const [historySessions, setHistorySessions] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState('');
  const [historySelectedId, setHistorySelectedId] = useState(null);
  const [historyDetails, setHistoryDetails] = useState(null);
  const [historyDetailsLoading, setHistoryDetailsLoading] = useState(false);
  const [historyDetailsError, setHistoryDetailsError] = useState('');

  const [newPlayerName, setNewPlayerName] = useState('');
  const [newPlayerGender, setNewPlayerGender] = useState('M');
  const [newPlayerElo, setNewPlayerElo] = useState(1000);

  const teammateHistory = useRef(new Map());
  const lastRoundBenched = useRef(new Set());
  const sessionEloGainRef = useRef(new Map());

  const playersRef = useRef(players);
  const matchesRef = useRef(matches);
  const winnerSelectionsRef = useRef(winnerSelections);
  const phaseRef = useRef(phase);
  const roundNumberRef = useRef(roundNumber);

  useEffect(() => {
    playersRef.current = players;
  }, [players]);

  useEffect(() => {
    matchesRef.current = matches;
  }, [matches]);

  useEffect(() => {
    winnerSelectionsRef.current = winnerSelections;
  }, [winnerSelections]);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  useEffect(() => {
    roundNumberRef.current = roundNumber;
  }, [roundNumber]);

  useEffect(() => {
    volumeRef.current = volume;
  }, [volume]);

  useEffect(() => {
    (async () => {
      try {
        const list = await APIClient.listPlayers();
        setPlayers(list);
      } catch (err) {
        console.error(err);
        alert('Could not load players.');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (tab !== TABS.HISTORY) return;
    loadHistorySessions();
  }, [tab]);

  const presentPlayers = useMemo(
    () => players.filter((p) => p.is_present).sort((a, b) => a.name.localeCompare(b.name)),
    [players]
  );

  const notPresentPlayers = useMemo(
    () => players.filter((p) => !p.is_present).sort((a, b) => a.name.localeCompare(b.name)),
    [players]
  );

  const leaderboard = useMemo(() => {
    return players
      .slice()
      .sort((a, b) => {
        if (b.elo_rating !== a.elo_rating) return b.elo_rating - a.elo_rating;
        if (b.wins !== a.wins) return b.wins - a.wins;
        return a.name.localeCompare(b.name);
      });
  }, [players]);

  const activePhaseLabel = useMemo(() => {
    if (phase === PHASES.PRE_ROUND) return 'Pre-Game';
    if (phase === PHASES.MATCH) return 'Game';
    if (phase === PHASES.TRANSITION) return 'Transition Period';
    return 'Idle';
  }, [phase]);

  const warningActive =
    phase === PHASES.MATCH && running && phaseRemaining <= warningSeconds && phaseRemaining > 0;

  /* ================= Timer engine ================= */

  useEffect(() => {
    if (!running) return;

    const id = window.setInterval(() => {
      setPhaseRemaining((prev) => Math.max(0, prev - 1));
    }, 1000);

    return () => window.clearInterval(id);
  }, [running]);

  useEffect(() => {
    if (!running) return;

    if (phase === PHASES.MATCH && phaseRemaining === warningSeconds) {
      beep(1000, 5000);
    }

    if (phaseRemaining !== 0) return;

    (async () => {
      if (phaseRef.current === PHASES.PRE_ROUND) {
        beep(1200, 6000);
        setPhase(PHASES.MATCH);
        setPhaseRemaining(matchMinutes * 60);
        return;
      }

      if (phaseRef.current === PHASES.MATCH) {
        beep(900, 5000);
        setPhase(PHASES.TRANSITION);
        setPhaseRemaining(transitionSeconds);
        return;
      }

      if (phaseRef.current === PHASES.TRANSITION) {
        beep(600, 3500);
        await resolveCurrentRoundAndAdvance();
      }
    })();
  }, [phaseRemaining, phase, running, matchMinutes, transitionSeconds, warningSeconds]);

  /* ================= Session History loaders ================= */

  async function loadHistorySessions() {
    setHistoryLoading(true);
    setHistoryError('');
    try {
      const sessions = await APIClient.listSessions();
      setHistorySessions(sessions);
    } catch (err) {
      console.error(err);
      setHistoryError(err.message || 'Failed to load sessions.');
    } finally {
      setHistoryLoading(false);
    }
  }

  async function openSessionHistory(sessionId) {
    setHistorySelectedId(sessionId);
    setHistoryDetails(null);
    setHistoryDetailsError('');
    setHistoryDetailsLoading(true);

    try {
      const details = await APIClient.getSessionDetails(sessionId);
      setHistoryDetails(details);
    } catch (err) {
      console.error(err);
      setHistoryDetailsError(err.message || 'Failed to load session details.');
    } finally {
      setHistoryDetailsLoading(false);
    }
  }

  /* ================= Session building ================= */

  async function buildRoundAndEnterPreRound() {
    const currentPlayers = playersRef.current.filter((p) => p.is_present);

    if (currentPlayers.length < 4) {
      alert('At least 4 players must be present.');
      stopSessionClock();
      return;
    }

    const nextRound = roundNumberRef.current + 1;
    const { playing, benched: nextBenched } = selectPlayersForRound(
      currentPlayers,
      nextRound,
      lastRoundBenched.current,
      courtsCount
    );

    if (playing.length < 4) {
      alert('Not enough players available to build a valid round.');
      stopSessionClock();
      return;
    }

    const builtMatches = buildMatchesFromPlayers(playing, teammateHistory.current, courtsCount);

    if (!builtMatches.length) {
      alert('Could not build matches.');
      stopSessionClock();
      return;
    }

    const playingIds = new Set(playing.map((p) => p.id));
    const benchedIds = new Set(nextBenched.map((p) => p.id));

    setPlayers((prev) =>
      prev.map((p) => {
        if (playingIds.has(p.id)) {
          return {
            ...p,
            bench_count: Number(p.bench_count || 0),
            last_played_round: nextRound,
          };
        }
        if (benchedIds.has(p.id)) {
          return {
            ...p,
            bench_count: Number(p.bench_count || 0) + 1,
          };
        }
        return p;
      })
    );

    setRoundNumber(nextRound);
    roundNumberRef.current = nextRound;

    setMatches(builtMatches);
    setBenched(nextBenched);
    setWinnerSelections({});
    lastRoundBenched.current = new Set(nextBenched.map((b) => b.id));

    setSessionHistory((prev) => [
      ...prev,
      {
        type: 'round_built',
        round: nextRound,
        created_at: new Date().toISOString(),
        matches: builtMatches.map((m) => ({
          court: m.court,
          team1: m.team1.map((p) => p.name),
          team2: m.team2.map((p) => p.name),
          avg1: Math.round(m.avg1),
          avg2: Math.round(m.avg2),
        })),
      },
    ]);

    setPhase(PHASES.PRE_ROUND);
    setPhaseRemaining(preRoundSeconds);
    setRunning(true);
  }

  async function resolveCurrentRoundAndAdvance() {
    const currentMatches = matchesRef.current;
    const selectedWinners = winnerSelectionsRef.current;

    if (!currentMatches.length) {
      stopSessionClock();
      return;
    }

    const playerMap = new Map(playersRef.current.map((p) => [p.id, { ...p }]));
    const patchUpdates = [];
    const roundLog = [];
    const dbRoundResults = [];

    for (const match of currentMatches) {
      const winner = Number(selectedWinners[match.court] || 0);

      if (winner !== 1 && winner !== 2) {
        roundLog.push({
          round: roundNumberRef.current,
          court: match.court,
          winner_team: 0,
          status: 'no_result',
          team1: match.team1.map((p) => p.name),
          team2: match.team2.map((p) => p.name),
          avg1: Math.round(match.avg1),
          avg2: Math.round(match.avg2),
        });

        dbRoundResults.push({
          court_number: match.court,
          status: 'no_result',
          winner_team: null,
          team1_avg_elo: Math.round(match.avg1),
          team2_avg_elo: Math.round(match.avg2),
          players: [
            ...match.team1.map((p) => ({
              player_id: p.id,
              team_number: 1,
              elo_before: p.elo_rating,
              elo_after: null,
              elo_delta: 0,
              result: null,
            })),
            ...match.team2.map((p) => ({
              player_id: p.id,
              team_number: 2,
              elo_before: p.elo_rating,
              elo_after: null,
              elo_delta: 0,
              result: null,
            })),
          ],
        });

        continue;
      }

      const eloResult = calculateMatchElo(match, winner, kFactor);

      for (const update of eloResult.updates) {
        const player = playerMap.get(update.id);
        if (!player) continue;

        const newElo = update.new_elo;
        const delta = update.elo_delta;
        const didWin = update.result === 'win';

        const previousStreak = Number(player.current_streak || 0);
        let nextStreak = 0;

        if (didWin) {
          nextStreak = previousStreak >= 0 ? previousStreak + 1 : 1;
        } else {
          nextStreak = previousStreak <= 0 ? previousStreak - 1 : -1;
        }

        const bestStreak = Math.max(Number(player.best_streak || 0), Math.abs(nextStreak));

        player.elo_rating = newElo;
        player.wins = Number(player.wins || 0) + (didWin ? 1 : 0);
        player.losses = Number(player.losses || 0) + (didWin ? 0 : 1);
        player.matches_played = Number(player.matches_played || 0) + 1;
        player.current_streak = nextStreak;
        player.best_streak = bestStreak;

        const gainMap = sessionEloGainRef.current;
        gainMap.set(player.id, Number(gainMap.get(player.id) || 0) + delta);

        patchUpdates.push({
          id: player.id,
          elo_rating: player.elo_rating,
          wins: player.wins,
          losses: player.losses,
          matches_played: player.matches_played,
          current_streak: player.current_streak,
          best_streak: player.best_streak,
        });
      }

      roundLog.push({
        round: roundNumberRef.current,
        court: match.court,
        winner_team: winner,
        status: 'completed',
        team1: match.team1.map((p) => p.name),
        team2: match.team2.map((p) => p.name),
        avg1: Math.round(match.avg1),
        avg2: Math.round(match.avg2),
        delta_team1: eloResult.delta1,
        delta_team2: eloResult.delta2,
      });

      dbRoundResults.push({
        court_number: match.court,
        status: 'completed',
        winner_team: winner,
        team1_avg_elo: Math.round(match.avg1),
        team2_avg_elo: Math.round(match.avg2),
        players: [
          ...match.team1.map((p) => {
            const updated = eloResult.updates.find((u) => u.id === p.id);
            return {
              player_id: p.id,
              team_number: 1,
              elo_before: p.elo_rating,
              elo_after: updated?.new_elo ?? p.elo_rating,
              elo_delta: updated?.elo_delta ?? 0,
              result: updated?.result ?? null,
            };
          }),
          ...match.team2.map((p) => {
            const updated = eloResult.updates.find((u) => u.id === p.id);
            return {
              player_id: p.id,
              team_number: 2,
              elo_before: p.elo_rating,
              elo_after: updated?.new_elo ?? p.elo_rating,
              elo_delta: updated?.elo_delta ?? 0,
              result: updated?.result ?? null,
            };
          }),
        ],
      });
    }

    const nextPlayers = Array.from(playerMap.values()).map(normalizePlayer);
    setPlayers(nextPlayers);

    setSessionHistory((prev) => [
      ...prev,
      {
        type: 'round_resolved',
        round: roundNumberRef.current,
        created_at: new Date().toISOString(),
        results: roundLog,
      },
    ]);

    if (patchUpdates.length) {
      try {
        await APIClient.patchPlayers(patchUpdates, adminKey);
      } catch (err) {
        console.error(err);
        alert(`Failed to persist player ELO/stat updates: ${err.message}`);
      }
    }

    if (activeSessionId && dbRoundResults.length) {
      try {
        await APIClient.logRoundResults(
          {
            session_id: activeSessionId,
            round_number: roundNumberRef.current,
            results: dbRoundResults,
          },
          adminKey
        );
      } catch (err) {
        console.error(err);
        alert(`Failed to save round history: ${err.message}`);
      }
    }

    const refreshedPresent = nextPlayers.filter((p) => p.is_present);
    if (refreshedPresent.length < 4) {
      stopSessionClock();
      return;
    }

    await buildRoundAndEnterPreRound();
  }

  function stopSessionClock() {
    setRunning(false);
    setPhase(PHASES.IDLE);
    setPhaseRemaining(0);
  }

  /* ================= Actions ================= */

  async function startSession() {
    const currentPresent = playersRef.current.filter((p) => p.is_present);
    if (currentPresent.length < 4) {
      alert('At least 4 players must be present before starting the session.');
      return;
    }

    if (!activeSessionId) {
      try {
        const data = await APIClient.startSession(currentPresent, adminKey);
        setActiveSessionId(data?.session?.id || null);
      } catch (err) {
        console.error(err);
        alert(`Failed to create session: ${err.message}`);
        return;
      }
    }

    setSessionActive(true);
    setSessionSummary(null);

    if (roundNumberRef.current === 0 || matchesRef.current.length === 0) {
      await buildRoundAndEnterPreRound();
    } else {
      setRunning(true);
    }
  }

  function pauseSession() {
    setRunning(false);
  }

  function resumeSession() {
    if (!sessionActive) {
      startSession();
      return;
    }
    if (phase === PHASES.IDLE && matches.length) {
      setPhase(PHASES.PRE_ROUND);
      setPhaseRemaining(preRoundSeconds);
    }
    setRunning(true);
  }

  async function nextRoundNow() {
    if (!sessionActive) {
      alert('Start the session first.');
      return;
    }
    setRunning(false);
    await resolveCurrentRoundAndAdvance();
  }

  async function endSession() {
    const currentPlayers = playersRef.current;

    const summary = buildSessionSummary(
      currentPlayers,
      sessionEloGainRef.current,
      sessionHistory,
      roundNumberRef.current
    );
    setSessionSummary(summary);

    const bestSessionUpdates = currentPlayers.map((player) => {
      const gain = Number(sessionEloGainRef.current.get(player.id) || 0);
      return {
        id: player.id,
        is_present: false,
        bench_count: 0,
        last_played_round: 0,
        best_session_elo_gain: Math.max(Number(player.best_session_elo_gain || 0), gain),
      };
    });

    const playerSummaries = currentPlayers
      .filter((p) => p.is_present)
      .map((player) => ({
        player_id: player.id,
        ending_elo: player.elo_rating,
        elo_gain: Number(sessionEloGainRef.current.get(player.id) || 0),
        wins: Number(player.wins || 0),
        losses: Number(player.losses || 0),
        matches_played: Number(player.matches_played || 0),
        benched_count: Number(player.bench_count || 0),
      }));

    if (activeSessionId) {
      try {
        await APIClient.endSession(
          {
            session_id: activeSessionId,
            rounds_played: roundNumberRef.current,
            player_summaries: playerSummaries,
          },
          adminKey
        );
      } catch (err) {
        console.error(err);
        alert(`Failed to close session history: ${err.message}`);
      }
    }

    setPlayers((prev) =>
      prev.map((p) => ({
        ...p,
        is_present: false,
        bench_count: 0,
        last_played_round: 0,
        best_session_elo_gain: Math.max(
          Number(p.best_session_elo_gain || 0),
          Number(sessionEloGainRef.current.get(p.id) || 0)
        ),
      }))
    );

    try {
      await APIClient.patchPlayers(bestSessionUpdates, adminKey);
    } catch (err) {
      console.error(err);
      alert(`Failed to save end-of-session player updates: ${err.message}`);
    }

    setSessionActive(false);
    setActiveSessionId(null);
    setRunning(false);
    setPhase(PHASES.IDLE);
    setPhaseRemaining(0);
    setRoundNumber(0);
    roundNumberRef.current = 0;
    setMatches([]);
    setBenched([]);
    setWinnerSelections({});
    teammateHistory.current = new Map();
    lastRoundBenched.current = new Set();
    sessionEloGainRef.current = new Map();
    setSessionHistory([]);
    setTab(TABS.HOME);
  }

  async function togglePresent(player) {
    const nextValue = !player.is_present;

    setPlayers((prev) =>
      prev.map((p) => (p.id === player.id ? { ...p, is_present: nextValue } : p))
    );

    try {
      await APIClient.patchPlayers([{ id: player.id, is_present: nextValue }], adminKey);
    } catch (err) {
      console.error(err);
      alert(`Failed to save presence change: ${err.message}`);
    }
  }

  function setWinner(court, team) {
    if (phase !== PHASES.TRANSITION) return;
    setWinnerSelections((prev) => ({
      ...prev,
      [court]: prev[court] === team ? 0 : team,
    }));
  }

  function clearWinner(court) {
    if (phase !== PHASES.TRANSITION) return;
    setWinnerSelections((prev) => ({
      ...prev,
      [court]: 0,
    }));
  }

  async function addPlayer() {
    if (!isAdmin) {
      alert('Admin mode required.');
      return;
    }

    const name = newPlayerName.trim();
    if (!name) return;

    const player = normalizePlayer({
      id: cryptoRandomId(),
      name,
      gender: newPlayerGender,
      elo_rating: Number(newPlayerElo) || 1000,
      is_present: false,
      bench_count: 0,
      last_played_round: 0,
      wins: 0,
      losses: 0,
      matches_played: 0,
      current_streak: 0,
      best_streak: 0,
      best_session_elo_gain: 0,
    });

    setPlayers((prev) => [...prev, player].sort((a, b) => a.name.localeCompare(b.name)));
    setNewPlayerName('');
    setNewPlayerGender('M');
    setNewPlayerElo(1000);

    try {
      await APIClient.upsertPlayers([player], adminKey);
    } catch (err) {
      console.error(err);
      alert(`Failed to add player: ${err.message}`);
    }
  }

  function updatePlayerLocal(id, field, value) {
    setPlayers((prev) =>
      prev.map((p) => {
        if (p.id !== id) return p;
        const next = { ...p, [field]: value };
        if (field === 'elo_rating') {
          next.skill_level = displayTier({ elo_rating: Number(value) || 1000 });
        }
        return next;
      })
    );
  }

  async function saveAllPlayers() {
    if (!isAdmin) {
      alert('Admin mode required.');
      return;
    }

    try {
      await APIClient.upsertPlayers(players.map(normalizePlayer), adminKey);
      alert('Players saved.');
    } catch (err) {
      console.error(err);
      alert(`Failed to save players: ${err.message}`);
    }
  }

  async function deletePlayer(id) {
    if (!isAdmin) {
      alert('Admin mode required.');
      return;
    }

    if (!window.confirm('Delete this player?')) return;

    setPlayers((prev) => prev.filter((p) => p.id !== id));

    try {
      await APIClient.removePlayers([id], adminKey);
    } catch (err) {
      console.error(err);
      alert(`Failed to delete player: ${err.message}`);
    }
  }

  function adminLogin() {
    const key = prompt('Enter admin key');
    if (!key) return;
    sessionStorage.setItem('adminKey', key);
    setAdminKey(key);
    alert('Admin mode enabled.');
  }

  function adminLogout() {
    sessionStorage.removeItem('adminKey');
    setAdminKey('');
    alert('Admin mode disabled.');
  }

  function saveSettings() {
    LS.set('flo.match.minutes', matchMinutes);
    LS.set('flo.warning.seconds', warningSeconds);
    LS.set('flo.transition.seconds', transitionSeconds);
    LS.set('flo.preround.seconds', preRoundSeconds);
    LS.set('flo.courts', courtsCount);
    LS.set('flo.kfactor', kFactor);
    LS.set('flo.volume', volume);
    LS.set('match_mode', matchMode);
    setMatchMode(matchMode);
    alert('Settings saved.');
  }

  if (loading) {
    return (
      <div className="page centered">
        <div className="muted">Loading players…</div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      <Navigation
        tab={tab}
        setTab={setTab}
        isAdmin={isAdmin}
        onAdminLogin={adminLogin}
        onAdminLogout={adminLogout}
      />

      {tab === TABS.HOME && (
        <HomeTab
          sessionSummary={sessionSummary}
          setTab={setTab}
          activeSessionId={activeSessionId}
        />
      )}

      {tab === TABS.PLAYERS && (
        <PlayerManagementTab
          players={players}
          newPlayerName={newPlayerName}
          setNewPlayerName={setNewPlayerName}
          newPlayerGender={newPlayerGender}
          setNewPlayerGender={setNewPlayerGender}
          newPlayerElo={newPlayerElo}
          setNewPlayerElo={setNewPlayerElo}
          addPlayer={addPlayer}
          saveAllPlayers={saveAllPlayers}
          updatePlayerLocal={updatePlayerLocal}
          deletePlayer={deletePlayer}
          togglePresent={togglePresent}
        />
      )}

      {tab === TABS.SESSION && (
        <SessionTab
          isAdmin={isAdmin}
          sessionActive={sessionActive}
          running={running}
          phase={phase}
          phaseRemaining={phaseRemaining}
          roundNumber={roundNumber}
          activePhaseLabel={activePhaseLabel}
          warningActive={warningActive}
          preRoundSeconds={preRoundSeconds}
          matchMinutes={matchMinutes}
          warningSeconds={warningSeconds}
          transitionSeconds={transitionSeconds}
          matchMode={matchMode}
          matches={matches}
          winnerSelections={winnerSelections}
          benched={benched}
          presentPlayers={presentPlayers}
          notPresentPlayers={notPresentPlayers}
          onStartSession={startSession}
          onPauseSession={pauseSession}
          onResumeSession={resumeSession}
          onNextRoundNow={nextRoundNow}
          onEndSession={endSession}
          onSetWinner={setWinner}
          onClearWinner={clearWinner}
          onTogglePresent={togglePresent}
        />
      )}

      {tab === TABS.LEADERBOARD && <LeaderboardTab leaderboard={leaderboard} />}

      {tab === TABS.HISTORY && (
        <SessionHistoryTab
          sessions={historySessions}
          loading={historyLoading}
          error={historyError}
          selectedId={historySelectedId}
          details={historyDetails}
          detailsLoading={historyDetailsLoading}
          detailsError={historyDetailsError}
          onRefresh={loadHistorySessions}
          onOpenSession={openSessionHistory}
        />
      )}

      {tab === TABS.SETTINGS && (
        <SettingsTab
          matchMinutes={matchMinutes}
          setMatchMinutes={setMatchMinutes}
          warningSeconds={warningSeconds}
          setWarningSeconds={setWarningSeconds}
          transitionSeconds={transitionSeconds}
          setTransitionSeconds={setTransitionSeconds}
          preRoundSeconds={preRoundSeconds}
          setPreRoundSeconds={setPreRoundSeconds}
          courtsCount={courtsCount}
          setCourtsCount={setCourtsCount}
          kFactor={kFactor}
          setKFactor={setKFactor}
          matchMode={matchMode}
          setMatchModeState={setMatchModeState}
          volume={volume}
          setVolume={setVolume}
          saveSettings={saveSettings}
        />
      )}
    </div>
  );
}

/* ================= Extracted Components ================= */

function Navigation({ tab, setTab, isAdmin, onAdminLogin, onAdminLogout }) {
  return (
    <div className="nav glass">
      <button className={`nav-btn ${tab === TABS.HOME ? 'active' : ''}`} onClick={() => setTab(TABS.HOME)}>
        Home
      </button>
      <button className={`nav-btn ${tab === TABS.PLAYERS ? 'active' : ''}`} onClick={() => setTab(TABS.PLAYERS)}>
        Player Management
      </button>
      <button className={`nav-btn ${tab === TABS.SESSION ? 'active' : ''}`} onClick={() => setTab(TABS.SESSION)}>
        Session
      </button>
      <button
        className={`nav-btn ${tab === TABS.LEADERBOARD ? 'active' : ''}`}
        onClick={() => setTab(TABS.LEADERBOARD)}
      >
        Leaderboard
      </button>
      <button
        className={`nav-btn ${tab === TABS.HISTORY ? 'active' : ''}`}
        onClick={() => setTab(TABS.HISTORY)}
      >
        Session History
      </button>
      <button
        className={`nav-btn ${tab === TABS.SETTINGS ? 'active' : ''}`}
        onClick={() => setTab(TABS.SETTINGS)}
      >
        Settings
      </button>

      <div className="nav-spacer" />

      {isAdmin ? (
        <button className="btn" onClick={onAdminLogout}>
          Admin On
        </button>
      ) : (
        <button className="btn" onClick={onAdminLogin}>
          Admin
        </button>
      )}
    </div>
  );
}

function HomeTab({ sessionSummary, setTab, activeSessionId }) {
  return (
    <div className="page">
      <div className="hero glass">
        <h1>The FLOminton System</h1>
        <p className="muted">
          Badminton matchmaking with fairness-based benching, live court assignment,
          winner selection, ELO updates, and full session history.
        </p>

        <div className="hero-actions">
          <button className="btn primary" onClick={() => setTab(TABS.SESSION)}>
            Go to Session
          </button>
          <button className="btn" onClick={() => setTab(TABS.PLAYERS)}>
            Player Management
          </button>
          <button className="btn" onClick={() => setTab(TABS.LEADERBOARD)}>
            Leaderboard
          </button>
          <button className="btn" onClick={() => setTab(TABS.HISTORY)}>
            Session History
          </button>
          <button className="btn" onClick={() => setTab(TABS.SETTINGS)}>
            Settings
          </button>
        </div>

        <div className="mt-12 muted">
          Active Session ID: <b>{activeSessionId || 'None'}</b>
        </div>
      </div>

      {sessionSummary && (
        <div className="panel glass">
          <div className="panel-head">
            <h3>Last Session Summary</h3>
          </div>

          <div className="summary-grid">
            <div className="summary-card">
              <div className="summary-label">Rounds Played</div>
              <div className="summary-value">{sessionSummary.rounds}</div>
            </div>
            <div className="summary-card">
              <div className="summary-label">Matches Resolved</div>
              <div className="summary-value">{sessionSummary.completedMatches}</div>
            </div>
            <div className="summary-card">
              <div className="summary-label">No Result Matches</div>
              <div className="summary-value">{sessionSummary.noResultMatches}</div>
            </div>
            <div className="summary-card">
              <div className="summary-label">Top Session Gain</div>
              <div className="summary-value">
                {sessionSummary.topGainName
                  ? `${sessionSummary.topGainName} (${formatSigned(sessionSummary.topGain)})`
                  : '—'}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PlayerManagementTab({
  players,
  newPlayerName,
  setNewPlayerName,
  newPlayerGender,
  setNewPlayerGender,
  newPlayerElo,
  setNewPlayerElo,
  addPlayer,
  saveAllPlayers,
  updatePlayerLocal,
  deletePlayer,
  togglePresent,
}) {
  return (
    <div className="page">
      <div className="panel glass">
        <div className="panel-head">
          <h3>Player Management</h3>
          <div className="muted">{players.length} players</div>
        </div>

        <div className="admin-add-row">
          <input
            className="input"
            placeholder="Player name"
            value={newPlayerName}
            onChange={(e) => setNewPlayerName(e.target.value)}
          />
          <select
            className="input"
            value={newPlayerGender}
            onChange={(e) => setNewPlayerGender(e.target.value)}
          >
            <option value="M">M</option>
            <option value="F">F</option>
          </select>
          <input
            className="input"
            type="number"
            min="600"
            max="2000"
            step="1"
            value={newPlayerElo}
            onChange={(e) => setNewPlayerElo(Number(e.target.value))}
          />
          <button className="btn" onClick={addPlayer}>
            Add Player
          </button>
          <button className="btn primary" onClick={saveAllPlayers}>
            Save All
          </button>
        </div>

        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Gender</th>
                <th>ELO</th>
                <th>Tier</th>
                <th>Wins</th>
                <th>Losses</th>
                <th>Matches</th>
                <th>Current Streak</th>
                <th>Best Session</th>
                <th>Present</th>
                <th>Delete</th>
              </tr>
            </thead>
            <tbody>
              {players
                .slice()
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((p) => (
                  <tr key={p.id}>
                    <td>
                      <input
                        className="input"
                        value={p.name}
                        onChange={(e) => updatePlayerLocal(p.id, 'name', e.target.value)}
                      />
                    </td>
                    <td>
                      <select
                        className="input"
                        value={p.gender}
                        onChange={(e) => updatePlayerLocal(p.id, 'gender', e.target.value)}
                      >
                        <option value="M">M</option>
                        <option value="F">F</option>
                      </select>
                    </td>
                    <td>
                      <input
                        className="input"
                        type="number"
                        min="600"
                        max="2200"
                        value={p.elo_rating}
                        onChange={(e) => updatePlayerLocal(p.id, 'elo_rating', Number(e.target.value))}
                      />
                    </td>
                    <td className="center">{displayTier(p)}</td>
                    <td className="center">{p.wins}</td>
                    <td className="center">{p.losses}</td>
                    <td className="center">{p.matches_played}</td>
                    <td className="center">{formatSigned(p.current_streak)}</td>
                    <td className="center">{formatSigned(p.best_session_elo_gain)}</td>
                    <td className="center">
                      <input type="checkbox" checked={p.is_present} onChange={() => togglePresent(p)} />
                    </td>
                    <td className="center">
                      <button className="btn danger" onClick={() => deletePlayer(p.id)}>
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function SessionTab({
  isAdmin,
  sessionActive,
  running,
  phase,
  phaseRemaining,
  roundNumber,
  activePhaseLabel,
  warningActive,
  preRoundSeconds,
  matchMinutes,
  warningSeconds,
  transitionSeconds,
  matchMode,
  matches,
  winnerSelections,
  benched,
  presentPlayers,
  notPresentPlayers,
  onStartSession,
  onPauseSession,
  onResumeSession,
  onNextRoundNow,
  onEndSession,
  onSetWinner,
  onClearWinner,
  onTogglePresent,
}) {
  return (
    <div className="page">
      <div className="toolbar glass">
        <div className="toolbar-left">
          <button className="btn primary" onClick={onStartSession}>
            Start Session
          </button>
          <button className="btn" onClick={onPauseSession} disabled={!running}>
            Pause
          </button>
          <button className="btn" onClick={onResumeSession}>
            Play / Resume
          </button>
          <button className="btn" onClick={onNextRoundNow} disabled={!sessionActive}>
            Force Next Round
          </button>
          <button className="btn danger" onClick={onEndSession} disabled={!sessionActive && roundNumber === 0}>
            End Session
          </button>
        </div>

        <div className="toolbar-right stack-right">
          <div className={`phase-chip ${phase}`}>
            {activePhaseLabel}
          </div>
          <div className={`time ${warningActive ? 'warn' : ''}`}>
            Round {roundNumber || 0} • {formatTime(phaseRemaining)}
          </div>
        </div>
      </div>

      <div className="session-status-grid">
        <div className="summary-card">
          <div className="summary-label">Phase</div>
          <div className="summary-value small">{activePhaseLabel}</div>
        </div>
        <div className="summary-card">
          <div className="summary-label">Present</div>
          <div className="summary-value">{presentPlayers.length}</div>
        </div>
        <div className="summary-card">
          <div className="summary-label">Benched</div>
          <div className="summary-value">{benched.length}</div>
        </div>
        <div className="summary-card">
          <div className="summary-label">Mode</div>
          <div className="summary-value small">
            {matchMode === MATCH_MODES.BAND ? 'Band' : 'Window'}
          </div>
        </div>
      </div>

      <div className="panel glass">
        <div className="panel-head">
          <h3>Matches</h3>
          <div className="muted">
            Pre-Game: {preRoundSeconds}s • Game: {matchMinutes}m • Warning Threshold: {warningSeconds}s • Transition Period: {transitionSeconds}s
          </div>
        </div>

        {matches.length === 0 ? (
          <div className="muted p-12">No matches built yet.</div>
        ) : (
          <div className="courts-grid">
            {matches.map((match) => (
              <CourtCard
                key={match.court}
                match={match}
                phase={phase}
                selectedWinner={Number(winnerSelections[match.court] || 0)}
                onPickWinner={onSetWinner}
                onClearWinner={onClearWinner}
              />
            ))}
          </div>
        )}
      </div>

      <div className="panel glass">
        <div className="panel-head">
          <h3>Benched Players</h3>
        </div>

        {benched.length === 0 ? (
          <div className="muted p-8">No one benched this round.</div>
        ) : (
          <div className="bench-row">
            {benched.map((p) => (
              <div className="tag" key={p.id}>
                <span className={`pill sm ${p.gender === 'F' ? 'female' : 'male'}`}>{p.gender}</span>
                {p.name} <span className="muted">(ELO {p.elo_rating})</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="lists-grid">
        <div className="list-col">
          <div className="list-head">
            All Players <span className="badge">{notPresentPlayers.length}</span>
          </div>
          <div className="list-box glass">
            {notPresentPlayers.map((p) => (
              <PlayerRow
                key={p.id}
                player={p}
                onClick={() => onTogglePresent(p)}
              />
            ))}
          </div>
        </div>

        <div className="list-col">
          <div className="list-head">
            Present <span className="badge">{presentPlayers.length}</span>
          </div>
          <div className="list-box glass">
            {presentPlayers.map((p) => (
              <PlayerRow
                key={p.id}
                player={p}
                onClick={() => onTogglePresent(p)}
                present
                showBenchCount={isAdmin}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function LeaderboardTab({ leaderboard }) {
  return (
    <div className="page">
      <div className="panel glass">
        <div className="panel-head">
          <h3>Leaderboard</h3>
          <div className="muted">Lifetime stats</div>
        </div>

        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Rank</th>
                <th>Name</th>
                <th>Gender</th>
                <th>ELO</th>
                <th>Tier</th>
                <th>Wins</th>
                <th>Losses</th>
                <th>Matches</th>
                <th>Win %</th>
                <th>Current Streak</th>
                <th>Best Session</th>
              </tr>
            </thead>
            <tbody>
              {leaderboard.map((p, index) => {
                const matchesPlayed = Number(p.matches_played || 0);
                const winPct = matchesPlayed
                  ? ((Number(p.wins || 0) / matchesPlayed) * 100).toFixed(1)
                  : '0.0';

                return (
                  <tr key={p.id}>
                    <td className="center">{index + 1}</td>
                    <td>{p.name}</td>
                    <td className="center">{p.gender}</td>
                    <td className="center"><b>{p.elo_rating}</b></td>
                    <td className="center">{displayTier(p)}</td>
                    <td className="center">{p.wins}</td>
                    <td className="center">{p.losses}</td>
                    <td className="center">{p.matches_played}</td>
                    <td className="center">{winPct}%</td>
                    <td className="center">{formatSigned(p.current_streak)}</td>
                    <td className="center">{formatSigned(p.best_session_elo_gain)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function SessionHistoryTab({
  sessions,
  loading,
  error,
  selectedId,
  details,
  detailsLoading,
  detailsError,
  onRefresh,
  onOpenSession,
}) {
  const groupedMatches = useMemo(() => {
    if (!details?.matches?.length) return [];
    const groups = new Map();

    details.matches.forEach((match) => {
      const round = Number(match.round_number || 0);
      if (!groups.has(round)) groups.set(round, []);
      groups.get(round).push(match);
    });

    return Array.from(groups.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([round, matches]) => ({
        round,
        matches: matches.slice().sort((a, b) => Number(a.court_number || 0) - Number(b.court_number || 0)),
      }));
  }, [details]);

  return (
    <div className="page">
      <div className="history-layout">
        <div className="panel glass">
          <div className="panel-head">
            <h3>Saved Sessions</h3>
            <button className="btn" onClick={onRefresh}>
              Refresh
            </button>
          </div>

          {loading ? (
            <div className="muted p-12">Loading sessions…</div>
          ) : error ? (
            <div className="error-box">{error}</div>
          ) : sessions.length === 0 ? (
            <div className="muted p-12">No saved sessions found.</div>
          ) : (
            <div className="history-session-list">
              {sessions.map((session) => (
                <button
                  key={session.id}
                  className={`history-session-item ${selectedId === session.id ? 'active' : ''}`}
                  onClick={() => onOpenSession(session.id)}
                >
                  <div className="history-session-title">
                    {formatDateTime(session.started_at)}
                  </div>
                  <div className="history-session-meta">
                    <span>Status: {session.status || '—'}</span>
                    <span>Rounds: {session.rounds_played ?? 0}</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="panel glass">
          <div className="panel-head">
            <h3>Session Details</h3>
          </div>

          {!selectedId ? (
            <div className="muted p-12">Select a session to view full details.</div>
          ) : detailsLoading ? (
            <div className="muted p-12">Loading session details…</div>
          ) : detailsError ? (
            <div className="error-box">{detailsError}</div>
          ) : !details?.session ? (
            <div className="muted p-12">No details found for this session.</div>
          ) : (
            <>
              <div className="summary-grid">
                <div className="summary-card">
                  <div className="summary-label">Started</div>
                  <div className="summary-value small">{formatDateTime(details.session.started_at)}</div>
                </div>
                <div className="summary-card">
                  <div className="summary-label">Ended</div>
                  <div className="summary-value small">{formatDateTime(details.session.ended_at)}</div>
                </div>
                <div className="summary-card">
                  <div className="summary-label">Status</div>
                  <div className="summary-value small">{details.session.status || '—'}</div>
                </div>
                <div className="summary-card">
                  <div className="summary-label">Rounds</div>
                  <div className="summary-value">{details.session.rounds_played ?? 0}</div>
                </div>
              </div>

              <div className="panel glass inner-panel">
                <div className="panel-head">
                  <h4>Session Players</h4>
                </div>
                {details.session_players?.length ? (
                  <div className="table-wrap">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Name</th>
                          <th>Gender</th>
                          <th>Start ELO</th>
                          <th>End ELO</th>
                          <th>ELO Gain</th>
                          <th>Wins</th>
                          <th>Losses</th>
                          <th>Matches</th>
                          <th>Benched</th>
                        </tr>
                      </thead>
                      <tbody>
                        {details.session_players
                          .slice()
                          .sort((a, b) => Number(b.elo_gain || 0) - Number(a.elo_gain || 0))
                          .map((row) => (
                            <tr key={row.id}>
                              <td>{row.player_name || row.player_id}</td>
                              <td className="center">{row.player_gender || '—'}</td>
                              <td className="center">{row.starting_elo}</td>
                              <td className="center">{row.ending_elo ?? '—'}</td>
                              <td className="center">{formatSigned(row.elo_gain)}</td>
                              <td className="center">{row.wins}</td>
                              <td className="center">{row.losses}</td>
                              <td className="center">{row.matches_played}</td>
                              <td className="center">{row.benched_count}</td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="muted p-8">No session player rows found.</div>
                )}
              </div>

              <div className="panel glass inner-panel">
                <div className="panel-head">
                  <h4>Round-by-Round Match History</h4>
                </div>

                {!groupedMatches.length ? (
                  <div className="muted p-8">No matches found for this session.</div>
                ) : (
                  <div className="history-rounds">
                    {groupedMatches.map((group) => (
                      <div key={group.round} className="history-round-block">
                        <div className="history-round-title">Round {group.round}</div>

                        {group.matches.map((match) => {
                          const playersByTeam = splitMatchPlayers(match.match_players || []);
                          return (
                            <div key={match.id} className="history-match-card">
                              <div className="history-match-head">
                                <div>
                                  <b>Court {match.court_number}</b>
                                </div>
                                <div className="muted">
                                  {match.status === 'no_result'
                                    ? 'No Result'
                                    : match.winner_team
                                      ? `Winner: Team ${match.winner_team}`
                                      : 'Pending'}
                                </div>
                              </div>

                              <div className="history-teams-grid">
                                <div className={`history-team ${match.winner_team === 1 ? 'winner' : ''}`}>
                                  <div className="team-title">Team 1</div>
                                  <div className="history-player-list">
                                    {playersByTeam.team1.length ? (
                                      playersByTeam.team1.map((p) => (
                                        <div key={p.id} className="history-player-item">
                                          <span>
                                            <span className={`pill sm ${p.player_gender === 'F' ? 'female' : 'male'}`}>
                                              {p.player_gender || '?'}
                                            </span>{' '}
                                            {p.player_name || p.player_id}
                                          </span>
                                          <span className="muted">
                                            {p.elo_before}
                                            {p.elo_after !== null && p.elo_after !== undefined
                                              ? ` → ${p.elo_after}`
                                              : ''}
                                            {' '}
                                            ({formatSigned(p.elo_delta)})
                                          </span>
                                        </div>
                                      ))
                                    ) : (
                                      <div className="muted">No players recorded</div>
                                    )}
                                  </div>
                                </div>

                                <div className={`history-team ${match.winner_team === 2 ? 'winner' : ''}`}>
                                  <div className="team-title">Team 2</div>
                                  <div className="history-player-list">
                                    {playersByTeam.team2.length ? (
                                      playersByTeam.team2.map((p) => (
                                        <div key={p.id} className="history-player-item">
                                          <span>
                                            <span className={`pill sm ${p.player_gender === 'F' ? 'female' : 'male'}`}>
                                              {p.player_gender || '?'}
                                            </span>{' '}
                                            {p.player_name || p.player_id}
                                          </span>
                                          <span className="muted">
                                            {p.elo_before}
                                            {p.elo_after !== null && p.elo_after !== undefined
                                              ? ` → ${p.elo_after}`
                                              : ''}
                                            {' '}
                                            ({formatSigned(p.elo_delta)})
                                          </span>
                                        </div>
                                      ))
                                    ) : (
                                      <div className="muted">No players recorded</div>
                                    )}
                                  </div>
                                </div>
                              </div>

                              <div className="history-match-foot muted">
                                Team averages: {match.team1_avg_elo ?? '—'} vs {match.team2_avg_elo ?? '—'}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function SettingsTab({
  matchMinutes,
  setMatchMinutes,
  warningSeconds,
  setWarningSeconds,
  transitionSeconds,
  setTransitionSeconds,
  preRoundSeconds,
  setPreRoundSeconds,
  courtsCount,
  setCourtsCount,
  kFactor,
  setKFactor,
  matchMode,
  setMatchModeState,
  volume,
  setVolume,
  saveSettings,
}) {
  return (
    <div className="page">
      <div className="panel glass">
        <div className="panel-head">
          <h3>Settings</h3>
        </div>

        <div className="settings-grid">
          <div className="setting">
            <label>Game Length (minutes)</label>
            <input
              className="input"
              type="number"
              min="1"
              max="60"
              value={matchMinutes}
              onChange={(e) => setMatchMinutes(Number(e.target.value))}
            />
          </div>

          <div className="setting">
            <label>Warning Threshold (seconds left)</label>
            <input
              className="input"
              type="number"
              min="5"
              max="120"
              value={warningSeconds}
              onChange={(e) => setWarningSeconds(Number(e.target.value))}
            />
          </div>

          <div className="setting">
            <label>Transition Period (seconds)</label>
            <input
              className="input"
              type="number"
              min="10"
              max="180"
              value={transitionSeconds}
              onChange={(e) => setTransitionSeconds(Number(e.target.value))}
            />
          </div>

          <div className="setting">
            <label>Pre-Game (seconds)</label>
            <input
              className="input"
              type="number"
              min="5"
              max="180"
              value={preRoundSeconds}
              onChange={(e) => setPreRoundSeconds(Number(e.target.value))}
            />
          </div>

          <div className="setting">
            <label>Courts Available</label>
            <input
              className="input"
              type="number"
              min="1"
              max="6"
              value={courtsCount}
              onChange={(e) => setCourtsCount(Number(e.target.value))}
            />
          </div>

          <div className="setting">
            <label>Default ELO K-Factor</label>
            <input
              className="input"
              type="number"
              min="1"
              max="200"
              value={kFactor}
              onChange={(e) => setKFactor(Number(e.target.value))}
            />
          </div>

          <div className="setting">
            <label>Matchmaking Mode</label>
            <select
              className="input"
              value={matchMode}
              onChange={(e) => setMatchModeState(e.target.value)}
            >
              <option value={MATCH_MODES.WINDOW}>Window</option>
              <option value={MATCH_MODES.BAND}>Band</option>
            </select>
          </div>

          <div className="setting">
            <label>Sound Volume (0–100)</label>
            <input
              className="input"
              type="number"
              min="0"
              max="100"
              step="1"
              value={volume}
              onChange={(e) => setVolume(Number(e.target.value))}
            />
          </div>
        </div>

        <div className="settings-note">
          <div><b>Default Settings</b></div>
          <div>Pre-Game = 30s • Game = 10 mins • Warning Threshold = 30s left • Transition Period = 60s</div>
          <div>No winner selected by end of transition = no rating change.</div>
        </div>

        <div className="right mt-12">
          <button className="btn primary" onClick={saveSettings}>
            Save Settings
          </button>
        </div>
      </div>
    </div>
  );
}

function PlayerRow({ player, onClick, present = false, showBenchCount = false }) {
  return (
    <div className={`row-player ${present ? 'present' : ''}`} onClick={onClick}>
      <span className="name">{player.name}</span>
      <span className="meta">
        <span className={`pill sm ${player.gender === 'F' ? 'female' : 'male'}`}>{player.gender}</span>
        <span>ELO {player.elo_rating}</span>
        <span>T{displayTier(player)}</span>
        {showBenchCount ? <span>Benched {Number(player.bench_count || 0)}</span> : null}
      </span>
    </div>
  );
}

function CourtCard({ match, phase, selectedWinner, onPickWinner, onClearWinner }) {
  const canPick = phase === PHASES.TRANSITION;

  return (
    <div className="court glass">
      <div className="court-head">
        <h3>Court {match.court}</h3>
        <div className="avg-pair">
          <span className="avg">Team 1 Avg: <b>{Math.round(match.avg1)}</b></span>
          <span className="avg">Team 2 Avg: <b>{Math.round(match.avg2)}</b></span>
        </div>
      </div>

      <div className="team-block">
        <div className={`team-card ${selectedWinner === 1 ? 'winner' : ''}`}>
          <div className="team-title">Team 1</div>
          <div className="team-line">
            {match.team1.map((p) => (
              <div className="tag" key={p.id}>
                <span className={`pill sm ${p.gender === 'F' ? 'female' : 'male'}`}>{p.gender}</span>
                {p.name}
              </div>
            ))}
          </div>
          <button
            className={`winner-btn ${selectedWinner === 1 ? 'active' : ''}`}
            onClick={() => onPickWinner(match.court, 1)}
            disabled={!canPick}
          >
            Team 1 Won
          </button>
        </div>

        <div className="net-horizontal" />

        <div className={`team-card ${selectedWinner === 2 ? 'winner' : ''}`}>
          <div className="team-title">Team 2</div>
          <div className="team-line">
            {match.team2.map((p) => (
              <div className="tag" key={p.id}>
                <span className={`pill sm ${p.gender === 'F' ? 'female' : 'male'}`}>{p.gender}</span>
                {p.name}
              </div>
            ))}
          </div>
          <button
            className={`winner-btn ${selectedWinner === 2 ? 'active' : ''}`}
            onClick={() => onPickWinner(match.court, 2)}
            disabled={!canPick}
          >
            Team 2 Won
          </button>
        </div>
      </div>

      <div className="court-footer">
        {canPick ? (
          <>
            <div className="muted">
              {selectedWinner
                ? `Winner selected: Team ${selectedWinner}`
                : 'No winner selected yet. If transition ends now, no ELO points are awarded.'}
            </div>
            <button className="btn ghost" onClick={() => onClearWinner(match.court)}>
              Clear Selection
            </button>
          </>
        ) : (
          <div className="muted">Winner selection opens during Stage 3/4.</div>
        )}
      </div>
    </div>
  );
}

/* ================= Utilities ================= */

function formatSigned(n) {
  const value = Number(n || 0);
  if (value > 0) return `+${value}`;
  return String(value);
}

function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString();
}

function splitMatchPlayers(matchPlayers) {
  return {
    team1: matchPlayers.filter((p) => Number(p.team_number) === 1),
    team2: matchPlayers.filter((p) => Number(p.team_number) === 2),
  };
}

function buildSessionSummary(players, gainMap, history, rounds) {
  const resolved = history.filter((x) => x.type === 'round_resolved');
  const allResults = resolved.flatMap((x) => x.results || []);
  const completedMatches = allResults.filter((x) => x.status === 'completed').length;
  const noResultMatches = allResults.filter((x) => x.status === 'no_result').length;

  let topGain = 0;
  let topGainName = '';

  players.forEach((player) => {
    const gain = Number(gainMap.get(player.id) || 0);
    if (gain > topGain) {
      topGain = gain;
      topGainName = player.name;
    }
  });

  return {
    rounds,
    completedMatches,
    noResultMatches,
    topGain,
    topGainName,
  };
}