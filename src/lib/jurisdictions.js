// Jurisdictional classification for ISO 3166-1 alpha-2 country codes.
// Country codes come from airports.json and airlines.json.
import jurisdictions from '../data/jurisdictions.json' with { type: 'json' };

export function isEU(country) {
  return jurisdictions.eu.includes(country);
}

export function isEUorAssociated(country) {
  return (
    jurisdictions.eu.includes(country) ||
    jurisdictions.euAssociated.includes(country)
  );
}

export function isUK(country) {
  return jurisdictions.uk.includes(country);
}

export function isCanada(country) {
  return jurisdictions.canada.includes(country);
}

export function isBrazil(country) {
  return jurisdictions.brazil.includes(country);
}

export function isIsrael(country) {
  return jurisdictions.israel.includes(country);
}

export function isUS(country) {
  return jurisdictions.us.includes(country);
}
