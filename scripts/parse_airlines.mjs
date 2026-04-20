// Build-time parser: OpenFlights airlines.dat → src/data/airlines.json.
//
// Run: `node scripts/parse_airlines.mjs`
// Prereq: /tmp/airlines.dat must exist. Fetch with:
//   curl -sSL -o /tmp/airlines.dat \
//     https://raw.githubusercontent.com/jpatokal/openflights/master/data/airlines.dat
//
// Filters to active carriers with a real 2-char IATA code, rewrites country
// names to ISO 3166-1 alpha-2 codes so they match airports.json and the
// jurisdiction helpers (isEU / isUK / isCanada / …).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import countries from 'i18n-iso-countries';
import enLocale from 'i18n-iso-countries/langs/en.json' with { type: 'json' };

countries.registerLocale(enLocale);

const __dirname = dirname(fileURLToPath(import.meta.url));
const INPUT = '/tmp/airlines.dat';
const OUTPUT = resolve(__dirname, '..', 'src', 'data', 'airlines.json');

// OpenFlights uses some legacy / non-standard country names that
// i18n-iso-countries doesn't resolve. Fallbacks below are hand-curated from
// the first pass (anything left as '' after getAlpha2Code).
const MANUAL_COUNTRY_FALLBACKS = {
  'Burma': 'MM',
  'Cape Verde': 'CV',
  'Congo (Brazzaville)': 'CG',
  'Congo (Kinshasa)': 'CD',
  'Czech Republic': 'CZ',
  "Cote d'Ivoire": 'CI',
  'Ivory Coast': 'CI',
  'East Timor': 'TL',
  'Macau': 'MO',
  'Macedonia': 'MK',
  'Palestine': 'PS',
  'Pitcairn': 'PN',
  'Republic of the Congo': 'CG',
  'Russia': 'RU',
  'South Korea': 'KR',
  'North Korea': 'KP',
  'Syria': 'SY',
  'Taiwan': 'TW',
  'Tanzania': 'TZ',
  'Vatican City': 'VA',
  'Vietnam': 'VN',
  'Venezuela': 'VE',
  'Virgin Islands': 'VI',
  'Wallis and Futuna': 'WF',
  'Iran': 'IR',
  'Brunei': 'BN',
  'Bolivia': 'BO',
  'Laos': 'LA',
  'Moldova': 'MD',
  'Micronesia': 'FM',
  // OpenFlights quirks found on first pass
  'Canadian Territories': 'CA',
  "Democratic People's Republic of Korea": 'KP',
  'Hong Kong SAR of China': 'HK',
  'Lao Peoples Democratic Republic': 'LA',
  'British Virgin Islands': 'VG',
  // Netherlands Antilles dissolved 2010 — no successor ISO code, leave unresolved.
  // "S.A.", "ALASKA", "AVIANCA", "DRAGON" appear to be data-quality artifacts
  // (upstream alias column written into the country column); leave unresolved.
};

function toISO(name) {
  if (!name) return '';
  const direct = countries.getAlpha2Code(name, 'en');
  if (direct) return direct;
  if (MANUAL_COUNTRY_FALLBACKS[name]) return MANUAL_COUNTRY_FALLBACKS[name];
  return '';
}

function parseCsvLine(line) {
  const fields = [];
  let current = '';
  let inQuotes = false;
  let i = 0;
  while (i < line.length) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') {
        current += '"';
        i += 2;
      } else if (c === '"') {
        inQuotes = false;
        i += 1;
      } else {
        current += c;
        i += 1;
      }
    } else {
      if (c === '"' && current === '') {
        inQuotes = true;
        i += 1;
      } else if (c === ',') {
        fields.push(current);
        current = '';
        i += 1;
      } else {
        current += c;
        i += 1;
      }
    }
  }
  fields.push(current);
  return fields;
}

// Null-ish markers in OpenFlights: `\N`, empty string, `-`.
const clean = (s) => (s === '\\N' || s === '-' || s == null ? '' : s.trim());

const raw = readFileSync(INPUT, 'utf8').split('\n').filter(Boolean);

const stats = {
  totalRows: raw.length,
  skipped: {
    notActive: 0,
    badIata: 0,
    badName: 0,
    duplicateIata: 0,
  },
  kept: 0,
  isoResolved: 0,
  isoUnresolved: 0,
  unresolvedSamples: new Set(),
};

const seen = new Set();
const airlines = [];

for (const line of raw) {
  const fields = parseCsvLine(line);
  if (fields.length < 8) continue;
  const [, nameRaw, , iataRaw, icaoRaw, , countryRaw, active] = fields;

  if (active.trim() !== 'Y') {
    stats.skipped.notActive += 1;
    continue;
  }
  const iata = clean(iataRaw).toUpperCase();
  if (!iata || iata.length !== 2) {
    stats.skipped.badIata += 1;
    continue;
  }
  const name = clean(nameRaw);
  if (!name || name === 'Unknown') {
    stats.skipped.badName += 1;
    continue;
  }
  if (seen.has(iata)) {
    stats.skipped.duplicateIata += 1;
    continue;
  }
  seen.add(iata);

  const countryName = clean(countryRaw);
  const countryIso = toISO(countryName);
  if (countryIso) stats.isoResolved += 1;
  else {
    stats.isoUnresolved += 1;
    if (countryName) stats.unresolvedSamples.add(countryName);
  }

  airlines.push({
    iata,
    icao: clean(icaoRaw),
    name,
    country: countryIso, // ISO 3166-1 alpha-2, or '' if we couldn't resolve
  });
  stats.kept += 1;
}

airlines.sort((a, b) => a.name.localeCompare(b.name));

writeFileSync(OUTPUT, JSON.stringify(airlines, null, 0));

console.log(JSON.stringify(
  {
    ...stats,
    unresolvedSamples: Array.from(stats.unresolvedSamples),
  },
  null,
  2,
));
console.log('Wrote', OUTPUT);

// Spot-checks
const find = (code) => airlines.find((a) => a.iata === code);
for (const code of ['LH', 'BA', 'AF', 'KE', 'FR', 'AC', 'UA']) {
  console.log(`${code}:`, find(code));
}
