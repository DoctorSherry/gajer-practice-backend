const crypto = require("crypto");
const { readRange, appendRows, updateRange } = require("./_lib/sheets");
const { verifyRequest } = require("./_lib/auth");
const { rowsToObjects, json, errorResponse, corsHeaders } = require("./_lib/rows");

const ORDERS_RANGE = process.env.ORDERS_RANGE || "Orders";

// Orders tab header row (one row per peptide, shared across the whole team):
//   Status | Date | Patient | Peptide | Dose | Frequency | Duration | Units | Patient Price |
//   Type | Payment Status | Payment Date | Collection Method | Ordered | Instructions Sent | Notes | Doctor | LineID | VisitID |
//   Is Membership | Supply Interval Days | Total Shipments | Shipments Sent | Next Ship Due | Last Shipment By | Removed By
// The last 6 columns are new — add them to your existing Orders tab header row
// (don't reorder the earlier ones; existing rows already match those positions).
const COLUMNS = [
  "Status", "Date", "Patient", "Peptide", "Dose", "Frequency", "Duration", "Units",
  "Patient Price", "Type", "Payment Status", "Payment Date",
  "Collection Method", "Ordered", "Instructions Sent", "Notes", "Doctor", "LineID", "VisitID",
  "Is Membership", "Supply Interval Days", "Total Shipments", "Shipments Sent", "Next Ship Due", "Last Shipment By",
  "Removed By",
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

/** For membership/recurring-supply orders: where this order stands in its
 * shipment schedule. Returns null for non-membership orders (nothing to show). */
function computeShipmentStatus(f, todayStr) {
  if (f.isMembership !== "Y") return null;
  const total = Number(f.totalShipments) || 0;
  const sent = Number(f.shipmentsSent) || 0;
  if (total > 0 && sent >= total) return "Membership Complete";
  if (!f.nextShipDue) return "Scheduled";
  const due = new Date(f.nextShipDue);
  const today = new Date(todayStr || new Date().toLocaleDateString("en-US", { timeZone: "America/New_York" }));
  const diffDays = Math.round((due - today) / 86400000);
  if (diffDays < 0) return "Overdue";
  if (diffDays === 0) return "Due Today";
  if (diffDays <= 3) return "Due Soon";
  return "Scheduled";
}


/** "10% off" / "$25.00 off" — shown in Notes so whoever collects payment knows why the price is lower. */
function discountNote(d) {
  if (!d || !d.type || d.type === "none") return "";
  const v = Number(d.value) || 0;
  if (v <= 0) return "";
  return d.type === "percent" ? `Discount applied: ${v}% off` : `Discount applied: $${v.toFixed(2)} off`;
}

/** Membership tier wording for Notes — says why a line costs $0 or less, so whoever collects payment isn't confused. */
function tierNote(l) {
  const t = Number(l && l.tier);
  if (!t || t < 1 || t > 3) return "";
  if (l.covered) return `Tier ${t} membership: covered`;
  return `Tier ${t} membership: 10% off`;
}

/** Joins the non-empty note parts with " · " */
function joinNotes(...parts) {
  return parts.filter(Boolean).join(" · ");
}

/** "2026-11-05" (from a date picker) or "11/5/2026" -> "11/5/2026", or null if it isn't a real date within a year. */
function parseShipDate(input) {
  const s = String(input || "").trim();
  let y, m, d;
  let hit = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (hit) { y = +hit[1]; m = +hit[2]; d = +hit[3]; }
  else {
    hit = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!hit) return null;
    m = +hit[1]; d = +hit[2]; y = +hit[3];
  }
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null; // e.g. Feb 31
  const diffDays = (dt.getTime() - Date.now()) / 86400000;
  if (diffDays < -2 || diffDays > 366) return null; // not in the past, not more than a year out
  return `${m}/${d}/${y}`;
}

/** Whole number >= 1; anything else keeps the old value (guards typos like 0 or -3). */
function clampPositiveInt(value, fallback) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n >= 1 ? n : fallback;
}

function rowFromFields(f) {
  const status = computeStatus(f);
  return [
    status, f.date, f.patient, f.peptide, f.dose, f.frequency, f.duration, f.units,
    f.patientPrice, f.type, f.paymentStatus || "", f.paymentDate || "",
    f.collectionMethod || "", f.ordered || "N", f.instructionsSent || "N", f.notes || "",
    f.doctor, f.lineId, f.visitId,
    f.isMembership || "N", f.supplyIntervalDays || "", f.totalShipments || "", f.shipmentsSent || 0, f.nextShipDue || "",
    f.lastShipmentBy || "",
    f.removedBy || "",
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
    isMembership: r["Is Membership"] || "N",
    supplyIntervalDays: Number(r["Supply Interval Days"]) || 0,
    totalShipments: Number(r["Total Shipments"]) || 0,
    shipmentsSent: Number(r["Shipments Sent"]) || 0,
    nextShipDue: r["Next Ship Due"] || "",
    lastShipmentBy: r["Last Shipment By"] || "",
    removedBy: r["Removed By"] || "",
  };
}

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders(), body: "" };
  try {
    const doctor = await verifyRequest(event);

    if (event.httpMethod === "GET") {
      const patientId = (event.queryStringParameters || {}).patientId;
      const rows = await readRange(process.env.APP_DATA_SHEET_ID, ORDERS_RANGE);
      let orders = rowsToObjects(rows).filter((r) => r.LineID).map(fieldsFromRow).filter((o) => !o.removedBy); // removed rows stay in the sheet, marked, but never show in the app
      if (patientId) orders = orders.filter((o) => o.patient === patientId);
      const today = new Date().toLocaleDateString("en-US", { timeZone: "America/New_York" });
      orders = orders.map((o) => ({ ...o, shipmentStatus: computeShipmentStatus(o, today) }));
      orders.sort((a, b) => new Date(b.date) - new Date(a.date));
      return json(200, { orders });
    }

    if (event.httpMethod === "POST") {
      const body = JSON.parse(event.body || "{}");
      const { patientId, type, blendName, lines, quoteId } = body;
      if (!patientId || !type || !Array.isArray(lines) || !lines.length) {
        return json(400, { error: "patientId, type, and lines[] are required" });
      }
      const isPurchase = type === "purchase";
      // When the saved quote's ID is passed in, reuse it as the VisitID so removing that
      // quote later can also remove the orders made with it.
      const visitId = typeof quoteId === "string" && quoteId.length > 0 && quoteId.length <= 100 ? quoteId : crypto.randomUUID();
      const date = new Date().toLocaleDateString("en-US", { timeZone: "America/New_York" });

      const rows = lines.map((l) => {
        const isMembership = l.isMembership ? "Y" : "N";
        const coveredPurchase = isPurchase && l.covered === true;
        return rowFromFields({
          date, patient: patientId, doctor: doctor.name, visitId,
          peptide: `${l.name} \\ ${l.vendor?.format || ""} \\ ${l.vendor?.strengthMg ? l.vendor.strengthMg + "mg" : l.vendor?.rawStrength || ""}${blendName ? ` (blend: ${blendName})` : ""}`,
          dose: l.config ? `${l.config.doseMg}${l.doseUnit || "mg"}` : "",
          frequency: l.config ? l.config.freqPerWeek : "",
          duration: l.config ? l.config.durationWeeks : "",
          units: l.unitsNeeded, patientPrice: l.patientCost,
          type: isPurchase ? "purchase" : "consultation",
          // A line the membership fully covers has nothing to collect, so it starts as paid
          // (method "Membership") instead of sitting in "Missing Payment".
          paymentStatus: isPurchase ? (coveredPurchase ? "paid" : "pending") : "",
          paymentDate: coveredPurchase ? date : "",
          collectionMethod: coveredPurchase ? "Membership" : "",
          ordered: "N", instructionsSent: "N",
          lineId: crypto.randomUUID(),
          notes: joinNotes(tierNote(l), discountNote(l.discount)),
          isMembership,
          supplyIntervalDays: isMembership === "Y" ? (l.supplyIntervalDays || 30) : "",
          totalShipments: isMembership === "Y" ? (l.totalShipments || 1) : "",
          shipmentsSent: 0,
          // First shipment is due the day the course starts — staff mark it
          // sent once it actually goes out, which schedules the next one.
          nextShipDue: isMembership === "Y" ? date : "",
        });
      });

      await appendRows(process.env.APP_DATA_SHEET_ID, ORDERS_RANGE, rows);
      return json(201, { visitId, count: rows.length });
    }

    if (event.httpMethod === "PATCH") {
      const body = JSON.parse(event.body || "{}");
      const { lineId, paymentStatus, paymentDate, collectionMethod, ordered, instructionsSent, notes, type, markShipmentSent, totalShipments, supplyIntervalDays, remove, visitId: removeVisitId, pushNextShipTo } = body;

      // Remove every order made from one saved quote (used when a plan is removed from history).
      if (remove && removeVisitId && !lineId) {
        const marker = `${doctor.name} · ${new Date().toLocaleDateString("en-US", { timeZone: "America/New_York" })}`;
        const allRows = await readRange(process.env.APP_DATA_SHEET_ID, ORDERS_RANGE);
        const objs = rowsToObjects(allRows);
        let removed = 0;
        for (let i = 0; i < objs.length; i++) {
          if (objs[i].VisitID === removeVisitId && !objs[i]["Removed By"]) {
            const f = { ...fieldsFromRow(objs[i]), removedBy: marker };
            const rowNo = i + 2;
            const lastC = String.fromCharCode(65 + COLUMNS.length - 1);
            await updateRange(process.env.APP_DATA_SHEET_ID, `${ORDERS_RANGE}!A${rowNo}:${lastC}${rowNo}`, rowFromFields(f));
            removed++;
          }
        }
        return json(200, { visitId: removeVisitId, removed });
      }

      if (!lineId) return json(400, { error: "lineId is required" });

      const rawRows = await readRange(process.env.APP_DATA_SHEET_ID, ORDERS_RANGE);
      const objects = rowsToObjects(rawRows);
      const rowIndex = objects.findIndex((r) => r.LineID === lineId);
      if (rowIndex === -1) return json(404, { error: "No order found with that LineID" });

      const existing = fieldsFromRow(objects[rowIndex]);
      let updated = {
        ...existing,
        ...(type !== undefined ? { type } : {}),
        ...(paymentStatus !== undefined ? { paymentStatus } : {}),
        ...(paymentDate !== undefined ? { paymentDate } : {}),
        ...(collectionMethod !== undefined ? { collectionMethod } : {}),
        ...(ordered !== undefined ? { ordered } : {}),
        ...(instructionsSent !== undefined ? { instructionsSent } : {}),
        ...(notes !== undefined ? { notes } : {}),
        // Fixing a typo'd shipment count/interval after the fact — doesn't
        // touch shipmentsSent or the already-scheduled next due date.
        ...(totalShipments !== undefined ? { totalShipments: clampPositiveInt(totalShipments, existing.totalShipments) } : {}),
        ...(supplyIntervalDays !== undefined ? { supplyIntervalDays: clampPositiveInt(supplyIntervalDays, existing.supplyIntervalDays) } : {}),
      };

      // If a typo'd total was raised after the course already finished, the
      // order is active again — schedule the next shipment so it has a due date.
      const todayStr = new Date().toLocaleDateString("en-US", { timeZone: "America/New_York" });
      if (
        existing.isMembership === "Y" &&
        totalShipments !== undefined &&
        !existing.nextShipDue &&
        Number(updated.shipmentsSent) < Number(updated.totalShipments)
      ) {
        updated.nextShipDue = new Date(Date.now() + (Number(updated.supplyIntervalDays) || 30) * 86400000)
          .toLocaleDateString("en-US", { timeZone: "America/New_York" });
      }
      // If the total was lowered to what's already been sent, nothing more is due.
      if (existing.isMembership === "Y" && Number(updated.shipmentsSent) >= Number(updated.totalShipments)) {
        updated.nextShipDue = "";
      }

      // "Mark shipment sent" is computed from the CURRENT sheet state, not
      // whatever the client last saw — two people clicking it moments apart
      // still each advance the count by exactly one, never skip or double up.
      // Already fully shipped (e.g. two people clicked the last one together):
      // do nothing — never push the count past the total.
      const alreadyComplete = existing.isMembership === "Y" && Number(existing.totalShipments) > 0 &&
        Number(existing.shipmentsSent) >= Number(existing.totalShipments);
      if (markShipmentSent && existing.isMembership === "Y" && !alreadyComplete) {
        const sentCount = (Number(existing.shipmentsSent) || 0) + 1;
        const total = Number(existing.totalShipments) || 0;
        updated.shipmentsSent = sentCount;
        updated.nextShipDue = sentCount >= total
          ? ""
          : new Date(Date.now() + (Number(existing.supplyIntervalDays) || 30) * 86400000)
              .toLocaleDateString("en-US", { timeZone: "America/New_York" });
        updated.lastShipmentBy = `${doctor.name} · ${todayStr}`; // name from verified sign-in, never client-supplied
      }

      // Push the next shipment to a new date (patient traveling, supply running long, etc.).
      // The old and new dates are written into Notes so there is a trail of who moved it.
      if (pushNextShipTo !== undefined) {
        if (existing.isMembership !== "Y") return json(400, { error: "This order has no shipment schedule to change." });
        if (alreadyComplete || !existing.nextShipDue) return json(400, { error: "All shipments for this order are already sent." });
        const newDate = parseShipDate(pushNextShipTo);
        if (!newDate) return json(400, { error: "Pick a real date within the next year." });
        updated.nextShipDue = newDate;
        updated.notes = joinNotes(existing.notes, `Next shipment moved ${existing.nextShipDue} → ${newDate} by ${doctor.name} (${todayStr})`);
      }

      if (remove) updated.removedBy = `${doctor.name} · ${todayStr}`;

      const sheetRowNumber = rowIndex + 2; // +1 for header row, +1 for 1-based indexing
      const lastCol = String.fromCharCode(65 + COLUMNS.length - 1);
      await updateRange(process.env.APP_DATA_SHEET_ID, `${ORDERS_RANGE}!A${sheetRowNumber}:${lastCol}${sheetRowNumber}`, rowFromFields(updated));

      return json(200, {
        lineId,
        removed: !!remove,
        status: computeStatus(updated),
        shipmentsSent: updated.shipmentsSent,
        nextShipDue: updated.nextShipDue,
        shipmentStatus: computeShipmentStatus(updated),
        totalShipments: updated.totalShipments,
        supplyIntervalDays: updated.supplyIntervalDays,
        lastShipmentBy: updated.lastShipmentBy,
        notes: updated.notes,
      });
    }

    return json(405, { error: "Method not allowed" });
  } catch (err) {
    return errorResponse(err);
  }
};
