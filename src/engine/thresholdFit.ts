import { WILSON_Z } from '../shared/catalog.ts';

/**
 * The Wilson bound qualification uses (assistant spec §4.4). The chain's threshold fitting (a grid over labelled
 * records) is not ported: emulated backends stay uncalibrated, so their AUTO band stays off.
 */

/** Wilson score upper bound of an error rate: `errors` out of `n`. 1 when there is nothing to go on. */
export function wilsonUpper(errors: number, n: number, z: number = WILSON_Z.default): number {
  if (!(n > 0)) return 1;
  const p = errors / n, z2 = z * z;
  const centre = p + z2 / (2 * n);
  const spread = z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n));
  return Math.min(1, (centre + spread) / (1 + z2 / n));
}
