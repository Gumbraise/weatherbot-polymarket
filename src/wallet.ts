import axios from "axios";
import { POLY_WALLET, POLYGON_RPC, USDC_CONTRACT } from "./config.js";

export async function fetchPolymarketBalance(): Promise<number | null> {
  if (!POLY_WALLET) return null;
  const addr = POLY_WALLET.replace("0x", "").toLowerCase().padStart(64, "0");
  const callData = `0x70a08231${addr}`;
  try {
    const { data } = await axios.post(POLYGON_RPC, {
      jsonrpc: "2.0", id: 1, method: "eth_call",
      params: [{ to: USDC_CONTRACT, data: callData }, "latest"],
    }, { timeout: 8000 });
    return parseInt(data.result, 16) / 1e6;
  } catch (e: any) {
    console.log(`  [RPC] Failed to fetch balance: ${e.message}`);
    return null;
  }
}
