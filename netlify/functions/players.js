// netlify/functions/players.js  (CommonJS)
const { createClient } = require('@supabase/supabase-js')

const url = process.env.SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE
const ADMIN_KEY = process.env.ADMIN_KEY || '' // set in Netlify env vars

const supabase = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

function isAdmin(event) {
  const h = event.headers || {}
  // headers may be lowercase in Netlify
  const key = h['x-admin-key'] || h['X-Admin-Key'] || ''
  return ADMIN_KEY && key === ADMIN_KEY
}
const JSON_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,X-Admin-Key',
  'Content-Type': 'application/json',
}

exports.handler = async (event) => {
  try {
    const method = event.httpMethod
    if (method === 'OPTIONS') {
      return { statusCode: 200, headers: JSON_HEADERS, body: '' }
    }

    // GET: public – list players
    if (method === 'GET') {
      const { data, error } = await supabase
        .from('players')
        .select('*')
        .order('name', { ascending: true })
      if (error) throw error
      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify(data || []) }
    }

    // PATCH: partial updates
    if (method === 'PATCH') {
      let body = {}
      try { body = JSON.parse(event.body || '{}') } catch {
        return { statusCode: 400, headers: JSON_HEADERS, body: JSON.stringify({ message: 'Invalid JSON' }) }
      }
      const updates = Array.isArray(body.updates) ? body.updates : []
      if (!updates.length) {
        return { statusCode: 400, headers: JSON_HEADERS, body: JSON.stringify({ message: 'No updates provided' }) }
      }

      // Determine if this patch touches admin-only fields
      const PUBLIC_FIELDS = new Set(['is_present', 'bench_count', 'last_played_round'])
      const touchesAdminField = updates.some(u => {
        const keys = Object.keys(u || {})
        return keys.some(k => k !== 'id' && !PUBLIC_FIELDS.has(k))
      })
      if (touchesAdminField && !isAdmin(event)) {
        return { statusCode: 403, headers: JSON_HEADERS, body: JSON.stringify({ message: 'Admin key required' }) }
      }

      // Apply updates one-by-one (clear errors if any)
      const errors = []
      for (const u of updates) {
        const { id, ...fields } = u || {}
        if (!id) { errors.push({ id, message: 'Missing id' }); continue }
        const { error } = await supabase.from('players').update(fields).eq('id', id)
        if (error) errors.push({ id, message: error.message })
      }
      if (errors.length) {
        return { statusCode: 207, headers: JSON_HEADERS, body: JSON.stringify({ ok: false, errors }) }
      }
      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) }
    }

    // POST: upsert (add/edit many) – admin only
    if (method === 'POST') {
      if (!isAdmin(event)) {
        return { statusCode: 403, headers: JSON_HEADERS, body: JSON.stringify({ message: 'Admin key required' }) }
      }
      let body = {}
      try { body = JSON.parse(event.body || '{}') } catch {
        return { statusCode: 400, headers: JSON_HEADERS, body: JSON.stringify({ message: 'Invalid JSON' }) }
      }
      const players = Array.isArray(body.players) ? body.players : []
      if (!players.length) {
        return { statusCode: 400, headers: JSON_HEADERS, body: JSON.stringify({ message: 'No players provided' }) }
      }
      const { error } = await supabase.from('players').upsert(players)
      if (error) throw error
      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) }
    }

    // DELETE: remove players – admin only
    if (method === 'DELETE') {
      if (!isAdmin(event)) {
        return { statusCode: 403, headers: JSON_HEADERS, body: JSON.stringify({ message: 'Admin key required' }) }
      }
      let body = {}
      try { body = JSON.parse(event.body || '{}') } catch {
        return { statusCode: 400, headers: JSON_HEADERS, body: JSON.stringify({ message: 'Invalid JSON' }) }
      }
      const ids = Array.isArray(body.ids) ? body.ids : []
      if (!ids.length) {
        return { statusCode: 400, headers: JSON_HEADERS, body: JSON.stringify({ message: 'No ids provided' }) }
      }
      const { error } = await supabase.from('players').delete().in('id', ids)
      if (error) throw error
      return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ ok: true }) }
    }

    return { statusCode: 405, headers: JSON_HEADERS, body: JSON.stringify({ message: 'Method not allowed' }) }
  } catch (e) {
    return { statusCode: 500, headers: JSON_HEADERS, body: JSON.stringify({ message: e.message || String(e) }) }
  }
}
