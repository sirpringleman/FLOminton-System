// netlify/functions/players.js
// Netlify Functions v2 "Fetch" style handler (req -> Response)
// Requires env vars on Netlify:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE   (preferred)  OR SUPABASE_ANON_KEY

import { createClient } from '@supabase/supabase-js';

const url  = process.env.SUPABASE_URL;
const key  = process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_ANON_KEY;

if (!url || !key) {
  // Fail fast so logs are clear
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE/ANON_KEY');
}

const supabase = createClient(url, key, { auth: { persistSession: false } });

// Helper to return JSON Responses
function json(status, data) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export default async (request, context) => {
  try {
    const { method } = request;

    if (method === 'GET') {
      const { data, error } = await supabase
        .from('players')
        .select('*')
        .order('name', { ascending: true });

      if (error) throw error;
      return json(200, data || []);
    }

    if (method === 'PATCH') {
      let body = {};
      try { body = await request.json(); } catch {}
      const updates = Array.isArray(body?.updates) ? body.updates : [];
      const results = [];

      for (const u of updates) {
        const { id, fields } = u || {};
        if (!id) continue;
        const { data, error } = await supabase
          .from('players')
          .update(fields || {})
          .eq('id', id)
          .select()
          .single();
        if (error) throw error;
        results.push(data);
      }
      return json(200, { ok: true, count: results.length, rows: results });
    }

    if (method === 'POST') {
      let body = {};
      try { body = await request.json(); } catch {}
      const players = Array.isArray(body?.players) ? body.players : [];
      if (!players.length) return json(400, { error: 'No players provided' });

      const { data, error } = await supabase
        .from('players')
        .upsert(players, { onConflict: 'id' })
        .select();
      if (error) throw error;
      return json(200, { ok: true, rows: data });
    }

    if (method === 'DELETE') {
      let body = {};
      try { body = await request.json(); } catch {}
      const id = body?.id;
      if (!id) return json(400, { error: 'Missing id' });

      const { error } = await supabase.from('players').delete().eq('id', id);
      if (error) throw error;
      return json(200, { ok: true });
    }

    return json(405, { error: 'Method not allowed' });
  } catch (err) {
    console.error('players function error:', err);
    return json(500, { error: String(err?.message || err) });
  }
};
