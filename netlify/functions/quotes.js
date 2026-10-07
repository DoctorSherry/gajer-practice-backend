const crypto = require("crypto");
const { readRange, appendRow, updateRange } = require("./_lib/sheets");
const { verifyRequest } = require("./_lib/auth");
const { rowsToObjects, json, errorResponse, corsHeaders } = require("./_lib/rows");

const QUOTES_RANGE = process.env.QUOTES_RANGE || "Quotes";       // consultation-only records
const PATIENTS_RANGE = process.env.PATIENTS_RANGE || "Patients"; // purchased records live here too

const TYPE_LABELS = { single: "Single Peptide", plan: "Treatment Plan", customblend: "Custom Blend" };

// Quotes tab header row:
//   QuoteID | PatientID | Type | BlendName | Doctor | Timestamp | LinesJSON | ScheduleJSON | TotalOffice | TotalPatient | Summary
//
// Patients tab header row — PatientID stays in column 1 so the existing
// "create/list patients" columns and the new purchase-detail columns can
// share one tab without colliding:
//   PatientID | CreatedBy | CreatedAt | QuoteID | Type | BlendName | Doctor | Timestamp | LinesJSON | ScheduleJSON | TotalOffice | TotalPatient | Summary
// A plain "patient created" row only fills the first 3 columns. A purchase
// row leaves CreatedBy/CreatedAt blank and fills QuoteID onward — that's
// how we tell the two row types apart when reading them back.
//
// LinesJSON/ScheduleJSON stay as machine-readable JSON — the app needs the
// full detail to redisplay, edit, and total up a quote. "Summary" is a
// separate, plain-English column meant purely for a human glancing at the
// sheet directly, generated fresh on every save.

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders(), body: "" };
  try {
    const doctor = await verifyRequest(event);

    if (event.httpMethod === "GET") {
      const patientId = (event.queryStringParameters || {}).patientId;
      if (!patientId) return json(400, { error: "patientId query param is required" });

      const [quoteRows, patientRows] = await Promise.all([
        readRange(process.env.APP_DATA_SHEET_ID, QUOTES_RANGE),
        readRange(process.env.APP_DATA_SHEET_ID, PATIENTS_RANGE),
      ]);

      const consultations = rowsToObjects(quoteRows)
        .filter((r) => r.PatientID === patientId && r.QuoteID && !r["Removed By"])
        .map((r) => toRecord(r, "consulted"));

      const purchases = rowsToObjects(patientRows)
        .filter((r) => r.PatientID === patientId && r.QuoteID && !r["Removed By"]) // skip the plain "patient created" rows — no QuoteID on those
        .map((r) => toRecord(r, "purchased"));

      const records = [...consultations, ...purchases].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

      return json(200, { records });
    }

    if (event.httpMethod === "POST") {
      const body = JSON.parse(event.body || "{}");
      const { patientId, type, blendName, schedule, lines, totalOffice, totalPatient, status } = body;
      if (!patientId || !type || !Array.isArray(lines)) {
        return json(400, { error: "patientId, type, and lines[] are required" });
      }

      const isPurchased = status === "purchased";
      const record = {
        id: crypto.randomUUID(),
        patientId,
        type,
        blendName: blendName || "",
        doctor: doctor.name, // <-- from verified Google sign-in, never trust client-supplied name
        timestamp: formatNeatTimestamp(new Date()),
        status: isPurchased ? "purchased" : "consulted",
      };

      const summary = buildSummary({ type, blendName, lines, totalPatient });
      const linesJSON = JSON.stringify(lines);
      const scheduleJSON = schedule ? JSON.stringify(schedule) : ""; // blank cell instead of the literal text "null"

      if (isPurchased) {
        await appendRow(process.env.APP_DATA_SHEET_ID, PATIENTS_RANGE, [
          record.patientId, "", "", // PatientID / CreatedBy (n/a) / CreatedAt (n/a) for a purchase row
          record.id, record.type, record.blendName, record.doctor, record.timestamp,
          linesJSON, scheduleJSON,
          Number(totalOffice) || 0, Number(totalPatient) || 0,
          summary,
        ]);
      } else {
        await appendRow(process.env.APP_DATA_SHEET_ID, QUOTES_RANGE, [
          record.id, record.patientId, record.type, record.blendName, record.doctor, record.timestamp,
          linesJSON, scheduleJSON,
          Number(totalOffice) || 0, Number(totalPatient) || 0,
          summary,
        ]);
      }

      return json(201, { ...record, lines, schedule, totalOffice, totalPatient });
    }

    if (event.httpMethod === "PATCH") {
      // Remove a saved quote/plan from a patient's history. The row is kept in the
      // sheet and marked "Removed By" — nothing is erased, it just stops showing in the app.
      const { quoteId, remove } = JSON.parse(event.body || "{}");
      if (!quoteId || !remove) return json(400, { error: "quoteId and remove:true are required" });
      const marker = `${doctor.name} · ${new Date().toLocaleDateString("en-US", { timeZone: "America/New_York" })}`;
      for (const tab of [QUOTES_RANGE, PATIENTS_RANGE]) {
        const rows = await readRange(process.env.APP_DATA_SHEET_ID, tab);
        if (!rows.length) continue;
        const headers = rows[0].map((h) => (h || "").toString().trim());
        const qIdx = headers.indexOf("QuoteID");
        if (qIdx === -1) continue;
        const rowIdx = rows.findIndex((r, i) => i > 0 && r[qIdx] === quoteId);
        if (rowIdx === -1) continue;
        const rIdx = headers.indexOf("Removed By");
        if (rIdx === -1) return json(500, { error: `The ${tab} tab needs a "Removed By" column header in its first row.` });
        await updateRange(process.env.APP_DATA_SHEET_ID, `${tab}!${colLetter(rIdx)}${rowIdx + 1}`, [marker]);
        return json(200, { quoteId, removed: true });
      }
      return json(404, { error: "No saved record found with that ID" });
    }

    return json(405, { error: "Method not allowed" });
  } catch (err) {
    return errorResponse(err);
  }
};

/** Builds a plain-English, one-line-per-item summary for a human reading the raw sheet. */
function buildSummary({ type, blendName, lines, totalPatient }) {
  const label = TYPE_LABELS[type] || type;
  const items = (lines || [])
    .map((l) => {
      const dose = l.config ? `${l.config.doseMg}mg × ${l.config.freqPerWeek}/wk × ${l.config.durationWeeks}wk` : "";
      const product = l.vendor ? `${l.vendor.format} ${l.vendor.strengthMg}mg` : "";
      const price = l.patientCost != null ? `$${Math.round(l.patientCost)}` : "";
      return [l.name, dose, product, price].filter(Boolean).join(" — ");
    })
    .join("; ");
  const total = totalPatient != null ? ` | Total: $${Math.round(totalPatient)}` : "";
  const name = type === "customblend" && blendName ? ` "${blendName}"` : "";
  return `${label}${name}: ${items}${total}`;
}

function formatNeatTimestamp(date) {
  // e.g. "Jul 30, 2026, 6:16 PM" — readable in the sheet, and still parses
  // correctly and sorts correctly via new Date(), which the app relies on.
  // Explicit timeZone matters: Netlify's servers run in UTC, so without this
  // every timestamp would show UTC time instead of the practice's actual time.
  return date.toLocaleString("en-US", {
    year: "numeric", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
    timeZone: "America/New_York",
  });
}

function toRecord(r, status) {
  return {
    id: r.QuoteID,
    patientId: r.PatientID,
    type: r.Type,
    blendName: r.BlendName || undefined,
    doctor: r.Doctor,
    timestamp: r.Timestamp,
    lines: safeParse(r.LinesJSON, []),
    schedule: safeParse(r.ScheduleJSON, undefined),
    totalOffice: Number(r.TotalOffice) || 0,
    totalPatient: Number(r.TotalPatient) || 0,
    status,
  };
}

function safeParse(str, fallback) {
  try {
    return str ? JSON.parse(str) : fallback;
  } catch {
    return fallback;
  }
}

/** 0 -> A, 25 -> Z, 26 -> AA */
function colLetter(i) {
  let n = i + 1, s = "";
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}
