const { google } = require("googleapis");

let cachedAuth = null;

function getAuth() {
  if (cachedAuth) return cachedAuth;
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  let raw = (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || "").trim();

  // Strip accidental wrapping quotes (happens if someone pastes the JSON
  // file's "private_key": "..." value including the outer quote marks).
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    raw = raw.slice(1, -1);
  }

  // Normalize line endings: handle both literal "\n" text (two characters)
  // and real newlines/CRLF, however it ended up after pasting into Netlify.
  let key = raw.includes("\\n") ? raw.replace(/\\n/g, "\n") : raw;
  key = key.replace(/\r\n/g, "\n").trim();

  if (!email) throw new Error("GOOGLE_SERVICE_ACCOUNT_EMAIL is missing.");
  if (!key.includes("BEGIN PRIVATE KEY") || !key.includes("END PRIVATE KEY")) {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY looks malformed — it should start with -----BEGIN PRIVATE KEY----- and end with -----END PRIVATE KEY-----, with no surrounding quote marks."
    );
  }

  cachedAuth = new google.auth.JWT({
    email,
    key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return cachedAuth;
}

async function getClient() {
  const auth = getAuth();
  await auth.authorize();
  return google.sheets({ version: "v4", auth });
}

/** Read a range (e.g. "Sheet1" or "Sheet1!A:Z") and return raw rows (array of arrays). */
async function readRange(spreadsheetId, range) {
  if (!spreadsheetId) throw new Error(`Missing spreadsheet ID for range "${range}"`);
  const sheets = await getClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  return res.data.values || [];
}

/** Append one row to the end of a sheet/tab. */
async function appendRow(spreadsheetId, range, row) {
  const sheets = await getClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [row] },
  });
}

/** Append several rows in one call (one visit producing multiple peptide lines). */
async function appendRows(spreadsheetId, range, rows) {
  const sheets = await getClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range,
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: rows },
  });
}

/** Overwrite an exact range (e.g. "Orders!A5:U5") with new values — used to
 * update a specific existing row in place (Orders tab operational fields). */
async function updateRange(spreadsheetId, range, values) {
  const sheets = await getClient();
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: "RAW",
    requestBody: { values: [values] },
  });
}

module.exports = { readRange, appendRow, appendRows, updateRange };
