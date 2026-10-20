const { readRange, appendRow, updateRange } = require("./_lib/sheets");
const { verifyRequest } = require("./_lib/auth");
const { json, errorResponse, corsHeaders } = require("./_lib/rows");
const { parseMDY, formatMDY, todayNY } = require("./_lib/pause");

const PATIENTS_RANGE = process.env.PATIENTS_RANGE || "Patients";

// Reminder contact details live on the patient's own row of the Patients tab, in columns that are
// added the first time they're used:  Patient Email | Next Follow-Up | Contact Updated By
// The daily reminder script reads these; nothing here sends anything.

function colLetter(i) {
  let n = i + 1, s = "";
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

function cleanEmail(v) {
  const s = String(v ?? "").trim();
  if (s === "") return "";
  if (s.length > 200 || !/^[^\s@,;<>()]+@[^\s@,;<>()]+\.[^\s@,;<>()]+$/.test(s)) return null;
  return s.toLowerCase();
}

// "2026-11-05" (date picker) or "11/5/2026" -> "11/5/2026"; "" -> ""; anything else -> null.
// Not more than 30 days back or 2 years ahead (catches typos like year 2062).
function cleanFollowUp(v) {
  const s = String(v ?? "").trim();
  if (s === "") return "";
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  const mdy = m ? `${+m[2]}/${+m[3]}/${+m[1]}` : s;
  const t = parseMDY(mdy);
  if (t === null) return null;
  const today = parseMDY(todayNY());
  const diff = (t - today) / 86400000;
  if (diff < -30 || diff > 730) return null;
  return formatMDY(t);
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders(), body: "" };
  try {
    const doctor = await verifyRequest(event);
    const sheetId = process.env.APP_DATA_SHEET_ID;

    if (event.httpMethod === "GET") {
      const patientId = (event.queryStringParameters || {}).patientId;
      if (!patientId) return json(400, { error: "patientId is required" });
      const rows = await readRange(sheetId, PATIENTS_RANGE);
      const headers = (rows[0] || []).map((h) => (h || "").toString().trim());
      const eIdx = headers.indexOf("Patient Email"), fIdx = headers.indexOf("Next Follow-Up"), qIdx = headers.indexOf("QuoteID");
      const row = rows.find((r, i) => i > 0 && r[0] === patientId && (qIdx === -1 || !r[qIdx]));
      return json(200, {
        patientId,
        email: row && eIdx !== -1 ? (row[eIdx] || "").toString().trim() : "",
        followUp: row && fIdx !== -1 ? (row[fIdx] || "").toString().trim() : "",
      });
    }

    if (event.httpMethod === "POST" || event.httpMethod === "PATCH") {
      const body = JSON.parse(event.body || "{}");
      const patientId = (body.patientId || "").toString().trim();
      if (!patientId) return json(400, { error: "patientId is required" });
      const hasEmail = body.email !== undefined, hasFollow = body.followUp !== undefined;
      if (!hasEmail && !hasFollow) return json(400, { error: "Send an email and/or a followUp date." });
      const email = hasEmail ? cleanEmail(body.email) : undefined;
      const followUp = hasFollow ? cleanFollowUp(body.followUp) : undefined;
      if (email === null) return json(400, { error: "That doesn't look like an email address." });
      if (followUp === null) return json(400, { error: "Pick a real follow-up date (no more than 30 days back or 2 years ahead)." });

      const rows = await readRange(sheetId, PATIENTS_RANGE);
      if (!rows.length) return json(500, { error: `The ${PATIENTS_RANGE} tab has no header row.` });
      const headers = rows[0].map((h) => (h || "").toString().trim());
      const ensure = async (name) => {
        let idx = headers.indexOf(name);
        if (idx === -1) { idx = headers.length; await updateRange(sheetId, `${PATIENTS_RANGE}!${colLetter(idx)}1`, [name]); headers.push(name); }
        return idx;
      };
      const eIdx = hasEmail ? await ensure("Patient Email") : headers.indexOf("Patient Email");
      const fIdx = hasFollow ? await ensure("Next Follow-Up") : headers.indexOf("Next Follow-Up");
      const byIdx = await ensure("Contact Updated By");
      const qIdx = headers.indexOf("QuoteID");
      const marker = `${doctor.name} · ${todayNY()}`;
      let rowIdx = rows.findIndex((r, i) => i > 0 && r[0] === patientId && (qIdx === -1 || !r[qIdx]));

      if (rowIdx === -1) {
        const blank = new Array(headers.length).fill("");
        blank[0] = patientId; blank[1] = doctor.email; blank[2] = new Date().toISOString();
        if (hasEmail) blank[eIdx] = email;
        if (hasFollow) blank[fIdx] = followUp;
        blank[byIdx] = marker;
        await appendRow(sheetId, PATIENTS_RANGE, blank);
      } else {
        const rowNo = rowIdx + 1;
        if (hasEmail) await updateRange(sheetId, `${PATIENTS_RANGE}!${colLetter(eIdx)}${rowNo}`, [email]);
        if (hasFollow) await updateRange(sheetId, `${PATIENTS_RANGE}!${colLetter(fIdx)}${rowNo}`, [followUp]);
        await updateRange(sheetId, `${PATIENTS_RANGE}!${colLetter(byIdx)}${rowNo}`, [marker]);
      }
      return json(200, { patientId, ...(hasEmail ? { email } : {}), ...(hasFollow ? { followUp } : {}) });
    }

    return json(405, { error: "Method not allowed" });
  } catch (err) {
    return errorResponse(err);
  }
};
