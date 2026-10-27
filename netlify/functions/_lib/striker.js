const { rowsToObjects, pickField, toNumber } = require("./rows");

// The "Striker Peptides" tab lists Striker 503A pharmacy products (Tier 1 pricing). Rows are turned
// into the same shape as the Healing Biologix catalog rows so both show up as options for a peptide.
//   - strength is the pharmacy's total "API mg" (the part before "total"); vitamins in the
//     concentration text such as "(1mg/0.5mL)" are never added in.
//   - the Price ($) column is the price used; "Bulk Price ($)" is kept in the sheet only.
//   - rows carry source: "Striker" (Healing Biologix rows carry "Healing Biologix") and the app shows it as a tag.

const NAME_KEYS = ["peptide / product name", "product", "peptide", "name", "product name"];
const FORMAT_KEYS = ["mode of delivery", "format", "delivery"];
const STRENGTH_KEYS = ["mg / ml (amount)", "strength", "mg"];
const PRICE_KEYS = ["price ($)", "price", "wholesale", "cost"];

// Striker's names -> the names the rest of the catalog already uses, so the same peptide lines up.
const ALIASES = {
  "kisspeptin-10": "Kisspeptin",
  "thymosin alpha-1": "Thymosin Alpha-1 (TA-1)",
  "tb-500 (thymosin b4 acetate)": "TB-500",
  "tesamorelin/ipamorelin (2x blend)": "Tesamorelin/Ipamorelin",
  "glow (ghk-cu/bpc-157/tb-500)": "GLOW (BPC-157/TB-500/GHK-Cu)",
  "glow (bpc-157/ghk-cu/tb-500)": "GLOW (BPC-157/TB-500/GHK-Cu)",
  "klow (bpc-157/ghk-cu/tb-500/kpv)": "KLOW (KPV/BPC-157/TB-500/GHK-Cu)",
  "semaglutide + b12 (cyanocobalamin)": "Semaglutide + B12",
  "tirzepatide + b12 (cyanocobalamin)": "Tirzepatide + B12",
  "semaglutide + b6 (pyridoxine)": "Semaglutide + B6",
  "tirzepatide + b6 (pyridoxine)": "Tirzepatide + B6",
};

function strikerName(raw) {
  const n = String(raw || "").trim();
  return ALIASES[n.toLowerCase()] || n;
}

// "4mg total, 2ml (1mg/0.5mL)" -> 4 ; "9mg, 15mg total, 6ml (...)" -> 24 ; "10mg, 50mg, 10mg, 10mg KPV total, 10ml" -> 80
function totalMgOf(amount) {
  const s = String(amount ?? "");
  const head = s.includes(" total") ? s.slice(0, s.indexOf(" total")) : s.replace(/\(.*$/, "");
  let sum = 0;
  for (const m of head.matchAll(/(\d+(?:\.\d+)?)\s*(mg|mcg)\b/gi)) sum += parseFloat(m[1]) / (m[2].toLowerCase() === "mcg" ? 1000 : 1);
  return sum;
}

function strikerVendors(rows) {
  return rowsToObjects(rows)
    .map((r) => {
      const mode = (pickField(r, FORMAT_KEYS) || "Vial").toString().trim();
      return {
        name: strikerName(pickField(r, NAME_KEYS)),
        format: mode.replace(/^striker\s*/i, "") || "Vial",
        strengthMg: totalMgOf(pickField(r, STRENGTH_KEYS)),
        unitRecognized: true,
        wholesalePrice: toNumber(pickField(r, PRICE_KEYS)),
        source: "Striker",
      };
    })
    .filter((v) => v.name && v.wholesalePrice > 0 && v.strengthMg > 0);
}

module.exports = { strikerVendors, strikerName, totalMgOf };
