// netlify/functions/players.js  (CommonJS)
const { createClient } = require('@supabase/supabase-js')

const url = process.env.SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE

// Defensive: fail fast if env missing
if (!url || !serviceKey) {
  console.error('[players] Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE')
}

const supabase = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

/** Chunk an array: returns arrays of length n */
function chunk(arr, n) {
  const out = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  }

  try {
    const method = event.httpMethod

    if (method === 'OPTIONS') {
      return { statusCode: 200, headers, body: '' }
    }

    if (method === 'GET') {
      const { data, error } = await supabase
        .from('players')
        .select('*')
        .order('name', { ascending: true })

      if (error) {
        console.error('[players][GET] supabase error:', error)
        return { statusCode: 500, headers, body: JSON.stringify({ message: error.message }) }
      }
      return { statusCode: 200, headers, body: JSON.stringify(data || []) }
    }

    if (method === 'PATCH') {
      let body = {}
      try {
        body = JSON.parse(event.body || '{}')
      } catch (e) {
        console.error('[players][PATCH] bad JSON body:', event.body)
        return { statusCode: 400, headers, body: JSON.stringify({ message: 'Invalid JSON' }) }
      }

      const updates = Array.isArray(body.updates) ? body.updates : []
      if (!updates.length) {
        return { statusCode: 400, headers, body: JSON.stringify({ message: 'No updates provided' }) }
      }

      // Safer: apply in small chunks to avoid timeouts / payload limits
      const CHUNK_SIZE = 25
      const chunks = chunk(updates, CHUNK_SIZE)
      const errors = []

      for (const part of chunks) {
        // Apply one-by-one to get precise error logging
        for (const u of part) {
          const { id, ...fields } = u || {}
          if (!id || typeof id !== 'string') {
            errors.push({ id, message: 'Invalid or missing id' })
            continue
          }
          try {
            const { error } = await supabase.from('players').update(fields).eq('id', id)
            if (error) {
              console.error('[players][PATCH] update error for id', id, error)
              errors.push({ id, message: error.message })
            }
          } catch (e) {
            console.error('[players][PATCH] exception for id', id, e)
            errors.push({ id, message: e.message || String(e) })
          }
        }
      }

      if (errors.length) {
        return { statusCode: 207, headers, body: JSON.stringify({ ok: false, errors }) } // 207 Multi-Status
      }
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) }
    }

    if (method === 'POST') {
      let body = {}
      try {
        body = JSON.parse(event.body || '{}')
      } catch (e) {
        console.error('[players][POST] bad JSON body:', event.body)
        return { statusCode: 400, headers, body: JSON.stringify({ message: 'Invalid JSON' }) }
      }

      const players = Array.isArray(body.players) ? body.players : []
      if (!players.length) {
        return { statusCode: 400, headers, body: JSON.stringify({ message: 'No players provided' }) }
      }

      try {
        const { error } = await supabase.from('players').upsert(players)
        if (error) {
          console.error('[players][POST] upsert error:', error)
          return { statusCode: 500, headers, body: JSON.stringify({ message: error.message }) }
        }
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) }
      } catch (e) {
        console.error('[players][POST] exception:', e)
        return { statusCode: 500, headers, body: JSON.stringify({ message: e.message || String(e) }) }
      }
    }

    return { statusCode: 405, headers, body: JSON.stringify({ message: 'Method not allowed' }) }
  } catch (e) {
    console.error('[players] fatal error:', e)
    // Always return JSON, never HTML
    return { statusCode: 500, headers, body: JSON.stringify({ message: e.message || String(e) }) }
  }
}
