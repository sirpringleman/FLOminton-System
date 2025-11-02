// netlify/functions/players.js
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const ADMIN_KEY = process.env.ADMIN_KEY || ''; // set in Netlify > Site settings > Environment

if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE');
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Key',
};

const json = (status, body) => ({
  statusCode: status,
  headers: { 'Content-Type': 'application/json', ...corsHeaders },
  body: JSON.stringify(body),
});

export async function handler(event) {
  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }

  const method = event.httpMethod.toUpperCase();

  try {
    // GET: list all players (public)
    if (method === 'GET') {
      const { data, error } = await supabase.from('players').select('*').order('name');
      if (error) throw error;
      return json(200, data || []);
    }

    // PATCH: update one or many players
    // Public whitelist: is_present, bench_count, last_played_round
    if (method === 'PATCH') {
      const body = JSON.parse(event.body || '{}');
      const updates = Array.isArray(body.updates) ? body.updates : [];
      if (!updates.length) return json(200, { ok: true, message: 'No updates' });

      const adminKey = event.headers['x-admin-key'] || event.headers['X-Admin-Key'];
      const publicAllowed = new Set(['is_present', 'bench_count', 'last_played_round']);

      const results = [];
      for (const u of updates) {
        const { id, ...fields } = u || {};
        if (!id || !fields || !Object.keys(fields).length) continue;

        const keys = Object.keys(fields);
        const allPublic = keys.every((k) => publicAllowed.has(k));

        // If not all fields are in the safe public list, require admin
        if (!allPublic && adminKey !== ADMIN_KEY) {
          results.push({ id, ok: false, error: 'Forbidden (admin required)' });
          continue;
        }

        const { error } = await supabase.from('players').update(fields).eq('id', id);
        if (error) {
          results.push({ id, ok: false, error: error.message || String(error) });
        } else {
          results.push({ id, ok: true });
        }
      }

      const anyError = results.some((r) => r.ok === false);
      return json(anyError ? 207 : 200, { ok: !anyError, results });
    }

    // POST: upsert players (admin only)
    if (method === 'POST') {
      const adminKey = event.headers['x-admin-key'] || event.headers['X-Admin-Key'];
      if (adminKey !== ADMIN_KEY) return json(401, { message: 'Unauthorized' });

      const body = JSON.parse(event.body || '{}');
      const players = Array.isArray(body.players) ? body.players : [];
      if (!players.length) return json(400, { message: 'No players provided' });

      const { error } = await supabase.from('players').upsert(players, { onConflict: 'id' });
      if (error) throw error;
      return json(200, { ok: true });
    }

    // DELETE: remove players (admin only)
    if (method === 'DELETE') {
      const adminKey = event.headers['x-admin-key'] || event.headers['X-Admin-Key'];
      if (adminKey !== ADMIN_KEY) return json(401, { message: 'Unauthorized' });

      const body = JSON.parse(event.body || '{}');
      const ids = Array.isArray(body.ids) ? body.ids : [];
      if (!ids.length) return json(400, { message: 'No ids provided' });

      const { error } = await supabase.from('players').delete().in('id', ids);
      if (error) throw error;
      return json(200, { ok: true });
    }

    return json(405, { message: 'Method not allowed' });
  } catch (err) {
    console.error('Function error:', err);
    // Surface a clear error so the browser alert is useful
    return json(500, { message: err?.message || String(err) });
  }
}
