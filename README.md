# Polymarket Arbitrage Trade Bot (TypeScript)

A TypeScript bot that trades on [Polymarket](https://polymarket.com) **binary crypto markets**—e.g. “Will Bitcoin go up or down in the next 15 minutes?” It connects to Polymarket’s order book (CLOB), picks a market by coin and time window, and runs one of two configurable strategies.

**Contact:** [@xstacks](https://t.me/x_stacks)

---

## Table of contents

- [What is this bot?](#what-is-this-bot)
- [Quick start](#quick-start)
- [Understanding the strategy](#understanding-the-strategy)
- [Setup (step by step)](#setup-step-by-step)
- [Running the bot](#running-the-bot)
- [Configuration reference](#configuration-reference)
- [Project layout](#project-layout)
- [Disclaimer](#disclaimer)

---

## What is this bot?

- **Markets:** Binary markets on Polymarket (e.g. BTC up/down in 15, 60, 240, or 1440 minutes). You choose **coin** (btc, eth, sol, xrp) and **period** in the config.
- **Behavior:** The bot fetches live order-book prices every second, decides when to **buy UP**, **buy DOWN**, or **sell** based on the active strategy, and can place orders via the Polymarket CLOB (or run in simulation).
- **Important:** This is **not** classic arbitrage. The code supports:
  - **trade_1:** Exit-focused—hold UP or DOWN and sell when a time or price condition is met.
  - **trade_2:** Entry + exit + optional “emergency swap”—enter when price and time are in range, exit in defined price bands, and optionally flip to the opposite side in an emergency band.

Order placement is **enabled** in the code; use `trade.toml` and your risk settings to control size and behavior.

---

## Quick start

1. **Requirements:** Node.js ≥ 20.6.0, a Polymarket proxy wallet and the EOA private key that signs for it.
2. **Clone, install, env, config:**
   ```bash
   git clone https://github.com/dev-protocol/polymarket-trading-bot
   cd polymarket-arbitrage-bot.git
   npm install
   ```
   - Copy `.env.example` to `.env` and set `POLYMARKET_PRIVATE_KEY` and `PROXY_WALLET_ADDRESS`.
   - Edit `trade.toml`: set `strategy` (`trade_1` or `trade_2`), `[market]` (coin + period), and optional `trade_usd`, etc.
3. **Run:**
   ```bash
   npm run dev
   ```
   The bot will find the matching market, connect, poll prices every second, and make trading decisions according to the chosen strategy.

---

## Understanding the strategy

The bot trades **one binary market at a time**: one **UP** token and one **DOWN** token. Prices are normalized into ratios (e.g. how far the UP bid is from 0.5). Decisions use:

- **Remaining time ratio** = elapsed time / market duration (0 → 1 as the market approaches expiry).
- **UP price ratio** = |UP bid − 0.5| / 0.5 (0 = balanced, 1 = extreme).

### Strategy 1: `trade_1` — Time or price exit

- **Idea:** You are assumed to already hold either UP or DOWN (e.g. from a previous run or manual trade). The bot only **exits** when a condition is met.
- **Exit when:**
  - **Time:** remaining time ratio > `exit_time_ratio` (e.g. 0.95 = near expiry), **or**
  - **Price:** UP price ratio > `exit_price_ratio` (e.g. market moved strongly in one direction).
- **Action:** If holding UP → sell UP; if holding DOWN → sell DOWN.
- **Use case:** Automate closing a position when the market is almost over or when price has moved enough.

### Strategy 2: `trade_2` — Entry, exit, and emergency swap

- **Idea:** Enter when price and time are in range, exit when price is in an “exit band,” and optionally “emergency swap” to the opposite side in another band.
- **Entry (when not holding):**
  - **When:** remaining time ratio > `entry_time_ratio` **and** UP price ratio is inside `entry_price_ratio` [min, max].
  - **Action:** Buy the **cheaper** side: if UP bid > DOWN bid → buy DOWN, else buy UP.
- **Exit:**
  - **When:** UP price ratio falls inside one of the `exit_price_ratio_range` intervals (e.g. [0, 0.01] or [1.0, 1.0]).
  - **Action:** Sell the held token (UP or DOWN). If sell succeeds and UP price ratio is inside `emergency_swap_price`, the bot then buys the **opposite** token (emergency swap).
- **Use case:** Enter late in the market when price is in a range, take profit or cut loss in exit bands, and flip to the other side in extreme moves if desired.

**Summary table**

| Strategy   | Main goal              | Entry              | Exit / other                    |
|-----------|-------------------------|--------------------|---------------------------------|
| `trade_1` | Exit existing position  | (none in bot)      | Time or price threshold         |
| `trade_2` | Enter + exit + swap     | Time + price range | Exit bands + optional swap      |

---

## Setup (step by step)

### 1. Clone and install

**Windows (PowerShell):**
```powershell
git clone https://github.com/dev-protocol/polymarket-trading-bot
cd polymarket-arbitrage-bot
npm install
```

**Linux / macOS:**
```bash
git clone https://github.com/dev-protocol/polymarket-trading-bot
cd polymarket-arbitrage-bot
npm install
```

### 2. Environment variables

Create a `.env` file in the project root (see `.env.example`). **Do not commit this file.**

| Variable                  | Description                                                                 |
|---------------------------|-----------------------------------------------------------------------------|
| `POLYMARKET_PRIVATE_KEY`  | EOA private key that signs transactions for your Polymarket proxy wallet.  |
| `PROXY_WALLET_ADDRESS`    | Polymarket proxy wallet address (holds funds on the CLOB).                 |

### 3. Configuration

Edit **`trade.toml`** in the project root.

- **`strategy`** — `"trade_1"` or `"trade_2"`.
- **`trade_usd`** — Size in USD per trade (e.g. `5`).
- **`max_retries`** — Retries for operations (e.g. `3`).
- **`[market]`**
  - `market_coin` — `"btc"`, `"eth"`, `"sol"`, or `"xrp"`.
  - `market_period` — `"15"`, `"60"`, `"240"`, or `"1440"` (minutes).
- **`[trade_1]`** — Used when `strategy = "trade_1"`: `exit_time_ratio`, `exit_price_ratio`, etc.
- **`[trade_2]`** — Used when `strategy = "trade_2"`: `entry_price_ratio`, `entry_time_ratio`, `exit_price_ratio_range`, `emergency_swap_price`, etc.

Example for trading the 60-minute BTC market with strategy 2:

```toml
strategy = "trade_2"
trade_usd = 5
max_retries = 3

[market]
market_coin = "btc"
market_period = "60"

[trade_2]
entry_price_ratio = [0.4, 0.95]
entry_time_ratio = 0.6
exit_price_ratio_range = [[0.0, 0.01], [1.0, 1.0]]
emergency_swap_price = [0.0, 0.5]
```

---

## Running the bot

| Command        | Description                    |
|----------------|--------------------------------|
| `npm run dev`  | Run the bot: `tsx src/index.ts` |
| `npm run build`| Compile TypeScript: `tsc`      |
| `npm start`    | Run compiled: `node dist/index.js` |

**Typical usage:** After setup, run:

```bash
npm run dev
```

The bot will:

1. Load `trade.toml` and `.env`.
2. Connect to Polymarket and derive/create an API key.
3. Resolve the market slug from `market_coin` + `market_period`.
4. Fetch the market (UP/DOWN token IDs) and start polling prices every second.
5. Call the decision logic for the selected strategy and place/cancel orders as configured.

When the market expires, it will look for the next matching market and continue.

---

## Configuration reference

- **Global:** `strategy`, `trade_usd`, `max_retries`.
- **`[market]`:** `market_coin` (btc | eth | sol | xrp), `market_period` (15 | 60 | 240 | 1440).
- **`[trade_1]`:** `exit_time_ratio`, `exit_price_ratio`, `entry_price_range`, `swap_price_range`, `take_profit`, `stop_loss`.
- **`[trade_2]`:** `entry_price_ratio` [min, max], `entry_time_ratio`, `exit_price_ratio_range` (list of [min, max]), `emergency_swap_price` [min, max] (optional).

---

## Project layout

| Path              | Purpose                                                                 |
|-------------------|-------------------------------------------------------------------------|
| `src/index.ts`    | Entry: load config, create CLOB client, resolve market, main loop.     |
| `src/config/`     | Env, TOML config, market/slug helpers.                                 |
| `src/services/`   | CLOB client, Gamma API, WebSockets.                                    |
| `src/trade/`      | `Trade` class: decision logic, prices, buy/sell UP/DOWN.                |
| `trade.toml`      | Strategy and market configuration.                                     |

---

## Disclaimer

This bot is for **education and experimentation**. Trading on Polymarket involves financial risk. Only use funds you can afford to lose and ensure you comply with Polymarket’s terms and applicable laws.
