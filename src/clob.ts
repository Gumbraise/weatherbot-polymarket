import { Wallet } from "ethers";
import { ClobClient, Side, OrderType } from "@polymarket/clob-client";
import type { ApiKeyCreds, TickSize } from "@polymarket/clob-client";
import { CLOB_HOST, PRIVATE_KEY, LIVE_TRADING, POLY_WALLET } from "./config.js";

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

export async function placeLiveOrder(
  tokenId: string,
  side: "BUY" | "SELL",
  price: number,
  size: number,
  tickSize: string,
  negRisk: boolean,
): Promise<string | null> {
  if (!clobClient || !tokenId) return null;
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

export async function hasExistingOrders(tokenId: string): Promise<boolean> {
  if (!clobClient || !tokenId) return false;
  try {
    const existing = await clobClient.getOpenOrders({ asset_id: tokenId });
    const orders = Array.isArray(existing) ? existing : (existing as any)?.data ?? [];
    return orders.length > 0;
  } catch {
    return false;
  }
}
