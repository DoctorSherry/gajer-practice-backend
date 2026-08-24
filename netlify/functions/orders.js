const crypto = require("crypto");
const { readRange, appendRows, updateRange } = require("./_lib/sheets");
const { verifyRequest } = require("./_lib/auth");
const { rowsToObjects, json, errorResponse, corsHeaders } = require("./_lib/rows");

const ORDERS_RANGE = process.env.ORDERS_RANGE || "Orders";

// Orders tab header row (one row per peptide, shared across the whole team):
//   Status | Date | Patient | Peptide | Dose | Frequency | Duration | Units | Patient Price |
//   Type | Payment Status | Payment Date | Collection Method | Ordered | Instructions Sent | Notes | Doctor | LineID | VisitID
const COLUMNS = [
  "Status", "Date", "Patient", "Peptide", "Dose", "Frequency", "Duration", "Units",
  "Patient Price", "Type", "Payment Status", "Payment Date",
  "Collection Method", "Ordered", "Instructions Sent", "Notes", "Doctor", "LineID", "VisitID",
];

/** Turns Type/Payment/Ordered/Instructions into one glance-able status word —
 * this is what shows in the sheet's Status column, and what the app's Orders
 * tab groups by. Recomputed on every write so it's never allowed to go stale. */
function computeStatus({ type, paymentStatus, ordered, instructionsSent }) {
  if (type !== "purchase") return "Consultation Only";
  if (paymentStatus !== "paid") return "Missing Payment";
  if (ordered !== "Y") return "Not Yet Ordered";
  if (instructionsSent !== "Y") return "Awaiting Instructions";
  return "Completed";
}

function rowFromFields(f) {
  const status = computeStatus(f);
  return [
    status, f.date, f.patient, f.peptide, f.dose, f.frequency, f.duration, f.units,
    f.patientPrice, f.type, f.paymentStatus || "", f.paymentDate || "",
    f.collectionMethod || "", f.ordered || "N", f.instructionsSent || "N", f.notes || "",
    f.doctor, f.lineId, f.visitId,
  ];
}

function fieldsFromRow(r) {
  return {
    status: r.Status, date: r.Date, patient: r.Patient, peptide: r.Peptide,
    dose: r.Dose, frequency: r.Frequency, duration: r.Duration, units: r.Units,
    patientPrice: Number(r["Patient Price"]) || 0,
    type: r.Type, paymentStatus: r["Payment Status"], paymentDate: r["Payment Date"],
    collectionMethod: r["Collection Method"], ordered: r.Ordered, instructionsSent: r["Instructions Sent"],
    notes: r.Notes, doctor: r.Doctor, lineId: r.LineID, visitId: r.VisitID,
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders(), body: "" };
  try {
    const doctor = await verifyRequest(event);

    if (event.httpMethod === "GET") {
      const patientId = (event.queryStringParameters || {}).patientId;
      const rows = await readRange(process.env.APP_DATA_SHEET_ID, ORDERS_RANGE);
      let orders = rowsToObjects(rows).filter((r) => r.LineID).map(fieldsFromRow);
      if (patientId) orders = orders.filter((o) => o.patient === patientId);
      orders.sort((a, b) => new Date(b.date) - new Date(a.date));
      return json(200, { orders });
    }

    if (event.httpMethod === "POST") {
      const body = JSON.parse(event.body || "{}");
      const { patientId, type, blendName, lines } = body;
      if (!patientId || !type || !Array.isArray(lines) || !lines.length) {
        return json(400, { error: "patientId, type, and lines[] are required" });
      }
      const isPurchase = type === "purchase";
      const visitId = crypto.randomUUID();
      const date = new Date().toLocaleDateString("en-US", { timeZone: "America/New_York" });

      const rows = lines.map((l) =>
        rowFromFields({
          date, patient: patientId, doctor: doctor.name, visitId,
          peptide: `${l.name} \\ ${l.vendor?.format || ""} \\ ${l.vendor?.strengthMg ? l.vendor.strengthMg + "mg" : l.vendor?.rawStrength || ""}${blendName ? ` (blend: ${blendName})` : ""}`,
          dose: l.config ? `${l.config.doseMg}${l.doseUnit || "mg"}` : "",
          frequency: l.config ? l.config.freqPerWeek : "",
          duration: l.config ? l.config.durationWeeks : "",
          units: l.unitsNeeded, patientPrice: l.patientCost,
          type: isPurchase ? "purchase" : "consultation",
          paymentStatus: isPurchase ? "pending" : "",
          ordered: "N", instructionsSent: "N",
          lineId: crypto.randomUUID(),
        })
      );

      await appendRows(process.env.APP_DATA_SHEET_ID, ORDERS_RANGE, rows);
      return json(201, { visitId, count: rows.length });
    }

    if (event.httpMethod === "PATCH") {
      const body = JSON.parse(event.body || "{}");
      const { lineId, paymentStatus, paymentDate, collectionMethod, ordered, instructionsSent, notes, type } = body;
      if (!lineId) return json(400, { error: "lineId is required" });

      const rawRows = await readRange(process.env.APP_DATA_SHEET_ID, ORDERS_RANGE);
      const objects = rowsToObjects(rawRows);
      const rowIndex = objects.findIndex((r) => r.LineID === lineId);
      if (rowIndex === -1) return json(404, { error: "No order found with that LineID" });

      const existing = fieldsFromRow(objects[rowIndex]);
      const updated = {
        ...existing,
        ...(type !== undefined ? { type } : {}),
        ...(paymentStatus !== undefined ? { paymentStatus } : {}),
        ...(paymentDate !== undefined ? { paymentDate } : {}),
        ...(collectionMethod !== undefined ? { collectionMethod } : {}),
        ...(ordered !== undefined ? { ordered } : {}),
        ...(instructionsSent !== undefined ? { instructionsSent } : {}),
        ...(notes !== undefined ? { notes } : {}),
      };

      const sheetRowNumber = rowIndex + 2; // +1 for header row, +1 for 1-based indexing
      const lastCol = String.fromCharCode(65 + COLUMNS.length - 1); // e.g. "U" for 21 columns
      await updateRange(process.env.APP_DATA_SHEET_ID, `${ORDERS_RANGE}!A${sheetRowNumber}:${lastCol}${sheetRowNumber}`, rowFromFields(updated));

      return json(200, { lineId, status: computeStatus(updated) });
    }

    return json(405, { error: "Method not allowed" });
  } catch (err) {
    return errorResponse(err);
  }
};
