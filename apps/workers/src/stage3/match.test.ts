/**
 * In-memory regression tests for the cohort-aware matcher.
 *
 * No DB connection required — we build PlayerFeaturesV0 vectors by hand
 * and assert that compareFingerprints() with cohort='few_games' weights
 * opening signals higher than scalar signals.
 *
 *   pnpm --filter @chessco/workers exec tsx src/stage3/match.test.ts
 */
import type { PlayerFeaturesV0 } from '../features/types';
import { compareFingerprints, cohortFromSampleSize } from './match';

function feat(overrides: Partial<PlayerFeaturesV0>): PlayerFeaturesV0 {
  return {
    version: 'v0',
    games_total: 5,
    games_as_white: 3,
    games_as_black: 2,
    wins_as_white: 0,
    losses_as_white: 0,
    draws_as_white: 0,
    wins_as_black: 0,
    losses_as_black: 0,
    draws_as_black: 0,
    eco_white: {},
    eco_black: {},
    move_seq_white: {},
    move_seq_black: {},
    time_class: {},
    termination: {},
    avg_ply_count: 0,
    avg_opponent_rating: null,
    opponent_rating_min: null,
    opponent_rating_max: null,
    earliest_played_at: new Date(0).toISOString(),
    latest_played_at: new Date(0).toISOString(),
    analyzed_games: 0,
    mean_cp_loss: null,
    mean_cp_loss_white: null,
    mean_cp_loss_black: null,
    blunder_rate: null,
    ...overrides,
  } as PlayerFeaturesV0;
}

let failures = 0;
function expect(label: string, ok: boolean, detail: string): void {
  if (ok) {
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.log(`  ✗ ${label} — ${detail}`);
  }
}

console.log('cohortFromSampleSize threshold');
expect(
  '5 games → few_games',
  cohortFromSampleSize(5) === 'few_games',
  `got ${cohortFromSampleSize(5)}`,
);
expect(
  '8 games → few_games',
  cohortFromSampleSize(8) === 'few_games',
  `got ${cohortFromSampleSize(8)}`,
);
expect(
  '9 games → standard',
  cohortFromSampleSize(9) === 'standard',
  `got ${cohortFromSampleSize(9)}`,
);
expect(
  '100 games → standard',
  cohortFromSampleSize(100) === 'standard',
  `got ${cohortFromSampleSize(100)}`,
);

console.log('\nfew_games downweights opp_rating noise');
{
  // Two candidates have identical opening fingerprints to the target.
  // Candidate A has a wildly mismatched avg_opponent_rating; B matches.
  // Under standard weights, A's penalty pushes A below B. Under few_games,
  // the opp_rating term is zeroed out, so A and B should score equally.
  const target = feat({
    eco_white: { B40: 0.6, B20: 0.4 },
    move_seq_white: { 'e4 c5 Nf3': 1.0 },
    avg_opponent_rating: 1800,
  });
  const candA = feat({
    eco_white: { B40: 0.6, B20: 0.4 },
    move_seq_white: { 'e4 c5 Nf3': 1.0 },
    avg_opponent_rating: 2400, // 600 off → near-zero gaussian
  });
  const candB = feat({
    eco_white: { B40: 0.6, B20: 0.4 },
    move_seq_white: { 'e4 c5 Nf3': 1.0 },
    avg_opponent_rating: 1810, // close → near-1 gaussian
  });
  const std = compareFingerprints(target, candA, 'standard').combined;
  const stdB = compareFingerprints(target, candB, 'standard').combined;
  const few = compareFingerprints(target, candA, 'few_games').combined;
  const fewB = compareFingerprints(target, candB, 'few_games').combined;
  expect(
    'standard: B (matched rating) > A (mismatched)',
    stdB > std,
    `stdB=${stdB.toFixed(4)} std=${std.toFixed(4)}`,
  );
  expect(
    'few_games: A ≈ B (opp_rating zeroed)',
    Math.abs(few - fewB) < 1e-6,
    `few=${few.toFixed(6)} fewB=${fewB.toFixed(6)}`,
  );
  expect(
    'few_games scores >= standard for matching openings',
    few > std,
    `few=${few.toFixed(4)} std=${std.toFixed(4)}`,
  );
}

console.log('\nfew_games preserves opening discrimination');
{
  const target = feat({
    eco_white: { B40: 1.0 },
    move_seq_white: { 'e4 c5 Nf3 d6': 1.0 },
  });
  const matchingOpening = feat({
    eco_white: { B40: 1.0 },
    move_seq_white: { 'e4 c5 Nf3 d6': 1.0 },
  });
  const differentOpening = feat({
    eco_white: { D20: 1.0 },
    move_seq_white: { 'd4 d5 c4 dxc4': 1.0 },
  });
  const matchScore = compareFingerprints(target, matchingOpening, 'few_games').combined;
  const offScore = compareFingerprints(target, differentOpening, 'few_games').combined;
  expect(
    'matching opening beats mismatched in few_games',
    matchScore > offScore,
    `match=${matchScore.toFixed(4)} off=${offScore.toFixed(4)}`,
  );
  expect(
    'matching opening scores ≥ 0.45 (heavily weighted)',
    matchScore >= 0.45,
    `match=${matchScore.toFixed(4)}`,
  );
}

console.log('\nweight profiles sum to 1.0');
{
  // Build a feature pair that scores 1.0 on every component (identical
  // vectors) and assert combined ≈ 1.0 in both cohorts.
  const t = feat({
    eco_white: { B40: 1.0 },
    eco_black: { C45: 1.0 },
    move_seq_white: { 'e4 c5': 1.0 },
    move_seq_black: { 'e4 e5': 1.0 },
    time_class: { blitz: 1.0 },
    avg_opponent_rating: 1800,
    mean_cp_loss: 30,
  });
  const stdSum = compareFingerprints(t, t, 'standard').combined;
  const fewSum = compareFingerprints(t, t, 'few_games').combined;
  expect('standard self-similarity ≈ 1.0', Math.abs(stdSum - 1) < 1e-6, `got ${stdSum.toFixed(6)}`);
  expect(
    'few_games self-similarity ≈ 1.0',
    Math.abs(fewSum - 1) < 1e-6,
    `got ${fewSum.toFixed(6)}`,
  );
}

if (failures > 0) {
  console.error(`\n${failures} test(s) failed`);
  process.exit(1);
} else {
  console.log('\nall match.test.ts assertions passed');
}
