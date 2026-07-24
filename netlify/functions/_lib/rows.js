/** Convert raw sheet rows (array of arrays, first row = headers) into objects. */
function rowsToObjects(rows) {
  if (!rows || !rows.length) return [];
  const headers = rows[0].map((h) => (h || "").toString().trim());
  return rows.slice(1).map((r) => {
    const obj = {};
    headers.forEach((h, i) => {
      obj[h] = r[i];
    });
    return obj;
  });
}

/** Case-insensitive lookup across a list of acceptable column-name synonyms. */
function pickField(obj, candidates) {
  for (const k of Object.keys(obj)) {
    if (candidates.includes(k.trim().toLowerCase())) return obj[k];
  }
  return undefined;
}

function toNumber(v) {
  const n = parseFloat(String(v ?? "").replace(/[^0-9.-]/g, ""));
  return isFinite(n) ? n : 0;
}

const CORS_HEADERS = {
  "Content-Type": "application/json",
};

function corsHeaders() {
  return {
    ...CORS_HEADERS,
    "Access-Control-Allow-Origin": process.env.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  };
}

function json(statusCode, data) {
  return { statusCode, headers: corsHeaders(), body: JSON.stringify(data) };
}

function errorResponse(err) {
  const status = err.name === "AuthError" ? 401 : err.statusCode || 500;
  // eslint-disable-next-line no-console
  console.error(err);
  return json(status, { error: err.message || "Internal error" });
}

module.exports = { rowsToObjects, pickField, toNumber, json, errorResponse, corsHeaders };
