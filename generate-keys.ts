#!/usr/bin/env tsx
/**
 * generate-keys.ts — Generate Polymarket CLOB API keys
 *
 * Usage:
 *     PRIVATE_KEY=0x... tsx generate-keys.ts
 *
 * Outputs the 4 values to add to your .env:
 *     CLOB_API_KEY, CLOB_SECRET, CLOB_PASSPHRASE, CLOB_ADDRESS
 */

import { ClobClient } from "@polymarket/clob-client";
import { Wallet } from "@ethersproject/wallet";

const CLOB_URL = "https://clob.polymarket.com";
const CHAIN_ID = 137; // Polygon mainnet

const pk = process.env.PRIVATE_KEY;
if (!pk) {
  console.error("Usage: PRIVATE_KEY=0x... tsx generate-keys.ts");
  process.exit(1);
}

const wallet = new Wallet(pk);
console.log(`Wallet: ${wallet.address}\n`);
console.log("Generating CLOB API keys...\n");

const client = new ClobClient(CLOB_URL, CHAIN_ID, wallet);
const creds: any = await client.createApiKey();

console.log("Add these to your .env:\n");
console.log(`CLOB_API_KEY=${creds.apiKey ?? creds.key}`);
console.log(`CLOB_SECRET=${creds.secret}`);
console.log(`CLOB_PASSPHRASE=${creds.passphrase}`);
console.log(`CLOB_ADDRESS=${wallet.address}`);
