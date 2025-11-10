// netlify/functions/checkAdmin.js
exports.handler = async function(event) {
    if (event.httpMethod !== "POST") {
      return { statusCode: 405, body: "Method not allowed" };
    }
    const body = JSON.parse(event.body || "{}");
    const pwd = String(body.password || "");
    const ADMIN = process.env.ADMIN_PASSWORD || "flomintonsys"; // set in Netlify -> Site settings -> Build & deploy -> Environment
    if (pwd.trim() === ADMIN) {
      return {
        statusCode: 200,
        body: JSON.stringify({ ok: true })
      };
    } else {
      return {
        statusCode: 401,
        body: JSON.stringify({ ok: false })
      };
    }
  };
  