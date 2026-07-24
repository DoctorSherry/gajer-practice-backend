const { readRange, appendRow } = require("./_lib/sheets");
const { verifyRequest } = require("./_lib/auth");
const { rowsToObjects, json, errorResponse, corsHeaders } = require("./_lib/rows");

const RANGE = process.env.PATIENTS_RANGE || "Patients";

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders(), body: "" };
  try {
    const doctor = await verifyRequest(event);

    if (event.httpMethod === "GET") {
      const rows = await readRange(process.env.APP_DATA_SHEET_ID, RANGE);
      const patients = rowsToObjects(rows).map((r) => r.PatientID).filter(Boolean);
      return json(200, { patients: [...new Set(patients)].sort() });
    }

    if (event.httpMethod === "POST") {
      const body = JSON.parse(event.body || "{}");
      const patientId = (body.patientId || "").trim();
      if (!patientId) return json(400, { error: "patientId is required" });

      const rows = await readRange(process.env.APP_DATA_SHEET_ID, RANGE);
      const existing = rowsToObjects(rows).some((r) => r.PatientID === patientId);
      if (existing) return json(200, { patientId, alreadyExisted: true });

      await appendRow(process.env.APP_DATA_SHEET_ID, RANGE, [
        patientId,
        doctor.email,
        new Date().toISOString(),
      ]);
      return json(201, { patientId, alreadyExisted: false });
    }

    return json(405, { error: "Method not allowed" });
  } catch (err) {
    return errorResponse(err);
  }
};
