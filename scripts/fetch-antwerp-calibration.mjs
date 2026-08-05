// Computes a forecast-bias correction (adj) per Antwerp spot by comparing Open-Meteo's
// historical model wind against real on-water RWS wind observations at the same station
// used for the water-temperature live badge. This does NOT compare "what was forecast N
// days ahead" — Open-Meteo's free archive only offers reanalysis (best-estimate of what
// actually happened), not archived past forecasts. What this DOES correctly capture is the
// dominant source of error we care about: the model's grid cell for a given spot is
// systematically too high/low because of local terrain, lake vs. open-sea roughness, etc.
// That's a siting bias, and it's present in both the reanalysis and the live 16-day forecast
// the site uses, since both come from the same underlying model physics at the same point.
//
// Output: antwerp/calibration.json — suggested adj per spot per 8-point direction band.
// This is NOT auto-applied to spots-data.js; it's meant to be reviewed, same spirit as the
// Sydney site's calibrate.html "recommended adj" table.
//
// Belgian coast (MVB) spots are not included yet — same reason as the water-temp script.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE_DIR = path.join(__dirname, '..', 'antwerp');
const SPOTS_PATH = path.join(SITE_DIR, 'spots-data.js');
const OUT_PATH = path.join(SITE_DIR, 'calibration.json');
const DEBUG_PATH = path.join(SITE_DIR, 'calibration-debug.json');

const RWS_BASE = 'https://ddapi20-waterwebservices.rijkswaterstaat.nl';
const CATALOG_URL = `${RWS_BASE}/METADATASERVICES/OphalenCatalogus`;
const OBS_URL = `${RWS_BASE}/ONLINEWAARNEMINGENSERVICES/OphalenWaarnemingen`;
const LATEST_URL = `${RWS_BASE}/ONLINEWAARNEMINGENSERVICES/OphalenLaatsteWaarnemingen`;
const OPEN_METEO_ARCHIVE = 'https://archive-api.open-meteo.com/v1/archive';

const LOOKBACK_DAYS = 90;
const MAX_AGE_HOURS = 48;
const SEARCH_RADIUS_KM = 60;

// The water-temp station for a spot isn't necessarily wind-equipped (confirmed: Bommenede and
// Kamperland/Schotsman are temperature-only — only Marollegat happens to carry a full sensor
// suite). So wind stations are discovered independently per spot, same "batch nearby
// candidates, keep the nearest one that's actually reporting" approach proven in
// fetch-antwerp-live.mjs, just against the WINDSHD/LT metadata instead of OW/T.
function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371, toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

async function findWindStation(catalog, spot, speedMeta, debugOut) {
  const locations = catalog.LocatieLijst || [];
  const candidates = locations
    .map(loc => ({
      loc,
      distKm: (typeof loc.Lat === 'number' && typeof loc.Lon === 'number')
        ? haversineKm(spot.lat, spot.lon, loc.Lat, loc.Lon) : Infinity,
    }))
    .filter(c => c.distKm < SEARCH_RADIUS_KM)
    .sort((a, b) => a.distKm - b.distKm)
    .slice(0, 25);

  if (!candidates.length) {
    debugOut.windStationSearch = { candidateCount: 0 };
    return null;
  }

  const byCode = {};
  for (const c of candidates) byCode[c.loc.Code] = c;

  const obs = await postJson(LATEST_URL, {
    LocatieLijst: candidates.map(c => ({ Code: c.loc.Code })),
    AquoPlusWaarnemingMetadataLijst: [{ AquoMetadata: { Compartiment: speedMeta.Compartiment, Grootheid: speedMeta.Grootheid } }],
  });

  const scored = (obs.WaarnemingenLijst || [])
    .map(series => {
      const events = series.MetingenLijst;
      const last = events && events.length ? events[events.length - 1] : null;
      if (!last) return null;
      const code = series.Locatie && series.Locatie.Code;
      const ageHours = (Date.now() - new Date(last.Tijdstip).getTime()) / 3.6e6;
      return { code, ageHours, distKm: byCode[code] ? byCode[code].distKm : Infinity };
    })
    .filter(Boolean)
    .sort((a, b) => {
      const aOk = a.ageHours >= 0 && a.ageHours < MAX_AGE_HOURS;
      const bOk = b.ageHours >= 0 && b.ageHours < MAX_AGE_HOURS;
      if (aOk !== bOk) return aOk ? -1 : 1;
      if (aOk && bOk) return a.distKm - b.distKm;
      return a.ageHours - b.ageHours;
    });

  debugOut.windStationSearch = {
    candidateCount: candidates.length,
    windEquippedCount: scored.length,
    top5: scored.slice(0, 5).map(s => ({ code: s.code, ageHours: Math.round(s.ageHours), distKm: Math.round(s.distKm) })),
  };

  const best = scored.find(s => s.ageHours >= 0 && s.ageHours < MAX_AGE_HOURS);
  return best ? best.code : null;
}

const DIR_BANDS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
function bandFor(deg) {
  return DIR_BANDS[Math.round(((deg % 360) + 360) % 360 / 45) % 8];
}

function loadSpots() {
  const src = fs.readFileSync(SPOTS_PATH, 'utf8');
  const fn = new Function(`${src}\nreturn SPOTS;`);
  return fn();
}

async function postJson(url, body) {
  const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${url}: ${text.slice(0, 500)}`);
  try { return JSON.parse(text); } catch { throw new Error(`Non-JSON from ${url}: ${text.slice(0, 500)}`); }
}

async function getJson(url) {
  const resp = await fetch(url);
  const text = await resp.text();
  if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${url}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

function isoNow() { return new Date().toISOString(); }
function isoDaysAgo(n) { return new Date(Date.now() - n * 86400000).toISOString(); }

async function discoverWindGrootheden(catalog) {
  const all = catalog.AquoMetadataLijst || [];
  const speed = all.find(m => /windsnelheid/i.test(m.Grootheid?.Omschrijving || '') && (m.Compartiment?.Code === 'LT'));
  const dir = all.find(m => /windrichting/i.test(m.Grootheid?.Omschrijving || '') && (m.Compartiment?.Code === 'LT'));
  return {
    speed: speed ? { Compartiment: speed.Compartiment, Grootheid: speed.Grootheid, Eenheid: speed.Eenheid } : null,
    dir: dir ? { Compartiment: dir.Compartiment, Grootheid: dir.Grootheid, Eenheid: dir.Eenheid } : null,
    speedSampleCount: all.filter(m => /windsnelheid/i.test(m.Grootheid?.Omschrijving || '')).length,
    dirSampleCount: all.filter(m => /windrichting/i.test(m.Grootheid?.Omschrijving || '')).length,
  };
}

async function fetchRwsSeries(stationCode, metadata) {
  const body = {
    Locatie: { Code: stationCode },
    AquoPlusWaarnemingMetadata: { AquoMetadata: { Compartiment: metadata.Compartiment, Grootheid: metadata.Grootheid } },
    Periode: { Begindatumtijd: isoDaysAgo(LOOKBACK_DAYS), Einddatumtijd: isoNow() },
  };
  const resp = await postJson(OBS_URL, body);
  const series = (resp.WaarnemingenLijst || [])[0];
  return series ? (series.MetingenLijst || []) : [];
}

async function fetchOpenMeteoArchive(lat, lon) {
  const start = isoDaysAgo(LOOKBACK_DAYS).slice(0, 10);
  const end = new Date().toISOString().slice(0, 10);
  const url = `${OPEN_METEO_ARCHIVE}?latitude=${lat}&longitude=${lon}&start_date=${start}&end_date=${end}` +
    `&hourly=wind_speed_10m,wind_direction_10m&wind_speed_unit=kn&timezone=UTC`;
  return getJson(url);
}

async function main() {
  const allSpots = loadSpots();
  const debug = { generatedAt: isoNow(), lookbackDays: LOOKBACK_DAYS };

  console.log('Fetching RWS catalog to discover wind Grootheid codes...');
  const catalog = await postJson(CATALOG_URL, { CatalogusFilter: { Compartimenten: true, Grootheden: true } });
  const windMeta = await discoverWindGrootheden(catalog);
  debug.windMetaDiscovery = windMeta;
  console.log('Wind speed metadata:', JSON.stringify(windMeta.speed));
  console.log('Wind direction metadata:', JSON.stringify(windMeta.dir));

  if (!windMeta.speed || !windMeta.dir) {
    console.log('Could not discover wind speed/direction Grootheid codes — aborting, see calibration-debug.json');
    fs.writeFileSync(DEBUG_PATH, JSON.stringify(debug, null, 2));
    return;
  }

  const results = {};
  debug.spots = {};
  // Only the 4 Dutch spots have an RWS-network station at all (Belgian coast is MVB, separate).
  const nlSpotIds = ['brouwersdam-lake', 'brouwersdam-sea', 'veerse-meer', 'oesterdam'];

  for (const spotId of nlSpotIds) {
    const spot = allSpots.find(s => s.id === spotId);
    if (!spot) { console.log(`\n${spotId}: not found in spots-data.js — skipping`); continue; }

    debug.spots[spotId] = {};
    console.log(`\n${spotId}: searching for a wind-equipped station nearby...`);
    let stationCode;
    try {
      stationCode = await findWindStation(catalog, spot, windMeta.speed, debug.spots[spotId]);
    } catch (e) {
      console.log(`  ! station search failed: ${e.message}`);
      debug.spots[spotId] = { error: e.message };
      continue;
    }
    if (!stationCode) {
      const nearest = debug.spots[spotId].windStationSearch?.top5?.[0];
      const nearestNote = nearest ? ` Nearest wind-equipped station (${nearest.code}) is ${Math.round(nearest.ageHours / 24)} days stale — looks decommissioned, not a search bug.` : '';
      console.log(`  No wind-equipped station found within ${SEARCH_RADIUS_KM}km with a reading newer than ${MAX_AGE_HOURS}h.${nearestNote}`);
      continue;
    }
    console.log(`  -> using ${stationCode}`);

    let speedObs, dirObs, archive;
    try {
      [speedObs, dirObs, archive] = await Promise.all([
        fetchRwsSeries(stationCode, windMeta.speed),
        fetchRwsSeries(stationCode, windMeta.dir),
        fetchOpenMeteoArchive(spot.lat, spot.lon),
      ]);
    } catch (e) {
      console.log(`  ! fetch failed: ${e.message}`);
      debug.spots[spotId] = { ...debug.spots[spotId], error: e.message };
      continue;
    }

    debug.spots[spotId] = {
      ...debug.spots[spotId],
      stationCode,
      speedObsCount: speedObs.length,
      dirObsCount: dirObs.length,
      speedSample: speedObs.slice(0, 2),
      dirSample: dirObs.slice(0, 2),
      archiveTopKeys: Object.keys(archive || {}),
      archiveHourlyKeys: archive && archive.hourly ? Object.keys(archive.hourly) : null,
      archiveHourlyLength: archive && archive.hourly && archive.hourly.time ? archive.hourly.time.length : null,
    };

    console.log(`  RWS: ${speedObs.length} speed readings, ${dirObs.length} direction readings`);
    console.log(`  Open-Meteo archive: ${debug.spots[spotId].archiveHourlyLength ?? 0} hourly points`);

    if (!speedObs.length || !dirObs.length || !debug.spots[spotId].archiveHourlyLength) {
      console.log('  Not enough data to compute bias for this spot yet.');
      continue;
    }

    // RWS flags each reading with a quality code; "99" means gap/missing-value sentinel and
    // can carry a garbage numeric value (this is what produced one absurd 63kn "adjustment"
    // in an earlier run — a handful of sentinel values dragging a band's average). Per RWS's
    // own docs, only these codes are considered trustworthy.
    const OK_QUALITY = new Set(['00', '10', '20', '25', '30', '40']);
    const isGoodReading = o => OK_QUALITY.has(o.WaarnemingMetadata?.Kwaliteitswaardecode);

    // Index actual dir readings by hour so we can pair with speed readings and archive.
    const dirByHour = new Map();
    for (const d of dirObs) {
      if (!isGoodReading(d)) continue;
      const hourKey = d.Tijdstip.slice(0, 13);
      dirByHour.set(hourKey, Number(d.Meetwaarde?.Waarde_Numeriek));
    }
    const speedByHour = new Map();
    for (const sObs of speedObs) {
      if (!isGoodReading(sObs)) continue;
      const hourKey = sObs.Tijdstip.slice(0, 13);
      // Multiple 10-min readings per hour — keep the last one seen for that hour.
      speedByHour.set(hourKey, Number(sObs.Meetwaarde?.Waarde_Numeriek));
    }
    const forecastByHour = new Map();
    archive.hourly.time.forEach((t, i) => {
      const hourKey = t.replace('T', 'T').slice(0, 13); // ISO already at hour granularity
      forecastByHour.set(hourKey, {
        speed: archive.hourly.wind_speed_10m[i],
        dir: archive.hourly.wind_direction_10m[i],
      });
    });

    const bandDeltas = {};
    DIR_BANDS.forEach(b => bandDeltas[b] = []);
    let pairedCount = 0;

    let droppedImplausible = 0;
    for (const [hourKey, actualSpeed] of speedByHour) {
      const actualDir = dirByHour.get(hourKey);
      const fc = forecastByHour.get(hourKey);
      if (actualDir == null || !fc || fc.speed == null) continue;
      // A real siting bias is a few knots, not tens — anything wilder than this per-hour is a
      // data problem (unit mismatch, bad timestamp alignment, etc.), not a genuine forecast
      // error. Drop it rather than let it distort the band average.
      if (!(actualSpeed >= 0 && actualSpeed < 80) || Math.abs(actualSpeed - fc.speed) > 40) {
        droppedImplausible++;
        continue;
      }
      const band = bandFor(actualDir);
      bandDeltas[band].push(actualSpeed - fc.speed);
      pairedCount++;
    }
    if (droppedImplausible) console.log(`  Dropped ${droppedImplausible} implausible hour(s) as likely data errors.`);

    debug.spots[spotId].pairedHourCount = pairedCount;
    debug.spots[spotId].droppedImplausible = droppedImplausible;
    console.log(`  Paired ${pairedCount} hours of actual-vs-forecast.`);

    function median(arr) {
      const s = [...arr].sort((a, b) => a - b);
      const mid = Math.floor(s.length / 2);
      return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
    }

    const bandAdj = {};
    for (const band of DIR_BANDS) {
      const deltas = bandDeltas[band];
      if (deltas.length >= 5) {
        // Median rather than mean — robust to the occasional bad reading that slips past the
        // quality-code and plausibility filters above.
        bandAdj[band] = { adj: Math.round(median(deltas)), sampleCount: deltas.length };
      } else {
        bandAdj[band] = { adj: null, sampleCount: deltas.length, note: 'fewer than 5 samples, not enough to trust yet' };
      }
    }
    results[spotId] = { stationCode, pairedHourCount: pairedCount, bandAdj };
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
