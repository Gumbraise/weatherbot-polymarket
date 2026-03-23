#!/usr/bin/env tsx
/**
 * weatherbet — Weather Trading Bot for Polymarket
 * =====================================================
 * Tracks weather forecasts from 3 sources (ECMWF, HRRR, METAR),
 * compares with Polymarket markets, trades using Kelly criterion.
 *
 * Usage:
 *     tsx src/index.ts          # main loop
 *     tsx src/index.ts report   # full report
 *     tsx src/index.ts status   # balance and open positions
 */

import {
  LOCATIONS, MAX_BET, SCAN_INTERVAL, MONITOR_INTERVAL, LIVE_TRADING,
} from "./config.js";
import { initClobClient, getClobClient } from "./clob.js";
import { syncBalance, getState, scanAndUpdate, monitorPositions, sleep } from "./engine.js";
import { printStatus, printReport } from "./report.js";

async function runLoop(): Promise<void> {
  await syncBalance();

  if (LIVE_TRADING) await initClobClient();
  const clobClient = getClobClient();
  const tradingMode = LIVE_TRADING && clobClient ? "LIVE" : "PAPER";
  const state = getState();

  console.log(`\n${"=".repeat(55)}`);
  console.log(`  WEATHERBET — STARTING (${tradingMode})`);
  console.log(`${"=".repeat(55)}`);
  console.log(`  Mode:       ${tradingMode}`);
  console.log(`  Cities:     ${Object.keys(LOCATIONS).length}`);
  console.log(`  Balance:    $${state.balance.toFixed(2)} | Max bet: $${MAX_BET}`);
  console.log(`  Scan:       ${Math.floor(SCAN_INTERVAL / 60)} min | Monitor: ${Math.floor(MONITOR_INTERVAL / 60)} min`);
  console.log(`  Sources:    ECMWF + HRRR(US) + METAR(D+0)`);
  console.log(`  Ctrl+C to stop\n`);

  let lastFullScan = 0;
  let running = true;

  process.on("SIGINT", () => {
    console.log(`\n  Stopping...`);
    console.log(`  Done. Bye!`);
    running = false;
    process.exit(0);
  });

  while (running) {
    const nowTs  = Date.now() / 1000;
    const nowStr = new Date().toISOString().replace("T", " ").slice(0, 19);

    if (nowTs - lastFullScan >= SCAN_INTERVAL) {
      console.log(`[${nowStr}] full scan...`);
      try {
        const { newPos, closed, resolved } = await scanAndUpdate();
        const st = getState();
        console.log(`  balance: $${st.balance.toFixed(2)} | new: ${newPos} | closed: ${closed} | resolved: ${resolved}`);
        lastFullScan = Date.now() / 1000;
      } catch (e: any) {
        if (e.code === "ECONNREFUSED" || e.code === "ENOTFOUND") {
          console.log(`  Connection lost — waiting 60 sec`);
          await sleep(60000);
          continue;
        }
        console.log(`  Error: ${e.message} — waiting 60 sec`);
        await sleep(60000);
        continue;
      }
    } else {
      console.log(`[${nowStr}] monitoring positions...`);
      try {
        const stopped = await monitorPositions();
        if (stopped) {
          const st = getState();
          console.log(`  balance: $${st.balance.toFixed(2)}`);
        }
      } catch (e: any) {
        console.log(`  Monitor error: ${e.message}`);
      }
    }

    await sleep(MONITOR_INTERVAL * 1000);
  }
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const cmd = process.argv[2] || "run";
if (cmd === "run") {
  runLoop().catch(e => { console.error(e); process.exit(1); });
} else if (cmd === "status") {
  await syncBalance();
  printStatus();
} else if (cmd === "report") {
  await syncBalance();
  printReport();
} else {
  console.log("Usage: tsx src/index.ts [run|status|report]");
}
