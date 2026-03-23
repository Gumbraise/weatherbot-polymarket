export interface Location {
  lat: number;
  lon: number;
  name: string;
  station: string;
  unit: "F" | "C";
  region: string;
}

export interface Position {
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

export interface Market {
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

export interface State {
  balance: number;
  starting_balance: number;
  total_trades: number;
  wins: number;
  losses: number;
  peak_balance: number;
}
