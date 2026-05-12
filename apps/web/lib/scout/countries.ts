/**
 * Common chess countries for the Scout search dropdown.
 * code3 = FIDE alpha-3 (used by federation_players.country)
 * code2 = ISO alpha-2 (used by platform_players.country)
 * flag  = Unicode emoji — renders cross-platform with no asset cost
 *
 * Order: top 8 by chess population first, then alphabetical.
 * Add more as launch markets expand.
 */
export interface CountryOption {
  code3: string;
  code2: string;
  name: string;
  flag: string;
}

export const COUNTRIES: CountryOption[] = [
  { code3: 'ISR', code2: 'IL', name: 'Israel', flag: '🇮🇱' },
  { code3: 'USA', code2: 'US', name: 'United States', flag: '🇺🇸' },
  { code3: 'IND', code2: 'IN', name: 'India', flag: '🇮🇳' },
  { code3: 'RUS', code2: 'RU', name: 'Russia', flag: '🇷🇺' },
  { code3: 'NOR', code2: 'NO', name: 'Norway', flag: '🇳🇴' },
  { code3: 'CHN', code2: 'CN', name: 'China', flag: '🇨🇳' },
  { code3: 'GER', code2: 'DE', name: 'Germany', flag: '🇩🇪' },
  { code3: 'GBR', code2: 'GB', name: 'United Kingdom', flag: '🇬🇧' },
  // alphabetical
  { code3: 'ARG', code2: 'AR', name: 'Argentina', flag: '🇦🇷' },
  { code3: 'ARM', code2: 'AM', name: 'Armenia', flag: '🇦🇲' },
  { code3: 'AUS', code2: 'AU', name: 'Australia', flag: '🇦🇺' },
  { code3: 'AUT', code2: 'AT', name: 'Austria', flag: '🇦🇹' },
  { code3: 'AZE', code2: 'AZ', name: 'Azerbaijan', flag: '🇦🇿' },
  { code3: 'BEL', code2: 'BE', name: 'Belgium', flag: '🇧🇪' },
  { code3: 'BLR', code2: 'BY', name: 'Belarus', flag: '🇧🇾' },
  { code3: 'BRA', code2: 'BR', name: 'Brazil', flag: '🇧🇷' },
  { code3: 'BUL', code2: 'BG', name: 'Bulgaria', flag: '🇧🇬' },
  { code3: 'CAN', code2: 'CA', name: 'Canada', flag: '🇨🇦' },
  { code3: 'CHI', code2: 'CL', name: 'Chile', flag: '🇨🇱' },
  { code3: 'COL', code2: 'CO', name: 'Colombia', flag: '🇨🇴' },
  { code3: 'CRO', code2: 'HR', name: 'Croatia', flag: '🇭🇷' },
  { code3: 'CUB', code2: 'CU', name: 'Cuba', flag: '🇨🇺' },
  { code3: 'CZE', code2: 'CZ', name: 'Czech Republic', flag: '🇨🇿' },
  { code3: 'DEN', code2: 'DK', name: 'Denmark', flag: '🇩🇰' },
  { code3: 'EGY', code2: 'EG', name: 'Egypt', flag: '🇪🇬' },
  { code3: 'ESP', code2: 'ES', name: 'Spain', flag: '🇪🇸' },
  { code3: 'EST', code2: 'EE', name: 'Estonia', flag: '🇪🇪' },
  { code3: 'FIN', code2: 'FI', name: 'Finland', flag: '🇫🇮' },
  { code3: 'FRA', code2: 'FR', name: 'France', flag: '🇫🇷' },
  { code3: 'GEO', code2: 'GE', name: 'Georgia', flag: '🇬🇪' },
  { code3: 'GRE', code2: 'GR', name: 'Greece', flag: '🇬🇷' },
  { code3: 'HUN', code2: 'HU', name: 'Hungary', flag: '🇭🇺' },
  { code3: 'INA', code2: 'ID', name: 'Indonesia', flag: '🇮🇩' },
  { code3: 'IRI', code2: 'IR', name: 'Iran', flag: '🇮🇷' },
  { code3: 'IRL', code2: 'IE', name: 'Ireland', flag: '🇮🇪' },
  { code3: 'ISL', code2: 'IS', name: 'Iceland', flag: '🇮🇸' },
  { code3: 'ITA', code2: 'IT', name: 'Italy', flag: '🇮🇹' },
  { code3: 'JPN', code2: 'JP', name: 'Japan', flag: '🇯🇵' },
  { code3: 'KAZ', code2: 'KZ', name: 'Kazakhstan', flag: '🇰🇿' },
  { code3: 'KOR', code2: 'KR', name: 'South Korea', flag: '🇰🇷' },
  { code3: 'LAT', code2: 'LV', name: 'Latvia', flag: '🇱🇻' },
  { code3: 'LTU', code2: 'LT', name: 'Lithuania', flag: '🇱🇹' },
  { code3: 'MEX', code2: 'MX', name: 'Mexico', flag: '🇲🇽' },
  { code3: 'NED', code2: 'NL', name: 'Netherlands', flag: '🇳🇱' },
  { code3: 'PER', code2: 'PE', name: 'Peru', flag: '🇵🇪' },
  { code3: 'PHI', code2: 'PH', name: 'Philippines', flag: '🇵🇭' },
  { code3: 'POL', code2: 'PL', name: 'Poland', flag: '🇵🇱' },
  { code3: 'POR', code2: 'PT', name: 'Portugal', flag: '🇵🇹' },
  { code3: 'ROU', code2: 'RO', name: 'Romania', flag: '🇷🇴' },
  { code3: 'RSA', code2: 'ZA', name: 'South Africa', flag: '🇿🇦' },
  { code3: 'SLO', code2: 'SI', name: 'Slovenia', flag: '🇸🇮' },
  { code3: 'SRB', code2: 'RS', name: 'Serbia', flag: '🇷🇸' },
  { code3: 'SUI', code2: 'CH', name: 'Switzerland', flag: '🇨🇭' },
  { code3: 'SVK', code2: 'SK', name: 'Slovakia', flag: '🇸🇰' },
  { code3: 'SWE', code2: 'SE', name: 'Sweden', flag: '🇸🇪' },
  { code3: 'TUR', code2: 'TR', name: 'Turkey', flag: '🇹🇷' },
  { code3: 'UKR', code2: 'UA', name: 'Ukraine', flag: '🇺🇦' },
  { code3: 'UZB', code2: 'UZ', name: 'Uzbekistan', flag: '🇺🇿' },
  { code3: 'VEN', code2: 'VE', name: 'Venezuela', flag: '🇻🇪' },
  { code3: 'VIE', code2: 'VN', name: 'Vietnam', flag: '🇻🇳' },
];

/** Look up by FIDE alpha-3 OR ISO alpha-2. Returns undefined if not in the list. */
export function findCountry(code: string | null | undefined): CountryOption | undefined {
  if (!code) return undefined;
  const up = code.toUpperCase();
  return COUNTRIES.find((c) => c.code3 === up || c.code2 === up);
}

export function countryFlag(code: string | null | undefined): string {
  return findCountry(code)?.flag ?? '';
}

export function countryName(code: string | null | undefined): string {
  return findCountry(code)?.name ?? (code ?? '').toUpperCase();
}
