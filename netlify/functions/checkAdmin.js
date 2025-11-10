// netlify/functions/checkAdmin.js

// This function verifies an admin password on the server side.
// 1. Set ADMIN_PASSWORD in Netlify -> Site configuration -> Environment variables
// 2. Frontend calls POST /.netlify/functions/checkAdmin with { password: "..." }

exports.handler = async function (event) {
    // Only allow POST
    if (event.httpMethod !== "POST") {
      return {
        statusCode: 405,
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ok: false, error: "Method not allowed" }),
      };
    }
  
    try {
      const body = JSON.parse(event.body || "{}");
      const incoming = String(body.password || "").trim();
  
      // read from env var first, otherwise fall back to your hardcoded default
      const SECRET = (process.env.ADMIN_PASSWORD || "flomintonsys").trim();
  
      const isMatch = incoming === SECRET;
  
      return {
        statusCode: isMatch ? 200 : 401,
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          ok: isMatch,
        }),
      };
    } catch (err) {
      console.error("checkAdmin error", err);
      return {
        statusCode: 500,
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ok: false, error: "Server error" }),
      };
    }
  };
  