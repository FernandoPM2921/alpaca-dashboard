/**
 * Alpaca Trading Dashboard — Backend API
 * Express server que conecta con Alpaca Markets API
 */

import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

dotenv.config();

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(join(__dirname, "../public")));

// ── Alpaca client helpers ─────────────────────────────────────
const BROKER_BASE = process.env.ALPACA_PAPER !== "false"
  ? "https://paper-api.alpaca.markets/v2"
  : "https://api.alpaca.markets/v2";

const DATA_BASE = "https://data.alpaca.markets/v2";

const headers = {
  "APCA-API-KEY-ID": process.env.ALPACA_API_KEY,
  "APCA-API-SECRET-KEY": process.env.ALPACA_SECRET_KEY,
};

async function broker(method, path, data = null, params = null) {
  const res = await axios({ method, url: `${BROKER_BASE}${path}`, headers, data, params });
  return res.data;
}

async function marketData(path, params = null) {
  const res = await axios({ method: "GET", url: `${DATA_BASE}${path}`, headers, params });
  return res.data;
}

// ── API Routes ────────────────────────────────────────────────

// Account
app.get("/api/account", async (req, res) => {
  try {
    const data = await broker("GET", "/account");
    res.json({
      equity: parseFloat(data.equity).toFixed(2),
      cash: parseFloat(data.cash).toFixed(2),
      buying_power: parseFloat(data.buying_power).toFixed(2),
      portfolio_value: parseFloat(data.portfolio_value).toFixed(2),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Positions
app.get("/api/positions", async (req, res) => {
  try {
    const positions = await broker("GET", "/positions");
    res.json(positions.map(p => ({
      symbol: p.symbol,
      qty: parseInt(p.qty),
      avg_entry_price: parseFloat(p.avg_entry_price).toFixed(2),
      current_price: parseFloat(p.current_price).toFixed(2),
      market_value: parseFloat(p.market_value).toFixed(2),
      unrealized_pl: parseFloat(p.unrealized_pl).toFixed(2),
      unrealized_plpc: (parseFloat(p.unrealized_plpc) * 100).toFixed(2),
      side: p.side,
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Close position
app.delete("/api/positions/:symbol", async (req, res) => {
  try {
    await broker("DELETE", `/positions/${req.params.symbol}`);
    res.json({ success: true, message: `Posición ${req.params.symbol} cerrada` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Close ALL positions
app.delete("/api/positions", async (req, res) => {
  try {
    await broker("DELETE", "/positions");
    res.json({ success: true, message: "Todas las posiciones cerradas" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Orders history
app.get("/api/orders", async (req, res) => {
  try {
    const orders = await broker("GET", "/orders", null, {
      status: req.query.status || "all",
      limit: req.query.limit || 50,
      direction: "desc",
    });
    res.json(orders.map(o => ({
      id: o.id,
      symbol: o.symbol,
      side: o.side,
      type: o.type,
      qty: o.qty,
      filled_qty: o.filled_qty,
      filled_avg_price: o.filled_avg_price ? parseFloat(o.filled_avg_price).toFixed(2) : null,
      status: o.status,
      submitted_at: o.submitted_at,
      filled_at: o.filled_at,
    })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cancel order
app.delete("/api/orders/:id", async (req, res) => {
  try {
    await broker("DELETE", `/orders/${req.params.id}`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Market clock
app.get("/api/clock", async (req, res) => {
  try {
    const clock = await broker("GET", "/clock");
    res.json(clock);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stock quote (precio actual)
app.get("/api/quote/:symbol", async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const data = await marketData(`/stocks/${symbol}/quotes/latest`);
    const q = data.quote;
    res.json({
      symbol,
      ask: q.ap,
      bid: q.bp,
      mid: ((q.ap + q.bp) / 2).toFixed(2),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stock bars + SMA14
app.get("/api/bars/:symbol", async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const now = new Date();
    const fiveDaysAgo = new Date(now);
    fiveDaysAgo.setDate(fiveDaysAgo.getDate() - 5);
    const startDate = fiveDaysAgo.toISOString().split("T")[0];

    const data = await marketData(`/stocks/${symbol}/bars`, {
      timeframe: req.query.timeframe || "5Min",
      start: startDate,
      feed: "iex",
      limit: 500,
    });

    const bars = data.bars || [];

    // Filtrar solo horario regular (9:30-15:55 ET)
    function isRegular(timestamp) {
      const date = new Date(timestamp);
      const utcMin = date.getUTCHours() * 60 + date.getUTCMinutes();
      const month = date.getUTCMonth();
      const inEDT = month >= 2 && month <= 10;
      const open  = inEDT ? 13 * 60 + 30 : 14 * 60 + 30;
      const close = inEDT ? 19 * 60 + 55 : 20 * 60 + 55;
      return utcMin >= open && utcMin <= close;
    }

    const regular = bars.filter(b => isRegular(b.t));

    // Calcular SMA14 para cada barra
    const period = parseInt(req.query.period) || 14;
    const result = regular.map((bar, i) => {
      const slice = regular.slice(Math.max(0, i - period + 1), i + 1);
      const sma = slice.length === period
        ? slice.reduce((s, b) => s + b.c, 0) / period
        : null;
      return {
        t: bar.t,
        o: bar.o,
        h: bar.h,
        l: bar.l,
        c: bar.c,
        v: bar.v,
        sma: sma ? parseFloat(sma.toFixed(2)) : null,
      };
    });

    // Solo devolver las últimas 50 barras para la gráfica
    res.json({ bars: result.slice(-50), symbol });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// P&L del día (calculado desde portfolio history)
app.get("/api/pnl", async (req, res) => {
  try {
    // Obtener historial de portfolio del día
    const history = await broker("GET", "/account/portfolio/history", null, {
      period: "1D",
      timeframe: "1H",
    });

    // P&L del día = diferencia entre equity actual y equity al inicio del día
    const equityValues = history.equity || [];
    const profitLoss = history.profit_loss || [];
    const profitLossPct = history.profit_loss_pct || [];

    const todayPnL = profitLoss.length > 0
      ? profitLoss[profitLoss.length - 1]
      : 0;

    // Obtener órdenes del día para contar wins/losses
    const today = new Date().toISOString().split("T")[0];
    const orders = await broker("GET", "/orders", null, {
      status: "filled",
      after: `${today}T00:00:00Z`,
      limit: 500,
    });

    // Calcular wins/losses desde órdenes de venta del día
    let wins = 0;
    let losses = 0;
    const sells = orders.filter(o => o.side === "sell" && o.filled_avg_price);

    // Para cada venta buscar la compra más reciente del mismo símbolo antes de esa venta
    sells.forEach(sell => {
      const sellTime = new Date(sell.filled_at);
      const matchBuys = orders.filter(o =>
        o.side === "buy" &&
        o.symbol === sell.symbol &&
        o.filled_avg_price &&
        new Date(o.filled_at) < sellTime
      ).sort((a, b) => new Date(b.filled_at) - new Date(a.filled_at));

      if (matchBuys.length > 0) {
        const pnl = (parseFloat(sell.filled_avg_price) - parseFloat(matchBuys[0].filled_avg_price)) * parseInt(sell.filled_qty);
        pnl >= 0 ? wins++ : losses++;
      }
    });

    // Build trade details for win/loss breakdown
    const tradeDetails = [];
    sells.forEach(sell => {
      const sellTime = new Date(sell.filled_at);
      const matchBuys = orders.filter(o =>
        o.side === "buy" &&
        o.symbol === sell.symbol &&
        o.filled_avg_price &&
        new Date(o.filled_at) < sellTime
      ).sort((a, b) => new Date(b.filled_at) - new Date(a.filled_at));

      if (matchBuys.length > 0) {
        const pnl = (parseFloat(sell.filled_avg_price) - parseFloat(matchBuys[0].filled_avg_price)) * parseInt(sell.filled_qty);
        tradeDetails.push({
          symbol: sell.symbol,
          pnl: pnl.toFixed(2),
          entry: parseFloat(matchBuys[0].filled_avg_price).toFixed(2),
          exit: parseFloat(sell.filled_avg_price).toFixed(2),
          qty: sell.filled_qty,
          time: sell.filled_at,
        });
      }
    });

    res.json({
      total_pnl: parseFloat(todayPnL).toFixed(2),
      wins,
      losses,
      total_trades: orders.length,
      trade_details: tradeDetails.sort((a, b) => new Date(b.time) - new Date(a.time)),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Bot Config Storage ────────────────────────────────────────
let botConfig = {
  watchlist: ["AAPL","AMZN","GOOG","META","MSFT","AMD","NVDA","BAC","JPM","CAT","GE","VLO","XOM","CVS","TJX","TSLA","COST","WMT","SPY","QQQ"],
  indicator: "SMA",
  period: 14,
  timeframe: "5Min",
  risk: 5,
  tp_enabled: false,
  tp_pct: 2,
  sl_enabled: false,
  sl_pct: 1,
  paused: false,
  symbol_config: {},
  cross_fast_type: "SMA",
  cross_fast_period: 9,
  cross_slow_type: "SMA",
  cross_slow_period: 21,
};

// Get bot config (used by the bot to read settings)
app.get("/api/bot-config", (req, res) => {
  res.json(botConfig);
});

// Update bot config (called from dashboard)
app.post("/api/bot-config", (req, res) => {
  const update = req.body;
  if (update.watchlist)              botConfig.watchlist          = update.watchlist;
  if (update.indicator)              botConfig.indicator          = update.indicator;
  if (update.period)                 botConfig.period             = parseInt(update.period);
  if (update.timeframe)              botConfig.timeframe          = update.timeframe;
  if (update.risk !== undefined)     botConfig.risk               = parseFloat(update.risk);
  if (update.tp_enabled !== undefined) botConfig.tp_enabled       = update.tp_enabled;
  if (update.tp_pct !== undefined)   botConfig.tp_pct             = parseFloat(update.tp_pct);
  if (update.sl_enabled !== undefined) botConfig.sl_enabled       = update.sl_enabled;
  if (update.sl_pct !== undefined)   botConfig.sl_pct             = parseFloat(update.sl_pct);
  if (update.paused !== undefined)   botConfig.paused             = update.paused;
  if (update.symbol_config)          botConfig.symbol_config      = update.symbol_config;
  if (update.cross_fast_type)        botConfig.cross_fast_type    = update.cross_fast_type;
  if (update.cross_fast_period)      botConfig.cross_fast_period  = parseInt(update.cross_fast_period);
  if (update.cross_slow_type)        botConfig.cross_slow_type    = update.cross_slow_type;
  if (update.cross_slow_period)      botConfig.cross_slow_period  = parseInt(update.cross_slow_period);

  console.log("⚙️  Config actualizada:", JSON.stringify(botConfig));
  res.json({ success: true, config: botConfig });
});

// ── Manual Orders ──────────────────────────────────────────────
app.post("/api/orders", async (req, res) => {
  try {
    const { symbol, side, type, qty, notional, limit_price, stop_price } = req.body;
    if (!symbol || !side || !type) return res.status(400).json({ error: "Faltan parámetros: symbol, side, type" });

    const order = {
      symbol: symbol.toUpperCase(),
      side,
      type,
      time_in_force: "day",
    };

    if (qty)          order.qty         = String(qty);
    if (notional)     order.notional    = String(notional);
    if (limit_price)  order.limit_price = String(limit_price);
    if (stop_price)   order.stop_price  = String(stop_price);

    const result = await broker("POST", "/orders", order);
    res.json({ success: true, order: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Backtesting ───────────────────────────────────────────────
app.post("/api/backtest", async (req, res) => {
  try {
    const {
      symbol, period_years = 1,
      indicator = "SMA", period = 14,
      cross_fast_type = "SMA", cross_fast_period = 9,
      cross_slow_type = "SMA", cross_slow_period = 21,
      long_short = false,
      initial_capital = 10000,
      risk_pct = 5,
    } = req.body;

    if (!symbol) return res.status(400).json({ error: "Falta símbolo" });

    // Fetch historical data from Yahoo Finance
    const endTs   = Math.floor(Date.now() / 1000);
    const startTs = endTs - period_years * 365 * 24 * 3600;
    const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol.toUpperCase()}?interval=1d&period1=${startTs}&period2=${endTs}`;

    const yahooRes = await axios.get(yahooUrl, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });

    const chart = yahooRes.data?.chart?.result?.[0];
    if (!chart) return res.status(400).json({ error: "No se encontraron datos para ese símbolo" });

    const timestamps = chart.timestamp;
    const closes     = chart.indicators.quote[0].close;

    // Filter out null values
    const bars = timestamps
      .map((t, i) => ({ t: new Date(t * 1000).toISOString().split("T")[0], c: closes[i] }))
      .filter(b => b.c != null);

    if (bars.length < 30) return res.status(400).json({ error: "Datos insuficientes" });

    // ── Indicator calculations ──────────────────────────────
    function calcSMA(arr, p) {
      if (arr.length < p) return null;
      return arr.slice(-p).reduce((a, b) => a + b, 0) / p;
    }
    function calcEMA(arr, p) {
      if (arr.length < p) return null;
      const k = 2 / (p + 1);
      let ema = arr.slice(0, p).reduce((a, b) => a + b, 0) / p;
      for (let i = p; i < arr.length; i++) ema = arr[i] * k + ema * (1 - k);
      return ema;
    }

    // ── Simulate strategy ───────────────────────────────────
    let capital    = initial_capital;
    let position   = null; // { side: 'long'|'short', entry, qty, entryDate }
    const trades   = [];
    const equity   = [];

    for (let i = 1; i < bars.length; i++) {
      const closes_so_far = bars.slice(0, i + 1).map(b => b.c);
      const price = bars[i].c;
      let signal = null; // true = bullish, false = bearish

      if (indicator.toUpperCase() === "CROSS") {
        const fastFn = cross_fast_type.toUpperCase() === "EMA" ? calcEMA : calcSMA;
        const slowFn = cross_slow_type.toUpperCase() === "EMA" ? calcEMA : calcSMA;
        const fast = fastFn(closes_so_far, cross_fast_period);
        const slow = slowFn(closes_so_far, cross_slow_period);
        if (fast != null && slow != null) signal = fast > slow;
      } else if (indicator.toUpperCase() === "EMA") {
        const ema = calcEMA(closes_so_far, period);
        if (ema != null) signal = price > ema;
      } else {
        const sma = calcSMA(closes_so_far, period);
        if (sma != null) signal = price > sma;
      }

      if (signal === null) { equity.push({ t: bars[i].t, v: capital }); continue; }

      const riskAmount = capital * (risk_pct / 100);
      const qty = Math.floor(riskAmount / price);

      if (signal && !position) {
        // Open long
        if (qty >= 1) {
          position = { side: "long", entry: price, qty, entryDate: bars[i].t };
        }
      } else if (!signal && position?.side === "long") {
        // Close long
        const pnl = (price - position.entry) * position.qty;
        capital += pnl;
        trades.push({ date: bars[i].t, side: "long", entry: position.entry, exit: price, qty: position.qty, pnl: parseFloat(pnl.toFixed(2)) });
        position = null;

        if (long_short && qty >= 1) {
          position = { side: "short", entry: price, qty, entryDate: bars[i].t };
        }
      } else if (signal && position?.side === "short") {
        // Close short
        const pnl = (position.entry - price) * position.qty;
        capital += pnl;
        trades.push({ date: bars[i].t, side: "short", entry: position.entry, exit: price, qty: position.qty, pnl: parseFloat(pnl.toFixed(2)) });
        position = null;

        if (qty >= 1) {
          position = { side: "long", entry: price, qty, entryDate: bars[i].t };
        }
      }

      equity.push({ t: bars[i].t, v: parseFloat(capital.toFixed(2)) });
    }

    // Close any open position at last price
    if (position) {
      const lastPrice = bars[bars.length - 1].c;
      const pnl = position.side === "long"
        ? (lastPrice - position.entry) * position.qty
        : (position.entry - lastPrice) * position.qty;
      capital += pnl;
      trades.push({ date: bars[bars.length - 1].t, side: position.side, entry: position.entry, exit: lastPrice, qty: position.qty, pnl: parseFloat(pnl.toFixed(2)), open: true });
    }

    // ── Stats ───────────────────────────────────────────────
    const wins      = trades.filter(t => t.pnl > 0).length;
    const losses    = trades.filter(t => t.pnl <= 0).length;
    const total_pnl = trades.reduce((s, t) => s + t.pnl, 0);
    const win_rate  = trades.length ? ((wins / trades.length) * 100).toFixed(1) : 0;

    // Max drawdown
    let peak = initial_capital, maxDrawdown = 0;
    for (const pt of equity) {
      if (pt.v > peak) peak = pt.v;
      const dd = (peak - pt.v) / peak * 100;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }

    res.json({
      symbol: symbol.toUpperCase(),
      bars_total: bars.length,
      trades_total: trades.length,
      wins, losses,
      win_rate: parseFloat(win_rate),
      total_pnl: parseFloat(total_pnl.toFixed(2)),
      total_pnl_pct: parseFloat(((capital - initial_capital) / initial_capital * 100).toFixed(2)),
      max_drawdown: parseFloat(maxDrawdown.toFixed(2)),
      initial_capital,
      final_capital: parseFloat(capital.toFixed(2)),
      equity,
      trades: trades.slice(-50), // last 50 trades for table
    });
  } catch (err) {
    console.error("Backtest error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Start server ──────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 Alpaca Dashboard corriendo en http://localhost:${PORT}`);
  console.log(`📊 Modo: ${process.env.ALPACA_PAPER !== "false" ? "PAPER TRADING" : "LIVE TRADING"}\n`);
});
