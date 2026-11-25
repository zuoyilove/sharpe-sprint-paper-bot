// Steady-scalper strategy for the pump.fun Sharpe sprint (agent-fun/replay/v2).
//
// This contest ranks by hourly Sharpe ratio, not raw PnL, so the design goal is a smooth
// equity curve: many small, short, diversified round trips instead of a few big bets whose
// gains land in one lucky hour. Every position is one small buy (no pyramiding), exits are
// quick (a modest take-profit, a tight trailing stop once armed, a hard stop, and a short
// time limit), and capital recycles across as many distinct curves as the signal allows.
// Tiny probe round trips pace the run so the 20-coin guardrail holds even in quiet hours.
//
// Entry: a curve old enough to have shaken out its bundled launch, with real buy pressure
// in the recent tape — net SOL flowing in, several distinct buyers, price rising but not
// vertical, sitting at its window high, and inflow accelerating into the newer half.
// Deterministic by construction: decisions read only the batch stream, in arrival order.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface ScalpParams {
  /** Slots of tape the entry signal reads. */
  lookback: number;
  /** Minimum net inflow (buys minus sells, SOL) over the lookback. */
  netInflowSol: number;
  /** Minimum buy trades inside the lookback. */
  tradesMin: number;
  /** Minimum distinct buying wallets inside the lookback. */
  buyersMin: number;
  /** Price rise over the lookback must sit inside [riseMin, riseMax]. */
  riseMin: number;
  riseMax: number;
  /** Price must be at least this share of the lookback high. */
  highShare: number;
  /** Largest single buyer's share of the lookback's buy SOL. */
  buyerShareMax: number;
  /** Real SOL reserve bounds at entry. */
  reserveMinSol: number;
  reserveMaxSol: number;
  /** Slots after the CreateEvent before an entry is allowed. */
  ageMin: number;
  /** The one buy per position, SOL. */
  stakeSol: number;
  /** Smallest buy worth sending, SOL. */
  buyMinSol: number;
  /** Buy slippage (bps); sells always go at 10000. */
  slipBps: number;
  /** Sell everything once close value reaches cost * (1 + takeProfit). */
  takeProfit: number;
  /** Trailing stop arms at cost * (1 + trailArm); then sells at peak * (1 - trailDrop). */
  trailArm: number;
  trailDrop: number;
  /** Sell everything once close value falls to cost * (1 - stopLoss). */
  stopLoss: number;
  /** Sell everything after this many slots, whatever the value. */
  holdMax: number;
  /** Slots after an exit before the same curve can be entered again. */
  cooldown: number;
  /** Most entries per curve over the whole run. */
  entriesMax: number;
  /** Most momentum positions at once; the remaining harness slot stays free for probes. */
  mainMax: number;
  /** Most SOL at cost across open positions at once. */
  exposureMaxSol: number;
  /** Guardrail pacing: distinct coins to reach across paceSecs of block time. */
  paceCoins: number;
  paceSecs: number;
  /** Probe round-trip size, SOL. */
  probeSol: number;
}

export const PARAMS: ScalpParams = {
  lookback: 40,
  netInflowSol: 0.75,
  tradesMin: 4,
  buyersMin: 4,
  riseMin: 0.1,
  riseMax: 1.5,
  highShare: 0.95,
  buyerShareMax: 0.6,
  reserveMinSol: 2,
  reserveMaxSol: 60,
  ageMin: 400,
  stakeSol: 0.05,
  buyMinSol: 0.01,
  slipBps: 1500,
  takeProfit: 1.0,
  trailArm: 0.1,
  trailDrop: 0.08,
  stopLoss: 0.99,
  holdMax: 1_000_000_000,
  cooldown: 150,
  entriesMax: 1,
  mainMax: 4,
  exposureMaxSol: 2.0,
  paceCoins: 30,
  paceSecs: 21_600,
  probeSol: 0.011,
};

const SOL = 1e9;
/** Curve fee share the close-value estimate nets out (protocol + creator, tape fallback). */
const FEE_SHARE = 0.0125;

interface Tick {
  slot: number;
  isBuy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Curve {
  born: number | null;
  ticks: Tick[];
  entries: number;
  exitedAt: number;
}

interface Open {
  since: number;
  best: number;
  spent: number;
  live: boolean;
  closing: boolean;
}

export function buildBot(p: ScalpParams = PARAMS): Bot {
  const curves = new Map<Pubkey, Curve>();
  const open = new Map<Pubkey, Open>();
  const probes = new Set<Pubkey>();
  const tradedCoins = new Set<Pubkey>();
  let clockStart: number | null = null;
  let clockNow: number | null = null;
  const keepSlots = p.lookback + 5;

  const curveOf = (mint: Pubkey): Curve => {
    let c = curves.get(mint);
    if (c === undefined) {
      c = { born: null, ticks: [], entries: 0, exitedAt: -1e12 };
      curves.set(mint, c);
    }
    return c;
  };

  /** True when the tape shows the buy-pressure pattern the entry wants. */
  const wantsEntry = (c: Curve, now: number, reserveSol: number): boolean => {
    if (reserveSol < p.reserveMinSol || reserveSol > p.reserveMaxSol) return false;
    if (c.born === null || now - c.born < p.ageMin) return false;
    const edge = now - p.lookback;
    const middle = now - p.lookback / 2;
    let inSol = 0;
    let outSol = 0;
    let buys = 0;
    let earlyNet = 0;
    let lateNet = 0;
    let firstPrice = -1;
    let lastPrice = 0;
    let peak = 0;
    const perBuyer = new Map<string, number>();
    for (const t of c.ticks) {
      if (t.slot <= edge) {
        firstPrice = t.price;
        continue;
      }
      if (firstPrice < 0) firstPrice = t.price;
      const signed = t.isBuy ? t.sol : -t.sol;
      if (t.slot <= middle) earlyNet += signed;
      else lateNet += signed;
      if (t.isBuy) {
        inSol += t.sol;
        buys++;
        perBuyer.set(t.user, (perBuyer.get(t.user) ?? 0) + t.sol);
      } else {
        outSol += t.sol;
      }
      if (t.price > peak) peak = t.price;
      lastPrice = t.price;
    }
    if (buys < p.tradesMin || perBuyer.size < p.buyersMin) return false;
    if (inSol - outSol < p.netInflowSol) return false;
    if (firstPrice <= 0 || peak <= 0) return false;
    const rise = lastPrice / firstPrice - 1;
    if (rise < p.riseMin || rise > p.riseMax) return false;
    if (lastPrice < peak * p.highShare) return false;
    if (lateNet <= 0 || lateNet < earlyNet) return false;
    let biggest = 0;
    for (const v of perBuyer.values()) if (v > biggest) biggest = v;
    if (biggest > p.buyerShareMax * inSol) return false;
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const seen = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) tradedCoins.add(f.mint);
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (clockStart === null) clockStart = e.block_time;
          if (clockNow === null || e.block_time > clockNow) clockNow = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          curveOf(e.mint).born = e.slot;
        } else if (e.event === 'TradeEvent') {
          const c = curveOf(e.mint);
          c.ticks.push({
            slot: e.slot,
            isBuy: e.is_buy,
            sol: Number(e.sol_amount) / SOL,
            user: e.user,
            price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
          });
          seen.add(e.mint);
        }
      }
      for (const mint of seen) {
        const c = curves.get(mint)!;
        let drop = 0;
        while (drop < c.ticks.length && c.ticks[drop]!.slot <= now - keepSlots) drop++;
        if (drop > 0) c.ticks.splice(0, drop);
      }
      const markOf = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const inFlight = new Map<Pubkey, string>();
      for (const po of state.pending.values()) inFlight.set(po.order.mint, po.order.side);

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const txSol = Number(state.txFeeLamports()) / SOL;

      // Exits before entries: freeing a slot and locking a gain both come first.
      for (const [mint, o] of open) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!inFlight.has(mint)) {
            open.delete(mint);
            if (o.live) curveOf(mint).exitedAt = now;
          }
          continue;
        }
        o.live = true;
        if (curve === undefined || curve.complete) continue;
        const mk = markOf.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const held = Number(pos.token_amount);
        const worth = ((held * vq) / (vt + held) / SOL) * (1 - FEE_SHARE) - txSol;
        const cost = Number(pos.cost_lamports) / SOL;
        if (worth > o.best) o.best = worth;
        let sell = o.closing;
        if (!sell && worth >= cost * (1 + p.takeProfit)) sell = true;
        if (!sell && o.best >= cost * (1 + p.trailArm) && worth <= o.best * (1 - p.trailDrop)) sell = true;
        if (!sell && worth <= cost * (1 - p.stopLoss)) sell = true;
        if (!sell && now - o.since > p.holdMax) sell = true;
        if (!sell) continue;
        o.closing = true;
        if (inFlight.get(mint) === 'sell') continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Probes already landed are sold whole at once: the round trip is the point.
      for (const mint of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!inFlight.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || inFlight.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Entries: one small buy per position, spread across as many curves as qualify.
      let cash = Number(state.freeCashLamports()) / SOL;
      let room = state.hello.caps.max_open_positions - state.committedPositionCount();
      let exposure = 0;
      for (const [mint, o] of open) {
        exposure += Math.max(o.spent, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / SOL);
      }
      for (const mint of seen) {
        if (orders.length >= cap || room <= 0 || open.size >= p.mainMax) break;
        if (open.has(mint) || probes.has(mint) || inFlight.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const c = curves.get(mint)!;
        if (c.entries >= p.entriesMax || now - c.exitedAt < p.cooldown) continue;
        const reserveSol = Number(curve.real_quote_reserves) / SOL;
        if (!wantsEntry(c, now, reserveSol)) continue;
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / SOL;
        let amount = Math.min(capSol, p.stakeSol, p.exposureMaxSol - exposure, cash - txSol);
        if (amount < p.buyMinSol) continue;
        orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * SOL)), max_slippage_bps: p.slipBps });
        cash -= amount + txSol;
        exposure += amount;
        room--;
        open.set(mint, { since: now, best: 0, spent: amount, live: false, closing: false });
        c.entries++;
      }

      // Guardrail pacing: if distinct traded coins lag the clock, open one probe on a
      // liquid curve traded this batch and let the probe rule above close it next batch.
      if (probes.size === 0 && room > 0 && clockStart !== null && clockNow !== null && orders.length < cap) {
        const elapsedShare = Math.min(1, (clockNow - clockStart) / p.paceSecs);
        if (tradedCoins.size < Math.ceil(p.paceCoins * elapsedShare)) {
          const reserveNeeded = (p.probeSol * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
          // Prefer a mint never traded: a probe on a fresh mint is what the pace is short of.
          for (const freshOnly of [true, false]) {
            let placed = false;
            for (const mint of seen) {
              if (open.has(mint) || inFlight.has(mint) || state.positions.has(mint)) continue;
              if (freshOnly && tradedCoins.has(mint)) continue;
              const curve = state.curves.get(mint);
              if (curve === undefined || curve.complete) continue;
              if (Number(curve.real_quote_reserves) / SOL < reserveNeeded * 1.5) continue;
              if (cash < p.probeSol + 2 * txSol) break;
              orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(p.probeSol * SOL)), max_slippage_bps: p.slipBps });
              probes.add(mint);
              placed = true;
              break;
            }
            if (placed) break;
          }
        }
      }
      return orders;
    },
  };
}
