import axios from "axios";
import type {
  EntrySignal,
  ExitIntent,
  ExitReason,
  ForecastSnap,
  Market,
  MarketSnap,
  Outcome,
  State,
} from "./types.js";
import {
  BALANCE_FALLBACK,
  LIVE_TRADING,
  LOCATIONS,
  MAX_HOURS,
  MAX_PRICE,
  MAX_SLIPPAGE,
  MIN_EV,
  MIN_HOURS,
  MIN_VOLUME,
  MONTHS,
  VC_KEY,
} from "./config.js";
import { fetchOpenOrders } from "./clob.js";
import {
  markMarketPrice,
  marketHasActiveOrder,
  marketHasExposure,
  reconcilePositionsWithExchange,
  submitBuyOrder,
  submitSellOrder,
  syncOrderStatus,
} from "./execution.js";
import { getActualTemp, getEcmwf, getHrrr, getMetar } from "./forecast.js";
import { betSize, bucketProb, calcEv, calcKelly, getSigma, inBucket, round2, round4 } from "./math.js";
import { checkMarketResolved, getPolymarketEvent, hoursToResolution, parseOutcomes } from "./polymarket.js";
import { createRestoredPositionFromBalance } from "./position-state.js";
import { fetchPolymarketBalance, getTokenBalance } from "./wallet.js";

export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(d: Date, n: number): Date {
  const copy = new Date(d);
  copy.setUTCDate(copy.getUTCDate() + n);
  return copy;
}

const marketStore = new Map<string, Market>();
const pendingEntrySignals = new Map<string, EntrySignal>();

export function getMarket(key: string): Market | null {
  return marketStore.get(key) ?? null;
}

export function setMarket(market: Market): void {
  marketStore.set(`${market.city}_${market.date}`, market);
}

export function getAllMarkets(): Market[] {
  return Array.from(marketStore.values());
}

function marketKey(city: string, date: string): string {
  return `${city}_${date}`;
}

function newMarket(citySlug: string, date: string, event: any, hours: number): Market {
  const loc = LOCATIONS[citySlug];
  return {
    city: citySlug,
    city_name: loc.name,
    date,
    unit: loc.unit,
    station: loc.station,
    event_end_date: event.endDate || "",
    hours_at_discovery: round4(hours),
    status: "open",
    position: null,
    orders: [],
    actual_temp: null,
    resolved_outcome: null,
    pnl: null,
    forecast_snapshots: [],
    market_snapshots: [],
    all_outcomes: [],
    created_at: new Date().toISOString(),
  };
}

let state: State = {
  balance: BALANCE_FALLBACK,
  available_balance: BALANCE_FALLBACK,
  reserved_balance: 0,
  starting_balance: BALANCE_FALLBACK,
  total_trades: 0,
  wins: 0,
  losses: 0,
  peak_balance: BALANCE_FALLBACK,
  realized_pnl: 0,
};

export function getState(): State {
  return state;
}

function recalculateBalances(): void {
  const reserved = getAllMarkets().reduce((sum, market) => {
    return sum + market.orders
      .filter(order => !order.is_terminal && order.side === "BUY")
      .reduce((orderSum, order) => orderSum + Math.max(0, order.requested_notional - order.fill.filled_notional), 0);
  }, 0);

  state.reserved_balance = round2(reserved);
  state.available_balance = round2(Math.max(0, state.balance - state.reserved_balance));
  state.peak_balance = Math.max(state.peak_balance, state.balance);
  state.realized_pnl = round2(
    getAllMarkets().reduce((sum, market) => sum + (market.position?.phase === "closed" ? market.position.realized_pnl : 0), 0),
  );
}

function applyPaperCashFromSync(marketBefore: Market, marketAfter: Market): void {
  if (LIVE_TRADING) return;

  const orderIds = new Set([
    ...marketBefore.orders.map(order => order.order_id),
    ...marketAfter.orders.map(order => order.order_id),
  ]);

  let cashDelta = 0;
  for (const orderId of orderIds) {
    const before = marketBefore.orders.find(order => order.order_id === orderId);
    const after = marketAfter.orders.find(order => order.order_id === orderId);
    if (!after) continue;
    const delta = round4(after.fill.filled_notional - (before?.fill.filled_notional ?? 0));
    if (delta <= 0) continue;
    cashDelta += after.side === "BUY" ? -delta : delta;
  }

  if (cashDelta !== 0) state.balance = round2(state.balance + cashDelta);
}

export async function syncBalance(): Promise<void> {
  if (!LIVE_TRADING) {
    recalculateBalances();
    return;
  }

  const live = await fetchPolymarketBalance();
  if (live != null) {
    state.balance = round2(live);
    if (state.starting_balance === BALANCE_FALLBACK) state.starting_balance = state.balance;
    recalculateBalances();
    console.log(`  [WALLET] Balance: $${state.balance.toFixed(2)} | Available: $${state.available_balance.toFixed(2)} | Reserved: $${state.reserved_balance.toFixed(2)}`);
  }
}

function getCurrentMarkPrice(outcomes: Outcome[], tokenId: string): number | null {
  const outcome = outcomes.find(item => item.token_id === tokenId);
  if (!outcome) return null;
  return outcome.bid ?? outcome.price ?? null;
}

function appendForecastSnapshot(market: Market, snap: any, horizon: string, hoursLeft: number): Market {
  const forecastSnap: ForecastSnap = {
    ts: snap.ts ?? null,
    horizon,
    hours_left: round4(hoursLeft),
    ecmwf: snap.ecmwf ?? null,
    hrrr: snap.hrrr ?? null,
    metar: snap.metar ?? null,
    best: snap.best ?? null,
    best_source: snap.best_source ?? null,
  };
  return {
    ...market,
    forecast_snapshots: [...market.forecast_snapshots, forecastSnap],
  };
}

function appendMarketSnapshot(market: Market, snap: any, outcomes: Outcome[]): Market {
  const top = outcomes.length > 0 ? outcomes.reduce((a, b) => (a.price > b.price ? a : b)) : null;
  const label = top ? `${top.range[0]}-${top.range[1]}${market.unit}` : null;
  const marketSnap: MarketSnap = {
    ts: snap.ts ?? null,
    top_bucket: label,
    top_price: top?.price ?? null,
  };
  return {
    ...market,
    market_snapshots: [...market.market_snapshots, marketSnap],
  };
}

async function fetchBestBid(marketId: string): Promise<number | null> {
  try {
    const { data } = await axios.get(`https://gamma-api.polymarket.com/markets/${marketId}`, { timeout: 5000 });
    if (data.bestBid != null) return Number(data.bestBid);
  } catch {
    return null;
  }
  return null;
}

async function fetchTopOfBook(marketId: string): Promise<{ bid: number | null; ask: number | null }> {
  try {
    const { data } = await axios.get(`https://gamma-api.polymarket.com/markets/${marketId}`, { timeout: 5000 });
    return {
      bid: data.bestBid != null ? Number(data.bestBid) : null,
      ask: data.bestAsk != null ? Number(data.bestAsk) : null,
    };
  } catch {
    return { bid: null, ask: null };
  }
}

async function takeForecastSnapshot(citySlug: string, dates: string[]): Promise<Record<string, any>> {
  const now = new Date();
  const nowStr = now.toISOString();
  const ecmwf = await getEcmwf(citySlug, dates);
  const hrrr = await getHrrr(citySlug, dates);
  const today = formatDate(now);
  const maxHrrrDate = formatDate(addDays(now, 2));

  const result: Record<string, any> = {};
  for (const date of dates) {
    const loc = LOCATIONS[citySlug];
    const snap: any = {
      ts: nowStr,
      ecmwf: ecmwf[date] ?? null,
      hrrr: date <= maxHrrrDate ? (hrrr[date] ?? null) : null,
      metar: date === today ? await getMetar(citySlug) : null,
    };

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
    result[date] = snap;
  }
  return result;
}

function updateStopState(market: Market, currentBid: number): Market {
  const position = market.position;
  if (!position || position.phase === "closed") return market;

  const stop = position.stop_price ?? position.average_entry_price * 0.8;
  if (currentBid >= position.average_entry_price * 1.2 && stop < position.average_entry_price) {
    const updatedPosition = {
      ...position,
      stop_price: round4(position.average_entry_price),
      trailing_activated: true,
      last_updated_at: new Date().toISOString(),
    };
    console.log(`  [TRAILING ARMED] ${market.city_name} ${market.date} | stop moved to breakeven $${position.average_entry_price.toFixed(3)}`);
    return { ...market, position: updatedPosition };
  }

  return market;
}

function getTakeProfit(hoursLeft: number): number | null {
  if (hoursLeft >= 48) return 0.75;
  if (hoursLeft >= 24) return 0.85;
  return null;
}

function evaluateExitIntent(market: Market, currentBid: number | null, forecastTemp: number | null): { market: Market; exitIntent: ExitIntent | null } {
  if (!market.position || market.position.phase === "closed" || currentBid == null) {
    return { market, exitIntent: null };
  }

  const nextMarket = updateStopState(market, currentBid);
  const position = nextMarket.position!;
  const stop = position.stop_price ?? position.average_entry_price * 0.8;
  const hoursLeft = nextMarket.event_end_date ? hoursToResolution(nextMarket.event_end_date) : 999;
  const takeProfit = getTakeProfit(hoursLeft);

  if (currentBid <= stop) {
    const reason: ExitReason = currentBid < position.average_entry_price ? "stop_loss" : "trailing_stop";
    return {
      market: nextMarket,
      exitIntent: { reason, signal_price: currentBid, mark_price: currentBid, limit_price: currentBid },
    };
  }

  if (takeProfit != null && currentBid >= takeProfit) {
    return {
      market: nextMarket,
      exitIntent: { reason: "take_profit", signal_price: currentBid, mark_price: currentBid, limit_price: currentBid },
    };
  }

  if (forecastTemp != null) {
    const buffer = nextMarket.unit === "F" ? 2 : 1;
    const midBucket = (position.bucket_low !== -999 && position.bucket_high !== 999)
      ? (position.bucket_low + position.bucket_high) / 2
      : forecastTemp;
    const forecastFar = Math.abs(forecastTemp - midBucket) > (Math.abs(midBucket - position.bucket_low) + buffer);
    if (!inBucket(forecastTemp, position.bucket_low, position.bucket_high) && forecastFar) {
      return {
        market: nextMarket,
        exitIntent: { reason: "forecast_changed", signal_price: currentBid, mark_price: currentBid, limit_price: currentBid },
      };
    }
  }

  return { market: nextMarket, exitIntent: null };
}

function buildEntrySignal(market: Market, outcomes: Outcome[], forecastTemp: number, bestSource: string | null): EntrySignal | null {
  let matchedBucket: Outcome | null = null;
  for (const outcome of outcomes) {
    if (inBucket(forecastTemp, outcome.range[0], outcome.range[1])) {
      matchedBucket = outcome;
      break;
    }
  }
  if (!matchedBucket) return null;
  if (matchedBucket.volume < MIN_VOLUME) return null;

  const sigma = getSigma(market.city, bestSource || "ecmwf");
  const signalAsk = matchedBucket.ask ?? matchedBucket.price;
  const p = bucketProb(forecastTemp, matchedBucket.range[0], matchedBucket.range[1], sigma);
  const ev = calcEv(p, signalAsk);
  if (ev < MIN_EV || signalAsk >= MAX_PRICE) return null;

  const kelly = calcKelly(p, signalAsk);
  const notional = betSize(kelly, state.available_balance);
  if (notional < 0.5) return null;

  return {
    market_id: matchedBucket.market_id,
    token_id: matchedBucket.token_id,
    question: matchedBucket.question,
    bucket_low: matchedBucket.range[0],
    bucket_high: matchedBucket.range[1],
    signal_price: round4(signalAsk),
    bid_at_signal: round4(matchedBucket.bid ?? matchedBucket.price),
    spread_at_signal: round4(matchedBucket.spread || 0),
    mark_price: round4(matchedBucket.bid ?? matchedBucket.price),
    limit_price: round4(signalAsk),
    planned_shares: round4(notional / signalAsk),
    planned_notional: round2(notional),
    p: round4(p),
    ev: round4(ev),
    kelly: round4(kelly),
    forecast_temp: forecastTemp,
    forecast_src: bestSource,
    sigma,
    neg_risk: matchedBucket.neg_risk,
    tick_size: matchedBucket.tick_size,
  };
}

async function validateEntrySignal(market: Market, signal: EntrySignal): Promise<EntrySignal | null> {
  const top = await fetchTopOfBook(signal.market_id);
  const realAsk = top.ask ?? signal.signal_price;
  const realBid = top.bid ?? signal.bid_at_signal;
  const realSpread = round4(realAsk - realBid);
  if (realSpread > MAX_SLIPPAGE || realAsk >= MAX_PRICE) {
    console.log(`  [SIGNAL SKIPPED] ${market.city_name} ${market.date} | ask $${realAsk.toFixed(3)} | spread $${realSpread.toFixed(3)}`);
    return null;
  }

  return {
    ...signal,
    signal_price: round4(realAsk),
    bid_at_signal: round4(realBid),
    spread_at_signal: realSpread,
    mark_price: round4(realBid),
    limit_price: round4(realAsk),
    planned_shares: round4(signal.planned_notional / realAsk),
    ev: round4(calcEv(signal.p, realAsk)),
  };
}

function countPositionOpenTransition(before: Market["position"], after: Market["position"]): number {
  const beforeOpen = !!before && before.phase !== "closed";
  const afterOpen = !!after && after.phase !== "closed";
  return beforeOpen || !afterOpen ? 0 : 1;
}

function countPositionClosedTransition(before: Market["position"], after: Market["position"]): number {
  const beforeOpen = !!before && before.phase !== "closed";
  const afterClosed = !!after && after.phase === "closed" && after.close_reason !== "resolved";
  return beforeOpen && afterClosed ? 1 : 0;
}

async function syncMarketExecution(market: Market): Promise<Market> {
  const before = market;
  const { market: next } = await syncOrderStatus(market, pendingEntrySignals);
  applyPaperCashFromSync(before, next);

  for (const order of next.orders) {
    if (order.intent === "entry" && order.is_terminal) {
      pendingEntrySignals.delete(order.order_id);
    }
  }

  if (!before.position && next.position && next.position.phase !== "closed") {
    state.total_trades += 1;
  }

  return next;
}

function toOrderMap(orders: Awaited<ReturnType<typeof fetchOpenOrders>>): Map<string, Awaited<ReturnType<typeof fetchOpenOrders>>> {
  const byToken = new Map<string, Awaited<ReturnType<typeof fetchOpenOrders>>>();
  for (const order of orders) {
    const current = byToken.get(order.asset_id) ?? [];
    current.push(order);
    byToken.set(order.asset_id, current);
  }
  return byToken;
}

function importRestoredOpenOrder(market: Market, order: any): Market {
  const exists = market.orders.some(item => item.order_id === order.id);
  if (exists) return market;

  const requestedShares = Number(order.original_size || 0);
  const filledShares = Number(order.size_matched || 0);
  const restoredOrder = {
    order_id: String(order.id),
    market_id: String(order.market),
    token_id: String(order.asset_id),
    question: market.position?.question ?? "",
    bucket_low: market.position?.bucket_low ?? 0,
    bucket_high: market.position?.bucket_high ?? 0,
    side: order.side === "SELL" ? "SELL" : "BUY",
    intent: order.side === "SELL" ? "exit" : "entry",
    status: "open",
    strategy: "market-fak",
    order_type: "FAK",
    submitted_at: new Date(Number(order.created_at || Date.now())).toISOString(),
    completed_at: null,
    last_synced_at: null,
    exchange_status: String(order.status || "open"),
    requested_shares: round4(requestedShares),
    requested_notional: round2(requestedShares * Number(order.price || 0)),
    remaining_shares: round4(Math.max(0, requestedShares - filledShares)),
    pricing: {
      signal_price: Number(order.price || 0),
      limit_price: Number(order.price || 0),
      fill_price: filledShares > 0 ? Number(order.price || 0) : null,
      mark_price: market.position?.exit.mark_price ?? null,
    },
    fill: {
      filled_shares: round4(filledShares),
      filled_notional: round4(filledShares * Number(order.price || 0)),
      average_price: filledShares > 0 ? Number(order.price || 0) : null,
      trade_ids: [],
      transaction_hashes: [],
      first_filled_at: null,
      last_filled_at: null,
    },
    tick_size: market.position?.tick_size || "0.01",
    neg_risk: market.position?.neg_risk || false,
    error: null,
    is_open_on_exchange: true,
    is_terminal: false,
    close_reason: market.position?.phase === "closing" ? market.position.close_reason : null,
  } as const;

  return {
    ...market,
    orders: [...market.orders, restoredOrder as any],
  };
}

export async function restorePositions(): Promise<number> {
  const now = new Date();
  let restored = 0;
  const liveOpenOrders = LIVE_TRADING ? toOrderMap(await fetchOpenOrders()) : new Map();

  for (const [citySlug, loc] of Object.entries(LOCATIONS)) {
    const dates = Array.from({ length: 4 }, (_, index) => formatDate(addDays(now, index)));

    for (const date of dates) {
      if (getMarket(marketKey(citySlug, date))) continue;

      const dt = new Date(`${date}T00:00:00Z`);
      const event = await getPolymarketEvent(citySlug, MONTHS[dt.getUTCMonth()], dt.getUTCDate(), dt.getUTCFullYear());
      if (!event) continue;

      const outcomes = parseOutcomes(event.markets || []);
      const endDate = event.endDate || "";
      const hours = endDate ? hoursToResolution(endDate) : 0;
      let market = newMarket(citySlug, date, event, hours);
      market.all_outcomes = outcomes;

      for (const outcome of outcomes) {
        if (!outcome.token_id) continue;
        const shares = await getTokenBalance(outcome.token_id);
        if (shares < 0.01) continue;

        market.position = createRestoredPositionFromBalance(market, outcome, shares, new Date().toISOString());
        const openOrders = liveOpenOrders.get(outcome.token_id) ?? [];
        for (const openOrder of openOrders) {
          market = importRestoredOpenOrder(market, openOrder);
        }
        restored += 1;
        console.log(
          `  [RESTORE POSITION] ${loc.name} ${date} | ${outcome.range[0]}-${outcome.range[1]}${loc.unit} | ` +
          `${shares.toFixed(2)} shares | entry estimated at ~$${market.position!.average_entry_price.toFixed(3)}`,
        );
        if (openOrders.length > 0) {
          console.log(`  [RESTORE ORDERS] ${loc.name} ${date} | imported ${openOrders.length} open order(s)`);
        }
        break;
      }

      setMarket(market);
      await sleep(50);
    }
  }

  const reconciled = await reconcilePositionsWithExchange(getAllMarkets(), pendingEntrySignals);
  for (const market of reconciled) setMarket(market);
  recalculateBalances();
  return restored;
}

export async function sellAllPositions(): Promise<number> {
  let submitted = 0;

  for (const market of getAllMarkets()) {
    if (!marketHasExposure(market) || marketHasActiveOrder(market, "SELL")) continue;
    const position = market.position!;
    const bestBid = await fetchBestBid(position.market_id) ?? position.exit.mark_price ?? position.average_entry_price;
    const { market: next, submitted: didSubmit } = await submitSellOrder(market, {
      reason: "manual_exit",
      signal_price: bestBid,
      mark_price: bestBid,
      limit_price: bestBid,
    });
    if (didSubmit) {
      submitted += 1;
      setMarket(next);
    }
    await sleep(100);
  }

  recalculateBalances();
  return submitted;
}

async function maybeResolveMarket(market: Market): Promise<{ market: Market; resolved: boolean }> {
  const position = market.position;
  if (!position || position.phase === "closed" || market.status === "resolved") {
    return { market, resolved: false };
  }

  const won = await checkMarketResolved(position.market_id);
  if (won === null) return { market, resolved: false };

  if (VC_KEY && market.actual_temp == null) {
    const actual = await getActualTemp(market.city, market.date);
    if (actual != null) {
      market.actual_temp = actual;
      console.log(`  [VC] ${market.city_name} ${market.date} actual: ${actual}°${market.unit}`);
    }
  }

  const proceeds = won ? round2(position.shares_open) : 0;
  const realizedDelta = round2(proceeds - position.shares_open * position.average_entry_price);
  const nextPosition = {
    ...position,
    phase: "closed" as const,
    pending_exit_order_id: null,
    shares_closed: round4(position.shares_closed + position.shares_open),
    shares_open: 0 as const,
    total_exit_proceeds: round2(position.total_exit_proceeds + proceeds),
    average_exit_price: won ? 1 : 0,
    realized_pnl: round2(position.realized_pnl + realizedDelta),
    unrealized_pnl: 0,
    close_reason: "resolved" as const,
    closed_at: new Date().toISOString(),
    exit: {
      signal_price: 1,
      limit_price: null,
      fill_price: won ? 1 : 0,
      mark_price: won ? 1 : 0,
    },
  };

  if (!LIVE_TRADING) state.balance = round2(state.balance + proceeds);

  const resolvedMarket: Market = {
    ...market,
    position: nextPosition,
    pnl: nextPosition.realized_pnl,
    status: "resolved",
    resolved_outcome: won ? "win" : "loss",
  };

  if (won) state.wins += 1;
  else state.losses += 1;

  console.log(`  [RESOLVED ${won ? "WIN" : "LOSS"}] ${market.city_name} ${market.date} | PnL ${nextPosition.realized_pnl >= 0 ? "+" : ""}${nextPosition.realized_pnl.toFixed(2)}`);
  return { market: resolvedMarket, resolved: true };
}

export async function scanAndUpdate(options: { buyEnabled?: boolean } = {}): Promise<{ newPos: number; closed: number; resolved: number }> {
  const { buyEnabled = true } = options;
  const now = new Date();
  let newPos = 0;
  let closed = 0;
  let resolved = 0;

  await syncBalance();

  for (const [citySlug, loc] of Object.entries(LOCATIONS)) {
    process.stdout.write(`  -> ${loc.name}... `);
    const dates = Array.from({ length: 4 }, (_, index) => formatDate(addDays(now, index)));

    let forecastSnapshots: Record<string, any>;
    try {
      forecastSnapshots = await takeForecastSnapshot(citySlug, dates);
    } catch (error: any) {
      console.log(`skipped (${error.message})`);
      continue;
    }

    for (let index = 0; index < dates.length; index++) {
      const date = dates[index];
      const dt = new Date(`${date}T00:00:00Z`);
      const event = await getPolymarketEvent(citySlug, MONTHS[dt.getUTCMonth()], dt.getUTCDate(), dt.getUTCFullYear());
      if (!event) continue;

      const endDate = event.endDate || "";
      const hours = endDate ? hoursToResolution(endDate) : 0;
      if (hours > MAX_HOURS) continue;

      const outcomes = parseOutcomes(event.markets || []);
      const snap = forecastSnapshots[date] || {};
      const forecastTemp = snap.best ?? null;
      const bestSource = snap.best_source ?? null;
      const horizon = `D+${index}`;
      let market = getMarket(marketKey(citySlug, date)) ?? newMarket(citySlug, date, event, hours);
      const beforePosition = market.position;

      market = {
        ...market,
        event_end_date: endDate,
        hours_at_discovery: round4(hours),
        all_outcomes: outcomes,
      };
      market = appendForecastSnapshot(market, snap, horizon, hours);
      market = appendMarketSnapshot(market, snap, outcomes);

      if (market.position) {
        const mark = getCurrentMarkPrice(outcomes, market.position.token_id);
        market = markMarketPrice(market, mark);
      }

      market = await syncMarketExecution(market);
      newPos += countPositionOpenTransition(beforePosition, market.position);
      closed += countPositionClosedTransition(beforePosition, market.position);

      const currentBid = market.position ? getCurrentMarkPrice(outcomes, market.position.token_id) : null;
      const { market: marketWithRules, exitIntent } = evaluateExitIntent(market, currentBid, forecastTemp);
      market = marketWithRules;

      if (exitIntent) {
        const submitted = await submitSellOrder(market, exitIntent);
        market = submitted.market;
      }

      if (buyEnabled && forecastTemp != null && hours >= MIN_HOURS) {
        const hasExposure = marketHasExposure(market);
        const hasBuyOrder = marketHasActiveOrder(market, "BUY");
        const hasSellOrder = marketHasActiveOrder(market, "SELL");
        if (!hasExposure && !hasBuyOrder && !hasSellOrder) {
          const signal = buildEntrySignal(market, outcomes, forecastTemp, bestSource);
          if (signal) {
            const validSignal = await validateEntrySignal(market, signal);
            if (validSignal && validSignal.ev >= MIN_EV) {
              console.log(
                `  [SIGNAL] ${market.city_name} ${date} | ${validSignal.bucket_low}-${validSignal.bucket_high}${market.unit} | ` +
                `signal $${validSignal.signal_price.toFixed(3)} | EV ${validSignal.ev >= 0 ? "+" : ""}${validSignal.ev.toFixed(2)} | ` +
                `mark $${(validSignal.mark_price ?? validSignal.signal_price).toFixed(3)}`,
              );
              const submitted = await submitBuyOrder(market, validSignal);
              market = submitted.market;
              if (submitted.submitted) {
                const latest = market.orders[market.orders.length - 1];
                pendingEntrySignals.set(latest.order_id, validSignal);
              }
            }
          }
        }
      }

      if (hours < 0.5 && market.status === "open" && !marketHasExposure(market) && !marketHasActiveOrder(market)) {
        market.status = "closed";
      }

      const resolution = await maybeResolveMarket(market);
      market = resolution.market;
      if (resolution.resolved) resolved += 1;

      setMarket(market);
      await sleep(75);
    }

    console.log("ok");
  }

  recalculateBalances();
  return { newPos, closed, resolved };
}

export async function monitorPositions(): Promise<number> {
  await syncBalance();
  let closed = 0;

  for (const market of getAllMarkets()) {
    if (!marketHasExposure(market) && !marketHasActiveOrder(market)) continue;
    const before = market.position;
    let nextMarket = market;

    if (nextMarket.position) {
      const bestBid = await fetchBestBid(nextMarket.position.market_id);
      nextMarket = markMarketPrice(nextMarket, bestBid);
    }

    nextMarket = await syncMarketExecution(nextMarket);
    closed += countPositionClosedTransition(before, nextMarket.position);

    const currentBid = nextMarket.position ? nextMarket.position.exit.mark_price : null;
    const { market: marketWithRules, exitIntent } = evaluateExitIntent(nextMarket, currentBid, null);
    nextMarket = marketWithRules;

    if (exitIntent) {
      const submitted = await submitSellOrder(nextMarket, exitIntent);
      nextMarket = submitted.market;
    }

    setMarket(nextMarket);
  }

  recalculateBalances();
  return closed;
}
