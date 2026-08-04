// Fetches live on-water readings for the FoilSpots Antwerp Dutch spots (RWS network) and
// writes Website/public/antwerp/live.json for the static site to read (same-origin, no CORS
// issue there — the RWS API itself does not allow direct browser calls, confirmed by testing
// from three different origins, so this has to run server-side, e.g. via GitHub Actions).
//
// Belgian coast spots (Meetnet Vlaamse Banken) are NOT handled here yet — that network requires
// an authenticated login (see MVB_USERNAME / MVB_PASSWORD secrets, not yet wired up). This script
// only fills in the `nl`-area spots for now; other spots are left out of live.json until MVB is
// added in a follow-up.
//
// Run with: node fetch-antwerp-live.mjs
// Requires Node 18+ (built-in fetch).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITE_DIR = path.join(__dirname, '..', 'antwerp');
const SPOTS_PATH = path.join(SITE_DIR, 'spots-data.js');
const OUT_PATH = path.join(SITE_DIR, 'live.json');

const BASE = 'https://ddapi20-waterwebservices.rijkswaterstaat.nl';
const CATALOG_URL = `${BASE}/METADATASERVICES/OphalenCatalogus`;
const LATEST_URL = `${BASE}/ONLINEWAARNEMINGENSERVICES/OphalenLaatsteWaarnemingen`;

// Only the Dutch (area: 'nl') spots have a station.network === 'rws'. We match catalog
// locations to spots by nearest distance to the spot's lat/lon, then confirm the candidate
// actually has a surface-water-temperature (Compartiment OW, Grootheid T) series.
const NL_SPOT_KEYWORDS = {
  'brouwersdam-lake': ['grevelingen', 'brouwersdam'],
  'brouwersdam-sea':  ['brouwersdam', 'schouwen'],
  'veerse-meer':      ['veerse', 'veere', 'vrouwenpolder'],
  'oesterdam':        ['oosterschelde', 'oesterdam', 'bergen op zoom'],
};

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371, toRad = d => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function loadSpots() {
  const src = fs.readFileSync(SPOTS_PATH, 'utf8');
  const fn = new Function(`${src}\nreturn SPOTS;`);
  return fn();
}

async function postJson(url, body) {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status} from ${url}: ${text.slice(0, 500)}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`Non-JSON response from ${url}: ${text.slice(0, 500)}`);
  }
}

async function main() {
  const allSpots = loadSpots();
  const nlSpots = allSpots.filter(s => s.station && s.station.network === 'rws');

  console.log(`Fetching RWS catalog...`);
  const catalog = await postJson(CATALOG_URL, { CatalogusFilter: { Compartimenten: true, Grootheden: true } });

  // Diagnostic dump — publicly readable (no GitHub login needed) so shape/field-name
  // assumptions can be checked from outside without needing repo access.
  const debugInfo = {
    generatedAt: new Date().toISOString(),
    topLevelKeys: Object.keys(catalog),
    locatieLijstLength: Array.isArray(catalog.LocatieLijst) ? catalog.LocatieLijst.length : null,
    sampleLocations: (catalog.LocatieLijst || []).slice(0, 3),
  };
  fs.writeFileSync(path.join(SITE_DIR, 'debug.json'), JSON.stringify(debugInfo, null, 2));

  const locations = catalog.LocatieLijst || [];
  console.log(`Catalog returned ${locations.length} locations.`);
  if (locations.length) {
    console.log('Sample location object:', JSON.stringify(locations[0]));
  }

  const results = {};
  const obsDebug = {};
  const MAX_AGE_HOURS = 48;
  const SEARCH_RADIUS_KM = 60; // widened — the nearest station by distance is often a defunct
                                 // one-off sampling point (e.g. old swim-water-quality checks);
                                 // the nearest *actively reporting* sensor can be further away.

  for (const spot of nlSpots) {
    const keywords = NL_SPOT_KEYWORDS[spot.id] || [];
    const candidates = locations
      .map(loc => {
        const name = (loc.Naam || loc.Code || '').toLowerCase();
        const nameHit = keywords.some(k => name.includes(k));
        const distKm = (typeof loc.Lat === 'number' && typeof loc.Lon === 'number')
          ? haversineKm(spot.lat, spot.lon, loc.Lat, loc.Lon)
          : Infinity;
        return { loc, nameHit, distKm };
      })
      .filter(c => c.distKm < SEARCH_RADIUS_KM)
      .sort((a, b) => a.distKm - b.distKm)
      .slice(0, 25); // cap so the batched request stays reasonably sized

    console.log(`\n${spot.id}: ${candidates.length} candidate location(s) within ${SEARCH_RADIUS_KM}km`);
    candidates.slice(0, 8).forEach(c =>
      console.log(`  - ${c.loc.Code} "${c.loc.Naam}" dist=${c.distKm.toFixed(1)}km`));

    if (candidates.length === 0) {
      console.log(`  No candidates found for ${spot.id} — skipping.`);
      continue;
    }

    // Batch: ask for all nearby candidates' latest water-temperature reading in one request,
    // then pick whichever one is both present AND actually recent. This is both fewer HTTP
    // calls and correctly finds the freshest sensor rather than just the nearest one.
    try {
      const obs = await postJson(LATEST_URL, {
        LocatieLijst: candidates.map(c => ({ Code: c.loc.Code })),
        AquoPlusWaarnemingMetadataLijst: [
          { AquoMetadata: { Compartiment: { Code: 'OW' }, Grootheid: { Code: 'T' } } },
        ],
      });

      const byCode = {};
      for (const c of candidates) byCode[c.loc.Code] = c;

      const scored = (obs.WaarnemingenLijst || [])
        .map(series => {
          const events = series.MetingenLijst;
          const last = events && events.length ? events[events.length - 1] : null;
          if (!last) return null;
          const code = series.Locatie && series.Locatie.Code;
          const ageHours = (Date.now() - new Date(last.Tijdstip).getTime()) / 3.6e6;
          return { code, last, ageHours, distKm: byCode[code] ? byCode[code].distKm : Infinity };
        })
        .filter(Boolean)
        .sort((a, b) => a.ageHours - b.ageHours); // freshest first

      obsDebug[spot.id] = {
        candidatesTried: candidates.length,
        seriesReturned: scored.length,
        top5ByFreshness: scored.slice(0, 5).map(s => ({ code: s.code, ts: s.last.Tijdstip, ageHours: Math.round(s.ageHours), distKm: Math.round(s.distKm) })),
      };

      const fresh = scored.find(s => s.ageHours >= 0 && s.ageHours < MAX_AGE_HOURS);
      if (fresh) {
        const stationName = byCode[fresh.code] ? byCode[fresh.code].loc.Naam : fresh.code;
        results[spot.id] = {
          waterTempC: Number(fresh.last.Meetwaarde?.Waarde_Numeriek),
          ts: fresh.last.Tijdstip,
          stationCode: fresh.code,
          stationName,
        };
        console.log(`  -> matched ${fresh.code} (${fresh.distKm.toFixed(1)}km away): ${results[spot.id].waterTempC}°C at ${fresh.last.Tijdstip}`);
      } else if (scored.length) {
        console.log(`  No candidate within ${SEARCH_RADIUS_KM}km has a reading newer than ${MAX_AGE_HOURS}h. Freshest found: ${scored[0].code} at ${scored[0].last.Tijdstip} (${Math.round(scored[0].ageHours)}h old).`);
      } else {
        console.log(`  None of the ${candidates.length} nearby candidates returned any OW/T series at all.`);
      }
    } catch (e) {
      console.log(`  ! Batched request failed for ${spot.id}: ${e.message}`);
      obsDebug[spot.id] = { error: e.message };
    }
  }

  const out = { generatedAt: new Date().toISOString(), spots: results };
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${OUT_PATH}`);
  console.log(JSON.stringify(out, null, 2));

  // Append observation-shape samples to debug.json for verification if matching still fails.
  const debugPath = path.join(SITE_DIR, 'debug.json');
  const existingDebug = JSON.parse(fs.readFileSync(debugPath, 'utf8'));
  existingDebug.obsSamples = obsDebug;
  fs.writeFileSync(debugPath, JSON.stringify(existingDebug, null, 2));
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});
