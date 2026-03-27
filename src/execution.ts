import { LIVE_TRADING } from "./config.js";
import {
  calculateImmediatePrice,
  cancelExchangeOrder,
  fetchOpenOrders,
  fetchOrder,
  fetchTrades,
  getClobClient,
  submitImmediateOrder,
} from "./clob.js";
import { round2, round4 } from "./math.js";
import {
  applyOrderSyncResult,
  clearPendingExitOrder,
  getLatestOrder,
  hasActiveOrder,
  markPositionClosing,
  positionHasExposure,
  reconcilePositionToTokenBalance,
  updatePositionMark,
} from "./position-state.js";
import { getTokenBalance } from "./wallet.js";
import type {
  CompletedOrder,
  EntrySignal,
  ExitIntent,
  FilledExecution,
  ManagedOrder,
  Market,
  OrderLifecycleStatus,
  OrderSide,
  OrderSyncResult,
  PendingOrder,
} from "./types.js";

const PAPER_FILL_DELAY_MS = 1200;
const STALE_ORDER_CANCEL_MS = 30000;
const FILL_EPSILON = 0.000001;

let paperOrderSequence = 0;

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)));
}

function bucketLabel(market: Market, order?: ManagedOrder): string {
  const source = market.position ?? order;
  if (!source) return "n/a";
  const unit = market.unit === "F" ? "F" : "C";
  return `${source.bucket_low}-${source.bucket_high}${unit}`;
}

function marketName(market: Market): string {
  return `${market.city_name} ${market.date} | ${bucketLabel(market)}`;
}

function emptyExecution(): FilledExecution {
  return {
    filled_shares: 0,
    filled_notional: 0,
    average_price: null,
    trade_ids: [],
    transaction_hashes: [],
    first_filled_at: null,
    last_filled_at: null,
  };
}

function isTerminalStatus(status: OrderLifecycleStatus): boolean {
  return status === "partially_filled" || status === "filled" || status === "cancelled" || status === "rejected" || status === "failed";
}

function newTrackedOrder(params: {
  market: Market;
  side: OrderSide;
  requestedShares: number;
  requestedNotional: number;
  signalPrice: number;
  limitPrice: number | null;
  markPrice: number | null;
  closeReason: ManagedOrder["close_reason"];
  orderId: string;
  exchangeStatus: string | null;
  strategy: ManagedOrder["strategy"];
  orderType: ManagedOrder["order_type"];
  tokenId: string;
  question: string;
  tickSize: string;
  negRisk: boolean;
}): PendingOrder {
  return {
    order_id: params.orderId,
    market_id: params.market.position?.market_id ?? params.market.all_outcomes[0]?.market_id ?? params.market.city,
    token_id: params.tokenId,
    question: params.question,
    side: params.side,
    intent: params.side === "BUY" ? "entry" : "exit",
    status: "submitted",
    strategy: params.strategy,
    order_type: params.orderType,
    submitted_at: new Date().toISOString(),
    completed_at: null,
    last_synced_at: null,
    exchange_status: params.exchangeStatus,
    requested_shares: round4(params.requestedShares),
    requested_notional: round2(params.requestedNotional),
    remaining_shares: round4(params.requestedShares),
    pricing: {
      signal_price: round4(params.signalPrice),
      limit_price: params.limitPrice != null ? round4(params.limitPrice) : null,
      fill_price: null,
      mark_price: params.markPrice != null ? round4(params.markPrice) : null,
    },
    fill: emptyExecution(),
    tick_size: params.tickSize,
    neg_risk: params.negRisk,
    error: null,
    is_open_on_exchange: false,
    is_terminal: false,
    close_reason: params.closeReason,
    bucket_low: params.market.position?.bucket_low ?? params.market.all_outcomes[0]?.range[0] ?? 0,
    bucket_high: params.market.position?.bucket_high ?? params.market.all_outcomes[0]?.range[1] ?? 0,
  } as PendingOrder & { bucket_low: number; bucket_high: number };
}

function orderWithOutcome(order: PendingOrder, market: Market): PendingOrder {
  const outcome = market.all_outcomes.find(item => item.token_id === order.token_id);
  if (!outcome) return order;
  return {
    ...order,
    market_id: outcome.market_id,
    question: outcome.question,
    tick_size: outcome.tick_size,
    neg_risk: outcome.neg_risk,
  };
}

function replaceOrder(market: Market, nextOrder: ManagedOrder): Market {
  const orders = market.orders.filter(order => order.order_id !== nextOrder.order_id);
  orders.push(nextOrder);
  orders.sort((a, b) => Date.parse(a.submitted_at) - Date.parse(b.submitted_at));
  return { ...market, orders };
}

function deriveTerminalNoFillStatus(exchangeStatus: string | null): CompletedOrder["status"] {
  const normalized = (exchangeStatus ?? "").toLowerCase();
  if (normalized.includes("reject") || normalized.includes("fail")) return "rejected";
  return "cancelled";
}

function summarizeTrades(order: ManagedOrder, trades: Awaited<ReturnType<typeof fetchTrades>>): FilledExecution {
  let filledShares = 0;
  let filledNotional = 0;
  const tradeIds: string[] = [];
  const transactionHashes: string[] = [];
  let firstFilledAt: string | null = null;
  let lastFilledAt: string | null = null;

  for (const trade of trades) {
    let matchedSize = 0;
    if (trade.taker_order_id === order.order_id) {
      matchedSize += Number(trade.size || 0);
    }
    for (const maker of trade.maker_orders ?? []) {
      if (maker.order_id === order.order_id) {
        matchedSize += Number(maker.matched_amount || 0);
      }
    }
    if (matchedSize <= FILL_EPSILON) continue;

    const price = Number(trade.price || 0);
    filledShares += matchedSize;
    filledNotional += matchedSize * price;
    tradeIds.push(String(trade.id));
    transactionHashes.push(String(trade.transaction_hash || ""));

    const matchTime = trade.match_time || trade.last_update || null;
    if (matchTime) {
      if (!firstFilledAt || Date.parse(matchTime) < Date.parse(firstFilledAt)) firstFilledAt = matchTime;
      if (!lastFilledAt || Date.parse(matchTime) > Date.parse(lastFilledAt)) lastFilledAt = matchTime;
    }
  }

  return {
    filled_shares: round4(filledShares),
    filled_notional: round4(filledNotional),
    average_price: filledShares > FILL_EPSILON ? round4(filledNotional / filledShares) : null,
    trade_ids: uniqueStrings(tradeIds),
    transaction_hashes: uniqueStrings(transactionHashes),
    first_filled_at: firstFilledAt,
    last_filled_at: lastFilledAt,
  };
}

function buildOrderSyncResult(order: ManagedOrder, nextOrder: ManagedOrder): OrderSyncResult {
  return {
    order_id: order.order_id,
    previous_status: order.status,
    current_status: nextOrder.status,
    newly_filled_shares: round4(nextOrder.fill.filled_shares - order.fill.filled_shares),
    total_filled_shares: nextOrder.fill.filled_shares,
    total_filled_notional: nextOrder.fill.filled_notional,
    average_fill_price: nextOrder.fill.average_price,
    is_open_on_exchange: nextOrder.is_open_on_exchange,
    completed: nextOrder.is_terminal,
  };
}

function toCompletedOrder(order: ManagedOrder, status: CompletedOrder["status"], details: Partial<ManagedOrder>): CompletedOrder {
  return {
    ...order,
    ...details,
    status,
    is_terminal: true,
    completed_at: details.completed_at ?? new Date().toISOString(),
  } as CompletedOrder;
}

function toPendingOrder(order: ManagedOrder, status: PendingOrder["status"], details: Partial<ManagedOrder>): PendingOrder {
  return {
    ...order,
    ...details,
    status,
    is_terminal: false,
    completed_at: null,
  } as PendingOrder;
}

async function syncLiveOrder(order: ManagedOrder): Promise<ManagedOrder> {
  const openOrders = await fetchOpenOrders(order.token_id);
  const liveOrder = openOrders.find(item => item.id === order.order_id) ?? await fetchOrder(order.order_id);
  const trades = await fetchTrades(order.token_id, order.submitted_at ?? undefined);
  const fill = summarizeTrades(order, trades);
  const remainingShares = Math.max(0, order.requested_shares - fill.filled_shares);
  const now = new Date().toISOString();

  if (liveOrder) {
    const nextStatus: PendingOrder["status"] = "open";
    return toPendingOrder(order, nextStatus, {
      exchange_status: liveOrder.status ?? order.exchange_status,
      last_synced_at: now,
      is_open_on_exchange: true,
      remaining_shares: round4(Math.max(0, Number(liveOrder.original_size || order.requested_shares) - Number(liveOrder.size_matched || fill.filled_shares))),
      fill,
      pricing: {
        ...order.pricing,
        fill_price: fill.average_price,
      },
    });
  }

  if (fill.filled_shares >= order.requested_shares - FILL_EPSILON) {
    return toCompletedOrder(order, "filled", {
      exchange_status: order.exchange_status ?? "filled",
      last_synced_at: now,
      is_open_on_exchange: false,
      remaining_shares: 0,
      fill,
      pricing: {
        ...order.pricing,
        fill_price: fill.average_price,
      },
      completed_at: fill.last_filled_at ?? now,
    });
  }

  if (fill.filled_shares > FILL_EPSILON) {
    return toCompletedOrder(order, "partially_filled", {
      exchange_status: order.exchange_status ?? "partially_filled",
      last_synced_at: now,
      is_open_on_exchange: false,
      remaining_shares: round4(remainingShares),
      fill,
      pricing: {
        ...order.pricing,
        fill_price: fill.average_price,
      },
      completed_at: fill.last_filled_at ?? now,
    });
  }

  return toCompletedOrder(order, deriveTerminalNoFillStatus(order.exchange_status), {
    last_synced_at: now,
    is_open_on_exchange: false,
    remaining_shares: round4(order.requested_shares),
    fill,
    pricing: {
      ...order.pricing,
      fill_price: null,
    },
  });
}

async function syncPaperOrder(order: ManagedOrder): Promise<ManagedOrder> {
  const now = new Date();
  const elapsed = now.getTime() - Date.parse(order.submitted_at);
  if (elapsed < PAPER_FILL_DELAY_MS) {
    return toPendingOrder(order, "submitted", {
      last_synced_at: now.toISOString(),
      is_open_on_exchange: false,
    });
  }

  const fillRatio = order.requested_notional > 12 ? 0.75 : 1;
  const filledShares = round4(order.requested_shares * fillRatio);
  const fillPrice = order.pricing.limit_price ?? order.pricing.signal_price ?? order.pricing.mark_price ?? 0;
  const fillNotional = round4(filledShares * fillPrice);
  const fill: FilledExecution = {
    filled_shares: filledShares,
    filled_notional: fillNotional,
    average_price: filledShares > FILL_EPSILON ? round4(fillNotional / filledShares) : null,
    trade_ids: [`paper-trade-${order.order_id}`],
    transaction_hashes: [],
    first_filled_at: now.toISOString(),
    last_filled_at: now.toISOString(),
  };

  const terminalStatus: CompletedOrder["status"] =
    filledShares >= order.requested_shares - FILL_EPSILON ? "filled" : (filledShares > FILL_EPSILON ? "partially_filled" : "cancelled");

  return toCompletedOrder(order, terminalStatus, {
    exchange_status: terminalStatus,
    last_synced_at: now.toISOString(),
    is_open_on_exchange: false,
    remaining_shares: round4(Math.max(0, order.requested_shares - filledShares)),
    fill,
    pricing: {
      ...order.pricing,
      fill_price: fill.average_price,
    },
    completed_at: now.toISOString(),
  });
}

async function maybeCancelStaleOrder(market: Market, order: ManagedOrder): Promise<ManagedOrder> {
  if (order.is_terminal || !order.is_open_on_exchange || !getClobClient()) return order;
  const ageMs = Date.now() - Date.parse(order.submitted_at);
  if (ageMs < STALE_ORDER_CANCEL_MS) return order;

  const cancelled = await cancelExchangeOrder(order.order_id);
  if (!cancelled) return order;

  console.log(`  [ORDER CANCELLED] ${marketName(market)} | ${order.side} ${order.order_id} | stale open order`);
  return toCompletedOrder(order, "cancelled", {
    exchange_status: "cancelled",
    last_synced_at: new Date().toISOString(),
    is_open_on_exchange: false,
  });
}

function logSyncTransition(market: Market, order: ManagedOrder, sync: OrderSyncResult): void {
  if (sync.newly_filled_shares > FILL_EPSILON) {
    const avg = sync.average_fill_price != null ? `$${sync.average_fill_price.toFixed(3)}` : "n/a";
    const verb = order.side === "BUY" ? "BUY" : "SELL";
    const tag = sync.current_status === "filled" ? `${verb} FILLED` : `${verb} PARTIAL`;
    console.log(
      `  [${tag}] ${marketName(market)} | ${sync.total_filled_shares.toFixed(2)}/${order.requested_shares.toFixed(2)} shares | avg ${avg}`,
    );
  }

  if (sync.previous_status !== sync.current_status && sync.newly_filled_shares <= FILL_EPSILON) {
    const tag = order.side === "BUY" ? "BUY" : "SELL";
    console.log(`  [${tag} ${sync.current_status.toUpperCase()}] ${marketName(market)} | order ${order.order_id}`);
  }
}

function logPositionTransition(previous: Market["position"], next: Market["position"], market: Market): void {
  if (!previous && next && next.phase !== "closed") {
    console.log(
      `  [POSITION OPEN] ${marketName(market)} | ${next.shares_open.toFixed(2)} shares @ $${next.average_entry_price.toFixed(3)}`,
    );
    return;
  }

  if (!previous || !next) return;

  if (previous.phase !== "closed" && next.phase === "closing" && previous.pending_exit_order_id !== next.pending_exit_order_id) {
    console.log(
      `  [POSITION CLOSING] ${marketName(market)} | ${next.shares_open.toFixed(2)} shares remaining | reason ${next.close_reason}`,
    );
  }

  if (previous.phase !== "closed" && next.phase === "closed") {
    console.log(
      `  [POSITION CLOSED] ${marketName(market)} | realized ${next.realized_pnl >= 0 ? "+" : ""}${next.realized_pnl.toFixed(2)} | reason ${next.close_reason}`,
    );
  }
}

export function marketHasActiveOrder(market: Market, side?: OrderSide): boolean {
  return hasActiveOrder(market, side);
}

export function marketHasExposure(market: Market): boolean {
  return positionHasExposure(market.position);
}

export async function submitBuyOrder(market: Market, signal: EntrySignal): Promise<{ market: Market; submitted: boolean }> {
  if (marketHasActiveOrder(market, "BUY") || marketHasActiveOrder(market, "SELL") || marketHasExposure(market)) {
    return { market, submitted: false };
  }

  const live = LIVE_TRADING && !!getClobClient();
  const limitPrice = signal.limit_price
    ?? await calculateImmediatePrice(signal.token_id, "BUY", signal.planned_notional)
    ?? signal.signal_price;

  let order = newTrackedOrder({
    market,
    side: "BUY",
    requestedShares: signal.planned_shares,
    requestedNotional: signal.planned_notional,
    signalPrice: signal.signal_price,
    limitPrice,
    markPrice: signal.mark_price,
    closeReason: null,
    orderId: live ? "pending-live-order" : `paper-buy-${++paperOrderSequence}`,
    exchangeStatus: live ? "submitted" : "paper_submitted",
    strategy: live ? "market-fak" : "paper-sim",
    orderType: live ? "FAK" : "PAPER",
    tokenId: signal.token_id,
    question: signal.question,
    tickSize: signal.tick_size,
    negRisk: signal.neg_risk,
  });

  if (live) {
    const submission = await submitImmediateOrder({
      tokenId: signal.token_id,
      side: "BUY",
      amount: signal.planned_notional,
      limitPrice,
      tickSize: signal.tick_size,
      negRisk: signal.neg_risk,
    });
    if (!submission) return { market, submitted: false };
    order = {
      ...order,
      order_id: submission.orderId,
      exchange_status: submission.status,
    };
  }

  order = orderWithOutcome(order, market);
  console.log(
    `  [BUY SUBMITTED] ${market.city_name} ${market.date} | ${signal.bucket_low}-${signal.bucket_high}${market.unit} | ` +
    `signal $${signal.signal_price.toFixed(3)} | limit ${limitPrice != null ? `$${limitPrice.toFixed(3)}` : "market"} | $${signal.planned_notional.toFixed(2)}`,
  );

  return {
    market: replaceOrder(market, order),
    submitted: true,
  };
}

export async function submitSellOrder(market: Market, exitIntent: ExitIntent): Promise<{ market: Market; submitted: boolean }> {
  let position = market.position;
  if (!position || position.phase === "closed" || position.shares_open <= FILL_EPSILON) {
    return { market, submitted: false };
  }
  if (marketHasActiveOrder(market, "SELL")) return { market, submitted: false };

  const live = LIVE_TRADING && !!getClobClient();
  if (live) {
    const actualShares = await getTokenBalance(position.token_id);
    const syncedPosition = reconcilePositionToTokenBalance(position, actualShares);

    if (syncedPosition !== position) {
      if (!syncedPosition || syncedPosition.phase === "closed") {
        console.log(`  [POSITION SYNC] ${marketName(market)} | token balance is 0.00 shares, closing stale local position`);
        return {
          market: {
            ...market,
            position: syncedPosition,
          },
          submitted: false,
        };
      }

      console.log(
        `  [POSITION SYNC] ${marketName(market)} | adjusted shares from ${position.shares_open.toFixed(2)} to ${syncedPosition.shares_open.toFixed(2)} based on token balance`,
      );
      market = {
        ...market,
        position: syncedPosition,
      };
      position = syncedPosition;
    }
  }

  const limitPrice = exitIntent.limit_price
    ?? await calculateImmediatePrice(position.token_id, "SELL", position.shares_open)
    ?? exitIntent.signal_price;

  let order = newTrackedOrder({
    market,
    side: "SELL",
    requestedShares: position.shares_open,
    requestedNotional: round2(position.shares_open * exitIntent.signal_price),
    signalPrice: exitIntent.signal_price,
    limitPrice,
    markPrice: exitIntent.mark_price,
    closeReason: exitIntent.reason,
    orderId: live ? "pending-live-order" : `paper-sell-${++paperOrderSequence}`,
    exchangeStatus: live ? "submitted" : "paper_submitted",
    strategy: live ? "market-fak" : "paper-sim",
    orderType: live ? "FAK" : "PAPER",
    tokenId: position.token_id,
    question: position.question,
    tickSize: position.tick_size || "0.01",
    negRisk: position.neg_risk || false,
  });

  if (live) {
    const submission = await submitImmediateOrder({
      tokenId: position.token_id,
      side: "SELL",
      amount: position.shares_open,
      limitPrice,
      tickSize: position.tick_size || "0.01",
      negRisk: position.neg_risk || false,
    });
    if (!submission) return { market, submitted: false };
    order = {
      ...order,
      order_id: submission.orderId,
      exchange_status: submission.status,
    };
  }

  console.log(
    `  [SELL SUBMITTED] ${marketName(market)} | ${position.shares_open.toFixed(2)} shares | ` +
    `signal $${exitIntent.signal_price.toFixed(3)} | limit ${limitPrice != null ? `$${limitPrice.toFixed(3)}` : "market"} | reason ${exitIntent.reason}`,
  );

  const nextMarket = replaceOrder(market, order);
  return {
    market: {
      ...nextMarket,
      position: markPositionClosing(position, order.order_id, exitIntent.reason, exitIntent.signal_price, limitPrice, exitIntent.mark_price),
    },
    submitted: true,
  };
}

export async function syncOrderStatus(market: Market, entrySignals: Map<string, EntrySignal> = new Map()): Promise<{ market: Market; results: OrderSyncResult[] }> {
  let nextMarket = market;
  const results: OrderSyncResult[] = [];

  for (const order of market.orders.filter(item => !item.is_terminal)) {
    const beforePosition = nextMarket.position;
    let syncedOrder = order.strategy === "market-fak" ? await syncLiveOrder(order) : await syncPaperOrder(order);
    syncedOrder = await maybeCancelStaleOrder(nextMarket, syncedOrder);
    const syncResult = buildOrderSyncResult(order, syncedOrder);
    results.push(syncResult);
    logSyncTransition(nextMarket, syncedOrder, syncResult);

    nextMarket = replaceOrder(nextMarket, syncedOrder);
    nextMarket = applyOrderSyncResult(nextMarket, syncedOrder, syncResult, entrySignals.get(order.order_id));

    if (nextMarket.position && nextMarket.position.phase !== "closed" && syncedOrder.intent === "exit" && syncedOrder.is_terminal) {
      nextMarket = {
        ...nextMarket,
        position: clearPendingExitOrder(nextMarket.position),
      };
    }

    logPositionTransition(beforePosition, nextMarket.position, nextMarket);
  }

  return { market: nextMarket, results };
}

export async function reconcilePositionsWithExchange(markets: Market[], entrySignals: Map<string, EntrySignal> = new Map()): Promise<Market[]> {
  const reconciled: Market[] = [];
  for (const market of markets) {
    const { market: nextMarket } = await syncOrderStatus(market, entrySignals);
    reconciled.push(nextMarket);
  }
  return reconciled;
}

export async function restoreOpenOrdersForToken(tokenId: string): Promise<Awaited<ReturnType<typeof fetchOpenOrders>>> {
  return await fetchOpenOrders(tokenId);
}

export function markMarketPrice(market: Market, markPrice: number | null): Market {
  return {
    ...market,
    position: updatePositionMark(market.position, markPrice),
  };
}

export function latestSubmittedOrder(market: Market, side?: OrderSide): ManagedOrder | null {
  return getLatestOrder(market, side);
}
