const { rowsToObjects, pickField, toNumber, parseStrengthInfo } = require("./rows");

// The Pens tab lists ready-to-use dosing pens. One "click" (a.k.a. unit) is 0.01 mL,
// so mg per click = concentration / 100. We read what the sheet says and cross-check it,
// so a typo in the sheet turns into "units unavailable" rather than a wrong number on a
// patient's instructions.

const NAME_KEYS = ["peptide / product name", "product", "peptide", "name", "product name"];
const FORMAT_KEYS = ["mode of delivery", "format", "delivery"];
const STRENGTH_KEYS = ["mg / ml (amount)", "strength", "mg"];
const PRICE_KEYS = ["price ($)", "price", "wholesale", "cost"];
const FILL_KEYS = ["fill volume"];
const CONC_KEYS = ["concentration (mg/ml)", "concentration"];
const CLICK_KEYS = ["mg per click/unit", "mg per click", "per click"];
const PRIME_KEYS = ["fill for priming"];

// "Semaglutide (GLP-1S)" is just Semaglutide; other parentheses (Wolverine, GLOW...) are real names.
function cleanPenName(name) {
  return String(name || "").replace(/\s*\((?:GLP-\d[A-Z])\)\s*$/i, "").trim();
}

function numbersIn(s) {
  return [...String(s ?? "").matchAll(/(\d+(?:\.\d+)?)/g)].map((m) => parseFloat(m[1]));
}

// "10mg/10mg, 3mL" -> [10, 10]; ignores the volume
function componentsOf(raw) {
  return [...String(raw ?? "").matchAll(/(\d+(?:\.\d+)?)\s*mg\b/gi)].map((m) => parseFloat(m[1]));
}

// Rows with those cells blank, or with a different count than ingredients, get no unit count.
// One click is 0.01 mL. We work the numbers out from the pen's label ("10mg, 3mL" = 10 mg in
// 3 mL) rather than from the sheet's rounded mg-per-click column (it shows 0.03 where the true
// value is 0.0333, which would be an 11% dosing error). The sheet's own columns are used only as
// a cross-check: if they disagree with the label by more than rounding, we refuse to give units.
function parsePen(r) {
  const rawStrength = (pickField(r, STRENGTH_KEYS) || "").toString().trim();
  const comps = componentsOf(rawStrength);
  const labelMl = (() => { const m = rawStrength.match(/(\d+(?:\.\d+)?)\s*ml\b/i); return m ? parseFloat(m[1]) : 0; })();
  const sheetFill = toNumber(pickField(r, FILL_KEYS));
  const fillMl = sheetFill || labelMl;
  const sheetConc = numbersIn(pickField(r, CONC_KEYS)).filter((n) => n > 0);
  const sheetClicks = numbersIn(pickField(r, CLICK_KEYS)).filter((n) => n > 0);
  const primeMl = toNumber(pickField(r, PRIME_KEYS));
  const pen = { components: comps, fillMl: fillMl || null, mgPerMl: [], mgPerClick: [], primeMl: primeMl || null, unitsOk: false, note: "" };

  if (!comps.length || !fillMl) { pen.note = "strength or fill volume can't be read"; return pen; }
  // Cells the clinic left blank stay blank: no concentration / click value in the sheet = no unit count.
  if (!sheetConc.length || !sheetClicks.length) { pen.note = "concentration / mg per click left blank in the sheet"; return pen; }
  pen.mgPerMl = comps.map((mg) => mg / fillMl);
  pen.mgPerClick = pen.mgPerMl.map((c) => c / 100);

  const SHEET_ROUNDING = 0.12; // the sheet rounds to 1-2 significant figures (0.0333 shown as 0.03 = 10%)
  const clickBad = sheetClicks.length === comps.length && sheetClicks.some((c, i) => Math.abs(c - pen.mgPerClick[i]) > pen.mgPerClick[i] * SHEET_ROUNDING);
  const concBad = sheetConc.length === comps.length && sheetConc.some((c, i) => Math.abs(c - pen.mgPerMl[i]) > pen.mgPerMl[i] * SHEET_ROUNDING);
  if (clickBad || concBad) { pen.note = "the sheet's concentration / mg per click disagrees with the label"; return pen; }
  if (sheetClicks.length !== comps.length || sheetConc.length !== comps.length) { pen.note = "the sheet lists a different number of values than ingredients"; return pen; }
  pen.unitsOk = true;
  return pen;
}

function penVendors(rows) {
  return rowsToObjects(rows)
    .map((r) => {
      const info = parseStrengthInfo(pickField(r, STRENGTH_KEYS));
      return {
        name: cleanPenName(pickField(r, NAME_KEYS)),
        format: (pickField(r, FORMAT_KEYS) || "Pen").toString().trim(),
        strengthMg: info.strengthMg,
        unitRecognized: info.unitRecognized,
        rawStrength: (pickField(r, STRENGTH_KEYS) || "").toString().trim(),
        wholesalePrice: toNumber(pickField(r, PRICE_KEYS)),
        pen: parsePen(r),
      };
    })
    .filter((v) => v.name && v.wholesalePrice > 0 && v.strengthMg > 0);
}

module.exports = { penVendors, parsePen, cleanPenName };
