import { Wallet } from "ethers";
import { ClobClient, OrderType, Side } from "@polymarket/clob-client";
import type { ApiKeyCreds, OpenOrder, TickSize, Trade } from "@polymarket/clob-client";
import { CLOB_HOST, LIVE_TRADING, POLY_WALLET, PRIVATE_KEY } from "./config.js";

let clobClient: ClobClient | null = null;

export function getClobClient(): ClobClient | null {
  return clobClient;
}

export async function initClobClient(): Promise<void> {
  if (!LIVE_TRADING || !PRIVATE_KEY) {
    if (LIVE_TRADING) console.log("  [LIVE] PRIVATE_KEY missing — falling back to paper trading");
    return;
  }
  try {
    const signer = new Wallet(PRIVATE_KEY.startsWith("0x") ? PRIVATE_KEY : `0x${PRIVATE_KEY}`);

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

export interface ExchangeOrderRequest {
  tokenId: string;
  side: "BUY" | "SELL";
  amount: number;
  limitPrice: number | null;
  tickSize: string;
  negRisk: boolean;
}

export interface ExchangeOrderSubmission {
  orderId: string;
  status: string | null;
  makingAmount: number | null;
  takingAmount: number | null;
  transactionHashes: string[];
  raw: unknown;
}

export async function submitImmediateOrder(request: ExchangeOrderRequest): Promise<ExchangeOrderSubmission | null> {
  if (!clobClient || !request.tokenId) return null;
  try {
    const resp = await clobClient.createAndPostMarketOrder(
      {
        tokenID: request.tokenId,
        amount: request.amount,
        side: request.side === "BUY" ? Side.BUY : Side.SELL,
        price: request.limitPrice ?? undefined,
      },
      { tickSize: toTickSize(request.tickSize), negRisk: request.negRisk },
      OrderType.FAK,
    );
    const r = resp as any;
    if (r?.error || r?.status === 401 || r?.status === 400) {
      console.log(`  [LIVE ${request.side} FAILED] ${r.error ?? r.data?.error ?? JSON.stringify(r)}`);
      return null;
    }
    const orderId = r?.orderID ?? r?.id ?? null;
    if (!orderId) {
      console.log(`  [LIVE ${request.side} FAILED] No orderID in response: ${JSON.stringify(r)}`);
      return null;
    }
    return {
      orderId: String(orderId),
      status: typeof r?.status === "string" ? r.status : null,
      makingAmount: r?.makingAmount != null ? Number(r.makingAmount) : null,
      takingAmount: r?.takingAmount != null ? Number(r.takingAmount) : null,
      transactionHashes: Array.isArray(r?.transactionsHashes) ? r.transactionsHashes.map(String) : [],
      raw: r,
    };
  } catch (e: any) {
    console.log(`  [LIVE ${request.side} FAILED] ${e.message}`);
    return null;
  }
}

export async function fetchOpenOrders(tokenId?: string): Promise<OpenOrder[]> {
  if (!clobClient) return [];
  try {
    const existing = tokenId
      ? await clobClient.getOpenOrders({ asset_id: tokenId }, true)
      : await clobClient.getOpenOrders(undefined, true);
    return Array.isArray(existing) ? existing : (existing as any)?.data ?? [];
  } catch {
    return [];
  }
}

export async function fetchOrder(orderId: string): Promise<OpenOrder | null> {
  if (!clobClient || !orderId) return null;
  try {
    return await clobClient.getOrder(orderId);
  } catch {
    return null;
  }
}

export async function fetchTrades(tokenId: string, after?: string): Promise<Trade[]> {
  if (!clobClient || !tokenId) return [];
  try {
    const trades = await clobClient.getTrades({
      asset_id: tokenId,
      after,
    }, true);
    return Array.isArray(trades) ? trades : [];
  } catch {
    return [];
  }
}

export async function calculateImmediatePrice(tokenId: string, side: "BUY" | "SELL", amount: number): Promise<number | null> {
  if (!clobClient || !tokenId || amount <= 0) return null;
  try {
    const price = await clobClient.calculateMarketPrice(
      tokenId,
      side === "BUY" ? Side.BUY : Side.SELL,
      amount,
      OrderType.FAK,
    );
    return Number.isFinite(price) ? Number(price) : null;
  } catch {
    return null;
  }
}

export async function cancelExchangeOrder(orderId: string): Promise<boolean> {
  if (!clobClient || !orderId) return false;
  try {
    const response = await clobClient.cancelOrder({ orderID: orderId } as any);
    const cancelled = Array.isArray((response as any)?.canceled) ? (response as any).canceled.map(String) : [];
    return cancelled.includes(orderId);
  } catch {
    return false;
  }
}
