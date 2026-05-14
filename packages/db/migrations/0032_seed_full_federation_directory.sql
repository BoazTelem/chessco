-- 0032_seed_full_federation_directory.sql
--
-- Phase 0 W7 expansion (2026-05-14): widen federation coverage to all
-- ~199 FIDE-recognized national federations.
--
-- This migration is additive:
--   1. Adds new metadata columns to `federations` (iso2/iso3/continent/
--      scrape_strategy/est_player_count/notes).
--   2. Extends the sync_cadence CHECK to include 'semi_annual'.
--   3. Indexes (continent, active) for fast UI dropdown sorting + filtering.
--   4. Bulk seeds 207 federation rows with ON CONFLICT DO UPDATE — preserves
--      `active` on existing rows (never overwrites FIDE/ICF/USCF state).
--
-- Source: apps/workers/src/lib/federations/directory.ts (TS const is the
-- canonical bootstrap; DB is runtime source of truth post-migration).
-- Regenerate the VALUES via: node packages/db/scripts/_gen_seed.mjs
--
-- Out of scope for this migration: per-federation Inngest cron registration
-- (lives in apps/workers/src/inngest/federations.ts; only FIDE/ICF/USCF
-- currently wired). New federations get parsers in Phase B waves.

ALTER TABLE federations
  ADD COLUMN IF NOT EXISTS iso2 char(2),
  ADD COLUMN IF NOT EXISTS iso3 char(3),
  ADD COLUMN IF NOT EXISTS continent text
    CHECK (continent IN ('AF','AS','EU','NA','OC','SA') OR continent IS NULL),
  ADD COLUMN IF NOT EXISTS scrape_strategy text
    CHECK (scrape_strategy IN
      ('dump','fetch-html','aspnet','spa','api','cloudflare','placeholder')
      OR scrape_strategy IS NULL),
  ADD COLUMN IF NOT EXISTS est_player_count integer,
  ADD COLUMN IF NOT EXISTS notes text;

-- Extend the sync_cadence check to include semi_annual (used by Tier-3+ feds).
ALTER TABLE federations DROP CONSTRAINT IF EXISTS federations_sync_cadence_check;
ALTER TABLE federations ADD CONSTRAINT federations_sync_cadence_check
  CHECK (sync_cadence IN ('monthly','quarterly','semi_annual','manual'));

CREATE INDEX IF NOT EXISTS federations_continent_idx ON federations (continent);
CREATE INDEX IF NOT EXISTS federations_active_idx ON federations (active);

-- ============================================================================
-- Bulk seed (207 rows). Columns:
--   (id, name, country, iso2, iso3, continent,
--    rating_list_url, rating_list_format, scrape_strategy, sync_cadence,
--    est_player_count, notes, active)
-- ============================================================================

INSERT INTO federations
  (id, name, country, iso2, iso3, continent,
   rating_list_url, rating_list_format, scrape_strategy, sync_cadence,
   est_player_count, notes, active)
VALUES
  ('FIDE', 'International Chess Federation', NULL, NULL, NULL, NULL, 'https://ratings.fide.com/download.phtml', 'xml', 'dump', 'monthly', 755000, 'Monthly XML zip dumps for standard/rapid/blitz', true),
  ('ALB', 'Federation Albanian Chess', 'AL', 'AL', 'ALB', 'EU', NULL, NULL, 'placeholder', 'quarterly', 1500, NULL, false),
  ('AND', 'Federacio d’Escacs Valls d’Andorra', 'AD', 'AD', 'AND', 'EU', NULL, NULL, 'placeholder', 'semi_annual', 200, 'Microstate', false),
  ('ARM', 'Chess Federation of Armenia', 'AM', 'AM', 'ARM', 'EU', 'https://armchess.am', 'html', 'fetch-html', 'quarterly', 3000, 'Highest GM density per capita', false),
  ('AUT', 'Österreichischer Schachbund', 'AT', 'AT', 'AUT', 'EU', 'https://chess.at/ratings', 'html', 'fetch-html', 'monthly', 7000, NULL, false),
  ('AZE', 'Azerbaijan Chess Federation', 'AZ', 'AZ', 'AZE', 'EU', 'https://azchess.az', 'html', 'fetch-html', 'quarterly', 3000, NULL, false),
  ('BLR', 'Belarus Chess Federation', 'BY', 'BY', 'BLR', 'EU', NULL, NULL, 'placeholder', 'quarterly', 4000, NULL, false),
  ('BEL', 'KBSB-FRBE Belgium', 'BE', 'BE', 'BEL', 'EU', 'https://www.kbsb.be/index.php/en/ratings', 'html', 'fetch-html', 'monthly', 5000, 'Phase 1 W10 target', false),
  ('BIH', 'Chess Federation of Bosnia and Herzegovina', 'BA', 'BA', 'BIH', 'EU', NULL, NULL, 'placeholder', 'quarterly', 3000, NULL, false),
  ('BUL', 'Bulgarian Chess Federation', 'BG', 'BG', 'BGR', 'EU', 'https://chessbg.com', 'html', 'fetch-html', 'quarterly', 3000, NULL, false),
  ('CRO', 'Croatian Chess Federation', 'HR', 'HR', 'HRV', 'EU', 'https://hssahkr.hr', 'html', 'fetch-html', 'quarterly', 4000, NULL, false),
  ('CYP', 'Cyprus Chess Federation', 'CY', 'CY', 'CYP', 'EU', NULL, NULL, 'placeholder', 'semi_annual', 800, NULL, false),
  ('CZE', 'Šachový svaz České republiky', 'CZ', 'CZ', 'CZE', 'EU', 'https://chess.cz/lkr', 'html', 'fetch-html', 'quarterly', 12000, NULL, false),
  ('DEN', 'Dansk Skak Union', 'DK', 'DK', 'DNK', 'EU', 'https://skak.dk', 'html', 'fetch-html', 'quarterly', 3000, NULL, false),
  ('DSB', 'Deutscher Schachbund', 'DE', 'DE', 'DEU', 'EU', 'https://www.schachbund.de/dwz.html', 'csv', 'fetch-html', 'monthly', 110000, 'DWZ ~50 ELO below FIDE; persist raw. FIDE alpha-3 is GER; we use DSB as PK to match existing seed.', false),
  ('ECF', 'English Chess Federation', 'GB', 'GB', NULL, 'EU', 'https://www.englishchess.org.uk/ecf-publications/', 'html', 'fetch-html', 'monthly', 12000, 'FIDE alpha-3 is ENG; we use ECF as PK to match existing seed.', false),
  ('EST', 'Eesti Maleliit', 'EE', 'EE', 'EST', 'EU', NULL, NULL, 'placeholder', 'quarterly', 2000, NULL, false),
  ('FAI', 'Føroyski Talvfelagið', 'FO', 'FO', 'FRO', 'EU', NULL, NULL, 'placeholder', 'semi_annual', 300, 'Faroe Islands', false),
  ('FFE', 'Fédération Française des Échecs', 'FR', 'FR', 'FRA', 'EU', 'https://www.echecs.asso.fr/Default.aspx?Cat=4', 'html', 'aspnet', 'monthly', 57000, 'ASP.NET ViewState. FIDE alpha-3 is FRA; we use FFE as PK to match existing seed.', false),
  ('FIN', 'Suomen Shakkiliitto', 'FI', 'FI', 'FIN', 'EU', 'https://shakkiliitto.fi', 'html', 'fetch-html', 'quarterly', 3000, NULL, false),
  ('GEO', 'Georgian Chess Federation', 'GE', 'GE', 'GEO', 'EU', 'https://gcf.org.ge', 'html', 'fetch-html', 'quarterly', 4000, 'Top women’s chess', false),
  ('GIB', 'Gibraltar Chess Association', 'GI', 'GI', 'GIB', 'EU', NULL, NULL, 'placeholder', 'semi_annual', 200, NULL, false),
  ('GRE', 'Greek Chess Federation', 'GR', 'GR', 'GRC', 'EU', 'https://chessfed.gr', 'html', 'fetch-html', 'quarterly', 3000, NULL, false),
  ('GUE', 'Guernsey Chess Federation', 'GG', 'GG', NULL, 'EU', NULL, NULL, 'placeholder', 'semi_annual', 100, NULL, false),
  ('HUN', 'Magyar Sakkszövetség', 'HU', 'HU', 'HUN', 'EU', 'https://www.chess.hu', 'html', 'fetch-html', 'quarterly', 10000, 'Top-10 historical', false),
  ('FSI', 'Federazione Scacchistica Italiana', 'IT', 'IT', 'ITA', 'EU', 'https://www.federscacchi.it/str.php', 'html', 'fetch-html', 'monthly', 28000, 'FIDE alpha-3 is ITA; we use FSI as PK to match existing seed.', false),
  ('ICF', 'Israel Chess Federation', 'IL', 'IL', 'ISR', 'EU', 'https://www.chess.org.il/Players/PlayersRanking.aspx', 'html', 'aspnet', 'monthly', 6800, 'ASP.NET GridView. FIDE alpha-3 is ISR; we use ICF as PK to match existing seed.', true),
  ('ISL', 'Skáksamband Íslands', 'IS', 'IS', 'ISL', 'EU', NULL, NULL, 'placeholder', 'quarterly', 1500, NULL, false),
  ('IRL', 'Irish Chess Union', 'IE', 'IE', 'IRL', 'EU', 'https://www.icu.ie/players', 'html', 'fetch-html', 'quarterly', 2000, NULL, false),
  ('JCI', 'Jersey Chess Federation', 'JE', 'JE', NULL, 'EU', NULL, NULL, 'placeholder', 'semi_annual', 100, NULL, false),
  ('KAZ', 'Kazakhstan Chess Federation', 'KZ', 'KZ', 'KAZ', 'AS', 'https://kazchess.kz', 'html', 'fetch-html', 'quarterly', 5000, 'Emerging; federated with ACF', false),
  ('KOS', 'Kosova Chess Federation', 'XK', 'XK', NULL, 'EU', NULL, NULL, 'placeholder', 'semi_annual', 800, 'XK is unofficial alpha-2', false),
  ('LAT', 'Latvijas Šaha Federācija', 'LV', 'LV', 'LVA', 'EU', NULL, NULL, 'placeholder', 'quarterly', 2000, NULL, false),
  ('LIE', 'Liechtensteiner Schachverband', 'LI', 'LI', 'LIE', 'EU', NULL, NULL, 'placeholder', 'semi_annual', 100, 'Microstate', false),
  ('LTU', 'Lietuvos Šachmatų Federacija', 'LT', 'LT', 'LTU', 'EU', NULL, NULL, 'placeholder', 'quarterly', 2500, NULL, false),
  ('LUX', 'Fédération Luxembourgeoise des Échecs', 'LU', 'LU', 'LUX', 'EU', NULL, NULL, 'placeholder', 'semi_annual', 500, NULL, false),
  ('MDA', 'Federaţia Şahului din Moldova', 'MD', 'MD', 'MDA', 'EU', NULL, NULL, 'placeholder', 'quarterly', 1500, NULL, false),
  ('MKD', 'Chess Federation of North Macedonia', 'MK', 'MK', 'MKD', 'EU', NULL, NULL, 'placeholder', 'quarterly', 1500, NULL, false),
  ('MLT', 'Malta Chess Federation', 'MT', 'MT', 'MLT', 'EU', NULL, NULL, 'placeholder', 'semi_annual', 500, NULL, false),
  ('MNC', 'Fédération Monégasque des Échecs', 'MC', 'MC', 'MCO', 'EU', NULL, NULL, 'placeholder', 'semi_annual', 100, 'Microstate', false),
  ('MNE', 'Chess Federation of Montenegro', 'ME', 'ME', 'MNE', 'EU', NULL, NULL, 'placeholder', 'semi_annual', 800, NULL, false),
  ('NED', 'Koninklijke Nederlandse Schaakbond', 'NL', 'NL', 'NLD', 'EU', 'https://ratingviewer.nl', 'html', 'spa', 'monthly', 17000, 'KNSB in PLAN.md; SPA needs Playwright', false),
  ('NOR', 'Norges Sjakkforbund', 'NO', 'NO', 'NOR', 'EU', 'https://sjakkforbundet.no', 'html', 'fetch-html', 'quarterly', 4000, 'Magnus’s federation', false),
  ('POL', 'Polski Związek Szachowy', 'PL', 'PL', 'POL', 'EU', 'https://cr.pzszach.pl', 'html', 'fetch-html', 'monthly', 30000, 'PZSzach in PLAN.md', false),
  ('POR', 'Federação Portuguesa de Xadrez', 'PT', 'PT', 'PRT', 'EU', 'https://www.fpx.pt', 'html', 'fetch-html', 'quarterly', 3000, NULL, false),
  ('ROU', 'Federația Română de Şah', 'RO', 'RO', 'ROU', 'EU', 'https://www.frsah.ro', 'html', 'fetch-html', 'quarterly', 6000, NULL, false),
  ('RUS', 'Chess Federation of Russia', 'RU', 'RU', 'RUS', 'EU', 'https://ratings.ruchess.ru', 'html', 'fetch-html', 'quarterly', 120000, 'Politically sensitive; large pool', false),
  ('SCO', 'Chess Scotland', 'GB', 'GB', NULL, 'EU', NULL, NULL, 'placeholder', 'quarterly', 1500, 'FIDE sub-country', false),
  ('SMR', 'Federazione Scacchistica di San Marino', 'SM', 'SM', 'SMR', 'EU', NULL, NULL, 'placeholder', 'semi_annual', 100, 'Microstate', false),
  ('SRB', 'Šahovski savez Srbije', 'RS', 'RS', 'SRB', 'EU', NULL, NULL, 'placeholder', 'quarterly', 8000, NULL, false),
  ('SVK', 'Slovak Chess Federation', 'SK', 'SK', 'SVK', 'EU', 'https://www.chess.sk', 'html', 'fetch-html', 'quarterly', 3000, NULL, false),
  ('SLO', 'Šahovska zveza Slovenije', 'SI', 'SI', 'SVN', 'EU', 'https://www.sah-zveza.si', 'html', 'fetch-html', 'quarterly', 2000, NULL, false),
  ('ESP', 'Federación Española de Ajedrez', 'ES', 'ES', 'ESP', 'EU', 'https://www.feda.org/feda2k16/ranking.aspx', 'html', 'aspnet', 'monthly', 28000, 'FEDA in PLAN.md', false),
  ('SWE', 'Sveriges Schackförbund', 'SE', 'SE', 'SWE', 'EU', 'https://www.schack.se/rating', 'html', 'fetch-html', 'quarterly', 5000, NULL, false),
  ('SUI', 'Swiss Chess Federation', 'CH', 'CH', 'CHE', 'EU', 'https://www.swisschess.ch', 'html', 'fetch-html', 'monthly', 6000, NULL, false),
  ('TUR', 'Türkiye Satranç Federasyonu', 'TR', 'TR', 'TUR', 'EU', 'https://tsf.org.tr', 'html', 'spa', 'quarterly', 15000, 'SPA needs Playwright', false),
  ('UKR', 'Ukrainian Chess Federation', 'UA', 'UA', 'UKR', 'EU', 'https://chess-ratings.com.ua', 'html', 'fetch-html', 'quarterly', 50000, 'Strong chess country', false),
  ('WLS', 'Welsh Chess Union', 'GB', 'GB', NULL, 'EU', NULL, NULL, 'placeholder', 'semi_annual', 500, 'FIDE sub-country', false),
  ('IOM', 'Isle of Man Chess Union', 'IM', 'IM', NULL, 'EU', NULL, NULL, 'placeholder', 'semi_annual', 200, NULL, false),
  ('AHO', 'Curaçao Chess Federation', 'CW', 'CW', 'CUW', 'NA', NULL, NULL, 'placeholder', 'semi_annual', 200, 'Former Netherlands Antilles', false),
  ('ARG', 'Federación Argentina de Ajedrez', 'AR', 'AR', 'ARG', 'SA', 'https://www.fada.org.ar', 'html', 'fetch-html', 'quarterly', 5000, NULL, false),
  ('ARU', 'Chess Federation of Aruba', 'AW', 'AW', 'ABW', 'NA', NULL, NULL, 'placeholder', 'semi_annual', 150, NULL, false),
  ('BAH', 'Bahamas Chess Federation', 'BS', 'BS', 'BHS', 'NA', NULL, NULL, 'placeholder', 'semi_annual', 200, NULL, false),
  ('BAR', 'Barbados Chess Federation', 'BB', 'BB', 'BRB', 'NA', NULL, NULL, 'placeholder', 'semi_annual', 300, NULL, false),
  ('BER', 'Bermuda Chess Association', 'BM', 'BM', 'BMU', 'NA', NULL, NULL, 'placeholder', 'semi_annual', 200, NULL, false),
  ('BIZ', 'National Chess Federation of Belize', 'BZ', 'BZ', 'BLZ', 'NA', NULL, NULL, 'placeholder', 'semi_annual', 200, NULL, false),
  ('BOL', 'Federación Boliviana de Ajedrez', 'BO', 'BO', 'BOL', 'SA', NULL, NULL, 'placeholder', 'quarterly', 1500, NULL, false),
  ('BRA', 'Confederação Brasileira de Xadrez', 'BR', 'BR', 'BRA', 'SA', 'https://www.cbx.org.br/rating', 'html', 'fetch-html', 'quarterly', 10000, 'Largest LatAm pool', false),
  ('CAN', 'Chess Federation of Canada', 'CA', 'CA', 'CAN', 'NA', 'https://www.chess.ca/en/ratings/', 'html', 'fetch-html', 'monthly', 9000, 'CFC in PLAN.md', false),
  ('CAY', 'Cayman Islands Chess Federation', 'KY', 'KY', 'CYM', 'NA', NULL, NULL, 'placeholder', 'semi_annual', 100, NULL, false),
  ('CHI', 'Federación Nacional de Ajedrez de Chile', 'CL', 'CL', 'CHL', 'SA', NULL, NULL, 'placeholder', 'quarterly', 2000, NULL, false),
  ('COL', 'Federación Colombiana de Ajedrez', 'CO', 'CO', 'COL', 'SA', NULL, NULL, 'placeholder', 'quarterly', 2500, 'FECODAZ', false),
  ('CRC', 'Federación Costarricense de Ajedrez', 'CR', 'CR', 'CRI', 'NA', NULL, NULL, 'placeholder', 'semi_annual', 500, NULL, false),
  ('CUB', 'Federación Cubana de Ajedrez', 'CU', 'CU', 'CUB', 'NA', NULL, NULL, 'placeholder', 'quarterly', 2500, NULL, false),
  ('DOM', 'Federación Dominicana de Ajedrez', 'DO', 'DO', 'DOM', 'NA', NULL, NULL, 'placeholder', 'semi_annual', 500, NULL, false),
  ('ECU', 'Federación Ecuatoriana de Ajedrez', 'EC', 'EC', 'ECU', 'SA', NULL, NULL, 'placeholder', 'quarterly', 1500, NULL, false),
  ('ESA', 'Federación Salvadoreña de Ajedrez', 'SV', 'SV', 'SLV', 'NA', NULL, NULL, 'placeholder', 'semi_annual', 400, NULL, false),
  ('GUA', 'Federación Nacional de Ajedrez de Guatemala', 'GT', 'GT', 'GTM', 'NA', NULL, NULL, 'placeholder', 'semi_annual', 500, NULL, false),
  ('GUY', 'Guyana Chess Federation', 'GY', 'GY', 'GUY', 'SA', NULL, NULL, 'placeholder', 'semi_annual', 200, NULL, false),
  ('HAI', 'Fédération Haïtienne des Échecs', 'HT', 'HT', 'HTI', 'NA', NULL, NULL, 'placeholder', 'semi_annual', 200, NULL, false),
  ('HON', 'Federación Nacional de Ajedrez de Honduras', 'HN', 'HN', 'HND', 'NA', NULL, NULL, 'placeholder', 'semi_annual', 300, NULL, false),
  ('IVB', 'British Virgin Islands Chess Federation', 'VG', 'VG', 'VGB', 'NA', NULL, NULL, 'placeholder', 'semi_annual', 100, NULL, false),
  ('ISV', 'US Virgin Islands Chess Federation', 'VI', 'VI', 'VIR', 'NA', NULL, NULL, 'placeholder', 'semi_annual', 100, NULL, false),
  ('JAM', 'Jamaica Chess Federation', 'JM', 'JM', 'JAM', 'NA', NULL, NULL, 'placeholder', 'semi_annual', 500, NULL, false),
  ('MEX', 'Federación Nacional de Ajedrez de México', 'MX', 'MX', 'MEX', 'NA', 'https://www.fenamac.com', 'html', 'fetch-html', 'semi_annual', 3000, 'FENAMAC in PLAN.md', false),
  ('NCA', 'Federación Nicaragüense de Ajedrez', 'NI', 'NI', 'NIC', 'NA', NULL, NULL, 'placeholder', 'semi_annual', 300, NULL, false),
  ('PAN', 'Federación Panameña de Ajedrez', 'PA', 'PA', 'PAN', 'NA', NULL, NULL, 'placeholder', 'semi_annual', 400, NULL, false),
  ('PAR', 'Federación Paraguaya de Ajedrez', 'PY', 'PY', 'PRY', 'SA', NULL, NULL, 'placeholder', 'quarterly', 1000, NULL, false),
  ('PER', 'Federación Deportiva Peruana de Ajedrez', 'PE', 'PE', 'PER', 'SA', NULL, NULL, 'placeholder', 'quarterly', 2000, NULL, false),
  ('PUR', 'Federación de Ajedrez de Puerto Rico', 'PR', 'PR', 'PRI', 'NA', NULL, NULL, 'placeholder', 'semi_annual', 500, NULL, false),
  ('SUR', 'Surinaamse Schaakbond', 'SR', 'SR', 'SUR', 'SA', NULL, NULL, 'placeholder', 'semi_annual', 200, NULL, false),
  ('TRI', 'Trinidad and Tobago Chess Association', 'TT', 'TT', 'TTO', 'NA', NULL, NULL, 'placeholder', 'semi_annual', 500, NULL, false),
  ('URU', 'Federación Uruguaya de Ajedrez', 'UY', 'UY', 'URY', 'SA', NULL, NULL, 'placeholder', 'semi_annual', 800, NULL, false),
  ('USCF', 'US Chess Federation', 'US', 'US', 'USA', 'NA', 'https://www.uschess.org/datapage/', 'html', 'cloudflare', 'monthly', 25000, 'Cloudflare-blocked 2026-05-13; FIDE-USA slice (13k) is the active fallback. FIDE alpha-3 is USA; we use USCF as PK to match existing seed.', false),
  ('VEN', 'Federación Venezolana de Ajedrez', 'VE', 'VE', 'VEN', 'SA', NULL, NULL, 'placeholder', 'quarterly', 1500, NULL, false),
  ('AFG', 'Afghanistan Chess Federation', 'AF', 'AF', 'AFG', 'AS', NULL, NULL, 'placeholder', 'semi_annual', 200, NULL, false),
  ('BAN', 'Bangladesh Chess Federation', 'BD', 'BD', 'BGD', 'AS', NULL, NULL, 'placeholder', 'quarterly', 1500, NULL, false),
  ('BHU', 'Bhutan Chess Federation', 'BT', 'BT', 'BTN', 'AS', NULL, NULL, 'placeholder', 'semi_annual', 100, NULL, false),
  ('BRU', 'Brunei Darussalam Chess Federation', 'BN', 'BN', 'BRN', 'AS', NULL, NULL, 'placeholder', 'semi_annual', 200, NULL, false),
  ('CAM', 'Cambodia Chess Federation', 'KH', 'KH', 'KHM', 'AS', NULL, NULL, 'placeholder', 'semi_annual', 300, NULL, false),
  ('CHN', 'Chinese Chess Association', 'CN', 'CN', 'CHN', 'AS', 'https://www.chinachess.org.cn', 'html', 'fetch-html', 'quarterly', 8000, 'CCA in PLAN.md; public data restricted', false),
  ('HKG', 'Hong Kong Chess Federation', 'HK', 'HK', 'HKG', 'AS', NULL, NULL, 'placeholder', 'quarterly', 500, NULL, false),
  ('IND', 'All India Chess Federation', 'IN', 'IN', 'IND', 'AS', 'https://www.aicf.in/ratings', 'html', 'fetch-html', 'quarterly', 35000, 'AICF in PLAN.md; geo-blocked from marketplace', false),
  ('INA', 'Persatuan Catur Seluruh Indonesia (PERCASI)', 'ID', 'ID', 'IDN', 'AS', NULL, NULL, 'placeholder', 'quarterly', 2000, NULL, false),
  ('IRI', 'Iran Chess Federation', 'IR', 'IR', 'IRN', 'AS', 'https://iranchessfederation.ir', 'html', 'fetch-html', 'semi_annual', 3000, 'Sanctions check on payments', false),
  ('IRQ', 'Iraqi Chess Federation', 'IQ', 'IQ', 'IRQ', 'AS', NULL, NULL, 'placeholder', 'semi_annual', 500, NULL, false),
  ('JOR', 'Jordan Chess Federation', 'JO', 'JO', 'JOR', 'AS', NULL, NULL, 'placeholder', 'semi_annual', 500, NULL, false),
  ('JPN', 'Japan Chess Association', 'JP', 'JP', 'JPN', 'AS', 'https://japanchess.org', 'html', 'fetch-html', 'quarterly', 3000, NULL, false),
  ('KGZ', 'Kyrgyzstan Chess Federation', 'KG', 'KG', 'KGZ', 'AS', NULL, NULL, 'placeholder', 'semi_annual', 400, NULL, false),
  ('KOR', 'Korea Chess Federation', 'KR', 'KR', 'KOR', 'AS', 'https://koreachess.org', 'html', 'fetch-html', 'semi_annual', 3000, NULL, false),
  ('KUW', 'Kuwait Chess Federation', 'KW', 'KW', 'KWT', 'AS', NULL, NULL, 'placeholder', 'semi_annual', 300, NULL, false),
  ('LAO', 'Lao Chess Federation', 'LA', 'LA', 'LAO', 'AS', NULL, NULL, 'placeholder', 'semi_annual', 100, NULL, false),
  ('LBN', 'Lebanese Chess Federation', 'LB', 'LB', 'LBN', 'AS', NULL, NULL, 'placeholder', 'semi_annual', 500, NULL, false),
  ('MAC', 'Macau Chess Association', 'MO', 'MO', 'MAC', 'AS', NULL, NULL, 'placeholder', 'semi_annual', 100, NULL, false),
  ('MAS', 'Malaysian Chess Federation', 'MY', 'MY', 'MYS', 'AS', NULL, NULL, 'placeholder', 'quarterly', 1500, NULL, false),
  ('MDV', 'Chess Association of Maldives', 'MV', 'MV', 'MDV', 'AS', NULL, NULL, 'placeholder', 'semi_annual', 100, NULL, false),
  ('MGL', 'Mongolian Chess Federation', 'MN', 'MN', 'MNG', 'AS', NULL, NULL, 'placeholder', 'semi_annual', 800, NULL, false),
  ('MYA', 'Myanmar Chess Federation', 'MM', 'MM', 'MMR', 'AS', NULL, NULL, 'placeholder', 'semi_annual', 200, NULL, false),
  ('NEP', 'Nepal Chess Association', 'NP', 'NP', 'NPL', 'AS', NULL, NULL, 'placeholder', 'semi_annual', 500, NULL, false),
  ('PAK', 'Chess Federation of Pakistan', 'PK', 'PK', 'PAK', 'AS', NULL, NULL, 'placeholder', 'quarterly', 1000, NULL, false),
  ('PHI', 'National Chess Federation of the Philippines', 'PH', 'PH', 'PHL', 'AS', 'https://www.ncfp.org.ph', 'html', 'fetch-html', 'semi_annual', 5000, NULL, false),
  ('PLE', 'Palestine Chess Federation', 'PS', 'PS', 'PSE', 'AS', NULL, NULL, 'placeholder', 'semi_annual', 200, NULL, false),
  ('PRK', 'Democratic People’s Republic of Korea Chess Federation', 'KP', 'KP', 'PRK', 'AS', NULL, NULL, 'placeholder', 'manual', 100, 'North Korea; limited data', false),
  ('QAT', 'Qatar Chess Federation', 'QA', 'QA', 'QAT', 'AS', NULL, NULL, 'placeholder', 'semi_annual', 300, NULL, false),
  ('KSA', 'Saudi Chess Association', 'SA', 'SA', 'SAU', 'AS', NULL, NULL, 'placeholder', 'semi_annual', 500, NULL, false),
  ('SGP', 'Singapore Chess Federation', 'SG', 'SG', 'SGP', 'AS', NULL, NULL, 'placeholder', 'quarterly', 800, NULL, false),
  ('SRI', 'Chess Federation of Sri Lanka', 'LK', 'LK', 'LKA', 'AS', NULL, NULL, 'placeholder', 'semi_annual', 800, NULL, false),
  ('SYR', 'Syrian Chess Federation', 'SY', 'SY', 'SYR', 'AS', NULL, NULL, 'placeholder', 'semi_annual', 300, NULL, false),
  ('TJK', 'Tajikistan Chess Federation', 'TJ', 'TJ', 'TJK', 'AS', NULL, NULL, 'placeholder', 'semi_annual', 300, NULL, false),
  ('TKM', 'Turkmenistan Chess Federation', 'TM', 'TM', 'TKM', 'AS', NULL, NULL, 'placeholder', 'semi_annual', 300, NULL, false),
  ('TLS', 'Timor-Leste Chess Federation', 'TL', 'TL', 'TLS', 'AS', NULL, NULL, 'placeholder', 'semi_annual', 100, NULL, false),
  ('TPE', 'Chinese Taipei Chess Association', 'TW', 'TW', 'TWN', 'AS', NULL, NULL, 'placeholder', 'semi_annual', 500, 'FIDE uses TPE for Taiwan', false),
  ('UAE', 'United Arab Emirates Chess Federation', 'AE', 'AE', 'ARE', 'AS', NULL, NULL, 'placeholder', 'semi_annual', 500, NULL, false),
  ('UZB', 'Uzbekistan Chess Federation', 'UZ', 'UZ', 'UZB', 'AS', 'https://chess.uz', 'html', 'fetch-html', 'quarterly', 4000, 'Emerging', false),
  ('VIE', 'Vietnam Chess Federation', 'VN', 'VN', 'VNM', 'AS', 'https://vietnamchess.vn', 'html', 'fetch-html', 'semi_annual', 3000, NULL, false),
  ('YEM', 'Yemen Chess Federation', 'YE', 'YE', 'YEM', 'AS', NULL, NULL, 'placeholder', 'semi_annual', 200, NULL, false),
  ('ALG', 'Fédération Algérienne des Échecs', 'DZ', 'DZ', 'DZA', 'AF', NULL, NULL, 'placeholder', 'semi_annual', 1500, NULL, false),
  ('ANG', 'Federação Angolana de Xadrez', 'AO', 'AO', 'AGO', 'AF', NULL, NULL, 'placeholder', 'semi_annual', 500, NULL, false),
  ('BDI', 'Fédération Burundaise des Échecs', 'BI', 'BI', 'BDI', 'AF', NULL, NULL, 'placeholder', 'semi_annual', 200, NULL, false),
  ('BEN', 'Fédération Béninoise des Échecs', 'BJ', 'BJ', 'BEN', 'AF', NULL, NULL, 'placeholder', 'semi_annual', 200, NULL, false),
  ('BOT', 'Botswana Chess Federation', 'BW', 'BW', 'BWA', 'AF', NULL, NULL, 'placeholder', 'semi_annual', 300, NULL, false),
  ('BUR', 'Fédération Burkinabé des Échecs', 'BF', 'BF', 'BFA', 'AF', NULL, NULL, 'placeholder', 'semi_annual', 200, NULL, false),
  ('CAF', 'Fédération Centrafricaine des Échecs', 'CF', 'CF', 'CAF', 'AF', NULL, NULL, 'placeholder', 'semi_annual', 100, NULL, false),
  ('CGO', 'Fédération Congolaise des Échecs', 'CG', 'CG', 'COG', 'AF', NULL, NULL, 'placeholder', 'semi_annual', 200, NULL, false),
  ('CHA', 'Fédération Tchadienne des Échecs', 'TD', 'TD', 'TCD', 'AF', NULL, NULL, 'placeholder', 'semi_annual', 100, NULL, false),
  ('CIV', 'Fédération Ivoirienne des Échecs', 'CI', 'CI', 'CIV', 'AF', NULL, NULL, 'placeholder', 'semi_annual', 400, NULL, false),
  ('CMR', 'Fédération Camerounaise des Échecs', 'CM', 'CM', 'CMR', 'AF', NULL, NULL, 'placeholder', 'semi_annual', 400, NULL, false),
  ('COD', 'Fédération Congolaise des Échecs (RDC)', 'CD', 'CD', 'COD', 'AF', NULL, NULL, 'placeholder', 'semi_annual', 400, 'DRC', false),
  ('COM', 'Comoros Chess Federation', 'KM', 'KM', 'COM', 'AF', NULL, NULL, 'placeholder', 'semi_annual', 100, NULL, false),
  ('CPV', 'Federação Cabo-Verdiana de Xadrez', 'CV', 'CV', 'CPV', 'AF', NULL, NULL, 'placeholder', 'semi_annual', 100, NULL, false),
  ('DJI', 'Fédération Djiboutienne des Échecs', 'DJ', 'DJ', 'DJI', 'AF', NULL, NULL, 'placeholder', 'semi_annual', 100, NULL, false),
  ('EGY', 'Egyptian Chess Federation', 'EG', 'EG', 'EGY', 'AF', NULL, NULL, 'placeholder', 'semi_annual', 3000, NULL, false),
  ('ERI', 'Eritrea Chess Federation', 'ER', 'ER', 'ERI', 'AF', NULL, NULL, 'placeholder', 'semi_annual', 100, NULL, false),
  ('ETH', 'Ethiopian Chess Federation', 'ET', 'ET', 'ETH', 'AF', NULL, NULL, 'placeholder', 'semi_annual', 500, NULL, false),
  ('GAB', 'Fédération Gabonaise des Échecs', 'GA', 'GA', 'GAB', 'AF', NULL, NULL, 'placeholder', 'semi_annual', 200, NULL, false),
  ('GAM', 'Gambia Chess Federation', 'GM', 'GM', 'GMB', 'AF', NULL, NULL, 'placeholder', 'semi_annual', 100, NULL, false),
  ('GEQ', 'Equatorial Guinea Chess Federation', 'GQ', 'GQ', 'GNQ', 'AF', NULL, NULL, 'placeholder', 'semi_annual', 100, NULL, false),
  ('GHA', 'Ghana Chess Association', 'GH', 'GH', 'GHA', 'AF', NULL, NULL, 'placeholder', 'semi_annual', 400, NULL, false),
  ('GUI', 'Fédération Guinéenne des Échecs', 'GN', 'GN', 'GIN', 'AF', NULL, NULL, 'placeholder', 'semi_annual', 200, NULL, false),
  ('KEN', 'Chess Kenya', 'KE', 'KE', 'KEN', 'AF', NULL, NULL, 'placeholder', 'semi_annual', 800, NULL, false),
  ('LBR', 'Liberia Chess Federation', 'LR', 'LR', 'LBR', 'AF', NULL, NULL, 'placeholder', 'semi_annual', 100, NULL, false),
  ('LBY', 'Libyan Chess Federation', 'LY', 'LY', 'LBY', 'AF', NULL, NULL, 'placeholder', 'semi_annual', 300, NULL, false),
  ('LES', 'Lesotho Chess Federation', 'LS', 'LS', 'LSO', 'AF', NULL, NULL, 'placeholder', 'semi_annual', 100, NULL, false),
  ('MAD', 'Fédération Malgache des Échecs', 'MG', 'MG', 'MDG', 'AF', NULL, NULL, 'placeholder', 'semi_annual', 300, NULL, false),
  ('MAR', 'Fédération Royale Marocaine des Échecs', 'MA', 'MA', 'MAR', 'AF', NULL, NULL, 'placeholder', 'semi_annual', 1500, 'Morocco', false),
  ('MAW', 'Chess Association of Malawi', 'MW', 'MW', 'MWI', 'AF', NULL, NULL, 'placeholder', 'semi_annual', 200, NULL, false),
  ('MLI', 'Fédération Malienne des Échecs', 'ML', 'ML', 'MLI', 'AF', NULL, NULL, 'placeholder', 'semi_annual', 200, NULL, false),
  ('MOZ', 'Federação Moçambicana de Xadrez', 'MZ', 'MZ', 'MOZ', 'AF', NULL, NULL, 'placeholder', 'semi_annual', 300, NULL, false),
  ('MRI', 'Mauritius Chess Federation', 'MU', 'MU', 'MUS', 'AF', NULL, NULL, 'placeholder', 'semi_annual', 300, NULL, false),
  ('MTN', 'Fédération Mauritanienne des Échecs', 'MR', 'MR', 'MRT', 'AF', NULL, NULL, 'placeholder', 'semi_annual', 100, NULL, false),
  ('NAM', 'Namibia Chess Federation', 'NA', 'NA', 'NAM', 'AF', NULL, NULL, 'placeholder', 'semi_annual', 300, NULL, false),
  ('NGR', 'Nigeria Chess Federation', 'NG', 'NG', 'NGA', 'AF', NULL, NULL, 'placeholder', 'semi_annual', 1500, NULL, false),
  ('NIG', 'Fédération Nigérienne des Échecs', 'NE', 'NE', 'NER', 'AF', NULL, NULL, 'placeholder', 'semi_annual', 100, 'Niger (not Nigeria)', false),
  ('RSA', 'Chess South Africa', 'ZA', 'ZA', 'ZAF', 'AF', 'https://www.chessa.co.za', 'html', 'fetch-html', 'semi_annual', 3000, 'CHESSA in PLAN.md', false),
  ('RWA', 'Rwanda Chess Federation', 'RW', 'RW', 'RWA', 'AF', NULL, NULL, 'placeholder', 'semi_annual', 200, NULL, false),
  ('SEN', 'Fédération Sénégalaise des Échecs', 'SN', 'SN', 'SEN', 'AF', NULL, NULL, 'placeholder', 'semi_annual', 200, NULL, false),
  ('SEY', 'Seychelles Chess Federation', 'SC', 'SC', 'SYC', 'AF', NULL, NULL, 'placeholder', 'semi_annual', 100, NULL, false),
  ('SLE', 'Sierra Leone Chess Federation', 'SL', 'SL', 'SLE', 'AF', NULL, NULL, 'placeholder', 'semi_annual', 100, NULL, false),
  ('SOM', 'Somali Chess Federation', 'SO', 'SO', 'SOM', 'AF', NULL, NULL, 'placeholder', 'semi_annual', 100, NULL, false),
  ('SSD', 'South Sudan Chess Federation', 'SS', 'SS', 'SSD', 'AF', NULL, NULL, 'placeholder', 'semi_annual', 100, NULL, false),
  ('STP', 'São Tomé and Príncipe Chess Federation', 'ST', 'ST', 'STP', 'AF', NULL, NULL, 'placeholder', 'semi_annual', 100, NULL, false),
  ('SUD', 'Sudan Chess Federation', 'SD', 'SD', 'SDN', 'AF', NULL, NULL, 'placeholder', 'semi_annual', 300, NULL, false),
  ('SWZ', 'Eswatini Chess Federation', 'SZ', 'SZ', 'SWZ', 'AF', NULL, NULL, 'placeholder', 'semi_annual', 200, 'Formerly Swaziland', false),
  ('TAN', 'Tanzania Chess Federation', 'TZ', 'TZ', 'TZA', 'AF', NULL, NULL, 'placeholder', 'semi_annual', 400, NULL, false),
  ('TOG', 'Fédération Togolaise des Échecs', 'TG', 'TG', 'TGO', 'AF', NULL, NULL, 'placeholder', 'semi_annual', 100, NULL, false),
  ('TUN', 'Fédération Tunisienne des Échecs', 'TN', 'TN', 'TUN', 'AF', NULL, NULL, 'placeholder', 'semi_annual', 1500, NULL, false),
  ('UGA', 'Uganda Chess Federation', 'UG', 'UG', 'UGA', 'AF', NULL, NULL, 'placeholder', 'semi_annual', 400, NULL, false),
  ('ZAM', 'Chess Federation of Zambia', 'ZM', 'ZM', 'ZMB', 'AF', NULL, NULL, 'placeholder', 'semi_annual', 400, NULL, false),
  ('ZIM', 'Zimbabwe Chess Federation', 'ZW', 'ZW', 'ZWE', 'AF', NULL, NULL, 'placeholder', 'semi_annual', 400, NULL, false),
  ('AUS', 'Australian Chess Federation', 'AU', 'AU', 'AUS', 'OC', 'https://auschess.org.au/rating/', 'html', 'fetch-html', 'quarterly', 5000, 'ACF in PLAN.md; quarterly periods', false),
  ('COK', 'Cook Islands Chess Federation', 'CK', 'CK', 'COK', 'OC', NULL, NULL, 'placeholder', 'manual', 50, NULL, false),
  ('FIJ', 'Fiji Chess Federation', 'FJ', 'FJ', 'FJI', 'OC', NULL, NULL, 'placeholder', 'semi_annual', 200, NULL, false),
  ('FSM', 'Federated States of Micronesia Chess Federation', 'FM', 'FM', 'FSM', 'OC', NULL, NULL, 'placeholder', 'manual', 50, NULL, false),
  ('GUM', 'Guam Chess Federation', 'GU', 'GU', 'GUM', 'OC', NULL, NULL, 'placeholder', 'semi_annual', 100, NULL, false),
  ('KIR', 'Kiribati Chess Federation', 'KI', 'KI', 'KIR', 'OC', NULL, NULL, 'placeholder', 'manual', 50, NULL, false),
  ('MHL', 'Marshall Islands Chess Federation', 'MH', 'MH', 'MHL', 'OC', NULL, NULL, 'placeholder', 'manual', 50, NULL, false),
  ('NMA', 'Northern Mariana Islands Chess Federation', 'MP', 'MP', 'MNP', 'OC', NULL, NULL, 'placeholder', 'manual', 50, NULL, false),
  ('NRU', 'Nauru Chess Federation', 'NR', 'NR', 'NRU', 'OC', NULL, NULL, 'placeholder', 'manual', 50, NULL, false),
  ('NZL', 'New Zealand Chess Federation', 'NZ', 'NZ', 'NZL', 'OC', 'https://www.newzealandchess.co.nz', 'html', 'fetch-html', 'semi_annual', 2000, 'NZCF in PLAN.md', false),
  ('PLW', 'Palau Chess Federation', 'PW', 'PW', 'PLW', 'OC', NULL, NULL, 'placeholder', 'manual', 50, NULL, false),
  ('PNG', 'Papua New Guinea Chess Federation', 'PG', 'PG', 'PNG', 'OC', NULL, NULL, 'placeholder', 'semi_annual', 200, NULL, false),
  ('SAM', 'Samoa Chess Federation', 'WS', 'WS', 'WSM', 'OC', NULL, NULL, 'placeholder', 'semi_annual', 100, NULL, false),
  ('SOL', 'Solomon Islands Chess Federation', 'SB', 'SB', 'SLB', 'OC', NULL, NULL, 'placeholder', 'semi_annual', 100, NULL, false),
  ('TAH', 'Fédération Tahitienne des Échecs', 'PF', 'PF', 'PYF', 'OC', NULL, NULL, 'placeholder', 'semi_annual', 100, 'French Polynesia', false),
  ('TGA', 'Tonga Chess Federation', 'TO', 'TO', 'TON', 'OC', NULL, NULL, 'placeholder', 'semi_annual', 100, NULL, false),
  ('TUV', 'Tuvalu Chess Federation', 'TV', 'TV', 'TUV', 'OC', NULL, NULL, 'placeholder', 'manual', 50, NULL, false),
  ('VAN', 'Vanuatu Chess Federation', 'VU', 'VU', 'VUT', 'OC', NULL, NULL, 'placeholder', 'semi_annual', 100, NULL, false)
ON CONFLICT (id) DO UPDATE SET
  name               = EXCLUDED.name,
  country            = COALESCE(EXCLUDED.country, federations.country),
  iso2               = COALESCE(EXCLUDED.iso2, federations.iso2),
  iso3               = COALESCE(EXCLUDED.iso3, federations.iso3),
  continent          = COALESCE(EXCLUDED.continent, federations.continent),
  rating_list_url    = COALESCE(EXCLUDED.rating_list_url, federations.rating_list_url),
  rating_list_format = COALESCE(EXCLUDED.rating_list_format, federations.rating_list_format),
  scrape_strategy    = COALESCE(EXCLUDED.scrape_strategy, federations.scrape_strategy),
  sync_cadence       = COALESCE(EXCLUDED.sync_cadence, federations.sync_cadence),
  est_player_count   = COALESCE(EXCLUDED.est_player_count, federations.est_player_count),
  notes              = COALESCE(EXCLUDED.notes, federations.notes);
  -- `active` deliberately omitted from the SET clause: never overwrite. Existing
  -- FIDE/ICF/USCF/ECF/DSB/FSI/FFE rows keep their pre-migration active state.

-- Sanity counts for in-migration assertion (read by ops post-deploy).
DO $$
DECLARE
  total int;
  active int;
BEGIN
  SELECT count(*), count(*) FILTER (WHERE active) INTO total, active FROM federations;
  RAISE NOTICE 'federations: total=%, active=%', total, active;
END $$;
