// netlify/functions/players.js
// Tolerates BOTH shapes:
//   { updates: [ { id, fields: { is_present: true } } ] }
//   { updates: [ { id, is_present: true } ] }

import { createClient } from '@supabase/supabase-js'

const url = process.env.SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_ANON_KEY

const supabase = createClient(url, key, { auth: { persistSession: false } })

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'access-control-allow-headers': 'content-type,authorization',
  'content-type': 'application/json'
}

const J = (status, data) => new Response(JSON.stringify(data), { status, headers: CORS })

export default async (req, ctx) => {
  try {
    const method = req.method

    // preflight
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS })
    }

    if (!url || !key) {
      console.error('[players] missing env')
      return J(500, { error: 'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE/ANON_KEY' })
    }

    /* ======================= GET ======================= */
    if (method === 'GET') {
      const { data, error } = await supabase
        .from('players')
        .select('*')
        .order('name', { ascending: true })

      if (error) {
        console.error('[players][GET]', error)
        return J(500, { error: error.message || String(error) })
      }
      return J(200, data || [])
    }

    /* ======================= PATCH ======================= */
    if (method === 'PATCH') {
      let body = {}
      try { body = await req.json() } catch {}
      const incoming = Array.isArray(body?.updates) ? body.updates : []

      if (!incoming.length) {
        return J(400, { error: 'Missing updates array' })
      }

      const results = []

      for (const u of incoming) {
        if (!u || !u.id) continue

        // accept both shapes
        // shape A: { id, fields: {...} }
        // shape B: { id, is_present: true, bench_count: 2, ... }
        let fields = {}
        if (u.fields && typeof u.fields === 'object') {
          fields = u.fields
        } else {
          // copy all props except id/fields into fields
          const { id, fields: _ignored, ...rest } = u
          fields = rest
        }

        // if still no fields, skip
        if (!fields || Object.keys(fields).length === 0) {
          console.warn('[players][PATCH] no fields for id', u.id)
          continue
        }

        const { data, error } = await supabase
          .from('players')
          .update(fields)
          .eq('id', u.id)
          .select()
          .maybeSingle() // tolerate 0 rows
        if (error) {
          console.error('[players][PATCH] update failed:', {
            id: u.id,
            fields,
            error
          })
          return J(500, {
            error: error.message || String(error),
            id: u.id,
            fields
          })
        }

        results.push(data)
      }

      return J(200, { ok: true, count: results.length, rows: results })
    }

    /* ======================= POST (upsert) ======================= */
    if (method === 'POST') {
      let body = {}
      try { body = await req.json() } catch {}
      const players = Array.isArray(body?.players) ? body.players : []
      if (!players.length) {
        return J(400, { error: 'No players provided' })
      }

      const { data, error } = await supabase
        .from('players')
        .upsert(players, { onConflict: 'id' })
        .select()

      if (error) {
        console.error('[players][POST] upsert error:', error)
        return J(500, { error: error.message || String(error) })
      }

      return J(200, { ok: true, rows: data })
    }

    /* ======================= DELETE ======================= */
    if (method === 'DELETE') {
      let body = {}
      try { body = await req.json() } catch {}
      const id = body?.id
      if (!id) return J(400, { error: 'Missing id' })

      const { error } = await supabase.from('players').delete().eq('id', id)
      if (error) {
        console.error('[players][DELETE] error:', error)
        return J(500, { error: error.message || String(error) })
      }
      return J(200, { ok: true })
    }

    return J(405, { error: 'Method not allowed' })
  } catch (err) {
    console.error('[players] fatal:', err)
    return J(500, { error: String(err?.message || err) })
  }
}
