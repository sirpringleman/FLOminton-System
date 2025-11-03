// netlify/functions/players.js
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
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })

    if (!url || !key) {
      console.error('[players] Missing SUPABASE_URL or KEY')
      return J(500, { error: 'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE/ANON_KEY' })
    }

    if (req.method === 'GET') {
      const { data, error } = await supabase.from('players').select('*').order('name', { ascending: true })
      if (error) {
        console.error('[players][GET] supabase error:', error)
        return J(500, { error: String(error.message || error) })
      }
      return J(200, data || [])
    }

    if (req.method === 'PATCH') {
      let body = {}
      try { body = await req.json() } catch {}
      const updates = Array.isArray(body?.updates) ? body.updates : []
      if (!updates.length) return J(400, { error: 'Missing updates' })

      const results = []
      for (const u of updates) {
        const { id, fields } = u || {}
        if (!id) continue
        try {
          const { data, error } = await supabase
            .from('players')
            .update(fields || {})
            .eq('id', id)
            .select()
            .single()
          if (error) {
            console.error('[players][PATCH] update failed:', { id, fields, error })
            return J(500, { error: error.message || String(error), id, fields })
          }
          results.push(data)
        } catch (e) {
          console.error('[players][PATCH] exception:', { id, fields, e })
          return J(500, { error: String(e?.message || e), id, fields })
        }
      }
      return J(200, { ok: true, count: results.length, rows: results })
    }

    if (req.method === 'POST') {
      let body = {}
      try { body = await req.json() } catch {}
      const players = Array.isArray(body?.players) ? body.players : []
      if (!players.length) return J(400, { error: 'No players provided' })

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

    if (req.method === 'DELETE') {
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
