import axios from "axios";
import type { State, Market, Position, Outcome, ForecastSnap, MarketSnap } from "./types.js";
import {
  LOCATIONS, MONTHS, TIMEZONES,
  MIN_HOURS, MAX_HOURS, MIN_VOLUME, MIN_EV, MAX_PRICE, MAX_SLIPPAGE,
  BALANCE_FALLBACK, LIVE_TRADING, VC_KEY,
} from "./config.js";
import { round2, round4, bucketProb, calcEv, calcKelly, betSize, inBucket, getSigma } from "./math.js";
import { getEcmwf, getHrrr, getMetar, getActualTemp } from "./forecast.js";
import { getPolymarketEvent, parseOutcomes, hoursToResolution, checkMarketResolved } from "./polymarket.js";
import { fetchPolymarketBalance, getTokenBalance } from "./wallet.js";
import { getClobClient, placeLiveOrder, hasExistingOrders } from "./clob.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

export const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(d: Date, n: number): Date {
  const result = new Date(d);
  result.setUTCDate(result.getUTCDate() + n);
  return result;
}

// ── In-memory state ──────────────────────────────────────────────────────────

const marketStore = new Map<string, Market>();

export function getMarket(key: string): Market | null {
  return marketStore.get(key) ?? null;
}

export function setMarket(market: Market): void {
  marketStore.set(`${market.city}_${market.date}`, market);
}

export function getAllMarkets(): Market[] {
  return Array.from(marketStore.values());
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

// ── Global runtime state ─────────────────────────────────────────────────────

let state: State = {
  balance:          BALANCE_FALLBACK,
  starting_balance: BALANCE_FALLBACK,
  total_trades:     0,
  wins:             0,
  losses:           0,
  peak_balance:     BALANCE_FALLBACK,
};

export function getState(): State { return state; }

export async function syncBalance(): Promise<void> {
  const live = await fetchPolymarketBalance();
  if (live != null) {
    state.balance = round2(live);
    if (state.starting_balance === BALANCE_FALLBACK) state.starting_balance = state.balance;
    state.peak_balance = Math.max(state.peak_balance, state.balance);
    console.log(`  [WALLET] Balance: $${state.balance.toFixed(2)}`);
  }
}

// ── Restore positions from on-chain data ─────────────────────────────────────

/**
 * At startup, scan all weather markets and check on-chain CTF balances
 * to reconstruct any open positions from a previous run.
 */
export async function restorePositions(): Promise<number> {
  const now = new Date();
  let restored = 0;

  for (const [citySlug, loc] of Object.entries(LOCATIONS)) {
    const dates: string[] = [];
    for (let i = 0; i < 4; i++) dates.push(formatDate(addDays(now, i)));

    for (const date of dates) {
      // Skip if already tracked in memory
      if (getMarket(`${citySlug}_${date}`) != null) continue;

      const dt = new Date(date + "T00:00:00Z");
      const event = await getPolymarketEvent(
        citySlug, MONTHS[dt.getUTCMonth()], dt.getUTCDate(), dt.getUTCFullYear()
      );
      if (!event) continue;

      const outcomes = parseOutcomes(event.markets || []);

      for (const o of outcomes) {
        if (!o.token_id) continue;
        const shares = await getTokenBalance(o.token_id);
        if (shares < 0.01) continue;

        // We hold shares on this token — reconstruct position
        const endDate = event.endDate || "";
        const hours = endDate ? hoursToResolution(endDate) : 0;

        const mkt: Market = {
          city:               citySlug,
          city_name:          loc.name,
          date,
          unit:               loc.unit,
          station:            loc.station,
          event_end_date:     endDate,
          hours_at_discovery: Math.round(hours * 10) / 10,
          status:             "open",
          position:           null,
          actual_temp:        null,
          resolved_outcome:   null,
          pnl:                null,
          forecast_snapshots: [],
          market_snapshots:   [],
          all_outcomes:       outcomes,
          created_at:         new Date().toISOString(),
        };

        // Use current market price as estimated entry (conservative)
        const entryPrice = o.price || o.bid || 0.50;
        mkt.position = {
          market_id:     o.market_id,
          token_id:      o.token_id,
          question:      o.question,
          bucket_low:    o.range[0],
          bucket_high:   o.range[1],
          entry_price:   entryPrice,
          bid_at_entry:  o.bid,
          spread:        o.spread,
          shares:        round2(shares),
          cost:          round2(shares * entryPrice),
          p:             0,
          ev:            0,
          kelly:         0,
          forecast_temp: 0,
          forecast_src:  null,
          sigma:         0,
          opened_at:     new Date().toISOString(),
          status:        "open",
          pnl:           null,
          exit_price:    null,
          close_reason:  null,
          closed_at:     null,
          neg_risk:      o.neg_risk,
          tick_size:     o.tick_size,
        };

        setMarket(mkt);
        restored++;
        const unitSym = loc.unit === "F" ? "F" : "C";
        const label = `${o.range[0]}-${o.range[1]}${unitSym}`;
        console.log(`  [RESTORE] ${loc.name} ${date} | ${label} | ${shares.toFixed(2)} shares @ ~$${entryPrice.toFixed(3)}`);
        break; // one position per market date
      }

      await sleep(100);
    }
  }

  return restored;
}

// ── Sell all positions ───────────────────────────────────────────────────────

/**
 * Sell/exit ALL open positions at current market price.
 * Used when the user wants to close everything and stop.
 */
export async function sellAllPositions(): Promise<number> {
  const openPos = getAllMarkets().filter(m => m.position?.status === "open");
  if (openPos.length === 0) return 0;

  const clobClient = getClobClient();
  let sold = 0;

  for (const mkt of openPos) {
    const pos = mkt.position!;
    const cityName = LOCATIONS[mkt.city]?.name || mkt.city;
    const unitSym = mkt.unit === "F" ? "F" : "C";
    const label = `${pos.bucket_low}-${pos.bucket_high}${unitSym}`;

    // Get current bid price
    let currentPrice: number | null = null;
    try {
      const { data: mdata } = await axios.get(
        `https://gamma-api.polymarket.com/markets/${pos.market_id}`,
        { timeout: 5000 }
      );
      if (mdata.bestBid != null) currentPrice = Number(mdata.bestBid);
    } catch { /* ignore */ }

    if (currentPrice == null) currentPrice = pos.entry_price * 0.90;

    if (LIVE_TRADING && clobClient && pos.token_id) {
      const orderId = await placeLiveOrder(
        pos.token_id, "SELL", currentPrice, pos.shares,
        pos.tick_size || "0.01", pos.neg_risk || false,
      );
      if (!orderId) {
        console.log(`  [EXIT FAILED] ${cityName} ${mkt.date} | ${label}`);
        continue;
      }
    }

    const pnl = round2((currentPrice - pos.entry_price) * pos.shares);
    pos.exit_price   = currentPrice;
    pos.pnl          = pnl;
    pos.close_reason = "manual_exit";
    pos.closed_at    = new Date().toISOString();
    pos.status       = "closed";
    mkt.status       = "closed";
    setMarket(mkt);
    sold++;

    console.log(
      `  [EXIT] ${cityName} ${mkt.date} | ${label} | ` +
      `${pos.shares.toFixed(2)} shares @ $${currentPrice.toFixed(3)} | ` +
      `PnL: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`
    );
    await sleep(300);
  }

  return sold;
}

// ── Forecast snapshot ────────────────────────────────────────────────────────

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

// ── Core scan ────────────────────────────────────────────────────────────────

export async function scanAndUpdate(): Promise<{ newPos: number; closed: number; resolved: number }> {
  const now     = new Date();
  await syncBalance();
  let balance   = state.balance;
  let newPos    = 0;
  let closed    = 0;
  let resolved  = 0;

  const clobClient = getClobClient();

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

      const mktKey = `${citySlug}_${date}`;
      let mkt = getMarket(mktKey);
      if (mkt === null) {
        if (hours < MIN_HOURS || hours > MAX_HOURS) continue;
        mkt = newMarket(citySlug, date, event, hours);
      }

      if (mkt.status === "resolved") continue;

      // Update outcomes
      const outcomes = parseOutcomes(event.markets || []);
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
      if (mkt.position && mkt.position.status === "open" && forecastTemp != null) {
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
            // Guard against duplicate orders
            if (LIVE_TRADING && clobClient && bestSignal.token_id) {
              if (await hasExistingOrders(bestSignal.token_id)) {
                console.log(`  [SKIP] ${loc.name} ${date} — already have open order(s) on this token`);
                setMarket(mkt);
                await sleep(100);
                continue;
              }
            }
            if (LIVE_TRADING && clobClient) {
              const orderId = await placeLiveOrder(
                bestSignal.token_id || "", "BUY",
                bestSignal.entry_price, bestSignal.shares,
                bestSignal.tick_size || "0.01", bestSignal.neg_risk || false,
              );
              if (!orderId) {
                console.log(`  [SKIP] ${loc.name} ${date} — live order failed, skipping`);
                setMarket(mkt);
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

      setMarket(mkt);
      await sleep(100);
    }

    console.log("ok");
  }

  // --- AUTO-RESOLUTION ---
  for (const mkt of getAllMarkets()) {
    if (mkt.status === "resolved") continue;
    const pos = mkt.position;
    if (!pos || pos.status !== "open") continue;
    if (!pos.market_id) continue;

    const won = await checkMarketResolved(pos.market_id);
    if (won === null) continue;

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

    setMarket(mkt);
    await sleep(300);
  }

  state.balance      = round2(balance);
  state.peak_balance = Math.max(state.peak_balance ?? balance, balance);

  return { newPos, closed, resolved };
}

// ── Monitor positions ────────────────────────────────────────────────────────

export async function monitorPositions(): Promise<number> {
  const openPos = getAllMarkets().filter(m => m.position?.status === "open");
  if (openPos.length === 0) return 0;

  let balance   = state.balance;
  let closedCnt = 0;
  const clobClient = getClobClient();

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
      setMarket(mkt);
    }
  }

  if (closedCnt > 0) {
    state.balance = round2(balance);
  }

  return closedCnt;
}
