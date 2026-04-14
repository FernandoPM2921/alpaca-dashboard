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

    res.json({
      total_pnl: parseFloat(todayPnL).toFixed(2),
      wins,
      losses,
      total_trades: orders.length,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start server ──────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 Alpaca Dashboard corriendo en http://localhost:${PORT}`);
  console.log(`📊 Modo: ${process.env.ALPACA_PAPER !== "false" ? "PAPER TRADING" : "LIVE TRADING"}\n`);
});
