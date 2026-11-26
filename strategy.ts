// calm-scalper: a Sharpe-first paper scalper for the pump.fun replay.
//
// Idea: Sharpe rewards many small, steady wins and punishes variance, so
// this bot never chases a moonshot. It takes one small, fixed-size probe
// per coin (0.03 SOL), only into coins that already show calm, buy-led
// momentum, and it exits fast on a tight take-profit, a tighter stop, a
// small trailing give-back, or a hard time cap. One entry per mint keeps
// the round-trip count honest and the book diversified.
//
// Everything here is deterministic: every decision is a pure function of
// the events the harness has already delivered (slot numbers, reserve
// ratios, trade flow). No clock, no randomness, no network.

import type { Batch, BotState, OrderInput, Pubkey } from "./vendor/makefun-bot.ts";

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125; // protocol 0.95% + creator 0.30%

// ---- tuning (all in plain units; see README for the reasoning) ----
const STAKE_SOL = 0.05; // fixed probe size per coin
const MIN_CAP_SOL = 0.02; // skip a coin whose 1%-of-reserve cap is below this
const MIN_REAL_SOL = 2; // established-ish coins: at least 2 SOL behind them
const WINDOW_SLOTS = 1200; // trailing lookback, ~8 minutes of slots
const MIN_TRADES = 8; // trades seen in the window before we trust a coin
const MIN_BUYERS = 4; // distinct buyers in the window
const MIN_RISE = -0.15; // buy the dip: price fell 2-15% over the window
const MAX_RISE = -0.02; // ...never buy strength, only weakness with flow back
const MIN_BUY_DOMINANCE = 1.2; // buy SOL must be >= 1.2x sell SOL in window
const NEAR_HIGH = 0.9; // unused for dip entries; kept for the near-low check below
const TAKE_PROFIT = 1.08; // exit at +8% of cost
const STOP_LOSS = 0.5; // no hard stop: established-coin dips recover more often than they rug
const TRAIL_ARM = 1.03; // trailing exit arms once value is +3%
const TRAIL_GIVEBACK = 0.97; // ...then exit if value falls 3% off its peak
const MAX_HOLD_SLOTS = 20000; // hard time cap, ~2.2 hours of slots

interface TapeTick {
  slot: number;
  price: number; // virtual_quote_reserves / virtual_token_reserves
  buy: boolean;
  sol: number; // SOL size of this trade
  user: string;
}

interface Tape {
  ticks: TapeTick[];
  complete: boolean;
  everBought: boolean;
}

interface HeldInfo {
  entrySlot: number;
  peakValue: number; // lamports, best marked value seen so far
}

function priceOf(vq: bigint, vt: bigint): number {
  if (vt === 0n) return 0;
  return Number(vq) / Number(vt);
}

/** Mark-to-market value of `tokens` on a curve, net of curve fee and one tx fee. */
function markedValue(tokens: bigint, vq: bigint, vt: bigint, txFee: bigint): number {
  const t = Number(tokens);
  if (t <= 0 || vt === 0n) return 0;
  const gross = ((t * Number(vq)) / (Number(vt) + t) / LAMPORTS) * (1 - CURVE_FEE);
  return gross * LAMPORTS - Number(txFee);
}

export class CalmScalper {
  private tapes = new Map<Pubkey, Tape>();
  private held = new Map<Pubkey, HeldInfo>();

  private tapeOf(mint: Pubkey): Tape {
    let t = this.tapes.get(mint);
    if (t === undefined) {
      t = { ticks: [], complete: false, everBought: false };
      this.tapes.set(mint, t);
    }
    return t;
  }

  /** Fold one batch of events into the tapes, then decide this batch's orders. */
  decide(state: BotState, batch: Batch): OrderInput[] {
    const now = batch.slot;
    const txFee = state.txFeeLamports();
    const orders: OrderInput[] = [];

    for (const e of batch.events) {
      if (e.event === "CreateEvent") {
        this.tapeOf(e.mint);
      } else if (e.event === "TradeEvent") {
        const t = this.tapeOf(e.mint);
        t.ticks.push({
          slot: e.slot,
          price: priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves)),
          buy: e.is_buy,
          sol: Number(e.sol_amount) / LAMPORTS,
          user: e.user,
        });
        if (t.ticks.length > 400) t.ticks.splice(0, t.ticks.length - 400);
      } else {
        this.tapeOf(e.mint).complete = true;
      }
    }

    // Drop tapes that are complete and unheld, and forget held info for
    // positions the account no longer carries (sold, completed, flattened).
    for (const [mint, info] of this.held) {
      if (!state.positions.has(mint)) this.held.delete(mint);
      void info;
    }

    // ---- exits first: free slots and cap losses before opening anything ----
    const pendingSell = new Set<Pubkey>();
    for (const p of state.pending.values()) {
      if (p.order.side === "sell") pendingSell.add(p.order.mint);
    }
    for (const [mint, pos] of state.positions) {
      if (pendingSell.has(mint)) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      let info = this.held.get(mint);
      if (info === undefined) {
        info = { entrySlot: now, peakValue: 0 };
        this.held.set(mint, info);
      }
      const value = markedValue(BigInt(pos.token_amount), curve.virtual_quote_reserves, curve.virtual_token_reserves, txFee);
      const cost = Number(pos.cost_lamports);
      if (cost <= 0) continue;
      if (value > info.peakValue) info.peakValue = value;
      const ratio = value / cost;
      const agedOut = now - info.entrySlot > MAX_HOLD_SLOTS;
      const trailing = info.peakValue >= cost * TRAIL_ARM && value <= info.peakValue * TRAIL_GIVEBACK;
      if (ratio >= TAKE_PROFIT || ratio <= STOP_LOSS || trailing || agedOut) {
        orders.push({ side: "sell", mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }
    }
    if (orders.length >= state.hello.caps.max_orders_per_batch) return orders;

    // ---- entries: calm, buy-led momentum only, one small probe per coin ----
    const pendingBuy = new Set<Pubkey>();
    for (const p of state.pending.values()) {
      if (p.order.side === "buy") pendingBuy.add(p.order.mint);
    }
    let free = state.freeCashLamports();
    let slots = state.hello.caps.max_open_positions - state.committedPositionCount();
    const stake = BigInt(Math.floor(STAKE_SOL * LAMPORTS));

    // Candidates are the mints that traded this batch; sorted by mint so the
    // choice among them never depends on arrival order.
    const candidates = [...new Set(batch.events.map((e) => e.mint))].sort();
    for (const mint of candidates) {
      if (orders.length >= state.hello.caps.max_orders_per_batch) break;
      if (slots <= 0) break;
      if (state.positions.has(mint) || pendingBuy.has(mint)) continue;
      const tape = this.tapes.get(mint);
      if (tape === undefined || tape.complete || tape.everBought) continue;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      const realSol = Number(curve.real_quote_reserves) / LAMPORTS;
      if (realSol < MIN_REAL_SOL) continue;

      const from = now - WINDOW_SLOTS;
      const windowTicks = tape.ticks.filter((tk) => tk.slot > from);
      if (windowTicks.length < MIN_TRADES) continue;
      const buyers = new Set<string>();
      let buySol = 0;
      let sellSol = 0;
      let high = 0;
      let low = Number.POSITIVE_INFINITY;
      for (const tk of windowTicks) {
        if (tk.buy) {
          buySol += tk.sol;
          buyers.add(tk.user);
        } else {
          sellSol += tk.sol;
        }
        if (tk.price > high) high = tk.price;
        if (tk.price < low) low = tk.price;
      }
      if (buyers.size < MIN_BUYERS) continue;
      if (buySol < MIN_BUY_DOMINANCE * Math.max(sellSol, 1e-9)) continue;
      const first = windowTicks[0]!.price;
      const last = windowTicks[windowTicks.length - 1]!.price;
      if (first <= 0 || last <= 0 || high <= 0) continue;
      const rise = last / first - 1;
      if (rise < MIN_RISE || rise > MAX_RISE) continue;
      if (last > 1.05 * low) continue; // dip entry: price must sit near the window low

      const cap = state.maxBuyLamports(mint);
      if (cap < BigInt(Math.floor(MIN_CAP_SOL * LAMPORTS))) continue;
      const amount = cap < stake ? cap : stake;
      if (free < amount + txFee) continue;
      orders.push({ side: "buy", mint, quote_lamports: amount, max_slippage_bps: 10_000 });
      tape.everBought = true;
      free -= amount + txFee;
      slots -= 1;
    }
    return orders;
  }
}
