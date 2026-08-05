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

// Our 3 Belgian coast spots (from spots-data.js) — kept here too so this discovery script
// can independently report nearest-station candidates without depending on the site's schema.
const BE_SPOTS = {
  oostende: { lat: 51.2278, lon: 2.9166 },
  'knokke-cadzand': { lat: 51.3700, lon: 3.3900 },
  'de-panne': { lat: 51.0937, lon: 2.5836 },
  'bray-dunes': { lat: 51.0765, lon: 2.5175 }, // FR, using nearest BE station as proxy
};

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371, toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// PositionWKT looks like "POINT (lon lat)" (confirmed via ProjectionWKT: WGS84/EPSG:4326).
function parseWktPoint(wkt) {
  const m = /POINT \(([-\d.]+) ([-\d.]+)\)/.exec(wkt || '');
  return m ? { lon: Number(m[1]), lat: Number(m[2]) } : null;
}

function nameOf(entry, culture = 'en-GB') {
  const n = (entry.Name || []).find(x => x.Culture === culture) || (entry.Name || [])[0];
  return n ? n.Message : entry.ID;
}

async function run(debug) {
  console.log('Logging in...');
  const token = await login(debug);
  console.log('Login OK, token acquired.');

  console.log('Fetching /V2/catalog...');
  const catalog = await getJson('/V2/catalog', token);
  debug.catalogTopLevelKeys = Object.keys(catalog);

  const locations = catalog.Locations || [];
  const parameters = catalog.Parameters || [];
  const available = catalog.AvailableData || [];

  // Full parameter list — this is what we actually need (only 22 total, cheap to keep all of).
  debug.allParameters = parameters.map(p => ({ ID: p.ID, name: nameOf(p), unit: p.Unit, typeId: p.ParameterTypeID }));
  const paramNameById = {};
  for (const p of debug.allParameters) paramNameById[p.ID] = p.name;

  // Full location list with parsed coordinates and which parameters each one publishes.
  const availByLocation = {};
  for (const a of available) {
    (availByLocation[a.Location] ||= []).push(`${a.Parameter} (${paramNameById[a.Parameter] || '?'})`);
  }
  debug.allLocations = locations.map(loc => {
    const pos = parseWktPoint(loc.PositionWKT);
    return { ID: loc.ID, name: nameOf(loc), lat: pos?.lat, lon: pos?.lon, parameters: availByLocation[loc.ID] || [] };
  });

  // Nearest stations to each of our 3 (+1 proxy) Belgian spots.
  debug.nearestPerSpot = {};
  for (const [spotId, spot] of Object.entries(BE_SPOTS)) {
    const ranked = debug.allLocations
      .filter(l => l.lat != null && l.lon != null)
      .map(l => ({ ...l, distKm: haversineKm(spot.lat, spot.lon, l.lat, l.lon) }))
      .sort((a, b) => a.distKm - b.distKm)
      .slice(0, 5)
      .map(l => ({ ID: l.ID, name: l.name, distKm: Math.round(l.distKm * 10) / 10, parameters: l.parameters }));
    debug.nearestPerSpot[spotId] = ranked;
    console.log(`${spotId}: nearest = ${ranked[0]?.ID} (${ranked[0]?.name}, ${ranked[0]?.distKm}km) with params [${ranked[0]?.parameters.join(', ')}]`);
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
