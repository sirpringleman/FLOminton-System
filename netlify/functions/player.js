// netlify/functions/players.js
import { createClient } from '@supabase/supabase-js'

const url = process.env.SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE

// Create a server-side Supabase client (safe: keys are not exposed to the browser)
const supabase = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

export const handler = async (event) => {
  try {
    const method = event.httpMethod

    // CORS headers for your site
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Content-Type': 'application/json',
    }

    if (method === 'OPTIONS') {
      return { statusCode: 200, headers, body: '' }
    }

    if (method === 'GET') {
      // List players
      const { data, error } = await supabase.from('players').select('*').order('name', { ascending: true })
      if (error) throw error
      return { statusCode: 200, headers, body: JSON.stringify(data) }
    }

    if (method === 'PATCH') {
      // Update multiple players. Body: { updates: [{id, ...fields}, ...] }
      const body = JSON.parse(event.body || '{}')
      const updates = Array.isArray(body.updates) ? body.updates : []
      if (!updates.length) {
        return { statusCode: 400, headers, body: JSON.stringify({ message: 'No updates' }) }
      }

      // Perform updates one-by-one (simple & reliable)
      for (const u of updates) {
        const { id, ...fields } = u
        if (!id) continue
        const { error } = await supabase.from('players').update(fields).eq('id', id)
        if (error) throw error
      }
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) }
    }

    if (method === 'POST') {
      // Upsert one or more players. Body: { players: [{...}, ...] }
      const body = JSON.parse(event.body || '{}')
      const players = Array.isArray(body.players) ? body.players : []
      if (!players.length) {
        return { statusCode: 400, headers, body: JSON.stringify({ message: 'No players' }) }
      }
      const { error } = await supabase.from('players').upsert(players)
      if (error) throw error
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) }
    }

    return { statusCode: 405, headers, body: JSON.stringify({ message: 'Method not allowed' }) }
  } catch (e) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ message: e.message || String(e) }),
    }
  }
}
