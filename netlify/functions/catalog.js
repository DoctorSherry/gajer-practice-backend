const { readRange } = require("./_lib/sheets");
const { verifyRequest } = require("./_lib/auth");
const { penVendors } = require("./_lib/pens");
const { strikerVendors } = require("./_lib/striker");
const { rowsToObjects, pickField, toNumber, parseStrengthInfo, json, errorResponse, corsHeaders } = require("./_lib/rows");

// Which supplier a catalog row comes from — shown as a tag so staff can tell the two apart.
const HB = "Healing Biologix";
const VENDOR_NAME_KEYS = ["product", "peptide", "name", "item", "product name", "peptide name"];
const FORMAT_KEYS = ["format", "delivery", "type", "delivery format"];
const STRENGTH_KEYS = ["strength", "size", "strength (mg)", "strength_mg", "mg", "volume"];
const PRICE_KEYS = ["price", "wholesale", "cost", "wholesale price", "office cost"];
// Listed most-specific-first: a clean numeric column (if the sheet has one)
// should always win over a vaguer or free-text column with a similar name.
const DOSE_KEYS = ["recommended dose", "dose_mg", "dose (mg)", "dosage", "dose"];
const FREQ_KEYS = ["freq / week", "freq/week", "frequency_per_week", "times per week", "freq", "frequency"];
const DURATION_KEYS = ["treatment weeks", "duration_weeks", "duration (weeks)", "course length", "weeks", "duration"];

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: corsHeaders(), body: "" };
  try {
    await verifyRequest(event);

    // Pens live on their own tab of the same workbook. If that tab is missing or unreadable the
    // rest of the catalog must still load, so a failure here is reported, not thrown.
    const pensPromise = readRange(process.env.VENDOR_SHEET_ID, process.env.PENS_RANGE || "Pens").catch((e) => ({ error: e.message }));
    // Striker (503A pharmacy) lists live on their own tabs too; same rule — a missing tab never breaks the catalog.
    const strikerPromise = readRange(process.env.VENDOR_SHEET_ID, process.env.STRIKER_RANGE || "Striker Peptides").catch((e) => ({ error: e.message }));
    const strikerPensPromise = readRange(process.env.VENDOR_SHEET_ID, process.env.STRIKER_PENS_RANGE || "Striker Pens").catch((e) => ({ error: e.message }));
    const [vendorRows, protocolRows] = await Promise.all([
      readRange(process.env.VENDOR_SHEET_ID, process.env.VENDOR_RANGE || "Sheet1"),
      readRange(process.env.PROTOCOL_SHEET_ID, process.env.PROTOCOL_RANGE || "Sheet1"),
    ]);

    const vendors = rowsToObjects(vendorRows)
      .map((r) => {
        const strengthInfo = parseStrengthInfo(pickField(r, STRENGTH_KEYS));
        return {
          name: (pickField(r, VENDOR_NAME_KEYS) || "").toString().trim(),
          format: (pickField(r, FORMAT_KEYS) || "Vial").toString().trim(),
          strengthMg: strengthInfo.strengthMg,
          unitRecognized: strengthInfo.unitRecognized,
          rawStrength: strengthInfo.rawStrength,
          rawUnitValue: strengthInfo.rawUnitValue,
          wholesalePrice: toNumber(pickField(r, PRICE_KEYS)),
          source: HB,
        };
      })
      // Keep a row if it has a usable mg strength OR is a flagged non-mg
      // product (IU etc.) meant for manual entry — only drop rows that are
      // genuinely broken (no name/price, or a real parsing failure).
      .filter((v) => v.name && v.wholesalePrice > 0 && (v.strengthMg > 0 || v.unitRecognized === false));

    const protocols = rowsToObjects(protocolRows)
      .map((r) => ({
        name: (pickField(r, VENDOR_NAME_KEYS) || "").toString().trim(),
        doseMg: toNumber(pickField(r, DOSE_KEYS)),
        freqPerWeek: toNumber(pickField(r, FREQ_KEYS)),
        durationWeeks: toNumber(pickField(r, DURATION_KEYS)),
      }))
      .filter((p) => p.name);

    const pensRaw = await pensPromise;
    let pensError = null;
    if (Array.isArray(pensRaw)) vendors.push(...penVendors(pensRaw).map((v) => ({ ...v, source: HB })));
    else pensError = pensRaw.error;

    const strikerRaw = await strikerPromise, strikerPensRaw = await strikerPensPromise;
    let strikerError = null;
    if (Array.isArray(strikerRaw)) vendors.push(...strikerVendors(strikerRaw));
    else strikerError = strikerRaw.error;
    if (Array.isArray(strikerPensRaw)) {
      // an empty tab (headers only) simply adds nothing
      vendors.push(...penVendors(strikerPensRaw).map((v) => ({ ...v, source: "Striker" })));
    } else strikerError = strikerError || strikerPensRaw.error;

    return json(200, { vendors, protocols, pensError, strikerError, fetchedAt: new Date().toISOString() });
  } catch (err) {
    return errorResponse(err);
  }
};
