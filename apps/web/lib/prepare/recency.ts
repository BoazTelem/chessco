const HALF_LIFE_YEARS = 1.5;
const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;
const LN2 = Math.log(2);

export function recencyWeight(playedAt: Date, now: Date = new Date()): number {
  const ageYears = Math.max(0, (now.getTime() - playedAt.getTime()) / MS_PER_YEAR);
  return Math.exp(-LN2 * (ageYears / HALF_LIFE_YEARS));
}

export { HALF_LIFE_YEARS };
