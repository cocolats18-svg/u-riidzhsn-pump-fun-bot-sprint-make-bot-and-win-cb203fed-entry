// Pullback Bounce — a mean-reversion bot for the pump.fun replay.
//
// Idea: pump.fun coins spike hard on fresh attention and then retrace. Most
// of them never come back, so chasing the spike loses — the dev window proved
// it twice: buying breakouts lost 0.93 SOL and buying young risers lost 0.46
// SOL, both far worse than buying the dip. What the dip version does better
// is that it buys low: after a sharp fall the coin has already shed the
// weak hands, and when buyers step back in the bounce from a lower base
// only needs a partial recovery to pay. So this bot buys exactly that shape
// — a deep, fresh pullback with the turn already under way — and exits on a
// fixed take-profit, a hard stop-loss, a trailing stop once a bounce is
// underway, or a time limit that frees the slot for the next coin.
//
// Nothing here reads the clock, the environment or Math.random: every decision
// comes from the replay state the harness hands over, so two runs of the same
// window produce byte-identical orders. Prices are ratios of the virtual
// reserves (quote per token), which is the bonding curve's own price.
//
// Entry (buy 0.05 SOL, one stake per coin, at most 5 open at once):
//   - the coin has traded at least MIN_TRADES times, so a "high" means something;
//   - its price is at least DIP_BPS below the highest price in its last
//     WINDOW trades, and that high is fresh (HIGH_MAX_AGE trades ago at most)
//     — an old peak means a long bleed, not a live dip;
//   - the price has already reclaimed RECLAIM_BPS off its window low, so the
//     turn is under way instead of a falling knife;
//   - the most recent trade on it is a buy, and at least 2 of its last 5
//     trades are buys — buyers are returning, not just one stray print;
//   - the per-reply size cap still allows a meaningful buy (>= 0.01 SOL).
//
// Exit (sell the whole position):
//   - take profit at +TP_BPS over the entry price;
//   - stop loss at -SL_BPS under the entry price;
//   - trailing stop: once the price has risen ARM_BPS over entry, sell if it
//     falls TRAIL_BPS below the best price seen since entry;
//   - time exit: held longer than MAX_HOLD_SLOTS, free the slot;
//   - stale exit: no trade on the coin for STALE_SLOTS and price below entry.
//
// The replay closes positions itself when a curve completes or the data ends,
// so those paths need no code here.

import { LAMPORTS_PER_SOL, runBot, type BuyInput, type SellInput } from './vendor/makefun-bot.ts';

// ---------------------------------------------------------------- tuning

/** SOL risked on each new position. */
const STAKE_LAMPORTS = LAMPORTS_PER_SOL / 20n; // 0.05 SOL
/** Smallest buy worth sending (the guardrail needs round trips >= 0.01 SOL). */
const MIN_BUY_LAMPORTS = LAMPORTS_PER_SOL / 100n; // 0.01 SOL
/** Slippage room for fills two slots after the decision. */
const MAX_SLIPPAGE_BPS = 2000;

/** Trades remembered per coin for the trailing high and the flow check. */
const WINDOW = 48;
/** A coin needs this many trades before it can be bought. */
const MIN_TRADES = 10;
/** Buy only when price is this far (bps) under its trailing WINDOW-trade high. */
const DIP_BPS = 3000; // -30%
/** Of the last FLOW_TRADES trades, at least this many must be buys. */
const FLOW_TRADES = 5;
const FLOW_MIN_BUYS = 3;

/** Take profit, bps over the entry price. */
const TP_BPS = 1200; // +12%
/** Stop loss, bps under the entry price. */
const SL_BPS = 1200; // -12%
/** Arm the trailing stop once price is this far (bps) over entry. */
const ARM_BPS = 1000; // +10%
/** Trailing stop: sell this far (bps) under the best price since entry. */
const TRAIL_BPS = 800; // -8% from the peak
/** Give up on a position after this many slots (~55 min at 0.4 s/slot). */
const MAX_HOLD_SLOTS = 12000;
/** Give up on a dead coin after this many slots with no trade, if underwater. */
const STALE_SLOTS = 8000;
/** The trailing high must be this fresh (trades ago) for the dip to be live. */
const HIGH_MAX_AGE = 15;
/** Buy only once price has reclaimed this far (bps) off its window low. */
const RECLAIM_BPS = 500; // +5% off the low

// ---------------------------------------------------------------- per-coin tape

/** Everything the bot remembers about one coin's recent trading. */
class Tape {
  /** Last WINDOW trade prices (quote per token), oldest first. */
  prices: number[] = [];
  /** Buy/sell flags for the last FLOW_TRADES trades, oldest first. */
  flow: boolean[] = [];
  /** Trades seen in total. */
  trades = 0;
  /** Slot of the most recent trade. */
  lastTradeSlot = -1;
  /** Highest price in `prices`. */
  high = 0;
  /** Index of the high inside `prices` (-1 when empty). */
  highIdx = -1;
  /** Lowest price in `prices`. */
  low = Number.POSITIVE_INFINITY;
  /** Index of the low inside `prices` (-1 when empty). */
  lowIdx = -1;

  /** Fold one trade's post-trade price into the tape. */
  add(price: number, isBuy: boolean, slot: number): void {
    this.trades += 1;
    this.lastTradeSlot = slot;
    this.prices.push(price);
    if (this.prices.length > WINDOW) {
      this.prices.shift();
      this.highIdx -= 1;
      this.lowIdx -= 1;
    }
    this.flow.push(isBuy);
    if (this.flow.length > FLOW_TRADES) this.flow.shift();
    const at = this.prices.length - 1;
    if (price > this.high) {
      this.high = price;
      this.highIdx = at;
    }
    if (price < this.low) {
      this.low = price;
      this.lowIdx = at;
    }
    // The window slid past the old high or low: rescan what is left.
    if (this.highIdx < 0) {
      let h = 0;
      let hi = -1;
      for (let i = 0; i < this.prices.length; i++) {
        if (this.prices[i] > h) {
          h = this.prices[i];
          hi = i;
        }
      }
      this.high = h;
      this.highIdx = hi;
    }
    if (this.lowIdx < 0) {
      let l = Number.POSITIVE_INFINITY;
      let li = -1;
      for (let i = 0; i < this.prices.length; i++) {
        if (this.prices[i] < l) {
          l = this.prices[i];
          li = i;
        }
      }
      this.low = l;
      this.lowIdx = li;
    }
  }

  /** Trades since the trailing high was printed. */
  get highAge(): number {
    if (this.highIdx < 0) return Number.POSITIVE_INFINITY;
    return this.prices.length - 1 - this.highIdx;
  }

  /** How far (bps) the price sits under its trailing high. 0 when no high yet. */
  dipBps(): number {
    if (this.high <= 0 || this.price <= 0) return 0;
    return Math.floor(((this.high - this.price) / this.high) * 10000);
  }

  /** How far (bps) the price has reclaimed off its window low. */
  reclaimBps(): number {
    if (this.low <= 0 || this.low === Number.POSITIVE_INFINITY || this.price <= 0) return 0;
    return Math.floor(((this.price - this.low) / this.low) * 10000);
  }

  /** Price now, from the tape's latest print. */
  get price(): number {
    return this.prices.length === 0 ? 0 : this.prices[this.prices.length - 1];
  }

  /** Buys among the last FLOW_TRADES trades. */
  get recentBuys(): number {
    let n = 0;
    for (const b of this.flow) if (b) n += 1;
    return n;
  }

  /** The last trade was a buy. */
  get lastIsBuy(): boolean {
    return this.flow.length > 0 && this.flow[this.flow.length - 1];
  }
}

/** One open position's entry bookkeeping. */
interface Held {
  entryPrice: number;
  entrySlot: number;
  peakSinceEntry: number;
}

const tapes = new Map<string, Tape>();
const held = new Map<string, Held>();

/** Bonding-curve price: virtual quote reserves per virtual token reserve. */
function curvePrice(virtualQuote: bigint, virtualToken: bigint): number {
  if (virtualToken <= 0n) return 0;
  return Number(virtualQuote) / Number(virtualToken);
}

/** Fold this batch's trade events into the tapes, in chain order. */
function observe(batch: { events: readonly { event: string; mint: string }[] }): void {
  for (const e of batch.events) {
    if (e.event !== 'TradeEvent') continue;
    const t = e as unknown as {
      mint: string;
      is_buy: boolean;
      slot: number;
      virtual_quote_reserves: string;
      virtual_token_reserves: string;
    };
    let tape = tapes.get(t.mint);
    if (tape === undefined) {
      tape = new Tape();
      tapes.set(t.mint, tape);
    }
    tape.add(
      curvePrice(BigInt(t.virtual_quote_reserves), BigInt(t.virtual_token_reserves)),
      t.is_buy,
      t.slot,
    );
  }
}

/** Decide whether a coin is a fresh pullback with buyers returning. */
function isPullbackBuy(tape: Tape): boolean {
  if (tape.trades < MIN_TRADES) return false;
  if (tape.dipBps() < DIP_BPS) return false;
  // The high must be recent: an old peak means a long bleed, not a live dip.
  if (tape.highAge > HIGH_MAX_AGE) return false;
  // Do not catch the falling knife: buy only after the price has already
  // turned back up off its window low.
  if (tape.reclaimBps() < RECLAIM_BPS) return false;
  if (!tape.lastIsBuy) return false;
  if (tape.recentBuys < FLOW_MIN_BUYS) return false;
  return true;
}

// ---------------------------------------------------------------- exits

/**
 * Why a held position should be sold now, or null to keep holding. `price` is
 * the coin's latest price, `slot` the current slot. The peak since entry is
 * tracked in `held` and updated here as a side effect.
 */
function exitReason(mint: string, h: Held, price: number, slot: number, tape: Tape | undefined): string | null {
  if (price <= 0) return null;
  if (price > h.peakSinceEntry) h.peakSinceEntry = price;
  const entry = h.entryPrice;
  // Take profit.
  if (price >= (entry * (10000 + TP_BPS)) / 10000) return 'take-profit';
  // Hard stop.
  if (price <= (entry * (10000 - SL_BPS)) / 10000) return 'stop-loss';
  // Trailing stop, armed only after a real bounce.
  if (h.peakSinceEntry >= (entry * (10000 + ARM_BPS)) / 10000) {
    if (price <= (h.peakSinceEntry * (10000 - TRAIL_BPS)) / 10000) return 'trailing-stop';
  }
  // Time exit: free the slot for a fresher coin.
  if (slot - h.entrySlot >= MAX_HOLD_SLOTS) return 'time-exit';
  // Stale exit: the coin stopped trading and we are underwater.
  if (tape !== undefined && price < entry && slot - tape.lastTradeSlot >= STALE_SLOTS) return 'stale-exit';
  return null;
}

// ---------------------------------------------------------------- the bot

await runBot({
  onHello() {
    // No warm-up needed: tapes fill from the batches as they arrive.
  },

  onBatch(state, batch) {
    // The batch's events arrive in chain order; fold the trades in first so
    // every decision below uses this slot's prices.
    observe(batch);

    // Reconcile entry bookkeeping with the fills that just resolved: a buy
    // that was rejected or failed leaves no position, so drop its entry;
    // a filled buy keeps it. Until its fill arrives a buy is in flight and
    // its entry must survive the cleanup below.
    for (const f of batch.fills) {
      if (f.side === 'buy' && f.status !== 'filled') held.delete(f.mint);
    }
    const hasPendingBuy = (mint: string): boolean => {
      for (const p of state.pending.values()) {
        if (p.order.side === 'buy' && p.order.mint === mint) return true;
      }
      return false;
    };

    const orders: (BuyInput | SellInput)[] = [];
    const { caps } = state.hello;
    const tx = state.txFeeLamports();
    let free = state.freeCashLamports();
    let slots = caps.max_open_positions - state.committedPositionCount();

    // --- exits first: selling frees a slot a buy in this same batch can use.
    // Positions the harness already flattened (complete / end of data) are
    // gone from state.positions, so their bookkeeping is dropped here too.
    for (const mint of [...held.keys()]) {
      if (!state.positions.has(mint) && !hasPendingBuy(mint)) {
        held.delete(mint);
      }
    }
    for (const [mint, pos] of state.positions) {
      const h = held.get(mint);
      if (h === undefined) continue; // Should not happen; never sell blind.
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const price = curvePrice(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      const why = exitReason(mint, h, price, batch.slot, tapes.get(mint));
      if (why === null) continue;
      if (orders.length >= caps.max_orders_per_batch) break;
      orders.push({
        side: 'sell',
        mint,
        token_amount: pos.token_amount,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      });
      held.delete(mint);
      slots += 1; // The slot frees once this sell fills; count it now so a
      // buy below does not over-commit the position cap.
      void why;
    }

    // --- entries: one stake per coin, in the batch's event order.
    for (const e of batch.events) {
      if (orders.length >= caps.max_orders_per_batch) break;
      if (slots <= 0) break;
      if (e.event !== 'TradeEvent' && e.event !== 'CreateEvent') continue;
      const mint = e.mint;
      if (state.positions.has(mint) || held.has(mint)) continue;
      if (hasPendingBuy(mint)) continue; // A buy is already in flight.
      const tape = tapes.get(mint);
      if (tape === undefined || !isPullbackBuy(tape)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const cap = state.maxBuyLamports(mint);
      if (cap < MIN_BUY_LAMPORTS) continue;
      const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
      if (free < amount + tx) continue;
      orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: MAX_SLIPPAGE_BPS });
      // Book the entry now: the fill lands two slots later, and the exit
      // logic needs the entry price from the decision-time curve.
      const price = curvePrice(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      held.set(mint, { entryPrice: price, entrySlot: batch.slot, peakSinceEntry: price });
      free -= amount + tx;
      slots -= 1;
    }
    return orders;
  },

  onDone(state) {
    const cash = Number(state.cash) / Number(LAMPORTS_PER_SOL);
    console.error(`pullback-bounce done: cash ${cash.toFixed(4)} SOL, positions ${state.positions.size}`);
  },
});
