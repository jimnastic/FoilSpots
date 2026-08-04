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
const OPEN_METEO_ARCHIVE = 'https://archive-api.open-meteo.com/v1/archive';

const LOOKBACK_DAYS = 90;

// Known-good stations confirmed via the water-temp pipeline (see antwerp/live.json history).
// If a spot's station changes there, update here too — kept separate so a bad wind fetch
// can't accidentally break the working water-temp station selection.
const STATIONS = {
  'brouwersdam-lake': 'bommenede',
  'brouwersdam-sea':  null, // confirm against live.json once the sea-side fix has run
  'veerse-meer':      'kamperland.schotsman',
  'oesterdam':        'marollegat',
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

  for (const [spotId, stationCode] of Object.entries(STATIONS)) {
    const spot = allSpots.find(s => s.id === spotId);
    if (!spot || !stationCode) {
      console.log(`\n${spotId}: no confirmed station yet — skipping`);
      continue;
    }
    console.log(`\n${spotId} (station ${stationCode}):`);

    let speedObs, dirObs, archive;
    try {
      [speedObs, dirObs, archive] = await Promise.all([
        fetchRwsSeries(stationCode, windMeta.speed),
        fetchRwsSeries(stationCode, windMeta.dir),
        fetchOpenMeteoArchive(spot.lat, spot.lon),
      ]);
    } catch (e) {
      console.log(`  ! fetch failed: ${e.message}`);
      debug.spots[spotId] = { error: e.message };
      continue;
    }

    debug.spots[spotId] = {
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

    // Index actual dir readings by hour so we can pair with speed readings and archive.
    const dirByHour = new Map();
    for (const d of dirObs) {
      const hourKey = d.Tijdstip.slice(0, 13);
      dirByHour.set(hourKey, Number(d.Meetwaarde?.Waarde_Numeriek));
    }
    const speedByHour = new Map();
    for (const sObs of speedObs) {
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

    for (const [hourKey, actualSpeed] of speedByHour) {
      const actualDir = dirByHour.get(hourKey);
      const fc = forecastByHour.get(hourKey);
      if (actualDir == null || !fc || fc.speed == null) continue;
      const band = bandFor(actualDir);
      bandDeltas[band].push(actualSpeed - fc.speed);
      pairedCount++;
    }

    debug.spots[spotId].pairedHourCount = pairedCount;
    console.log(`  Paired ${pairedCount} hours of actual-vs-forecast.`);

    const bandAdj = {};
    for (const band of DIR_BANDS) {
      const deltas = bandDeltas[band];
      if (deltas.length >= 5) {
        bandAdj[band] = { adj: Math.round(deltas.reduce((a, b) => a + b, 0) / deltas.length), sampleCount: deltas.length };
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
