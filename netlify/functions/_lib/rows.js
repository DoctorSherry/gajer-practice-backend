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

/** Fuzzy lookup: tries each candidate keyword in priority order (the order
 * you list them), matching a column whose header contains that keyword.
 * This lets a specific, clean column (e.g. "Freq / Week") be preferred over
 * a vaguer, possibly-text one (e.g. "Frequency") by simply listing it first. */
function pickField(obj, candidates) {
  const keys = Object.keys(obj);
  // exact match first, respecting candidate priority order
  for (const c of candidates) {
    const hit = keys.find((k) => k.trim().toLowerCase() === c);
    if (hit !== undefined) return obj[hit];
  }
  // then "header contains keyword", still respecting candidate priority order
  for (const c of candidates) {
    const hit = keys.find((k) => k.trim().toLowerCase().includes(c));
    if (hit !== undefined) return obj[hit];
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
