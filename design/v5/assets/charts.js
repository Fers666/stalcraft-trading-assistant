/* ============================================================
   SC TRADING · design v5 · charts.js
   SVG-графики терминала: лог-шкала, тики 1-2-5, медиана-пунктир.
   Цвета — из CSS-токенов (:root), хексы здесь только как фолбэк.
   Требует SC_APP (форматтеры). Глобальный объект window.SC_CHARTS.
   ============================================================ */
(function(){
"use strict";
var A = window.SC_APP;

/* цвета из tokens.css (фолбэки = те же значения) */
function cvar(name, fb){
  var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fb;
}
function pal(){
  return {
    grid:      cvar("--grid", "rgba(255,255,255,.06)"),
    axis:      cvar("--line-hi", "rgba(255,255,255,.15)"),
    tick:      cvar("--tick", "rgba(255,255,255,.2)"),
    faint:     cvar("--faint", "#8A939C"),
    gold:      cvar("--gold", "#D9AF37"),
    gold2:     cvar("--gold-2", "#F2C94C"),
    green:     cvar("--green", "#3ED598"),
    bandFill:  cvar("--gold-dim", "rgba(217,175,55,.12)"),
    bandLine:  cvar("--gold-line-soft", "rgba(217,175,55,.3)")
  };
}

/* тики лог-шкалы: мантиссы 1-2-5, прореживание до <=6 */
function logTicks(lo, hi){
  var t = [];
  var d0 = Math.floor(Math.log10(lo)), d1 = Math.ceil(Math.log10(hi));
  var mults = (d1 - d0 >= 3) ? [1] : [1, 2, 5];
  for (var d = d0; d <= d1; d++){
    mults.forEach(function(m){
      var v = m * Math.pow(10, d);
      if (v >= lo * 0.999 && v <= hi * 1.001) t.push(v);
    });
  }
  while (t.length > 6){
    t = t.filter(function(_, i){ return i % 2 === 0 || i === t.length - 1; });
  }
  return t;
}
function svgOpen(w, h){
  return '<svg width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '" ' +
    'font-family="JetBrains Mono, monospace" font-size="11" aria-hidden="true">';
}
function dims(el){
  var W = Math.max(360, el.clientWidth || 480);
  var H = 234;
  return {W:W, H:H, padL:62, padR:14, padT:12, padB:26,
          iw:W - 62 - 14, ih:H - 12 - 26};
}
function empty(el, W, H, text){
  el.innerHTML = svgOpen(W, H) + '</svg><div class="chart-empty">' + A.esc(text || "Нет данных.") + '</div>';
}

/* ------------------------------------------------------------
   scatter(el, pts, opts) — точки сделок в часовом окне.
   pts: [{t:ms, p:цена}] (уже отфильтрованы в окно [from..to]);
   opts: {from, to, median, stepH (шаг часовых тиков, по умолч. 4), emptyText}.
   Точки ниже медианы — зелёные (аномалия -> профит), выше — золотые.
   Возвращает {count,min,max,avg} или null (нет данных).
   ------------------------------------------------------------ */
function scatter(el, pts, opts){
  var g = dims(el), P = pal();
  var W = g.W, H = g.H, padL = g.padL, padR = g.padR, padT = g.padT, iw = g.iw, ih = g.ih;
  var from = opts.from, to = opts.to;
  var med = opts.median || 0;
  var stepH = opts.stepH || 4;

  if (!pts.length){ empty(el, W, H, opts.emptyText); return null; }

  var lo = pts[0].p, hi = pts[0].p, sum = 0;
  pts.forEach(function(p){ lo = Math.min(lo, p.p); hi = Math.max(hi, p.p); sum += p.p; });
  if (med > 0){ lo = Math.min(lo, med); hi = Math.max(hi, med); }
  lo = lo * 0.85; hi = hi * 1.15;
  var lgLo = Math.log10(lo), lgHi = Math.log10(hi);
  function y(v){ return padT + ih - (Math.log10(v) - lgLo) / (lgHi - lgLo) * ih; }
  function x(t){ return padL + (t - from) / (to - from) * iw; }

  var out = svgOpen(W, H);
  /* горизонтальная сетка + тики Y */
  logTicks(lo, hi).forEach(function(v){
    var yy = y(v);
    out += '<line x1="' + padL + '" y1="' + yy + '" x2="' + (W - padR) + '" y2="' + yy + '" stroke="' + P.grid + '"/>';
    out += '<text x="' + (padL - 8) + '" y="' + (yy + 3.5) + '" text-anchor="end" fill="' + P.faint + '">' + A.fmtTick(v) + '</text>';
  });
  /* тики X — часы */
  for (var t0 = Math.ceil(from / 3600000) * 3600000; t0 <= to; t0 += 3600000){
    var dd = new Date(t0);
    if (dd.getHours() % stepH !== 0) continue;
    var xx = x(t0);
    out += '<line x1="' + xx + '" y1="' + (padT + ih) + '" x2="' + xx + '" y2="' + (padT + ih + 4) + '" stroke="' + P.tick + '"/>';
    out += '<text x="' + xx + '" y="' + (H - 8) + '" text-anchor="middle" fill="' + P.faint + '">' + A.fmtHM(t0) + '</text>';
  }
  /* линия медианы */
  if (med > 0){
    var ym = y(med);
    out += '<line x1="' + padL + '" y1="' + ym + '" x2="' + (W - padR) + '" y2="' + ym + '" stroke="' + P.gold + '" stroke-width="1" stroke-dasharray="5 4" opacity=".8"/>';
    out += '<text x="' + (W - padR - 4) + '" y="' + (ym - 5) + '" text-anchor="end" fill="' + P.gold + '">медиана ' + A.fmtTick(med) + '</text>';
  }
  /* точки */
  pts.forEach(function(p){
    var below = med > 0 && p.p < med;
    out += '<circle cx="' + x(p.t).toFixed(1) + '" cy="' + y(p.p).toFixed(1) + '" r="3" fill="' +
      (below ? P.green : P.gold) + '" fill-opacity=".85"><title>' + A.fmtP(p.p) + " · " + A.fmtHM(p.t) + '</title></circle>';
  });
  /* ось X */
  out += '<line x1="' + padL + '" y1="' + (padT + ih) + '" x2="' + (W - padR) + '" y2="' + (padT + ih) + '" stroke="' + P.axis + '"/>';
  out += '</svg>';
  el.innerHTML = out;

  return {
    count: pts.length,
    min: Math.min.apply(null, pts.map(function(p){ return p.p; })),
    max: Math.max.apply(null, pts.map(function(p){ return p.p; })),
    avg: sum / pts.length
  };
}

/* ------------------------------------------------------------
   band(el, rows, opts) — дневной коридор мин–макс + средняя линия.
   rows: [{t:ms, min, max, avg, sales}] по возрастанию t;
   opts: {median, emptyText}.
   Возвращает {days, sales} или null (нет данных).
   ------------------------------------------------------------ */
function band(el, rows, opts){
  var g = dims(el), P = pal();
  var W = g.W, H = g.H, padL = g.padL, padR = g.padR, padT = g.padT, iw = g.iw, ih = g.ih;
  var med = opts.median || 0;

  if (!rows.length){ empty(el, W, H, opts.emptyText); return null; }

  var lo = rows[0].min, hi = rows[0].max, sSum = 0;
  rows.forEach(function(r){ lo = Math.min(lo, r.min); hi = Math.max(hi, r.max); sSum += r.sales; });
  if (med > 0){ lo = Math.min(lo, med); hi = Math.max(hi, med); }
  lo = Math.max(1, lo * 0.85); hi = hi * 1.15;
  var lg0 = Math.log10(lo), lg1 = Math.log10(hi);
  function y(v){ return padT + ih - (Math.log10(Math.max(1, v)) - lg0) / (lg1 - lg0) * ih; }
  var tMin = rows[0].t, tMax = rows[rows.length - 1].t;
  if (tMax === tMin){ tMin -= 43200000; tMax += 43200000; }
  function x(t){ return padL + (t - tMin) / (tMax - tMin) * iw; }

  var out = svgOpen(W, H);
  logTicks(lo, hi).forEach(function(v){
    var yy = y(v);
    out += '<line x1="' + padL + '" y1="' + yy + '" x2="' + (W - padR) + '" y2="' + yy + '" stroke="' + P.grid + '"/>';
    out += '<text x="' + (padL - 8) + '" y="' + (yy + 3.5) + '" text-anchor="end" fill="' + P.faint + '">' + A.fmtTick(v) + '</text>';
  });
  /* коридор мин–макс */
  var bandPath = "M";
  rows.forEach(function(r, i){ bandPath += (i ? "L" : "") + x(r.t).toFixed(1) + " " + y(r.max).toFixed(1) + " "; });
  for (var j = rows.length - 1; j >= 0; j--){ bandPath += "L" + x(rows[j].t).toFixed(1) + " " + y(rows[j].min).toFixed(1) + " "; }
  bandPath += "Z";
  out += '<path d="' + bandPath + '" fill="' + P.bandFill + '" stroke="' + P.bandLine + '" stroke-width="1"/>';
  /* средняя */
  var line = "";
  rows.forEach(function(r, i){ line += (i ? "L" : "M") + x(r.t).toFixed(1) + " " + y(r.avg).toFixed(1) + " "; });
  out += '<path d="' + line + '" fill="none" stroke="' + P.gold2 + '" stroke-width="2" stroke-linejoin="round"/>';
  rows.forEach(function(r){
    out += '<circle cx="' + x(r.t).toFixed(1) + '" cy="' + y(r.avg).toFixed(1) + '" r="3" fill="' + P.gold2 + '"><title>' +
      A.fmtDM(r.t) + " · сред " + A.fmtP(r.avg) + " · " + A.fmtN(r.sales) + " продаж</title></circle>";
  });
  /* медиана 7д */
  if (med > 0){
    var ym = y(med);
    out += '<line x1="' + padL + '" y1="' + ym + '" x2="' + (W - padR) + '" y2="' + ym + '" stroke="' + P.gold + '" stroke-width="1" stroke-dasharray="5 4" opacity=".8"/>';
    out += '<text x="' + (W - padR - 4) + '" y="' + (ym - 5) + '" text-anchor="end" fill="' + P.gold + '">медиана ' + A.fmtTick(med) + '</text>';
  }
  /* тики X — даты */
  var every = Math.max(1, Math.ceil(rows.length / 7));
  rows.forEach(function(r, i){
    if (i % every !== 0 && i !== rows.length - 1) return;
    var xx = x(r.t);
    out += '<line x1="' + xx + '" y1="' + (padT + ih) + '" x2="' + xx + '" y2="' + (padT + ih + 4) + '" stroke="' + P.tick + '"/>';
    out += '<text x="' + xx + '" y="' + (H - 8) + '" text-anchor="middle" fill="' + P.faint + '">' + A.fmtDM(r.t) + '</text>';
  });
  out += '<line x1="' + padL + '" y1="' + (padT + ih) + '" x2="' + (W - padR) + '" y2="' + (padT + ih) + '" stroke="' + P.axis + '"/>';
  out += '</svg>';
  el.innerHTML = out;

  return {days: rows.length, sales: sSum};
}

window.SC_CHARTS = {scatter: scatter, band: band};
})();
