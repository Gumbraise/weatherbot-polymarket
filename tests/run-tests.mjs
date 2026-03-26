import assert from "node:assert/strict";

import { applyOrderSyncResult, buildOpenPositionFromEntrySignal, markPositionClosing } from "../dist/src/position-state.js";

function makeMarket() {
  return {
    city: "paris",
    city_name: "Paris",
    date: "2026-03-27",
    unit: "C",
    station: "LFPG",
    event_end_date: "2026-03-27T23:00:00Z",
    hours_at_discovery: 12,
    status: "open",
    position: null,
    orders: [],
    actual_temp: null,
    resolved_outcome: null,
    pnl: null,
    forecast_snapshots: [],
    market_snapshots: [],
    all_outcomes: [],
    created_at: "2026-03-26T10:00:00Z",
  };
}

function makeEntrySignal() {
  return {
    market_id: "market-1",
    token_id: "token-1",
    question: "Will Paris be between 18-20C?",
    bucket_low: 18,
    bucket_high: 20,
    signal_price: 0.41,
    bid_at_signal: 0.38,
    spread_at_signal: 0.03,
    mark_price: 0.38,
    limit_price: 0.41,
    planned_shares: 20,
    planned_notional: 8.2,
    p: 0.54,
    ev: 0.12,
    kelly: 0.2,
    forecast_temp: 19,
    forecast_src: "ecmwf",
    sigma: 1.2,
    neg_risk: false,
    tick_size: "0.01",
  };
}

function makeOrder(side, overrides = {}) {
  return {
    order_id: side === "BUY" ? "buy-1" : "sell-1",
    market_id: "market-1",
    token_id: "token-1",
    question: "Will Paris be between 18-20C?",
    bucket_low: 18,
    bucket_high: 20,
    side,
    intent: side === "BUY" ? "entry" : "exit",
    status: "submitted",
    strategy: "paper-sim",
    order_type: "PAPER",
    submitted_at: "2026-03-26T10:00:00Z",
    completed_at: null,
    last_synced_at: null,
    exchange_status: "submitted",
    requested_shares: 20,
    requested_notional: 8.2,
    remaining_shares: 20,
    pricing: {
      signal_price: side === "BUY" ? 0.41 : 0.55,
      limit_price: side === "BUY" ? 0.41 : 0.55,
      fill_price: null,
      mark_price: side === "BUY" ? 0.38 : 0.55,
    },
    fill: {
      filled_shares: 0,
      filled_notional: 0,
      average_price: null,
      trade_ids: [],
      transaction_hashes: [],
      first_filled_at: null,
      last_filled_at: null,
    },
    tick_size: "0.01",
    neg_risk: false,
    error: null,
    is_open_on_exchange: false,
    is_terminal: false,
    close_reason: side === "SELL" ? "take_profit" : null,
    ...overrides,
  };
}

function run(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    throw error;
  }
}

run("entry fill opens position only after a real fill", () => {
  const market = makeMarket();
  const signal = makeEntrySignal();
  const order = makeOrder("BUY");
  const sync = {
    order_id: "buy-1",
    previous_status: "submitted",
    current_status: "filled",
    newly_filled_shares: 20,
    total_filled_shares: 20,
    total_filled_notional: 8.2,
    average_fill_price: 0.41,
    is_open_on_exchange: false,
    completed: true,
  };

  const updated = applyOrderSyncResult(market, order, sync, signal);

  assert.ok(updated.position);
  assert.equal(updated.position.phase, "open");
  assert.equal(updated.position.shares_open, 20);
  assert.equal(updated.position.average_entry_price, 0.41);
  assert.equal(updated.position.entry.fill_price, 0.41);
});

run("partial sell fill keeps the position in closing state", () => {
  const signal = makeEntrySignal();
  const basePosition = buildOpenPositionFromEntrySignal(signal, {
    filled_shares: 20,
    filled_notional: 8.2,
    average_price: 0.41,
    trade_ids: ["t1"],
    transaction_hashes: [],
    first_filled_at: "2026-03-26T10:00:00Z",
    last_filled_at: "2026-03-26T10:00:00Z",
  }, "2026-03-26T10:00:00Z");

  const market = {
    ...makeMarket(),
    position: markPositionClosing(basePosition, "sell-1", "take_profit", 0.55, 0.55, 0.55),
  };
  const order = makeOrder("SELL", { close_reason: "take_profit" });
  const sync = {
    order_id: "sell-1",
    previous_status: "submitted",
    current_status: "partially_filled",
    newly_filled_shares: 8,
    total_filled_shares: 8,
    total_filled_notional: 4.4,
    average_fill_price: 0.55,
    is_open_on_exchange: false,
    completed: true,
  };

  const updated = applyOrderSyncResult(market, order, sync);

  assert.ok(updated.position);
  assert.equal(updated.position.phase, "closing");
  assert.equal(updated.position.shares_open, 12);
  assert.equal(updated.position.shares_closed, 8);
  assert.equal(updated.position.realized_pnl, 1.12);
});

run("full sell fill closes the position and realizes pnl", () => {
  const signal = makeEntrySignal();
  const basePosition = buildOpenPositionFromEntrySignal(signal, {
    filled_shares: 20,
    filled_notional: 8.2,
    average_price: 0.41,
    trade_ids: ["t1"],
    transaction_hashes: [],
    first_filled_at: "2026-03-26T10:00:00Z",
    last_filled_at: "2026-03-26T10:00:00Z",
  }, "2026-03-26T10:00:00Z");

  const market = {
    ...makeMarket(),
    position: markPositionClosing(basePosition, "sell-1", "take_profit", 0.55, 0.55, 0.55),
  };
  const order = makeOrder("SELL", { close_reason: "take_profit" });
  const sync = {
    order_id: "sell-1",
    previous_status: "submitted",
    current_status: "filled",
    newly_filled_shares: 20,
    total_filled_shares: 20,
    total_filled_notional: 11,
    average_fill_price: 0.55,
    is_open_on_exchange: false,
    completed: true,
  };

  const updated = applyOrderSyncResult(market, order, sync);

  assert.ok(updated.position);
  assert.equal(updated.position.phase, "closed");
  assert.equal(updated.position.shares_open, 0);
  assert.equal(updated.position.realized_pnl, 2.8);
  assert.equal(updated.position.close_reason, "take_profit");
});
