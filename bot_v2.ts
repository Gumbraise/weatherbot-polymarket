#!/usr/bin/env tsx
/**
 * weatherbet.ts — Weather Trading Bot for Polymarket
 * =====================================================
 * Tracks weather forecasts from 3 sources (ECMWF, HRRR, METAR),
 * compares with Polymarket markets, paper trades using Kelly criterion.
 *
 * Usage:
 *     tsx bot_v2.ts          # main loop
 *     tsx bot_v2.ts report   # full report
 *     tsx bot_v2.ts status   # balance and open positions
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import axios from "axios";
import "dotenv/config";
import { Wallet } from "ethers";
import { ClobClient, Side, OrderType } from "@polymarket/clob-client";
import type { ApiKeyCreds, TickSize } from "@polymarket/clob-client";

// =============================================================================
// CONFIG
// =============================================================================

const __dirname = fileURLToPath(new URL(".", import.meta.url));

const env = (key: string, fallback: number): number => {
  const v = process.env[key];
  return v !== undefined ? Number(v) : fallback;
};

const BALANCE_FALLBACK = env("BALANCE", 10000.0);
const MAX_BET         = env("MAX_BET", 20.0);
const MIN_EV          = env("MIN_EV", 0.10);
const MAX_PRICE       = env("MAX_PRICE", 0.45);
const MIN_VOLUME      = env("MIN_VOLUME", 500);
const MIN_HOURS       = env("MIN_HOURS", 2.0);
const MAX_HOURS       = env("MAX_HOURS", 72.0);
const KELLY_FRACTION  = env("KELLY_FRACTION", 0.25);
const MAX_SLIPPAGE    = env("MAX_SLIPPAGE", 0.03);
const SCAN_INTERVAL   = env("SCAN_INTERVAL", 3600);
const CALIBRATION_MIN = env("CALIBRATION_MIN", 30);
const VC_KEY          = process.env.VC_KEY ?? "";

const POLY_WALLET     = process.env.POLY_WALLET ?? "";
const POLYGON_RPC     = process.env.POLYGON_RPC ?? "https://polygon-bor-rpc.publicnode.com";
const PRIVATE_KEY     = process.env.PRIVATE_KEY ?? "";
const LIVE_TRADING    = (process.env.LIVE_TRADING ?? "false").toLowerCase() === "true";
const CLOB_HOST       = "https://clob.polymarket.com";
// USDC.e on Polygon (used by Polymarket)
const USDC_CONTRACT   = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

const SIGMA_F = 2.0;
const SIGMA_C = 1.2;

const DATA_DIR         = join(__dirname, "data");
const STATE_FILE       = join(DATA_DIR, "state.json");
const MARKETS_DIR      = join(DATA_DIR, "markets");
const CALIBRATION_FILE = join(DATA_DIR, "calibration.json");

for (const dir of [DATA_DIR, MARKETS_DIR]) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// =============================================================================
// TYPES
// =============================================================================

interface Location {
  lat: number;
  lon: number;
  name: string;
  station: string;
  unit: "F" | "C";
  region: string;
}

interface Position {
  market_id: string;
  token_id?: string;
  question: string;
  bucket_low: number;
  bucket_high: number;
  entry_price: number;
  bid_at_entry: number;
  spread: number;
  shares: number;
  cost: number;
  p: number;
  ev: number;
  kelly: number;
  forecast_temp: number;
  forecast_src: string | null;
  sigma: number;
  opened_at: string | null;
  status: "open" | "closed";
  pnl: number | null;
  exit_price: number | null;
  close_reason: string | null;
  closed_at: string | null;
  stop_price?: number;
  trailing_activated?: boolean;
  neg_risk?: boolean;
  tick_size?: string;
}

interface Outcome {
  question: string;
  market_id: string;
  token_id: string;
  range: [number, number];
  bid: number;
  ask: number;
  price: number;
  spread: number;
  volume: number;
  neg_risk: boolean;
  tick_size: string;
}

interface ForecastSnap {
  ts: string | null;
  horizon: string;
  hours_left: number;
  ecmwf: number | null;
  hrrr: number | null;
  metar: number | null;
  best: number | null;
  best_source: string | null;
}

interface MarketSnap {
  ts: string | null;
  top_bucket: string | null;
  top_price: number | null;
}

interface Market {
  city: string;
  city_name: string;
  date: string;
  unit: "F" | "C";
  station: string;
  event_end_date: string;
  hours_at_discovery: number;
  status: "open" | "closed" | "resolved";
  position: Position | null;
  actual_temp: number | null;
  resolved_outcome: "win" | "loss" | "no_position" | null;
  pnl: number | null;
  forecast_snapshots: ForecastSnap[];
  market_snapshots: MarketSnap[];
  all_outcomes: Outcome[];
  created_at: string;
}

interface State {
  balance: number;
  starting_balance: number;
  total_trades: number;
  wins: number;
  losses: number;
  peak_balance: number;
}

interface CalEntry {
  sigma: number;
  n: number;
  updated_at: string;
}

type CalMap = Record<string, CalEntry>;

// =============================================================================
// DATA
// =============================================================================

const LOCATIONS: Record<string, Location> = {
  "nyc":          { lat: 40.7772,  lon:  -73.8726, name: "New York City", station: "KLGA", unit: "F", region: "us" },
  "chicago":      { lat: 41.9742,  lon:  -87.9073, name: "Chicago",       station: "KORD", unit: "F", region: "us" },
  "miami":        { lat: 25.7959,  lon:  -80.2870, name: "Miami",         station: "KMIA", unit: "F", region: "us" },
  "dallas":       { lat: 32.8471,  lon:  -96.8518, name: "Dallas",        station: "KDAL", unit: "F", region: "us" },
  "seattle":      { lat: 47.4502,  lon: -122.3088, name: "Seattle",       station: "KSEA", unit: "F", region: "us" },
  "atlanta":      { lat: 33.6407,  lon:  -84.4277, name: "Atlanta",       station: "KATL", unit: "F", region: "us" },
  "london":       { lat: 51.5048,  lon:    0.0495, name: "London",        station: "EGLC", unit: "C", region: "eu" },
  "paris":        { lat: 48.9962,  lon:    2.5979, name: "Paris",         station: "LFPG", unit: "C", region: "eu" },
  "munich":       { lat: 48.3537,  lon:   11.7750, name: "Munich",        station: "EDDM", unit: "C", region: "eu" },
  "ankara":       { lat: 40.1281,  lon:   32.9951, name: "Ankara",        station: "LTAC", unit: "C", region: "eu" },
  "seoul":        { lat: 37.4691,  lon:  126.4505, name: "Seoul",         station: "RKSI", unit: "C", region: "asia" },
  "tokyo":        { lat: 35.7647,  lon:  140.3864, name: "Tokyo",         station: "RJTT", unit: "C", region: "asia" },
  "shanghai":     { lat: 31.1443,  lon:  121.8083, name: "Shanghai",      station: "ZSPD", unit: "C", region: "asia" },
  "singapore":    { lat:  1.3502,  lon:  103.9940, name: "Singapore",     station: "WSSS", unit: "C", region: "asia" },
  "lucknow":      { lat: 26.7606,  lon:   80.8893, name: "Lucknow",       station: "VILK", unit: "C", region: "asia" },
  "tel-aviv":     { lat: 32.0114,  lon:   34.8867, name: "Tel Aviv",      station: "LLBG", unit: "C", region: "asia" },
  "toronto":      { lat: 43.6772,  lon:  -79.6306, name: "Toronto",       station: "CYYZ", unit: "C", region: "ca" },
  "sao-paulo":    { lat: -23.4356, lon:  -46.4731, name: "Sao Paulo",     station: "SBGR", unit: "C", region: "sa" },
  "buenos-aires": { lat: -34.8222, lon:  -58.5358, name: "Buenos Aires",  station: "SAEZ", unit: "C", region: "sa" },
  "wellington":   { lat: -41.3272, lon:  174.8052, name: "Wellington",    station: "NZWN", unit: "C", region: "oc" },
};

const TIMEZONES: Record<string, string> = {
  "nyc": "America/New_York", "chicago": "America/Chicago",
  "miami": "America/New_York", "dallas": "America/Chicago",
  "seattle": "America/Los_Angeles", "atlanta": "America/New_York",
  "london": "Europe/London", "paris": "Europe/Paris",
  "munich": "Europe/Berlin", "ankara": "Europe/Istanbul",
  "seoul": "Asia/Seoul", "tokyo": "Asia/Tokyo",
  "shanghai": "Asia/Shanghai", "singapore": "Asia/Singapore",
  "lucknow": "Asia/Kolkata", "tel-aviv": "Asia/Jerusalem",
  "toronto": "America/Toronto", "sao-paulo": "America/Sao_Paulo",
  "buenos-aires": "America/Argentina/Buenos_Aires", "wellington": "Pacific/Auckland",
};

const MONTHS = ["january","february","march","april","may","june",
                "july","august","september","october","november","december"];

// =============================================================================
// MATH
// =============================================================================

function erf(x: number): number {
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

function normCdf(x: number): number {
  return 0.5 * (1.0 + erf(x / Math.sqrt(2.0)));
}

function inBucket(forecast: number, tLow: number, tHigh: number): boolean {
  if (tLow === tHigh) return Math.round(forecast) === Math.round(tLow);
  return tLow <= forecast && forecast <= tHigh;
}

function bucketProb(forecast: number, tLow: number, tHigh: number, sigma: number | null = null): number {
  const s = sigma || 2.0;
  if (tLow === -999) return normCdf((tHigh - forecast) / s);
  if (tHigh === 999) return 1.0 - normCdf((tLow - forecast) / s);
  return inBucket(forecast, tLow, tHigh) ? 1.0 : 0.0;
}

function calcEv(p: number, price: number): number {
  if (price <= 0 || price >= 1) return 0.0;
  return round4(p * (1.0 / price - 1.0) - (1.0 - p));
}

function calcKelly(p: number, price: number): number {
  if (price <= 0 || price >= 1) return 0.0;
  const b = 1.0 / price - 1.0;
  const f = (p * b - (1.0 - p)) / b;
  return round4(Math.min(Math.max(0.0, f) * KELLY_FRACTION, 1.0));
}

function betSize(kelly: number, balance: number): number {
  return round2(Math.min(kelly * balance, MAX_BET));
}

function round2(n: number): number { return Math.round(n * 100) / 100; }
function round4(n: number): number { return Math.round(n * 10000) / 10000; }

// =============================================================================
// CALIBRATION
// =============================================================================

let _cal: CalMap = {};

function loadCal(): CalMap {
  if (existsSync(CALIBRATION_FILE)) {
    return JSON.parse(readFileSync(CALIBRATION_FILE, "utf-8"));
  }
  return {};
}

function getSigma(citySlug: string, source = "ecmwf"): number {
  const key = `${citySlug}_${source}`;
  if (_cal[key]) return _cal[key].sigma;
  return LOCATIONS[citySlug].unit === "F" ? SIGMA_F : SIGMA_C;
}

function runCalibration(markets: Market[]): CalMap {
  const resolved = markets.filter(m => m.resolved_outcome && m.actual_temp != null);
  const cal = loadCal();
  const updated: string[] = [];

  for (const source of ["ecmwf", "hrrr", "metar"]) {
    const cities = [...new Set(resolved.map(m => m.city))];
    for (const city of cities) {
      const group = resolved.filter(m => m.city === city);
      const errors: number[] = [];
      for (const m of group) {
        const snaps = [...(m.forecast_snapshots || [])].reverse();
        const snap = snaps.find((s: any) => s.source === source);
        if (snap && (snap as any).temp != null) {
          errors.push(Math.abs((snap as any).temp - m.actual_temp!));
        }
      }
      if (errors.length < CALIBRATION_MIN) continue;
      const mae = errors.reduce((a, b) => a + b, 0) / errors.length;
      const key = `${city}_${source}`;
      const old = cal[key]?.sigma ?? (LOCATIONS[city].unit === "F" ? SIGMA_F : SIGMA_C);
      const newSigma = Math.round(mae * 1000) / 1000;
      cal[key] = { sigma: newSigma, n: errors.length, updated_at: new Date().toISOString() };
      if (Math.abs(newSigma - old) > 0.05) {
        updated.push(`${LOCATIONS[city].name} ${source}: ${old.toFixed(2)}->${newSigma.toFixed(2)}`);
      }
    }
  }

  writeFileSync(CALIBRATION_FILE, JSON.stringify(cal, null, 2), "utf-8");
  if (updated.length) console.log(`  [CAL] ${updated.join(", ")}`);
  return cal;
}

// =============================================================================
// POLYMARKET BALANCE (Polygon USDC.e via RPC)
// =============================================================================

async function fetchPolymarketBalance(): Promise<number | null> {
  if (!POLY_WALLET) return null;
  // balanceOf(address) selector = 0x70a08231, address padded to 32 bytes
  const addr = POLY_WALLET.replace("0x", "").toLowerCase().padStart(64, "0");
  const callData = `0x70a08231${addr}`;
  try {
    const { data } = await axios.post(POLYGON_RPC, {
      jsonrpc: "2.0", id: 1, method: "eth_call",
      params: [{ to: USDC_CONTRACT, data: callData }, "latest"],
    }, { timeout: 8000 });
    // USDC.e has 6 decimals
    return parseInt(data.result, 16) / 1e6;
  } catch (e: any) {
    console.log(`  [RPC] Failed to fetch balance: ${e.message}`);
    return null;
  }
}

// =============================================================================
// CLOB CLIENT (live trading)
// =============================================================================

let clobClient: ClobClient | null = null;

async function initClobClient(): Promise<void> {
  if (!LIVE_TRADING || !PRIVATE_KEY) {
    if (LIVE_TRADING) console.log("  [LIVE] PRIVATE_KEY missing — falling back to paper trading");
    return;
  }
  try {
    const signer = new Wallet(PRIVATE_KEY.startsWith("0x") ? PRIVATE_KEY : `0x${PRIVATE_KEY}`);

    // Use existing CLOB creds from .env if available, otherwise derive
    const envKey = process.env.CLOB_API_KEY ?? "";
    const envSecret = process.env.CLOB_SECRET ?? "";
    const envPassphrase = process.env.CLOB_PASSPHRASE ?? "";

    let creds: ApiKeyCreds;
    if (envKey && envSecret && envPassphrase) {
      creds = { key: envKey, secret: envSecret, passphrase: envPassphrase };
      console.log(`  [LIVE] Using CLOB creds from .env`);
    } else {
      const tempClient = new ClobClient(CLOB_HOST, 137, signer);
      creds = await tempClient.createOrDeriveApiKey();
      console.log(`  [LIVE] Derived CLOB creds (save them to .env to avoid this step)`);
      console.log(`  CLOB_API_KEY=${creds.key}`);
      console.log(`  CLOB_SECRET=${creds.secret}`);
      console.log(`  CLOB_PASSPHRASE=${creds.passphrase}`);
    }

    clobClient = new ClobClient(CLOB_HOST, 137, signer, creds, 2, POLY_WALLET || undefined);
    console.log(`  [LIVE] CLOB client ready — signer ${signer.address}`);
  } catch (e: any) {
    console.log(`  [LIVE] CLOB init failed: ${e.message} — falling back to paper trading`);
    clobClient = null;
  }
}

const VALID_TICK_SIZES = new Set(["0.1", "0.01", "0.001", "0.0001"]);

function toTickSize(s: string): TickSize {
  return VALID_TICK_SIZES.has(s) ? (s as TickSize) : "0.01";
}

async function placeLiveOrder(
  tokenId: string,
  side: "BUY" | "SELL",
  price: number,
  size: number,
  tickSize: string,
  negRisk: boolean,
): Promise<string | null> {
  if (!clobClient || !tokenId) return null;
  // CLOB minimum order size is $1 for marketable BUY orders
  const adjustedSize = side === "BUY" && size * price < 1.0
    ? Math.ceil(1.0 / price * 100) / 100
    : size;
  try {
    const resp = await clobClient.createAndPostOrder(
      {
        tokenID: tokenId,
        price,
        side: side === "BUY" ? Side.BUY : Side.SELL,
        size: adjustedSize,
      },
      { tickSize: toTickSize(tickSize), negRisk },
      OrderType.GTC,
    );
    const r = resp as any;
    if (r?.error || r?.status === 401 || r?.status === 400) {
      console.log(`  [LIVE ${side} FAILED] ${r.error ?? r.data?.error ?? JSON.stringify(r)}`);
      return null;
    }
    const orderId = r?.orderID ?? r?.id ?? null;
    if (!orderId) {
      console.log(`  [LIVE ${side} FAILED] No orderID in response: ${JSON.stringify(r)}`);
      return null;
    }
    console.log(`  [LIVE ${side}] Order ${orderId}`);
    return String(orderId);
  } catch (e: any) {
    console.log(`  [LIVE ${side} FAILED] ${e.message}`);
    return null;
  }
}

// =============================================================================
// HELPERS
// =============================================================================

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, n: number): Date {
  const result = new Date(d);
  result.setUTCDate(result.getUTCDate() + n);
  return result;
}

// =============================================================================
// FORECASTS
// =============================================================================

async function getEcmwf(citySlug: string, dates: string[]): Promise<Record<string, number>> {
  const loc = LOCATIONS[citySlug];
  const tempUnit = loc.unit === "F" ? "fahrenheit" : "celsius";
  const result: Record<string, number> = {};
  const tz = TIMEZONES[citySlug] || "UTC";
  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${loc.lat}&longitude=${loc.lon}` +
    `&daily=temperature_2m_max&temperature_unit=${tempUnit}` +
    `&forecast_days=7&timezone=${tz}` +
    `&models=ecmwf_ifs025&bias_correction=true`;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { data } = await axios.get(url, { timeout: 10000 });
      if (!data.error) {
        const times: string[] = data.daily.time;
        const temps: (number | null)[] = data.daily.temperature_2m_max;
        for (let i = 0; i < times.length; i++) {
          if (dates.includes(times[i]) && temps[i] != null) {
            result[times[i]] = loc.unit === "C"
              ? Math.round(temps[i]! * 10) / 10
              : Math.round(temps[i]!);
          }
        }
      }
      break;
    } catch (e: any) {
      if (attempt < 2) await sleep(3000);
      else console.log(`  [ECMWF] ${citySlug}: ${e.message}`);
    }
  }
  return result;
}

async function getHrrr(citySlug: string, dates: string[]): Promise<Record<string, number>> {
  const loc = LOCATIONS[citySlug];
  if (loc.region !== "us") return {};
  const result: Record<string, number> = {};
  const tz = TIMEZONES[citySlug] || "UTC";
  const url =
    `https://api.open-meteo.com/v1/forecast` +
    `?latitude=${loc.lat}&longitude=${loc.lon}` +
    `&daily=temperature_2m_max&temperature_unit=fahrenheit` +
    `&forecast_days=3&timezone=${tz}` +
    `&models=gfs_seamless`;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const { data } = await axios.get(url, { timeout: 10000 });
      if (!data.error) {
        const times: string[] = data.daily.time;
        const temps: (number | null)[] = data.daily.temperature_2m_max;
        for (let i = 0; i < times.length; i++) {
          if (dates.includes(times[i]) && temps[i] != null) {
            result[times[i]] = Math.round(temps[i]!);
          }
        }
      }
      break;
    } catch (e: any) {
      if (attempt < 2) await sleep(3000);
      else console.log(`  [HRRR] ${citySlug}: ${e.message}`);
    }
  }
  return result;
}

async function getMetar(citySlug: string): Promise<number | null> {
  const loc = LOCATIONS[citySlug];
  try {
    const url = `https://aviationweather.gov/api/data/metar?ids=${loc.station}&format=json`;
    const { data } = await axios.get(url, { timeout: 8000 });
    if (data && Array.isArray(data) && data.length > 0) {
      const tempC = data[0].temp;
      if (tempC != null) {
        return loc.unit === "F"
          ? Math.round(Number(tempC) * 9 / 5 + 32)
          : Math.round(Number(tempC) * 10) / 10;
      }
    }
  } catch (e: any) {
    console.log(`  [METAR] ${citySlug}: ${e.message}`);
  }
  return null;
}

async function getActualTemp(citySlug: string, dateStr: string): Promise<number | null> {
  const loc = LOCATIONS[citySlug];
  const vcUnit = loc.unit === "F" ? "us" : "metric";
  const url =
    `https://weather.visualcrossing.com/VisualCrossingWebServices/rest/services/timeline` +
    `/${loc.station}/${dateStr}/${dateStr}` +
    `?unitGroup=${vcUnit}&key=${VC_KEY}&include=days&elements=tempmax`;
  try {
    const { data } = await axios.get(url, { timeout: 8000 });
    const days = data.days || [];
    if (days.length > 0 && days[0].tempmax != null) {
      return Math.round(Number(days[0].tempmax) * 10) / 10;
    }
  } catch (e: any) {
    console.log(`  [VC] ${citySlug} ${dateStr}: ${e.message}`);
  }
  return null;
}

async function checkMarketResolved(marketId: string): Promise<boolean | null> {
  try {
    const { data } = await axios.get(
      `https://gamma-api.polymarket.com/markets/${marketId}`,
      { timeout: 8000 }
    );
    if (!data.closed) return null;
    const prices = JSON.parse(data.outcomePrices || "[0.5,0.5]");
    const yesPrice = Number(prices[0]);
    if (yesPrice >= 0.95) return true;
    if (yesPrice <= 0.05) return false;
    return null;
  } catch (e: any) {
    console.log(`  [RESOLVE] ${marketId}: ${e.message}`);
  }
  return null;
}

// =============================================================================
// POLYMARKET
// =============================================================================

async function getPolymarketEvent(citySlug: string, month: string, day: number, year: number): Promise<any | null> {
  const slug = `highest-temperature-in-${citySlug}-on-${month}-${day}-${year}`;
  try {
    const { data } = await axios.get(
      `https://gamma-api.polymarket.com/events?slug=${slug}`,
      { timeout: 8000 }
    );
    if (data && Array.isArray(data) && data.length > 0) return data[0];
  } catch { /* ignore */ }
  return null;
}

function parseTempRange(question: string): [number, number] | null {
  if (!question) return null;
  const num = "(-?\\d+(?:\\.\\d+)?)";

  if (/or below/i.test(question)) {
    const m = question.match(new RegExp(num + "[°]?[FC] or below", "i"));
    if (m) return [-999.0, Number(m[1])];
  }
  if (/or higher/i.test(question)) {
    const m = question.match(new RegExp(num + "[°]?[FC] or higher", "i"));
    if (m) return [Number(m[1]), 999.0];
  }
  {
    const m = question.match(new RegExp("between " + num + "-" + num + "[°]?[FC]", "i"));
    if (m) return [Number(m[1]), Number(m[2])];
  }
  {
    const m = question.match(new RegExp("be " + num + "[°]?[FC] on", "i"));
    if (m) {
      const v = Number(m[1]);
      return [v, v];
    }
  }
  return null;
}

function hoursToResolution(endDateStr: string): number {
  try {
    const end = new Date(endDateStr);
    return Math.max(0.0, (end.getTime() - Date.now()) / 3600000);
  } catch {
    return 999.0;
  }
}

// =============================================================================
// MARKET DATA STORAGE
// =============================================================================

function marketPath(citySlug: string, dateStr: string): string {
  return join(MARKETS_DIR, `${citySlug}_${dateStr}.json`);
}

function loadMarket(citySlug: string, dateStr: string): Market | null {
  const p = marketPath(citySlug, dateStr);
  if (existsSync(p)) return JSON.parse(readFileSync(p, "utf-8"));
  return null;
}

function saveMarket(market: Market): void {
  const p = marketPath(market.city, market.date);
  writeFileSync(p, JSON.stringify(market, null, 2), "utf-8");
}

function loadAllMarkets(): Market[] {
  const markets: Market[] = [];
  if (!existsSync(MARKETS_DIR)) return markets;
  for (const f of readdirSync(MARKETS_DIR)) {
    if (!f.endsWith(".json")) continue;
    try {
      markets.push(JSON.parse(readFileSync(join(MARKETS_DIR, f), "utf-8")));
    } catch { /* skip corrupt files */ }
  }
  return markets;
}

function newMarket(citySlug: string, dateStr: string, event: any, hours: number): Market {
  const loc = LOCATIONS[citySlug];
  return {
    city:               citySlug,
    city_name:          loc.name,
    date:               dateStr,
    unit:               loc.unit,
    station:            loc.station,
    event_end_date:     event.endDate || "",
    hours_at_discovery: Math.round(hours * 10) / 10,
    status:             "open",
    position:           null,
    actual_temp:        null,
    resolved_outcome:   null,
    pnl:                null,
    forecast_snapshots: [],
    market_snapshots:   [],
    all_outcomes:       [],
    created_at:         new Date().toISOString(),
  };
}

// =============================================================================
// STATE
// =============================================================================

function loadState(): State {
  if (existsSync(STATE_FILE)) {
    return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
  }
  return {
    balance:          BALANCE_FALLBACK,
    starting_balance: BALANCE_FALLBACK,
    total_trades:     0,
    wins:             0,
    losses:           0,
    peak_balance:     BALANCE_FALLBACK,
  };
}

async function syncBalance(state: State): Promise<void> {
  const live = await fetchPolymarketBalance();
  if (live != null) {
    state.balance = round2(live);
    if (state.starting_balance === BALANCE_FALLBACK) state.starting_balance = state.balance;
    state.peak_balance = Math.max(state.peak_balance, state.balance);
    console.log(`  [WALLET] Balance: $${state.balance.toFixed(2)}`);
  }
}

function saveState(state: State): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

// =============================================================================
// CORE LOGIC
// =============================================================================

async function takeForecastSnapshot(citySlug: string, dates: string[]) {
  const nowStr = new Date().toISOString();
  const ecmwf  = await getEcmwf(citySlug, dates);
  const hrrr   = await getHrrr(citySlug, dates);
  const today  = formatDate(new Date());

  const snapshots: Record<string, any> = {};
  for (const date of dates) {
    const maxHrrrDate = formatDate(addDays(new Date(), 2));
    const snap: any = {
      ts:    nowStr,
      ecmwf: ecmwf[date] ?? null,
      hrrr:  (date <= maxHrrrDate) ? (hrrr[date] ?? null) : null,
      metar: (date === today) ? await getMetar(citySlug) : null,
    };
    const loc = LOCATIONS[citySlug];
    if (loc.region === "us" && snap.hrrr != null) {
      snap.best = snap.hrrr;
      snap.best_source = "hrrr";
    } else if (snap.ecmwf != null) {
      snap.best = snap.ecmwf;
      snap.best_source = "ecmwf";
    } else {
      snap.best = null;
      snap.best_source = null;
    }
    snapshots[date] = snap;
  }
  return snapshots;
}

async function scanAndUpdate(): Promise<{ newPos: number; closed: number; resolved: number }> {
  const now     = new Date();
  const state   = loadState();
  await syncBalance(state);
  let balance   = state.balance;
  let newPos    = 0;
  let closed    = 0;
  let resolved  = 0;

  for (const [citySlug, loc] of Object.entries(LOCATIONS)) {
    const unitSym = loc.unit === "F" ? "F" : "C";
    process.stdout.write(`  -> ${loc.name}... `);

    let snapshots: Record<string, any>;
    try {
      const dates: string[] = [];
      for (let i = 0; i < 4; i++) dates.push(formatDate(addDays(now, i)));
      snapshots = await takeForecastSnapshot(citySlug, dates);
      await sleep(300);
    } catch (e: any) {
      console.log(`skipped (${e.message})`);
      continue;
    }

    const dates: string[] = [];
    for (let i = 0; i < 4; i++) dates.push(formatDate(addDays(now, i)));

    for (let i = 0; i < dates.length; i++) {
      const date = dates[i];
      const dt   = new Date(date + "T00:00:00Z");
      const event = await getPolymarketEvent(citySlug, MONTHS[dt.getUTCMonth()], dt.getUTCDate(), dt.getUTCFullYear());
      if (!event) continue;

      const endDate = event.endDate || "";
      const hours   = endDate ? hoursToResolution(endDate) : 0;
      const horizon = `D+${i}`;

      let mkt = loadMarket(citySlug, date);
      if (mkt === null) {
        if (hours < MIN_HOURS || hours > MAX_HOURS) continue;
        mkt = newMarket(citySlug, date, event, hours);
      }

      if (mkt.status === "resolved") continue;

      // Update outcomes list
      const outcomes: Outcome[] = [];
      for (const market of (event.markets || [])) {
        const question: string = market.question || "";
        const mid = String(market.id || "");
        const volume = Number(market.volume || 0);
        const rng = parseTempRange(question);
        if (!rng) continue;
        let bid: number, ask: number;
        try {
          const prices = JSON.parse(market.outcomePrices || "[0.5,0.5]");
          bid = Number(prices[0]);
          ask = prices.length > 1 ? Number(prices[1]) : bid;
        } catch { continue; }
        let tokenId = "";
        try {
          const tokenIds = JSON.parse(market.clobTokenIds || "[]");
          tokenId = tokenIds[0] || "";
        } catch { /* ignore */ }
        outcomes.push({
          question, market_id: mid, token_id: tokenId, range: rng,
          bid: round4(bid), ask: round4(ask), price: round4(bid),
          spread: round4(ask - bid), volume: Math.round(volume),
          neg_risk: !!market.negRisk,
          tick_size: String(market.orderPriceMinTickSize || "0.01"),
        });
      }

      outcomes.sort((a, b) => a.range[0] - b.range[0]);
      mkt.all_outcomes = outcomes;

      // Forecast snapshot
      const snap = snapshots[date] || {};
      const forecastSnap: ForecastSnap = {
        ts:          snap.ts ?? null,
        horizon,
        hours_left:  Math.round(hours * 10) / 10,
        ecmwf:       snap.ecmwf ?? null,
        hrrr:        snap.hrrr ?? null,
        metar:       snap.metar ?? null,
        best:        snap.best ?? null,
        best_source: snap.best_source ?? null,
      };
      mkt.forecast_snapshots.push(forecastSnap);

      // Market price snapshot
      const top = outcomes.length > 0
        ? outcomes.reduce((a, b) => a.price > b.price ? a : b)
        : null;
      const marketSnap: MarketSnap = {
        ts:         snap.ts ?? null,
        top_bucket: top ? `${top.range[0]}-${top.range[1]}${unitSym}` : null,
        top_price:  top ? top.price : null,
      };
      mkt.market_snapshots.push(marketSnap);

      const forecastTemp: number | null = snap.best ?? null;
      const bestSource: string | null   = snap.best_source ?? null;

      // --- STOP-LOSS AND TRAILING STOP ---
      if (mkt.position && mkt.position.status === "open") {
        const pos = mkt.position;
        let currentPrice: number | null = null;
        for (const o of outcomes) {
          if (o.market_id === pos.market_id) { currentPrice = o.price; break; }
        }

        if (currentPrice != null) {
          for (const o of outcomes) {
            if (o.market_id === pos.market_id) { currentPrice = o.bid ?? currentPrice; break; }
          }
          const entry = pos.entry_price;
          const stop  = pos.stop_price ?? entry * 0.80;

          if (currentPrice >= entry * 1.20 && stop < entry) {
            pos.stop_price = entry;
            pos.trailing_activated = true;
          }

          if (currentPrice <= stop) {
            if (LIVE_TRADING && clobClient && pos.token_id) {
              await placeLiveOrder(pos.token_id, "SELL", currentPrice, pos.shares, pos.tick_size || "0.01", pos.neg_risk || false);
            }
            const pnl = round2((currentPrice - entry) * pos.shares);
            balance += pos.cost + pnl;
            pos.closed_at    = snap.ts ?? null;
            pos.close_reason = currentPrice < entry ? "stop_loss" : "trailing_stop";
            pos.exit_price   = currentPrice;
            pos.pnl          = pnl;
            pos.status       = "closed";
            closed += 1;
            const reason = currentPrice < entry ? "STOP" : "TRAILING BE";
            console.log(`  [${reason}] ${loc.name} ${date} | entry $${entry.toFixed(3)} exit $${currentPrice.toFixed(3)} | PnL: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`);
          }
        }
      }

      // --- CLOSE POSITION if forecast shifted 2+ degrees ---
      if (mkt.position && forecastTemp != null) {
        const pos = mkt.position;
        const buffer = loc.unit === "F" ? 2.0 : 1.0;
        const midBucket = (pos.bucket_low !== -999 && pos.bucket_high !== 999)
          ? (pos.bucket_low + pos.bucket_high) / 2
          : forecastTemp;
        const forecastFar = Math.abs(forecastTemp - midBucket) > (Math.abs(midBucket - pos.bucket_low) + buffer);
        if (!inBucket(forecastTemp, pos.bucket_low, pos.bucket_high) && forecastFar) {
          let currentPrice: number | null = null;
          for (const o of outcomes) {
            if (o.market_id === pos.market_id) { currentPrice = o.price; break; }
          }
          if (currentPrice != null) {
            if (LIVE_TRADING && clobClient && pos.token_id) {
              await placeLiveOrder(pos.token_id, "SELL", currentPrice, pos.shares, pos.tick_size || "0.01", pos.neg_risk || false);
            }
            const pnl = round2((currentPrice - pos.entry_price) * pos.shares);
            balance += pos.cost + pnl;
            mkt.position.closed_at    = snap.ts ?? null;
            mkt.position.close_reason = "forecast_changed";
            mkt.position.exit_price   = currentPrice;
            mkt.position.pnl          = pnl;
            mkt.position.status       = "closed";
            closed += 1;
            console.log(`  [CLOSE] ${loc.name} ${date} — forecast changed | PnL: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`);
          }
        }
      }

      // --- OPEN POSITION ---
      if (!mkt.position && forecastTemp != null && hours >= MIN_HOURS) {
        const sigma = getSigma(citySlug, bestSource || "ecmwf");
        let bestSignal: Position | null = null;

        let matchedBucket: Outcome | null = null;
        for (const o of outcomes) {
          if (inBucket(forecastTemp, o.range[0], o.range[1])) { matchedBucket = o; break; }
        }

        if (matchedBucket) {
          const o = matchedBucket;
          const [tLow, tHigh] = o.range;
          if (o.volume >= MIN_VOLUME) {
            const p  = bucketProb(forecastTemp, tLow, tHigh, sigma);
            const ev = calcEv(p, o.ask ?? o.price);
            if (ev >= MIN_EV) {
              const kelly = calcKelly(p, o.ask ?? o.price);
              const size  = betSize(kelly, balance);
              if (size >= 0.50) {
                bestSignal = {
                  market_id:     o.market_id,
                  token_id:      o.token_id,
                  question:      o.question,
                  bucket_low:    tLow,
                  bucket_high:   tHigh,
                  entry_price:   o.ask ?? o.price,
                  bid_at_entry:  o.bid ?? o.price,
                  spread:        o.spread || 0,
                  shares:        round2(size / (o.ask ?? o.price)),
                  cost:          size,
                  p:             round4(p),
                  ev:            round4(ev),
                  kelly:         round4(kelly),
                  forecast_temp: forecastTemp,
                  forecast_src:  bestSource,
                  sigma,
                  opened_at:     snap.ts ?? null,
                  status:        "open",
                  pnl:           null,
                  exit_price:    null,
                  close_reason:  null,
                  closed_at:     null,
                  neg_risk:      o.neg_risk,
                  tick_size:     o.tick_size,
                };
              }
            }
          }
        }

        if (bestSignal) {
          let skipPosition = false;
          try {
            const { data: mdata } = await axios.get(
              `https://gamma-api.polymarket.com/markets/${bestSignal.market_id}`,
              { timeout: 5000 }
            );
            const realAsk    = Number(mdata.bestAsk ?? bestSignal.entry_price);
            const realBid    = Number(mdata.bestBid ?? bestSignal.bid_at_entry);
            const realSpread = round4(realAsk - realBid);
            if (realSpread > MAX_SLIPPAGE || realAsk >= MAX_PRICE) {
              console.log(`  [SKIP] ${loc.name} ${date} — real ask $${realAsk.toFixed(3)} spread $${realSpread.toFixed(3)}`);
              skipPosition = true;
            } else {
              bestSignal.entry_price  = realAsk;
              bestSignal.bid_at_entry = realBid;
              bestSignal.spread       = realSpread;
              bestSignal.shares       = round2(bestSignal.cost / realAsk);
              bestSignal.ev           = round4(calcEv(bestSignal.p, realAsk));
            }
          } catch (e: any) {
            console.log(`  [WARN] Could not fetch real ask for ${bestSignal.market_id}: ${e.message}`);
          }

          if (!skipPosition && bestSignal.entry_price < MAX_PRICE) {
            // Guard against duplicate orders if local data was lost
            if (LIVE_TRADING && clobClient && bestSignal.token_id) {
              try {
                const existing = await clobClient.getOpenOrders({ asset_id: bestSignal.token_id });
                const orders = Array.isArray(existing) ? existing : (existing as any)?.data ?? [];
                if (orders.length > 0) {
                  console.log(`  [SKIP] ${loc.name} ${date} — already have ${orders.length} open order(s) on this token`);
                  saveMarket(mkt);
                  await sleep(100);
                  continue;
                }
              } catch { /* ignore check failure, proceed with order */ }
            }
            if (LIVE_TRADING && clobClient) {
              const orderId = await placeLiveOrder(
                bestSignal.token_id || "", "BUY",
                bestSignal.entry_price, bestSignal.shares,
                bestSignal.tick_size || "0.01", bestSignal.neg_risk || false,
              );
              if (!orderId) {
                console.log(`  [SKIP] ${loc.name} ${date} — live order failed, skipping`);
                saveMarket(mkt);
                await sleep(100);
                continue;
              }
            }
            balance -= bestSignal.cost;
            mkt.position = bestSignal;
            state.total_trades += 1;
            newPos += 1;
            const bucketLabel = `${bestSignal.bucket_low}-${bestSignal.bucket_high}${unitSym}`;
            const mode = LIVE_TRADING && clobClient ? "LIVE BUY" : "BUY";
            console.log(
              `  [${mode}]  ${loc.name} ${horizon} ${date} | ${bucketLabel} | ` +
              `$${bestSignal.entry_price.toFixed(3)} | EV ${bestSignal.ev >= 0 ? "+" : ""}${bestSignal.ev.toFixed(2)} | ` +
              `$${bestSignal.cost.toFixed(2)} (${(bestSignal.forecast_src || "").toUpperCase()})`
            );
          }
        }
      }

      if (hours < 0.5 && mkt.status === "open") mkt.status = "closed";

      saveMarket(mkt);
      await sleep(100);
    }

    console.log("ok");
  }

  // --- AUTO-RESOLUTION ---
  for (const mkt of loadAllMarkets()) {
    if (mkt.status === "resolved") continue;
    const pos = mkt.position;
    if (!pos || pos.status !== "open") continue;
    if (!pos.market_id) continue;

    const won = await checkMarketResolved(pos.market_id);
    if (won === null) continue;

    // Fetch actual temperature for calibration
    if (VC_KEY && mkt.actual_temp == null) {
      const actual = await getActualTemp(mkt.city, mkt.date);
      if (actual != null) {
        mkt.actual_temp = actual;
        console.log(`  [VC] ${mkt.city_name} ${mkt.date} actual: ${actual}°${mkt.unit}`);
      }
    }

    const pnl = won ? round2(pos.shares * (1 - pos.entry_price)) : round2(-pos.cost);

    balance += pos.cost + pnl;
    pos.exit_price   = won ? 1.0 : 0.0;
    pos.pnl          = pnl;
    pos.close_reason = "resolved";
    pos.closed_at    = now.toISOString();
    pos.status       = "closed";
    mkt.pnl          = pnl;
    mkt.status       = "resolved";
    mkt.resolved_outcome = won ? "win" : "loss";

    if (won) state.wins += 1;
    else     state.losses += 1;

    const result = won ? "WIN" : "LOSS";
    console.log(`  [${result}] ${mkt.city_name} ${mkt.date} | PnL: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`);
    resolved += 1;

    saveMarket(mkt);
    await sleep(300);
  }

  state.balance      = round2(balance);
  state.peak_balance = Math.max(state.peak_balance ?? balance, balance);
  saveState(state);

  const allMkts = loadAllMarkets();
  const resolvedCount = allMkts.filter(m => m.status === "resolved").length;
  if (resolvedCount >= CALIBRATION_MIN) {
    _cal = runCalibration(allMkts);
  }

  return { newPos, closed, resolved };
}

// =============================================================================
// REPORT
// =============================================================================

function printStatus(): void {
  const state    = loadState();
  const markets  = loadAllMarkets();
  const openPos  = markets.filter(m => m.position?.status === "open");
  const resolvedM = markets.filter(m => m.status === "resolved" && m.pnl != null);

  const bal     = state.balance;
  const start   = state.starting_balance;
  const retPct  = (bal - start) / start * 100;
  const { wins, losses } = state;
  const total   = wins + losses;

  console.log(`\n${"=".repeat(55)}`);
  console.log(`  WEATHERBET — STATUS`);
  console.log(`${"=".repeat(55)}`);
  console.log(`  Balance:     $${bal.toFixed(2)}  (start $${start.toFixed(2)}, ${retPct >= 0 ? "+" : ""}${retPct.toFixed(1)}%)`);
  if (total > 0) {
    console.log(`  Trades:      ${total} | W: ${wins} | L: ${losses} | WR: ${Math.round(wins / total * 100)}%`);
  } else {
    console.log(`  No trades yet`);
  }
  console.log(`  Open:        ${openPos.length}`);
  console.log(`  Resolved:    ${resolvedM.length}`);

  if (openPos.length > 0) {
    console.log(`\n  Open positions:`);
    let totalUnrealized = 0.0;
    for (const m of openPos) {
      const pos     = m.position!;
      const unitSym = m.unit === "F" ? "F" : "C";
      const label   = `${pos.bucket_low}-${pos.bucket_high}${unitSym}`;

      let currentPrice = pos.entry_price;
      for (const o of (m.all_outcomes || [])) {
        if (o.market_id === pos.market_id) { currentPrice = o.price; break; }
      }

      const unrealized = round2((currentPrice - pos.entry_price) * pos.shares);
      totalUnrealized += unrealized;
      console.log(
        `    ${m.city_name.padEnd(16)} ${m.date} | ${label.padEnd(14)} | ` +
        `entry $${pos.entry_price.toFixed(3)} -> $${currentPrice.toFixed(3)} | ` +
        `PnL: ${unrealized >= 0 ? "+" : ""}${unrealized.toFixed(2)} | ${(pos.forecast_src || "").toUpperCase()}`
      );
    }
    console.log(`\n  Unrealized PnL: ${totalUnrealized >= 0 ? "+" : ""}${totalUnrealized.toFixed(2)}`);
  }

  console.log(`${"=".repeat(55)}\n`);
}

function printReport(): void {
  const markets   = loadAllMarkets();
  const resolvedM = markets.filter(m => m.status === "resolved" && m.pnl != null);

  console.log(`\n${"=".repeat(55)}`);
  console.log(`  WEATHERBET — FULL REPORT`);
  console.log(`${"=".repeat(55)}`);

  if (resolvedM.length === 0) { console.log("  No resolved markets yet."); return; }

  const totalPnl = resolvedM.reduce((s, m) => s + m.pnl!, 0);
  const wins     = resolvedM.filter(m => m.resolved_outcome === "win");
  const losses   = resolvedM.filter(m => m.resolved_outcome === "loss");

  console.log(`\n  Total resolved: ${resolvedM.length}`);
  console.log(`  Wins:           ${wins.length} | Losses: ${losses.length}`);
  console.log(`  Win rate:       ${Math.round(wins.length / resolvedM.length * 100)}%`);
  console.log(`  Total PnL:      ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)}`);

  console.log(`\n  By city:`);
  for (const city of [...new Set(resolvedM.map(m => m.city))].sort()) {
    const group = resolvedM.filter(m => m.city === city);
    const w     = group.filter(m => m.resolved_outcome === "win").length;
    const pnl   = group.reduce((s, m) => s + m.pnl!, 0);
    console.log(`    ${LOCATIONS[city].name.padEnd(16)} ${w}/${group.length} (${Math.round(w / group.length * 100)}%)  PnL: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`);
  }

  console.log(`\n  Market details:`);
  for (const m of [...resolvedM].sort((a, b) => a.date.localeCompare(b.date))) {
    const pos     = m.position;
    const unitSym = m.unit === "F" ? "F" : "C";
    const snaps   = m.forecast_snapshots || [];
    const firstFc = snaps[0]?.best ?? null;
    const lastFc  = snaps[snaps.length - 1]?.best ?? null;
    const label   = pos ? `${pos.bucket_low}-${pos.bucket_high}${unitSym}` : "no position";
    const result  = (m.resolved_outcome || "").toUpperCase();
    const pnlStr  = m.pnl != null ? `${m.pnl >= 0 ? "+" : ""}${m.pnl.toFixed(2)}` : "-";
    const fcStr   = firstFc != null ? `forecast ${firstFc}->${lastFc}${unitSym}` : "no forecast";
    const actual  = m.actual_temp != null ? `actual ${m.actual_temp}${unitSym}` : "";
    console.log(`    ${(m.city_name || "").padEnd(16)} ${m.date} | ${label.padEnd(14)} | ${fcStr} | ${actual} | ${result} ${pnlStr}`);
  }

  console.log(`${"=".repeat(55)}\n`);
}

// =============================================================================
// MAIN LOOP
// =============================================================================

const MONITOR_INTERVAL = 600;

async function monitorPositions(): Promise<number> {
  const markets = loadAllMarkets();
  const openPos = markets.filter(m => m.position?.status === "open");
  if (openPos.length === 0) return 0;

  const state   = loadState();
  let balance   = state.balance;
  let closedCnt = 0;

  for (const mkt of openPos) {
    const pos = mkt.position!;
    const mid = pos.market_id;

    let currentPrice: number | null = null;
    try {
      const { data: mdata } = await axios.get(
        `https://gamma-api.polymarket.com/markets/${mid}`,
        { timeout: 5000 }
      );
      if (mdata.bestBid != null) currentPrice = Number(mdata.bestBid);
    } catch { /* ignore */ }

    if (currentPrice == null) {
      for (const o of (mkt.all_outcomes || [])) {
        if (o.market_id === mid) { currentPrice = o.bid ?? o.price; break; }
      }
    }

    if (currentPrice == null) continue;

    const entry    = pos.entry_price;
    const stop     = pos.stop_price ?? entry * 0.80;
    const cityName = LOCATIONS[mkt.city]?.name || mkt.city;

    const hoursLeft = mkt.event_end_date ? hoursToResolution(mkt.event_end_date) : 999.0;

    let takeProfit: number | null = null;
    if (hoursLeft >= 48)      takeProfit = 0.75;
    else if (hoursLeft >= 24) takeProfit = 0.85;

    if (currentPrice >= entry * 1.20 && stop < entry) {
      pos.stop_price = entry;
      pos.trailing_activated = true;
      console.log(`  [TRAILING] ${cityName} ${mkt.date} — stop moved to breakeven $${entry.toFixed(3)}`);
    }

    const takeTriggered = takeProfit != null && currentPrice >= takeProfit;
    const stopTriggered = currentPrice <= stop;

    if (takeTriggered || stopTriggered) {
      if (LIVE_TRADING && clobClient && pos.token_id) {
        await placeLiveOrder(pos.token_id, "SELL", currentPrice, pos.shares, pos.tick_size || "0.01", pos.neg_risk || false);
      }
      const pnl = round2((currentPrice - entry) * pos.shares);
      balance += pos.cost + pnl;
      pos.closed_at = new Date().toISOString();
      let reason: string;
      if (takeTriggered) {
        pos.close_reason = "take_profit"; reason = "TAKE";
      } else if (currentPrice < entry) {
        pos.close_reason = "stop_loss"; reason = "STOP";
      } else {
        pos.close_reason = "trailing_stop"; reason = "TRAILING BE";
      }
      pos.exit_price = currentPrice;
      pos.pnl        = pnl;
      pos.status     = "closed";
      closedCnt += 1;
      console.log(`  [${reason}] ${cityName} ${mkt.date} | entry $${entry.toFixed(3)} exit $${currentPrice.toFixed(3)} | ${hoursLeft.toFixed(0)}h left | PnL: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`);
      saveMarket(mkt);
    }
  }

  if (closedCnt > 0) {
    state.balance = round2(balance);
    saveState(state);
  }

  return closedCnt;
}

async function runLoop(): Promise<void> {
  _cal = loadCal();
  const state = loadState();
  await syncBalance(state);
  saveState(state);

  if (LIVE_TRADING) await initClobClient();
  const tradingMode = LIVE_TRADING && clobClient ? "LIVE" : "PAPER";

  console.log(`\n${"=".repeat(55)}`);
  console.log(`  WEATHERBET — STARTING (${tradingMode})`);
  console.log(`${"=".repeat(55)}`);
  console.log(`  Mode:       ${tradingMode}`);
  console.log(`  Cities:     ${Object.keys(LOCATIONS).length}`);
  console.log(`  Balance:    $${state.balance.toFixed(2)} | Max bet: $${MAX_BET}`);
  console.log(`  Scan:       ${Math.floor(SCAN_INTERVAL / 60)} min | Monitor: ${Math.floor(MONITOR_INTERVAL / 60)} min`);
  console.log(`  Sources:    ECMWF + HRRR(US) + METAR(D+0)`);
  console.log(`  Data:       ${resolve(DATA_DIR)}`);
  console.log(`  Ctrl+C to stop\n`);

  let lastFullScan = 0;
  let running = true;

  process.on("SIGINT", () => {
    console.log(`\n  Stopping — saving state...`);
    saveState(loadState());
    console.log(`  Done. Bye!`);
    running = false;
    process.exit(0);
  });

  while (running) {
    const nowTs  = Date.now() / 1000;
    const nowStr = new Date().toISOString().replace("T", " ").slice(0, 19);

    if (nowTs - lastFullScan >= SCAN_INTERVAL) {
      console.log(`[${nowStr}] full scan...`);
      try {
        const { newPos, closed, resolved } = await scanAndUpdate();
        const st = loadState();
        console.log(`  balance: $${st.balance.toFixed(2)} | new: ${newPos} | closed: ${closed} | resolved: ${resolved}`);
        lastFullScan = Date.now() / 1000;
      } catch (e: any) {
        if (e.code === "ECONNREFUSED" || e.code === "ENOTFOUND") {
          console.log(`  Connection lost — waiting 60 sec`);
          await sleep(60000);
          continue;
        }
        console.log(`  Error: ${e.message} — waiting 60 sec`);
        await sleep(60000);
        continue;
      }
    } else {
      console.log(`[${nowStr}] monitoring positions...`);
      try {
        const stopped = await monitorPositions();
        if (stopped) {
          const st = loadState();
          console.log(`  balance: $${st.balance.toFixed(2)}`);
        }
      } catch (e: any) {
        console.log(`  Monitor error: ${e.message}`);
      }
    }

    await sleep(MONITOR_INTERVAL * 1000);
  }
}

// =============================================================================
// CLI
// =============================================================================

const cmd = process.argv[2] || "run";
if (cmd === "run") {
  runLoop().catch(e => { console.error(e); process.exit(1); });
} else if (cmd === "status") {
  _cal = loadCal();
  printStatus();
} else if (cmd === "report") {
  _cal = loadCal();
  printReport();
} else {
  console.log("Usage: tsx bot_v2.ts [run|status|report]");
}
