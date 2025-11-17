// netlify/functions/match_results.js
// FLOMINTON MATCH RESULTS LOGGER
//
// Supports ONLY:
//   POST  → insert many match_result rows
//
// Each inserted row should include:
//   session_id         (string - date or unique session identifier)
//   round_number       (int)
//   court_number       (int)
//   player_id          (UUID)
//   team               ("team1" | "team2")
//   result             ("win" | "loss")
//   elo_before         (number)
//   elo_after          (number)
//   elo_change         (number)
//   opponent_avg_elo   (number)
//   created_at         (optional - timestamp; otherwise auto generated)
//
// Example body:
// {
//   "results": [
//      {
//        "session_id": "2025-11-14",
//        "round_number": 3,
//        "court_number": 1,
//        "player_id": "abcd-uuid",
//        "team": "team1",
//        "result": "win",
//        "elo_before": 1040,
//        "elo_after": 1060,
//        "elo_change": 20,
//        "opponent_avg_elo": 1100
//      },
//      ...
//   ]
// }
//
// The players.js and App.jsx will call this after every completed round.

import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key =
  process.env.SUPABASE_SERVICE_ROLE ||
  process.env.SUPABASE_ANON_KEY;

const supabase = createClient(url, key, { auth: { persistSession: false } });

// CORS headers
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST,OPTIONS",
  "access-control-allow-headers": "content-type,authorization,x-admin-key",
  "content-type": "application/json"
};

const J = (status, data) =>
  new Response(JSON.stringify(data), {
    status,
    headers: CORS
  });

const ADMIN_HEADER = "x-admin-key";

export default async (req, ctx) => {
  try {
    const method = req.method;
    const adminKey = req.headers.get(ADMIN_HEADER) || "";

    // Preflight
    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (!url || !key) {
      console.error("[match_results] Missing Supabase env vars");
      return J(500, { error: "Server misconfiguration" });
    }

    /* ========================================================
       POST → Insert match result rows
       ======================================================== */
    if (method === "POST") {
      let body = {};
      try { body = await req.json(); } catch {}

      const rows = Array.isArray(body.results) ? body.results : [];

      if (!rows.length) {
        return J(400, { error: "No results provided" });
      }

      // Validate minimal fields for each row
      for (const r of rows) {
        const required = [
          "session_id",
          "round_number",
          "court_number",
          "player_id",
          "team",
          "result",
          "elo_before",
          "elo_after",
          "elo_change",
          "opponent_avg_elo"
        ];

        for (const field of required) {
          if (!(field in r)) {
            return J(400, {
              error: `Missing required field: ${field}`,
              row: r
            });
          }
        }

        // Auto-fill timestamp if not provided
        if (!r.created_at) {
          r.created_at = new Date().toISOString();
        }
      }

      // Insert all rows in one go
      const { data, error } = await supabase
        .from("match_results")
        .insert(rows)
        .select();

      if (error) {
        console.error("[match_results/POST] insert error:", error);
        return J(500, { error: error.message });
      }

      return J(200, { ok: true, count: rows.length, rows: data });
    }

    return J(405, { error: "Method not allowed" });

  } catch (err) {
    console.error("[match_results] fatal:", err);
    return J(500, { error: String(err?.message || err) });
  }
};
