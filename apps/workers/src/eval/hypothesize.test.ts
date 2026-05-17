/**
 * Hypothesizer v2 (sprint lever 2) unit tests.
 *
 *   pnpm --filter @chessco/workers exec tsx src/eval/hypothesize.test.ts
 */
import { hypothesizeHandles } from '../identification/hypothesize';

let failures = 0;
function expect(label: string, ok: boolean, detail: string): void {
  if (ok) console.log(`  ✓ ${label}`);
  else {
    failures++;
    console.log(`  ✗ ${label} — ${detail}`);
  }
}

console.log('hypothesizeHandles — baseline (Magnus Carlsen, NOR, 1990)');
{
  const hs = hypothesizeHandles({
    name: 'Carlsen, Magnus',
    country: 'NOR',
    birth_year: 1990,
  });
  const handles = hs.map((h) => h.handle);
  expect('contains "carlsen"', handles.includes('carlsen'), `got ${handles.slice(0, 5).join(',')}`);
  expect('contains "magnuscarlsen"', handles.includes('magnuscarlsen'), 'missing firstlast');
  expect('contains "carlsen90"', handles.includes('carlsen90'), 'missing last+YY');
  expect('contains "carlsen_nor"', handles.includes('carlsen_nor'), 'missing last_country');
  expect('contains "carlsenchess"', handles.includes('carlsenchess'), 'missing last+chess');
  expect('contains "carlsen_chess"', handles.includes('carlsen_chess'), 'missing last_chess');
}

console.log('hypothesizeHandles — nickname mapping (William Smith)');
{
  const hs = hypothesizeHandles({
    name: 'Smith, William',
    country: 'USA',
    birth_year: 1985,
  });
  const handles = hs.map((h) => h.handle);
  expect('contains "willsmith"', handles.includes('willsmith'), 'missing will-nickname firstlast');
  expect('contains "billsmith"', handles.includes('billsmith'), 'missing bill-nickname firstlast');
  expect('contains "liamsmith"', handles.includes('liamsmith'), 'missing liam-nickname firstlast');
  expect('contains "will_smith"', handles.includes('will_smith'), 'missing will_smith underscore');
}

console.log('hypothesizeHandles — Russian nickname (Alexander Grischuk)');
{
  const hs = hypothesizeHandles({
    name: 'Grischuk, Alexander',
    country: 'RUS',
    birth_year: 1983,
  });
  const handles = hs.map((h) => h.handle);
  expect('contains "alexgrischuk"', handles.includes('alexgrischuk'), 'missing alex variant');
  expect('contains "sashagrischuk"', handles.includes('sashagrischuk'), 'missing sasha variant');
  expect('contains "grischukrus"', handles.includes('grischukrus'), 'missing country suffix');
}

console.log('hypothesizeHandles — DOB on first name (Hikaru Nakamura)');
{
  const hs = hypothesizeHandles({
    name: 'Nakamura, Hikaru',
    country: 'USA',
    birth_year: 1987,
  });
  const handles = hs.map((h) => h.handle);
  expect('contains "hikaru87"', handles.includes('hikaru87'), 'missing first+YY');
  expect('contains "nakamura87"', handles.includes('nakamura87'), 'missing last+YY (regression)');
}

console.log('hypothesizeHandles — transliteration alternates');
{
  const hs = hypothesizeHandles({
    name: 'Andreikin, Daniil',
    country: 'RUS',
    birth_year: 1990,
  });
  const handles = hs.map((h) => h.handle);
  // -ei → -ey transliteration rule
  expect(
    'contains transliteration alt (ei→ey)',
    handles.some((h) => h.includes('andreykin') || h.includes('andreikin')),
    `got ${handles.filter((h) => h.startsWith('andre')).join(',')}`,
  );
}

console.log('hypothesizeHandles — single token (mononym handling)');
{
  const hs = hypothesizeHandles({
    name: 'Caruana',
    country: 'USA',
    birth_year: 1992,
  });
  const handles = hs.map((h) => h.handle);
  expect('contains "caruana"', handles.includes('caruana'), 'missing single-token last');
  expect('contains "caruana92"', handles.includes('caruana92'), 'missing single-token last+YY');
  expect(
    'contains "caruanachess"',
    handles.includes('caruanachess'),
    'missing single-token last+chess',
  );
}

console.log('hypothesizeHandles — slice(0,10) preserves strongest signals');
{
  const top10 = hypothesizeHandles({
    name: 'Carlsen, Magnus',
    country: 'NOR',
    birth_year: 1990,
  })
    .slice(0, 10)
    .map((h) => h.handle);
  expect('top-10 contains "carlsen"', top10.includes('carlsen'), `top10=${top10.join(',')}`);
  expect(
    'top-10 contains "magnuscarlsen"',
    top10.includes('magnuscarlsen'),
    `top10=${top10.join(',')}`,
  );
}

console.log('hypothesizeHandles — empty / degenerate input');
{
  const hs = hypothesizeHandles({ name: '', country: null, birth_year: null });
  expect('empty name returns []', hs.length === 0, `got ${hs.length}`);
  const stopOnly = hypothesizeHandles({ name: 'Jr, Sr', country: null, birth_year: null });
  expect('stopword-only returns []', stopOnly.length === 0, `got ${stopOnly.length}`);
}

console.log('hypothesizeHandles — variant count (v2 expands beyond v1 ~20)');
{
  const hs = hypothesizeHandles({
    name: 'Carlsen, Magnus',
    country: 'NOR',
    birth_year: 1990,
  });
  // v1 produced ~20. v2 should produce significantly more, but cap each at 25 chars.
  expect('generates >25 variants for full input', hs.length > 25, `got ${hs.length}`);
  expect(
    'every handle within length bounds [3,25]',
    hs.every((h) => h.handle.length >= 3 && h.handle.length <= 25),
    `outliers: ${hs
      .filter((h) => h.handle.length < 3 || h.handle.length > 25)
      .map((h) => h.handle)
      .join(',')}`,
  );
  const dupes = new Set<string>();
  for (const h of hs) dupes.add(h.handle);
  expect('no duplicate handles', dupes.size === hs.length, `${hs.length - dupes.size} dupes`);
}

if (failures > 0) {
  console.log(`\n${failures} test(s) failed`);
  process.exit(1);
}
console.log('\nAll hypothesize.test.ts assertions passed');
