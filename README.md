# 🌤️ WeatherBot Polymarket — Automated Weather Trading Bot

> **Autonomous weather prediction market trading bot for [Polymarket](https://polymarket.com)** — Fetches real-time weather forecasts, identifies mispriced temperature markets, and executes trades using Kelly criterion and EIP-712 signed orders on Polygon.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue?logo=typescript)](https://www.typescriptlang.org/)
[![Polymarket](https://img.shields.io/badge/Polymarket-CLOB%20API-purple)](https://docs.polymarket.com/)
[![Polygon](https://img.shields.io/badge/Polygon-Mainnet-8247e5?logo=polygon)](https://polygon.technology/)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

---

## What It Does

WeatherBot is a **fully automated trading bot** that finds and exploits mispricings in Polymarket's daily high temperature markets across **20 global cities**.

It works by comparing professional weather forecasts against Polymarket odds. When the forecasts disagree with the market, the bot calculates expected value and places optimally-sized bets using the Kelly criterion.

### The Edge

Weather forecasting models (ECMWF, GFS/HRRR) are surprisingly accurate 1-3 days out, but prediction markets often misprice temperature buckets — especially for less-followed cities or during rapidly changing weather patterns. This bot systematically captures that edge.

---

## Features

- **3 Forecast Sources** — ECMWF IFS (global), GFS/HRRR (US high-res), METAR (real-time airport observations)
- **20 Cities Worldwide** — NYC, Chicago, Miami, London, Paris, Tokyo, Seoul, Singapore, and more
- **Kelly Criterion Sizing** — Mathematically optimal bet sizing based on calculated edge
- **Live Trading via CLOB API** — Places real orders on Polymarket with EIP-712 signatures
- **Smart Risk Management** — Stop-loss (80%), trailing stop (breakeven at +20%), dynamic take-profit
- **Forecast Shift Detection** — Auto-exits positions when weather models change significantly
- **Crash Recovery** — Restores open positions from on-chain CTF token balances at startup
- **Monitor Mode** — Sell-only loop that manages existing positions without opening new ones
- **Stateless Architecture** — No local database; all state from blockchain + APIs
- **Auto-Resolution** — Detects market outcomes and tracks P&L automatically

---

## Architecture

```
src/
├── index.ts        → CLI entry point (run / monitor / exit / status / report)
├── config.ts       → Environment variables, 20 city locations, timezones
├── types.ts        → TypeScript interfaces (Position, Market, Outcome, State)
├── math.ts         → Kelly criterion, expected value, normal CDF, bucket probability
├── forecast.ts     → ECMWF, HRRR/GFS, METAR, Visual Crossing API clients
├── polymarket.ts   → Gamma API client, temperature range parser, market resolution
├── wallet.ts       → USDC.e balance via Polygon RPC, CTF token balance checker
├── clob.ts         → Polymarket CLOB client, order placement, duplicate guard
├── engine.ts       → Core trading loop, position management, restore from chain
└── report.ts       → Status dashboard and detailed performance reports
```

---

## Quick Start

### Prerequisites

- **Node.js** ≥ 18
- A **Polymarket account** with USDC.e deposited
- Your **MetaMask private key** (the signer wallet)

### Installation

```bash
git clone https://github.com/Gumbraise/weatherbot-polymarket.git
cd weatherbot-polymarket
npm install
```

### Configuration

```bash
cp .env.example .env
```

Edit `.env` with your credentials:

```env
# Your Polymarket proxy wallet address (found on polymarket.com/wallet)
POLY_WALLET=0x...

# Your MetaMask private key (signer wallet)
PRIVATE_KEY=...

# Enable live trading (set to false for paper trading)
LIVE_TRADING=true

# Trading parameters
MAX_BET=5              # Maximum bet size in USDC
MIN_EV=0.10            # Minimum expected value to enter
MAX_PRICE=0.45         # Don't buy above this price
KELLY_FRACTION=0.25    # Fraction of Kelly criterion to use
SCAN_INTERVAL=3600     # Full scan every N seconds
MAX_SLIPPAGE=0.03      # Max spread to accept
```

> **Note:** CLOB API credentials are auto-derived on first run from your private key. They'll be printed to console — save them to `.env` to skip re-derivation.

### Run

```bash
# Full auto-trading mode (buy + sell + monitor)
npx tsx src/index.ts

# Monitor mode — only manage existing positions (no new buys)
npx tsx src/index.ts monitor

# Sell all open positions immediately
npx tsx src/index.ts exit

# Check balance and open positions
npx tsx src/index.ts status

# Full performance report
npx tsx src/index.ts report
```

---

## How the Bot Decides

### Entry (BUY)

```
1. Fetch ECMWF + HRRR forecasts for each city (D+0 to D+3)
2. Get all Polymarket temperature markets from Gamma API
3. For each market bucket, calculate P(forecast lands in bucket) using normal CDF
4. Compute Expected Value: EV = P × (1/price - 1) - (1 - P)
5. If EV > 0.10 and price < $0.45 → calculate Kelly optimal size
6. Verify real-time spread < 3¢ and no existing orders
7. Place GTC limit order via CLOB API
```

### Exit (SELL)

| Trigger | Condition | Reason |
|---------|-----------|--------|
| **Stop-loss** | Price drops below 80% of entry | Cut losses early |
| **Trailing stop** | Price rose +20%, then fell back to entry | Lock in breakeven |
| **Take profit** | Price ≥ $0.75 (>48h) or ≥ $0.85 (>24h) | Secure gains |
| **Forecast shift** | New forecast exits bucket by 2°F+ | Edge disappeared |
| **Resolution** | Market resolves on Polymarket | Final settlement |

### Position Monitoring

- **Full scan** every 60 minutes — fetches fresh forecasts, evaluates all markets
- **Position check** every 10 minutes — monitors stop-loss, trailing, take-profit
- **Auto-resolution** — detects when Polymarket settles a market, records win/loss

---

## Supported Cities

| Americas | Europe | Asia-Pacific |
|----------|--------|-------------|
| New York City 🇺🇸 | London 🇬🇧 | Tokyo 🇯🇵 |
| Chicago 🇺🇸 | Paris 🇫🇷 | Seoul 🇰🇷 |
| Miami 🇺🇸 | Munich 🇩🇪 | Shanghai 🇨🇳 |
| Dallas 🇺🇸 | Ankara 🇹🇷 | Singapore 🇸🇬 |
| Seattle 🇺🇸 | | Lucknow 🇮🇳 |
| Atlanta 🇺🇸 | | Tel Aviv 🇮🇱 |
| Toronto 🇨🇦 | | Wellington 🇳🇿 |
| São Paulo 🇧🇷 | | |
| Buenos Aires 🇦🇷 | | |

---

## Technical Stack

- **Runtime:** Node.js + [tsx](https://github.com/privatenumber/tsx) (TypeScript execution)
- **Blockchain:** Polygon mainnet via public RPC
- **Trading:** Polymarket CLOB API with EIP-712 order signing
- **Wallet:** Gnosis Safe proxy (signature type 2) via ethers.js v5
- **Forecasts:** [Open-Meteo](https://open-meteo.com/) (ECMWF, GFS), [Aviation Weather](https://aviationweather.gov/) (METAR)
- **Market Data:** [Polymarket Gamma API](https://gamma-api.polymarket.com/)
- **State Recovery:** On-chain CTF (ERC-1155) token balance queries

---

## Disclaimer

This bot trades with real money on Polymarket. Use at your own risk.

- Weather forecasts can be wrong
- Markets can be illiquid
- Smart contract risk exists on Polygon
- Past performance does not guarantee future results

**Start with small bets** (`MAX_BET=1`) and monitor performance before scaling up.

---

## Credits

This project is based on **[alteregoeth-ai/weatherbot](https://github.com/alteregoeth-ai/weatherbot)**

Rewritten in TypeScript with modular architecture, live trading via Polymarket CLOB API, on-chain position recovery, and stateless design.

---

## License

MIT
