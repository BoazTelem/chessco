/**
 * FIDE alpha-3 (ISR) ↔ chess.com / Lichess alpha-2 (IL) bridge.
 * Mirror of apps/workers/src/lib/country-code.ts. Kept in-app so the web
 * doesn't reach across the monorepo for one small lookup table.
 */
const FIDE_TO_ISO2: Record<string, string> = {
  ISR: 'IL',
  USA: 'US',
  GBR: 'GB',
  ENG: 'GB',
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

export function normalizeCountry(code: string): string {
  const up = code.trim().toUpperCase();
  if (up.length === 2) return up;
  return FIDE_TO_ISO2[up] ?? up;
}

export function countryMatches(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean | null {
  if (!a || !b) return null;
  return normalizeCountry(a) === normalizeCountry(b);
}
