const { google } = require("googleapis");

let cachedAuth = null;

function getAuth() {
  if (cachedAuth) return cachedAuth;
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const rawKey = process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || "";
  const key = rawKey.replace(/\\n/g, "\n");
  if (!email || !key) {
    throw new Error("Missing GOOGLE_SERVICE_ACCOUNT_EMAIL or GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY env vars");
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

module.exports = { readRange, appendRow };
