// One-off generator: parses directory.ts and emits SQL VALUES tuples.
// Usage: node packages/db/scripts/_gen_seed.mjs > /tmp/fed_values.sql
import fs from 'node:fs';

const txt = fs.readFileSync(
  'c:/xampp/htdocs/chessco/apps/workers/src/lib/federations/directory.ts',
  'utf8',
);

const rowRe = /\{\s*code:\s*'[^']+'[\s\S]*?\},?\s*\n/g;

const sqlString = (v) => (v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
const sqlInt = (v) => (v == null ? 'NULL' : String(v));
const sqlBool = (v) => (v ? 'true' : 'false');

function fieldValue(body, name) {
  // Match `<name>: <literal>` where literal is null/true/false/'...'/number-with-underscores
  const re = new RegExp(
    String.raw`\b` + name + String.raw`:\s*(null|true|false|'((?:[^'\\]|\\.)*)'|(-?\d[\d_]*))`,
  );
  const m = body.match(re);
  if (!m) return undefined;
  if (m[1] === 'null') return null;
  if (m[1] === 'true') return true;
  if (m[1] === 'false') return false;
  if (m[2] !== undefined) return m[2].replace(/\\'/g, "'");
  return Number(String(m[3]).replace(/_/g, ''));
}

const tuples = [];
for (const m of txt.matchAll(rowRe)) {
  const body = m[0];
  const code = fieldValue(body, 'code');
  if (!code) continue;
  const name = fieldValue(body, 'name');
  const iso2 = fieldValue(body, 'iso2');
  const iso3 = fieldValue(body, 'iso3');
  const continent = fieldValue(body, 'continent');
  const ratingListUrl = fieldValue(body, 'ratingListUrl');
  const ratingListFormat = fieldValue(body, 'ratingListFormat');
  const scrapeStrategy = fieldValue(body, 'scrapeStrategy');
  const syncCadence = fieldValue(body, 'syncCadence');
  const estPlayerCount = fieldValue(body, 'estPlayerCount');
  const notes = fieldValue(body, 'notes');
  const active = fieldValue(body, 'active');
  const country = iso2 ?? null;
  tuples.push(
    `  (${[
      sqlString(code),
      sqlString(name),
      sqlString(country),
      sqlString(iso2),
      sqlString(iso3),
      sqlString(continent),
      sqlString(ratingListUrl),
      sqlString(ratingListFormat),
      sqlString(scrapeStrategy),
      sqlString(syncCadence),
      sqlInt(estPlayerCount),
      sqlString(notes ?? null),
      sqlBool(active),
    ].join(', ')})`,
  );
}

process.stdout.write(tuples.join(',\n'));
process.stderr.write(`\nGenerated ${tuples.length} rows\n`);
