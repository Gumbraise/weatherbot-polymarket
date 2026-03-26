import { LOCATIONS } from "./config.js";
import { round2 } from "./math.js";
import { getState, getAllMarkets } from "./engine.js";

export function printStatus(): void {
  const state    = getState();
  const markets  = getAllMarkets();
  const livePos  = markets.filter(m => m.position && m.position.phase !== "closed");
  const openOrders = markets.flatMap(m => m.orders.filter(order => !order.is_terminal));
  const resolvedM = markets.filter(m => m.status === "resolved" && m.pnl != null);

  const bal     = state.balance;
  const start   = state.starting_balance;
  const retPct  = (bal - start) / start * 100;
  const { wins, losses } = state;
  const total   = wins + losses;

  console.log(`\n${"=".repeat(55)}`);
  console.log(`  WEATHERBET — STATUS`);
  console.log(`${"=".repeat(55)}`);
  console.log(`  Balance:     $${bal.toFixed(2)}  (start $${start.toFixed(2)}, ${retPct >= 0 ? "+" : ""}${retPct.toFixed(1)}%)`);
  if (total > 0) {
    console.log(`  Trades:      ${total} | W: ${wins} | L: ${losses} | WR: ${Math.round(wins / total * 100)}%`);
  } else {
    console.log(`  No trades yet`);
  }
  console.log(`  Exposure:    ${livePos.length}`);
  console.log(`  Open orders: ${openOrders.length}`);
  console.log(`  Resolved:    ${resolvedM.length}`);
  console.log(`  Available:   $${state.available_balance.toFixed(2)} | Reserved: $${state.reserved_balance.toFixed(2)}`);

  if (livePos.length > 0) {
    console.log(`\n  Live positions:`);
    let totalUnrealized = 0.0;
    for (const m of livePos) {
      const pos     = m.position!;
      const unitSym = m.unit === "F" ? "F" : "C";
      const label   = `${pos.bucket_low}-${pos.bucket_high}${unitSym}`;
      const markPrice = pos.exit.mark_price ?? pos.entry.fill_price;
      const unrealized = pos.unrealized_pnl ?? 0;
      totalUnrealized += unrealized;
      console.log(
        `    ${m.city_name.padEnd(16)} ${m.date} | ${label.padEnd(14)} | ` +
        `entry $${pos.entry.fill_price.toFixed(3)} -> mark $${markPrice.toFixed(3)} | ` +
        `phase ${pos.phase.padEnd(7)} | U-PnL: ${unrealized >= 0 ? "+" : ""}${unrealized.toFixed(2)} | ${(pos.metrics.forecast_src || "").toUpperCase()}`
      );
    }
    console.log(`\n  Unrealized PnL: ${totalUnrealized >= 0 ? "+" : ""}${totalUnrealized.toFixed(2)}`);
  }

  console.log(`${"=".repeat(55)}\n`);
}

export function printReport(): void {
  const markets   = getAllMarkets();
  const resolvedM = markets.filter(m => m.status === "resolved" && m.pnl != null);

  console.log(`\n${"=".repeat(55)}`);
  console.log(`  WEATHERBET — FULL REPORT`);
  console.log(`${"=".repeat(55)}`);

  if (resolvedM.length === 0) { console.log("  No resolved markets yet."); return; }

  const totalPnl = resolvedM.reduce((s, m) => s + m.pnl!, 0);
  const wins     = resolvedM.filter(m => m.resolved_outcome === "win");
  const losses   = resolvedM.filter(m => m.resolved_outcome === "loss");

  console.log(`\n  Total resolved: ${resolvedM.length}`);
  console.log(`  Wins:           ${wins.length} | Losses: ${losses.length}`);
  console.log(`  Win rate:       ${Math.round(wins.length / resolvedM.length * 100)}%`);
  console.log(`  Total PnL:      ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(2)}`);

  console.log(`\n  By city:`);
  const cities = Array.from(new Set(resolvedM.map(m => m.city))).sort();
  for (const city of cities) {
    const group = resolvedM.filter(m => m.city === city);
    const w     = group.filter(m => m.resolved_outcome === "win").length;
    const pnl   = group.reduce((s, m) => s + m.pnl!, 0);
    console.log(`    ${LOCATIONS[city].name.padEnd(16)} ${w}/${group.length} (${Math.round(w / group.length * 100)}%)  PnL: ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}`);
  }

  console.log(`\n  Market details:`);
  for (const m of [...resolvedM].sort((a, b) => a.date.localeCompare(b.date))) {
    const pos     = m.position;
    const unitSym = m.unit === "F" ? "F" : "C";
    const snaps   = m.forecast_snapshots || [];
    const firstFc = snaps[0]?.best ?? null;
    const lastFc  = snaps[snaps.length - 1]?.best ?? null;
    const label   = pos ? `${pos.bucket_low}-${pos.bucket_high}${unitSym}` : "no position";
    const result  = (m.resolved_outcome || "").toUpperCase();
    const pnlStr  = m.pnl != null ? `${m.pnl >= 0 ? "+" : ""}${m.pnl.toFixed(2)}` : "-";
    const fcStr   = firstFc != null ? `forecast ${firstFc}->${lastFc}${unitSym}` : "no forecast";
    const actual  = m.actual_temp != null ? `actual ${m.actual_temp}${unitSym}` : "";
    const entryFill = pos ? `$${pos.entry.fill_price.toFixed(3)}` : "-";
    const exitFill = pos?.exit.fill_price != null ? `$${pos.exit.fill_price.toFixed(3)}` : "-";
    console.log(`    ${(m.city_name || "").padEnd(16)} ${m.date} | ${label.padEnd(14)} | ${fcStr} | ${actual} | entry ${entryFill} exit ${exitFill} | ${result} ${pnlStr}`);
  }

  console.log(`${"=".repeat(55)}\n`);
}
