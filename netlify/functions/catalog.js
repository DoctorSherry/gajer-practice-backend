const { readRange } = require("./_lib/sheets");
const { verifyRequest } = require("./_lib/auth");
const { rowsToObjects, pickField, toNumber, json, errorResponse, corsHeaders } = require("./_lib/rows");

const VENDOR_NAME_KEYS = ["product", "peptide", "name", "item", "product name", "peptide name"];
const FORMAT_KEYS = ["format", "delivery", "type", "delivery format"];
const STRENGTH_KEYS = ["strength", "size", "strength (mg)", "strength_mg", "mg", "volume"];
const PRICE_KEYS = ["price", "wholesale", "cost", "wholesale price", "office cost"];
const DOSE_KEYS = ["dose", "dose_mg", "dosage", "dose (mg)"];
const FREQ_KEYS = ["frequency", "freq", "times per week", "frequency_per_week", "freq/week"];
const DURATION_KEYS = ["duration", "weeks", "duration_weeks", "course length", "duration (weeks)"];

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders(), body: "" };
  try {
    await verifyRequest(event);

    const [vendorRows, protocolRows] = await Promise.all([
      readRange(process.env.VENDOR_SHEET_ID, process.env.VENDOR_RANGE || "Sheet1"),
      readRange(process.env.PROTOCOL_SHEET_ID, process.env.PROTOCOL_RANGE || "Sheet1"),
    ]);

    const vendors = rowsToObjects(vendorRows)
      .map((r) => ({
        name: (pickField(r, VENDOR_NAME_KEYS) || "").toString().trim(),
        format: (pickField(r, FORMAT_KEYS) || "Vial").toString().trim(),
        strengthMg: toNumber(pickField(r, STRENGTH_KEYS)),
        wholesalePrice: toNumber(pickField(r, PRICE_KEYS)),
      }))
      .filter((v) => v.name && v.strengthMg > 0 && v.wholesalePrice > 0);

    const protocols = rowsToObjects(protocolRows)
      .map((r) => ({
        name: (pickField(r, VENDOR_NAME_KEYS) || "").toString().trim(),
        doseMg: toNumber(pickField(r, DOSE_KEYS)),
        freqPerWeek: toNumber(pickField(r, FREQ_KEYS)),
        durationWeeks: toNumber(pickField(r, DURATION_KEYS)),
      }))
      .filter((p) => p.name);

    return json(200, { vendors, protocols, fetchedAt: new Date().toISOString() });
  } catch (err) {
    return errorResponse(err);
  }
};
