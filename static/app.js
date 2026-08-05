/* ==========================================================================
   Kronos View — multi-chart terminal application
   --------------------------------------------------------------------------
   * Rendering  : TradingView lightweight-charts v5.2 (CDN, with fallback)
   * Multi-chart: 1 / 2 / 3 / 4 independent chart panes in a grid. Each pane
                  has its OWN symbol, timeframe, live Angel feed, drawings,
                  indicators and Kronos AI overlay. Click a pane to focus it -
                  the shared toolbar acts on the focused pane.
   * Data       : FastAPI backend -> /api/history (deep 5y cache -> Angel
                  One REST -> CSV fallback)
   * Live       : one WebSocket per pane (/ws?symbol=...) bridged to Angel
                  SmartWebSocketV2; every tick folds into the pane's current
                  candle via series.update()
   * Drawing    : custom ISeriesPrimitive layer (trendline / hLine / vLine /
                  hRay / rectangle). Drawings can extend into the empty space
                  to the RIGHT of the last candle (extrapolated time anchor +
                  edge clamping) - no more dead zone at the data edge.
   * Range      : TradingView-style range buttons (1D .. 5Y). Default 1Y.
                  Scrolling to the left edge loads OLDER candles (deep cache
                  paging via ?before=) until the start of the archive.
   * Kronos     : POST /api/kronos/forecast -> dashed line overlay. The
                  🔮 Auto button re-runs the forecast automatically as live
                  candles update, so the prediction keeps up with the market.
   ========================================================================== */

(function () {
  'use strict';

  /* ------------------------------ palette -------------------------------- */
  var COLORS = {
    bg: '#131722', text: '#d1d4dc', muted: '#787b86',
    up: '#089981', down: '#f23645',
    volUp: 'rgba(8,153,129,0.45)', volDown: 'rgba(242,54,69,0.45)',
    drawing: '#2962ff', kronos: '#ffb74d',
  };

  var INTERVAL_MS = { '1m': 60000, '5m': 300000, '15m': 900000, '30m': 1800000, '1H': 3600000, '1D': 86400000 };
  var IST_OFFSET_MS = 5.5 * 3600 * 1000;   // Asia/Kolkata = UTC + 5:30
  // NSE cash session (IST): market opens 09:15, closes 15:30. Live candle
  // buckets and the session gate both anchor to these exact boundaries.
  var MARKET_OPEN_MS = (9 * 60 + 15) * 60 * 1000;   // 09:15 IST in ms
  var SESSION_START_MIN = 9 * 60 + 15;               // 555
  var SESSION_END_MIN = 15 * 60 + 30;                // 930

  // TradingView-style ranges (calendar days fetched from the deep cache).
  var RANGES = { '1D': 1, '5D': 5, '1M': 31, '3M': 93, '6M': 183, '1Y': 365, '5Y': 1825 };
  var DEFAULT_RANGE = '5D';
  var DEFAULT_INTERVAL = '5m';
  // TradingView-style reset window: a FIXED bar count per timeframe,
  // right-anchored at the newest candle. A constant count makes every
  // timeframe's reset show its OWN distinct amount of history (1m ~3.3h,
  // 5m ~16.6h, 15m ~2 days, 1H ~8 days, 1D ~6 months) instead of the same
  // ~1-session window that made every chart look identical to the 1m view.
  var RESET_BARS = { '1m': 200, '5m': 200, '15m': 200, '30m': 200, '1H': 200, '1D': 120 };
  var RIGHT_OFFSET_BARS = 8;
  var INTERVAL_BUTTONS = ['1m', '5m', '15m', '30m', '1H', '1D'];
  // PUBLIC BUILD: exactly three chartable instruments - the Nifty 50 index,
  // the near-month NIFTY future and the Bank Nifty index. 'NIFTY FUT'
  // resolves server-side to the current month's NFO contract
  // (NIFTY25AUG26FUT, ...) and rolls automatically at expiry.
  var DEFAULT_SYMBOLS = ['Nifty 50', 'NIFTY FUT', 'Bank Nifty'];
  var MAX_PANES = 1;   // public build: single chart only

  var INDICATORS = {
    sma20:  { label: 'SMA',  period: 20,  color: '#e2b3ff', kind: 'line', ema: false },
    sma50:  { label: 'SMA',  period: 50,  color: '#64b5f6', kind: 'line', ema: false },
    sma200: { label: 'SMA',  period: 200, color: '#ffb74d', kind: 'line', ema: false },
    ema20:  { label: 'EMA',  period: 20,  color: '#4dd0e1', kind: 'line', ema: true },
    vwap:   { label: 'VWAP', color: '#b388ff', kind: 'vwap' },
    boll:   { label: 'BB',   period: 20,  mult: 2, color: '#4fc3f7', kind: 'boll' },
    rsi:    { label: 'RSI',  period: 14,  color: '#ffd54f', kind: 'rsi', sub: 'rsi' },
    macd:   { label: 'MACD', fast: 12, slow: 26, signal: 9, color: '#4dd0e1', signalColor: '#ffb74d', kind: 'macd', sub: 'macd' },
    stoch:  { label: 'Stoch', period: 14, k: 3, d: 3, color: '#7e57c2', color2: '#26a69a', kind: 'stoch', sub: 'stoch' },
    atr:    { label: 'ATR',  period: 14, color: '#ff8a65', kind: 'atr' },
    super:  { label: 'SuperTrend', period: 10, mult: 3, color: '#26a69a', color2: '#ef5350', kind: 'super' },
    obv:    { label: 'OBV',  color: '#ffca28', kind: 'obv' },
    adx:    { label: 'ADX',  period: 14, color: '#b0bec5', color2: '#4dd0e1', kind: 'adx', sub: 'adx' },
  };

  /* -------------------- pattern detection + zigzag / S-R ------------------ */
  function bodyPct(c) {
    var rng = c.high - c.low;
    return rng <= 0 ? 0 : Math.abs(c.close - c.open) / rng;
  }
  function wickUpper(c) {
    var rng = c.high - c.low;
    return rng <= 0 ? 0 : (c.high - Math.max(c.open, c.close)) / rng;
  }
  function wickLower(c) {
    var rng = c.high - c.low;
    return rng <= 0 ? 0 : (Math.min(c.open, c.close) - c.low) / rng;
  }
  function isBull(c) { return c.close >= c.open; }
  function isBear(c) { return c.close < c.open; }

  // TradingView-style candlestick pattern scanner. Pure function over the
  // candle array -> [{time, type, dir, text}]. Cheap enough to run on every
  // committed candle close.
  function detectPatterns(candles) {
    var out = [];
    var n = candles.length;
    for (var i = 1; i < n; i++) {
      var c = candles[i], p = candles[i - 1], pp = i > 1 ? candles[i - 2] : null;
      var rng = c.high - c.low;
      if (rng <= 0) continue;
      var bp = bodyPct(c), uw = wickUpper(c), lw = wickLower(c);
      var bull = isBull(c), bear = isBear(c);
      if (bp <= 0.1) out.push({ time: c.time, type: 'Doji', dir: 0, text: 'Doji' });
      if (lw >= 2 * bp && uw <= 0.25 && bp <= 0.35)
        out.push({ time: c.time, type: 'Hammer', dir: 1, text: 'Hammer' });
      if (uw >= 2 * bp && lw <= 0.25 && bp <= 0.35)
        out.push({ time: c.time, type: 'Shooting Star', dir: -1, text: 'Shooting Star' });
      if (p && bull && isBear(p) && c.close > p.open && c.open < p.close &&
          Math.abs(c.close - c.open) > Math.abs(p.close - p.open))
        out.push({ time: c.time, type: 'Bullish Engulfing', dir: 1, text: 'Bull Engulf' });
      if (p && bear && isBull(p) && c.close < p.open && c.open > p.close &&
          Math.abs(c.close - c.open) > Math.abs(p.close - p.open))
        out.push({ time: c.time, type: 'Bearish Engulfing', dir: -1, text: 'Bear Engulf' });
      if (pp && isBear(pp) && bodyPct(p) <= 0.25 && bull && c.close > (pp.open + pp.close) / 2)
        out.push({ time: c.time, type: 'Morning Star', dir: 1, text: 'Morning Star' });
      if (pp && isBull(pp) && bodyPct(p) <= 0.25 && bear && c.close < (pp.open + pp.close) / 2)
        out.push({ time: c.time, type: 'Evening Star', dir: -1, text: 'Evening Star' });
      if (bp >= 0.9)
        out.push({ time: c.time, type: bull ? 'Bullish Marubozu' : 'Bearish Marubozu',
                   dir: bull ? 1 : -1, text: bull ? 'Marubozu ▲' : 'Marubozu ▼' });
    }
    return out;
  }

  // Zigzag pivot detection + clustered support/resistance levels.
  function computeZigzagSR(candles, thresholdPct) {
    var thr = (thresholdPct || 1.2) / 100;
    var pivots = [], dir = 0, lastP = null;
    for (var i = 1; i < candles.length - 1; i++) {
      var c = candles[i];
      var isHigh = c.high >= candles[i - 1].high && c.high >= candles[i + 1].high;
      var isLow = c.low <= candles[i - 1].low && c.low <= candles[i + 1].low;
      if (!isHigh && !isLow) continue;
      var price = isHigh ? c.high : c.low;
      if (!lastP) { pivots.push({ t: c.time, p: price }); lastP = price; dir = isHigh ? 1 : -1; continue; }
      if (Math.abs(price - lastP) / lastP < thr) continue;
      var nd = isHigh ? 1 : -1;
      if (nd === dir) {
        if ((nd === 1 && price > lastP) || (nd === -1 && price < lastP)) {
          pivots[pivots.length - 1] = { t: c.time, p: price };
          lastP = price;
        }
      } else {
        pivots.push({ t: c.time, p: price });
        lastP = price;
        dir = nd;
      }
    }
    // Cluster pivot prices into levels (bins ~ threshold wide), top 6.
    var prices = pivots.map(function (q) { return q.p; });
    var levels = [];
    while (prices.length && levels.length < 6) {
      var best = prices[0], cnt = 0;
      for (var a = 0; a < prices.length; a++) {
        var c2 = 0;
        for (var b = 0; b < prices.length; b++)
          if (Math.abs(prices[b] - prices[a]) / prices[a] <= thr) c2++;
        if (c2 > cnt) { cnt = c2; best = prices[a]; }
      }
      var sum = 0, mem = [];
      for (var b = 0; b < prices.length; b++)
        if (Math.abs(prices[b] - best) / best <= thr) { sum += prices[b]; mem.push(prices[b]); }
      var dedup = prices.filter(function (q) { return mem.indexOf(q) === -1; });
      prices = dedup;
      levels.push({ price: sum / mem.length, touches: mem.length });
    }
    return { pivots: pivots, levels: levels };
  }

  // TradingView-style indicator settings: every indicator can be customized
  // (period / source / color / line style / width) per chart via the ⚙ gear
  // or a double-click on its toolbar chip. Configs live on the Pane.
  var SOURCES = [['close', 'Close'], ['open', 'Open'], ['high', 'High'],
                 ['low', 'Low'], ['hl2', 'HL/2'], ['hlc3', 'HLC/3'], ['ohlc4', 'OHLC/4']];
  var LINE_STYLES = [[0, 'Solid'], [2, 'Dashed'], [3, 'Dotted']];

  function indicatorDefaults(key) {
    var d = INDICATORS[key];
    var cfg = { color: d.color, lineStyle: 0, lineWidth: 1, source: 'close' };
    if (d.kind === 'macd') cfg.signalColor = d.signalColor;
    if (d.period != null) cfg.period = d.period;
    if (d.mult != null) cfg.mult = d.mult;
    if (d.fast != null) cfg.fast = d.fast;
    if (d.slow != null) cfg.slow = d.slow;
    if (d.signal != null) cfg.signal = d.signal;
    return cfg;
  }

  var state = {
    layout: 1,          // number of panes currently shown (TradingView-style
                        // default: a single chart with volume below)
    panes: [],          // Pane instances
    activeIndex: 0,     // focused pane
    symbols: [],        // watchlist for the pane selects
  };

  // Shared right-click context menu (TradingView-style). One element, reused
  // by every pane; populated with the actions of the pane that was clicked.
  var ctxMenu = null;
  function buildContextMenu() {
    var m = el('div', 'ctx-menu');
    m.id = 'ctx-menu';
    m.hidden = true;
    document.body.appendChild(m);
    return m;
  }
  function hideContextMenu() { if (ctxMenu) ctxMenu.hidden = true; }

  /* --------------------------- tiny helpers ------------------------------ */
  function $(id) { return document.getElementById(id); }
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function fmtVol(v) {
    if (v == null || isNaN(v)) return '—';
    if (v >= 1e7) return (v / 1e7).toFixed(2) + 'Cr';
    if (v >= 1e5) return (v / 1e5).toFixed(2) + 'L';
    if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
    return String(Math.round(v));
  }
  function toast(msg, kind) {
    var stack = $('toast-stack');
    var t = el('div', 'toast' + (kind === 'err' ? ' err' : ''), msg);
    stack.appendChild(t);
    setTimeout(function () { t.remove(); }, 4500);
  }
  function istDateKey(epochSec) {
    return new Date((epochSec + IST_OFFSET_MS / 1000) * 1000).toISOString().slice(0, 10);
  }

  // Every candle timestamp is an ABSOLUTE instant (UTC epoch), so labels must
  // render in Asia/Kolkata regardless of the browser's local timezone - the
  // header clock is IST and the market is IST. Without this, a browser in a
  // different timezone would show every candle shifted from the real time.
  function fmtIST(epochSec, opts) {
    opts = opts || {};
    try {
      var d = new Date(epochSec * 1000);
      var parts = { minute: '2-digit' };
      if (opts.hour != null) parts.hour = opts.hour; else parts.hour = '2-digit';
      if (opts.seconds) parts.second = '2-digit';
      if (opts.date !== false) {
        parts.day = '2-digit';
        parts.month = 'short';
        if (opts.year) parts.year = 'numeric';
      }
      return new Intl.DateTimeFormat('en-IN', {
        timeZone: 'Asia/Kolkata', hour12: false,
        day: parts.day, month: parts.month, year: parts.year,
        hour: parts.hour, minute: parts.minute, second: parts.second,
      }).format(d) + ' IST';
    } catch (e) {
      // Fallback for browsers/WebViews without Intl timeZone support - the
      // same pure-arithmetic IST shift the axis formatters use.
      var dd = new Date(epochSec * 1000 + IST_OFFSET_MS);
      var iso = dd.toISOString();
      var hm = iso.slice(11, 16) + (opts.seconds ? ':' + iso.slice(17, 19) : '');
      var day = iso.slice(8, 10) + ' ' + IST_MONTHS[parseInt(iso.slice(5, 7), 10) - 1];
      return day + (opts.year ? ' ' + iso.slice(0, 4) : '') + ' ' + hm + ' IST';
    }
  }
  function fmtISTDate(epochSec) {
    return istDateKey(epochSec).split('-').reverse().join('/');
  }

  // --- Time-axis / crosshair formatters (always Asia/Kolkata) --------------
  // lightweight-charts renders axis ticks + the bottom crosshair time label
  // in the BROWSER's local timezone unless localization.timeFormatter /
  // dateFormatter are provided. Every candle timestamp is an absolute UTC
  // epoch, so without these a viewer outside IST sees every candle shifted
  // (e.g. 09:15 IST shown as 05:15 local). The formatters below always
  // render in Asia/Kolkata to match the header clock and the legend.
  // Axis labels are computed with PURE arithmetic (epoch + 5:30 -> ISO
  // string), so the bottom time axis is IST in EVERY browser/WebView - the
  // old Intl.DateTimeFormat(timeZone) path could throw or silently fall back
  // to the browser's local timezone (UTC) and print UTC labels at the bottom.
  var IST_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function istAxisParts(t) {
    // t is either a UTCTimestamp (number, seconds) or a BusinessDay
    // {year, month, day} object (date-boundary ticks / daily series).
    try {
      var d;
      if (t && typeof t === 'object' && t.year) {
        // BusinessDay = a calendar date (e.g. midnight IST of a daily bar).
        d = new Date(Date.UTC(t.year, (t.month || 1) - 1, t.day || 1) + IST_OFFSET_MS);
      } else if (typeof t === 'number') {
        d = new Date(t * 1000 + IST_OFFSET_MS);
      } else {
        return null;
      }
      var iso = d.toISOString();   // of the IST-shifted instant == IST wall time
      return {
        hm: iso.slice(11, 16),
        day: iso.slice(8, 10) + ' ' + IST_MONTHS[parseInt(iso.slice(5, 7), 10) - 1],
      };
    } catch (e) {
      return null;
    }
  }

  function fmtAxisTime(t) {
    var p = istAxisParts(t);
    if (!p) return '';
    // Date-boundary ticks (midnight IST) show the date, intraday show HH:MM.
    return p.hm === '00:00' ? p.day : p.hm;
  }

  function fmtAxisDate(t) {
    var p = istAxisParts(t);
    if (!p) return '';
    return p.day;
  }
  function activePane() { return state.panes[state.activeIndex]; }

  /* =========================================================================
     Pane — one fully independent chart (symbol / timeframe / feed / AI)
     ========================================================================= */
  function Pane(index, container) {
    this.index = index;
    this.container = container;          // .pane element
    this.symbol = DEFAULT_SYMBOLS[index] || 'Nifty 50';
    this.interval = DEFAULT_INTERVAL;
    this.range = DEFAULT_RANGE;
    this.chartType = 'candles';
    this.indicators = {};
    this._indSeen = {};      // last applied on/off state per indicator - lets
                             // recomputeIndicators skip unchanged (off) series
    this._indCache = {};     // per-indicator incremental state + last applied
                             // candle time - live candle closes append a point
                             // via series.update() instead of a full setData
    this.candles = [];
    this.currentCandle = null;
    this.loadingMore = false;
    this.historyDone = false;
    this.loadToken = 0;          // guards against stale async loads
    this.destroyed = false;      // teardown guard for ws/canvas callbacks
    this.ws = null;
    this.wsTimer = null;
    this.wsFeed = null;
    this.kronosData = null;
    this.kronosBand = null;
    this.kronosConfidence = null;
    this.kronosRegime = null;
    this.scaleMode = 'auto';
    this.forecastLoading = false;
    this.autoPredict = false;
    this.autoTimer = null;
    this.lastAutoRun = 0;
    this._aiPending = false;   // AI analysis in flight for a just-closed candle
    this._needRefresh = false; // derived overlays waiting on the AI result
    this.drawn = [];
    this.draft = null;
    this.activeTool = null;
    this.nextId = 1;
    this.selectedId = null;   // id of the currently selected drawing (Delete removes it)
    this.showVolume = true;   // volume histogram toggle
    this.sessionBreaks = true;   // TradingView-style dotted line at each
                                 // market close->open boundary (toggleable)
    this._breaks = [];           // cached session-boundary times (IST date change)
    this.drawColor = COLORS.drawing;   // color for NEW drawings (toolbar picker)
    // --- Pro-suite toggles (right-click menu) ---
    this.patternScan = false;          // candlestick pattern markers + Patterns panel
    this.patterns = [];                // last detected patterns for THIS symbol
    this.autoSR = false;               // automatic zigzag + support/resistance overlay
    this.maAlert = false;              // SMA-cross toasts on live candle closes
    this._maAlertCd = {};              // per-MA cooldown timestamps
    this.watermarkOn = true;           // symbol+interval text watermark
    this._watermark = null;
    this.gridOn = true;                // price grid lines
    this.crosshairOn = true;           // crosshair lines
    this._haTail = null;   // last Heikin-Ashi candle (incremental live transform)
    this._haPrev = null;   // HA candle before the tail (for in-place refreshes)
    this.model = 'Kronos-small';   // GPU-only default (public build: mini + small only)
    this.volProfile = false;          // volume-at-price overlay (right-click toggle)
    this._volProfileBins = null;      // computed profile for the visible window
    this._lastView = null;            // last good visible range (persisted view)
    this._viewSaveTimer = null;       // debounce for view persistence

    this.chart = null;
    this.series = {};
    this.indSeries = {};
    this.legend = {};
    this.buildDom();
    this.buildChart();
    this.applyWatermark();   // symbol+interval watermark (v5 plugin)
    this.wirePaneEvents();
    this.populateSymbols();
  }

  /* ----------------------------- pane DOM -------------------------------- */
  Pane.prototype.buildDom = function () {
    var head = el('div', 'pane-head');
    var search = el('input', 'pane-search');
    search.placeholder = 'Search…';
    search.autocomplete = 'off';
    search.spellcheck = false;
    var select = el('select', 'pane-select');
    var intervals = el('div', 'pane-intervals');
    INTERVAL_BUTTONS.forEach(function (iv) {
      var b = el('button', 'tv-btn tv-btn-sm' + (iv === DEFAULT_INTERVAL ? ' tv-btn-active' : ''), iv);
      b.dataset.interval = iv;
      intervals.appendChild(b);
    });
    // Per-pane Kronos AI toggle: turns the forecast overlay + auto-predict
    // ON for THIS chart only - the toolbar's global buttons still act on
    // the focused pane, but each pane now carries its own switch.
    var aiBtn = el('button', 'tv-btn tv-btn-sm pane-ai', '🔮 AI');
    aiBtn.title = 'Turn ON Kronos forecast + auto-predict for this chart only';
    head.appendChild(search);
    head.appendChild(select);
    head.appendChild(intervals);
    head.appendChild(aiBtn);


    var chartEl = el('div', 'pane-chart');
    var legend = el('div', 'pane-legend',
      '<span class="legend-title">—</span>' +
      '<span class="legend-time"></span>' +
      '<span class="legend-ohlc">O — H — L — C — V —</span>' +
      '<span class="legend-chg"></span>' +
      '<span class="legend-compare"></span>');
    // "What the AI is thinking" panel (top-right of the chart): the model's
    // direction call, confidence, market-regime chips and the technical
    // context its sampled paths reason from. Click the header to collapse it
    // to a single line. The panel is interactive now, so it needs pointer
    // events - the chart ignores clicks that don't land on its canvas.
    var kronosNote = el('div', 'kronos-note',
      '<div class="ai-head">' +
        '<span class="ai-title">🔮 Kronos thinking</span>' +
        '<span class="ai-dir">—</span>' +
        '<button class="ai-toggle" title="Expand / collapse">▾</button>' +
      '</div>' +
      '<div class="ai-body">' +
        '<div class="ai-next">next candle: <span class="kronos-next">—</span></div>' +
        '<div class="ai-path">path: <span class="kronos-path">—</span></div>' +
        '<div class="ai-conf"><span>Confidence</span>' +
          '<div class="ai-bar"><div class="ai-fill"></div></div>' +
          '<b class="ai-conf-val">—</b></div>' +
        '<div class="ai-chips"></div>' +
        '<ul class="ai-why"></ul>' +
        '<div class="ai-meta"><span class="kronos-ctx"></span></div>' +
        '<div class="ai-note">market context the model reasons from — not a literal chain of thought</div>' +
      '</div>');
    kronosNote.hidden = true;
    var noteHead = kronosNote.querySelector('.ai-head');
    noteHead.addEventListener('click', function () {
      var collapsed = !kronosNote.classList.contains('collapsed');
      kronosNote.classList.toggle('collapsed', collapsed);
      var t = kronosNote.querySelector('.ai-toggle');
      if (t) t.textContent = collapsed ? '▸' : '▾';
      saveLayout();   // persist the collapsed state per pane
    });
    var autoNote = el('div', 'pane-autonote', '🔮 auto-predicting…');
    autoNote.hidden = true;
    chartEl.appendChild(legend);
    chartEl.appendChild(kronosNote);
    chartEl.appendChild(autoNote);

    this.container.appendChild(head);
    this.container.appendChild(chartEl);


    this.headEl = head;
    this.chartEl = chartEl;
    this.searchEl = search;
    this.selectEl = select;
    this.kronosNoteEl = kronosNote;
    this.kronosNextEl = kronosNote.querySelector('.kronos-next');
    this.autoNoteEl = autoNote;
    this.aiBtnEl = aiBtn;
    this.legend = {
      title: legend.querySelector('.legend-title'),
      time: legend.querySelector('.legend-time'),
      ohlc: legend.querySelector('.legend-ohlc'),
      chg: legend.querySelector('.legend-chg'),
    };
    this.compareLegendEl = legend.querySelector('.legend-compare');
    this.kronosPathEl = kronosNote.querySelector('.kronos-path');
    this.kronosCtxEl = kronosNote.querySelector('.kronos-ctx');
    this.paneIntervalsEl = intervals;
  };

  /* --------------------------- chart initialization ---------------------- */
  Pane.prototype.buildChart = function () {
    var self = this;
    this.chart = LightweightCharts.createChart(this.chartEl, {
      layout: {
        background: { type: 'solid', color: COLORS.bg },
        textColor: COLORS.text,
        fontSize: 11,
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        attributionLogo: false,   // hide the "TradingView" logo at the bottom of the chart
      },
      grid: {
        vertLines: { color: 'rgba(42,46,57,0.5)' },
        horzLines: { color: 'rgba(42,46,57,0.5)' },
      },
      crosshair: {
        // v5 moved magnet snapping from a per-series option (v4's
        // crosshairMagnet) to the chart-level crosshair mode. Magnet keeps
        // the crosshair horizontal line stuck to the close of OHLC series -
        // the TradingView default the panes used to set per series.
        mode: LightweightCharts.CrosshairMode.Magnet,
        vertLine: { color: '#758696', labelBackgroundColor: '#2a2e39' },
        horzLine: { color: '#758696', labelBackgroundColor: '#2a2e39' },
      },
      rightPriceScale: { borderColor: '#2a2e39' },
      timeScale: {
        borderColor: '#2a2e39', timeVisible: true, secondsVisible: false,
        rightOffset: RIGHT_OFFSET_BARS,   // small empty space right of the last candle - TradingView-style
      },
      // TradingView-like navigation: wheel zoom around the cursor, pinch
      // zoom, drag-to-pan with the mouse, and kinetic (momentum) scrolling
      // on touch so the chart glides like the real terminal.
      handleScroll: {
        mouseWheel: true, pressedMouseMove: true,
        horzTouchDrag: true, vertTouchDrag: true,
      },
      handleScale: {
        axisPressedMouseMove: true, mouseWheel: true, pinch: true,
      },
      kineticScroll: { mouse: false, touch: true },
      // Render every time label (axis ticks + crosshair) in IST, never in
      // the browser's local timezone - candle times are absolute UTC epochs.
      localization: {
        locale: 'en-IN',
        timeFormatter: fmtAxisTime,
        dateFormatter: fmtAxisDate,
      },
    });

    // v5 series API: every series is created via chart.addSeries(Definition,
    // options) where the definition is exported on the LightweightCharts
    // namespace (the old per-type add*Series() helpers are gone).
    this.series.candle = this.chart.addSeries(LightweightCharts.CandlestickSeries, {
      upColor: COLORS.up, downColor: COLORS.down,
      borderUpColor: COLORS.up, borderDownColor: COLORS.down,
      wickUpColor: COLORS.up, wickDownColor: COLORS.down,
      priceLineVisible: true,
      priceLineColor: '#d1d4dc',
      priceLineStyle: LightweightCharts.LineStyle.Dashed,
      lastValueVisible: true,
      priceFormat: { type: 'price', precision: 2, minMove: 0.05 },
    });
    this.series.bar = this.chart.addSeries(LightweightCharts.BarSeries, {
      upColor: COLORS.up, downColor: COLORS.down,
      thinBars: false, priceLineVisible: false, lastValueVisible: true,
      visible: false,
      priceFormat: { type: 'price', precision: 2, minMove: 0.05 },
    });
    this.series.line = this.chart.addSeries(LightweightCharts.LineSeries, {
      color: '#2962ff', lineWidth: 2, priceLineVisible: false,
      crosshairMarkerVisible: false, visible: false,
      priceFormat: { type: 'price', precision: 2, minMove: 0.05 },
    });
    this.series.area = this.chart.addSeries(LightweightCharts.AreaSeries, {
      lineColor: '#2962ff', topColor: 'rgba(41,98,255,0.30)',
      bottomColor: 'rgba(41,98,255,0.02)', lineWidth: 2,
      priceLineVisible: false, crosshairMarkerVisible: false,
      visible: false,
      priceFormat: { type: 'price', precision: 2, minMove: 0.05 },
    });
    this.series.volume = this.chart.addSeries(LightweightCharts.HistogramSeries, {
      priceFormat: { type: 'volume' },
      priceScaleId: 'vol',
    });
    this.chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    // Sub-pane price scales for RSI / MACD (created up-front; margins are
    // applied by _layoutScales() only when the indicator is switched on).
    // Sub-pane oscillators: lastValueVisible shows the CURRENT value on the
    // indicator's own scale at the right edge - TradingView-style (e.g.
    // "RSI 14  62.3" at the bottom of the RSI pane).
    this.series.rsi = this.chart.addSeries(LightweightCharts.LineSeries, {
      color: '#ffd54f', lineWidth: 1.5, priceScaleId: 'rsi',
      priceLineVisible: false, lastValueVisible: true, title: 'RSI',
      crosshairMarkerVisible: false, visible: false,
    });
    this.series.macdLine = this.chart.addSeries(LightweightCharts.LineSeries, {
      color: '#4dd0e1', lineWidth: 1.5, priceScaleId: 'macd',
      priceLineVisible: false, lastValueVisible: true, title: 'MACD',
      crosshairMarkerVisible: false, visible: false,
    });
    this.series.macdSignal = this.chart.addSeries(LightweightCharts.LineSeries, {
      color: '#ffb74d', lineWidth: 1, priceScaleId: 'macd',
      priceLineVisible: false, lastValueVisible: true, title: 'Signal',
      crosshairMarkerVisible: false, visible: false,
    });
    this.series.macdHist = this.chart.addSeries(LightweightCharts.HistogramSeries, {
      priceScaleId: 'macd', priceFormat: { type: 'price', precision: 2 },
      priceLineVisible: false, lastValueVisible: false, visible: false,
    });
    // Stochastic oscillator sub-pane (K + D lines).
    this.series.stochK = this.chart.addSeries(LightweightCharts.LineSeries, {
      color: '#7e57c2', lineWidth: 1.5, priceScaleId: 'stoch',
      priceLineVisible: false, lastValueVisible: true, title: 'Stoch K',
      crosshairMarkerVisible: false, visible: false,
    });
    this.series.stochD = this.chart.addSeries(LightweightCharts.LineSeries, {
      color: '#26a69a', lineWidth: 1.5, priceScaleId: 'stoch',
      priceLineVisible: false, lastValueVisible: true, title: 'Stoch D',
      crosshairMarkerVisible: false, visible: false,
    });
    // ADX sub-pane (ADX + +DI/-DI).
    this.series.adxLine = this.chart.addSeries(LightweightCharts.LineSeries, {
      color: '#b0bec5', lineWidth: 1.5, priceScaleId: 'adx',
      priceLineVisible: false, lastValueVisible: true, title: 'ADX',
      crosshairMarkerVisible: false, visible: false,
    });
    this.series.adxPdi = this.chart.addSeries(LightweightCharts.LineSeries, {
      color: '#4dd0e1', lineWidth: 1, priceScaleId: 'adx',
      priceLineVisible: false, lastValueVisible: true, title: '+DI',
      crosshairMarkerVisible: false, visible: false,
    });
    this.series.adxNdi = this.chart.addSeries(LightweightCharts.LineSeries, {
      color: '#ffb74d', lineWidth: 1, priceScaleId: 'adx',
      priceLineVisible: false, lastValueVisible: true, title: '-DI',
      crosshairMarkerVisible: false, visible: false,
    });
    // ATR / SuperTrend / OBV overlay on the main price scale (no axis move).
    this.series.atr = this.chart.addSeries(LightweightCharts.LineSeries, {
      color: '#ff8a65', lineWidth: 1, priceLineVisible: false,
      lastValueVisible: false, crosshairMarkerVisible: false, visible: false,
      autoscaleInfoProvider: function () { return null; },
    });
    this.series.super = this.chart.addSeries(LightweightCharts.LineSeries, {
      color: 'rgba(38,166,154,0.85)', lineWidth: 2, priceLineVisible: false,
      lastValueVisible: false, crosshairMarkerVisible: false, visible: false,
      autoscaleInfoProvider: function () { return null; },
    });
    this.series.obv = this.chart.addSeries(LightweightCharts.LineSeries, {
      color: '#ffca28', lineWidth: 1, priceLineVisible: false,
      lastValueVisible: false, crosshairMarkerVisible: false, visible: false,
      autoscaleInfoProvider: function () { return null; },
    });
    this.chart.priceScale('rsi').applyOptions({ scaleMargins: { top: 0.7, bottom: 0.3 } });
    this.chart.priceScale('macd').applyOptions({ scaleMargins: { top: 0.7, bottom: 0.3 } });
    this.chart.priceScale('stoch').applyOptions({ scaleMargins: { top: 0.7, bottom: 0.3 } });
    this.chart.priceScale('adx').applyOptions({ scaleMargins: { top: 0.7, bottom: 0.3 } });
    // Overlays on the RIGHT price scale must NOT move the axis (the SMA/EMA
    // series do the same via autoscaleInfoProvider) - otherwise opening BB 20
    // would visibly zoom the candles out by 2 sigma.
    this.series.bollUp = this.chart.addSeries(LightweightCharts.LineSeries, {
      color: 'rgba(79,195,247,0.7)', lineWidth: 1,
      priceLineVisible: false, lastValueVisible: false,
      crosshairMarkerVisible: false, visible: false,
      autoscaleInfoProvider: function () { return null; },
    });
    this.series.bollMid = this.chart.addSeries(LightweightCharts.LineSeries, {
      color: '#4fc3f7', lineWidth: 1,
      priceLineVisible: false, lastValueVisible: false,
      crosshairMarkerVisible: false, visible: false,
      autoscaleInfoProvider: function () { return null; },
    });
    this.series.bollLo = this.chart.addSeries(LightweightCharts.LineSeries, {
      color: 'rgba(79,195,247,0.7)', lineWidth: 1,
      priceLineVisible: false, lastValueVisible: false,
      crosshairMarkerVisible: false, visible: false,
      autoscaleInfoProvider: function () { return null; },
    });
    this.series.vwap = this.chart.addSeries(LightweightCharts.LineSeries, {
      color: '#b388ff', lineWidth: 1.5,
      priceLineVisible: false, lastValueVisible: false,
      crosshairMarkerVisible: false, visible: false,
      autoscaleInfoProvider: function () { return null; },
    });
    this.series.kronos = this.chart.addSeries(LightweightCharts.LineSeries, {
      color: COLORS.kronos,
      lineStyle: LightweightCharts.LineStyle.Dashed,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
      crosshairMarkerVisible: true,
      title: 'Kronos Forecast',
    });
    this.series.kronos.setData([]);

    // Custom drawing layer (series primitive) - per pane.
    this.primitive = new DrawingsPrimitive(
      this.chart, this.series.candle,
      function () { return self.drawn; },
      function () { return self.draft; },
      function () { return self.kronosBand; },
      function () { return self.selectedId; },
      function () { return { on: self.sessionBreaks, breaks: self._breaks, interval: self.interval }; },
      function () { return self._volProfileBins; }
    );
    this.series.candle.attachPrimitive(this.primitive);

    // Keep the canvas sized to its container.
    this.resizeObserver = new ResizeObserver(function () {
      self.chart.resize(self.chartEl.clientWidth, self.chartEl.clientHeight);
    });
    this.resizeObserver.observe(this.chartEl);

    // Fullscreen: the ResizeObserver fires BEFORE the fullscreen transition
    // settles, so the canvas gets the pre-transition size and the chart can
    // stay black/empty. Re-size on every fullscreenchange (enter + exit),
    // but only for the pane actually involved (avoids N wasted resizes
    // when every pane's listener fires on a single transition).
    this._fsChangeSub = function () {
      var fsEl = document.fullscreenElement || document.webkitFullscreenElement;
      if (fsEl !== self.container) return;
      setTimeout(function () {
        if (self.destroyed) return;
        self.chart.resize(self.chartEl.clientWidth, self.chartEl.clientHeight);
      }, 60);
    };
    document.addEventListener('fullscreenchange', this._fsChangeSub);
    document.addEventListener('webkitfullscreenchange', this._fsChangeSub);

    // Click-to-draw + crosshair legend/draft preview (drawing works into the
    // empty space to the right of the data via the extrapolated time anchor).
    // Handlers are stored so destroy() can unsubscribe them cleanly.
    this._clickSub = function (param) { self.handleChartClick(param); };
    this.chart.subscribeClick(this._clickSub);
    this._crossSub = function (param) {
      if (self.destroyed) return;
      if (self.draft && param.point) {
        var t = self.resolveTimeAtPoint(param);
        if (t) {
          self.draft.t2 = t;
          self.draft.p2 = self.series.candle.coordinateToPrice(param.point.y);
          self.primitive.requestUpdate();
        }
      }
      var cd = param.seriesData ? param.seriesData.get(self.series.candle) : undefined;
      self.updateLegend(cd);
    };
    this.chart.subscribeCrosshairMove(this._crossSub);

    // Infinite scroll-back: reaching the left edge loads older candles. Also
    // defends against lightweight-charts producing a corrupt (NaN / inverted)
    // logical range after aggressive zoom+pan - restore the last good range
    // instead of rendering garbage (empty chart + stray horizontal lines).
    this._rangeSub = function (range) {
      if (self.destroyed) return;
      if (self._resetting) return;                 // programmatic reset - not a user scroll
      if (!range) return;
      // Persist the view (debounced) + refresh the volume-profile window for
      // EVERY valid range change - including after scroll-back is exhausted
      // (historyDone), so pan/zoom always survives a reload.
      if (isFinite(range.from) && isFinite(range.to) && range.from <= range.to) {
        self._lastView = { from: range.from, to: range.to };
        if (self.volProfile) {
          self.computeVolProfile();
          if (self.primitive) self.primitive.requestUpdate();
        }
        if (!self._viewSaveTimer) {
          self._viewSaveTimer = setTimeout(function () {
            self._viewSaveTimer = null;
            saveLayout();
          }, 500);
        }
      }
      if (self.loadingMore || self.historyDone) return;
      if (!isFinite(range.from) || !isFinite(range.to) || range.from > range.to) {
        // A single transient NaN during a fast wheel-zoom is normal - only
        // restore the last good view when the range is STUCK corrupt (2+).
        self._corruptCount = (self._corruptCount || 0) + 1;
        if (self._corruptCount > 2 && self._lastGoodRange && self.chart) {
          self.chart.timeScale().setVisibleLogicalRange(self._lastGoodRange);
        }
        return;
      }
      self._corruptCount = 0;
      self._lastGoodRange = { from: range.from, to: range.to };
      // Load older candles ONLY when the user SCROLLS to the left edge - not
      // when they zoom out (zooming also drives `from` to 0, and prepending
      // up to 15k candles mid-zoom froze the chart and yanked the view).
      // PANNING preserves barSpacing exactly while zooming changes it, so
      // barSpacing constancy is the reliable scroll-vs-zoom discriminator
      // (range width is NOT: wheel zoom moves it ~10-20% per notch, which
      // a width tolerance would misread as a scroll).
      var bs = self.chart.timeScale().getBarSpacing
        ? self.chart.timeScale().getBarSpacing() : null;
      var lastBs = self._lastBarSpacing;
      if (bs != null) self._lastBarSpacing = bs;
      var scrolled = bs != null && lastBs != null && Math.abs(bs - lastBs) <= 0.5;
      if (scrolled && range.from <= 0 && self.candles.length) self.loadMore();
    };
    this.chart.timeScale().subscribeVisibleLogicalRangeChange(this._rangeSub);

    // TradingView-style right-click: open the context menu on the chart.
    this._ctxSub = function (ev) {
      ev.preventDefault();
      self.showContextMenu(ev.clientX, ev.clientY);
    };
    this.chartEl.addEventListener('contextmenu', this._ctxSub);

    // Draggable drawings (TradingView-style): grab any drawing to MOVE it,
    // or drag its anchor handles to RESIZE it. window listeners so the drag
    // keeps tracking even when the pointer leaves the pane.
    this._ptrDownSub = function (ev) { self.handlePtrDown(ev); };
    this._ptrMoveSub = function (ev) { self.handlePtrMove(ev); };
    this._ptrUpSub = function (ev) { self.handlePtrUp(ev); };
    // Capture phase: when a drawing is grabbed we stopPropagation() BEFORE
    // the chart's own canvas listener runs, so the chart can never start a
    // pan gesture under a drawing drag (the pane would slide while you move
    // the line).
    this.chartEl.addEventListener('pointerdown', this._ptrDownSub, true);
    window.addEventListener('pointermove', this._ptrMoveSub);
    window.addEventListener('pointerup', this._ptrUpSub);
  };

  /* ------------------- draggable drawings (move / resize) ---------------- */
  Pane.prototype.findDrawing = function (id) {
    for (var i = 0; i < this.drawn.length; i++) {
      if (this.drawn[i].id === id) return this.drawn[i];
    }
    return null;
  };

  Pane.prototype.handlePtrDown = function (ev) {
    if (this.destroyed) return;
    if (ev.button !== 0) return;
    if (this.activeTool) return;            // drawing tools own their clicks
    // Only grab drawings from the chart canvas itself - pointerdowns on the
    // legend / AI notes / loading spinner must pass through untouched.
    if (!ev.target || ev.target.tagName !== 'CANVAS') return;
    var rect = this.chartEl.getBoundingClientRect();
    var x = ev.clientX - rect.left, y = ev.clientY - rect.top;
    var hit = this.hitTest(x, y);
    this._drag = null;
    this._dragMoved = false;
    if (!hit) return;
    this.selectedId = hit.id;
    if (this.primitive) this.primitive.requestUpdate();
    var twoAnchor = hit.type === 'trendline' || hit.type === 'rect' || hit.type === 'fib' ||
                    hit.type === 'measure';
    var mode = 'move';
    if (twoAnchor) {
      var a1 = this._anchorPt(hit, 1), a2 = this._anchorPt(hit, 2);
      if (a1.x != null && a1.y != null && Math.hypot(x - a1.x, y - a1.y) <= 10) mode = 'a1';
      else if (a2.x != null && a2.y != null && Math.hypot(x - a2.x, y - a2.y) <= 10) mode = 'a2';
    }
    this._drag = {
      id: hit.id, mode: mode, startX: x, startY: y,
      orig: JSON.parse(JSON.stringify(hit)),
    };
    this.chartEl.style.cursor = mode === 'move' ? 'move' : 'crosshair';
    // While dragging, stop the chart's own mouse-pan so the pane doesn't
    // slide under the drawing (belt-and-suspenders: the capture-phase
    // stopPropagation above already keeps this gesture away from the chart).
    try { this.chart.applyOptions({ handleScroll: { pressedMouseMove: false } }); } catch (e) {}
    ev.preventDefault();
    ev.stopPropagation();
  };

  // Screen/pane pixel position of a drawing anchor (null when off-screen).
  Pane.prototype._anchorPt = function (d, which) {
    var ts = this.chart.timeScale();
    var t = which === 1 ? d.t1 : d.t2;
    var p = which === 1 ? d.p1 : d.p2;
    return {
      x: t == null ? null : ts.timeToCoordinate(t),
      y: p == null ? null : this.series.candle.priceToCoordinate(p),
    };
  };

  Pane.prototype.handlePtrMove = function (ev) {
    var drag = this._drag;
    if (!drag) return;
    var rect = this.chartEl.getBoundingClientRect();
    var x = ev.clientX - rect.left, y = ev.clientY - rect.top;
    if (Math.hypot(x - drag.startX, y - drag.startY) > 3) this._dragMoved = true;
    var d = this.findDrawing(drag.id);
    if (!d) { this._drag = null; this.chartEl.style.cursor = ''; return; }
    var ts = this.chart.timeScale();
    var series = this.series.candle;
    // Pixels -> seconds/bar and price/px so 'move' translates smoothly even
    // when the drawing sits in the empty space beyond the last candle.
    var secPerPx = 0, pricePerPx = 0;
    var n = this.candles.length;
    if (n >= 2) {
      var last = this.candles[n - 1], prev = this.candles[n - 2];
      var xLast = ts.timeToCoordinate(last.time), xPrev = ts.timeToCoordinate(prev.time);
      if (xLast != null && xPrev != null && xLast !== xPrev) {
        secPerPx = (last.time - prev.time) / (xLast - xPrev);
      }
    }
    var yA = 10, yB = Math.max(20, this.chartEl.clientHeight - 10);
    var pA = series.coordinateToPrice(yA), pB = series.coordinateToPrice(yB);
    if (pA != null && pB != null && yB !== yA) pricePerPx = (pB - pA) / (yB - yA);
    var dt = (x - drag.startX) * secPerPx;
    var dp = (y - drag.startY) * pricePerPx;    // y grows down -> dp negative when dragging down
    var orig = drag.orig;

    if (drag.mode === 'move') {
      if (d.type === 'hLine') {
        if (orig.p1 != null) d.p1 = orig.p1 + dp;
      } else if (d.type === 'vLine') {
        if (orig.t1 != null) d.t1 = orig.t1 + dt;
      } else if (d.type === 'hRay') {
        if (orig.p1 != null) d.p1 = orig.p1 + dp;
        if (orig.t1 != null) d.t1 = orig.t1 + dt;
      } else {
        if (orig.t1 != null) d.t1 = orig.t1 + dt;
        if (orig.t2 != null) d.t2 = orig.t2 + dt;
        if (orig.p1 != null) d.p1 = orig.p1 + dp;
        if (orig.p2 != null) d.p2 = orig.p2 + dp;
      }
    } else {
      // Anchor resize: snap the dragged handle to the pointer (time/price).
      var t = this.resolveTimeAtPoint({ point: { x: x, y: y } });
      var price = series.coordinateToPrice(y);
      if (drag.mode === 'a1') { if (t != null) d.t1 = t; if (price != null) d.p1 = price; }
      else { if (t != null) d.t2 = t; if (price != null) d.p2 = price; }
    }
    if (this.primitive) this.primitive.requestUpdate();
  };

  Pane.prototype.handlePtrUp = function () {
    var wasMoved = this._dragMoved;
    if (!this._drag) return;
    this._drag = null;
    this.chartEl.style.cursor = '';
    try { this.chart.applyOptions({ handleScroll: { pressedMouseMove: true } }); } catch (e) {}
    if (this.primitive) this.primitive.requestUpdate();
    this.renderDrawingManager();
    this.updateDrawBtn();
    // A click on a drawing selects it (pointerdown) - with the chart's own
    // pointerdown swallowed by the capture-phase grab, the chart's click
    // event never fires, so surface the selection toast here for real clicks.
    if (!wasMoved && this.selectedId) {
      var sel = this.findDrawing(this.selectedId);
      if (sel) toast('✏️ Selected ' + (sel.type || 'drawing') + ' — press Delete to remove');
    }
  };

  /* ----------------------- right-click context menu ---------------------- */
  Pane.prototype.showContextMenu = function (x, y) {
    if (!ctxMenu) return;
    var self = this;
    var items = [
      { icon: '⟲', label: 'Reset chart view', fn: function () { self.resetView(); } },
      { icon: '📊', label: 'Toggle volume', fn: function () { self.toggleVolume(); } },
      { icon: '📸', label: 'Screenshot', fn: function () { self.screenshot(); } },
      { icon: '⛶', label: 'Toggle fullscreen', fn: function () { self.toggleFullscreen(); } },
      { sep: true },
      { icon: '🔮', label: 'Kronos AI forecast', fn: function () { self.runKronos(true); } },
    ];
    var html = '';
    items.forEach(function (it) {
      if (it.sep) { html += '<div class="ctx-sep"></div>'; return; }
      html += '<div class="ctx-item"><span class="ctx-ic">' + it.icon +
              '</span><span class="ctx-lb">' + it.label + '</span></div>';
    });
    ctxMenu.innerHTML = html;
    var nodes = ctxMenu.querySelectorAll('.ctx-item');
    var j = 0;
    items.forEach(function (it) {
      if (it.sep) return;
      if (nodes[j]) nodes[j].__fn = it.fn;   // guard: trailing separator safe
      j += 1;
    });
    nodes.forEach(function (n) {
      n.addEventListener('click', function () {
        if (n.__fn) n.__fn();
        hideContextMenu();
      });
    });
    ctxMenu.hidden = false;
    var w = ctxMenu.offsetWidth, h = ctxMenu.offsetHeight;
    ctxMenu.style.left = Math.max(4, Math.min(x, window.innerWidth - w - 8)) + 'px';
    ctxMenu.style.top = Math.max(4, Math.min(y, window.innerHeight - h - 8)) + 'px';
  };

  Pane.prototype.toggleFullscreen = function () {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (this.container.requestFullscreen) this.container.requestFullscreen();
  };

  Pane.prototype.screenshot = function () {
    try {
      var canvas = this.chart.takeScreenshot();
      var a = document.createElement('a');
      a.download = 'kronos_' + this.symbol.replace(/[^a-z0-9]+/gi, '_') + '_' + this.interval + '.png';
      a.href = canvas.toDataURL('image/png');
      a.click();
      toast('📸 Screenshot saved');
    } catch (e) {
      toast('Screenshot failed: ' + e.message, 'err');
    }
  };

  /* ------------------------------ drawing tools --------------------------- */
  // A single series primitive renders every committed drawing (and the live
  // draft) each frame, converting time/price via the series coordinate API.
  function DrawingsPrimitive(chartRef, seriesRef, getDrawings, getDraft, getBand, getSelected, getSession, getVolProfile) {
    this._chart = chartRef;
    this._series = seriesRef;
    this._getDrawings = getDrawings;
    this._getDraft = getDraft;
    this._getBand = getBand || null;
    this._getSelected = getSelected || null;
    this._getSession = getSession || null;
    this._getVolProfile = getVolProfile || null;
    this._requestUpdate = null;
    this._host = null;
  }
  DrawingsPrimitive.prototype.attached = function (param) {
    this._chart = param.chart;
    this._series = param.series;
    this._requestUpdate = param.requestUpdate;
    this._host = param.series;
  };
  DrawingsPrimitive.prototype.detached = function () {};
  DrawingsPrimitive.prototype.requestUpdate = function () {
    if (this._requestUpdate) this._requestUpdate();
    else if (this._series && typeof this._series.applyOptions === 'function') {
      this._series.applyOptions({});
    }
  };
  DrawingsPrimitive.prototype.updateAllViews = function () {};
  DrawingsPrimitive.prototype.paneViews = function () {
    return [new DrawingsPaneView(this._chart, this._series,
                                 this._getDrawings, this._getDraft, this._getBand,
                                 this._getSelected, this._getSession, this._getVolProfile)];
  };

  function DrawingsPaneView(chartRef, seriesRef, getDrawings, getDraft, getBand, getSelected, getSession, getVolProfile) {
    this._chart = chartRef;
    this._series = seriesRef;
    this._getDrawings = getDrawings;
    this._getDraft = getDraft;
    this._getBand = getBand || null;
    this._getSelected = getSelected || null;
    this._getSession = getSession || null;
    this._getVolProfile = getVolProfile || null;
  }
  DrawingsPaneView.prototype.update = function () {};
  DrawingsPaneView.prototype.renderer = function () {
    var self = this;
    return {
      draw: function (target) {
        target.useMediaCoordinateSpace(function (scope) {
          var ctx = scope.context;
          var w = scope.mediaSize.width;
          var h = scope.mediaSize.height;
          self._drawVolProfile(ctx, w, h);
          self._drawSessionBreaks(ctx, w, h);
          self._drawBand(ctx, w, h);
          var selId = self._getSelected ? self._getSelected() : null;
          self._getDrawings().forEach(function (d) { self._draw(ctx, w, h, d, false, d.id === selId); });
          var draft = self._getDraft();
          if (draft) self._draw(ctx, w, h, draft, true);
        });
      },
    };
  };

  // Volume-at-price histogram pinned to the RIGHT edge of the pane: candle
  // volumes bucketed into price bins, bar width proportional to the volume
  // in that bin, colored by whether buying (up close) or selling dominated.
  // The POC (point of control) bin gets a highlight outline.
  DrawingsPaneView.prototype._drawVolProfile = function (ctx, w, h) {
    var bins = this._getVolProfile ? this._getVolProfile() : null;
    if (!bins || !bins.length) return;
    var series = this._series;
    var maxW = Math.max(48, w * 0.12);
    ctx.save();
    for (var i = 0; i < bins.length; i++) {
      var b = bins[i];
      var y = series.priceToCoordinate(b.lo);
      var y2 = series.priceToCoordinate(b.hi);
      if (y == null || y2 == null) continue;
      var top = Math.min(y, y2);
      var bh = Math.max(2, Math.abs(y2 - y) - 1);
      var total = b.up + b.down;
      if (total <= 0) continue;
      var width = Math.max(3, maxW * (b.w || 0));
      ctx.globalAlpha = 0.6;
      ctx.fillStyle = b.up >= b.down ? 'rgba(8,153,129,0.65)' : 'rgba(242,54,69,0.65)';
      ctx.fillRect(w - width, top, width, bh);
    }
    ctx.globalAlpha = 1;
    var maxT = 0, poc = -1;
    for (var j = 0; j < bins.length; j++) {
      if (bins[j].up + bins[j].down > maxT) { maxT = bins[j].up + bins[j].down; poc = j; }
    }
    if (poc >= 0) {
      var pb = bins[poc];
      var py = series.priceToCoordinate(pb.lo);
      var py2 = series.priceToCoordinate(pb.hi);
      if (py != null && py2 != null) {
        ctx.strokeStyle = 'rgba(255,183,77,0.85)';
        ctx.lineWidth = 1;
        ctx.strokeRect(w - maxW - 3, Math.min(py, py2) - 1, maxW + 3, Math.max(2, Math.abs(py2 - py) + 1));
      }
    }
    ctx.restore();
  };

  // TradingView-style session breaks: faint dotted vertical lines where a
  // market session ends and the next one begins (overnight close->open and
  // weekends). Toggleable via the right-click menu (⚡ Session breaks).
  DrawingsPaneView.prototype._drawSessionBreaks = function (ctx, w, h) {
    var st = this._getSession && this._getSession();
    if (!st || !st.on || !st.breaks || !st.breaks.length) return;
    var ts = this._chart.timeScale();
    ctx.save();
    ctx.strokeStyle = 'rgba(66, 165, 245, 0.75)';  // light blue — clearly visible, distinct from BB/SMA lines
    ctx.lineWidth = 1.5;
    ctx.setLineDash([2, 4]);
    for (var i = 0; i < st.breaks.length; i++) {
      var x = ts.timeToCoordinate(st.breaks[i]);
      if (x == null) continue;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    ctx.restore();
  };

  // Kronos probabilistic band: a translucent filled region between the
  // forecast's lower and upper confidence paths (from the multi-sample
  // server run). Drawn behind every drawing, like a TradingView channel.
  DrawingsPaneView.prototype._drawBand = function (ctx, w, h) {
    var band = this._getBand && this._getBand();
    if (!band || !band.length) return;
    var ts = this._chart.timeScale();
    var pts = [];
    for (var i = 0; i < band.length; i++) {
      var x = ts.timeToCoordinate(band[i].time);
      if (x == null) continue;
      var yLo = this._series.priceToCoordinate(band[i].lo);
      var yHi = this._series.priceToCoordinate(band[i].hi);
      if (yLo == null || yHi == null) continue;
      pts.push({ x: x, yLo: yLo, yHi: yHi });
    }
    if (pts.length < 2) return;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].yHi);
    for (var i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].yHi);
    for (var i = pts.length - 1; i >= 0; i--) ctx.lineTo(pts[i].x, pts[i].yLo);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,183,77,0.14)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,183,77,0.35)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.stroke();
    ctx.restore();
  };
  DrawingsPaneView.prototype._xy = function (d, w, h) {
    // x from the TIME SCALE; y from the series price scale. Times beyond the
    // last candle (or before the first) return null from timeToCoordinate -
    // clamp to the pane edges so trendlines can extend into empty space.
    var ts = this._chart.timeScale();
    var x1 = d.t1 == null ? null : ts.timeToCoordinate(d.t1);
    var x2 = d.t2 == null ? null : ts.timeToCoordinate(d.t2);
    if (x1 == null && d.t1 != null) x1 = 0;
    if (x2 == null && d.t2 != null) x2 = w;
    return {
      x1: x1,
      y1: d.p1 == null ? null : this._series.priceToCoordinate(d.p1),
      x2: x2,
      y2: d.p2 == null ? null : this._series.priceToCoordinate(d.p2),
    };
  };
  DrawingsPaneView.prototype._draw = function (ctx, w, h, d, draft, selected) {
    var c = this._xy(d, w, h);
    ctx.save();
    ctx.lineWidth = selected ? 3 : (draft ? 1 : 1.5);
    ctx.setLineDash(draft && !selected ? [5, 4] : []);
    ctx.strokeStyle = selected ? '#ffffff' : (d.color || COLORS.drawing);
    ctx.fillStyle = d.color || COLORS.drawing;
    if (d.type === 'trendline' || d.type === 'rect') {
      if (c.x1 == null || c.y1 == null || c.x2 == null || c.y2 == null) { ctx.restore(); return; }
      if (d.type === 'rect') {
        var rx = Math.min(c.x1, c.x2), ry = Math.min(c.y1, c.y2);
        ctx.globalAlpha = draft ? 0.18 : 0.08;
        ctx.fillRect(rx, ry, Math.abs(c.x2 - c.x1), Math.abs(c.y2 - c.y1));
        ctx.globalAlpha = 1;
        ctx.strokeRect(rx, ry, Math.abs(c.x2 - c.x1), Math.abs(c.y2 - c.y1));
      } else {
        ctx.beginPath(); ctx.moveTo(c.x1, c.y1); ctx.lineTo(c.x2, c.y2); ctx.stroke();
      }
    } else if (d.type === 'hLine') {
      if (c.y1 == null) { ctx.restore(); return; }
      ctx.beginPath(); ctx.moveTo(0, c.y1); ctx.lineTo(w, c.y1); ctx.stroke();
      if (d.p1 != null) {
        ctx.setLineDash([]);
        ctx.font = '10px sans-serif';
        ctx.fillText(d.p1.toFixed(2), 4, c.y1 - 4);
      }
    } else if (d.type === 'hRay') {
      if (c.x1 == null || c.y1 == null) { ctx.restore(); return; }
      ctx.beginPath(); ctx.moveTo(c.x1, c.y1); ctx.lineTo(w, c.y1); ctx.stroke();
    } else if (d.type === 'vLine') {
      if (c.x1 == null) { ctx.restore(); return; }
      ctx.beginPath(); ctx.moveTo(c.x1, 0); ctx.lineTo(c.x1, h); ctx.stroke();
    } else if (d.type === 'measure') {
      // Measure tool (TradingView): line between two points + a floating box
      // with the price change, % change and bar count in between.
      if (c.x1 == null || c.y1 == null || c.x2 == null || c.y2 == null) { ctx.restore(); return; }
      ctx.beginPath(); ctx.moveTo(c.x1, c.y1); ctx.lineTo(c.x2, c.y2); ctx.stroke();
      var stt = this._getSession && this._getSession();
      var secPerBar = stt && stt.interval ? (INTERVAL_MS[stt.interval] || 60000) / 1000 : 60;
      var dP = d.p2 - d.p1;
      var pctM = d.p1 !== 0 ? (dP / d.p1) * 100 : 0;
      var nBars = Math.round(Math.abs(d.t2 - d.t1) / secPerBar);
      var mx = (c.x1 + c.x2) / 2, my = (c.y1 + c.y2) / 2;
      var txt = (dP >= 0 ? '+' : '') + dP.toFixed(2) + '  (' +
                (pctM >= 0 ? '+' : '') + pctM.toFixed(2) + '%)  ' + nBars + ' bars';
      ctx.font = '11px sans-serif';
      var tw = ctx.measureText(txt).width + 12;
      ctx.fillStyle = 'rgba(24,28,38,0.92)';
      ctx.strokeStyle = 'rgba(117,134,150,0.6)';
      ctx.fillRect(mx - tw / 2, my - 22, tw, 19);
      ctx.strokeRect(mx - tw / 2, my - 22, tw, 19);
      ctx.fillStyle = '#d1d4dc';
      ctx.fillText(txt, mx - tw / 2 + 6, my - 8);
      ctx.beginPath();
      ctx.arc(c.x1, c.y1, 3, 0, Math.PI * 2);
      ctx.arc(c.x2, c.y2, 3, 0, Math.PI * 2);
      ctx.fill();
    } else if (d.type === 'fib') {
      // Fib retracement: 7 standard levels between anchor p1 and p2, drawn
      // across the whole pane with the retracement % + price labelled on
      // the right edge, exactly like TradingView's Fib tool.
      if (c.y1 == null || c.y2 == null || c.x1 == null) { ctx.restore(); return; }
      var ratios = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
      var span = c.y2 - c.y1;
      ctx.font = '10px sans-serif';
      for (var i = 0; i < ratios.length; i++) {
        var y = c.y1 + span * ratios[i];
        var pct = ratios[i] * 100;
        var lbl = (pct === 0 || pct === 100) ? pct.toFixed(0) + '%' : pct.toFixed(1) + '%';
        var pr = d.p1 + (d.p2 - d.p1) * ratios[i];
        ctx.globalAlpha = draft ? 0.5 : 0.85;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.fillText(lbl + '  ' + pr.toFixed(2), 4, y - 3);
      }
    } else if (d.type === 'text') {
      if (c.x1 == null || c.y1 == null) { ctx.restore(); return; }
      ctx.font = 'bold 12px sans-serif';
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.lineWidth = 3;
      ctx.strokeText(d.text || '', c.x1 + 4, c.y1 - 4);
      ctx.fillStyle = '#e8ecf8';
      ctx.fillText(d.text || '', c.x1 + 4, c.y1 - 4);
    } else if (d.type === 'zigzag' && d.points && d.points.length >= 2) {
      var ts = this._chart.timeScale();
      ctx.beginPath();
      var started = false;
      for (var zi = 0; zi < d.points.length; zi++) {
        var zx = ts.timeToCoordinate(d.points[zi].t);
        var zy = this._series.priceToCoordinate(d.points[zi].p);
        if (zx == null || zy == null) continue;
        if (!started) { ctx.moveTo(zx, zy); started = true; }
        else ctx.lineTo(zx, zy);
      }
      ctx.stroke();
    } else if (d.type === 'slevel') {
      if (c.y1 == null) { ctx.restore(); return; }
      ctx.setLineDash(d.dash || [4, 4]);
      ctx.globalAlpha = 0.8;
      ctx.beginPath(); ctx.moveTo(0, c.y1); ctx.lineTo(w, c.y1); ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.setLineDash([]);
      if (d.label) {
        ctx.font = '10px sans-serif';
        ctx.fillText(d.label, 4, c.y1 - 3);
      }
    } else if (d.type === 'arrowUp' || d.type === 'arrowDown') {
      if (c.x1 == null || c.y1 == null) { ctx.restore(); return; }
      var dir = d.type === 'arrowUp' ? -1 : 1;   // canvas y grows downward
      var sz = 11;
      var ax = c.x1, ay = c.y1;
      ctx.beginPath();
      ctx.moveTo(ax, ay + dir * sz);
      ctx.lineTo(ax - sz * 0.62, ay - dir * sz * 0.55);
      ctx.lineTo(ax + sz * 0.62, ay - dir * sz * 0.55);
      ctx.closePath();
      ctx.fillStyle = d.type === 'arrowUp' ? COLORS.up : COLORS.down;
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    if (selected) {
      // Selection highlight: white anchor handles at the drawing's endpoints
      // so it reads clearly as "this drawing is selected - Delete removes it".
      ctx.setLineDash([]);
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#2962ff';
      ctx.lineWidth = 1.5;
      var pts = [];
      if (c.x1 != null && c.y1 != null) pts.push([c.x1, c.y1]);
      if (d.type !== 'hLine' && d.type !== 'vLine' &&
          c.x2 != null && c.y2 != null) pts.push([c.x2, c.y2]);
      if (d.type === 'hLine' && c.y1 != null) pts.push([w - 1, c.y1]);
      if (d.type === 'vLine' && c.x1 != null) pts.push([c.x1, 1]);
      for (var hh = 0; hh < pts.length; hh++) {
        ctx.beginPath();
        ctx.arc(pts[hh][0], pts[hh][1], 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    }
    ctx.restore();
  };

  // Resolve the time at a click/crosshair point. param.time is null in the
  // empty space to the RIGHT of the last candle - extrapolate a synthetic
  // future time from the bar spacing so drawings can be placed there.
  Pane.prototype.resolveTimeAtPoint = function (param) {
    if (param.time) return param.time;
    if (!param.point) return null;
    var ts = this.chart.timeScale();
    var t = ts.coordinateToTime(param.point.x);
    if (t) return t;
    var n = this.candles.length;
    if (n < 2) return null;
    var last = this.candles[n - 1], prev = this.candles[n - 2];
    var xLast = ts.timeToCoordinate(last.time);
    var xPrev = ts.timeToCoordinate(prev.time);
    if (xLast == null || xPrev == null) return null;
    var dt = last.time - prev.time;             // seconds per bar
    var dx = xLast - xPrev;                     // pixels per bar
    if (!dx) return null;
    return Math.round(last.time + ((param.point.x - xLast) / dx) * dt);
  };

  Pane.prototype.setActiveTool = function (tool) {
    this.activeTool = tool;
    this.draft = null;
    var btns = document.querySelectorAll('#drawing-buttons .tv-btn[data-tool]');
    btns.forEach(function (b) {
      b.classList.toggle('tv-btn-active', b.getAttribute('data-tool') === tool);
    });
    if (tool) toast('✏️ Draw tool: ' + tool + ' — click the focused chart' +
      (tool === 'trendline' || tool === 'rect' || tool === 'fib' || tool === 'measure' ? ' (2 clicks)' : ' (1 click)'));
  };

  Pane.prototype.handleChartClick = function (param) {
    if (!param.point) return;
    // A drag (move/resize) just ended - the click that follows it must not
    // be treated as a fresh selection or drawing action.
    if (this._dragMoved) { this._dragMoved = false; return; }
    if (!this.activeTool) {
      // No drawing tool active: a click selects the nearest drawing so it can
      // be removed individually (Delete key / drawings manager), or clears the
      // selection when it lands on empty space - TradingView-style object
      // picking instead of a blunt clear-all.
      var hit = this.hitTest(param.point.x, param.point.y);
      this.selectedId = hit ? hit.id : null;
      if (this.primitive) this.primitive.requestUpdate();
      this.renderDrawingManager();
      this.updateDrawBtn();
      if (hit) toast('✏️ Selected ' + (hit.type || 'drawing') + ' — press Delete to remove');
      return;
    }
    var t = this.resolveTimeAtPoint(param);
    if (t == null) return;
    var price = this.series.candle.coordinateToPrice(param.point.y);
    if (price == null) return;

    var oneClick = this.activeTool === 'hLine' || this.activeTool === 'vLine' ||
                   this.activeTool === 'hRay' || this.activeTool === 'text' ||
                   this.activeTool === 'arrowUp' || this.activeTool === 'arrowDown';
    if (oneClick) {
      var d = {
        id: this.nextId++, type: this.activeTool,
        t1: t, p1: price, t2: null, p2: null, color: this.drawColor || COLORS.drawing,
      };
      if (this.activeTool === 'text') {
        var txt = window.prompt('Text label:', '');
        if (txt === null) { this.setActiveTool(null); return; }
        d.text = txt || 'text';
      }
      this.drawn.push(d);
      // A drawn horizontal line also arms a server-side price alert (toast
      // fires even on a pane that isn't focused).
      if (d.type === 'hLine' && d.p1 != null) this.setPriceAlert(d.p1);
      this.setActiveTool(null);
      this.primitive.requestUpdate();
      this.updateDrawBtn();
      this.renderDrawingManager();
      saveLayout();
      return;
    }
    if (!this.draft) {
      this.draft = {
        id: -1, type: this.activeTool, t1: t, p1: price, t2: null, p2: null,
        color: this.drawColor || COLORS.drawing,
      };
    } else {
      this.drawn.push({
        id: this.nextId++, type: this.activeTool,
        t1: this.draft.t1, p1: this.draft.p1, t2: t, p2: price,
        color: this.drawColor || COLORS.drawing,
      });
      this.draft = null;
      this.setActiveTool(null);
      this.updateDrawBtn();
      this.renderDrawingManager();
    }
    this.primitive.requestUpdate();
  };

  Pane.prototype.clearDrawings = function () {
    // Keep auto overlays (S/R, zigzag) - they are chart-managed, not user
    // drawings; "Clear drawings" only removes the user's own objects.
    this.drawn = this.drawn.filter(function (d) { return d.auto; });
    this.draft = null;
    this.selectedId = null;
    this.setActiveTool(null);
    this.primitive.requestUpdate();
    this.renderDrawingManager();
    this.updateDrawBtn();
  };

  // ---- selective drawing deletion (TradingView-style object picking) ----
  // The same time/price coordinate mapping the renderer uses, in pixel space.
  Pane.prototype._drawCoords = function (d) {
    var ts = this.chart.timeScale();
    var series = this.series.candle;
    var x1 = d.t1 == null ? null : ts.timeToCoordinate(d.t1);
    var x2 = d.t2 == null ? null : ts.timeToCoordinate(d.t2);
    if (x1 == null && d.t1 != null) x1 = 0;
    if (x2 == null && d.t2 != null) x2 = 100000;
    return {
      x1: x1,
      y1: d.p1 == null ? null : series.priceToCoordinate(d.p1),
      x2: x2,
      y2: d.p2 == null ? null : series.priceToCoordinate(d.p2),
    };
  };

  Pane.prototype._distToSegment = function (px, py, ax, ay, bx, by) {
    var dx = bx - ax, dy = by - ay;
    if (dx === 0 && dy === 0) return Math.hypot(px - ax, py - ay);
    var t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy);
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  };

  // Distance (px) from a click to a committed drawing, or null when missed.
  Pane.prototype._drawingHit = function (d, x, y) {
    var c = this._drawCoords(d);
    if (d.type === 'hLine') {
      if (c.y1 == null) return null;
      return Math.abs(y - c.y1) <= 8 ? Math.abs(y - c.y1) : null;
    }
    if (d.type === 'hRay') {
      if (c.y1 == null || c.x1 == null || x < c.x1 - 8) return null;
      return Math.abs(y - c.y1) <= 8 ? Math.abs(y - c.y1) : null;
    }
    if (d.type === 'vLine') {
      if (c.x1 == null) return null;
      return Math.abs(x - c.x1) <= 8 ? Math.abs(x - c.x1) : null;
    }
    if (d.type === 'rect') {
      if (c.x1 == null || c.y1 == null || c.x2 == null || c.y2 == null) return null;
      var l = Math.min(c.x1, c.x2), r = Math.max(c.x1, c.x2);
      var t = Math.min(c.y1, c.y2), b = Math.max(c.y1, c.y2);
      if (x >= l && x <= r && y >= t && y <= b) return 0;
      var edge = Math.min(Math.abs(x - l), Math.abs(x - r),
                          Math.abs(y - t), Math.abs(y - b));
      return edge <= 8 ? edge : null;
    }
    if (d.type === 'fib') {
      if (c.y1 == null || c.y2 == null || c.x1 == null) return null;
      if (x < 0) return null;
      var ratios = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
      var best = null;
      for (var i = 0; i < ratios.length; i++) {
        var yl = c.y1 + (c.y2 - c.y1) * ratios[i];
        var dist = Math.abs(y - yl);
        if (dist <= 8 && (best === null || dist < best)) best = dist;
      }
      return best;
    }
    if (d.type === 'trendline' || d.type === 'measure') {
      if (c.x1 == null || c.y1 == null || c.x2 == null || c.y2 == null) return null;
      var dl = this._distToSegment(x, y, c.x1, c.y1, c.x2, c.y2);
      return dl <= 8 ? dl : null;
    }
    // text / arrows: distance to the anchor point.
    if (c.x1 != null && c.y1 != null) {
      var dp = Math.hypot(x - c.x1, y - c.y1);
      return dp <= 10 ? dp : null;
    }
    return null;
  };

  // Topmost drawing within tolerance of the click point (or null).
  Pane.prototype.hitTest = function (x, y) {
    var best = null, bestDist = 9;
    for (var i = this.drawn.length - 1; i >= 0; i--) {
      if (this.drawn[i].auto) continue;   // auto overlays (S/R, zigzag) aren't interactive
      var dist = this._drawingHit(this.drawn[i], x, y);
      if (dist !== null && dist < bestDist) { bestDist = dist; best = this.drawn[i]; }
    }
    return best;
  };

  // Remove ONE drawing by id (Delete key / manager row). Returns success.
  Pane.prototype.deleteDrawing = function (id) {
    var idx = -1;
    for (var i = 0; i < this.drawn.length; i++) {
      if (this.drawn[i].id === id) { idx = i; break; }
    }
    if (idx < 0) return false;
    if (this.drawn[idx].auto) return false;   // auto overlays can't be deleted
    var d = this.drawn[idx];
    this.drawn.splice(idx, 1);
    if (this.selectedId === id) this.selectedId = null;
    this.primitive.requestUpdate();
    this.renderDrawingManager();
    this.updateDrawBtn();
    toast('🗑 Deleted ' + (d.type || 'drawing'));
    return true;
  };

  // Ctrl+Z / Cmd+Z: remove the most recently added drawing on this pane.
  Pane.prototype.undoDrawing = function () {
    // Pop the most recent USER drawing - auto overlays (S/R, zigzag) are
    // managed by the chart, not the undo stack.
    var idx = -1;
    for (var i = this.drawn.length - 1; i >= 0; i--) {
      if (!this.drawn[i].auto) { idx = i; break; }
    }
    if (idx < 0) { toast('Nothing to undo', 'err'); return; }
    var d = this.drawn.splice(idx, 1)[0];
    this.selectedId = null;
    this.primitive.requestUpdate();
    this.renderDrawingManager();
    this.updateDrawBtn();
    toast('↩ Undid ' + (d.type || 'drawing'));
  };

  /* --------------------------- chart type + indicators -------------------- */
  Pane.prototype.applyChartType = function () {
    var t = this.chartType;
    this.series.candle.applyOptions({ visible: t === 'candles' || t === 'heikin-ashi' || t === 'renko' });
    this.series.bar.applyOptions({ visible: t === 'bars' });
    this.series.line.applyOptions({ visible: t === 'line' });
    this.series.area.applyOptions({ visible: t === 'area' });
    var target = t === 'bars' ? this.series.bar
      : (t === 'line' ? this.series.line
        : (t === 'area' ? this.series.area : this.series.candle));
    this.renderMainSeries();
    // Live rendering now updates only the ACTIVE series (rAF-batched in
    // _flushLiveRender), so the freshly-activated series must catch up on
    // the forming candle that was previously only pushed to the old one.
    var fc = this.currentCandle;
    if (fc) {
      try {
        if (t === 'bars') this.series.bar.update(fc);
        else if (t === 'line') this.series.line.update({ time: fc.time, value: fc.close });
        else if (t === 'area') this.series.area.update({ time: fc.time, value: fc.close });
        else if (t === 'renko') { /* bricks only change on candle close */ }
        else this.series.candle.update(t === 'heikin-ashi' ? this.displayCandle(fc) : fc);
      } catch (e) {}
    }
    try {
      if (target !== this.primitive._host) {
        var old = this.primitive._host;
        if (old && typeof old.detachPrimitive === 'function') old.detachPrimitive(this.primitive);
        target.attachPrimitive(this.primitive);
        this.primitive._host = target;
      }
    } catch (e) {}
  };

  // Resolve the configured price source for an indicator input series
  // (TradingView's Source selector: Close/Open/High/Low/HL2/HLC3/OHLC4).
  Pane.prototype.srcVal = function (c, src) {
    switch (src) {
      case 'open': return c.open;
      case 'high': return c.high;
      case 'low': return c.low;
      case 'hl2': return (c.high + c.low) / 2;
      case 'hlc3': return (c.high + c.low + c.close) / 3;
      case 'ohlc4': return (c.open + c.high + c.low + c.close) / 4;
      default: return c.close;
    }
  };

  Pane.prototype.smaValues = function (period, src) {
    var out = [], sum = 0;
    for (var i = 0; i < this.candles.length; i++) {
      sum += this.srcVal(this.candles[i], src);
      if (i >= period) sum -= this.srcVal(this.candles[i - period], src);
      if (i >= period - 1) out.push({ time: this.candles[i].time, value: sum / period });
    }
    return out;
  };

  Pane.prototype.emaValues = function (period, src) {
    if (!this.candles.length) return [];
    var k = 2 / (period + 1);
    var prev = this.srcVal(this.candles[0], src);
    var out = [];
    for (var i = 0; i < this.candles.length; i++) {
      var v = this.srcVal(this.candles[i], src);
      prev = i === 0 ? v : v * k + prev * (1 - k);
      if (i >= period - 1) out.push({ time: this.candles[i].time, value: prev });
    }
    return out;
  };

  Pane.prototype.ensureIndSeries = function (key) {
    if (this.indSeries[key]) return this.indSeries[key];
    var cfg = INDICATORS[key];
    var s = this.chart.addSeries(LightweightCharts.LineSeries, {
      color: cfg.color, lineWidth: 1,
      priceLineVisible: false, lastValueVisible: false,
      crosshairMarkerVisible: false,
      autoscaleInfoProvider: function () { return null; },
    });
    this.indSeries[key] = s;
    return s;
  };

  // --- indicator maths (all pure, candle-array based) -------------------
  Pane.prototype.vwapValues = function () {
    // Session-anchored VWAP (typical price * volume / cumulative volume),
    // resetting at each new IST trading day - exactly like TradingView's
    // intraday VWAP that resets every session.
    var out = [], cumPV = 0, cumV = 0, curDay = null;
    for (var i = 0; i < this.candles.length; i++) {
      var c = this.candles[i];
      var day = istDateKey(c.time);
      if (curDay !== day) { curDay = day; cumPV = 0; cumV = 0; }
      var tp = (c.high + c.low + c.close) / 3;
      var vol = c.volume || 0;
      cumPV += tp * vol; cumV += vol;
      if (cumV > 0) out.push({ time: c.time, value: cumPV / cumV });
    }
    return out;
  };

  Pane.prototype.bollValues = function (period, mult, src) {
    // Bollinger Bands: SMA(period) +/− mult * population stddev.
    var out = [];
    for (var i = period - 1; i < this.candles.length; i++) {
      var sum = 0;
      for (var j = i - period + 1; j <= i; j++) sum += this.srcVal(this.candles[j], src);
      var mid = sum / period, sq = 0;
      for (var k = i - period + 1; k <= i; k++) {
        var d = this.srcVal(this.candles[k], src) - mid; sq += d * d;
      }
      var sd = Math.sqrt(sq / period);
      out.push({ time: this.candles[i].time, mid: mid, up: mid + mult * sd, lo: mid - mult * sd });
    }
    return out;
  };

  Pane.prototype.rsiValues = function (period, src) {
    // Wilder-smoothed RSI, the classic momentum oscillator.
    if (this.candles.length < period + 1) return [];
    var out = [], gains = 0, losses = 0;
    for (var i = 1; i <= period; i++) {
      var d = this.srcVal(this.candles[i], src) - this.srcVal(this.candles[i - 1], src);
      if (d >= 0) gains += d; else losses -= d;
    }
    var avgG = gains / period, avgL = losses / period;
    var rsi = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
    out.push({ time: this.candles[period].time, value: rsi });
    for (var i = period + 1; i < this.candles.length; i++) {
      var d = this.srcVal(this.candles[i], src) - this.srcVal(this.candles[i - 1], src);
      avgG = (avgG * (period - 1) + Math.max(d, 0)) / period;
      avgL = (avgL * (period - 1) + Math.max(-d, 0)) / period;
      rsi = avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
      out.push({ time: this.candles[i].time, value: rsi });
    }
    return out;
  };

  Pane.prototype.macdValues = function (fast, slow, signal, src) {
    // MACD: EMA(fast)-EMA(slow) line, its signal EMA, and histogram.
    var emaF = this._emaArr(fast, src), emaS = this._emaArr(slow, src);
    var line = [], hist = [];
    for (var i = 0; i < this.candles.length; i++) {
      line.push({ time: this.candles[i].time, value: emaF[i] - emaS[i] });
    }
    var sigVals = this._emaFromArr(line.map(function (p) { return p.value; }), signal);
    for (var i = 0; i < this.candles.length; i++) {
      hist.push({ time: this.candles[i].time, value: line[i].value - sigVals[i] });
    }
    var sig = [];
    for (var i = 0; i < this.candles.length; i++) sig.push({ time: this.candles[i].time, value: sigVals[i] });
    return { line: line, signal: sig, hist: hist };
  };

  Pane.prototype._emaArr = function (period, src) {
    var k = 2 / (period + 1), prev = null, out = [];
    for (var i = 0; i < this.candles.length; i++) {
      var v = this.srcVal(this.candles[i], src);
      prev = prev == null ? v : v * k + prev * (1 - k);
      out.push(prev);
    }
    return out;
  };

  Pane.prototype.stochValues = function (period, k, d, src) {
    // Stochastic %K: (close - lowest low) / (highest high - lowest low) over
    // the window, then smoothed with a simple average for the %D line.
    var pk = [], pd = [], raw = [];
    for (var i = 0; i < this.candles.length; i++) {
      if (i < period - 1) { raw.push(null); continue; }
      var lo = Infinity, hi = -Infinity;
      for (var j = i - period + 1; j <= i; j++) {
        lo = Math.min(lo, this.candles[j].low);
        hi = Math.max(hi, this.candles[j].high);
      }
      var c = this.srcVal(this.candles[i], src);
      raw.push(hi === lo ? 50 : (c - lo) / (hi - lo) * 100);
    }
    for (var i = 0; i < raw.length; i++) {
      if (raw[i] == null) { pk.push(null); pd.push(null); continue; }
      pk.push({ time: this.candles[i].time, value: raw[i] });
      // %D = average of the last k VALID raw values - identical to the
      // incremental engine (which only keeps non-null raws in its ring).
      if (i >= k - 1) {
        var s = 0, cnt = 0;
        for (var q = i - k + 1; q <= i; q++) {
          if (raw[q] == null) break;   // nulls pad the warm-up window
          s += raw[q]; cnt++;
        }
        if (cnt === k) pd.push({ time: this.candles[i].time, value: s / k });
      }
    }
    return { k: pk, d: pd };
  };

  Pane.prototype.atrValues = function (period) {
    // Average True Range: Wilder-smoothed mean of TR = max(H-L, |H-pC|, |L-pC|).
    if (this.candles.length < 2) return [];
    var out = [], prevClose = this.candles[0].close;
    var trs = [];
    for (var i = 1; i < this.candles.length; i++) {
      var c = this.candles[i];
      var tr = Math.max(c.high - c.low,
        Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
      trs.push(tr);
      prevClose = c.close;
    }
    if (trs.length < period) return [];
    var atr = 0;
    for (var i = 0; i < period; i++) atr += trs[i];
    atr /= period;
    out.push({ time: this.candles[period].time, value: atr });
    for (var i = period; i < trs.length; i++) {
      atr = (atr * (period - 1) + trs[i]) / period;
      out.push({ time: this.candles[i + 1].time, value: atr });
    }
    return out;
  };

  Pane.prototype.superValues = function (period, mult) {
    // SuperTrend: ATR-band channel, flips when close crosses the band. Returns
    // the trend line (up/down band) plus a trend direction for coloring.
    if (this.candles.length < period + 1) return { line: [], dir: [] };
    var atrArr = this.atrValues(period);
    var hl2 = [];
    for (var i = 0; i < this.candles.length; i++) hl2.push((this.candles[i].high + this.candles[i].low) / 2);
    var line = [], dir = [], trendUp = true;
    var basicUp = 0, basicLo = 0, upBand = 0, loBand = 0;
    for (var i = period; i < this.candles.length; i++) {
      var atr = atrArr[i - period] ? atrArr[i - period].value : 0;
      var c = this.candles[i];
      basicUp = hl2[i] + mult * atr;
      basicLo = hl2[i] - mult * atr;
      upBand = (basicUp < upBand || c.close > upBand) ? basicUp : upBand;
      loBand = (basicLo > loBand || c.close < loBand) ? basicLo : loBand;
      if (trendUp) {
        trendUp = c.close > upBand;
        if (!trendUp) upBand = basicUp;
      } else {
        trendUp = c.close >= loBand;
        if (trendUp) loBand = basicLo;
      }
      dir.push(trendUp ? 1 : -1);
      line.push({ time: c.time, value: trendUp ? loBand : upBand });
    }
    return { line: line, dir: dir };
  };

  Pane.prototype.obvValues = function () {
    // On-Balance Volume: cumulative volume, +/- by close direction.
    var out = [], obv = 0, prevClose = null;
    for (var i = 0; i < this.candles.length; i++) {
      var c = this.candles[i];
      if (prevClose != null) {
        if (c.close > prevClose) obv += (c.volume || 0);
        else if (c.close < prevClose) obv -= (c.volume || 0);
      }
      prevClose = c.close;
      out.push({ time: c.time, value: obv });
    }
    return out;
  };

  Pane.prototype.adxValues = function (period) {
    // Average Directional Index: Wilder-smoothed +DI/-DI/ADX.
    if (this.candles.length < period + 1) return { adx: [], pdi: [], ndi: [] };
    var trs = [], pdms = [], ndms = [];
    for (var i = 1; i < this.candles.length; i++) {
      var a = this.candles[i - 1], c = this.candles[i];
      trs.push(Math.max(c.high - c.low,
        Math.abs(c.high - a.close), Math.abs(c.low - a.close)));
      var up = c.high - a.high, dn = a.low - c.low;
      pdms.push((up > dn && up > 0) ? up : 0);
      ndms.push((dn > up && dn > 0) ? dn : 0);
    }
    var trSum = 0, pdSum = 0, ndSum = 0;
    for (var i = 0; i < period; i++) { trSum += trs[i]; pdSum += pdms[i]; ndSum += ndms[i]; }
    var adxOut = [], pdiOut = [], ndiOut = [], dxs = [];
    var firstAdx = period + period - 1;
    for (var i = period; i < trs.length; i++) {
      trSum = trSum - trSum / period + trs[i];
      pdSum = pdSum - pdSum / period + pdms[i];
      ndSum = ndSum - ndSum / period + ndms[i];
      var pdi = trSum === 0 ? 0 : 100 * pdSum / trSum;
      var ndi = trSum === 0 ? 0 : 100 * ndSum / trSum;
      var dx = (pdi + ndi) === 0 ? 0 : 100 * Math.abs(pdi - ndi) / (pdi + ndi);
      pdiOut.push({ time: this.candles[i + 1].time, value: pdi });
      ndiOut.push({ time: this.candles[i + 1].time, value: ndi });
      dxs.push(dx);
      // ADX = SMA of the LAST `period` DX values (dxs holds DX for bars
      // period..i, so the window is the tail of the array).
      if (i >= firstAdx) {
        var s = 0;
        for (var q = dxs.length - period; q < dxs.length; q++) s += dxs[q];
        adxOut.push({ time: this.candles[i + 1].time, value: s / period });
      }
    }
    return { adx: adxOut, pdi: pdiOut, ndi: ndiOut };
  };

  Pane.prototype._emaFromArr = function (arr, period) {
    var k = 2 / (period + 1), prev = null, out = [];
    for (var i = 0; i < arr.length; i++) {
      prev = prev == null ? arr[i] : arr[i] * k + prev * (1 - k);
      out.push(prev);
    }
    return out;
  };

  // Stack the sub-pane scales (RSI / MACD / volume) under the price pane and
  // shrink the price scale's margins to make room - TradingView-style panes.
  Pane.prototype._layoutScales = function () {
    var volTop = 0.82;                       // volume always at the bottom
    var next = volTop;
    // Stack sub-panes bottom-up (TradingView order: last toggled at the top
    // of the stack). New sub-pane indicators slot in before the old ones.
    var subStack = ['adx', 'stoch', 'macd', 'rsi'];
    for (var i = 0; i < subStack.length; i++) {
      var k = subStack[i];
      if (this.indicators[k]) {
        this.chart.priceScale(k).applyOptions({ scaleMargins: { top: next - 0.12, bottom: 1 - next } });
        next -= 0.12;
      }
    }
    this.chart.priceScale('right').applyOptions({ scaleMargins: { top: 0.08, bottom: 1 - next } });
  };

  Pane.prototype.recomputeIndicators = function () {
    if (!this.chart) return;
    var self = this;
    var keys = Object.keys(INDICATORS);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var cfg = self.indicators[key];
      var on = !!cfg;
      var wasOn = !!self._indSeen[key];
      // Skip indicators that are off AND were off - previously every
      // recompute (e.g. on every live candle close) re-set [] + hid all 8
      // series, which was the bulk of the live-update lag.
      if (!on && !wasOn) continue;
      self._indSeen[key] = on;
      var lineOpts = { visible: on };
      if (on) {
        lineOpts.color = cfg.color;
        lineOpts.lineStyle = cfg.lineStyle;
        lineOpts.lineWidth = cfg.lineWidth;
        // Live value labels on the indicator's own scale (RSI 14 -> 62.3).
        if (key === 'rsi') lineOpts.title = 'RSI ' + cfg.period;
        if (key === 'macd') lineOpts.title = 'MACD (' + cfg.fast + ',' + cfg.slow + ',' + cfg.signal + ')';
      }
      if (key === 'vwap') {
        self.series.vwap.setData(on ? self.vwapValues() : []);
        self.series.vwap.applyOptions(lineOpts);
      } else if (key === 'boll') {
        var b = on ? self.bollValues(cfg.period, cfg.mult, cfg.source) : [];
        self.series.bollUp.setData(b.map(function (p) { return { time: p.time, value: p.up }; }));
        self.series.bollMid.setData(b.map(function (p) { return { time: p.time, value: p.mid }; }));
        self.series.bollLo.setData(b.map(function (p) { return { time: p.time, value: p.lo }; }));
        self.series.bollUp.applyOptions(lineOpts);
        self.series.bollMid.applyOptions(lineOpts);
        self.series.bollLo.applyOptions(lineOpts);
      } else if (key === 'rsi') {
        self.series.rsi.setData(on ? self.rsiValues(cfg.period, cfg.source) : []);
        self.series.rsi.applyOptions(lineOpts);
      } else if (key === 'macd') {
        var m = on ? self.macdValues(cfg.fast, cfg.slow, cfg.signal, cfg.source)
                   : { line: [], signal: [], hist: [] };
        self.series.macdLine.setData(m.line);
        self.series.macdSignal.setData(m.signal);
        self.series.macdHist.setData(m.hist.map(function (p) {
          return { time: p.time, value: p.value, color: p.value >= 0 ? 'rgba(8,153,129,0.55)' : 'rgba(242,54,69,0.55)' };
        }));
        self.series.macdLine.applyOptions(lineOpts);
        self.series.macdSignal.applyOptions(on ? {
          visible: true, color: cfg.signalColor, title: 'Signal',
          lineStyle: cfg.lineStyle, lineWidth: cfg.lineWidth,
        } : { visible: false });
        self.series.macdHist.applyOptions({ visible: on });
      } else if (key === 'stoch') {
        var sc = on ? self.stochValues(cfg.period, cfg.k, cfg.d, cfg.source)
                    : { k: [], d: [] };
        self.series.stochK.setData(sc.k);
        self.series.stochD.setData(sc.d);
        self.series.stochK.applyOptions(on ? {
          visible: true, color: cfg.color, title: 'K', lineStyle: cfg.lineStyle, lineWidth: cfg.lineWidth,
        } : { visible: false });
        self.series.stochD.applyOptions(on ? {
          visible: true, color: cfg.color2, title: 'D', lineStyle: cfg.lineStyle, lineWidth: cfg.lineWidth,
        } : { visible: false });
      } else if (key === 'atr') {
        self.series.atr.setData(on ? self.atrValues(cfg.period) : []);
        self.series.atr.applyOptions(lineOpts);
      } else if (key === 'super') {
        var sup = on ? self.superValues(cfg.period, cfg.mult) : { line: [], dir: [] };
        var colored = sup.line.map(function (p, i) {
          return { time: p.time, value: p.value,
                   color: sup.dir[i] > 0 ? 'rgba(38,166,154,0.85)' : 'rgba(239,83,80,0.85)' };
        });
        self.series.super.setData(colored);
        self.series.super.applyOptions({ visible: on, lineWidth: 2,
                                         priceLineVisible: false, lastValueVisible: false });
      } else if (key === 'obv') {
        self.series.obv.setData(on ? self.obvValues() : []);
        self.series.obv.applyOptions(lineOpts);
      } else if (key === 'adx') {
        var ad = on ? self.adxValues(cfg.period) : { adx: [], pdi: [], ndi: [] };
        self.series.adxLine.setData(ad.adx);
        self.series.adxPdi.setData(ad.pdi);
        self.series.adxNdi.setData(ad.ndi);
        self.series.adxLine.applyOptions(on ? {
          visible: true, color: cfg.color, title: 'ADX', lineStyle: cfg.lineStyle, lineWidth: cfg.lineWidth,
        } : { visible: false });
        self.series.adxPdi.applyOptions(on ? {
          visible: true, color: '#4dd0e1', title: '+DI', lineWidth: cfg.lineWidth,
        } : { visible: false });
        self.series.adxNdi.applyOptions(on ? {
          visible: true, color: '#ffb74d', title: '-DI', lineWidth: cfg.lineWidth,
        } : { visible: false });
      } else {
        var s = self.ensureIndSeries(key);
        if (on) {
          var vals = INDICATORS[key].ema
            ? self.emaValues(cfg.period, cfg.source)
            : self.smaValues(cfg.period, cfg.source);
          s.setData(vals);
          s.applyOptions(lineOpts);
        } else {
          s.setData([]);
          s.applyOptions({ visible: false });
        }
      }
      // Seed the incremental state so a live candle close can append a point
      // via series.update() instead of a full O(n) recompute + setData.
      if (on) self._seedInd(key, cfg);
      else delete self._indCache[key];
    }
    self._layoutScales();
  };

  /* ---------------- incremental indicator engine (live closes) ----------- */
  // Every indicator keeps a tiny running state (rolling sums / EMA / Wilder /
  // MACD chains). A live candle close advances the state by ONE candle and
  // appends the new point with series.update() - O(1) per indicator instead of
  // re-walking up to 60k candles and re-setting the whole series on every
  // close (the old behavior, which was the biggest live-update stutter). The
  // math mirrors the full-array functions EXACTLY (same warm-up windows), so
  // incremental points are byte-identical to a full recompute.
  Pane.prototype._indEmpty = function (key, cfg) {
    var def = INDICATORS[key];
    var st = { n: 0 };
    if (def.kind === 'line') {
      if (def.ema) st.prev = null;
      else { st.sum = 0; st.ring = []; }
    } else if (def.kind === 'vwap') {
      st.day = null; st.cumPV = 0; st.cumV = 0;
    } else if (def.kind === 'boll') {
      st.ring = []; st.sum = 0; st.sumsq = 0;
    } else if (def.kind === 'rsi') {
      st.prevSrc = null; st.gains = 0; st.losses = 0; st.avgG = 0; st.avgL = 0;
    } else if (def.kind === 'macd') {
      st.emaF = null; st.emaS = null; st.sig = null;
    } else if (def.kind === 'stoch') {
      st.ring = []; st.k = []; st.raw = [];
    } else if (def.kind === 'atr') {
      st.prevClose = null; st.trs = []; st.atr = null; st.n = 0;
    } else if (def.kind === 'super') {
      st.prevClose = null; st.trs = []; st.atr = null;
      st.hl2 = []; st.trendUp = true; st.upBand = 0; st.loBand = 0;
    } else if (def.kind === 'obv') {
      st.obv = 0; st.prevClose = null;
    } else if (def.kind === 'adx') {
      st.trs = []; st.pdms = []; st.ndms = []; st.trSum = 0; st.pdSum = 0; st.ndSum = 0;
      st.dxs = []; st.adx = null; st.dxCount = 0;
    }
    return st;
  };

  Pane.prototype._indEmit = function (key, cfg, st, c) {
    var def = INDICATORS[key];
    var kind = def.kind;
    var n = ++st.n;
    if (kind === 'line') {
      var v = this.srcVal(c, cfg.source);
      if (def.ema) {
        var k = 2 / (cfg.period + 1);
        st.prev = st.prev == null ? v : v * k + st.prev * (1 - k);
        if (n < cfg.period) return null;
        return { time: c.time, value: st.prev };
      }
      st.sum += v; st.ring.push(v);
      if (st.ring.length > cfg.period) st.sum -= st.ring.shift();
      if (n < cfg.period) return null;
      return { time: c.time, value: st.sum / cfg.period };
    }
    if (kind === 'vwap') {
      var day = istDateKey(c.time);
      if (st.day !== day) { st.day = day; st.cumPV = 0; st.cumV = 0; }
      var tp = (c.high + c.low + c.close) / 3;
      var vol = c.volume || 0;
      st.cumPV += tp * vol; st.cumV += vol;
      return st.cumV > 0 ? { time: c.time, value: st.cumPV / st.cumV } : null;
    }
    if (kind === 'boll') {
      var v = this.srcVal(c, cfg.source);
      st.ring.push(v); st.sum += v;
      if (st.ring.length > cfg.period) st.sum -= st.ring.shift();
      if (n < cfg.period) return null;
      // Population stddev over the exact window (sum of squared deviations
      // from the window mean), identical to bollValues() - the E[x^2]-E[x]^2
      // shortcut can drift in the last digits and shows up as wobble.
      var mid = st.sum / cfg.period, sq = 0;
      for (var q = 0; q < st.ring.length; q++) {
        var dq = st.ring[q] - mid;
        sq += dq * dq;
      }
      var sd = Math.sqrt(sq / st.ring.length);
      return { time: c.time, mid: mid, up: mid + cfg.mult * sd, lo: mid - cfg.mult * sd };
    }
    if (kind === 'rsi') {
      if (st.prevSrc == null) { st.prevSrc = this.srcVal(c, cfg.source); return null; }
      var v = this.srcVal(c, cfg.source);
      var d = v - st.prevSrc;
      st.prevSrc = v;
      if (n <= cfg.period + 1) {
        if (d >= 0) st.gains += d; else st.losses -= d;
        if (n < cfg.period + 1) return null;
        st.avgG = st.gains / cfg.period;
        st.avgL = st.losses / cfg.period;
      } else {
        st.avgG = (st.avgG * (cfg.period - 1) + Math.max(d, 0)) / cfg.period;
        st.avgL = (st.avgL * (cfg.period - 1) + Math.max(-d, 0)) / cfg.period;
      }
      var rsi = st.avgL === 0 ? 100 : 100 - 100 / (1 + st.avgG / st.avgL);
      return { time: c.time, value: rsi };
    }
    if (kind === 'macd') {
      var v = this.srcVal(c, cfg.source);
      var kF = 2 / (cfg.fast + 1), kS = 2 / (cfg.slow + 1), kSig = 2 / (cfg.signal + 1);
      st.emaF = st.emaF == null ? v : v * kF + st.emaF * (1 - kF);
      st.emaS = st.emaS == null ? v : v * kS + st.emaS * (1 - kS);
      var line = st.emaF - st.emaS;
      st.sig = st.sig == null ? line : line * kSig + st.sig * (1 - kSig);
      return { time: c.time, line: line, signal: st.sig, hist: line - st.sig };
    }
    if (kind === 'stoch') {
      // %K needs a rolling window of lows/highs; %D is a k-period SMA of %K.
      st.ring.push(c);
      if (st.ring.length > cfg.period) st.ring.shift();
      if (st.ring.length < cfg.period) return null;
      var lo = Infinity, hi = -Infinity;
      for (var q = 0; q < st.ring.length; q++) {
        lo = Math.min(lo, st.ring[q].low);
        hi = Math.max(hi, st.ring[q].high);
      }
      var sc = this.srcVal(c, cfg.source);
      var raw = hi === lo ? 50 : (sc - lo) / (hi - lo) * 100;
      st.raw.push(raw);
      if (st.raw.length > cfg.k) st.raw.shift();
      var kLine = { time: c.time, value: raw };
      if (st.raw.length < cfg.k) return { time: c.time, k: kLine, d: null };
      var s = 0;
      for (var q2 = 0; q2 < st.raw.length; q2++) s += st.raw[q2];
      return { time: c.time, k: kLine, d: { time: c.time, value: s / st.raw.length } };
    }
    if (kind === 'atr') {
      // TR needs the previous close; Wilder smoothing starts after `period` TRs.
      if (st.prevClose == null) { st.prevClose = c.close; return null; }
      var tr = Math.max(c.high - c.low,
        Math.abs(c.high - st.prevClose), Math.abs(c.low - st.prevClose));
      st.prevClose = c.close;
      st.trs.push(tr);
      if (st.trs.length < cfg.period) return null;
      if (st.atr == null) {
        var s = 0;
        for (var q = 0; q < st.trs.length; q++) s += st.trs[q];
        st.atr = s / cfg.period;
      } else {
        st.atr = (st.atr * (cfg.period - 1) + tr) / cfg.period;
      }
      return { time: c.time, value: st.atr };
    }
    if (kind === 'super') {
      // SuperTrend needs ATR(period) first: carry a Wilder-smoothed ATR in
      // state (identical to the 'atr' branch) so every emit matches what
      // superValues() + atrValues() would produce for the same candle.
      if (st.prevClose == null) {
        st.prevClose = c.close;
        st.hl2.push((c.high + c.low) / 2);
        return null;
      }
      var tr = Math.max(c.high - c.low,
        Math.abs(c.high - st.prevClose), Math.abs(c.low - st.prevClose));
      st.prevClose = c.close;
      st.trs.push(tr);
      st.hl2.push((c.high + c.low) / 2);
      if (st.trs.length < cfg.period) return null;
      var atr;
      if (st.atr == null) {
        var s = 0;
        for (var q = 0; q < st.trs.length; q++) s += st.trs[q];
        atr = s / cfg.period;
        st.atr = atr;
      } else {
        st.atr = (st.atr * (cfg.period - 1) + tr) / cfg.period;
        atr = st.atr;
      }
      var hl2 = st.hl2[st.hl2.length - 1];
      var basicUp = hl2 + cfg.mult * atr;
      var basicLo = hl2 - cfg.mult * atr;
      st.upBand = (basicUp < st.upBand || c.close > st.upBand) ? basicUp : st.upBand;
      st.loBand = (basicLo > st.loBand || c.close < st.loBand) ? basicLo : st.loBand;
      if (st.trendUp) {
        st.trendUp = c.close > st.upBand;
        if (!st.trendUp) st.upBand = basicUp;
      } else {
        st.trendUp = c.close >= st.loBand;
        if (st.trendUp) st.loBand = basicLo;
      }
      return { time: c.time, value: st.trendUp ? st.loBand : st.upBand, dir: st.trendUp ? 1 : -1 };
    }
    if (kind === 'obv') {
      if (st.prevClose != null) {
        if (c.close > st.prevClose) st.obv += (c.volume || 0);
        else if (c.close < st.prevClose) st.obv -= (c.volume || 0);
      }
      st.prevClose = c.close;
      return { time: c.time, value: st.obv };
    }
    if (kind === 'adx') {
      // Wilder-smoothed +DI/-DI/ADX, mirroring adxValues() exactly.
      if (st.prevClose == null) {
        st.prevHigh = c.high; st.prevLow = c.low; st.prevClose = c.close;
        return null;
      }
      var tr = Math.max(c.high - c.low,
        Math.abs(c.high - st.prevClose), Math.abs(c.low - st.prevClose));
      var up = c.high - st.prevHigh;
      var dn = st.prevLow - c.low;
      st.trs.push(tr);
      st.pdms.push((up > dn && up > 0) ? up : 0);
      st.ndms.push((dn > up && dn > 0) ? dn : 0);
      st.prevHigh = c.high; st.prevLow = c.low; st.prevClose = c.close;
      if (st.trs.length < cfg.period) return null;
      if (st.trSum === 0 && st.dxCount === 0) {
        for (var q = 0; q < cfg.period; q++) {
          st.trSum += st.trs[q]; st.pdSum += st.pdms[q]; st.ndSum += st.ndms[q];
        }
        st.dxCount = 1;
        return null;   // warm-up candle: adxValues() emits from the NEXT bar
      } else {
        st.trSum = st.trSum - st.trSum / cfg.period + tr;
        st.pdSum = st.pdSum - st.pdSum / cfg.period + (up > dn && up > 0 ? up : 0);
        st.ndSum = st.ndSum - st.ndSum / cfg.period + (dn > up && dn > 0 ? dn : 0);
      }
      var pdi = st.trSum === 0 ? 0 : 100 * st.pdSum / st.trSum;
      var ndi = st.trSum === 0 ? 0 : 100 * st.ndSum / st.trSum;
      var dx = (pdi + ndi) === 0 ? 0 : 100 * Math.abs(pdi - ndi) / (pdi + ndi);
      st.dxs.push(dx);
      if (st.dxs.length > cfg.period) st.dxs.shift();
      if (st.dxs.length < cfg.period) return { time: c.time, adx: null, pdi: pdi, ndi: ndi };
      var s = 0;
      for (var q2 = 0; q2 < st.dxs.length; q2++) s += st.dxs[q2];
      return { time: c.time, adx: s / st.dxs.length, pdi: pdi, ndi: ndi };
    }
    return null;
  };

  // Replay the whole committed array through _indEmit to capture the running
  // state + the last candle index it consumed. Called after every full
  // recompute so the incremental path continues exactly where setData left off.
  Pane.prototype._seedInd = function (key, cfg) {
    var st = this._indEmpty(key, cfg);
    for (var i = 0; i < this.candles.length; i++) this._indEmit(key, cfg, st, this.candles[i]);
    this._indCache[key] = { st: st, last: this.candles.length - 1 };
  };

  // Advance every ON indicator over the candles committed since the last
  // refresh (usually exactly one - the just-closed candle) and push the new
  // point(s) with series.update(). Falls back to a full recompute when the
  // cache is missing (e.g. candles were replaced wholesale).
  Pane.prototype.refreshLiveIndicators = function () {
    var self = this;
    var keys = Object.keys(INDICATORS);
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i];
      var cfg = self.indicators[key];
      if (!cfg) continue;
      var cache = self._indCache[key];
      if (!cache) {
        // Cache missing (candles were replaced wholesale / pane just loaded):
        // a full recompute rebuilds every series AND reseeds the caches.
        self.recomputeIndicators();
        return;
      }
      for (var j = cache.last + 1; j < self.candles.length; j++) {
        var pt = self._indEmit(key, cfg, cache.st, self.candles[j]);
        if (pt) self._indApply(key, pt);
        cache.last = j;
      }
    }
    self._layoutScales();
  };

  Pane.prototype._indApply = function (key, pt) {
    var def = INDICATORS[key];
    var kind = def.kind;
    if (kind === 'line') {
      var s = this.indSeries[key] || this.ensureIndSeries(key);
      s.update({ time: pt.time, value: pt.value });
    } else if (kind === 'vwap') {
      this.series.vwap.update({ time: pt.time, value: pt.value });
    } else if (kind === 'boll') {
      this.series.bollUp.update({ time: pt.time, value: pt.up });
      this.series.bollMid.update({ time: pt.time, value: pt.mid });
      this.series.bollLo.update({ time: pt.time, value: pt.lo });
    } else if (kind === 'rsi') {
      this.series.rsi.update({ time: pt.time, value: pt.value });
    } else if (kind === 'macd') {
      this.series.macdLine.update({ time: pt.time, value: pt.line });
      this.series.macdSignal.update({ time: pt.time, value: pt.signal });
      this.series.macdHist.update({
        time: pt.time, value: pt.hist,
        color: pt.hist >= 0 ? 'rgba(8,153,129,0.55)' : 'rgba(242,54,69,0.55)',
      });
    } else if (kind === 'stoch') {
      if (pt.k) this.series.stochK.update(pt.k);
      if (pt.d) this.series.stochD.update(pt.d);
    } else if (kind === 'atr') {
      this.series.atr.update({ time: pt.time, value: pt.value });
    } else if (kind === 'super') {
      this.series.super.update({
        time: pt.time, value: pt.value,
        color: pt.dir > 0 ? 'rgba(38,166,154,0.85)' : 'rgba(239,83,80,0.85)',
      });
    } else if (kind === 'obv') {
      this.series.obv.update({ time: pt.time, value: pt.value });
    } else if (kind === 'adx') {
      if (pt.pdi != null) this.series.adxPdi.update({ time: pt.time, value: pt.pdi });
      if (pt.ndi != null) this.series.adxNdi.update({ time: pt.time, value: pt.ndi });
      if (pt.adx != null) this.series.adxLine.update({ time: pt.time, value: pt.adx });
    }
  };

  Pane.prototype.toggleIndicator = function (key) {
    if (this.indicators[key]) delete this.indicators[key];
    else this.indicators[key] = indicatorDefaults(key);
    var btn = document.querySelector('#indicator-buttons .tv-ind[data-ind="' + key + '"]');
    if (btn) btn.classList.toggle('tv-btn-active', !!this.indicators[key]);
    this.refreshIndicatorButtons();
    this.recomputeIndicators();
    saveLayout();
  };

  // Refresh the toolbar chips so they show the CURRENT config (e.g. "SMA 10"
  // after the period is changed) - TradingView-style.
  Pane.prototype.refreshIndicatorButtons = function () {
    if (this !== activePane()) return;
    var self = this;
    Object.keys(INDICATORS).forEach(function (key) {
      var btn = document.querySelector('#indicator-buttons .tv-ind[data-ind="' + key + '"]');
      if (!btn) return;
      var cfg = self.indicators[key];
      var def = INDICATORS[key];
      var lbl = def.label;
      if (def.kind === 'macd') {
        lbl += ' (' + (cfg ? cfg.fast : def.fast) + ',' + (cfg ? cfg.slow : def.slow) + ',' +
               (cfg ? cfg.signal : def.signal) + ')';
      } else if (def.kind === 'boll') {
        lbl += ' ' + (cfg ? cfg.period : def.period) + ', ' + (cfg ? cfg.mult : def.mult);
      } else if (def.period != null) {
        lbl += ' ' + (cfg ? cfg.period : def.period);
      }
      var span = btn.querySelector('.ind-label');
      if (span) span.textContent = lbl;
    });
  };

  // ---- TradingView-style indicator settings popover ---------------------
  // Clicking the ⚙ gear (or double-clicking the chip) opens a settings panel
  // for that indicator on the focused chart. Every change applies LIVE.
  Pane.prototype.openIndicatorSettings = function (key) {
    var pop = $('ind-settings');
    var def = INDICATORS[key];
    if (!pop || !def) return;
    if (this._settingsKey === key && !pop.hidden) { pop.hidden = true; return; }
    this._settingsKey = key;
    // Opening settings on a disabled indicator turns it ON (TV behavior).
    if (!this.indicators[key]) {
      this.indicators[key] = indicatorDefaults(key);
      this.recomputeIndicators();
      this.refreshIndicatorButtons();
    }
    var self = this;
    var cfg = this.indicators[key];

    var rows = '';
    if (def.kind === 'line') rows += indRow('Length', indNum('is-period', cfg.period, 1, 500, 1));
    if (def.kind === 'boll') {
      rows += indRow('Length', indNum('is-period', cfg.period, 1, 200, 1));
      rows += indRow('StdDev', indNum('is-mult', cfg.mult, 0.1, 5, 0.1));
    }
    if (def.kind === 'rsi') rows += indRow('Length', indNum('is-period', cfg.period, 1, 100, 1));
    if (def.kind === 'macd') {
      rows += indRow('Fast', indNum('is-fast', cfg.fast, 1, 100, 1));
      rows += indRow('Slow', indNum('is-slow', cfg.slow, 2, 300, 1));
      rows += indRow('Signal', indNum('is-signal', cfg.signal, 1, 100, 1));
    }
    if (def.kind === 'stoch') {
      rows += indRow('Length', indNum('is-period', cfg.period, 1, 200, 1));
      rows += indRow('%K', indNum('is-k', cfg.k, 1, 50, 1));
      rows += indRow('%D', indNum('is-d', cfg.d, 1, 50, 1));
    }
    if (def.kind === 'atr') rows += indRow('Length', indNum('is-period', cfg.period, 1, 200, 1));
    if (def.kind === 'super') {
      rows += indRow('Length', indNum('is-period', cfg.period, 1, 100, 1));
      rows += indRow('Multiplier', indNum('is-mult', cfg.mult, 0.5, 10, 0.5));
    }
    if (def.kind === 'adx') rows += indRow('Length', indNum('is-period', cfg.period, 1, 100, 1));
    if (def.kind !== 'vwap' && def.kind !== 'atr' && def.kind !== 'super'
        && def.kind !== 'obv' && def.kind !== 'adx') {
      rows += indRow('Source', indSelect('is-source', SOURCES, cfg.source));
    }
    rows += indRow('Color', indColor('is-color', cfg.color));
    if (def.kind === 'macd') rows += indRow('Signal color', indColor('is-sigcolor', cfg.signalColor));
    rows += indRow('Style', indSelect('is-style', LINE_STYLES, cfg.lineStyle));
    rows += indRow('Width', indNum('is-width', cfg.lineWidth, 1, 4, 1));

    pop.innerHTML =
      '<div class="ind-settings-head"><span>' + def.label + ' settings · ' +
      this.symbol + '</span><button class="ind-settings-x" title="Close (Esc)">✕</button></div>' +
      '<div class="ind-settings-body">' + rows + '</div>' +
      '<div class="ind-settings-foot">' +
      '<button class="tv-btn tv-btn-sm" id="is-reset">Reset</button>' +
      '<button class="tv-btn tv-btn-sm tv-btn-accent" id="is-done">Done</button>' +
      '</div>';

    var btn = document.querySelector('#indicator-buttons .tv-ind[data-ind="' + key + '"]');
    var r = btn ? btn.getBoundingClientRect() : null;
    if (r) {
      pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 270)) + 'px';
      pop.style.top = (r.bottom + 6) + 'px';
    } else {
      pop.style.left = '140px';
      pop.style.top = '52px';
    }
    pop.hidden = false;

    var numVal = function (id) {
      var e = pop.querySelector('#' + id);
      if (!e) return null;
      var v = parseFloat(e.value);
      return isNaN(v) ? null : v;
    };
    var apply = function () {
      var p = numVal('is-period');
      if (p != null) cfg.period = Math.max(1, Math.round(p));
      var m = numVal('is-mult');
      if (m != null) cfg.mult = Math.max(0.1, m);
      var f = numVal('is-fast');
      if (f != null) cfg.fast = Math.max(1, Math.round(f));
      var s = numVal('is-slow');
      if (s != null) cfg.slow = Math.max(2, Math.round(s));
      var g = numVal('is-signal');
      if (g != null) cfg.signal = Math.max(1, Math.round(g));
      var kk = numVal('is-k');
      if (kk != null) cfg.k = Math.max(1, Math.round(kk));
      var dd = numVal('is-d');
      if (dd != null) cfg.d = Math.max(1, Math.round(dd));
      var w = numVal('is-width');
      if (w != null) cfg.lineWidth = Math.max(1, Math.min(4, Math.round(w)));
      var src = pop.querySelector('#is-source');
      if (src) cfg.source = src.value;
      var col = pop.querySelector('#is-color');
      if (col) cfg.color = col.value;
      var sc = pop.querySelector('#is-sigcolor');
      if (sc) cfg.signalColor = sc.value;
      var st = pop.querySelector('#is-style');
      if (st) cfg.lineStyle = parseInt(st.value, 10) || 0;
      self.recomputeIndicators();
      self.refreshIndicatorButtons();
    };
    // Live apply: selects/colors recompute immediately; number fields are
    // debounced so typing a long SMA period doesn't recompute per keystroke.
    var debounce = null;
    pop.querySelectorAll('input,select').forEach(function (e) {
      e.addEventListener(e.tagName === 'SELECT' ? 'change' : 'input', function () {
        if (e.type === 'number') {
          if (debounce) clearTimeout(debounce);
          debounce = setTimeout(apply, 150);
        } else {
          apply();
        }
      });
    });
    var reset = pop.querySelector('#is-reset');
    if (reset) reset.addEventListener('click', function () {
      if (debounce) clearTimeout(debounce);   // drop any pending live-apply
      self.indicators[key] = indicatorDefaults(key);
      self.recomputeIndicators();
      self.refreshIndicatorButtons();
      // Re-render with the defaults. Clear _settingsKey so the re-entry
      // below doesn't hit the toggle guard and close the popover instead.
      self._settingsKey = null;
      self.openIndicatorSettings(key);
    });
    var done = pop.querySelector('#is-done');
    if (done) done.addEventListener('click', function () { pop.hidden = true; });
    var x = pop.querySelector('.ind-settings-x');
    if (x) x.addEventListener('click', function () { pop.hidden = true; });
  };

  function indRow(label, inputHtml) {
    return '<label class="ind-field"><span class="ind-fname">' + label + '</span>' + inputHtml + '</label>';
  }
  function indNum(id, val, min, max, step) {
    return '<input type="number" id="' + id + '" value="' + val + '" min="' + min +
           '" max="' + max + '" step="' + step + '">';
  }
  function indSelect(id, opts, cur) {
    var html = '<select id="' + id + '">';
    opts.forEach(function (o) {
      html += '<option value="' + o[0] + '"' + (String(o[0]) === String(cur) ? ' selected' : '') + '>' + o[1] + '</option>';
    });
    return html + '</select>';
  }
  function indColor(id, val) {
    return '<input type="color" id="' + id + '" value="' + val + '">';
  }

  // TradingView price-scale modes on the right axis: Auto (normal linear),
  // Log (logarithmic) and Percent (normalized to the first visible bar).
  // Volume profile (volume-at-price) over the VISIBLE window: bucket candle
  // volumes into ~32 price bins and normalize - the classic TradingView
  // right-edge histogram. Recomputes on data load + visible-range change.
  Pane.prototype.computeVolProfile = function () {
    if (!this.volProfile || !this.candles.length) { this._volProfileBins = null; return; }
    var candles = this.candles;
    var ts = this.chart.timeScale();
    var range = ts.getVisibleLogicalRange();
    var start = 0, end = candles.length;
    if (range && isFinite(range.from) && isFinite(range.to)) {
      start = Math.max(0, Math.floor(range.from));
      end = Math.min(candles.length, Math.ceil(range.to) + 1);
    }
    var win = candles.slice(start, end);
    if (win.length < 2) return;
    var lo = Infinity, hi = -Infinity;
    for (var i = 0; i < win.length; i++) {
      if (win[i].low < lo) lo = win[i].low;
      if (win[i].high > hi) hi = win[i].high;
    }
    var BINS = 32, span = hi - lo;
    if (span <= 0) { this._volProfileBins = null; return; }   // no stale profile
    var bins = [];
    for (var k = 0; k < BINS; k++) {
      bins.push({ lo: lo + span * k / BINS, hi: lo + span * (k + 1) / BINS, up: 0, down: 0 });
    }
    for (var j = 0; j < win.length; j++) {
      var c = win[j];
      var mid = (c.high + c.low) / 2;
      var idx = Math.max(0, Math.min(BINS - 1, Math.floor((mid - lo) / span * BINS)));
      var v = c.volume || 0;
      if (c.close >= c.open) bins[idx].up += v; else bins[idx].down += v;
    }
    var maxT = 0;
    for (var m = 0; m < bins.length; m++) {
      var t = bins[m].up + bins[m].down;
      if (t > maxT) maxT = t;
    }
    this._volProfileBins = bins.map(function (b) {
      return { lo: b.lo, hi: b.hi, up: b.up, down: b.down, w: maxT ? (b.up + b.down) / maxT : 0 };
    });
  };

  Pane.prototype.toggleVolProfile = function () {
    this.volProfile = !this.volProfile;
    if (!this.volProfile) this._volProfileBins = null;
    else this.computeVolProfile();
    if (this.primitive) this.primitive.requestUpdate();
    toast('📊 Volume profile ' + (this.volProfile ? 'ON' : 'OFF'));
    saveLayout();
  };

  Pane.prototype.toggleVolume = function () {
    this.showVolume = !this.showVolume;
    this.series.volume.applyOptions({ visible: this.showVolume });
    var b = $('vol-btn');
    if (b) b.classList.toggle('tv-btn-active', this.showVolume);
    toast(this.showVolume ? '📊 Volume shown' : '📊 Volume hidden');
    saveLayout();
  };

  Pane.prototype.toggleSessionBreaks = function () {
    this.sessionBreaks = !this.sessionBreaks;
    if (this.primitive) this.primitive.requestUpdate();
    var b = $('day-breaks-btn');
    if (b) b.classList.toggle('tv-btn-active', this.sessionBreaks);
    toast(this.sessionBreaks ? '┆ Day lines shown' : '┆ Day lines hidden');
    saveLayout();
  };

  Pane.prototype.applyScaleMode = function () {
    var M = LightweightCharts.PriceScaleMode;
    var mode = this.scaleMode === 'log' ? M.Logarithmic
      : (this.scaleMode === 'pct' ? M.Percentage : M.Normal);
    this.chart.priceScale('right').applyOptions({ mode: mode });
    this.chart.priceScale('vol').applyOptions({ mode: M.Normal });
  };

  /* ------------------------------ data loading ---------------------------- */
  Pane.prototype.historyUrl = function (days, before) {    var url = '/api/history?symbol=' + encodeURIComponent(this.symbol) +
              '&interval=' + this.interval + '&days=' + days;
    if (before != null) url += '&before=' + Math.floor(before);
    return url;
  };

  // TradingView-style reset: snap back to the default view - right-anchored
  // at the latest candle, zoomed to ~1.5 trading days (today + half of
  // yesterday) for the active interval. Small datasets (e.g. a 1D range on an
  // intraday chart) fit entirely; a wide range is NEVER squeezed into tiny
  // frames the way fitContent() used to do.
  // TradingView-style reset: a fixed per-timeframe bar window, right-anchored
  // at the newest candle. The other candles stay loaded - scrolling left
  // reveals them. A constant count per timeframe (see RESET_BARS) means each
  // timeframe's reset shows its own distinct amount of history, and it can
  // never degenerate to a handful of bars.
  Pane.prototype.resetView = function () {
    var n = this.candles.length;
    if (!n) return;
    var bars = Math.max(2, Math.min(RESET_BARS[this.interval] || 200, n));
    var self = this;
    // Programmatic reset must NOT look like the user scrolled to the left
    // edge - suppress the auto-load-more subscriber while we set the range,
    // and drop the scroll baseline so the next event re-anchors it.
    this._lastBarSpacing = null;
    // A user reset invalidates the saved restore target too - a stuck-corrupt
    // range right after reset must snap to THIS view, not the pre-reset zoom.
    this._lastGoodRange = null;
    this._resetting = true;
    this.chart.timeScale().setVisibleLogicalRange({
      from: n - bars,
      to: n - 1 + RIGHT_OFFSET_BARS,
    });
    setTimeout(function () { self._resetting = false; }, 120);
  };

  // Push the CURRENT chart-type data into the visible series (raw candles,
  // OHLC bars, line/area closes, or the Heikin-Ashi transform) without ever
  // touching the view or the drawings - TradingView chart styles.
  Pane.prototype.renderMainSeries = function () {
    var t = this.chartType;
    if (t === 'bars') {
      this.series.bar.setData(this.candles);
    } else if (t === 'line') {
      this.series.line.setData(this.candles.map(function (c) { return { time: c.time, value: c.close }; }));
    } else if (t === 'area') {
      this.series.area.setData(this.candles.map(function (c) { return { time: c.time, value: c.close }; }));
    } else if (t === 'heikin-ashi') {
      var ha = this.heikinAshiValues();
      this._haPrev = ha.length >= 2 ? ha[ha.length - 2] : null;
      this._haTail = ha.length ? ha[ha.length - 1] : null;
      this.series.candle.setData(ha);
    } else if (t === 'renko') {
      this.series.candle.setData(this.renkoValues());
    } else {
      this.series.candle.setData(this.candles);
    }
  };

  // Heikin-Ashi transform: haClose = (O+H+L+C)/4, haOpen = (prevHaOpen +
  // prevHaClose)/2, haHigh/Low = the max/min of (H/L, haOpen, haClose).
  // Continuous across the whole series, exactly like TradingView's HA style.
  Pane.prototype._haFrom = function (c, prevHA) {
    var close = (c.open + c.high + c.low + c.close) / 4;
    var open = prevHA ? (prevHA.open + prevHA.close) / 2 : close;
    return {
      time: c.time, open: open,
      high: Math.max(c.high, open, close),
      low: Math.min(c.low, open, close),
      close: close, volume: c.volume,
    };
  };

  Pane.prototype.heikinAshiValues = function () {
    var ha = [], prev = null;
    for (var i = 0; i < this.candles.length; i++) {
      var hc = this._haFrom(this.candles[i], prev);
      ha.push(hc);
      prev = hc;
    }
    return ha;
  };

  // The HA version of the FORMING candle (live ticks) - derived from the last
  // committed HA candle so the forming bar stays consistent with the series.
  Pane.prototype.displayCandle = function (c) {
    return this._haFrom(c, this._haTail);
  };

  // Renko brick size: max(ATR(14), 0.35% of the latest close, min tick) so
  // it adapts to volatility AND stays usable on wide price ranges.
  Pane.prototype._renkoBrickSize = function () {
    var n = this.candles.length;
    var lastClose = n ? this.candles[n - 1].close : 0;
    if (n < 15) return Math.max(lastClose * 0.0035, 0.05);
    var trs = [];
    for (var i = 1; i < n; i++) {
      var c = this.candles[i], p = this.candles[i - 1];
      trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
    }
    var sum = 0;
    for (var j = 0; j < 14; j++) sum += trs[j];
    var atr = sum / 14;
    for (var k = 14; k < trs.length; k++) atr = (atr * 13 + trs[k]) / 14;
    return Math.max(atr, lastClose * 0.0035, 0.05);
  };

  // Renko: trend-following bricks built from closes. A move >= brickSize
  // pushes/flips bricks (instant one-brick reversal). Each brick carries the
  // time of the candle that triggered it so the series stays time-aligned.
  Pane.prototype.renkoValues = function () {
    var src = this.candles;
    if (!src.length) return [];
    var size = this._renkoBrickSize();
    var out = [], anchor = null, dir = 0;
    for (var i = 0; i < src.length; i++) {
      var c = src[i];
      if (anchor == null) { anchor = c.close; continue; }
      var move = c.close - anchor;
      var abs = Math.abs(move);
      if (abs < size) continue;
      var nd = move > 0 ? 1 : -1;
      if (dir === 0 || nd === dir) {
        var cnt = Math.floor(abs / size);
        for (var b = 0; b < cnt; b++) {
          var o = anchor, cl = nd > 0 ? anchor + size : anchor - size;
          out.push({ time: c.time, open: o, high: Math.max(o, cl), low: Math.min(o, cl), close: cl, volume: c.volume });
          anchor = cl;
        }
        dir = nd;
      } else {
        var o2 = anchor, cl2 = nd > 0 ? anchor + size : anchor - size;
        out.push({ time: c.time, open: o2, high: Math.max(o2, cl2), low: Math.min(o2, cl2), close: cl2, volume: c.volume });
        anchor = cl2;
        dir = nd;
      }
    }
    return out;
  };

  Pane.prototype.setCandleData = function () {
    this.renderMainSeries();
    this.series.volume.setData(this.candles.map(function (c) {
      return {
        time: c.time, value: c.volume,
        color: c.close >= c.open ? COLORS.volUp : COLORS.volDown,
      };
    }));
    this.series.volume.applyOptions({ visible: this.showVolume });
    this.recomputeIndicators();
    this.refreshSessionBreaks();
    // Re-apply Buy/Sell + pattern markers, and rebuild the auto S/R overlay,
    // after any full data reload (patterns/levels react to the candle set).
    this.refreshPatterns();
    this.renderAutoSR();
    this.computeVolProfile();
  };

  Pane.prototype.setCompare = function (symbol) {
    var self = this;
    this.compareSymbol = symbol || null;
    if (this.compareSeries) {
      try { this.chart.removeSeries(this.compareSeries); } catch (e) {}
      this.compareSeries = null;
    }
    if (this.compareLegendEl) this.compareLegendEl.textContent = '';
    if (!this.compareSymbol) { saveLayout(); return; }
    fetch('/api/history?symbol=' + encodeURIComponent(symbol) +
          '&interval=' + encodeURIComponent(this.interval) + '&days=120')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (self.destroyed || !self.compareSymbol ||
            symbol !== self.compareSymbol) return;
        var bars = d.candles || [];
        if (bars.length < 2) {
          toast('Compare: no data for ' + symbol, 'err');
          self.compareSymbol = null;
          saveLayout();
          return;
        }
        // Normalise to percent-change-from-first so symbols with very
        // different price scales overlay cleanly (TradingView compare).
        var base = bars[0].close;
        var line = bars.map(function (b) {
          return { time: b.time, value: base ? (b.close - base) / base * 100 : 0 };
        });
        try {
          self.compareSeries = self.chart.addSeries(LightweightCharts.LineSeries, {
            color: '#ffb74d', lineWidth: 1.5, priceScaleId: 'right',
            title: symbol + ' %', priceLineVisible: false,
            crosshairMarkerVisible: false,
          });
          self.compareSeries.setData(line);
          if (self.compareLegendEl) self.compareLegendEl.textContent = '⇄ ' + symbol;
          saveLayout();
        } catch (e) {}
      })
      .catch(function () {
        if (!self.destroyed) toast('Compare fetch failed: ' + symbol, 'err');
      });
  };

  Pane.prototype.clearCompare = function () { this.setCompare(null); };

  // Recompute the dotted session-break markers (market close -> open and
  // weekend boundaries) from the current candle array - TradingView-style.
  Pane.prototype.refreshSessionBreaks = function () {
    var breaks = [];
    var prevKey = null;
    for (var i = 0; i < this.candles.length; i++) {
      var k = istDateKey(this.candles[i].time);
      if (prevKey !== null && k !== prevKey) breaks.push(this.candles[i].time);
      prevKey = k;
    }
    this._breaks = breaks;
  };

  Pane.prototype.updateCount = function (meta) {
    if (this !== activePane()) return;   // status bar always reflects the focused pane
    $('st-candles').textContent = this.candles.length + ' candles';
    var first = this.candles[0];
    if (first) {
      $('st-depth').textContent = 'from ' + fmtISTDate(first.time) +
        (meta && meta.available && meta.available.rows ? ' · ' + meta.available.rows + ' in cache' : '');
    } else {
      $('st-depth').textContent = '';
    }
  };

  Pane.prototype.loadHistory = function () {
    var self = this;
    var token = ++this.loadToken;   // stale fetches (old symbol/interval) are dropped
    // A fresh symbol/interval/range has a different data length - a stale
    // last-good range from the previous data must not be restorable.
    this._lastGoodRange = null;
    this._lastBarSpacing = null;
    this._corruptCount = 0;
    // Time out slow/hung history fetches (Angel REST can stall for tens of
    // seconds under rate limits) and abort superseded ones. Without a
    // timeout a pane could sit FOREVER on the PREVIOUS interval's candles
    // while the toolbar claims a new one - the "5m chart showing 1m candles"
    // bug. A quick 5m->1m->5m click storm also only finishes the last fetch.
    // (AbortController is guarded for older browsers/WebViews that lack it.)
    if (this._histAbort) { try { this._histAbort.abort(); } catch (e) {} }
    var ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
    this._histAbort = ctrl;
    var timer = setTimeout(function () { if (ctrl) { try { ctrl.abort(); } catch (e) {} } }, 25000);
    return fetch(this.historyUrl(RANGES[this.range] || 365), ctrl ? { signal: ctrl.signal } : {})
      .then(function (res) {
        if (!res.ok) return res.json().then(function (e) { throw new Error(e.detail || 'history failed'); });
        return res.json();
      })
      .then(function (payload) {
        if (token !== self.loadToken) return;
        if (self.destroyed) return;   // pane removed while the fetch was in flight
        self.candles = payload.candles;
        self.currentCandle = null;
        self.historyDone = false;
        self._aiPending = false;
        self._needRefresh = false;
        self.setCandleData();
        self.resetView();   // TradingView-style default zoom, not fitContent()
        self.setSourceBadge(payload.meta);
        self.updateCount(payload.meta);
        self.updateLegend();
        self.applyWatermark();   // refresh the symbol/interval watermark text
        self.kronosData = null;
        self.kronosBand = null;
        self.kronosConfidence = null;
        self.kronosRegime = null;
        self.series.kronos.setData([]);
        self.kronosNoteEl.hidden = true;
        if (self.primitive) self.primitive.requestUpdate();
        // With Auto ON, a symbol/interval/range change must re-run the
        // forecast on the NEW candles right away - otherwise the old
        // prediction stays visible (or nothing shows) until the next
        // candle closes, which looks like a broken auto-predictor.
        if (self.autoPredict && !self.destroyed) self.autoPredictNow(true);
      })
      .catch(function (err) {
        if (token !== self.loadToken) return;
        if (self.destroyed) return;   // pane removed while the fetch was in flight
        if (err && err.name === 'AbortError') {
          toast('History request timed out — trying daily fallback', 'err');
        }
        // Equity symbols have no intraday deep cache (only daily) - degrade
        // gracefully to 1D instead of showing an error, so every symbol
        // always has a chart. Only do this once to avoid loops.
        if (self.interval !== '1D' && !self._degradedOnce) {
          self._degradedOnce = true;
          var tried = self.interval;
          self.interval = '1D';
          // Sync BOTH the pane's own buttons and the GLOBAL timeframe
          // toolbar, so the UI never claims an interval the pane isn't on.
          self.paneIntervalsEl.querySelectorAll('button').forEach(function (x) {
            x.classList.toggle('tv-btn-active', x.dataset.interval === '1D');
          });
          document.querySelectorAll('#tf-buttons .tv-btn').forEach(function (x) {
            x.classList.toggle('tv-btn-active', x.dataset.tf === '1D');
          });
          toast('⚠️ No ' + tried.replace(/[^a-z0-9]/gi, '') +
                ' data for ' + self.symbol + ' — showing daily (deep cache)');
          return self.loadHistory();
        }
        // FINAL failure: never keep the previous interval's candles on
        // screen under the new interval label - clear to an honest empty
        // chart instead of showing stale 1m data on a "5m" chart.
        self.candles = [];
        self.currentCandle = null;
        self.kronosData = null;
        self.kronosBand = null;
        self.kronosConfidence = null;
        self.kronosRegime = null;
        self.series.kronos.setData([]);
        self.kronosNoteEl.hidden = true;
        self.setCandleData();
        self.updateLegend();
        self.setSourceBadge(null);
        self.updateCount();
        if (self.primitive) self.primitive.requestUpdate();
        toast('History: ' + err.message, 'err');
      })
      .finally(function () {
        clearTimeout(timer);
        if (self._histAbort === ctrl) self._histAbort = null;
      });
  };

  Pane.prototype.loadMore = function () {
    var self = this;
    this.loadingMore = true;
    var token = this.loadToken;
    var earliest = this.candles[0] && this.candles[0].time;
    if (earliest == null) { this.loadingMore = false; return; }
    var ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) { try { ctrl.abort(); } catch (e) {} } }, 20000);
    fetch(this.historyUrl(RANGES[this.range] || 365, earliest), ctrl ? { signal: ctrl.signal } : {})
      .then(function (res) {
        if (token !== self.loadToken) throw new Error('stale');
        if (!res.ok) { self.historyDone = true; throw new Error('no older data'); }
        return res.json();
      })
      .then(function (payload) {
        if (token !== self.loadToken) return;
        if (self.destroyed) return;   // pane removed while the fetch was in flight
        var added = payload.candles || [];
        if (payload.meta && payload.meta.done) { self.historyDone = true; }
        if (!added.length) {
          if (payload.meta && payload.meta.available === null) self.historyDone = true;
          return;
        }
        var known = {};
        self.candles.forEach(function (c) { known[c.time] = true; });
        var fresh = added.filter(function (c) { return !known[c.time]; });
        if (!fresh.length) { self.historyDone = true; return; }
        var logical = self.chart.timeScale().getVisibleLogicalRange();
        self.candles = fresh.concat(self.candles);
        self.setCandleData();
        // Only carry the view forward if the range is still valid - a NaN/
        // inverted range (possible after fast pan+zoom) must not be shifted
        // and re-applied, or the chart stays corrupt forever.
        if (logical && isFinite(logical.from) && isFinite(logical.to) &&
            logical.from <= logical.to) {
          self.chart.timeScale().setVisibleLogicalRange({
            from: logical.from + fresh.length,
            to: logical.to + fresh.length,
          });
        }
        self.updateCount(payload.meta);
        toast('⏪ Loaded ' + fresh.length + ' older candles (from ' +
          fmtISTDate(fresh[0].time) + ')');
      })
      .catch(function (err) {
        if (token !== self.loadToken) return;
        if (self.destroyed) return;   // pane removed while the fetch was in flight
        // A timeout is transient - retry on the next scroll instead of
        // permanently marking the archive exhausted.
        if (err && err.name === 'AbortError') {
          toast('Could not load older candles: request timed out', 'err');
          return;
        }
        self.historyDone = true;
        if (err.message !== 'stale') toast('Could not load older candles: ' + err.message, 'err');
      })
      .finally(function () {
        clearTimeout(timer);
        self.loadingMore = false;
      });
  };

  Pane.prototype.setSourceBadge = function (meta) {
    if (this !== activePane()) return;
    var b = $('source-badge');
    if (!meta || !meta.source) { b.textContent = '—'; return; }
    var src = String(meta.source);
    var live = src.indexOf('+live') !== -1;      // forecast merged the live tail
    if (src.indexOf('angel-rest') !== -1) {
      b.textContent = 'source: Angel One REST' + (live ? ' + live' : '');
      b.className = 'tv-badge tv-badge-live';
    } else if (src.indexOf('history-cache') !== -1) {
      var base = meta.degraded ? 'source: deep cache (resampled)' : 'source: deep cache (5y)';
      b.textContent = base + (live ? ' + live' : '');
      b.className = 'tv-badge tv-badge-live';
    } else if (src.indexOf('live-csv') !== -1) {
      b.textContent = 'source: live CSV recorder';
      b.className = 'tv-badge tv-badge-live';
    } else if (src.indexOf('csv-fallback') !== -1) {
      b.textContent = 'source: CSV fallback' + (live ? ' + live' : '');
      b.className = 'tv-badge tv-badge-warn';
    } else {
      b.textContent = meta.degraded ? 'source: CSV (approx)' : 'source: CSV fallback';
      b.className = 'tv-badge tv-badge-warn';
    }
  };

  /* ------------------------------ live ticks ------------------------------ */
  Pane.prototype.connectWS = function () {
    var self = this;
    if (this.ws) { try { this.ws.close(); } catch (e) {} }
    var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    var ws = new WebSocket(proto + location.host + '/ws?symbol=' + encodeURIComponent(this.symbol));
    this.ws = ws;
    ws.onopen = function () {
      if (self.destroyed) { try { ws.close(); } catch (e) {} return; }
      self.wsFeed = 'connecting'; self.syncFeedBadge();
    };
    ws.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.type === 'status') {
        self.wsFeed = msg.feed;
        self.syncFeedBadge();
        if (self === activePane()) {
          var b = $('ws-badge');
          b.textContent = msg.feed === 'live' ? 'ws: ● live'
            : (msg.feed === 'no-session' ? 'ws: no session' : 'ws: error');
          b.className = 'tv-badge' + (msg.feed === 'live' ? ' tv-badge-live'
            : (msg.feed === 'no-session' ? ' tv-badge-warn' : ' tv-badge-err'));
          $('market-badge').textContent = msg.market || '—';
          $('market-badge').className = 'tv-badge' + (msg.market_open ? ' tv-badge-live' : '');
        }
      } else if (msg.type === 'tick') {
        self.onTick(msg);
      } else if (msg.type === 'alert') {
        // Server-side price alert fired (level crossed on a live tick):
        // toast + beep + refresh the alerts panel (one-shot alert removed).
        var a = msg.alert || {};
        toast('🔔 ALERT: ' + (msg.symbol || a.symbol || '') +
              ' crossed ' + String(Number(a.price).toFixed(2)));
        beep();
        refreshAlertsPanel();
      }
    };
    ws.onclose = function () {
      if (self.destroyed) return;
      if (self.ws !== ws) return;
      self.wsFeed = 'offline';
      self.syncFeedBadge();
      self.ws = null;
      if (self.wsTimer) clearTimeout(self.wsTimer);
      self.wsTimer = setTimeout(function () {
        if (!self.destroyed) self.connectWS();
      }, 5000);
    };
    ws.onerror = function () { try { ws.close(); } catch (e) {} };
  };

  Pane.prototype.syncFeedBadge = function () {
    if (this !== activePane()) return;
    var b = $('ws-badge');
    var feed = this.wsFeed;
    b.textContent = feed === 'live' ? 'ws: ● live'
      : (feed === 'no-session' ? 'ws: no session'
        : (feed === 'connecting' ? 'ws: connecting…' : 'ws: offline'));
    b.className = 'tv-badge' + (feed === 'live' ? ' tv-badge-live'
      : (feed === 'no-session' ? ' tv-badge-warn'
        : (feed === 'connecting' ? '' : ' tv-badge-warn')));
  };

  Pane.prototype.bucketEpoch = function (tsMs) {
    // Buckets are anchored to the NSE MARKET-OPEN grid (09:15 IST) - the SAME
    // grid the server's _resample() uses and Angel's native intraday candles
    // sit on. Shifting by the 09:15 anchor before flooring keeps 1H/30m live
    // candles on 09:15/10:15 (and 09:15/09:45) boundaries instead of the
    // midnight wall-clock grid (09:00/10:00). A plain IST shift is only exact
    // for 1m/5m/15m (330 min divides 5/15 and 1); for 30m/1H the two grids
    // differ by 15 min, which parked the live forming candle 15 min BEFORE the
    // history grid - interleaved bars + a visible gap at every hour boundary.
    var ms = INTERVAL_MS[this.interval] || 300000;
    if (this.interval === '1D') {
      return Math.floor((tsMs + IST_OFFSET_MS) / 86400000) * 86400000 - IST_OFFSET_MS;
    }
    // tsMs is absolute UTC epoch ms; shift to the IST wall clock, back by the
    // 09:15 open anchor, floor to the interval, then undo the shifts so the
    // bucket lands on the trading-session grid in UTC epoch terms.
    return Math.floor((tsMs + IST_OFFSET_MS - MARKET_OPEN_MS) / ms) * ms
      + MARKET_OPEN_MS - IST_OFFSET_MS;
  };

  Pane.prototype.baseCandleFor = function (bucketSec) {
    var last = this.candles[this.candles.length - 1];
    if (!last) return null;
    if (this.interval === '1D') {
      return istDateKey(last.time) === istDateKey(bucketSec) ? last : null;
    }
    return last.time === bucketSec ? last : null;
  };

  // Commit a just-closed live candle into this.candles so the dataset (and
  // everything derived from it - indicators, forecast context, status bar)
  // stays current without a full reload. Never touches drawings.
  Pane.prototype.commitLiveCandle = function (c) {
    var n = this.candles.length;
    var last = n ? this.candles[n - 1] : null;
    if (last && c.time === last.time) {
      // Same bucket as the last committed candle (e.g. a tick arrived right
      // after loadHistory reset currentCandle) - refresh it in place so the
      // dataset never drifts from what the chart shows.
      this.candles[n - 1] = c;
      this._haTail = this._haFrom(c, this._haPrev);   // in-place HA refresh
      return;
    }
    if (last && c.time < last.time) return;    // out-of-order guard
    this.candles.push(c);
    this._haPrev = this._haTail;
    this._haTail = this._haFrom(c, this._haTail);
    // A new session started between the previous candle and this one - add a
    // session-break marker (incremental, O(1) instead of rescanning 60k rows).
    if (last && istDateKey(last.time) !== istDateKey(c.time)) this._breaks.push(c.time);
    if (this.candles.length > 60000) {
      this.candles = this.candles.slice(-60000);
      this.refreshSessionBreaks();
    }
    this.updateCount();
    // Renko bricks derive from closes - refresh the brick series when a
    // candle commits (raw forming-candle ticks are ignored in renko mode).
    if (this.chartType === 'renko' && this.series && this.series.candle) {
      this.series.candle.setData(this.renkoValues());
    }
  };

  // Lightweight post-commit refresh: recompute the indicator overlays from
  // the (now live) candle array. The main price series is already showing the
  // candle via series.update() - we only sync derived overlays, so this is
  // cheap and never resets the view or the drawings.
  Pane.prototype.refreshLiveData = function () {
    if (this.destroyed) return;
    // Incremental: advance each ON indicator by the just-committed candle and
    // append via series.update() - O(1) per indicator per close instead of a
    // full O(n) recompute + setData on up to 60k candles every candle close.
    this.refreshLiveIndicators();
    this.updateLegend();
    this.updateCount();
  };

  // The freshest candles (last ~60 committed + the forming one) as UTC-epoch
  // OHLCV objects - POSTed to /api/kronos/forecast as live_tail so the model
  // predicts from the true live close, not just the cached history. Newest
  // timestamp wins (keep-last), matching the server's merge semantics.
  Pane.prototype.liveTailPayload = function () {
    var arr = this.candles.slice(Math.max(0, this.candles.length - 60));
    if (this.currentCandle) arr.push(this.currentCandle);
    var byTime = {};
    for (var j = 0; j < arr.length; j++) byTime[arr[j].time] = arr[j];
    var times = Object.keys(byTime).map(Number).sort(function (a, b) { return a - b; });
    var out = [];
    for (var i = 0; i < times.length; i++) {
      var c = byTime[times[i]];
      out.push({
        time: c.time,
        open: c.open, high: c.high,
        low: c.low, close: c.close,
        volume: c.volume || 0,
      });
    }
    return out;
  };

  Pane.prototype.onTick = function (t) {
    if (!t.price) return;
    // Ignore ticks outside the NSE cash session (09:15-15:30 IST): Angel can
    // stream pre-open and post-close quotes, and folding them in creates
    // phantom candles (e.g. 07:15 on the 1H chart) that show up as stray bars
    // and gaps around the real session. The exchange timestamp is absolute UTC
    // epoch ms - add the IST offset to read the IST wall clock directly.
    var istMs = (t.ts_ms || Date.now()) + IST_OFFSET_MS;
    var ist = new Date(istMs);
    var istMin = ist.getUTCHours() * 60 + ist.getUTCMinutes();
    if (istMin < SESSION_START_MIN || istMin > SESSION_END_MIN) return;
    var bucketSec = Math.floor(this.bucketEpoch(t.ts_ms || Date.now()) / 1000);
    var base = this.currentCandle || this.baseCandleFor(bucketSec);
    var prevPrice = base ? base.close : null;
    var c;
    var newCandle = false;
    if (!base || bucketSec > base.time) {
      // The previous candle just closed - commit it to the dataset immediately
      // (data integrity), but defer the derived-overlay refresh to AFTER the
      // AI analysis when auto-predict is on, so the chart and the forecast
      // always agree on the same candle close.
      if (this.currentCandle && this.currentCandle.time < bucketSec) {
        this.commitLiveCandle(this.currentCandle);
        this._needRefresh = true;
      }
      c = {
        time: bucketSec,
        open: t.price, high: t.price, low: t.price, close: t.price,
        volume: t.volume || 0,
      };
      newCandle = true;
    } else if (bucketSec < base.time) {
      return;
    } else {
      c = {
        time: base.time,
        open: base.open,
        high: Math.max(base.high, t.price),
        low: Math.min(base.low, t.price),
        close: t.price,
        volume: Math.max(base.volume || 0, t.volume || 0),
      };
    }
    this.currentCandle = c;
    // rAF-batched live render: ticks can burst far faster than the display
    // refresh rate (Angel streams many quotes per second across 4 panes),
    // and updating 5 series objects per tick - the old behavior - was the
    // dominant live-update cost even though only ONE chart type is visible.
    // The candle state is captured here and flushed ONCE per animation frame
    // (see _flushLiveRender), which coalesces a tick burst into a single
    // frame's render and updates only the active series.
    this._liveCandle = c;
    if (!this._liveRaf) {
      var self = this;
      this._liveRaf = requestAnimationFrame(function () { self._flushLiveRender(); });
    }
    // Drawn horizontal levels act as live price alerts (toast + beep).
    this._checkLevelAlerts(prevPrice, t.price);
    // New candle formed: with auto-predict on, the chart refreshes (indicators
    // + forecast) only after the AI has analyzed the close; otherwise refresh
    // immediately so the chart keeps tracking the live market.
    if (newCandle) {
      if (this.autoPredict) {
        this._aiPending = true;
        this.autoNoteEl.hidden = false;
        this.autoPredictNow();
      } else if (this._needRefresh) {
        this._needRefresh = false;
        this.refreshLiveData();
      }
      // Bar-close overlays: pattern markers, auto S/R and MA-cross toasts
      // react to the just-closed candle.
      if (this.patternScan) this.refreshPatterns();
      if (this.autoSR) this.renderAutoSR();
      this._checkMaCrosses();
    }
  };

  // One-per-frame live render. onTick() only records the freshest candle -
  // this flushes it to the chart. Updating ONLY the visible chart-type
  // series (plus volume when shown) instead of all 5 series cuts the per-
  // frame work dramatically; the hidden preview series are re-synced by
  // renderMainSeries() the moment the user switches chart type.
  Pane.prototype._flushLiveRender = function () {
    this._liveRaf = null;
    if (this.destroyed) return;
    var c = this._liveCandle;
    if (!c) return;
    this._liveCandle = null;
    // Renko is brick-based: the forming candle only matters once it closes
    // (commitLiveCandle re-derives the bricks). Never push raw ticks in.
    if (this.chartType === 'renko') return;
    var t = this.chartType;
    if (t === 'bars') {
      this.series.bar.update(c);
    } else if (t === 'line') {
      this.series.line.update({ time: c.time, value: c.close });
    } else if (t === 'area') {
      this.series.area.update({ time: c.time, value: c.close });
    } else {
      // candles + heikin-ashi: the forming candle via series.update() - the
      // smooth real-time display that does NOT touch the drawings layer.
      this.series.candle.update(t === 'heikin-ashi' ? this.displayCandle(c) : c);
    }
    if (this.showVolume) {
      this.series.volume.update({
        time: c.time, value: c.volume,
        color: c.close >= c.open ? COLORS.volUp : COLORS.volDown,
      });
    }
  };

  /* ------------------------------ legend ---------------------------------- */
  // TradingView-style status line: title + hovered candle time + OHLC where
  // each value is coloured by the candle direction, change % on the right.
  Pane.prototype.updateLegend = function (candle) {
    this.legend.title.textContent = this.symbol + ' · ' + this.interval + ' · ' + this.range;
    if (candle) {
      this.legend.time.textContent = fmtIST(candle.time);
      var cls = candle.close >= candle.open ? 'up' : 'down';
      var f = function (v) { return v.toFixed(2); };
      this.legend.ohlc.innerHTML =
        '<span class="l-o">O ' + f(candle.open) + '</span>' +
        '<span class="l-h ' + cls + '">H ' + f(candle.high) + '</span>' +
        '<span class="l-l ' + cls + '">L ' + f(candle.low) + '</span>' +
        '<span class="l-c ' + cls + '">C ' + f(candle.close) + '</span>' +
        '<span class="l-v">V ' + fmtVol(candle.volume) + '</span>';
      var chg = (candle.close - candle.open) / candle.open * 100;
      this.legend.chg.textContent = (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%';
      this.legend.chg.className = 'legend-chg ' + (chg >= 0 ? 'up' : 'down');
    } else {
      this.legend.time.textContent = '';
      this.legend.ohlc.textContent = 'O — H — L — C — V —';
      this.legend.chg.textContent = '';
      this.legend.chg.className = 'legend-chg';
    }
  };

  /* ------------------------------ Kronos AI ------------------------------- */
  Pane.prototype.drawKronos = function () {
    var p = this.kronosData;
    if (!p) return;
    var pts = [{ time: p.last_time, value: p.last_close }];
    p.forecast.forEach(function (f) { pts.push({ time: f.time, value: f.close }); });
    this.series.kronos.setData(pts);
    if (this.primitive) this.primitive.requestUpdate();   // redraw the band
    // With the TradingView-style small right offset, the dashed forecast
    // path extends past the right edge. If the user is anchored at the
    // latest candles, nudge the view so the visible part of the prediction
    // is on screen - but never yank the view if they scrolled back in time.
    var ts = this.chart.timeScale();
    var range = ts.getVisibleLogicalRange();
    var n = this.candles.length;
    if (range && n && range.to >= n - 1 - 2) {
      var target = n - 1 + RIGHT_OFFSET_BARS + 34;   // ~34 bars of forecast
      if (target > range.to) {
        ts.setVisibleLogicalRange({ from: range.from, to: target });
      }
    }
  };

  // --- "What the AI is thinking" panel (top-right of the chart) -----------
  // Kronos is a neural forecaster - there is no literal chain of thought to
  // show. This instead surfaces everything it actually reasons from: the
  // direction + magnitude of its sampled paths, their agreement (confidence),
  // the market-regime snapshot and the technical context around the last
  // close. Every number comes from the forecast payload and the pane's own
  // candle array - nothing is invented.
  Pane.prototype.renderAiThinking = function (payload) {
    if (!this.kronosNoteEl || !payload) return;
    var note = this.kronosNoteEl;
    var reg = (payload.meta || {}).regime || {};
    var last = this.candles.length ? this.candles[this.candles.length - 1] : null;
    var lastClose = this.currentCandle ? this.currentCandle.close
      : (last ? last.close : null);

    // Direction + magnitude of the averaged paths. The HEADLINE is the NET
    // move over the whole forecast horizon (net_move_pct = last forecast
    // close vs last real close) - exactly what the dashed overlay draws - so
    // the box can never contradict the chart. On 1H/1D the first candle is
    // often flat while the 30-candle path swings hundreds of points, which
    // used to make the box look "stuck on the 15m prediction" and show the
    // opposite of the drawn line.
    var dirEl = note.querySelector('.ai-dir');
    if (dirEl) {
      var net = (payload.net_move_pct != null ? payload.net_move_pct : payload.move_pct) || 0;
      var up = net >= 0;
      dirEl.textContent = (up ? '🔺 +' : '🔻 ') + net.toFixed(2) + '%';
      dirEl.style.color = up ? '#26a69a' : '#ef5350';
    }
    // Full-path summary: where the dashed line actually goes (start → end).
    // Uses forecast[-1].close (the exact drawn endpoint, always present when
    // forecast.length >= 2) instead of payload.horizon_close, so a missing
    // field can never throw and abort the runKronos success chain.
    if (payload.forecast && payload.forecast.length >= 2 && this.kronosPathEl) {
      var lastF = payload.forecast[payload.forecast.length - 1];
      var netPts = payload.horizon_close != null && payload.last_close != null
        ? (payload.horizon_close - payload.last_close) : null;
      this.kronosPathEl.textContent =
        (payload.meta.pred_len || 30) + '×' + this.interval + ' path: ' +
        fmtIST(payload.forecast[0].time, { year: true }) + ' → ' +
        fmtIST(lastF.time, { year: true }) + ' · ' + lastF.close.toFixed(2) +
        (netPts != null ? ' (' + (netPts >= 0 ? '+' : '') + netPts.toFixed(1) + ' pts)' : '');
    } else if (this.kronosPathEl) {
      this.kronosPathEl.textContent = '';
    }
    // Next candle the model will print (the trader's first decision point).
    if (payload.forecast && payload.forecast.length && this.kronosNextEl) {
      var first = payload.forecast[0];
      this.kronosNextEl.textContent =
        fmtIST(first.time, { year: true }) + ' → ' + first.close.toFixed(2);
    }

    // Confidence = multi-sample direction agreement + band tightness.
    var conf = payload.confidence;
    var confVal = note.querySelector('.ai-conf-val');
    var confFill = note.querySelector('.ai-fill');
    if (confVal) confVal.textContent = conf != null ? conf.toFixed(0) + '%' : '—';
    if (confFill) {
      var w = conf != null ? Math.max(4, Math.min(100, conf)) : 0;
      confFill.style.width = w + '%';
      confFill.style.background = conf == null ? 'transparent'
        : (conf >= 60 ? 'linear-gradient(90deg,#26a69a,#4dd0e1)'
          : (conf >= 40 ? 'linear-gradient(90deg,#ffb74d,#ffd54f)'
            : 'linear-gradient(90deg,#ef5350,#ff7043)'));
    }

    // Market-regime chips (context, NOT the forecast itself - a stale-cache
    // fallback gets a ⚠ chip so a wild anchor is visible instead of silent).
    var chips = note.querySelector('.ai-chips');
    if (chips) {
      chips.innerHTML = '';
      var chipData = [];
      if (reg.trend && reg.trend !== 'n/a') chipData.push(reg.trend);
      if (reg.vol_state && reg.vol_state !== 'n/a') chipData.push('Vol ' + reg.vol_state);
      if (reg.rsi != null) chipData.push('RSI ' + reg.rsi);
      if (reg.state && reg.state !== 'Neutral' && reg.rsi != null) chipData.push(reg.state);
      if (payload.meta && payload.meta.stale) chipData.push('⚠ stale data');
      chipData.forEach(function (t) {
        chips.appendChild(el('span', 'ai-chip' + (t === '⚠ stale data' ? ' ai-chip-warn' : ''), t));
      });
    }

    // The "why" - technical context around the last close.
    var why = note.querySelector('.ai-why');
    if (why) {
      why.innerHTML = '';
      var points = [];
      if (reg.rsi != null) {
        if (reg.rsi >= 70) points.push('RSI ' + reg.rsi + ' — overbought, momentum stretched');
        else if (reg.rsi <= 30) points.push('RSI ' + reg.rsi + ' — oversold, bounce risk');
        else if (reg.rsi >= 55) points.push('RSI ' + reg.rsi + ' — momentum leans bullish');
        else if (reg.rsi <= 45) points.push('RSI ' + reg.rsi + ' — momentum leans bearish');
        else points.push('RSI ' + reg.rsi + ' — momentum neutral');
      }
      if (lastClose != null) {
        var sma = this.smaValues(20, 'close');
        if (sma.length) {
          var s20 = sma[sma.length - 1].value;
          points.push('Close ' + (lastClose >= s20 ? 'above' : 'below') + ' SMA 20' +
            (lastClose >= s20 ? ' — trend tailwind' : ' — trend headwind'));
        }
      }
      if (reg.ema_slope_pct != null) {
        var slope = reg.ema_slope_pct;
        points.push('EMA 20/50 slope ' + (slope >= 0 ? '+' : '') + slope.toFixed(2) +
          '% — ' + (slope > 0.03 ? 'uptrend support'
            : (slope < -0.03 ? 'downtrend pressure' : 'no strong bias')));
      }
      var macd = this.macdValues(12, 26, 9);
      if (macd && macd.hist.length) {
        var h = macd.hist[macd.hist.length - 1].value;
        points.push('MACD histogram ' + (h >= 0 ? 'positive' : 'negative') +
          (h >= 0 ? ' — bullish cross' : ' — bearish cross'));
      }
      if (reg.atr_pct != null) {
        points.push('ATR ' + reg.atr_pct.toFixed(2) + '% — ' +
          (reg.vol_state === 'High' ? 'high volatility, wider swings expected'
            : (reg.vol_state === 'Low' ? 'low volatility, tight range'
              : 'normal volatility')));
      }
      var nPaths = (payload.meta || {}).sample_count || 1;
      if (nPaths > 1) {
        points.push('Averaged ' + nPaths + ' sampled paths' +
          (payload.band && payload.band.length ? ' (band = path spread)' : ''));
      }
      points.forEach(function (t) {
        var li = el('li');
        li.textContent = t;
        why.appendChild(li);
      });
    }

    // Model meta footer.
    var meta = payload.meta || {};
    var dev = meta.device || 'cuda';
    if (this.kronosCtxEl) {
      this.kronosCtxEl.textContent = (meta.model || 'Kronos') + ' · ' +
        (meta.lookback || 400) + '→' + (meta.pred_len || 30) + ' · ' +
        (dev === 'cuda' ? '⚡GPU' : dev) +
        (meta.inference_seconds != null ? ' · ' + meta.inference_seconds + 's' : '');
    }
    // Sync the chevron with a restored collapsed state.
    var tEl = note.querySelector('.ai-toggle');
    if (tEl) tEl.textContent = note.classList.contains('collapsed') ? '▸' : '▾';
  };

  // Probabilistic forecast: manual runs sample 3 paths (confidence band + a
  // 0-100 score + market regime); live auto-predict stays on 1 fast path so
  // the market never waits on a heavy CPU stack.
  Pane.prototype.runKronos = function (manual) {
    var self = this;
    if (this.forecastLoading || this.destroyed) return;
    this.forecastLoading = true;
    var manualRun = !!manual;
    var sym = this.symbol, iv = this.interval, mdl = this.model;
    var btn = $('kronos-btn');
    if (this === activePane()) {
      btn.classList.add('tv-btn-busy');
      btn.textContent = '🔮 predicting…';
    }
    fetch('/api/kronos/forecast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        symbol: sym,
        interval: iv,
        lookback: 400,
        pred_len: 30,
        model: mdl,
        sample_count: this.autoPredict ? 1 : 5,
        temperature: 1.0,
        top_p: 0.9,
        live_tail: self.liveTailPayload(),
      }),
    })
      .then(function (res) {
        if (!res.ok) return res.json().then(function (e) { throw new Error(e.detail || 'forecast failed'); });
        return res.json();
      })
      .then(function (payload) {
        // Drop stale responses: pane destroyed or symbol/interval changed.
        if (self.destroyed || sym !== self.symbol || iv !== self.interval || mdl !== self.model) return;
        // Guard against a malformed/empty forecast payload so a single bad
        // response can never crash the auto-predictor loop (it would just
        // re-try on the next new candle). forecastLoading is reset by the
        // .finally below on both success and error paths.
        if (!payload || !Array.isArray(payload.forecast) || !payload.forecast.length) {
          toast('Kronos: empty forecast - will retry on the next candle', 'err');
          if (self._needRefresh) { self._needRefresh = false; self.refreshLiveData(); }
          if (self._aiPending) { self._aiPending = false; self.autoNoteEl.hidden = true; }
          return;
        }
        self.kronosData = payload;
        self.kronosBand = payload.band || null;
        self.kronosConfidence = payload.confidence;
        self.kronosRegime = (payload.meta || {}).regime || null;
        self.drawKronos();
        self.series.kronos.applyOptions({ visible: true });
        self.renderAiThinking(payload);
        self.kronosNoteEl.hidden = false;
        // The AI has now analyzed the latest live close - safe to refresh the
        // derived overlays (indicators/legend/count). Drawings are untouched.
        if (self._needRefresh) self._needRefresh = false;
        self.refreshLiveData();
        if (self._aiPending) { self._aiPending = false; self.autoNoteEl.hidden = true; }
        // Toast shows BOTH numbers the user just saw: the full-path net move
        // (what the headline + dashed line show) and the next-candle move, so
        // the toast can never contradict the golden box.
        var toastNet = payload.net_move_pct != null ? payload.net_move_pct : payload.move_pct;
        toast('🔮 Kronos · path ' + (toastNet >= 0 ? '🔺 +' : '🔻 ') + Math.abs(toastNet).toFixed(2) +
          '% · next ' + (payload.move_pct >= 0 ? '🔺' : '🔻') + ' ' + Math.abs(payload.move_pct).toFixed(2) + '%' +
          (payload.confidence != null ? ' · conf ' + payload.confidence.toFixed(0) + '%' : '') +
          ' (⚡' + ((payload.meta || {}).device === 'cuda' ? 'GPU' : 'CPU') + ' · ' +
          payload.meta.inference_seconds + 's · ' + (payload.meta.sample_count || 1) + ' paths)');
      })
      .catch(function (err) {
        toast('Kronos: ' + err.message, 'err');
        // Even on failure, never stall the chart - finalize the pending live
        // refresh so indicators still track the market.
        if (self._needRefresh) { self._needRefresh = false; self.refreshLiveData(); }
        if (self._aiPending) { self._aiPending = false; self.autoNoteEl.hidden = true; }
      })
      .finally(function () {
        self.forecastLoading = false;
        if (self === activePane()) {
          btn.classList.remove('tv-btn-busy');
          btn.textContent = '🔮 Kronos AI';
        }
      });
  };

  // Price alerts on drawn horizontal levels: the moment the live price
  // crosses a committed hLine/hRay, fire a toast + beep exactly once per
  // crossing. The drawing records which side it last saw, so a fresh tick
  // on the SAME side never re-fires - only a true side change does.
  Pane.prototype._checkLevelAlerts = function (prevPrice, newPrice) {
    if (prevPrice == null || newPrice == null) return;
    for (var i = 0; i < this.drawn.length; i++) {
      var d = this.drawn[i];
      if ((d.type !== 'hLine' && d.type !== 'hRay') || d.p1 == null) continue;
      var lvl = d.p1;
      var nowAbove = newPrice >= lvl;
      var newSide = nowAbove ? 'above' : 'below';
      // First time we see this level: just remember which side price is on.
      if (d._alertSide === undefined) { d._alertSide = newSide; continue; }
      if (d._alertSide !== newSide) {
        d._alertSide = newSide;
        toast('🔔 ' + this.symbol + ' crossed ' + lvl.toFixed(2) + ' (' + newSide + ')');
        beep();
      }
    }
  };

  /* ========================= pro-suite features ========================== */
  // Candlestick pattern scan: markers on the chart + the Patterns panel.
  Pane.prototype.refreshPatterns = function () {
    // Detect on the tail (last 1000 bars) so live candle closes never
    // rescan the whole 60k-candle history or push thousands of markers.
    this.patterns = (this.patternScan && this.candles.length > 3)
      ? detectPatterns(this.candles.slice(-1000)) : [];
    this.renderMarkers();
    renderPatternsPanel();
  };

  Pane.prototype.togglePatternScan = function () {
    this.patternScan = !this.patternScan;
    toast('🔎 Pattern scan ' + (this.patternScan ? 'ON' : 'OFF'));
    this.refreshPatterns();
    saveLayout();
  };

  // Automatic zigzag + clustered support/resistance as NON-interactive auto
  // drawings (excluded from hit-testing, undo and the drawings manager).
  Pane.prototype.renderAutoSR = function () {
    this.drawn = this.drawn.filter(function (d) { return !d.auto; });
    if (this.autoSR && this.candles.length >= 10) {
      var thr = this.interval === '1D' ? 2.5 : 1.2;
      // Bound the input (recent 2000 bars) so the O(n^2) level clustering
      // stays cheap on long histories and every candle close.
      var r = computeZigzagSR(this.candles.slice(-2000), thr);
      if (r.pivots.length >= 2) {
        this.drawn.push({
          id: 'auto-zig', type: 'zigzag', auto: true,
          color: 'rgba(150,170,205,0.6)', points: r.pivots,
        });
      }
      for (var i = 0; i < r.levels.length; i++) {
        var lv = r.levels[i];
        this.drawn.push({
          id: 'auto-sr-' + i, type: 'slevel', auto: true, p1: lv.price,
          color: lv.touches >= 3 ? '#ffb74d' : 'rgba(140,160,190,0.7)',
          label: 'S/R ' + lv.price.toFixed(2) + ' ×' + lv.touches,
          dash: lv.touches >= 3 ? [] : [4, 4],
        });
      }
    }
    if (this.primitive) this.primitive.requestUpdate();
  };

  Pane.prototype.toggleAutoSR = function () {
    this.autoSR = !this.autoSR;
    toast('📉 Auto S/R + zigzag ' + (this.autoSR ? 'ON' : 'OFF'));
    this.renderAutoSR();
    saveLayout();
  };

  // SMA-cross alerts: toast + beep when price crosses SMA20/50/200 on a
  // candle close (45 s cooldown per MA to avoid spam).
  Pane.prototype._smaAt = function (period, idx) {
    var c = this.candles;
    if (idx < period - 1 || idx >= c.length) return null;
    var s = 0;
    for (var i = idx - period + 1; i <= idx; i++) s += c[i].close;
    return s / period;
  };

  Pane.prototype._checkMaCrosses = function () {
    if (!this.maAlert) return;
    var c = this.candles, n = c.length;
    if (n < 3) return;
    var now = Date.now();
    var self = this;
    [20, 50, 200].forEach(function (per) {
      var key = 'sma' + per;
      if (now - (self._maAlertCd[key] || 0) < 45000) return;
      var prevS = self._smaAt(per, n - 2), curS = self._smaAt(per, n - 1);
      if (prevS == null || curS == null) return;
      var d0 = c[n - 2].close - prevS, d1 = c[n - 1].close - curS;
      if (d0 !== 0 && (d0 < 0) !== (d1 < 0)) {
        self._maAlertCd[key] = now;
        toast('〰 ' + self.symbol + ' crossed ' + (d1 > 0 ? 'above' : 'below') +
              ' SMA' + per + ' (' + curS.toFixed(2) + ')');
        beep();
      }
    });
  };

  Pane.prototype.toggleMaAlert = function () {
    this.maAlert = !this.maAlert;
    toast('〰 MA cross alerts ' + (this.maAlert ? 'ON' : 'OFF'));
    saveLayout();
  };

  // Symbol + interval text watermark (v5 plugin, bottom-left).
  Pane.prototype.applyWatermark = function () {
    var wm = this._watermark;
    if (wm) { try { wm.detach(); } catch (e) {} this._watermark = null; }
    if (!this.watermarkOn || !LightweightCharts.createTextWatermark) return;
    try {
      var pane = this.chart && this.chart.panes ? this.chart.panes()[0] : null;
      if (!pane) return;
      this._watermark = LightweightCharts.createTextWatermark(pane, {
        horzAlign: 'left', vertAlign: 'bottom',
        lines: [
          { text: this.symbol, color: 'rgba(130,150,175,0.30)', fontSize: 16, fontStyle: 'bold' },
          { text: this.interval + ' · ' + this.range, color: 'rgba(130,150,175,0.18)', fontSize: 11 },
        ],
      });
    } catch (e) {}
  };

  Pane.prototype.toggleWatermark = function () {
    this.watermarkOn = !this.watermarkOn;
    toast('💧 Watermark ' + (this.watermarkOn ? 'ON' : 'OFF'));
    this.applyWatermark();
    saveLayout();
  };

  Pane.prototype.toggleGrid = function () {
    this.gridOn = !this.gridOn;
    try {
      this.chart.applyOptions({
        grid: { vertLines: { visible: this.gridOn }, horzLines: { visible: this.gridOn } },
      });
    } catch (e) {}
    toast('▦ Grid ' + (this.gridOn ? 'ON' : 'OFF'));
    saveLayout();
  };

  Pane.prototype.toggleCrosshair = function () {
    this.crosshairOn = !this.crosshairOn;
    try {
      this.chart.applyOptions({
        crosshair: {
          mode: this.crosshairOn ? 1 : 0,
          vertLine: { visible: this.crosshairOn, labelVisible: this.crosshairOn },
          horzLine: { visible: this.crosshairOn, labelVisible: this.crosshairOn },
        },
      });
    } catch (e) {}
    toast('✛ Crosshair ' + (this.crosshairOn ? 'ON' : 'OFF'));
    saveLayout();
  };

  // Copy a deep link to the active chart (symbol/interval/layout) - the URL
  // is read back by embedParams() on load.
  Pane.prototype.copyLink = function () {
    var p = activePane() || this;
    var url = location.origin + location.pathname +
      '?symbol=' + encodeURIComponent(p.symbol) +
      '&interval=' + encodeURIComponent(p.interval) +
      '&layout=' + (state.layout || 1);
    var done = function () {
      toast('🔗 Link copied — opens ' + p.symbol + ' ' + p.interval);
    };
    var fallback = function () {
      var ta = document.createElement('textarea');
      ta.value = url;
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (e) {}
      document.body.removeChild(ta);
      done();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(done).catch(fallback);
    } else fallback();
  };

  function beep() {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      var ctx = window.__beepCtx || (window.__beepCtx = new AC());
      var o = ctx.createOscillator();
      var g = ctx.createGain();
      o.type = 'sine';
      o.frequency.value = 880;
      g.gain.value = 0.12;
      o.connect(g); g.connect(ctx.destination);
      o.start();
      setTimeout(function () { try { o.stop(); } catch (e) {} }, 160);
    } catch (e) {}
  }

  // Remove the forecast overlay + band from this pane entirely.
  Pane.prototype.clearKronos = function () {
    this.kronosData = null;
    this.kronosBand = null;
    this.kronosConfidence = null;
    this.kronosRegime = null;
    if (this.series && this.series.kronos) {
      this.series.kronos.setData([]);
      this.series.kronos.applyOptions({ visible: false });
    }
    if (this.kronosNoteEl) this.kronosNoteEl.hidden = true;
    if (this.primitive) this.primitive.requestUpdate();
  };

  Pane.prototype.setAutoPredict = function (on, skipFirstRun) {
    var self = this;
    this.autoPredict = on;
    this.autoNoteEl.hidden = !on;
    if (this.aiBtnEl) {
      this.aiBtnEl.classList.toggle('tv-btn-auto-on', on);
      this.aiBtnEl.title = on
        ? 'Kronos auto-predict ON for this chart - every new closed candle triggers a forecast'
        : 'Turn ON Kronos forecast + auto-predict for this chart only';
    }
    var btn = $('auto-btn');
    if (this === activePane()) {
      btn.classList.toggle('tv-btn-auto-on', on);
      btn.textContent = on ? '🔮 Auto on' : '🔮 Auto';
    }
    if (on) {
      // Stagger the first run per pane (4s apart) so several panes never hit
      // the CPU at the same instant. After that, auto-predict only fires on
      // every newly closed candle (onTick detects bucketSec > base.time and
      // calls autoPredictNow). No setInterval timer — the predictor should
      // NOT refresh unless a candle actually closed, otherwise the chart
      // flickers and re-fetches forecasts every 60s for no reason.
      if (!skipFirstRun) {
        var delay = (this.index || 0) * 4000;
        setTimeout(function () {
          if (!self.destroyed && self.autoPredict) self.autoPredictNow(true);
        }, delay);
      }
    } else {
      // Switching AI off for this chart also removes its forecast overlay,
      // so only the panes you selected keep showing Kronos predictions.
      this.clearKronos();
    }
    saveLayout();
  };

  Pane.prototype.autoPredictNow = function (force) {
    var now = Date.now();
    if (!force && now - this.lastAutoRun < 15000) {
      // A forecast ran very recently - don't queue another. A fresh enough
      // prediction exists, so finalize the pending candle now instead of
      // leaving the chart waiting on an AI run.
      if (this._needRefresh) { this._needRefresh = false; this.refreshLiveData(); }
      if (this._aiPending) { this._aiPending = false; this.autoNoteEl.hidden = true; }
      return;
    }
    this.lastAutoRun = now;
    this.runKronos();
  };

  /* ------------------------------ pane events ----------------------------- */
  Pane.prototype.populateSymbols = function (force) {
    var self = this;
    var sel = this.selectEl;
    // Called once at construction (before /api/symbols arrives) and again
    // from init() once the watchlist loads - always rebuild from scratch so
    // the dropdown never accumulates duplicate options.
    sel.innerHTML = '';
    (state.symbols || []).forEach(function (s) {
      var o = el('option');
      o.value = s;
      o.textContent = s;
      sel.appendChild(o);
    });
    if (state.symbols.length) {
      var idx = state.symbols.indexOf(self.symbol);
      sel.value = idx >= 0 ? self.symbol : state.symbols[0];
      self.symbol = sel.value;
    } else if (!force) {
      // Watchlist hasn't loaded yet (panes are created during boot before
      // /api/symbols resolves) - skip the fetch. init() re-calls us once the
      // symbols arrive, so panes never double-fetch history or open two
      // WebSockets at startup.
      return Promise.resolve();
    }
    return this.loadHistory().then(function () {
      self.connectWS();
      self.applyRestoredView();
      // Restored auto-predict: run the first forecast once candles are real
      // (staggered per pane so they never hit the GPU at the same instant).
      if (self.autoPredict) {
        setTimeout(function () {
          if (!self.destroyed && self.autoPredict) self.autoPredictNow(true);
        }, (self.index || 0) * 4000);
      }
    });
  };

  // Restore the persisted visible range after history loads (the range only
  // exists once candles are on the scale). Consumed once per pane load.
  Pane.prototype.applyRestoredView = function () {
    var v = this._restoreView;
    this._restoreView = null;
    if (!v) return;
    var self = this;
    setTimeout(function () {
      if (self.destroyed) return;
      try {
        self.chart.timeScale().setVisibleLogicalRange({ from: v.from, to: v.to });
      } catch (e) {}
    }, 30);
  };

  Pane.prototype.wirePaneEvents = function () {
    var self = this;

    this.container.addEventListener('pointerdown', function () { self.focus(); });

    // Debounced server-side search over the FULL SmartAPI universe (NSE +
    // NFO futures/options + BSE + MCX). The curated dropdown is only the
    // default - typing 2+ chars queries /api/search and rebuilds the option
    // list from the results so any Angel chartable instrument is reachable.
    this.searchEl.addEventListener('input', function () {
      var q = self.searchEl.value.trim();
      var list = state.symbols || [];
      if (q.length >= 2) {
        clearTimeout(self._searchTimer);
        self._searchTimer = setTimeout(function () {
          fetch('/api/search?q=' + encodeURIComponent(q) + '&limit=30')
            .then(function (r) { return r.json(); })
            .then(function (d) {
              if (self.searchEl.value.trim() !== q) return;  // stale keystroke
              list = d.results || [];
              self.rebuildSymbolOptions(list);
              self.selectEl.value = list[0] || '';
            })
            .catch(function () {});
        }, 180);
        return;
      }
      self.rebuildSymbolOptions(list);
    });
    this.searchEl.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') {
        var vis = Array.prototype.filter.call(self.selectEl.options, function (o) { return !o.hidden; });
        if (vis.length) {
          self.selectEl.value = vis[0].value;
          self.setSymbol(vis[0].value);
        }
      }
    });

    this.selectEl.addEventListener('change', function () {
      self.setSymbol(self.selectEl.value);
    });

    this.paneIntervalsEl.querySelectorAll('button').forEach(function (b) {
      b.addEventListener('click', function () {
        self.paneIntervalsEl.querySelectorAll('button').forEach(function (x) {
          x.classList.remove('tv-btn-active');
        });
        b.classList.add('tv-btn-active');
        self.interval = b.dataset.interval;
        self._degradedOnce = false;   // manual switch: allow re-degrade if missing
        self.currentCandle = null;
        if (self === activePane()) {
          document.querySelectorAll('#tf-buttons .tv-btn').forEach(function (x) {
            x.classList.toggle('tv-btn-active', x.dataset.tf === self.interval);
          });
        }
        saveLayout();
        self.loadHistory();
      });
    });


    // Per-pane AI switch: enable/disable this chart's forecast + auto-predict
    // independently of the other panes.
    this.aiBtnEl.addEventListener('click', function () {
      self.setAutoPredict(!self.autoPredict);
    });

  };

  // Replace the dropdown options with a fresh label list (server search
  // results, or the curated watchlist when the search box is empty).
  Pane.prototype.rebuildSymbolOptions = function (labels) {
    var sel = this.selectEl;
    sel.innerHTML = '';
    (labels || []).forEach(function (s) {
      var o = el('option');
      o.value = s;
      o.textContent = s;
      sel.appendChild(o);
    });
  };

  /* ---------------------- Buy/Sell markers (series markers) -------------- */
  Pane.prototype.addMarker = function (side) {
    if (!this.candles.length) { toast('No candles loaded yet', 'err'); return; }
    var t = this.candles[this.candles.length - 1].time;
    var price = this.currentCandle ? this.currentCandle.close
      : this.candles[this.candles.length - 1].close;
    var marker = {
      id: 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      time: t, price: price, side: side,
    };
    this.markers = this.markers || [];
    this.markers.push(marker);
    this.renderMarkers();
    saveLayout();
    toast((side === 'buy' ? '▲ Buy' : '▼ Sell') + ' marker @ ' + fmtIST(t, { year: false }) + ' ' + price.toFixed(2));
  };

  Pane.prototype.renderMarkers = function () {
    if (!this.chart || !this.series.candle) return;
    var ms = (this.markers || []).map(function (m) {
      return {
        time: m.time, position: m.side === 'buy' ? 'belowBar' : 'aboveBar',
        color: m.side === 'buy' ? '#26a69a' : '#ef5350',
        shape: m.side === 'buy' ? 'arrowUp' : 'arrowDown',
        text: m.side === 'buy' ? 'Buy' : 'Sell',
        size: 1,
      };
    });
    // Candlestick pattern markers when the scan is ON for this pane.
    if (this.patternScan && this.patterns && this.patterns.length) {
      this.patterns.forEach(function (p) {
        ms.push({
          time: p.time,
          position: p.dir === -1 ? 'aboveBar' : 'belowBar',
          color: p.dir === 1 ? '#26a69a' : (p.dir === -1 ? '#ef5350' : '#90a4ae'),
          shape: p.dir === 1 ? 'arrowUp' : (p.dir === -1 ? 'arrowDown' : 'circle'),
          text: p.text || p.type,
          size: 0.9,
        });
      });
    }
    try {
      if (LightweightCharts.createSeriesMarkers) {
        this.series.candle.setMarkers(ms);
      }
    } catch (e) {}
  };

  Pane.prototype.removeMarkerAt = function (time) {
    if (!this.markers) return;
    var before = this.markers.length;
    this.markers = this.markers.filter(function (m) { return m.time !== time; });
    if (this.markers.length !== before) { this.renderMarkers(); saveLayout(); }
  };

  /* ------------------- compare / overlay symbol --------------------------- */
  Pane.prototype.setPriceAlert = function (price) {
    var self = this;
    if (!price || isNaN(price)) return;
    fetch('/api/alerts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: this.symbol, price: price, direction: 'cross', note: '' }),
    }).then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.ok) {
          toast('🔔 Alert armed @ ' + price.toFixed(2) + ' on ' + self.symbol);
          refreshAlertsPanel();
        }
      }).catch(function () {});
  };

  // Rebuild the popover list from the current drawings.
  Pane.prototype.renderDrawingManager = function () {
    if (!this.drawPopEl) return;
    var pop = this.drawPopEl;
    // Auto overlays (S/R, zigzag) are chart-managed - only list user drawings.
    var user = this.drawn.filter(function (d) { return !d.auto; });
    if (!user.length) {
      pop.innerHTML = '<div class="drawings-empty">No drawings on this chart yet.</div>';
      return;
    }
    var self = this;
    var rows = '';
    for (var i = 0; i < user.length; i++) {
      var d = user[i];
      var label = (d.type || 'drawing') +
        (d.p1 != null ? ' @ ' + d.p1.toFixed(2) : '');
      rows += '<div class="drawings-row' + (d.id === this.selectedId ? ' sel' : '') + '">' +
        '<span class="drawings-label">' + label + '</span>' +
        '<button class="drawings-del" data-id="' + d.id + '" title="Delete this drawing">✕</button>' +
        '</div>';
    }
    pop.innerHTML = '<div class="drawings-head">Drawings (' + user.length + ')</div>' +
      rows +
      '<div class="drawings-foot">' +
      '<button id="drawings-clear" class="tv-btn tv-btn-sm tv-btn-danger">Clear all</button>' +
      '</div>';
    pop.querySelectorAll('.drawings-del').forEach(function (b) {
      b.addEventListener('click', function () {
        self.deleteDrawing(parseInt(b.dataset.id, 10));
        if (self.drawn.length) self.renderDrawingManager();
      });
    });
    var clr = pop.querySelector('#drawings-clear');
    if (clr) clr.addEventListener('click', function () {
      self.clearDrawings();
      pop.hidden = true;
    });
  };

  Pane.prototype.toggleDrawingManager = function () {
    this.renderDrawingManager();
    this.drawPopEl.hidden = !this.drawPopEl.hidden;
  };

  // Live count badge on the pane's 🧾 button.
  Pane.prototype.updateDrawBtn = function () {
    if (!this.drawBtnEl) return;
    var n = this.drawn.length;
    this.drawBtnEl.textContent = n ? '🧾 ' + n : '🧾';
    this.drawBtnEl.title = 'Manage drawings (' + n + ') — select which to delete';
  };

  Pane.prototype.setSymbol = function (sym) {
    if (sym === this.symbol) return;
    this.symbol = sym;
    this._degradedOnce = false;   // new symbol may have intraday cache
    this.clearDrawings();
    // Old auto S/R lines belong to the PREVIOUS symbol - drop them now so
    // they don't flash over the new chart until the fresh history loads.
    this.drawn = this.drawn.filter(function (d) { return !d.auto; });
    this.clearCompare();
    this.loadHistory().then(function () { this.connectWS(); }.bind(this));
    saveLayout();
    if (this === activePane()) refreshNewsPanel();
  };

  Pane.prototype.focus = function () {
    setActivePane(this.index);
  };

  Pane.prototype.destroy = function () {
    this.destroyed = true;
    // Cancel any in-flight history fetch - its callbacks are destroyed-guarded
    // too, but aborting stops wasted work and releases the AbortController.
    if (this._histAbort) {
      try { this._histAbort.abort(); } catch (e) {}
      this._histAbort = null;
    }
    // If its settings popover is open, close it (the pane is gone).
    var isp = $('ind-settings');
    if (isp && !isp.hidden && activePane() === this) isp.hidden = true;
    if (this._viewSaveTimer) { clearTimeout(this._viewSaveTimer); this._viewSaveTimer = null; }
    if (this.ws) { try { this.ws.close(); } catch (e) {} this.ws = null; }
    if (this.wsTimer) { clearTimeout(this.wsTimer); this.wsTimer = null; }
    if (this.autoTimer) { clearInterval(this.autoTimer); this.autoTimer = null; }
    if (this.resizeObserver) { try { this.resizeObserver.disconnect(); } catch (e) {} }
    if (this._fsChangeSub) {
      try {
        document.removeEventListener('fullscreenchange', this._fsChangeSub);
        document.removeEventListener('webkitfullscreenchange', this._fsChangeSub);
      } catch (e) {}
    }
    if (this._popOutsideSub) {
      try { document.removeEventListener('pointerdown', this._popOutsideSub); } catch (e) {}
      this._popOutsideSub = null;
    }
    if (this._ctxSub) {
      try { this.chartEl.removeEventListener('contextmenu', this._ctxSub); } catch (e) {}
      this._ctxSub = null;
    }
    if (this._ptrDownSub) {
      try { this.chartEl.removeEventListener('pointerdown', this._ptrDownSub, true); } catch (e) {}
      window.removeEventListener('pointermove', this._ptrMoveSub);
      window.removeEventListener('pointerup', this._ptrUpSub);
      this._ptrDownSub = null;
    }
    if (this.chart) {
      try {
        this.chart.timeScale().unsubscribeVisibleLogicalRangeChange(this._rangeSub);
        this.chart.unsubscribeClick(this._clickSub);
        this.chart.unsubscribeCrosshairMove(this._crossSub);
        this.chart.remove();
      } catch (e) {}
      this.chart = null;
    }
    if (this.container.parentNode) this.container.parentNode.removeChild(this.container);
  };

  /* =========================================================================
     Layout / active-pane management
     ========================================================================= */
  // Show/hide the news / patterns / alerts sidebar (☰ toolbar button or the
  // right-click menu). The state is persisted across sessions.
  function toggleSidebar() {
    setSidebarHidden(!($('sidebar') && $('sidebar').classList.contains('hidden-side')));
  }
  function setSidebarHidden(hidden) {
    var sb = $('sidebar');
    if (!sb) return;
    sb.classList.toggle('hidden-side', !!hidden);
    var b = $('side-toggle');
    if (b) b.classList.toggle('tv-btn-side-hidden', !!hidden);
    saveLayout();
  }

  function setLayout(n) {
    saveLayout();
    n = Math.max(1, Math.min(MAX_PANES, n));
    var grid = $('chart-grid');
    // grow
    while (state.panes.length < n) {
      var container = el('div', 'pane');
      grid.appendChild(container);
      var pane = new Pane(state.panes.length, container);
      state.panes.push(pane);
    }
    // shrink
    while (state.panes.length > n) {
      state.panes.pop().destroy();
    }
    if (state.activeIndex >= state.panes.length) state.activeIndex = 0;
    grid.className = 'layout-' + n;
    state.layout = n;
    document.querySelectorAll('#layout-buttons .tv-btn').forEach(function (b) {
      b.classList.toggle('tv-btn-active', parseInt(b.dataset.layout, 10) === n);
    });
    setActivePane(state.activeIndex);
  }

  function setActivePane(index) {
    if (!state.panes.length) return;
    index = Math.max(0, Math.min(state.panes.length - 1, index));
    state.activeIndex = index;
    state.panes.forEach(function (p, i) {
      p.container.classList.toggle('active', i === index);
    });
    syncToolbarFor(activePane());
    renderPatternsPanel();
    refreshNewsPanel();
    saveLayout();
  }

  function syncToolbarFor(pane) {
    if (!pane) return;
    $('st-symbol').textContent = pane.symbol;
    $('st-interval').textContent = pane.interval;
    $('st-candles').textContent = pane.candles.length + ' candles';
    pane.syncFeedBadge();
    pane.updateCount();
    pane.updateLegend();
    // timeframe active state
    document.querySelectorAll('#tf-buttons .tv-btn').forEach(function (b) {
      b.classList.toggle('tv-btn-active', b.dataset.tf === pane.interval);
    });
    // range active state
    document.querySelectorAll('#range-buttons .tv-btn').forEach(function (b) {
      b.classList.toggle('tv-btn-active', b.dataset.range === pane.range);
    });
    // type active state
    document.querySelectorAll('#type-buttons .tv-btn').forEach(function (b) {
      b.classList.toggle('tv-btn-active', b.dataset.charttype === pane.chartType);
    });
    // indicators
    document.querySelectorAll('#indicator-buttons .tv-ind').forEach(function (b) {
      b.classList.toggle('tv-btn-active', !!pane.indicators[b.dataset.ind]);
    });
    pane.refreshIndicatorButtons();
    // auto button
    var ab = $('auto-btn');
    ab.classList.toggle('tv-btn-auto-on', pane.autoPredict);
    ab.textContent = pane.autoPredict ? '🔮 Auto on' : '🔮 Auto';
    // volume toggle state
    var vb = $('vol-btn');
    if (vb) vb.classList.toggle('tv-btn-active', pane.showVolume);
    // day-lines (session breaks) toggle state
    var db = $('day-breaks-btn');
    if (db) db.classList.toggle('tv-btn-active', pane.sessionBreaks);
    // drawings count badge on this pane's manager button
    pane.updateDrawBtn();
    // scale mode buttons
    document.querySelectorAll('#scale-buttons .tv-btn[data-scale]').forEach(function (b) {
      b.classList.toggle('tv-btn-active', b.dataset.scale === pane.scaleMode);
    });
    // drawing color picker reflects the focused pane's color
    var dc = $('draw-color');
    if (dc) dc.value = pane.drawColor || '#2962ff';
  }

  /* ------------------------------ toolbar wiring -------------------------- */
  function wireToolbar() {
    var tfGroup = $('tf-buttons');
    if (tfGroup) {
      tfGroup.querySelectorAll('button').forEach(function (b) {
        b.addEventListener('click', function () {
          var p = activePane();
          if (!p) return;
        p.interval = b.dataset.tf;
        p._degradedOnce = false;
        p.currentCandle = null;
        p.paneIntervalsEl.querySelectorAll('button').forEach(function (x) {
          x.classList.toggle('tv-btn-active', x.dataset.interval === p.interval);
        });
        document.querySelectorAll('#tf-buttons .tv-btn').forEach(function (x) {
          x.classList.toggle('tv-btn-active', x.dataset.tf === p.interval);
        });
        saveLayout();
        p.loadHistory();
        });
      });
    }

    $('range-buttons').querySelectorAll('button').forEach(function (b) {
      b.addEventListener('click', function () {
        var p = activePane();
        if (!p) return;
        p.range = b.dataset.range;
        document.querySelectorAll('#range-buttons .tv-btn').forEach(function (x) {
          x.classList.remove('tv-btn-active');
        });
        b.classList.add('tv-btn-active');
        p.loadHistory();
      });
    });

    $('type-buttons').querySelectorAll('button').forEach(function (b) {
      b.addEventListener('click', function () {
        var p = activePane();
        if (!p) return;
        p.chartType = b.dataset.charttype;
        p.applyChartType();
        document.querySelectorAll('#type-buttons .tv-btn').forEach(function (x) {
          x.classList.remove('tv-btn-active');
        });
        b.classList.add('tv-btn-active');
        saveLayout();
      });
    });

    $('vol-btn').addEventListener('click', function () {
      var p = activePane();
      if (p) p.toggleVolume();
    });
    $('kronos-btn').addEventListener('click', function () {
      var p = activePane();
      if (p) p.runKronos(true);
    });

    $('auto-btn').addEventListener('click', function () {
      var p = activePane();
      if (p) p.setAutoPredict(!p.autoPredict);
    });

    $('reset-btn').addEventListener('click', function () {
      var p = activePane();
      if (p) p.resetView();
    });

    $('screenshot-btn').addEventListener('click', function () {
      var p = activePane();
      if (p) p.screenshot();
    });

    $('fullscreen-btn').addEventListener('click', function () {
      var p = activePane();
      if (p) p.toggleFullscreen();
    });

    // TradingView-style shortcuts: Alt+T/H/V/F tools, Alt+S screenshot,
    // Ctrl+K focus the symbol search, Esc cancels the active tool. While
    // typing in any input (symbol search), keys pass through untouched and
    // Escape only blurs the field - it never cancels a drawing tool.
    document.addEventListener('keydown', function (ev) {
      var p = activePane();
      if (!p) return;
      var tag = document.activeElement ? document.activeElement.tagName : '';
      var typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      // Alt shortcuts (screenshot, RESET) fire even while an input has focus.
      if (ev.altKey && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey) {
        if (ev.key === 's' || ev.key === 'S') {
          ev.preventDefault();
          $('screenshot-btn').click();
          return;
        }
        if (ev.key === 'r' || ev.key === 'R') {
          ev.preventDefault();
          p.resetView();
          return;
        }
        return;
      }
      if (typing) {
        if (ev.key === 'Escape' && document.activeElement) {
          document.activeElement.blur();
        }
        return;
      }
      // TradingView keyboard navigation: +/- (or =/_ ) zoom the time scale
      // bar spacing; ←/→ scroll through time. Never fires while typing.
      if (ev.key === '+' || ev.key === '=' || ev.key === '-' || ev.key === '_') {
        ev.preventDefault();
        var ts1 = p.chart.timeScale();
        var cur1 = ts1.getBarSpacing ? ts1.getBarSpacing() : 0;
        if (cur1) {
          var zoomIn = ev.key === '+' || ev.key === '=';
          var next1 = zoomIn ? cur1 * 1.2 : cur1 / 1.2;
          ts1.applyOptions({ barSpacing: Math.max(2, Math.min(80, next1)) });
        }
        return;
      }
      // ↑/↓ cycle through the watchlist symbols on the focused chart
      // (TradingView watchlist navigation).
      if (ev.key === 'ArrowUp' || ev.key === 'ArrowDown') {
        ev.preventDefault();
        var opts = Array.prototype.slice.call(p.selectEl.options)
          .filter(function (o) { return !o.hidden; });
        if (!opts.length) return;
        var curIdx = -1;
        for (var oi = 0; oi < opts.length; oi++) {
          if (opts[oi].value === p.symbol) { curIdx = oi; break; }
        }
        if (curIdx < 0) curIdx = 0;
        var ni = ev.key === 'ArrowUp'
          ? (curIdx - 1 + opts.length) % opts.length
          : (curIdx + 1) % opts.length;
        var nextSym = opts[ni].value;
        p.selectEl.value = nextSym;
        p.setSymbol(nextSym);
        toast('⇄ ' + nextSym);
        return;
      }
      if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
        ev.preventDefault();
        var ts2 = p.chart.timeScale();
        var range2 = ts2.getVisibleLogicalRange();
        if (range2) {
          var step2 = Math.max(1, Math.round((range2.to - range2.from) * 0.2));
          var dir2 = ev.key === 'ArrowLeft' ? -step2 : step2;
          ts2.setVisibleLogicalRange({ from: range2.from + dir2, to: range2.to + dir2 });
        }
        return;
      }
      if (ev.key === 'Escape') {
        if (ctxMenu && !ctxMenu.hidden) { ctxMenu.hidden = true; return; }
        p.setActiveTool(null);
        if (p.primitive) p.primitive.requestUpdate();
        return;
      }
      if ((ev.ctrlKey || ev.metaKey) && (ev.key === 'k' || ev.key === 'K')) {
        ev.preventDefault();
        p.searchEl.focus();
        p.searchEl.select();
      }
    });
  }

  /* ------------------------------ clock ----------------------------------- */
  function tickClock() {
    var now = new Date(Date.now() + IST_OFFSET_MS);
    $('st-clock').textContent = 'IST ' + now.toISOString().slice(11, 19);
  }

  /* ------------------------------ boot ------------------------------------ */
  /* Embedding support: the Kronos Local Lab opens this terminal with URL
     params so the embedded chart shows exactly what the lab selected:
       ?symbol=Nifty 50&interval=1m&ai=1&layout=1
     - symbol   preselects pane 0's market (must exist in the watchlist)
     - interval preselects pane 0's timeframe
     - ai=1     switches the Kronos forecast + auto-predict ON for pane 0
     - layout   number of panes (default 1 = single chart, TradingView-style) */
  function embedParams() {
    var out = {};
    try {
      var q = new URLSearchParams(window.location.search);
      if (q.has('symbol')) out.symbol = q.get('symbol').trim();
      if (q.has('interval')) {
        var iv = q.get('interval').trim();
        if (INTERVAL_BUTTONS.indexOf(iv) >= 0) out.interval = iv;
      }
      var ai = q.get('ai');
      if (ai === '1' || ai === 'true' || ai === 'on') out.ai = true;
      var ly = parseInt(q.get('layout'), 10);
      if (ly >= 1 && ly <= MAX_PANES) out.layout = ly;
    } catch (e) {}
    return out;
  }

  /* ------------------- compare popover / layout persistence -------------- */
  function toggleComparePop() {
    var pop = $('cmp-pop');
    if (!pop) return;
    if (!pop.hidden) { pop.hidden = true; return; }
    var p = activePane();
    pop.hidden = false;
    if (p) $('cmp-input').value = p.compareSymbol || '';
    $('cmp-input').focus();
    var r = $('compare-btn').getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 300)) + 'px';
    pop.style.top = (r.bottom + 6) + 'px';
  }

  function saveLayout() {
    try {
      var data = {
        layout: state.layout,
        activeIndex: state.activeIndex,
        panes: state.panes.map(function (p) {
          return {
            symbol: p.symbol, interval: p.interval, range: p.range || '5D',
            chartType: p.chartType || 'candles',
            scaleMode: p.scaleMode || 'auto',
            showVolume: p.showVolume !== false,
            indicators: Object.keys(INDICATORS).filter(function (k) { return !!p.indicators[k]; }),
            indicatorConfigs: p.indicators || {},
            markers: p.markers || [],
            compare: p.compareSymbol || null,
            drawings: (p.drawn || []).filter(function (d) { return !d.auto; }),
            autoPredict: !!p.autoPredict,
            patternScan: !!p.patternScan,
            autoSR: !!p.autoSR,
            maAlert: !!p.maAlert,
            watermarkOn: p.watermarkOn !== false,
            gridOn: p.gridOn !== false,
            crosshairOn: p.crosshairOn !== false,
            sessionBreaks: p.sessionBreaks !== false,
        volProfile: !!p.volProfile,
        view: p._lastView || null,
        aiCollapsed: !!(p.container && p.container.querySelector('.kronos-note')
          && p.container.querySelector('.kronos-note').classList.contains('collapsed')),
      };
        }),
        sidebarHidden: !!($('sidebar') && $('sidebar').classList.contains('hidden-side')),
      };
      localStorage.setItem('kronos_layout_v1', JSON.stringify(data));
    } catch (e) {}
  }

  function restoreLayout() {
    try {
      var raw = localStorage.getItem('kronos_layout_v1');
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) { return null; }
  }

  /* --------------------------- alerts panel ------------------------------- */
  function refreshAlertsPanel() {
    var list = $('al-list');
    if (!list) return;
    fetch('/api/alerts').then(function (r) { return r.json(); })
      .then(function (d) {
        var alerts = d.alerts || [];
        list.innerHTML = '';
        if (!alerts.length) {
          list.innerHTML = '<div class="al-empty">No alerts — draw an H-line or click the price scale to arm one.</div>';
          return;
        }
        alerts.forEach(function (a) {
          var row = el('div', 'al-row');
          row.appendChild(el('span', 'al-sym', a.symbol));
          row.appendChild(el('span', 'al-price', String(Number(a.price).toFixed(2))));
          row.appendChild(el('span', 'al-dir', a.direction || 'cross'));
          var rm = el('button', 'al-rm', '✕');
          rm.title = 'Delete alert';
          rm.addEventListener('click', function () {
            fetch('/api/alerts/' + a.id, { method: 'DELETE' }).then(refreshAlertsPanel).catch(function () {});
          });
          row.appendChild(rm);
          list.appendChild(row);
        });
      }).catch(function () {});
  }

  /* --------------------------- news panel -------------------------------- */
  // Sidebar NEWS panel: headlines + VADER sentiment for the FOCUSED pane's
  // symbol (server /api/news, TTL-cached). Clicking a headline opens it.
  var _newsToken = 0;
  function refreshNewsPanel() {
    var list = $('news-list');
    if (!list) return;
    var p = activePane();
    var sym = (p && p.symbol) || 'Nifty 50';
    var token = ++_newsToken;
    list.innerHTML = '<div class="al-empty news-loading">Fetching news for ' + sym + '…</div>';
    fetch('/api/news?symbol=' + encodeURIComponent(sym) + '&limit=8')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (token !== _newsToken) return;      // stale (symbol changed)
        var items = d.news || [];
        list.innerHTML = '';
        if (!items.length) {
          // textContent (not innerHTML): the server's error string is
          // external input and must never be parsed as markup.
          var empty = el('div', 'al-empty');
          empty.textContent = 'No headlines right now' +
            (d.error ? ' (' + d.error + ')' : '') + '.';
          list.appendChild(empty);
          return;
        }
        items.forEach(function (h) {
          var sc = Number(h.sentiment) || 0;
          var cls = sc >= 0.05 ? 'pos' : (sc <= -0.05 ? 'neg' : 'neu');
          var label = sc >= 0.05 ? '▲' : (sc <= -0.05 ? '▼' : '—');
          var row = el('div', 'news-row ' + cls);
          row.title = (h.title || '') + ' — open in a new tab';
          // External RSS titles/sources must render as TEXT, never markup.
          var titleEl = el('span', 'news-title');
          titleEl.textContent = h.title || '';
          row.appendChild(titleEl);
          var meta = el('div', 'news-meta');
          meta.appendChild(el('span', 'news-sent ' + cls, label + ' ' + sc.toFixed(2)));
          var srcEl = el('span', 'news-src');
          srcEl.textContent = (h.source || '') +
            (h.published_ist && h.published_ist !== '—' ? ' · ' + h.published_ist : '');
          meta.appendChild(srcEl);
          if (h.link) {
            row.addEventListener('click', function () { window.open(h.link, '_blank'); });
          }
          list.appendChild(row);
        });
      })
      .catch(function () {
        if (token === _newsToken) {
          list.innerHTML = '<div class="al-empty">News unavailable (offline?).</div>';
        }
      });
  }

  /* --------------------------- patterns panel ---------------------------- */
  // The sidebar PATTERNS panel mirrors the focused pane's detected patterns.
  // Watchlist-scan rows open the signal's symbol in pane 0 when clicked.
  // (Patterns are detected on the tail of the candle array - see
  // refreshPatterns - so the panel always stays responsive on live closes.)
  function renderPatternsPanel() {
    var list = $('pt-list');
    if (!list) return;
    var p = activePane();
    if (!p || !p.patternScan) {
      list.innerHTML = '<div class="al-empty">Pattern scan is OFF — enable it via the chart’s right-click menu (🔎 Pattern scan).</div>';
      return;
    }
    var sigs = p.patterns || [];
    if (!sigs.length) {
      list.innerHTML = '<div class="al-empty">No patterns detected on ' + p.symbol + ' yet.</div>';
      return;
    }
    list.innerHTML = '';
    sigs.slice(-30).reverse().forEach(function (s) {
      var row = el('div', 'al-row pt-row');
      var b = el('span', 'pt-badge ' + (s.dir === 1 ? 'up' : s.dir === -1 ? 'down' : 'flat'), s.type);
      row.appendChild(b);
      row.appendChild(el('span', 'pt-time', fmtISTDate(s.time)));
      row.title = s.text + ' on ' + p.symbol + ' at ' + fmtIST(s.time);
      list.appendChild(row);
    });
  }

  // Batch-scan the watchlist (5m, 2 days) for candlestick patterns and list
  // the hits - clicking a row loads that symbol into pane 0.
  function scanWatchlistPatterns() {
    var targets = (state.symbols || []).slice(0, 12);
    var list = $('pt-list');
    if (!list) return;
    if (!targets.length) { list.innerHTML = '<div class="al-empty">No symbols to scan.</div>'; return; }
    list.innerHTML = '<div class="al-empty">Scanning ' + targets.length + ' symbols…</div>';
    toast('🔎 Scanning ' + targets.length + ' symbols for patterns…');
    var hits = [];
    var i = 0;
    function next() {
      if (i >= targets.length) {
        if (hits.length) {
          list.innerHTML = '';
          hits.forEach(function (h) {
            var row = el('div', 'al-row pt-row clickable');
            row.appendChild(el('span', 'pt-badge ' + (h.dir === 1 ? 'up' : h.dir === -1 ? 'down' : 'flat'), h.type));
            row.appendChild(el('span', 'pt-sym', h.symbol));
            row.appendChild(el('span', 'pt-time', fmtISTDate(h.time)));
            row.addEventListener('click', function () {
              setActivePane(0);
              if (state.panes[0]) state.panes[0].setSymbol(h.symbol);
            });
            list.appendChild(row);
          });
          toast('🔎 Scan done — ' + hits.length + ' signals across ' + targets.length + ' symbols');
        } else {
          list.innerHTML = '<div class="al-empty">No patterns found in the last 2 days of 5m data.</div>';
          toast('🔎 Scan done — no signals found');
        }
        var p = activePane();
        if (p && p.patternScan) renderPatternsPanel();
        return;
      }
      var sym = targets[i]; i += 1;
      fetch('/api/history?symbol=' + encodeURIComponent(sym) + '&interval=5m&days=2')
        .then(function (r) { return r.json(); })
        .then(function (d) {
          if (d.candles && d.candles.length > 5) {
            detectPatterns(d.candles.slice(-1000)).forEach(function (s) {
              hits.push({ symbol: sym, type: s.type, dir: s.dir, text: s.text, time: s.time });
            });
          }
        })
        .catch(function () {})
        .then(function () { setTimeout(next, 40); });
    }
    next();
  }

  function init() {
    var embed = embedParams();
    wireToolbar();
    // Right-click context menu (TradingView-style): close on outside click,
    // window blur/resize, and scroll.
    ctxMenu = buildContextMenu();
    document.addEventListener('pointerdown', function (ev) {
      if (ctxMenu && !ctxMenu.hidden && !ctxMenu.contains(ev.target)) ctxMenu.hidden = true;
    });
    window.addEventListener('blur', hideContextMenu);
    window.addEventListener('resize', hideContextMenu);
    document.addEventListener('wheel', hideContextMenu, { passive: true });

    var saved = restoreLayout();
    // TradingView-style default on open: ONE chart at the recent-candles
    // window. The saved multi-pane layout and saved zoom are NOT restored -
    // the reset view wins so you never open into the whole history at once.
    // The embed can still request its own layout (?layout=1).
    setLayout(embed.layout || 1);

    // The sidebar (news / patterns / alerts) hide state persists across
    // sessions - apply it BEFORE setLayout()'s first saveLayout() so it
    // sticks.
    if (saved && saved.sidebarHidden) setSidebarHidden(true);

    // Preselect pane 0 BEFORE the symbol list arrives so populateSymbols()
    // keeps the embed symbol (it falls back to the first symbol in the list
    // when the requested symbol isn't in it).
    if (embed.symbol && state.panes.length) {
      state.panes[0].symbol = embed.symbol;
      if (embed.interval) state.panes[0].interval = embed.interval;
    } else if (saved && saved.panes && state.panes.length) {
      // Keep per-pane settings (symbol/interval/chart-type/toggles/drawings)
      // on the single default chart so it continues where you left off - but
      // NEVER restore the saved zoom: the recent-candles reset view wins.
      // Indicator configs + compare are applied after history loads below.
      saved.panes.forEach(function (cfg, i) {
        var p = state.panes[i];
        if (!p) return;
        if (cfg.symbol) p.symbol = cfg.symbol;
        if (cfg.interval) p.interval = cfg.interval;
        if (cfg.chartType) p.chartType = cfg.chartType;
        if (cfg.scaleMode) p.scaleMode = cfg.scaleMode;
        if (cfg.markers) p.markers = cfg.markers;
        // NOTE: cfg.view (the saved zoom) is deliberately ignored on open.
        p.autoPredict = !!cfg.autoPredict;
        p.autoNoteEl.hidden = !p.autoPredict;
        if (p.aiBtnEl) p.aiBtnEl.classList.toggle('tv-btn-auto-on', p.autoPredict);
        p.patternScan = !!cfg.patternScan;
        p.autoSR = !!cfg.autoSR;
        p.maAlert = !!cfg.maAlert;
        p.watermarkOn = cfg.watermarkOn !== false;
        p.gridOn = cfg.gridOn !== false;
        p.crosshairOn = cfg.crosshairOn !== false;
        p.sessionBreaks = cfg.sessionBreaks !== false;
        p.volProfile = !!cfg.volProfile;
        if (cfg.aiCollapsed && p.kronosNoteEl) p.kronosNoteEl.classList.add('collapsed');
        var userD = (cfg.drawings || []).filter(function (d) { return d && d.type; });
        if (userD.length) {
          p.drawn = userD;
          var mx = 0;
          userD.forEach(function (d) { if (typeof d.id === 'number' && d.id > mx) mx = d.id; });
          p.nextId = mx + 1;
        }
      });
    }

    fetch('/api/symbols').then(function (r) { return r.json(); }).then(function (d) {
      state.symbols = d.symbols || [];
      var embedPromise = null;
      state.panes.forEach(function (p) {
        var pr = p.populateSymbols();
        if (p.index === 0) embedPromise = pr;   // history load for the embed pane
      });
      // Restore per-pane indicators + compare after the first history load.
      if (saved && saved.panes) {
        saved.panes.forEach(function (cfg, i) {
          var p = state.panes[i];
          if (!p) return;
          // Full indicator configs first (custom periods/colors), then any
          // legacy 'indicators' key list as defaults for the rest.
          if (cfg.indicatorConfigs) {
            Object.keys(cfg.indicatorConfigs).forEach(function (k) {
              if (!INDICATORS[k]) return;
              var merged = indicatorDefaults(k);
              var sc = cfg.indicatorConfigs[k];
              if (sc && typeof sc === 'object') {
                Object.keys(sc).forEach(function (f) { merged[f] = sc[f]; });
              }
              p.indicators[k] = merged;
            });
          }
          if (cfg.indicators) {
            cfg.indicators.forEach(function (k) {
              if (INDICATORS[k] && !p.indicators[k]) p.indicators[k] = indicatorDefaults(k);
            });
            p.recomputeIndicators();
            p.refreshIndicatorButtons();
          }
          // A restored non-default chart type (bars/line/area/renko) must
          // switch the active series NOW - applyChartType() is what toggles
          // series visibility, and without it the restored chart renders
          // blank (the correct series stays hidden). Safe with no candles;
          // the post-load setCandleData() re-renders the real data.
          if (cfg.chartType) p.applyChartType();
          if (cfg.compare) p.compareSymbol = cfg.compare; // applied after load
          if (cfg.showVolume != null && cfg.showVolume !== p.showVolume) p.toggleVolume();
          p.renderMarkers();
          if (p.volProfile) p.computeVolProfile();
          if (p.patternScan) p.refreshPatterns();
          if (p.autoSR) p.renderAutoSR();
          // Re-apply chart-level toggles that were configured at construction
          // with their defaults (only toggleGrid/toggleCrosshair/applyWatermark
          // actually touch the chart) - otherwise saved OFF states come back ON.
          try {
            p.chart.applyOptions({
              grid: { vertLines: { visible: p.gridOn }, horzLines: { visible: p.gridOn } },
            });
            p.chart.applyOptions({
              crosshair: {
                mode: p.crosshairOn ? 1 : 0,
                vertLine: { visible: p.crosshairOn, labelVisible: p.crosshairOn },
                horzLine: { visible: p.crosshairOn, labelVisible: p.crosshairOn },
              },
            });
          } catch (e) {}
          p.applyWatermark();
        });
      }
      // Sync toolbar highlights to the restored pane 0 (and its compare).
      var p0 = state.panes[0];
      if (p0) {
        syncToolbarFor(p0);
        if (p0.compareSymbol) p0.setCompare(p0.compareSymbol);
      }
      if (embed.symbol && state.panes.length) {
        p0 = state.panes[0];
        p0.setSymbol(embed.symbol);
        if (embed.interval) {
          p0.interval = embed.interval;
          p0.paneIntervalsEl.querySelectorAll('button').forEach(function (x) {
            x.classList.toggle('tv-btn-active', x.dataset.interval === embed.interval);
          });
        }
        syncToolbarFor(p0);
        // Fire the first Kronos forecast only AFTER the embedded chart's
        // history is on screen, so the overlay draws on top of real candles
        // and the model isn't run twice at boot (setAutoPredict's own first
        // run is skipped via skipFirstRun).
        if (embed.ai) {
          (embedPromise || Promise.resolve()).then(function () {
            if (!p0.destroyed) {
              p0.setAutoPredict(true, true);
              p0.autoPredictNow(true);
            }
          }).catch(function () {});
        }
      }
    }).catch(function () {
      // /api/symbols failed - still load every pane with its default symbol
      // (force, since the symbols list will never arrive to trigger the load).
      state.panes.forEach(function (p) { p.populateSymbols(true); });
    });

    fetch('/api/auth/status').then(function (r) { return r.json(); }).then(function (st) {
      $('market-badge').textContent = st.market_label || '—';
      $('market-badge').className = 'tv-badge' + (st.market_open ? ' tv-badge-live' : '');
      if (!st.logged_in) $('ws-badge').textContent = 'ws: no session';
    }).catch(function () {});

    setInterval(tickClock, 1000);
    tickClock();
  }

  /* Wait for the CDN chart library (loaded async in index.html). */
  var libWait = 0;
  (function boot() {
    if (window.LightweightCharts) { init(); return; }
    libWait += 50;
    if (libWait > 15000) {
      $('st-hint').textContent = 'lightweight-charts could not be loaded — check your internet connection and reload.';
      return;
    }
    setTimeout(boot, 50);
  })();
})();
