import axios from "axios";
import type { Outcome } from "./types.js";

export async function getPolymarketEvent(citySlug: string, month: string, day: number, year: number): Promise<any | null> {
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

export function parseTempRange(question: string): [number, number] | null {
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

export function hoursToResolution(endDateStr: string): number {
  try {
    const end = new Date(endDateStr);
    return Math.max(0.0, (end.getTime() - Date.now()) / 3600000);
  } catch {
    return 999.0;
  }
}

export async function checkMarketResolved(marketId: string): Promise<boolean | null> {
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

export function parseOutcomes(markets: any[]): Outcome[] {
  const outcomes: Outcome[] = [];
  const round4 = (n: number) => Math.round(n * 10000) / 10000;
  for (const market of markets) {
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
  return outcomes;
}
