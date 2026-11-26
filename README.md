# Calm-Scalper — Pump.fun Sharpe Sprint

[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/mochhidayah/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/mochhidayah/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A paper-trading bot for the 6-hour pump.fun replay. Ranking is by hourly
Sharpe ratio, not PnL — so this bot optimises for steady, controlled gains:
many small dip-buys in established coins, quick take-profits, no hard
stop-loss (established-coin dips recover more often than they rug), and a
hard time cap so dead money never sits.

## Strategy (strategy.ts)

- **Entry — buy the dip, only in established coins:** a coin qualifies when
  it holds ≥ 2 SOL of real reserves, saw ≥ 8 trades from ≥ 4 distinct
  buyers in the last 1,200 slots, its price fell 2–15% over that window
  while buy SOL stayed ≥ 1.2× sell SOL, and the price sits within 5% of
  the window low. One fixed 0.05 SOL probe per coin, one entry per mint,
  max 5 open positions.
- **Exit:** take-profit +8% of cost, trailing exit once +3% (give back 3%
  off the peak), or a 20,000-slot (~2.2 h) time cap. No hard stop-loss.
- **Determinism:** every decision is a pure function of the events the
  harness delivered — no clock, no randomness, no network — so the
  grader's two executions produce byte-identical action logs.

## Files

- `main.ts` — entrypoint: wires the strategy into the replay shim.
- `strategy.ts` — the calm-scalper logic.
- `vendor/makefun-bot.ts` — the kit's replay-v2 SDK shim, vendored.

## Local dev replay (kit grade-local, process driver)

Dev window (24 h, 128,058 events): **net PnL −0.031 SOL, 79 round trips
over 79 coins, win rate 41.8%, max drawdown 1.05%**, guardrails met
(79 ≥ 20 distinct mints). For comparison on the same window: pilot
momentum −9.44 SOL, pilot reversion −3.99 SOL, pilot sniper −0.50 SOL.
Action log reproduced byte for byte across the two executions.

## Run

The grader runs `node /bot/main.ts` (Node 22+ strips the types).
