/**
 * The Gajer Practice — daily reminder emails (Google Apps Script, free).
 *
 * WHAT IT DOES (once a day, ~8 AM):
 *   • Emails the STAFF a digest: shipments overdue / due today / due soon, follow-ups coming up,
 *     payments still outstanding, and memberships that are paused (with the 60-day warning).
 *   • Emails PATIENTS a short, generic reminder (no peptide names, no health details) for:
 *     an upcoming shipment, an upcoming follow-up, and an outstanding payment.
 *   • Never sends the same reminder twice (it keeps a "Reminder Log" tab) and never sends shipment
 *     reminders for a paused membership.
 *
 * SAFE START: patient emails are in PREVIEW mode (DRY_RUN_PATIENTS = true). In preview mode the
 * script writes what it WOULD send to the "Reminder Log" tab and emails only staff. Check the log,
 * then set DRY_RUN_PATIENTS to false.
 *
 * INSTALL (5 minutes, from the app's data spreadsheet — the one with the Orders and Patients tabs):
 *   1. Extensions → Apps Script. Delete the sample code and paste this whole file. Save.
 *   2. Edit the CONFIG block below (staff emails, clinic phone).
 *   3. Run `setupDailyTrigger` once (pick it in the function menu → Run) and approve the permissions.
 *      Emails are sent from the Google account that does this — use a clinic address.
 *   4. Run `sendTestEmailToMe` to see a sample staff email. Run `sendDailyReminders` to do a real pass now.
 */

var CONFIG = {
  CLINIC_NAME: "The Gajer Practice",
  CLINIC_PHONE: "",                                   // shown to patients if filled in, e.g. "(555) 123-4567"
  STAFF_EMAILS: ["patrick@thegajerpractice.com"],     // who gets the daily digest
  REPLY_TO: "patrick@thegajerpractice.com",           // where patient replies go
  TIMEZONE: "America/New_York",

  DRY_RUN_PATIENTS: true,                             // true = preview only; false = really email patients
  SEND_SHIPMENT_REMINDERS: true,
  SEND_FOLLOWUP_REMINDERS: true,
  SEND_PAYMENT_REMINDERS: true,

  STAFF_LOOKAHEAD_DAYS: 7,                            // staff digest shows things due within this many days (missed follow-ups stay listed for 14 days)
  SHIPMENT_REMINDER_DAYS: 3,                          // patients are told about a shipment this many days ahead
  FOLLOWUP_REMINDER_DAYS: 3,                          // …and a follow-up this many days ahead
  PAYMENT_REMINDER_AFTER_DAYS: 3,                     // a payment is "outstanding" after this many days
  PAUSE_LIMIT_DAYS: 60,                               // staff are warned when a pause passes this

  ORDERS_TAB: "Orders",
  PATIENTS_TAB: "Patients",
  LOG_TAB: "Reminder Log",
  TRIGGER_HOUR: 8
};

/* ------------------------------------------------------------------ dates (pure helpers) */

// "M/D/YYYY" text, a Date from the sheet, or "" -> UTC-midnight milliseconds, or null.
function parseDate_(v) {
  if (v === null || v === undefined || v === "") return null;
  if (Object.prototype.toString.call(v) === "[object Date]") {
    if (isNaN(v.getTime())) return null;
    return Date.UTC(v.getFullYear(), v.getMonth(), v.getDate());
  }
  var m = String(v).trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  var t = Date.UTC(+m[3], +m[1] - 1, +m[2]);
  var d = new Date(t);
  return d.getUTCFullYear() === +m[3] && d.getUTCMonth() === +m[1] - 1 && d.getUTCDate() === +m[2] ? t : null;
}
function formatDate_(ms) {
  var d = new Date(ms);
  return (d.getUTCMonth() + 1) + "/" + d.getUTCDate() + "/" + d.getUTCFullYear();
}
function daysBetween_(fromMs, toMs) { return Math.round((toMs - fromMs) / 86400000); }

/* ------------------------------------------------------------------ reading the sheet (pure) */

function rowsToObjects_(values) {
  if (!values || values.length < 2) return [];
  var headers = values[0].map(function (h) { return String(h || "").trim(); });
  return values.slice(1).map(function (row) {
    var o = {};
    headers.forEach(function (h, i) { if (h) o[h] = row[i]; });
    return o;
  });
}
function clean_(v) { return v === null || v === undefined ? "" : String(v).trim(); }

// Patients tab: the patient's own row has no QuoteID. Returns { id: {email, followUp(ms|null), pausedSince(ms|null)} }
function readPatients_(values) {
  var out = {};
  rowsToObjects_(values).forEach(function (r) {
    var id = clean_(r["PatientID"]);
    if (!id || clean_(r["QuoteID"])) return;
    out[id] = {
      email: clean_(r["Patient Email"]).toLowerCase(),
      followUp: parseDate_(r["Next Follow-Up"]),
      pausedSince: parseDate_(r["Paused Since"])
    };
  });
  return out;
}

/* ------------------------------------------------------------------ deciding what to send (pure) */

/**
 * orders: rows from the Orders tab (objects), patients: from readPatients_, sentKeys: {key:true} already sent,
 * today: UTC-midnight ms of the clinic's today. Returns { staff: {...}, patientEmails: [...] } — nothing is sent here.
 */
function buildPlan_(orders, patients, sentKeys, todayMs, cfg) {
  var staff = { overdue: [], today: [], soon: [], followUps: [], payments: [], paused: [] };
  var perPatient = {}; // id -> { shipments:[{key,dueMs}], followUp:{key,dueMs}|null, payments:[{key}] }
  function bucket(id) { return perPatient[id] = perPatient[id] || { shipments: [], followUp: null, payments: [] }; }

  orders.forEach(function (o) {
    if (!clean_(o["LineID"]) || clean_(o["Removed By"])) return;
    var pid = clean_(o["Patient"]);
    var pat = patients[pid] || { email: "", followUp: null, pausedSince: null };
    var lineId = clean_(o["LineID"]);

    // --- shipments
    if (clean_(o["Is Membership"]) === "Y") {
      var total = Number(o["Total Shipments"]) || 0, sent = Number(o["Shipments Sent"]) || 0;
      var due = parseDate_(o["Next Ship Due"]);
      if (!(total > 0 && sent >= total) && due !== null && !pat.pausedSince) {
        var diff = daysBetween_(todayMs, due);
        var item = { patient: pid, peptide: clean_(o["Peptide"]).split("\\")[0].trim(), due: formatDate_(due), days: diff, count: (sent + 1) + " of " + total };
        if (diff < 0) staff.overdue.push(item);
        else if (diff === 0) staff.today.push(item);
        else if (diff <= cfg.STAFF_LOOKAHEAD_DAYS) staff.soon.push(item);
        if (diff >= 0 && diff <= cfg.SHIPMENT_REMINDER_DAYS) bucket(pid).shipments.push({ key: "ship|" + lineId + "|" + formatDate_(due), dueMs: due });
      }
    }

    // --- outstanding payment (a purchase nobody has marked paid)
    if (clean_(o["Type"]) === "purchase" && clean_(o["Payment Status"]) !== "paid") {
      var placed = parseDate_(o["Date"]);
      if (placed !== null) {
        var age = daysBetween_(placed, todayMs);
        if (age >= cfg.PAYMENT_REMINDER_AFTER_DAYS) {
          staff.payments.push({ patient: pid, peptide: clean_(o["Peptide"]).split("\\")[0].trim(), price: Number(o["Patient Price"]) || 0, days: age });
          bucket(pid).payments.push({ key: "pay|" + lineId + "|wk" + Math.floor(todayMs / 86400000 / 7) });
        }
      }
    }
  });

  // --- follow-ups and paused memberships (per patient)
  Object.keys(patients).forEach(function (pid) {
    var p = patients[pid];
    if (p.followUp !== null) {
      var d = daysBetween_(todayMs, p.followUp);
      if (d <= cfg.STAFF_LOOKAHEAD_DAYS && d >= -14) staff.followUps.push({ patient: pid, due: formatDate_(p.followUp), days: d });
      if (d >= 0 && d <= cfg.FOLLOWUP_REMINDER_DAYS) bucket(pid).followUp = { key: "follow|" + pid + "|" + formatDate_(p.followUp), dueMs: p.followUp };
    }
    if (p.pausedSince !== null) {
      var pd = daysBetween_(p.pausedSince, todayMs);
      staff.paused.push({ patient: pid, since: formatDate_(p.pausedSince), days: pd, overLimit: pd > cfg.PAUSE_LIMIT_DAYS });
    }
  });

  // --- patient emails: one per patient, combining everything that is new for them today
  var patientEmails = [];
  Object.keys(perPatient).forEach(function (pid) {
    var b = perPatient[pid], p = patients[pid] || { email: "" };
    var lines = [], keys = [];
    if (cfg.SEND_SHIPMENT_REMINDERS) {
      var fresh = b.shipments.filter(function (s) { return !sentKeys[s.key]; });
      if (fresh.length) {
        var first = fresh.map(function (s) { return s.dueMs; }).sort(function (a, c) { return a - c; })[0];
        lines.push("Your next shipment is scheduled for " + formatDate_(first) + ".");
        fresh.forEach(function (s) { keys.push(s.key); });
      }
    }
    if (cfg.SEND_FOLLOWUP_REMINDERS && b.followUp && !sentKeys[b.followUp.key]) {
      lines.push("You have a follow-up coming up on " + formatDate_(b.followUp.dueMs) + ".");
      keys.push(b.followUp.key);
    }
    if (cfg.SEND_PAYMENT_REMINDERS) {
      var pay = b.payments.filter(function (x) { return !sentKeys[x.key]; });
      if (pay.length) {
        lines.push("There is a balance on your account that needs your attention. Please contact us so we can take care of it.");
        pay.forEach(function (x) { keys.push(x.key); });
      }
    }
    if (lines.length) patientEmails.push({ patient: pid, to: p.email, lines: lines, keys: keys });
  });

  return { staff: staff, patientEmails: patientEmails };
}

/* ------------------------------------------------------------------ email text (pure) */

function patientEmailBody_(lines, cfg) {
  var contact = cfg.CLINIC_PHONE ? "reply to this email or call us at " + cfg.CLINIC_PHONE : "reply to this email";
  return "Hello,\n\n" + lines.join("\n\n") +
    "\n\nIf your plans have changed or you have any questions, just " + contact + ".\n\nThank you,\n" + cfg.CLINIC_NAME;
}

function staffDigest_(staff, todayMs, cfg) {
  var counts = [];
  if (staff.overdue.length) counts.push(staff.overdue.length + " overdue");
  if (staff.today.length) counts.push(staff.today.length + " due today");
  if (staff.soon.length) counts.push(staff.soon.length + " due soon");
  if (staff.followUps.length) counts.push(staff.followUps.length + " follow-up" + (staff.followUps.length === 1 ? "" : "s"));
  if (staff.payments.length) counts.push(staff.payments.length + " unpaid");
  if (staff.paused.length) counts.push(staff.paused.length + " paused");
  if (!counts.length) return null;

  function ship(list, label) {
    if (!list.length) return "";
    return label + "\n" + list.map(function (i) {
      var when = i.days < 0 ? Math.abs(i.days) + " day" + (Math.abs(i.days) === 1 ? "" : "s") + " late" : (i.days === 0 ? "today" : "in " + i.days + " day" + (i.days === 1 ? "" : "s"));
      return "  • " + i.patient + " — " + i.peptide + " (shipment " + i.count + ", due " + i.due + ", " + when + ")";
    }).join("\n") + "\n\n";
  }
  var body = "Daily reminders for " + formatDate_(todayMs) + "\n\n";
  body += ship(staff.overdue, "OVERDUE SHIPMENTS");
  body += ship(staff.today, "DUE TODAY");
  body += ship(staff.soon, "DUE IN THE NEXT " + cfg.STAFF_LOOKAHEAD_DAYS + " DAYS");
  if (staff.followUps.length) {
    body += "FOLLOW-UPS\n" + staff.followUps.sort(function (a, b) { return a.days - b.days; }).map(function (f) {
      var n = Math.abs(f.days), unit = n === 1 ? " day" : " days";
      return "  • " + f.patient + " — " + f.due + (f.days < 0 ? " (" + n + unit + " ago)" : f.days === 0 ? " (today)" : " (in " + n + unit + ")");
    }).join("\n") + "\n\n";
  }
  if (staff.payments.length) {
    body += "PAYMENT STILL OUTSTANDING\n" + staff.payments.map(function (p) {
      return "  • " + p.patient + " — " + p.peptide + ", $" + p.price.toFixed(2) + " (ordered " + p.days + " days ago)";
    }).join("\n") + "\n\n";
  }
  if (staff.paused.length) {
    body += "PAUSED MEMBERSHIPS (shipments and billing on hold until restarted)\n" + staff.paused.map(function (p) {
      return "  • " + p.patient + " — paused since " + p.since + " (" + p.days + " days)" + (p.overLimit ? " — PAST THE " + cfg.PAUSE_LIMIT_DAYS + "-DAY LIMIT" : "");
    }).join("\n") + "\n\n";
  }
  body += "Open the app's Orders tab to mark shipments sent or move a date.";
  return { subject: cfg.CLINIC_NAME + " — daily reminders: " + counts.join(", "), body: body };
}

/* ------------------------------------------------------------------ the parts that touch Google */

function todayMs_() {
  return parseDate_(Utilities.formatDate(new Date(), CONFIG.TIMEZONE, "M/d/yyyy"));
}

function getLogSheet_(ss) {
  var sh = ss.getSheetByName(CONFIG.LOG_TAB);
  if (!sh) { sh = ss.insertSheet(CONFIG.LOG_TAB); sh.appendRow(["Time", "Type", "Key", "To", "Status"]); }
  return sh;
}

function readSentKeys_(logSheet) {
  var sent = {};
  logSheet.getDataRange().getValues().slice(1).forEach(function (r) { if (String(r[4]) === "SENT") sent[String(r[2])] = true; });
  return sent;
}

function sendDailyReminders() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var ordersSheet = ss.getSheetByName(CONFIG.ORDERS_TAB), patientsSheet = ss.getSheetByName(CONFIG.PATIENTS_TAB);
  if (!ordersSheet || !patientsSheet) throw new Error("Can't find the '" + CONFIG.ORDERS_TAB + "' and '" + CONFIG.PATIENTS_TAB + "' tabs — run this from the app's data spreadsheet.");
  var log = getLogSheet_(ss);
  var today = todayMs_();
  var plan = buildPlan_(rowsToObjects_(ordersSheet.getDataRange().getValues()), readPatients_(patientsSheet.getDataRange().getValues()), readSentKeys_(log), today, CONFIG);
  var now = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, "M/d/yyyy HH:mm");
  var result = { staffSent: false, patientSent: 0, patientPreview: 0, patientSkipped: 0, errors: 0 };

  // 1) staff digest — always real
  var digest = staffDigest_(plan.staff, today, CONFIG);
  if (digest && CONFIG.STAFF_EMAILS.length) {
    try {
      MailApp.sendEmail({ to: CONFIG.STAFF_EMAILS.join(","), subject: digest.subject, body: digest.body, name: CONFIG.CLINIC_NAME + " reminders" });
      result.staffSent = true;
    } catch (e) { result.errors++; log.appendRow([now, "staff", "digest|" + formatDate_(today), CONFIG.STAFF_EMAILS.join(","), "ERROR: " + e.message]); }
  }

  // 2) patient emails — preview until DRY_RUN_PATIENTS is false
  plan.patientEmails.forEach(function (pe) {
    var keyText = pe.keys.join(" ; ");
    if (!pe.to) { result.patientSkipped++; log.appendRow([now, "patient", keyText, "", "SKIPPED: no email on file for " + pe.patient]); return; }
    if (CONFIG.DRY_RUN_PATIENTS) { result.patientPreview++; log.appendRow([now, "patient", keyText, pe.to, "DRY RUN: would send — " + pe.lines.join(" | ")]); return; }
    if (MailApp.getRemainingDailyQuota() < 1) { result.errors++; log.appendRow([now, "patient", keyText, pe.to, "ERROR: daily email limit reached"]); return; }
    try {
      MailApp.sendEmail({ to: pe.to, subject: "A reminder from " + CONFIG.CLINIC_NAME, body: patientEmailBody_(pe.lines, CONFIG), replyTo: CONFIG.REPLY_TO, name: CONFIG.CLINIC_NAME });
      pe.keys.forEach(function (k) { log.appendRow([now, "patient", k, pe.to, "SENT"]); });
      result.patientSent++;
    } catch (e) { result.errors++; log.appendRow([now, "patient", keyText, pe.to, "ERROR: " + e.message]); }
  });
  Logger.log(JSON.stringify(result));
  return result;
}

// Sends a sample staff email to whoever is running the script, using today's real data.
function sendTestEmailToMe() {
  var me = Session.getActiveUser().getEmail();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var plan = buildPlan_(rowsToObjects_(ss.getSheetByName(CONFIG.ORDERS_TAB).getDataRange().getValues()), readPatients_(ss.getSheetByName(CONFIG.PATIENTS_TAB).getDataRange().getValues()), {}, todayMs_(), CONFIG);
  var digest = staffDigest_(plan.staff, todayMs_(), CONFIG) || { subject: CONFIG.CLINIC_NAME + " — daily reminders: nothing due", body: "Nothing is due, overdue or paused right now. The reminder script is working." };
  MailApp.sendEmail({ to: me, subject: "[TEST] " + digest.subject, body: digest.body });
  Logger.log("Test email sent to " + me);
}

// Run once: makes the script run every morning. Safe to run again — it replaces its own trigger.
function setupDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === "sendDailyReminders") ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger("sendDailyReminders").timeBased().everyDays(1).atHour(CONFIG.TRIGGER_HOUR).inTimezone(CONFIG.TIMEZONE).create();
  Logger.log("Daily reminders will run every day around " + CONFIG.TRIGGER_HOUR + ":00 (" + CONFIG.TIMEZONE + ").");
}
