const { readRange, appendRow, updateRange } = require("./_lib/sheets");
const { verifyRequest } = require("./_lib/auth");
const { json, errorResponse, corsHeaders } = require("./_lib/rows");

const PATIENTS_RANGE = process.env.PATIENTS_RANGE || "Patients";

// Membership tier lives on the patient's own "patient created" row in the
// Patients tab (the row with no QuoteID), in two extra columns at the end:
//   Tier (0-3)  |  Tier Set By ("Name · date")
// The columns are added automatically the first time a tier is set, so there
// is nothing to prepare in the sheet. 0 = no membership.

function colLetter(i) {
  let n = i + 1, s = "";
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

function parseTier(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 3 ? n : 0;
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders(), body: "" };
  try {
    const doctor = await verifyRequest(event);
    const sheetId = process.env.APP_DATA_SHEET_ID;

    if (event.httpMethod === "GET") {
      const patientId = (event.queryStringParameters || {}).patientId;
      const rows = await readRange(sheetId, PATIENTS_RANGE);
      const headers = (rows[0] || []).map((h) => (h || "").toString().trim());
      const tierIdx = headers.indexOf("Tier");
      const qIdx = headers.indexOf("QuoteID");
      const tiers = {};
      if (tierIdx !== -1) {
        rows.slice(1).forEach((r) => {
          if (!r[0] || (qIdx !== -1 && r[qIdx])) return; // only the patient's own row carries the tier
          tiers[r[0]] = parseTier(r[tierIdx]);
        });
      }
      if (patientId) return json(200, { patientId, tier: tiers[patientId] || 0 });
      return json(200, { tiers });
    }

    if (event.httpMethod === "POST" || event.httpMethod === "PATCH") {
      const body = JSON.parse(event.body || "{}");
      const patientId = (body.patientId || "").toString().trim();
      // Only a real number (or a numeric string) counts — null, "", true and [] must not be read as 0
      // and quietly wipe out someone's membership.
      const raw = body.tier;
      const tierNum = typeof raw === "number" ? raw : (typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN);
      if (!patientId) return json(400, { error: "patientId is required" });
      if (!Number.isInteger(tierNum) || tierNum < 0 || tierNum > 3) return json(400, { error: "tier must be 0, 1, 2 or 3" });

      const rows = await readRange(sheetId, PATIENTS_RANGE);
      if (!rows.length) return json(500, { error: `The ${PATIENTS_RANGE} tab has no header row.` });
      const headers = rows[0].map((h) => (h || "").toString().trim());

      // Add the two columns on first use (right after the last header).
      let tierIdx = headers.indexOf("Tier");
      if (tierIdx === -1) {
        tierIdx = headers.length;
        await updateRange(sheetId, `${PATIENTS_RANGE}!${colLetter(tierIdx)}1`, ["Tier"]);
        headers.push("Tier");
      }
      let byIdx = headers.indexOf("Tier Set By");
      if (byIdx === -1) {
        byIdx = headers.length;
        await updateRange(sheetId, `${PATIENTS_RANGE}!${colLetter(byIdx)}1`, ["Tier Set By"]);
        headers.push("Tier Set By");
      }

      const qIdx = headers.indexOf("QuoteID");
      const marker = `${doctor.name} · ${new Date().toLocaleDateString("en-US", { timeZone: "America/New_York" })}`;
      const rowIdx = rows.findIndex((r, i) => i > 0 && r[0] === patientId && (qIdx === -1 || !r[qIdx]));

      if (rowIdx === -1) {
        // Patient has records but no "created" row (older data) — make one so the tier has a home.
        const blank = new Array(headers.length).fill("");
        blank[0] = patientId; blank[1] = doctor.email; blank[2] = new Date().toISOString();
        blank[tierIdx] = tierNum; blank[byIdx] = marker;
        await appendRow(sheetId, PATIENTS_RANGE, blank);
      } else {
        const rowNo = rowIdx + 1; // rows[] is 0-based and includes the header row
        await updateRange(sheetId, `${PATIENTS_RANGE}!${colLetter(tierIdx)}${rowNo}`, [tierNum]);
        await updateRange(sheetId, `${PATIENTS_RANGE}!${colLetter(byIdx)}${rowNo}`, [marker]);
      }
      return json(200, { patientId, tier: tierNum, setBy: marker });
    }

    return json(405, { error: "Method not allowed" });
  } catch (err) {
    return errorResponse(err);
  }
};
