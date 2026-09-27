"""Live market watch for Zuzu: a ranked 'top 5 today' board, a personal watchlist and price alerts.

Prices come from Yahoo Finance's public chart endpoint (no key, ~1-2 min delayed for
some exchanges). This is information, not financial advice: the ranking shows which
liquid markets are moving most today, nothing more.
"""
import concurrent.futures
import json
import pathlib
import threading
import time
import urllib.parse
import urllib.request
import uuid

ROOT = pathlib.Path(__file__).resolve().parent
FILE = ROOT / "markets.json"
LOCK = threading.RLock()

# Liquid, widely tradable markets the "top 5" board ranks every refresh.
UNIVERSE = {
    "GC=F": "Gold", "SI=F": "Silver", "CL=F": "Crude oil", "NG=F": "Natural gas",
    "^GSPC": "S&P 500", "^IXIC": "Nasdaq", "^DJI": "Dow Jones", "^FTSE": "FTSE 100",
    "BTC-USD": "Bitcoin", "ETH-USD": "Ethereum", "SOL-USD": "Solana",
    "EURUSD=X": "EUR/USD", "GBPUSD=X": "GBP/USD", "USDJPY=X": "USD/JPY",
    "NVDA": "Nvidia", "TSLA": "Tesla", "AAPL": "Apple", "MSFT": "Microsoft",
}
_CACHE = {"at": 0.0, "quotes": {}}
CACHE_SECONDS = 50


def _load():
    try:
        data = json.loads(FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        data = {}
    data.setdefault("watchlist", [])
    data.setdefault("alerts", [])
    return data


def _save(data):
    FILE.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")


def _chart(symbol):
    url = ("https://query1.finance.yahoo.com/v8/finance/chart/" + urllib.parse.quote(symbol, safe="")
           + "?range=5d&interval=1h&includePrePost=false")
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 Zuzu/1.0"})
    with urllib.request.urlopen(req, timeout=8) as response:
        return json.loads(response.read())


def quote(symbol):
    result = (_chart(symbol).get("chart", {}).get("result") or [None])[0]
    if not result:
        raise ValueError(f"No data for {symbol}")
    meta = result.get("meta", {})
    closes = [c for c in ((result.get("indicators", {}).get("quote") or [{}])[0].get("close") or []) if c is not None]
    price = meta.get("regularMarketPrice") or (closes[-1] if closes else None)
    prev = meta.get("chartPreviousClose") or meta.get("previousClose")
    if price is None:
        raise ValueError(f"No price for {symbol}")
    change = ((price - prev) / prev * 100) if prev else 0.0
    # Hourly moves over 5 days: a simple volatility read for "how tradable is it now".
    moves = [abs(b - a) / a * 100 for a, b in zip(closes, closes[1:]) if a]
    volatility = sum(moves[-24:]) / max(1, len(moves[-24:])) if moves else 0.0
    trend = ((closes[-1] - closes[0]) / closes[0] * 100) if len(closes) > 1 and closes[0] else 0.0
    return {"symbol": symbol, "name": UNIVERSE.get(symbol, meta.get("shortName") or symbol),
            "price": round(price, 6 if price < 5 else 2), "change": round(change, 2),
            "trend5d": round(trend, 2), "volatility": round(volatility, 3),
            "currency": meta.get("currency", ""), "spark": [round(c, 6) for c in closes[-40:]]}


def quotes(symbols):
    now = time.monotonic()
    fresh = {}
    with LOCK:
        cached = _CACHE["quotes"] if now - _CACHE["at"] < CACHE_SECONDS else {}
    def fetch(sym):
        try:
            return sym, quote(sym)
        except Exception as exc:  # noqa: BLE001
            return sym, {"symbol": sym, "name": UNIVERSE.get(sym, sym), "error": type(exc).__name__}
    missing = [s for s in symbols if s not in cached]
    fresh.update({s: cached[s] for s in symbols if s in cached})
    if missing:
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            fresh.update(dict(pool.map(fetch, missing)))
    with LOCK:
        if now - _CACHE["at"] >= CACHE_SECONDS:
            _CACHE["quotes"] = {}
            _CACHE["at"] = now
        _CACHE["quotes"].update({k: v for k, v in fresh.items() if "error" not in v})
    return fresh


def top5(board=None):
    """Rank by today's move weighted by recent volatility: the most active markets right now."""
    board = board or quotes(list(UNIVERSE))
    live = [q for q in board.values() if "error" not in q]
    for q in live:
        q["score"] = round(abs(q["change"]) * 0.7 + q["volatility"] * 30 * 0.3, 3)
        q["bias"] = "up" if q["change"] > 0.15 else "down" if q["change"] < -0.15 else "flat"
    return sorted(live, key=lambda q: q["score"], reverse=True)[:5]


def state():
    data = _load()
    board = quotes(list(dict.fromkeys(list(UNIVERSE) + data["watchlist"])))
    return {"top5": top5({k: v for k, v in board.items() if k in UNIVERSE}),
            "watchlist": [board[s] for s in data["watchlist"] if s in board],
            "alerts": data["alerts"], "updated": time.strftime("%H:%M:%S"),
            "note": "Most active liquid markets today, ranked by move and volatility. Information only, not financial advice."}


def action(payload):
    kind = payload.get("action")
    with LOCK:
        data = _load()
        if kind == "watch":
            sym = str(payload.get("symbol", "")).strip().upper()[:20]
            if not sym:
                raise ValueError("symbol required")
            quote(sym)                                   # validate before saving
            if sym not in data["watchlist"]:
                data["watchlist"].append(sym)
        elif kind == "unwatch":
            data["watchlist"] = [s for s in data["watchlist"] if s != str(payload.get("symbol", "")).upper()]
        elif kind == "add_alert":
            sym = str(payload.get("symbol", "")).strip().upper()[:20]
            direction = payload.get("direction")
            if direction not in {"above", "below"}:
                raise ValueError("direction must be above or below")
            data["alerts"].append({"id": uuid.uuid4().hex[:8], "symbol": sym, "name": UNIVERSE.get(sym, sym),
                                   "direction": direction, "price": float(payload.get("price")), "fired": False})
        elif kind == "delete_alert":
            data["alerts"] = [a for a in data["alerts"] if a["id"] != payload.get("id")]
        else:
            raise ValueError("unknown markets action")
        _save(data)
    return state()


def check_alerts():
    """Return alerts that just triggered (each fires once)."""
    with LOCK:
        data = _load()
        pending = [a for a in data["alerts"] if not a["fired"]]
    if not pending:
        return []
    board = quotes(sorted({a["symbol"] for a in pending}))
    fired = []
    with LOCK:
        data = _load()
        for a in data["alerts"]:
            q = board.get(a["symbol"], {})
            if a["fired"] or "price" not in q:
                continue
            if (a["direction"] == "above" and q["price"] >= a["price"]) or (a["direction"] == "below" and q["price"] <= a["price"]):
                a["fired"] = True
                fired.append({**a, "now": q["price"]})
        if fired:
            _save(data)
    return fired
