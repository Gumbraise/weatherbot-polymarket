import axios from "axios";
import { POLY_WALLET, POLYGON_RPC, USDC_CONTRACT, CTF_CONTRACT } from "./config.js";

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

/**
 * Check on-chain balance of a conditional token (ERC-1155) on the CTF contract.
 * Returns number of shares held (6 decimals like USDC).
 */
export async function getTokenBalance(tokenId: string): Promise<number> {
  if (!POLY_WALLET) return 0;
  // balanceOf(address,uint256) selector = 0x00fdd58e
  const addr = POLY_WALLET.replace("0x", "").toLowerCase().padStart(64, "0");
  const tokenIdHex = BigInt(tokenId).toString(16).padStart(64, "0");
  const callData = `0x00fdd58e${addr}${tokenIdHex}`;
  try {
    const { data } = await axios.post(POLYGON_RPC, {
      jsonrpc: "2.0", id: 1, method: "eth_call",
      params: [{ to: CTF_CONTRACT, data: callData }, "latest"],
    }, { timeout: 8000 });
    return parseInt(data.result, 16) / 1e6;
  } catch {
    return 0;
  }
}
