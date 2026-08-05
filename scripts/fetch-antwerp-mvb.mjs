// Belgian coast (Meetnet Vlaamse Banken) live data for Oostende, Knokke-Heist/Cadzand, and
// De Panne, plus Bray-Dunes (FR) as a proxy since no BE/NL network reaches French waters.
//
// MVB requires an authenticated login for any real data (confirmed earlier: /V2/ping works
// anonymously, /V2/catalog returns 401 without a token). Credentials come from
// MVB_USERNAME / MVB_PASSWORD environment variables (GitHub Actions repo secrets) — never
// written to any committed file. This script only runs server-side (GitHub Actions), same
// reasoning as the RWS pipeline, so the token never has to reach the browser.
//
// FIRST PASS: this is a discovery run. We don't yet know MVB's exact catalog field names,
// units, or ID scheme for requesting data, so rather than guess (which cost a lot of
// back-and-forth on the RWS side), this dumps the real catalog shape to antwerp/mvb-debug.json
// so the actual fetch logic can be written against facts, not assumptions.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE_DIR = path.join(__dirname, '..', 'antwerp');
const DEBUG_PATH = path.join(SITE_DIR, 'mvb-debug.json');

const BASE = 'https://api.meetnetvlaamsebanken.be';

async function login(debug) {
  const username = process.env.MVB_USERNAME;
  const password = process.env.MVB_PASSWORD;
  debug.hasUsername = !!username;
  debug.hasPassword = !!password;
  debug.usernameLength = username ? username.length : 0; // length only, never the value
  if (!username || !password) {
    throw new Error('MVB_USERNAME / MVB_PASSWORD environment variables are not set (add as GitHub repo secrets).');
  }
  const body = new URLSearchParams({ grant_type: 'password', username, password });
  // Login is NOT versioned — /Token, not /V2/Token (confirmed: the latter 404s).
  const resp = await fetch(`${BASE}/Token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const text = await resp.text();
  debug.loginStatus = resp.status;
  // Never log the response body verbatim in case it ever echoes anything sensitive — but MVB's
  // error shape so far has just been {"Message": "..."}, safe to keep for diagnosis.
  debug.loginResponsePreview = text.slice(0, 300);
  if (!resp.ok) throw new Error(`Login failed: HTTP ${resp.status}: ${text.slice(0, 300)}`);
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`Login response not JSON: ${text.slice(0, 300)}`); }
  if (!json.access_token) throw new Error(`Login response missing access_token: ${text.slice(0, 300)}`);
  return json.access_token;
}

async function getJson(urlPath, token) {
  const resp = await fetch(`${BASE}${urlPath}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${urlPath}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { throw new Error(`Non-JSON from ${urlPath}: ${text.slice(0, 300)}`); }
}

async function run(debug) {
  console.log('Logging in...');
  const token = await login(debug);
  console.log('Login OK, token acquired.');

  console.log('Checking /V2/ping with token...');
  const ping = await getJson('/V2/ping', token);
  debug.ping = ping;
  console.log('Ping:', JSON.stringify(ping));

  console.log('Fetching /V2/catalog...');
  const catalog = await getJson('/V2/catalog', token);
  debug.catalogTopLevelKeys = Object.keys(catalog);

  // Try to find whatever the locations / parameters / available-data lists are called —
  // field names are unconfirmed, so inspect broadly rather than assume.
  for (const key of Object.keys(catalog)) {
    const val = catalog[key];
    if (Array.isArray(val)) {
      debug[`${key}_length`] = val.length;
      debug[`${key}_sample`] = val.slice(0, 3);
    } else {
      debug[`${key}_value`] = val;
    }
  }
}

async function main() {
  const debug = { generatedAt: new Date().toISOString() };
  try {
    await run(debug);
  } catch (err) {
    debug.error = String(err && err.message || err);
    console.error('FATAL:', err);
    process.exitCode = 1;
  } finally {
    // Always write whatever we learned, success or failure — this is a discovery script,
    // the partial state IS the useful output when something goes wrong.
    fs.writeFileSync(DEBUG_PATH, JSON.stringify(debug, null, 2));
    console.log(`Wrote ${DEBUG_PATH}`);
  }
}

main();
