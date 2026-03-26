import { round2, round4 } from "./math.js";
import type {
  CloseReason,
  EntrySignal,
  ExitPricing,
  ExitReason,
  FilledExecution,
  ManagedOrder,
  ManagedPosition,
  Market,
  OpenPosition,
  OrderSyncResult,
  PositionBase,
} from "./types.js";

const POSITION_EPSILON = 0.000001;

function cloneExecution(fill: FilledExecution): FilledExecution {
  return {
    filled_shares: round4(fill.filled_shares),
    filled_notional: round4(fill.filled_notional),
    average_price: fill.average_price != null ? round4(fill.average_price) : null,
    trade_ids: [...fill.trade_ids],
    transaction_hashes: [...fill.transaction_hashes],
    first_filled_at: fill.first_filled_at,
    last_filled_at: fill.last_filled_at,
  };
}

function buildExitPricing(position: PositionBase, order: ManagedOrder): ExitPricing {
  return {
    signal_price: order.pricing.signal_price ?? position.exit.signal_price,
    limit_price: order.pricing.limit_price ?? position.exit.limit_price,
    fill_price: order.fill.average_price ?? position.exit.fill_price,
    mark_price: order.pricing.mark_price ?? position.exit.mark_price,
  };
}

export function positionHasExposure(position: ManagedPosition | null): boolean {
  return !!position && position.shares_open > POSITION_EPSILON && position.phase !== "closed";
}

export function hasActiveOrder(market: Market, side?: "BUY" | "SELL"): boolean {
  return market.orders.some(order => !order.is_terminal && (!side || order.side === side));
}

export function getLatestOrder(market: Market, side?: "BUY" | "SELL"): ManagedOrder | null {
  const orders = market.orders
    .filter(order => !side || order.side === side)
    .sort((a, b) => Date.parse(b.submitted_at) - Date.parse(a.submitted_at));
  return orders[0] ?? null;
}

export function buildOpenPositionFromEntrySignal(signal: EntrySignal, fill: FilledExecution, openedAt: string): OpenPosition {
  const avgFillPrice = fill.average_price ?? signal.signal_price;
  const shares = round4(fill.filled_shares);
  const totalEntryCost = round2(fill.filled_notional);

  return {
    phase: "open",
    market_id: signal.market_id,
    token_id: signal.token_id,
    question: signal.question,
    bucket_low: signal.bucket_low,
    bucket_high: signal.bucket_high,
    target_notional: round2(signal.planned_notional),
    total_entry_shares: shares,
    total_entry_cost: totalEntryCost,
    shares_open: shares,
    shares_closed: 0,
    total_exit_proceeds: 0,
    average_entry_price: round4(avgFillPrice),
    average_exit_price: null,
    realized_pnl: 0,
    unrealized_pnl: null,
    opened_at: openedAt,
    last_updated_at: openedAt,
    close_reason: null,
    closed_at: null,
    pending_exit_order_id: null,
    entry: {
      signal_price: signal.signal_price,
      limit_price: signal.limit_price,
      fill_price: round4(avgFillPrice),
      bid_at_signal: signal.bid_at_signal,
      spread_at_signal: signal.spread_at_signal,
      mark_price: signal.mark_price,
      estimated: false,
    },
    exit: {
      signal_price: null,
      limit_price: null,
      fill_price: null,
      mark_price: signal.mark_price,
    },
    metrics: {
      p: signal.p,
      ev: signal.ev,
      kelly: signal.kelly,
      forecast_temp: signal.forecast_temp,
      forecast_src: signal.forecast_src,
      sigma: signal.sigma,
    },
    stop_price: round4(avgFillPrice * 0.8),
    trailing_activated: false,
    neg_risk: signal.neg_risk,
    tick_size: signal.tick_size,
    restored_from_balance: false,
  };
}

export function createRestoredPositionFromBalance(market: Market, outcome: { question: string; market_id: string; token_id: string; range: [number, number]; bid: number; ask: number; spread: number; neg_risk: boolean; tick_size: string; }, shares: number, restoredAt: string): OpenPosition {
  const entryPrice = outcome.ask || outcome.bid || 0.5;
  const roundedShares = round4(shares);
  const cost = round2(roundedShares * entryPrice);

  return {
    phase: "open",
    market_id: outcome.market_id,
    token_id: outcome.token_id,
    question: outcome.question,
    bucket_low: outcome.range[0],
    bucket_high: outcome.range[1],
    target_notional: cost,
    total_entry_shares: roundedShares,
    total_entry_cost: cost,
    shares_open: roundedShares,
    shares_closed: 0,
    total_exit_proceeds: 0,
    average_entry_price: round4(entryPrice),
    average_exit_price: null,
    realized_pnl: 0,
    unrealized_pnl: null,
    opened_at: restoredAt,
    last_updated_at: restoredAt,
    close_reason: null,
    closed_at: null,
    pending_exit_order_id: null,
    entry: {
      signal_price: round4(entryPrice),
      limit_price: round4(entryPrice),
      fill_price: round4(entryPrice),
      bid_at_signal: outcome.bid,
      spread_at_signal: outcome.spread,
      mark_price: outcome.bid,
      estimated: true,
    },
    exit: {
      signal_price: null,
      limit_price: null,
      fill_price: null,
      mark_price: outcome.bid,
    },
    metrics: {
      p: 0,
      ev: 0,
      kelly: 0,
      forecast_temp: 0,
      forecast_src: null,
      sigma: 0,
    },
    stop_price: round4(entryPrice * 0.8),
    trailing_activated: false,
    neg_risk: outcome.neg_risk,
    tick_size: outcome.tick_size,
    restored_from_balance: true,
  };
}

export function updatePositionMark(position: ManagedPosition | null, markPrice: number | null): ManagedPosition | null {
  if (!position || markPrice == null || position.phase === "closed") return position;

  return {
    ...position,
    exit: {
      ...position.exit,
      mark_price: round4(markPrice),
    },
    unrealized_pnl: round2((markPrice - position.average_entry_price) * position.shares_open),
    last_updated_at: new Date().toISOString(),
  };
}

export function markPositionClosing(position: ManagedPosition, orderId: string | null, reason: ExitReason | "manual_exit", exitSignalPrice: number, limitPrice: number | null, markPrice: number | null): ManagedPosition {
  if (position.phase === "closed") return position;

  return {
    ...position,
    phase: "closing" as const,
    pending_exit_order_id: orderId,
    close_reason: reason,
    closed_at: null,
    exit: {
      signal_price: round4(exitSignalPrice),
      limit_price: limitPrice != null ? round4(limitPrice) : null,
      fill_price: position.exit.fill_price,
      mark_price: markPrice != null ? round4(markPrice) : position.exit.mark_price,
    },
    last_updated_at: new Date().toISOString(),
  };
}

export function clearPendingExitOrder(position: ManagedPosition): ManagedPosition {
  if (position.phase === "closed") return position;
  if (position.phase === "open") return { ...position, pending_exit_order_id: null };
  return { ...position, pending_exit_order_id: null, last_updated_at: new Date().toISOString() };
}

export function applyOrderSyncResult(market: Market, order: ManagedOrder, sync: OrderSyncResult, entrySignal?: EntrySignal): Market {
  const deltaShares = round4(sync.newly_filled_shares);
  const deltaNotional = round4(sync.total_filled_notional - order.fill.filled_notional);
  let position = market.position;

  if (deltaShares > POSITION_EPSILON) {
    if (order.intent === "entry") {
      if (!position) {
        if (!entrySignal) {
          throw new Error(`Missing entry signal context for order ${order.order_id}`);
        }
        position = buildOpenPositionFromEntrySignal(
          entrySignal,
          {
            ...cloneExecution(order.fill),
            filled_shares: sync.total_filled_shares,
            filled_notional: sync.total_filled_notional,
            average_price: sync.average_fill_price,
          },
          order.fill.last_filled_at ?? order.submitted_at,
        );
      } else if (position.phase !== "closed") {
        const totalEntryShares = round4(position.total_entry_shares + deltaShares);
        const totalEntryCost = round2(position.total_entry_cost + deltaNotional);
        if (position.phase === "closing") {
          position = {
            ...position,
            phase: "closing",
            total_entry_shares: totalEntryShares,
            total_entry_cost: totalEntryCost,
            shares_open: round4(position.shares_open + deltaShares),
            average_entry_price: totalEntryShares > POSITION_EPSILON ? round4(totalEntryCost / totalEntryShares) : position.average_entry_price,
            unrealized_pnl: position.exit.mark_price != null ? round2((position.exit.mark_price - position.average_entry_price) * (position.shares_open + deltaShares)) : position.unrealized_pnl,
            last_updated_at: order.fill.last_filled_at ?? order.submitted_at,
          };
        } else {
          position = {
            ...position,
            phase: "open",
            total_entry_shares: totalEntryShares,
            total_entry_cost: totalEntryCost,
            shares_open: round4(position.shares_open + deltaShares),
            average_entry_price: totalEntryShares > POSITION_EPSILON ? round4(totalEntryCost / totalEntryShares) : position.average_entry_price,
            unrealized_pnl: position.exit.mark_price != null ? round2((position.exit.mark_price - position.average_entry_price) * (position.shares_open + deltaShares)) : position.unrealized_pnl,
            last_updated_at: order.fill.last_filled_at ?? order.submitted_at,
          };
        }
      }
    } else if (position && position.phase !== "closed") {
      const sharesClosed = Math.min(position.shares_open, deltaShares);
      const remainingShares = Math.max(0, position.shares_open - sharesClosed);
      const realizedDelta = round2(deltaNotional - sharesClosed * position.average_entry_price);
      const totalExitProceeds = round2(position.total_exit_proceeds + deltaNotional);
      const totalClosedShares = round4(position.shares_closed + sharesClosed);
      const averageExitPrice = totalClosedShares > POSITION_EPSILON ? round4(totalExitProceeds / totalClosedShares) : null;
      const completedAt = order.fill.last_filled_at ?? order.submitted_at;
      const closeReason = (position.close_reason ?? order.close_reason ?? "manual_exit") as CloseReason;

      if (remainingShares <= POSITION_EPSILON) {
        position = {
          ...position,
          phase: "closed" as const,
          pending_exit_order_id: null,
          shares_open: 0 as const,
          shares_closed: totalClosedShares,
          total_exit_proceeds: totalExitProceeds,
          average_exit_price: averageExitPrice,
          realized_pnl: round2(position.realized_pnl + realizedDelta),
          unrealized_pnl: 0,
          close_reason: closeReason,
          closed_at: completedAt,
          exit: buildExitPricing(position, order),
          last_updated_at: completedAt,
        };
      } else {
        position = {
          ...position,
          phase: "closing" as const,
          pending_exit_order_id: sync.completed ? null : order.order_id,
          shares_open: round4(remainingShares),
          shares_closed: totalClosedShares,
          total_exit_proceeds: totalExitProceeds,
          average_exit_price: averageExitPrice,
          realized_pnl: round2(position.realized_pnl + realizedDelta),
          unrealized_pnl: position.exit.mark_price != null ? round2((position.exit.mark_price - position.average_entry_price) * remainingShares) : position.unrealized_pnl,
          close_reason: closeReason as ExitReason | "manual_exit",
          exit: buildExitPricing(position, order),
          last_updated_at: completedAt,
        };
      }
    }
  }

  if (position && order.intent === "exit" && sync.completed && position.phase !== "closed") {
    position = {
      ...position,
      pending_exit_order_id: null,
      last_updated_at: new Date().toISOString(),
    };
  }

  return {
    ...market,
    position,
    pnl: position?.phase === "closed" ? position.realized_pnl : market.pnl,
  };
}
