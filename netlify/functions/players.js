import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE;

const supabase = createClient(supabaseUrl, serviceKey);

export const handler = async (event) => {
  const method = event.httpMethod;

  // CORS preflight
  if (method === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type,x-admin-key',
      },
      body: '',
    };
  }

  try {
    if (method === 'GET') {
      const club = event.queryStringParameters && event.queryStringParameters.club;
      let query = supabase.from('players').select('*').order('name');
      if (club) {
        query = supabase.from('players').select('*').eq('club_code', club).order('name');
      }
      const { data, error } = await query;
      if (error) throw error;
      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
        body: JSON.stringify(data),
      };
    }

    if (method === 'PATCH') {
      const body = JSON.parse(event.body || '{}');
      const updates = body.updates || [];
      for (const u of updates) {
        const { id, ...fields } = u;
        if (!id) continue;
        const { error } = await supabase.from('players').update(fields).eq('id', id);
        if (error) throw error;
      }
      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
        body: JSON.stringify({ ok: true }),
      };
    }

    if (method === 'POST') {
      const body = JSON.parse(event.body || '{}');
      const club = body.club_code || null;
      let players = body.players || [];
      // force club_code
      players = players.map((p) => ({
        ...p,
        club_code: p.club_code || club,
      }));
      const { error } = await supabase.from('players').upsert(players);
      if (error) throw error;
      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
        body: JSON.stringify({ ok: true }),
      };
    }

    if (method === 'DELETE') {
      const body = JSON.parse(event.body || '{}');
      const ids = body.ids || [];
      if (!ids.length) {
        return {
          statusCode: 400,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
          body: JSON.stringify({ message: 'ids required' }),
        };
      }
      const { error } = await supabase.from('players').delete().in('id', ids);
      if (error) throw error;
      return {
        statusCode: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
        body: JSON.stringify({ ok: true }),
      };
    }

    return {
      statusCode: 405,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({ message: 'Method not allowed' }),
    };
  } catch (err) {
    console.error('players function failed', err);
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
      body: JSON.stringify({ message: err.message || 'server error' }),
    };
  }
};
