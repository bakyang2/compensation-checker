// Node smoke test for the eligibility engine.
// Loads real airports.json + airlines.json (no fixtures) and runs a matrix
// of scenarios that exercise every branch.
//
// Run: `node scripts/test_eligibility.mjs`
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import airportsData from '../src/data/airports.json' with { type: 'json' };
import airlinesData from '../src/data/airlines.json' with { type: 'json' };
import { evaluateEligibility } from '../src/lib/eligibility.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Build airport lookup keyed by IATA. airports.json is keyed by ICAO and many
// entries have empty IATA; filter to the 3-letter IATA subset the widget uses.
const airportsByIata = new Map();
for (const code in airportsData) {
  const a = airportsData[code];
  if (!a.iata || a.iata.length !== 3) continue;
  airportsByIata.set(a.iata, a);
}

// airlines.json is already an array of { iata, icao, name, country }.
const airlinesByIata = new Map(airlinesData.map((a) => [a.iata, a]));

function airport(iata) {
  const a = airportsByIata.get(iata);
  if (!a) throw new Error(`airport ${iata} not found in airports.json`);
  return a;
}
function airline(iata) {
  const a = airlinesByIata.get(iata);
  if (!a) throw new Error(`airline ${iata} not found in airlines.json`);
  return a;
}

const DEFAULTS = {
  flightDate: '2026-02-14',
  notificationTiming: null,
  reroutingOffered: null,
  deniedBoardingType: null,
  originalClass: null,
  actualClass: null,
};

const SCENARIOS = [
  {
    name: 'Scenario 1: LHR→JFK, British Airways, delayed 4h+, technical',
    input: {
      ...DEFAULTS,
      origin: airport('LHR'),
      destination: airport('JFK'),
      airline: airline('BA'),
      issueType: 'delayed',
      delayDuration: '4h_plus',
      disruptionReason: 'technical',
    },
  },
  {
    name: 'Scenario 2: LAX→JFK, United, delayed 3-4h, operational (US domestic)',
    input: {
      ...DEFAULTS,
      origin: airport('LAX'),
      destination: airport('JFK'),
      airline: airline('UA'),
      issueType: 'delayed',
      delayDuration: '3_to_4h',
      disruptionReason: 'operational',
    },
  },
  {
    name: 'Scenario 3: ICN→NRT, Korean Air, delayed 3-4h, technical',
    input: {
      ...DEFAULTS,
      origin: airport('ICN'),
      destination: airport('NRT'),
      airline: airline('KE'),
      issueType: 'delayed',
      delayDuration: '3_to_4h',
      disruptionReason: 'technical',
    },
  },
  {
    name: 'Scenario 4: CDG→FCO, Air France, cancelled 7-13d, accepted reroute, weather',
    input: {
      ...DEFAULTS,
      origin: airport('CDG'),
      destination: airport('FCO'),
      airline: airline('AF'),
      issueType: 'cancelled',
      delayDuration: null,
      notificationTiming: '7_to_13d',
      reroutingOffered: 'yes_accepted',
      disruptionReason: 'weather',
    },
  },
  {
    name: 'Scenario 5: JFK→CDG, Lufthansa, delayed 4h+, technical (EU-carrier branch)',
    input: {
      ...DEFAULTS,
      origin: airport('JFK'),
      destination: airport('CDG'),
      airline: airline('LH'),
      issueType: 'delayed',
      delayDuration: '4h_plus',
      disruptionReason: 'technical',
    },
  },
  {
    name: 'Scenario 6: YYZ→LAX, Air Canada, delayed 3-4h, technical (APPR Canadian carrier)',
    input: {
      ...DEFAULTS,
      origin: airport('YYZ'),
      destination: airport('LAX'),
      airline: airline('AC'),
      issueType: 'delayed',
      delayDuration: '3_to_4h',
      disruptionReason: 'technical',
    },
  },
];

for (const sc of SCENARIOS) {
  console.log('\n=========================================================');
  console.log(sc.name);
  console.log('airline.country:', sc.input.airline.country,
    '| origin.country:', sc.input.origin.country,
    '| dest.country:', sc.input.destination.country);
  console.log('=========================================================');
  const result = evaluateEligibility(sc.input);
  console.log(JSON.stringify(result, null, 2));
}
