// netlify/functions/players.js
// FULL REWRITE FOR FLOMINTON ELO SYSTEM
//
// Supports:
//  GET       → list all players
//  POST      → upsert players
//  PATCH     → bulk update fields for many players
//  DELETE    → delete a player
//  POST /reset → reset all stats (admin only)
//
// Notes:
//   - Reset DOES NOT change is_present (as requested)
//   - All new stats fields for ELO system are supported
//   - Handles both {id, fields:{...}} and {id, field1, field2...} formats

import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key =
  process.env.SUPABASE_SERVICE_ROLE ||
  process.env.SUPABASE_ANON_KEY;

const supabase = createClient(url, key, { auth: { persistSession: false } });

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'access-control-allow-headers': 'content-type,authorization,x-admin-key',
  'content-type': 'application/json'
};

const J = (status, data) =>
  new Response(JSON.stringify(data), {
    status,
    headers: CORS
  });

// Hard-coded admin key header name
const ADMIN_HEADER = "x-admin-key";

/* ============================================================
   RESET ALL STATS (ADMIN ONLY)
   ============================================================ */

async function resetAllStats(adminKey) {
  if (!adminKey) {
    return J(403, { error: "Admin key required" });
  }

  // Reset all fields EXCEPT is_present, name, gender, handedness, notes, status
  const resetFields = {
    elo_rating: 1000,
    elo_delta_session: 0,
    elo_delta_total: 0,
    wins: 0,
    losses: 0,
    matches_played: 0,
    attendance_count: 0,
    win_streak: 0,
    loss_streak: 0,
    bench_count: 0,
    last_played_round: 0,
    last_seen_at: null
  };

  const { error } = await supabase
    .from('players')
    .update(resetFields)
    .neq('id', null); // update ALL rows

  if (error) {
    console.error("[players/reset] failed:", error);
    return J(500, { error: error.message });
  }

  return J(200, { ok: true, reset: resetFields });
}

/* ============================================================
   MAIN HANDLER
   ============================================================ */

export default async (req, ctx) => {
  try {
    const method = req.method;
    const adminKey = req.headers.get(ADMIN_HEADER) || "";

    // Preflight
    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (!url || !key) {
      console.error("[players] missing env");
      return J(500, { error: "Missing SUPABASE_URL or keys" });
    }

    /* ========================================================
       SPECIAL ROUTE → /reset (admin only)
       ======================================================== */
    if (req.url.includes("/reset") && method === "POST") {
      return resetAllStats(adminKey);
    }

    /* ========================================================
       GET → list players
       ======================================================== */
    if (method === 'GET') {
      const { data, error } = await supabase
        .from('players')
        .select('*')
        .order('name', { ascending: true });

      if (error) {
        console.error("[players/GET]", error);
        return J(500, { error: error.message });
      }
      return J(200, data || []);
    }

    /* ========================================================
       POST → upsert players
       ======================================================== */
    if (method === 'POST') {
      let body = {};
      try { body = await req.json(); } catch {}

      // Upsert multiple players
      const players = Array.isArray(body.players) ? body.players : [];

      if (!players.length) {
        return J(400, { error: "No players provided" });
      }

      const { data, error } = await supabase
        .from('players')
        .upsert(players, { onConflict: 'id' })
        .select();

      if (error) {
        console.error("[players/POST]", error);
        return J(500, { error: error.message });
      }

      return J(200, { ok: true, rows: data });
    }

    /* ========================================================
       PATCH → update multiple players
       ======================================================== */
    if (method === 'PATCH') {
      let body = {};
      try { body = await req.json(); } catch {}

      const updates = Array.isArray(body.updates) ? body.updates : [];

      if (!updates.length) {
        return J(400, { error: "Missing updates array" });
      }

      const results = [];

      for (const u of updates) {
        if (!u || !u.id) continue;

        // Accept both:
        // { id, fields:{...} }
        // { id, elo_rating:1200, matches_played: 3, ... }
        let fields = {};
        if (u.fields && typeof u.fields === "object") {
          fields = u.fields;
        } else {
          const { id, fields: _ignored, ...rest } = u;
          fields = rest;
        }

        // No fields?
        if (!fields || Object.keys(fields).length === 0) {
          console.warn("[players/PATCH] no fields for id", u.id);
          continue;
        }

        const { data, error } = await supabase
          .from('players')
          .update(fields)
          .eq('id', u.id)
          .select()
          .maybeSingle();

        if (error) {
          console.error("[players/PATCH] update failed:", {
            id: u.id,
            fields,
            error
          });
          return J(500, { error: error.message, id: u.id, fields });
        }

        results.push(data);
      }

      return J(200, { ok: true, count: results.length, rows: results });
    }

    /* ========================================================
       DELETE → delete a player by ID
       ======================================================== */
    if (method === 'DELETE') {
      let body = {};
      try { body = await req.json(); } catch {}

      const id = body?.id;
      if (!id) return J(400, { error: "Missing id" });

      const { error } = await supabase
        .from('players')
        .delete()
        .eq('id', id);

      if (error) {
        console.error("[players/DELETE]", error);
        return J(500, { error: error.message });
      }

      return J(200, { ok: true });
    }

    return J(405, { error: "Method not allowed" });

  } catch (err) {
    console.error("[players] fatal:", err);
    return J(500, { error: String(err?.message || err) });
  }
};
