const { readRange, appendRow, updateRange } = require("./_lib/sheets");
const { verifyRequest } = require("./_lib/auth");
const { json, errorResponse, corsHeaders } = require("./_lib/rows");
const { PAUSE_LIMIT_DAYS, todayNY, daysBetween } = require("./_lib/pause");
const { shiftPatientShipments } = require("./orders");

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

async function ensureColumn(sheetId, headers, name) {
  let idx = headers.indexOf(name);
  if (idx === -1) {
    idx = headers.length;
    await updateRange(sheetId, `${PATIENTS_RANGE}!${colLetter(idx)}1`, [name]);
    headers.push(name);
  }
  return idx;
}

// Pause stops shipments and billing until someone restarts it (never automatic). The first 60 days are the
// allowed pause; past that the app warns, but nothing restarts on its own.
async function handlePause(action, patientId, doctor, sheetId) {
  const rows = await readRange(sheetId, PATIENTS_RANGE);
  if (!rows.length) return json(500, { error: `The ${PATIENTS_RANGE} tab has no header row.` });
  const headers = rows[0].map((h) => (h || "").toString().trim());
  const tierIdx = headers.indexOf("Tier");
  const pauseIdx0 = headers.indexOf("Paused Since");
  const qIdx = headers.indexOf("QuoteID");
  const rowIdx = rows.findIndex((r, i) => i > 0 && r[0] === patientId && (qIdx === -1 || !r[qIdx]));
  const row = rowIdx === -1 ? null : rows[rowIdx];
  const tier = row && tierIdx !== -1 ? parseTier(row[tierIdx]) : 0;
  const pausedSince = row && pauseIdx0 !== -1 ? (row[pauseIdx0] || "").toString().trim() : "";
  const today = todayNY();
  const who = `${doctor.name}`;

  if (action === "pause") {
    if (tier < 1) return json(400, { error: "This patient has no membership to pause." });
    if (pausedSince) return json(409, { error: `Already paused since ${pausedSince}.` });
    const pauseIdx = await ensureColumn(sheetId, headers, "Paused Since");
    const byIdx = await ensureColumn(sheetId, headers, "Paused By");
    const rowNo = rowIdx + 1;
    await updateRange(sheetId, `${PATIENTS_RANGE}!${colLetter(pauseIdx)}${rowNo}`, [today]);
    await updateRange(sheetId, `${PATIENTS_RANGE}!${colLetter(byIdx)}${rowNo}`, [`${who} · ${today}`]);
    return json(200, { patientId, pausedSince: today, pausedDays: 0, pauseLimitDays: PAUSE_LIMIT_DAYS });
  }

  // resume
  if (!pausedSince) return json(409, { error: "This membership isn't paused." });
  const rowNo = rowIdx + 1;
  // Clear the pause first: if moving a shipment date fails afterwards, nothing gets moved twice on a retry,
  // and the message below tells staff which ones to move by hand.
  await updateRange(sheetId, `${PATIENTS_RANGE}!${colLetter(pauseIdx0)}${rowNo}`, [""]);
  const byIdx = headers.indexOf("Paused By");
  if (byIdx !== -1) await updateRange(sheetId, `${PATIENTS_RANGE}!${colLetter(byIdx)}${rowNo}`, [`Restarted by ${who} · ${today}`]);
  const result = await shiftPatientShipments(sheetId, patientId, pausedSince, who);
  return json(200, { patientId, pausedSince: "", pausedDays: 0, pausedForDays: result.days, shipmentsMoved: result.shifted, shipmentsNotMoved: result.failed, pauseLimitDays: PAUSE_LIMIT_DAYS });
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
      const pauseIdx = headers.indexOf("Paused Since");
      const qIdx = headers.indexOf("QuoteID");
      const tiers = {};
      const paused = {};
      rows.slice(1).forEach((r) => {
        if (!r[0] || (qIdx !== -1 && r[qIdx])) return; // only the patient's own row carries the tier
        if (tierIdx !== -1) tiers[r[0]] = parseTier(r[tierIdx]);
        const ps = pauseIdx !== -1 ? (r[pauseIdx] || "").toString().trim() : "";
        if (ps) paused[r[0]] = ps; else delete paused[r[0]];
      });
      const today = todayNY();
      const pauseInfo = (id) => (paused[id] ? { pausedSince: paused[id], pausedDays: daysBetween(paused[id], today), pauseLimitDays: PAUSE_LIMIT_DAYS } : { pausedSince: "", pausedDays: 0, pauseLimitDays: PAUSE_LIMIT_DAYS });
      if (patientId) return json(200, { patientId, tier: tiers[patientId] || 0, ...pauseInfo(patientId) });
      return json(200, { tiers, paused });
    }

    if (event.httpMethod === "POST" || event.httpMethod === "PATCH") {
      const body = JSON.parse(event.body || "{}");
      const patientId = (body.patientId || "").toString().trim();
      // Only a real number (or a numeric string) counts — null, "", true and [] must not be read as 0
      // and quietly wipe out someone's membership.
      const raw = body.tier;
      const tierNum = typeof raw === "number" ? raw : (typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN);
      if (!patientId) return json(400, { error: "patientId is required" });
      if (body.action === "pause" || body.action === "resume") return handlePause(body.action, patientId, doctor, sheetId);
      if (!Number.isInteger(tierNum) || tierNum < 0 || tierNum > 3) return json(400, { error: "tier must be 0, 1, 2 or 3" });

      const rows = await readRange(sheetId, PATIENTS_RANGE);
      if (!rows.length) return json(500, { error: `The ${PATIENTS_RANGE} tab has no header row.` });
      const headers = rows[0].map((h) => (h || "").toString().trim());
      {
        // A paused membership keeps its tier until it's restarted — changing it mid-pause would muddy the restart.
        const pi = headers.indexOf("Paused Since"), qi = headers.indexOf("QuoteID");
        const row = rows.find((r, i) => i > 0 && r[0] === patientId && (qi === -1 || !r[qi]));
        if (pi !== -1 && row && (row[pi] || "").toString().trim()) return json(409, { error: "This membership is paused. Restart it before changing the tier." });
      }

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
