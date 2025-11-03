// netlify/functions/players.js
// Netlify Functions v2 (Fetch) handler compatible with your canonical App.jsx
// Requires Netlify env vars:
//   SUPABASE_URL
//   SUPABASE_SERVICE_ROLE  (recommended)  OR  SUPABASE_ANON_KEY
//
// Endpoints your front-end uses:
//   GET     /.netlify/functions/players
//   PATCH   /.netlify/functions/players   body: { updates:[{id, fields:{...}}, ...] }
//   POST    /.netlify/functions/players   body: { players:[{...}, ...] }  (upsert)
//   DELETE  /.netlify/functions/players   body: { id: "uuid" }

import { createClient } from '@supabase/supabase-js'

const url = process.env.SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_ANON_KEY

if (!url || !key) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE/ANON_KEY in Netlify env vars')
}

const supabase = createClient(url, key, { auth: { persistSession: false } })

function json(status, data, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json',
      ...extraHeaders
    }
  })
}

// Optional CORS helper (kept permissive for local previews / other origins)
const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'access-control-allow-headers': 'content-type,authorization'
}

export default async (request, context) => {
  try {
    const { method } = request

    // Preflight for safety (harmless when same-origin on Netlify)
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS })
    }

    if (method === 'GET') {
      const { data, error } = await supabase
        .from('players')
        .select('*')
        .order('name', { ascending: true })
      if (error) throw error
      return json(200, data || [], CORS_HEADERS)
    }

    if (method === 'PATCH') {
      let body = {}
      try { body = await request.json() } catch {}
      const updates = Array.isArray(body?.updates) ? body.updates : []
      const results = []

      for (const u of updates) {
        const { id, fields } = u || {}
        if (!id) continue
        const { data, error } = await supabase
          .from('players')
          .update(fields || {})
          .eq('id', id)
          .select()
          .single()
        if (error) throw error
        results.push(data)
      }
      return json(200, { ok: true, count: results.length, rows: results }, CORS_HEADERS)
    }

    if (method === 'POST') {
      let body = {}
      try { body = await request.json() } catch {}
      const players = Array.isArray(body?.players) ? body.players : []
      if (!players.length) return json(400, { error: 'No players provided' }, CORS_HEADERS)

      const { data, error } = await supabase
        .from('players')
        .upsert(players, { onConflict: 'id' })
        .select()
      if (error) throw error
      return json(200, { ok: true, rows: data }, CORS_HEADERS)
    }

    if (method === 'DELETE') {
      let body = {}
      try { body = await request.json() } catch {}
      const id = body?.id
      if (!id) return json(400, { error: 'Missing id' }, CORS_HEADERS)

      const { error } = await supabase.from('players').delete().eq('id', id)
      if (error) throw error
      return json(200, { ok: true }, CORS_HEADERS)
    }

    return json(405, { error: 'Method not allowed' }, CORS_HEADERS)
  } catch (err) {
    console.error('players function error:', err)
    return json(500, { error: String(err?.message || err) }, CORS_HEADERS)
  }
}
