// Belgian coast (Meetnet Vlaamse Banken) live water temperature for Oostende, Knokke-Heist/
// Cadzand, De Panne, and Bray-Dunes (FR — no BE/NL network reaches French waters, using the
// nearest BE station as a proxy). Writes antwerp/mvb-live.json — kept SEPARATE from the RWS
// pipeline's antwerp/live.json so the two workflows (different secrets, different schedules)
// never touch the same file and can't collide. The site merges both client-side.
//
// Station/parameter codes below were confirmed via a discovery pass against the real MVB
// catalog, THEN cross-checked against a live /V2/currentData response (2026-08-05) — the
// catalog lists more AvailableData combos than are actually publishing right now, so a few
// of the closest-on-paper stations (OS7, ONS, ZHG) turned out to have no live series and were
// swapped for the nearest station that IS live:
//   Oostende:        wind OMP "Ostend - Weather station" (1.4km, live), water temp OST "Ostend eastern palisade - Buoy" (2.3km, live)
//   Knokke/Cadzand:  wind MP4 "Scheur Wielingen - Measuring pile" (8.3km, live, genuinely offshore — swapped from ZWN "Zwin - Weather station" which is land-sited near the Zwin nature reserve), water temp SWI "Scheur Wielingen - Buoy" (7.0km, live, same offshore area as MP4)
//   De Panne:        wind NP7 (11.6km, live), water temp TRG (4.9km, live)
//   Bray-Dunes (FR):  wind NP7 (16.5km, proxy), water temp TRG (8.2km, proxy)
// Parameter WVC (wind speed) and WC3 (gust) are in m/s — MVB does not offer knots directly.
// NOTE: /V2/currentData?ids=... does NOT filter server-side — it returns ALL ~176 live series
// regardless of the ids= param. This script requests the narrower list anyway (harmless, and
// documents intent) but filters client-side against SPOT_STATIONS after the fact.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE_DIR = path.join(__dirname, '..', 'antwerp');
const OUT_PATH = path.join(SITE_DIR, 'mvb-live.json');
const DEBUG_PATH = path.join(SITE_DIR, 'mvb-debug.json');

const BASE = 'https://api.meetnetvlaamsebanken.be';
const MS_TO_KN = 1.943844;

const SPOT_STATIONS = {
  oostende:          { windStation: 'OMP', tempStation: 'OST' },
  'knokke-cadzand':  { windStation: 'MP4', tempStation: 'SWI' },
  'de-panne':        { windStation: 'NP7', tempStation: 'TRG' },
  'bray-dunes':      { windStation: 'NP7', tempStation: 'TRG' },
};

async function login() {
  const username = process.env.MVB_USERNAME;
  const password = process.env.MVB_PASSWORD;
  if (!username || !password) throw new Error('MVB_USERNAME / MVB_PASSWORD not set.');
  const body = new URLSearchParams({ grant_type: 'password', username, password });
  const resp = await fetch(`${BASE}/Token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`Login failed: HTTP ${resp.status}: ${text.slice(0, 300)}`);
  const json = JSON.parse(text);
  if (!json.access_token) throw new Error(`Login response missing access_token`);
  return json.access_token;
}

async function getJson(urlPath, token) {
  const resp = await fetch(`${BASE}${urlPath}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${urlPath}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

async function main() {
  const debug = { generatedAt: new Date().toISOString() };
  const results = {};
  try {
    console.log('Logging in...');
    const token = await login();

    // AvailableData IDs are Location+Parameter concatenated, e.g. "OS7WVC".
    const ids = new Set();
    for (const s of Object.values(SPOT_STATIONS)) {
      ids.add(`${s.windStation}WVC`);
      ids.add(`${s.windStation}WRS`);
      ids.add(`${s.tempStation}TZW`);
    }
    const idList = [...ids];
    debug.requestedIds = idList;

    console.log(`Fetching current data for ${idList.length} series...`);
    const current = await getJson(`/V2/currentData?ids=${idList.join(',')}`, token);
    debug.currentDataRaw = current;

    // Response shape unconfirmed until this runs — inspect defensively.
    const list = Array.isArray(current) ? current : (current.Values || current.Data || []);
    debug.currentDataListLength = Array.isArray(list) ? list.length : null;

    const byId = {};
    for (const entry of list) {
      const id = entry.ID || entry.Id || entry.AvailableDataID;
      if (id) byId[id] = entry;
    }
    debug.byIdKeys = Object.keys(byId);

    for (const [spotId, s] of Object.entries(SPOT_STATIONS)) {
      const tempEntry = byId[`${s.tempStation}TZW`];
      const windSpeedEntry = byId[`${s.windStation}WVC`];
      const windDirEntry = byId[`${s.windStation}WRS`];

      const tempVal = tempEntry && (tempEntry.Value ?? tempEntry.Value1 ?? tempEntry.value);
      const tempTs = tempEntry && (tempEntry.Timestamp ?? tempEntry.Datum ?? tempEntry.timestamp);

      if (tempVal != null) {
        results[spotId] = {
          waterTempC: Number(tempVal),
          ts: tempTs,
          stationCode: s.tempStation,
        };
      }
      if (windSpeedEntry && windSpeedEntry.Value != null) {
        results[spotId] = results[spotId] || {};
        results[spotId].windSpeedKn = Number(windSpeedEntry.Value) * MS_TO_KN;
        results[spotId].windDir = windDirEntry ? Number(windDirEntry.Value) : null;
        results[spotId].windStationCode = s.windStation;
      }
      console.log(`${spotId}: ${JSON.stringify(results[spotId] || 'no data')}`);
    }
  } catch (e) {
    debug.error = String(e && e.message || e);
    console.error('FATAL:', e);
    process.exitCode = 1;
  } finally {
    fs.writeFileSync(DEBUG_PATH, JSON.stringify(debug, null, 2));
    fs.writeFileSync(OUT_PATH, JSON.stringify({ generatedAt: new Date().toISOString(), spots: results }, null, 2));
    console.log(`Wrote ${OUT_PATH} and ${DEBUG_PATH}`);
  }
}

main();
