// Computes a forecast-bias correction (adj) per Belgian-coast Antwerp spot by comparing
// Open-Meteo's historical model wind against real on-water/near-water MVB wind observations
// at the station used for the live wind badge (see fetch-antwerp-mvb.mjs SPOT_STATIONS).
// Same approach and same caveats as fetch-antwerp-calibration.mjs (the RWS/Dutch version):
// Open-Meteo's free archive is reanalysis (best-estimate of what happened), not an archive of
// past forecasts, but it captures the siting bias we actually care about (this grid cell reads
// systematically high/low vs. the real station), which is present in both the reanalysis and
// the live 16-day forecast since both come from the same model physics at the same point.
//
// Output: antwerp/mvb-calibration.json — suggested adj per spot per 8-point direction band.
// Kept as a SEPARATE file from the RWS side's calibration.json (different network, different
// credentials/workflow) — not auto-applied to spots-data.js, meant to be reviewed.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE_DIR = path.join(__dirname, '..', 'antwerp');
const SPOTS_PATH = path.join(SITE_DIR, 'spots-data.js');
const OUT_PATH = path.join(SITE_DIR, 'mvb-calibration.json');
const DEBUG_PATH = path.join(SITE_DIR, 'mvb-calibration-debug.json');

const BASE = 'https://api.meetnetvlaamsebanken.be';
const OPEN_METEO_ARCHIVE = 'https://archive-api.open-meteo.com/v1/archive';
const MS_TO_KN = 1.943844;
const LOOKBACK_DAYS = 90;

// Same wind stations as the live-data script (fetch-antwerp-mvb.mjs), confirmed live and
// checked for on-water siting quality (see project discussion — OMP/NP7 are the best
// available even though not all are strictly on-water; MP4 was chosen over ZWN for Knokke
// specifically because it's a genuine offshore measuring pile).
const SPOT_STATIONS = {
  oostende:          { windStation: 'OMP' },
  'knokke-cadzand':  { windStation: 'MP4' },
  'de-panne':        { windStation: 'NP7' },
  'bray-dunes':      { windStation: 'NP7' },
};

const DIR_BANDS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
function bandFor(deg) {
  return DIR_BANDS[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
}

function loadSpots() {
  const src = fs.readFileSync(SPOTS_PATH, 'utf8');
  const fn = new Function(`${src}\nreturn SPOTS;`);
  return fn();
}

async function login() {
  const username = process.env.MVB_USERNAME;
  const password = process.env.MVB_PASSWORD;
  if (!username || !password) throw new Error('MVB_USERNAME / MVB_PASSWORD environment variables are not set (add as GitHub repo secrets).');
  const body = new URLSearchParams({ grant_type: 'password', username, password });
  const resp = await fetch(`${BASE}/Token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`Login failed: HTTP ${resp.status}: ${text.slice(0, 300)}`);
  let json;
  try { json = JSON.parse(text); } catch { throw new Error(`Login response not JSON: ${text.slice(0, 300)}`); }
  if (!json.access_token) throw new Error(`Login response missing access_token: ${text.slice(0, 300)}`);
  return json.access_token;
}

async function postJson(urlPath, token, body) {
  const resp = await fetch(`${BASE}${urlPath}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${urlPath}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { throw new Error(`Non-JSON from ${urlPath}: ${text.slice(0, 300)}`); }
}

async function getJson(url) {
  const resp = await fetch(url);
  const text = await resp.text();
  if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${url}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

function isoNow() { return new Date().toISOString(); }
function isoDaysAgo(n) { return new Date(Date.now() - n * 86400000).toISOString(); }

async function fetchMvbSeries(token, id) {
  // Confirmed via MVB's published JSON schema (GetData_Request.json): the field names are
  // StartTime/EndTime, NOT From/Till (my first guess) — that mistake silently returned an
  // empty Values array rather than an error, which is why the first run came back empty.
  const body = { StartTime: isoDaysAgo(LOOKBACK_DAYS), EndTime: isoNow(), IDs: [id] };
  const resp = await postJson('/V2/getData', token, body);
  // Response shape confirmed via GetDataModel.json: { StartTime, EndTime, Intervals,
  // Values: [ { ID, StartTime, EndTime, MinValue, MaxValue, Values: [{Timestamp, Value}] } ] }
  return resp;
}

async function fetchOpenMeteoArchive(lat, lon) {
  const start = isoDaysAgo(LOOKBACK_DAYS).slice(0, 10);
  const end = new Date().toISOString().slice(0, 10);
  const url = `${OPEN_METEO_ARCHIVE}?latitude=${lat}&longitude=${lon}&start_date=${start}&end_date=${end}` +
    `&hourly=wind_speed_10m,wind_direction_10m&wind_speed_unit=kn&timezone=UTC`;
  return getJson(url);
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Normalize whatever getData actually returns into a Map<hourKeyISO, {speed?, dir?}>.
// hourKey = ISO string sliced to hour, e.g. "2026-08-05T11".
function extractHourlySeries(raw, debugOut) {
  debugOut.rawTopLevelKeys = raw && typeof raw === 'object' ? Object.keys(raw) : typeof raw;
  // Try common shapes.
  let series = null;
  if (Array.isArray(raw)) series = raw;
  else if (raw && Array.isArray(raw.Values)) series = raw.Values;
  else if (raw && Array.isArray(raw.Data)) series = raw.Data;
  if (!series) return { byHour: new Map(), sample: null };

  // Each entry might itself be {ID, Values:[{Timestamp,Value}]} (one per requested ID) or
  // already be a flat list of {Timestamp,Value} points.
  let points = [];
  if (series.length && series[0] && Array.isArray(series[0].Values)) {
    points = series[0].Values;
  } else if (series.length && series[0] && Array.isArray(series[0].Data)) {
    points = series[0].Data;
  } else {
    points = series;
  }
  debugOut.pointSample = points.slice(0, 3);

  const byHour = new Map();
  for (const p of points) {
    const ts = p.Timestamp ?? p.Datum ?? p.timestamp ?? p.Date;
    const val = p.Value ?? p.Value1 ?? p.value;
    if (ts == null || val == null) continue;
    const hourKey = String(ts).slice(0, 13);
    byHour.set(hourKey, Number(val));
  }
  return { byHour, sample: points.slice(0, 3) };
}

async function main() {
  const allSpots = loadSpots();
  const debug = { generatedAt: isoNow(), lookbackDays: LOOKBACK_DAYS, spots: {} };
  const results = {};

  let token;
  try {
    console.log('Logging in...');
    token = await login();
  } catch (e) {
    debug.error = String(e && e.message || e);
    console.error('FATAL:', e);
    fs.writeFileSync(DEBUG_PATH, JSON.stringify(debug, null, 2));
    process.exitCode = 1;
    return;
  }

  for (const [spotId, s] of Object.entries(SPOT_STATIONS)) {
    const spot = allSpots.find(sp => sp.id === spotId);
    if (!spot) { console.log(`${spotId}: not found in spots-data.js — skipping`); continue; }

    debug.spots[spotId] = { windStation: s.windStation };
    console.log(`\n${spotId}: fetching ${s.windStation}WVC / ${s.windStation}WRS (${LOOKBACK_DAYS}d) + Open-Meteo archive...`);

    let speedRaw, dirRaw, archive;
    try {
      [speedRaw, dirRaw, archive] = await Promise.all([
        fetchMvbSeries(token, `${s.windStation}WVC`),
        fetchMvbSeries(token, `${s.windStation}WRS`),
        fetchOpenMeteoArchive(spot.lat, spot.lon),
      ]);
    } catch (e) {
      console.log(`  ! fetch failed: ${e.message}`);
      debug.spots[spotId].error = e.message;
      continue;
    }

    const speedExtract = extractHourlySeries(speedRaw, debug.spots[spotId].speedExtractDebug = {});
    const dirExtract = extractHourlySeries(dirRaw, debug.spots[spotId].dirExtractDebug = {});
    debug.spots[spotId].speedHourCount = speedExtract.byHour.size;
    debug.spots[spotId].dirHourCount = dirExtract.byHour.size;
    debug.spots[spotId].archiveHourlyLength = archive?.hourly?.time?.length ?? null;

    console.log(`  MVB: ${speedExtract.byHour.size} speed hours, ${dirExtract.byHour.size} direction hours`);
    console.log(`  Open-Meteo archive: ${debug.spots[spotId].archiveHourlyLength ?? 0} hourly points`);

    if (!speedExtract.byHour.size || !dirExtract.byHour.size || !debug.spots[spotId].archiveHourlyLength) {
      console.log('  Not enough data to compute bias for this spot yet — see debug for raw response shape.');
      continue;
    }

    const forecastByHour = new Map();
    archive.hourly.time.forEach((t, i) => {
      forecastByHour.set(t.slice(0, 13), {
        speed: archive.hourly.wind_speed_10m[i],
        dir: archive.hourly.wind_direction_10m[i],
      });
    });

    const bandDeltas = {};
    DIR_BANDS.forEach(b => bandDeltas[b] = []);
    let pairedCount = 0;
    let droppedImplausible = 0;

    for (const [hourKey, actualSpeedMs] of speedExtract.byHour) {
      const actualDir = dirExtract.byHour.get(hourKey);
      const fc = forecastByHour.get(hourKey);
      if (actualDir == null || !fc || fc.speed == null) continue;
      const actualSpeedKn = actualSpeedMs * MS_TO_KN;
      if (!(actualSpeedKn >= 0 && actualSpeedKn < 80) || Math.abs(actualSpeedKn - fc.speed) > 40) {
        droppedImplausible++;
        continue;
      }
      const band = bandFor(actualDir);
      bandDeltas[band].push(actualSpeedKn - fc.speed);
      pairedCount++;
    }
    if (droppedImplausible) console.log(`  Dropped ${droppedImplausible} implausible hour(s) as likely data errors.`);
    debug.spots[spotId].pairedHourCount = pairedCount;
    debug.spots[spotId].droppedImplausible = droppedImplausible;
    console.log(`  Paired ${pairedCount} hours of actual-vs-forecast.`);

    const bandAdj = {};
    for (const band of DIR_BANDS) {
      const deltas = bandDeltas[band];
      if (deltas.length >= 5) {
        bandAdj[band] = { adj: Math.round(median(deltas)), sampleCount: deltas.length };
      } else {
        bandAdj[band] = { adj: null, sampleCount: deltas.length, note: 'fewer than 5 samples, not enough to trust yet' };
      }
    }
    results[spotId] = { windStation: s.windStation, pairedHourCount: pairedCount, bandAdj };
    console.log('  Band adj:', JSON.stringify(bandAdj));
  }

  fs.writeFileSync(DEBUG_PATH, JSON.stringify(debug, null, 2));
  fs.writeFileSync(OUT_PATH, JSON.stringify({ generatedAt: isoNow(), lookbackDays: LOOKBACK_DAYS, spots: results }, null, 2));
  console.log(`\nWrote ${OUT_PATH} and ${DEBUG_PATH}`);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});
