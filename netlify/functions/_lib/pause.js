// Membership pause helpers. A pause lives on the patient's own row of the Patients tab
// ("Paused Since" / "Paused By" columns, added on first use). It stays until someone restarts it.

const PAUSE_LIMIT_DAYS = 60; // Patrick: a pause can last up to 60 days to begin with

function todayNY() {
  return new Date().toLocaleDateString("en-US", { timeZone: "America/New_York" });
}

// "M/D/YYYY" -> UTC midnight ms, or null
function parseMDY(s) {
  const m = String(s || "").trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const t = Date.UTC(+m[3], +m[1] - 1, +m[2]);
  const d = new Date(t);
  return d.getUTCFullYear() === +m[3] && d.getUTCMonth() === +m[1] - 1 && d.getUTCDate() === +m[2] ? t : null;
}

function formatMDY(ms) {
  const d = new Date(ms);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
}

function daysBetween(fromMDY, toMDY) {
  const a = parseMDY(fromMDY), b = parseMDY(toMDY);
  if (a === null || b === null) return 0;
  return Math.max(0, Math.round((b - a) / 86400000));
}

// Where a shipment moves to when a pause ends. One that was already due (before or during the pause)
// is simply due on restart; one still in the future moves out by the number of days paused.
function shiftedShipDate(nextShipDue, pausedSince, today) {
  const old = parseMDY(nextShipDue), start = parseMDY(pausedSince), now = parseMDY(today);
  if (old === null || start === null || now === null) return null;
  if (old <= now) return formatMDY(now);
  return formatMDY(old + Math.max(0, Math.round((now - start) / 86400000)) * 86400000);
}

// patientId -> "M/D/YYYY" for every patient currently paused
async function readPauseMap(readRange, sheetId, patientsRange) {
  const rows = await readRange(sheetId, patientsRange);
  const headers = (rows[0] || []).map((h) => (h || "").toString().trim());
  const pIdx = headers.indexOf("Paused Since");
  const qIdx = headers.indexOf("QuoteID");
  const map = {};
  if (pIdx === -1) return map;
  rows.slice(1).forEach((r) => {
    if (!r[0] || (qIdx !== -1 && r[qIdx])) return; // only the patient's own row
    const v = (r[pIdx] || "").toString().trim();
    if (v) map[r[0]] = v; else delete map[r[0]];
  });
  return map;
}

module.exports = { PAUSE_LIMIT_DAYS, todayNY, parseMDY, formatMDY, daysBetween, shiftedShipDate, readPauseMap };
