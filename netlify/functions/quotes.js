const crypto = require("crypto");
const { readRange, appendRow } = require("./_lib/sheets");
const { verifyRequest } = require("./_lib/auth");
const { rowsToObjects, json, errorResponse, corsHeaders } = require("./_lib/rows");

const RANGE = process.env.QUOTES_RANGE || "Quotes";
// Column order written to the sheet — keep in sync with the header row you create.
const COLUMNS = [
  "QuoteID", "PatientID", "Type", "BlendName", "Doctor", "Timestamp",
  "LinesJSON", "ScheduleJSON", "TotalOffice", "TotalPatient",
];

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders(), body: "" };
  try {
    const doctor = await verifyRequest(event);

    if (event.httpMethod === "GET") {
      const patientId = (event.queryStringParameters || {}).patientId;
      if (!patientId) return json(400, { error: "patientId query param is required" });

      const rows = await readRange(process.env.APP_DATA_SHEET_ID, RANGE);
      const records = rowsToObjects(rows)
        .filter((r) => r.PatientID === patientId)
        .map((r) => ({
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
        }))
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)); // newest first

      return json(200, { records });
    }

    if (event.httpMethod === "POST") {
      const body = JSON.parse(event.body || "{}");
      const { patientId, type, blendName, schedule, lines, totalOffice, totalPatient } = body;
      if (!patientId || !type || !Array.isArray(lines)) {
        return json(400, { error: "patientId, type, and lines[] are required" });
      }

      const record = {
        id: crypto.randomUUID(),
        patientId,
        type,
        blendName: blendName || "",
        doctor: doctor.name, // <-- from verified Google sign-in, never trust client-supplied name
        timestamp: new Date().toISOString(),
      };

      await appendRow(process.env.APP_DATA_SHEET_ID, RANGE, [
        record.id,
        record.patientId,
        record.type,
        record.blendName,
        record.doctor,
        record.timestamp,
        JSON.stringify(lines),
        JSON.stringify(schedule || null),
        Number(totalOffice) || 0,
        Number(totalPatient) || 0,
      ]);

      return json(201, { ...record, lines, schedule, totalOffice, totalPatient });
    }

    return json(405, { error: "Method not allowed" });
  } catch (err) {
    return errorResponse(err);
  }
};

function safeParse(str, fallback) {
  try {
    return str ? JSON.parse(str) : fallback;
  } catch {
    return fallback;
  }
}
