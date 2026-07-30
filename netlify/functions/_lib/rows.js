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

/**
 * Parses a vendor "strength" cell into one total-mg number for that product.
 * Handles combo products written like "10mg/10mg, 3mL" (two peptides in one
 * pen) by adding up every "<number>mg" amount found — 10 + 10 = 20 — while
 * correctly ignoring volume figures like "3mL" (different unit, not summed).
 * A plain cell like "10" or "10mg" still just returns 10, same as before.
 */
function parseStrengthMg(v) {
  const str = String(v ?? "");
  const mgMatches = [...str.matchAll(/(\d+(?:\.\d+)?)\s*mg/gi)];
  if (mgMatches.length) {
    return mgMatches.reduce((sum, m) => sum + parseFloat(m[1]), 0);
  }
  return toNumber(str);
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

module.exports = { rowsToObjects, pickField, toNumber, parseStrengthMg, json, errorResponse, corsHeaders };
