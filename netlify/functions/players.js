// netlify/functions/players.js
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

export default async (req) => {
  try {
    const method = req.method;

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (!url || !key) {
      return J(500, { error: 'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE/ANON_KEY' });
    }

    if (method === 'GET') {
      const { data, error } = await supabase
        .from('players')
        .select('*')
        .order('name', { ascending: true });

      if (error) {
        console.error('[players][GET]', error);
        return J(500, { error: error.message || String(error) });
      }

      return J(200, data || []);
    }

    if (method === 'PATCH') {
      let body = {};
      try {
        body = await req.json();
      } catch {}

      const incoming = Array.isArray(body?.updates) ? body.updates : [];

      if (!incoming.length) {
        return J(400, { error: 'Missing updates array' });
      }

      const results = [];

      for (const u of incoming) {
        if (!u || !u.id) continue;

        let fields = {};

        if (u.fields && typeof u.fields === 'object') {
          fields = u.fields;
        } else {
          const { id, fields: _ignored, ...rest } = u;
          fields = rest;
        }

        if (!fields || Object.keys(fields).length === 0) continue;

        const { data, error } = await supabase
          .from('players')
          .update(fields)
          .eq('id', u.id)
          .select()
          .maybeSingle();

        if (error) {
          console.error('[players][PATCH]', error);
          return J(500, {
            error: error.message || String(error),
            id: u.id,
            fields,
          });
        }

        results.push(data);
      }

      return J(200, { ok: true, count: results.length, rows: results });
    }

    if (method === 'POST') {
      let body = {};
      try {
        body = await req.json();
      } catch {}

      const players = Array.isArray(body?.players) ? body.players : [];

      if (!players.length) {
        return J(400, { error: 'No players provided' });
      }

      const { data, error } = await supabase
        .from('players')
        .upsert(players, { onConflict: 'id' })
        .select();

      if (error) {
        console.error('[players][POST]', error);
        return J(500, { error: error.message || String(error) });
      }

      return J(200, { ok: true, rows: data || [] });
    }

    if (method === 'DELETE') {
      let body = {};
      try {
        body = await req.json();
      } catch {}

      const ids = Array.isArray(body?.ids)
        ? body.ids.filter(Boolean)
        : body?.id
          ? [body.id]
          : [];

      if (!ids.length) {
        return J(400, { error: 'Missing ids array or id' });
      }

      const { error } = await supabase.from('players').delete().in('id', ids);

      if (error) {
        console.error('[players][DELETE]', error);
        return J(500, { error: error.message || String(error) });
      }

      return J(200, { ok: true, count: ids.length });
    }

    return J(405, { error: 'Method not allowed' });
  } catch (err) {
    console.error('[players] fatal:', err);
    return J(500, { error: String(err?.message || err) });
  }
}