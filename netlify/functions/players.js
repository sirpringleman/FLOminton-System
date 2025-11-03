// netlify/functions/players.js
// Requires Netlify env vars:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE   (preferred)  OR SUPABASE_ANON_KEY (with RLS policies allowing the ops you need)

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_ANON_KEY;

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false }
});

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const { data, error } = await supabase
        .from('players')
        .select('*')
        .order('name', { ascending: true });
      if (error) throw error;
      return res.status(200).json(data || []);
    }

    if (req.method === 'PATCH') {
      const body = await readBody(req);
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
      return res.status(200).json({ ok: true, count: results.length, rows: results });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      const players = Array.isArray(body?.players) ? body.players : [];
      if (!players.length) return res.status(400).json({ error: 'No players provided' });
      const { data, error } = await supabase
        .from('players')
        .upsert(players, { onConflict: 'id' })
        .select();
      if (error) throw error;
      return res.status(200).json({ ok: true, rows: data });
    }

    if (req.method === 'DELETE') {
      const body = await readBody(req);
      const id = body?.id;
      if (!id) return res.status(400).json({ error: 'Missing id' });
      const { error } = await supabase
        .from('players')
        .delete()
        .eq('id', id);
      if (error) throw error;
      return res.status(200).json({ ok: true });
    }

    res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    console.error('players function error:', err);
    res.status(500).json({ error: String(err?.message || err) });
  }
}

// Netlify body reader (works for all verbs)
async function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); }
      catch { resolve({}); }
    });
  });
}
