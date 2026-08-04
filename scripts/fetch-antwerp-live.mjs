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
  for (const spot of nlSpots) {
    const keywords = NL_SPOT_KEYWORDS[spot.id] || [];
    // Rank candidates by (a) name containing a keyword, (b) proximity to the spot's coordinates.
    const candidates = locations
      .map(loc => {
        const name = (loc.Naam || loc.Code || '').toLowerCase();
        const nameHit = keywords.some(k => name.includes(k));
        const distKm = (typeof loc.X === 'number' && typeof loc.Y === 'number')
          ? haversineKm(spot.lat, spot.lon, loc.Y, loc.X)
          : Infinity;
        return { loc, nameHit, distKm };
      })
      .filter(c => c.distKm < 25) // within 25km of the spot
      .sort((a, b) => (b.nameHit - a.nameHit) || (a.distKm - b.distKm));

    console.log(`\n${spot.id}: ${candidates.length} candidate location(s) within 25km`);
    candidates.slice(0, 5).forEach(c =>
      console.log(`  - ${c.loc.Code} "${c.loc.Naam}" nameHit=${c.nameHit} dist=${c.distKm.toFixed(1)}km`));

    if (candidates.length === 0) {
      console.log(`  No candidates found for ${spot.id} — skipping.`);
      continue;
    }

    // Try candidates in order until one returns a water-temperature reading.
    for (const c of candidates.slice(0, 5)) {
      try {
        const obs = await postJson(LATEST_URL, {
          LocatieLijst: [{ Code: c.loc.Code }],
          AquoPlusWaarnemingMetadataLijst: [
            { AquoMetadata: { Compartiment: { Code: 'OW' }, Grootheid: { Code: 'T' } } },
          ],
        });
        const series = (obs.WaarnemingenLijst || [])[0];
        const events = series && series.MetingenLijst;
        if (events && events.length) {
          const last = events[events.length - 1];
          results[spot.id] = {
            waterTempC: Number(last.Meetwaarde?.Waarde_Numeriek),
            ts: last.Tijdstip,
            stationCode: c.loc.Code,
            stationName: c.loc.Naam,
          };
          console.log(`  -> matched ${c.loc.Code}: ${results[spot.id].waterTempC}°C at ${results[spot.id].ts}`);
          break;
        }
      } catch (e) {
        console.log(`  ! ${c.loc.Code} failed: ${e.message}`);
      }
    }
    if (!results[spot.id]) {
      console.log(`  No usable water-temperature reading found for ${spot.id} among top candidates.`);
    }
  }

  const out = { generatedAt: new Date().toISOString(), spots: results };
  fs.writeFileSync(OUT_PATH, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${OUT_PATH}`);
  console.log(JSON.stringify(out, null, 2));
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exitCode = 1;
});
