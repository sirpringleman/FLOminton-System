// netlify/functions/sessions.js
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_ANON_KEY;

const supabase = createClient(url, key, {
  auth: { persistSession: false },
});

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'access-control-allow-headers': 'content-type,authorization,x-admin-key',
  'content-type': 'application/json',
};

const J = (status, data) =>
  new Response(JSON.stringify(data), { status, headers: CORS });

function safeNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export default async (req) => {
  try {
    const method = req.method;

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (!url || !key) {
      return J(500, { error: 'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE/ANON_KEY' });
    }

    if (method === 'POST') {
      let body = {};
      try {
        body = await req.json();
      } catch {}

      const action = body?.action;

      if (action === 'start_session') {
        const presentPlayers = Array.isArray(body?.players) ? body.players : [];

        const { data: sessionRow, error: sessionError } = await supabase
          .from('sessions')
          .insert({
            status: 'active',
            rounds_played: 0,
          })
          .select()
          .single();

        if (sessionError) {
          console.error('[sessions][start_session][session insert]', sessionError);
          return J(500, { error: sessionError.message || String(sessionError) });
        }

        if (presentPlayers.length) {
          const attendanceRows = presentPlayers.map((p) => ({
            session_id: sessionRow.id,
            player_id: p.id,
            starting_elo: safeNum(p.elo_rating, 1000),
            ending_elo: null,
            elo_gain: 0,
            wins: 0,
            losses: 0,
            matches_played: 0,
            benched_count: safeNum(p.bench_count, 0),
          }));

          const { error: attendanceError } = await supabase
            .from('session_players')
            .insert(attendanceRows);

          if (attendanceError) {
            console.error('[sessions][start_session][session_players insert]', attendanceError);
            return J(500, { error: attendanceError.message || String(attendanceError) });
          }
        }

        return J(200, {
          ok: true,
          session: sessionRow,
        });
      }

      if (action === 'log_round_results') {
        const sessionId = body?.session_id;
        const roundNumber = safeNum(body?.round_number, 0);
        const results = Array.isArray(body?.results) ? body.results : [];

        if (!sessionId) {
          return J(400, { error: 'Missing session_id' });
        }

        if (!roundNumber) {
          return J(400, { error: 'Missing round_number' });
        }

        const insertedMatches = [];

        for (const result of results) {
          const status = result?.status || 'pending';
          const winnerTeam =
            result?.winner_team === 1 || result?.winner_team === 2
              ? result.winner_team
              : null;

          const { data: matchRow, error: matchError } = await supabase
            .from('matches')
            .insert({
              session_id: sessionId,
              round_number: roundNumber,
              court_number: safeNum(result?.court_number, 0),
              status,
              winner_team: winnerTeam,
              team1_avg_elo: safeNum(result?.team1_avg_elo, 0),
              team2_avg_elo: safeNum(result?.team2_avg_elo, 0),
              resolved_at: new Date().toISOString(),
            })
            .select()
            .single();

          if (matchError) {
            console.error('[sessions][log_round_results][matches insert]', matchError, result);
            return J(500, { error: matchError.message || String(matchError) });
          }

          insertedMatches.push(matchRow);

          const playerRows = Array.isArray(result?.players) ? result.players : [];
          if (playerRows.length) {
            const payload = playerRows.map((player) => ({
              match_id: matchRow.id,
              player_id: player.player_id,
              team_number: safeNum(player.team_number, 0),
              elo_before: safeNum(player.elo_before, 1000),
              elo_after:
                player.elo_after === null || player.elo_after === undefined
                  ? null
                  : safeNum(player.elo_after, 1000),
              elo_delta: safeNum(player.elo_delta, 0),
              result: player.result || null,
            }));

            const { error: mpError } = await supabase
              .from('match_players')
              .insert(payload);

            if (mpError) {
              console.error('[sessions][log_round_results][match_players insert]', mpError, payload);
              return J(500, { error: mpError.message || String(mpError) });
            }
          }
        }

        const { error: updateSessionError } = await supabase
          .from('sessions')
          .update({ rounds_played: roundNumber })
          .eq('id', sessionId);

        if (updateSessionError) {
          console.error('[sessions][log_round_results][sessions update]', updateSessionError);
          return J(500, { error: updateSessionError.message || String(updateSessionError) });
        }

        return J(200, {
          ok: true,
          count: insertedMatches.length,
          rows: insertedMatches,
        });
      }

      if (action === 'end_session') {
        const sessionId = body?.session_id;
        const roundsPlayed = safeNum(body?.rounds_played, 0);
        const playerSummaries = Array.isArray(body?.player_summaries) ? body.player_summaries : [];

        if (!sessionId) {
          return J(400, { error: 'Missing session_id' });
        }

        for (const summary of playerSummaries) {
          const { error: spError } = await supabase
            .from('session_players')
            .update({
              ending_elo: safeNum(summary?.ending_elo, 1000),
              elo_gain: safeNum(summary?.elo_gain, 0),
              wins: safeNum(summary?.wins, 0),
              losses: safeNum(summary?.losses, 0),
              matches_played: safeNum(summary?.matches_played, 0),
              benched_count: safeNum(summary?.benched_count, 0),
            })
            .eq('session_id', sessionId)
            .eq('player_id', summary?.player_id);

          if (spError) {
            console.error('[sessions][end_session][session_players update]', spError, summary);
            return J(500, { error: spError.message || String(spError) });
          }
        }

        const { data: sessionRow, error: sessionError } = await supabase
          .from('sessions')
          .update({
            status: 'completed',
            ended_at: new Date().toISOString(),
            rounds_played: roundsPlayed,
          })
          .eq('id', sessionId)
          .select()
          .single();

        if (sessionError) {
          console.error('[sessions][end_session][sessions update]', sessionError);
          return J(500, { error: sessionError.message || String(sessionError) });
        }

        return J(200, {
          ok: true,
          session: sessionRow,
        });
      }

      return J(400, { error: 'Unsupported action' });
    }

    if (method === 'GET') {
      const urlObj = new URL(req.url);
      const sessionId = urlObj.searchParams.get('session_id');

      if (sessionId) {
        const { data: session, error: sessionError } = await supabase
          .from('sessions')
          .select('*')
          .eq('id', sessionId)
          .maybeSingle();

        if (sessionError) {
          console.error('[sessions][GET][session]', sessionError);
          return J(500, { error: sessionError.message || String(sessionError) });
        }

        const { data: matches, error: matchesError } = await supabase
          .from('matches')
          .select('*, match_players(*)')
          .eq('session_id', sessionId)
          .order('round_number', { ascending: true })
          .order('court_number', { ascending: true });

        if (matchesError) {
          console.error('[sessions][GET][matches]', matchesError);
          return J(500, { error: matchesError.message || String(matchesError) });
        }

        const { data: sessionPlayers, error: spError } = await supabase
          .from('session_players')
          .select('*')
          .eq('session_id', sessionId);

        if (spError) {
          console.error('[sessions][GET][session_players]', spError);
          return J(500, { error: spError.message || String(spError) });
        }

        return J(200, {
          session,
          matches: matches || [],
          session_players: sessionPlayers || [],
        });
      }

      const { data, error } = await supabase
        .from('sessions')
        .select('*')
        .order('started_at', { ascending: false })
        .limit(50);

      if (error) {
        console.error('[sessions][GET]', error);
        return J(500, { error: error.message || String(error) });
      }

      return J(200, data || []);
    }

    return J(405, { error: 'Method not allowed' });
  } catch (err) {
    console.error('[sessions] fatal:', err);
    return J(500, { error: String(err?.message || err) });
  }
};