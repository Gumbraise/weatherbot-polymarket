import { KELLY_FRACTION, MAX_BET, SIGMA_F, SIGMA_C, LOCATIONS } from "./config.js";

export function erf(x: number): number {
  const a1 =  0.254829592;
  const a2 = -0.284496736;
  const a3 =  1.421413741;
  const a4 = -1.453152027;
  const a5 =  1.061405429;
  const p  =  0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}

export function normCdf(x: number): number {
  return 0.5 * (1.0 + erf(x / Math.sqrt(2.0)));
}

export function inBucket(forecast: number, tLow: number, tHigh: number): boolean {
  if (tLow === tHigh) return Math.round(forecast) === Math.round(tLow);
  return tLow <= forecast && forecast <= tHigh;
}

export function bucketProb(forecast: number, tLow: number, tHigh: number, sigma: number | null = null): number {
  const s = sigma || 2.0;
  if (tLow === -999) return normCdf((tHigh - forecast) / s);
  if (tHigh === 999) return 1.0 - normCdf((tLow - forecast) / s);
  return inBucket(forecast, tLow, tHigh) ? 1.0 : 0.0;
}

export function calcEv(p: number, price: number): number {
  if (price <= 0 || price >= 1) return 0.0;
  return round4(p * (1.0 / price - 1.0) - (1.0 - p));
}

export function calcKelly(p: number, price: number): number {
  if (price <= 0 || price >= 1) return 0.0;
  const b = 1.0 / price - 1.0;
  const f = (p * b - (1.0 - p)) / b;
  return round4(Math.min(Math.max(0.0, f) * KELLY_FRACTION, 1.0));
}

export function betSize(kelly: number, balance: number): number {
  return round2(Math.min(kelly * balance, MAX_BET));
}

export function getSigma(citySlug: string, _source = "ecmwf"): number {
  return LOCATIONS[citySlug].unit === "F" ? SIGMA_F : SIGMA_C;
}

export function round2(n: number): number { return Math.round(n * 100) / 100; }
export function round4(n: number): number { return Math.round(n * 10000) / 10000; }
