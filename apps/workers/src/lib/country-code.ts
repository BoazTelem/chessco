/**
 * FIDE uses ISO 3166-1 alpha-3 country codes (ISR, USA, GBR, NOR, ...).
 * Lichess and chess.com use alpha-2 (IL, US, GB, NO, ...).
 *
 * We map alpha-3 → alpha-2 at comparison time. Coverage focuses on the
 * launch markets and the top ~50 chess-playing nations; FIDE has a few
 * historical/non-standard codes (SCG, YUG) that we don't bother with.
 */
const FIDE_TO_ISO2: Record<string, string> = {
  ISR: 'IL',
  USA: 'US',
  GBR: 'GB',
  ENG: 'GB', // FIDE uses ENG for England separately from GBR
  CAN: 'CA',
  AUS: 'AU',
  GER: 'DE',
  FRA: 'FR',
  ITA: 'IT',
  ESP: 'ES',
  NED: 'NL',
  NOR: 'NO',
  SWE: 'SE',
  DEN: 'DK',
  FIN: 'FI',
  ISL: 'IS',
  RUS: 'RU',
  UKR: 'UA',
  POL: 'PL',
  CZE: 'CZ',
  SVK: 'SK',
  HUN: 'HU',
  ROU: 'RO',
  BUL: 'BG',
  SRB: 'RS',
  CRO: 'HR',
  SLO: 'SI',
  GRE: 'GR',
  TUR: 'TR',
  ARM: 'AM',
  AZE: 'AZ',
  GEO: 'GE',
  IND: 'IN',
  CHN: 'CN',
  JPN: 'JP',
  KOR: 'KR',
  IRI: 'IR',
  KAZ: 'KZ',
  UZB: 'UZ',
  VIE: 'VN',
  PHI: 'PH',
  INA: 'ID',
  SGP: 'SG',
  AUT: 'AT',
  SUI: 'CH',
  BEL: 'BE',
  IRL: 'IE',
  POR: 'PT',
  EST: 'EE',
  LAT: 'LV',
  LTU: 'LT',
  BLR: 'BY',
  MEX: 'MX',
  ARG: 'AR',
  BRA: 'BR',
  CHI: 'CL',
  COL: 'CO',
  PER: 'PE',
  VEN: 'VE',
  URU: 'UY',
  PAR: 'PY',
  CUB: 'CU',
  RSA: 'ZA',
  EGY: 'EG',
  MAR: 'MA',
  TUN: 'TN',
  ALG: 'DZ',
  NGR: 'NG',
};

/**
 * Returns true iff the country fields refer to the same country.
 * Inputs can be alpha-2 or alpha-3 (or null). Case-insensitive.
 * Returns null when either side is unknown — caller should treat as
 * "no signal" rather than "mismatch".
 */
export function countryMatches(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean | null {
  if (!a || !b) return null;
  return normalizeCountry(a) === normalizeCountry(b);
}

/** Reduce any country code to alpha-2 for comparison. */
export function normalizeCountry(code: string): string {
  const up = code.trim().toUpperCase();
  if (up.length === 2) return up;
  return FIDE_TO_ISO2[up] ?? up;
}
