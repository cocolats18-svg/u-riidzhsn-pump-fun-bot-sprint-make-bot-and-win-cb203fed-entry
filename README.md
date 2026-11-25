[![Pump.fun Bot Sprint](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/competitions/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![Rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/cocolats18-svg/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed-entry/rank.svg)](https://make.fun/competitions/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![Reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/cocolats18-svg/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed-entry/reward.svg)](https://make.fun/competitions/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

# Pullback Bounce — a pump.fun replay bot

A mean-reversion trading bot for the [Pump.fun Bot Sprint: Make Bot And Win](https://make.fun/competitions/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) competition. It trades paper SOL on a replay of pump.fun bonding-curve events (`agent-fun/replay/v2`), ranked on net PnL.

## Strategy

Pump.fun coins spike hard on fresh attention and then retrace. Chasing the spike loses — on the dev window, buying breakouts lost 0.93 SOL and buying young risers lost 0.46 SOL. Buying the dip does better: after a sharp fall the coin has already shed the weak hands, and when buyers step back in, the bounce from a lower base only needs a partial recovery to pay.

**Entry** — buy 0.05 SOL, one stake per coin, at most 5 open at once, when all of these hold:

- the coin has traded at least 10 times, so a "high" means something;
- its price is at least 30% below the highest price in its last 48 trades, and that high is fresh (no more than 15 trades ago) — an old peak means a long bleed, not a live dip;
- the price has already reclaimed 5% off its window low, so the turn is under way instead of a falling knife;
- the most recent trade is a buy, and at least 3 of its last 5 trades are buys — buyers are returning, not just one stray print;
- the per-reply size cap still allows a meaningful buy (≥ 0.01 SOL).

**Exit** — sell the whole position on the first of:

- take profit at +12% over the entry price;
- stop loss at −12% under the entry price;
- trailing stop: once the price has risen 10% over entry, sell if it falls 8% below the best price seen since entry;
- time exit after 12,000 slots (~80 min) to free the slot for a fresher coin;
- stale exit: no trade on the coin for 8,000 slots while underwater.

The replay closes positions itself when a curve completes or the data ends.

Prices are ratios of the virtual reserves (quote per token) — the bonding curve's own price. The bot is fully deterministic: it never reads the clock, the environment, or `Math.random`, so two runs of the same window produce byte-identical orders.

## Local dev-window grade

| Metric | Value |
|---|---|
| Net PnL | −0.0148 SOL (gross ≈ +0.016 SOL before fees) |
| Round trips | 29 over 29 coins |
| Win rate | 17% |
| Max drawdown | 1.3% |
| Guardrails | met (≥20 coins with ≥0.01 SOL round trips, drawdown ≤ 50%) |
| Determinism | two executions reproduced byte for byte |

The dev score sits just below holding cash: the gross edge is positive but the ~2.5% round-trip curve fees eat it. It is the best of five shapes tried locally (plain dip −0.33, dip + reclaim −0.10, tight dip −0.05, breakout −0.93, early rider −0.46 SOL).

## Layout

- `main.ts` — the bot (entrypoint, run by the grader as `node /bot/main.ts`)
- `vendor/makefun-bot.ts` — the kit's SDK shim, copied byte-identical (never modified)
- `LICENSE` — MIT

## Run it

Grade locally with the kit (process driver; no Docker needed):

```sh
node cli/makefun.mjs grade-local --kit <kit-dir> --bot . --driver process
```

---

*Built for make.fun — if you want to try the bounties yourself, sign up with my referral link: https://make.fun/r/8z4pvdk9 (referral code: `8z4pvdk9`).*
