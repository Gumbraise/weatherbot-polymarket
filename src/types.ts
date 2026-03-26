export interface Location {
  lat: number;
  lon: number;
  name: string;
  station: string;
  unit: "F" | "C";
  region: string;
}

export type MarketStatus = "open" | "closed" | "resolved";
export type OrderSide = "BUY" | "SELL";
export type OrderIntent = "entry" | "exit";
export type OrderStrategy = "market-fak" | "paper-sim";
export type OrderLifecycleStatus =
  | "submitted"
  | "open"
  | "partially_filled"
  | "filled"
  | "cancelled"
  | "rejected"
  | "failed";
export type PositionPhase = "open" | "closing" | "closed";
export type CloseReason =
  | "manual_exit"
  | "stop_loss"
  | "trailing_stop"
  | "take_profit"
  | "forecast_changed"
  | "resolved";
export type ExitReason = Exclude<CloseReason, "resolved">;

export interface Outcome {
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

export interface ForecastSnap {
  ts: string | null;
  horizon: string;
  hours_left: number;
  ecmwf: number | null;
  hrrr: number | null;
  metar: number | null;
  best: number | null;
  best_source: string | null;
}

export interface MarketSnap {
  ts: string | null;
  top_bucket: string | null;
  top_price: number | null;
}

export interface PricingSnapshot {
  signal_price: number | null;
  limit_price: number | null;
  fill_price: number | null;
  mark_price: number | null;
}

export interface FilledExecution {
  filled_shares: number;
  filled_notional: number;
  average_price: number | null;
  trade_ids: string[];
  transaction_hashes: string[];
  first_filled_at: string | null;
  last_filled_at: string | null;
}

export interface TrackedOrderBase {
  order_id: string;
  market_id: string;
  token_id: string;
  question: string;
  bucket_low: number;
  bucket_high: number;
  side: OrderSide;
  intent: OrderIntent;
  status: OrderLifecycleStatus;
  strategy: OrderStrategy;
  order_type: "FAK" | "PAPER";
  submitted_at: string;
  completed_at: string | null;
  last_synced_at: string | null;
  exchange_status: string | null;
  requested_shares: number;
  requested_notional: number;
  remaining_shares: number;
  pricing: PricingSnapshot;
  fill: FilledExecution;
  tick_size: string;
  neg_risk: boolean;
  error: string | null;
  is_open_on_exchange: boolean;
  is_terminal: boolean;
  close_reason: ExitReason | "manual_exit" | null;
}

export interface PendingOrder extends TrackedOrderBase {
  status: "submitted" | "open";
  is_terminal: false;
}

export interface CompletedOrder extends TrackedOrderBase {
  status: "partially_filled" | "filled" | "cancelled" | "rejected" | "failed";
  is_terminal: true;
}

export type ManagedOrder = PendingOrder | CompletedOrder;

export interface PositionSignalMetrics {
  p: number;
  ev: number;
  kelly: number;
  forecast_temp: number;
  forecast_src: string | null;
  sigma: number;
}

export interface EntryPricing {
  signal_price: number;
  limit_price: number | null;
  fill_price: number;
  bid_at_signal: number;
  spread_at_signal: number;
  mark_price: number | null;
  estimated: boolean;
}

export interface ExitPricing {
  signal_price: number | null;
  limit_price: number | null;
  fill_price: number | null;
  mark_price: number | null;
}

export interface PositionBase {
  market_id: string;
  token_id: string;
  question: string;
  bucket_low: number;
  bucket_high: number;
  target_notional: number;
  total_entry_shares: number;
  total_entry_cost: number;
  shares_open: number;
  shares_closed: number;
  total_exit_proceeds: number;
  average_entry_price: number;
  average_exit_price: number | null;
  realized_pnl: number;
  unrealized_pnl: number | null;
  opened_at: string | null;
  last_updated_at: string | null;
  close_reason: CloseReason | null;
  closed_at: string | null;
  entry: EntryPricing;
  exit: ExitPricing;
  metrics: PositionSignalMetrics;
  stop_price?: number;
  trailing_activated?: boolean;
  neg_risk?: boolean;
  tick_size?: string;
  restored_from_balance?: boolean;
}

export interface OpenPosition extends PositionBase {
  phase: "open";
  pending_exit_order_id: null;
  close_reason: null;
  closed_at: null;
}

export interface ClosingPosition extends PositionBase {
  phase: "closing";
  pending_exit_order_id: string | null;
  close_reason: ExitReason | "manual_exit";
  closed_at: null;
}

export interface ClosedPosition extends PositionBase {
  phase: "closed";
  pending_exit_order_id: null;
  shares_open: 0;
  close_reason: CloseReason;
  closed_at: string;
}

export type ManagedPosition = OpenPosition | ClosingPosition | ClosedPosition;

export interface Market {
  city: string;
  city_name: string;
  date: string;
  unit: "F" | "C";
  station: string;
  event_end_date: string;
  hours_at_discovery: number;
  status: MarketStatus;
  position: ManagedPosition | null;
  orders: ManagedOrder[];
  actual_temp: number | null;
  resolved_outcome: "win" | "loss" | "no_position" | null;
  pnl: number | null;
  forecast_snapshots: ForecastSnap[];
  market_snapshots: MarketSnap[];
  all_outcomes: Outcome[];
  created_at: string;
}

export interface State {
  balance: number;
  available_balance: number;
  reserved_balance: number;
  starting_balance: number;
  total_trades: number;
  wins: number;
  losses: number;
  peak_balance: number;
  realized_pnl: number;
}

export interface OrderSyncResult {
  order_id: string;
  previous_status: OrderLifecycleStatus;
  current_status: OrderLifecycleStatus;
  newly_filled_shares: number;
  total_filled_shares: number;
  total_filled_notional: number;
  average_fill_price: number | null;
  is_open_on_exchange: boolean;
  completed: boolean;
}

export interface EntrySignal {
  market_id: string;
  token_id: string;
  question: string;
  bucket_low: number;
  bucket_high: number;
  signal_price: number;
  bid_at_signal: number;
  spread_at_signal: number;
  mark_price: number | null;
  limit_price: number | null;
  planned_shares: number;
  planned_notional: number;
  p: number;
  ev: number;
  kelly: number;
  forecast_temp: number;
  forecast_src: string | null;
  sigma: number;
  neg_risk: boolean;
  tick_size: string;
}

export interface ExitIntent {
  reason: ExitReason | "manual_exit";
  signal_price: number;
  mark_price: number | null;
  limit_price: number | null;
}
