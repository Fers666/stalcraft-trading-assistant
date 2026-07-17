/* ============================================================
   SC TRADING · design v5 · app.js
   Общий интерактив без страничной специфики.
   Работает по file:// — только глобальный объект window.SC_APP.
   Порядок подключения: data.js -> app.js -> charts.js -> shell.js -> страница.
   ============================================================ */
(function(){
"use strict";
var D = window.SC_DATA || {favorites:[]};

/* --- виртуальные часы: NOW = самый свежий срез данных + 29 минут --- */
var NOW = (function(){
  var m = 0;
  (D.favorites || []).forEach(function(f){
    if (f.market && f.market.collectTime){
      var t = Date.parse(f.market.collectTime);
      if (t > m) m = t;
    }
  });
  return m + 29*60000;
})();

/* --- словари --- */
var RANK = {
  "default":     {name:"Обычный",  v:"--q-default"},
  "rank_newbie": {name:"Новичок",  v:"--q-newbie"},
  "rank_stalker":{name:"Сталкер",  v:"--q-stalker"},
  "rank_veteran":{name:"Ветеран",  v:"--q-veteran"},
  "rank_master": {name:"Мастер",   v:"--q-master"},
  "rank_legend": {name:"Легенда",  v:"--q-legend"}
};
var QNAME = ["Обычный","Необычный","Особый","Ветеран","Мастер","Легендарный"];
var DAY = {Monday:"пн",Tuesday:"вт",Wednesday:"ср",Thursday:"чт",Friday:"пт",Saturday:"сб",Sunday:"вс"};
var CONF = {high:"высокая",medium:"средняя",low:"низкая"};

/* --- форматтеры (все цифры — mono + tabular-nums, «1 234 567 ₽») --- */
function fmtN(n){ return Math.round(n).toLocaleString("ru-RU"); }
function fmtP(n){ return fmtN(n) + " ₽"; }
function fmtCompact(n){
  if (n >= 1e6){ var m = n/1e6; return (m>=10 ? Math.round(m) : Math.round(m*10)/10).toLocaleString("ru-RU") + " млн ₽"; }
  if (n >= 1e4){ return Math.round(n/1e3).toLocaleString("ru-RU") + " тыс ₽"; }
  return fmtP(n);
}
function fmtTick(v){
  if (v >= 1e6){ var m = v/1e6; return (m === Math.round(m) ? m : Math.round(m*10)/10) + " млн"; }
  if (v >= 1e3){ var k = v/1e3; return (k === Math.round(k) ? k : Math.round(k*10)/10) + " тыс"; }
  return String(Math.round(v));
}
function fmtHM(ts){
  var d = new Date(ts);
  return String(d.getHours()).padStart(2,"0") + ":" + String(d.getMinutes()).padStart(2,"0");
}
function fmtDM(ts){
  var d = new Date(ts);
  return String(d.getDate()).padStart(2,"0") + "." + String(d.getMonth()+1).padStart(2,"0");
}
function fmtLeft(ms){
  if (ms <= 0) return "истёк";
  var h = Math.floor(ms/3600000), m = Math.floor(ms%3600000/60000);
  return h > 0 ? (h + " ч " + m + " м") : (m + " м");
}
function agoMin(iso){ return Math.max(0, Math.round((NOW - Date.parse(iso))/60000)); }
function esc(s){ return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

/* --- доменные хелперы --- */
function rankOf(f){ return RANK[f.color || "default"] || RANK["default"]; }
function favById(id, list){
  var arr = list || D.favorites || [];
  for (var i=0;i<arr.length;i++) if (arr[i].itemId === id) return arr[i];
  return null;
}
function lotsOf(f){
  if (!f.market || !f.market.lots) return [];
  var med = f.stats.medianPrice7d || 0;
  return f.market.lots
    .filter(function(l){ return l.buyoutPrice > 0; })
    .map(function(l, i){
      var per = Math.round(l.buyoutPrice / l.amount);
      return {
        idx:i, buyout:l.buyoutPrice, amount:l.amount, per:per,
        ptn:(l.ptn == null ? 0 : l.ptn), qlt:l.qlt,
        left: Date.parse(l.endTime) - NOW,
        profit: Math.round(med - per)
      };
    });
}
function goodCount(f){
  return lotsOf(f).filter(function(l){ return l.profit > 0 && l.left > 0; }).length;
}
function riskOf(v){
  if (v == null) return {cls:"md", label:"н/д"};
  if (v < 50)   return {cls:"lo", label:"низкий"};
  if (v < 150)  return {cls:"md", label:"средний"};
  return {cls:"hi", label:"высокий"};
}
/* иконка предмета с фолбэком-буквой на цвете качества (.fb из base.css) */
function iconHtml(f, cls){
  var r = rankOf(f);
  var letter = (f.nameRu || "?").replace(/[«»"]/g,"").charAt(0).toUpperCase();
  return '<span class="' + cls + '" style="--qc:var(' + r.v + ')">' +
    '<img src="' + esc(f.icon) + '" alt="" loading="lazy" ' +
    'onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'grid\'">' +
    '<span class="fb" aria-hidden="true">' + esc(letter) + '</span></span>';
}

/* --- сортировка таблицы ---
   headEl: <tr> с th[data-k]>.thb; sort: {key,dir} (мутируется);
   defaults: {колонка: стартовое направление, по умолчанию 1}; onChange() — перерисовка. */
function sortTable(headEl, sort, defaults, onChange){
  Array.prototype.forEach.call(headEl.querySelectorAll("th[data-k]"), function(th){
    var btn = th.querySelector(".thb") || th;
    btn.addEventListener("click", function(){
      var k = th.getAttribute("data-k");
      if (sort.key === k) sort.dir = -sort.dir;
      else { sort.key = k; sort.dir = (defaults && defaults[k]) || 1; }
      onChange();
    });
  });
}
/* aria-sort + глиф ▲/▼ на активной колонке (вызывать при каждой перерисовке) */
function markSort(headEl, sort){
  Array.prototype.forEach.call(headEl.querySelectorAll("th[data-k]"), function(th){
    var k = th.getAttribute("data-k");
    var si = th.querySelector(".si");
    if (k === sort.key){
      th.setAttribute("aria-sort", sort.dir > 0 ? "ascending" : "descending");
      if (si) si.textContent = sort.dir > 0 ? "▲" : "▼";
    } else {
      th.removeAttribute("aria-sort");
      if (si) si.textContent = "";
    }
  });
}

/* --- табы: container содержит [role="tab"][data-t]; cb(value, btn) --- */
function tabs(container, cb){
  var btns = container.querySelectorAll('[role="tab"]');
  Array.prototype.forEach.call(btns, function(b){
    b.addEventListener("click", function(){
      Array.prototype.forEach.call(btns, function(x){
        x.setAttribute("aria-selected", String(x === b));
      });
      cb(b.getAttribute("data-t"), b);
    });
  });
}

/* --- двухшаговое подтверждение: клик -> «Точно?» (3 с) -> клик -> cb() ---
   Единственный паттерн удаления строк; confirm() запрещён. */
function armConfirm(btn, cb, label){
  var orig = btn.innerHTML, t = null;
  btn.addEventListener("click", function(){
    if (btn.classList.contains("armed")){
      clearTimeout(t);
      btn.classList.remove("armed");
      btn.innerHTML = orig;
      cb();
      return;
    }
    btn.classList.add("armed");
    btn.innerHTML = label || "Точно?";
    t = setTimeout(function(){
      btn.classList.remove("armed");
      btn.innerHTML = orig;
    }, 3000);
  });
}

/* --- модалка: openModal({title, body, actions:[{label, primary, danger, onClick}]}) --- */
var _modal = null;
function closeModal(){
  if (_modal){ _modal.remove(); _modal = null; document.removeEventListener("keydown", _modalEsc); }
}
function _modalEsc(e){ if (e.key === "Escape") closeModal(); }
function openModal(opts){
  closeModal();
  var ov = document.createElement("div");
  ov.className = "modal-ov";
  var acts = (opts.actions || []).map(function(a, i){
    var cls = a.primary ? "gbtn" : (a.danger ? "dbtn" : "qbtn");
    return '<button type="button" class="' + cls + '" data-act="' + i + '">' + esc(a.label) + '</button>';
  }).join("");
  ov.innerHTML =
    '<div class="modal" role="dialog" aria-modal="true" aria-label="' + esc(opts.title || "") + '">' +
      '<div class="modal-h"><h3>' + esc(opts.title || "") + '</h3>' +
        '<button type="button" class="ibtn" data-close aria-label="Закрыть">' +
        '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M1.5 1.5l9 9M10.5 1.5l-9 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>' +
        '</button></div>' +
      '<div class="modal-b">' + (opts.body || "") + '</div>' +
      (acts ? '<div class="modal-f">' + acts + '</div>' : '') +
    '</div>';
  ov.addEventListener("click", function(e){ if (e.target === ov) closeModal(); });
  ov.querySelector("[data-close]").addEventListener("click", closeModal);
  Array.prototype.forEach.call(ov.querySelectorAll("[data-act]"), function(b){
    b.addEventListener("click", function(){
      var a = opts.actions[Number(b.getAttribute("data-act"))];
      closeModal();
      if (a.onClick) a.onClick();
    });
  });
  document.body.appendChild(ov);
  document.addEventListener("keydown", _modalEsc);
  var first = ov.querySelector(".modal-f button, [data-close]");
  if (first) first.focus();
  _modal = ov;
  return ov;
}

/* --- тост: короткое подтверждение действия (3.2 с) --- */
function toast(msg){
  var stack = document.querySelector(".toast-stack");
  if (!stack){
    stack = document.createElement("div");
    stack.className = "toast-stack";
    document.body.appendChild(stack);
  }
  var el = document.createElement("div");
  el.className = "toast";
  el.setAttribute("role", "status");
  el.textContent = msg;
  stack.appendChild(el);
  setTimeout(function(){ el.remove(); }, 3200);
}

window.SC_APP = {
  NOW: NOW,
  RANK: RANK, QNAME: QNAME, DAY: DAY, CONF: CONF,
  fmtN: fmtN, fmtP: fmtP, fmtCompact: fmtCompact, fmtTick: fmtTick,
  fmtHM: fmtHM, fmtDM: fmtDM, fmtLeft: fmtLeft, agoMin: agoMin, esc: esc,
  rankOf: rankOf, favById: favById, lotsOf: lotsOf, goodCount: goodCount,
  riskOf: riskOf, iconHtml: iconHtml,
  sortTable: sortTable, markSort: markSort, tabs: tabs, armConfirm: armConfirm,
  openModal: openModal, closeModal: closeModal, toast: toast
};
})();
