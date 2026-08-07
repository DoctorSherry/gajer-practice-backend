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
/**
 * Parses a vendor "strength" cell into a total-mg number for that product,
 * correctly distinguishing units:
 *   - "500mcg" -> 0.5 (mg) — NOT 500. mcg and mg are 1000x apart; treating
 *     them the same silently makes every IU/mcg dose 1000x wrong.
 *   - "10mg/10mg, 3mL" -> 20 (combo products, summed, volume ignored)
 *   - "1mg/25mcg/20mg" -> 21.025 (mixed mg+mcg in one combo, both converted
 *     to mg and summed)
 *   - "50 IU" -> flagged unitRecognized:false — IU is a potency unit, not a
 *     weight, and can't be converted to mg. strengthMg is returned as 0 so
 *     it's never silently used in mg-based math; the frontend prompts the
 *     doctor to enter that product's dose manually instead.
 */
function parseStrengthInfo(v) {
  const str = String(v ?? "");
  const mgMatches = [...str.matchAll(/(\d+(?:\.\d+)?)\s*mg\b/gi)];
  const mcgMatches = [...str.matchAll(/(\d+(?:\.\d+)?)\s*mcg\b/gi)];
  if (mgMatches.length || mcgMatches.length) {
    const mgSum = mgMatches.reduce((sum, m) => sum + parseFloat(m[1]), 0);
    const mcgSum = mcgMatches.reduce((sum, m) => sum + parseFloat(m[1]), 0) / 1000;
    return { strengthMg: mgSum + mcgSum, unitRecognized: true };
  }
  if (/\d+(?:\.\d+)?\s*iu\b/i.test(str)) {
    const iuMatch = str.match(/(\d+(?:\.\d+)?)\s*iu\b/i);
    return { strengthMg: 0, unitRecognized: false, rawStrength: str.trim(), rawUnitValue: parseFloat(iuMatch[1]) };
  }
  return { strengthMg: toNumber(str), unitRecognized: true };
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

module.exports = { rowsToObjects, pickField, toNumber, parseStrengthInfo, json, errorResponse, corsHeaders };
