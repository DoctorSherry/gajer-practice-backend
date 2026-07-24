# The Gajer Practice — Backend

Netlify Functions that connect the peptide app to your real Google Sheets
(vendor pricing + protocols) and store patient quote history — replacing the
per-browser `window.storage` the prototype used.

## What this gives you

- `GET /api/catalog` — live-reads your vendor + protocol sheets, merges them
  the same way the app's CSV importer does (forgiving of inexact column
  names, matches peptide names across sheets even if punctuation differs).
- `GET/POST /api/patients` — list known patient IDs / create a new one.
- `GET/POST /api/quotes` — a patient's quote history (append-only) / save a
  new quote. **The "doctor" on every record comes from the verified Google
  Sign-In token, not a typed name field** — this closes the gap where anyone
  could type any doctor's name in the old prototype.

## 1. Google Cloud project + service account (for reading/writing Sheets)

1. Go to [console.cloud.google.com](https://console.cloud.google.com) →
   create a new project (e.g. "Gajer Practice App").
2. **APIs & Services → Library** → enable **Google Sheets API**.
3. **APIs & Services → Credentials → Create Credentials → Service account**.
   Name it anything (e.g. `gajer-app-sheets`). No roles needed at the
   project level — access is granted per-sheet in step 3 below.
4. Open the service account → **Keys → Add key → Create new key → JSON**.
   This downloads a `.json` file — keep it private, never commit it.
5. From that JSON file you need two values for your `.env`:
   - `client_email` → `GOOGLE_SERVICE_ACCOUNT_EMAIL`
   - `private_key` → `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` (keep the `\n`s as
     literal `\n` characters, wrapped in quotes)

## 2. Share your existing sheets with the service account

1. Open your **vendor pricing sheet** in Google Sheets → **Share** → paste
   the `client_email` from step 1 → give it **Viewer** access.
2. Do the same for your **protocol sheet**.
3. Copy each sheet's ID from its URL:
   `https://docs.google.com/spreadsheets/d/`**`THIS_PART`**`/edit`
   → these go in `VENDOR_SHEET_ID` and `PROTOCOL_SHEET_ID`.
4. If a tab isn't named "Sheet1", update `VENDOR_RANGE` / `PROTOCOL_RANGE`
   to match (just the tab name is enough, e.g. `Healing Biologix Vials`).

## 3. Create one new sheet for patient records

Create a new, blank Google Sheet (e.g. "Gajer Practice — App Data") with
two tabs:

**Tab "Patients"** — header row:
```
PatientID | CreatedBy | CreatedAt
```

**Tab "Quotes"** — header row:
```
QuoteID | PatientID | Type | BlendName | Doctor | Timestamp | LinesJSON | ScheduleJSON | TotalOffice | TotalPatient
```

Share this sheet with the same service account email, this time with
**Editor** access (it needs to write rows). Copy its ID into
`APP_DATA_SHEET_ID`.

> This sheet is the practice's real patient data. Treat sharing on it the
> same way you'd treat access to a chart — don't add anyone here as
> "Editor" who shouldn't be able to see quote history.

## 4. Google Sign-In (restricts the app to @thegajerpractice.com)

1. Same Google Cloud project → **APIs & Services → Credentials → Create
   Credentials → OAuth client ID**.
2. Application type: **Web application**.
3. **Authorized JavaScript origins**: add your Netlify URL, e.g.
   `https://gajer-practice-app.netlify.app` (and `http://localhost:8888`
   for local testing).
4. Copy the **Client ID** into `GOOGLE_OAUTH_CLIENT_ID`.
5. Leave `ALLOWED_DOMAIN=thegajerpractice.com` as-is — this is what actually
   blocks non-practice Google accounts from signing in, independent of the
   frontend.

> Note: this only works cleanly if your team is on **Google Workspace**
> (not personal @gmail accounts) — the domain check relies on Google's
> `hd` (hosted domain) claim, which personal accounts don't have.

## 5. Deploy to Netlify

```bash
npm install
netlify login
netlify init          # link this folder to your Netlify site
netlify env:import .env   # after filling in your real .env from .env.example
netlify deploy --prod
```

Or set the same variables under **Site settings → Environment variables**
in the Netlify dashboard instead of `netlify env:import`.

## 6. Test it

```bash
curl https://your-site.netlify.app/api/catalog \
  -H "Authorization: Bearer <a real Google ID token>"
```

You'll get a 401 without a valid token — that's the auth check working.
The frontend (next step) will supply this automatically once Google
Sign-In is wired in.

## What's NOT in this repo yet

- The frontend still needs to be updated to: (a) show a "Sign in with
  Google" button instead of the free-text doctor name field, and (b) call
  `/api/catalog`, `/api/patients`, `/api/quotes` instead of
  `window.storage`. That's the next piece — say the word and I'll wire it
  into the app artifact.
- Rate limiting / abuse protection on the endpoints (fine at single-practice
  scale, worth adding if this ever gets exposed more broadly).
- Editing/undo for quotes — by design, everything is append-only, matching
  the immutable-history requirement from the original proposal.
