/* ============================================================
   SC TRADING · design v5 · shell.js
   Оболочка приложения: навбар + лента сигналов -> #shell,
   футер-sysbar -> конец <body>. Демо-переключатель тарифа.
   Требует SC_DATA и SC_APP. Глобальный объект window.SC_SHELL.
   Использование:  SC_SHELL.render("favorites");
   ============================================================ */
(function(){
"use strict";
var D = window.SC_DATA || {favorites:[]};
var A = window.SC_APP;

/* ---------- тарифы и гейтинг ---------- */
var TIER_KEY = "sc_demo_tier", RADAR_KEY = "sc_demo_radar";
var ORDER = ["base","advanced","advanced_plus","advanced_max"];
var TIER_NAME = {
  base:"БАЗОВАЯ",
  advanced:"ПРОДВИНУТАЯ",
  advanced_plus:"ПРОДВИНУТАЯ+",
  advanced_max:"ПРОДВИНУТАЯ МАКС"
};
/* окно графика -> минимальный тариф */
var WIN_NEED = {"24":"base", "48":"base", "7d":"advanced", "30d":"advanced_plus"};

function getTier(){
  var t = null;
  try{ t = localStorage.getItem(TIER_KEY); }catch(e){}
  return ORDER.indexOf(t) >= 0 ? t : "advanced_plus";
}
function hasRadar(){
  try{ return localStorage.getItem(RADAR_KEY) === "1"; }catch(e){ return false; }
}
function tierAllows(win){
  var need = WIN_NEED[win] || "base";
  return ORDER.indexOf(getTier()) >= ORDER.indexOf(need);
}
function tierName(t){ return TIER_NAME[t || getTier()]; }
function requiredTier(win){ return TIER_NAME[WIN_NEED[win] || "base"]; }
function lotsOpen(){ return ORDER.indexOf(getTier()) >= ORDER.indexOf("advanced_plus"); }

/* ---------- иконки ---------- */
function lockSvg(w, h, sw){
  return '<svg width="' + (w||11) + '" height="' + (h||12) + '" viewBox="0 0 11 12" fill="none" aria-hidden="true">' +
    '<rect x="1" y="5" width="9" height="6" stroke="currentColor" stroke-width="' + (sw||1.4) + '"/>' +
    '<path d="M3 5V3.5a2.5 2.5 0 0 1 5 0V5" stroke="currentColor" stroke-width="' + (sw||1.4) + '"/></svg>';
}

/* ---------- состояние оболочки ---------- */
var state = {active:null, onSignal:null, selected:null};

/* ---------- навбар ---------- */
function navItems(){
  return [
    {id:"favorites", label:"Избранное", href:"favorites.html"},
    {id:"catalog",   label:"Каталог",   href:"catalog.html"},
    {id:"lots",      label:"Лоты",      href:"lots.html",
      locked:!lotsOpen(), tip:"Доступно на тарифе ПРОДВИНУТАЯ+"},
    {id:"feed",      label:"Лента",     href:"feed.html"},
    {id:"inventory", label:"Склад",     href:"inventory.html"},
    {id:"news",      label:"Новости",   href:"#", dead:true, title:"Вне охвата прототипа"},
    {id:"radar",     label:"Радар рынка", href:"radar.html",
      locked:!hasRadar(), tip:"Доступно как аддон «Радар рынка»"}
  ];
}
function topbarHtml(active){
  var links = navItems().map(function(p){
    var attrs = "";
    if (p.id === active) attrs += ' aria-current="page"';
    if (p.locked) attrs += ' class="locked" data-tip="' + A.esc(p.tip) + '"';
    if (p.title) attrs += ' title="' + A.esc(p.title) + '"';
    var href = p.locked ? "#" : p.href;
    return '<a href="' + href + '" data-nav="' + p.id + '"' + attrs + '>' +
      A.esc(p.label) + (p.locked ? lockSvg(11, 12, 1.4) : "") + '</a>';
  }).join("");

  var tierOpts = ORDER.map(function(t){
    return '<option value="' + t + '"' + (t === getTier() ? " selected" : "") + '>' + TIER_NAME[t] + '</option>';
  }).join("");

  return '<div class="topbar">' +
    '<a class="brand" href="favorites.html" aria-label="SC Trading — на главную">' +
      '<svg width="26" height="26" viewBox="0 0 26 26" fill="none" aria-hidden="true">' +
        '<path class="lg-o" d="M13 1.5 L24.5 13 L13 24.5 L1.5 13 Z" stroke-width="1.6"/>' +
        '<path class="lg-i" d="M13 6.5 L19.5 13 L13 19.5 L6.5 13 Z" stroke-width="1"/>' +
      '</svg>' +
      '<span class="bt"><b>SC TRADING</b><i>Zone Terminal</i></span>' +
    '</a>' +
    '<nav class="nav" aria-label="Основная навигация">' + links + '</nav>' +
    '<div class="tb-r">' +
      '<div class="emis" title="Виджет выброса"><span class="dot" aria-hidden="true"></span>' +
        '<span class="k">Выброс</span><span class="v">последний: 2 ч назад</span></div>' +
      '<div class="demo" title="Демо-режим прототипа: переключение тарифа">' +
        '<span class="demo-k">демо</span>' +
        '<select id="demo-tier" aria-label="Тариф (демо)">' + tierOpts + '</select>' +
        '<label><input type="checkbox" id="demo-radar"' + (hasRadar() ? " checked" : "") + '> радар</label>' +
      '</div>' +
      '<span class="tb-user">trader_01</span>' +
      '<span class="tb-plan">' + tierName() + '</span>' +
      '<div class="tb-icons">' +
        '<a class="ibtn" href="#" aria-label="Помощь" data-tip="Помощь">' +
          '<svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true"><circle cx="7.5" cy="7.5" r="6.4" stroke="currentColor" stroke-width="1.4"/><path d="M5.7 5.8a1.8 1.8 0 1 1 2.6 1.7c-.5.3-.8.6-.8 1.2v.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="7.5" cy="11" r=".9" fill="currentColor"/></svg></a>' +
        '<a class="ibtn" href="settings.html" aria-label="Настройки" data-tip="Настройки"' +
          (active === "settings" ? ' aria-current="page"' : '') + '>' +
          '<svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true"><circle cx="7.5" cy="7.5" r="2.2" stroke="currentColor" stroke-width="1.4"/><path d="M7.5 1v2M7.5 12v2M1 7.5h2M12 7.5h2M2.9 2.9l1.4 1.4M10.7 10.7l1.4 1.4M12.1 2.9l-1.4 1.4M4.3 10.7l-1.4 1.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg></a>' +
        '<a class="ibtn" href="login.html" aria-label="Выход" data-tip="Выход">' +
          '<svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden="true"><path d="M9.5 1.5H13a.5.5 0 0 1 .5.5v11a.5.5 0 0 1-.5.5H9.5" stroke="currentColor" stroke-width="1.4"/><path d="M6.5 4.5 3.5 7.5l3 3M3.5 7.5H10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg></a>' +
      '</div>' +
    '</div>' +
  '</div>';
}

/* ---------- лента сигналов ---------- */
function signalsHtml(){
  return '<div class="signals" aria-label="Сигналы — предметы с выгодными лотами">' +
    '<div class="sig-label"><span class="t">Сигналы</span>' +
    '<span class="live" id="siglive">срез —</span></div>' +
    '<div class="sig-track" id="sigtrack"></div></div>';
}
function fillSignals(){
  var track = document.getElementById("sigtrack");
  if (!track) return;
  var items = (D.favorites || []).filter(function(f){
    return f.market && f.market.lots && f.market.lots.length;
  });
  if (!items.length){
    track.innerHTML = '<div class="sig-empty">Сигналов нет — добавь предметы в избранное.</div>';
    document.getElementById("siglive").textContent = "срез " + A.fmtHM(A.NOW);
    return;
  }
  var latest = 0;
  track.innerHTML = items.map(function(f){
    var n = A.goodCount(f);
    var t = Date.parse(f.market.collectTime);
    if (t > latest) latest = t;
    return '<a class="sig' + (f.itemId === state.selected ? " on" : "") + '" ' +
      'href="favorites.html?item=' + encodeURIComponent(f.itemId) + '" data-id="' + A.esc(f.itemId) + '">' +
      A.iconHtml(f, "sig-ico") +
      '<span class="sig-main"><span class="sig-name">' + A.esc(f.nameRu) + '</span>' +
      '<span class="sig-sub">обн. ' + A.fmtHM(t) + '</span></span>' +
      (n > 0 ? '<span class="sig-badge" title="Выгодных лотов">+' + n + '</span>' : '') +
      '</a>';
  }).join("");
  document.getElementById("siglive").textContent = "срез " + A.fmtHM(latest || A.NOW);
  Array.prototype.forEach.call(track.querySelectorAll(".sig"), function(el){
    el.addEventListener("click", function(e){
      if (state.onSignal){
        e.preventDefault();
        var id = el.getAttribute("data-id");
        setSignal(id);
        state.onSignal(id);
      }
    });
  });
}
function setSignal(id){
  state.selected = id;
  var track = document.getElementById("sigtrack");
  if (!track) return;
  Array.prototype.forEach.call(track.querySelectorAll(".sig"), function(el){
    el.classList.toggle("on", el.getAttribute("data-id") === id);
  });
}
function refreshSignals(selectedId){
  if (selectedId !== undefined) state.selected = selectedId;
  fillSignals();
}

/* ---------- футер ---------- */
function sysbarHtml(){
  var cut = A.fmtDM(A.NOW) + "." + new Date(A.NOW).getFullYear() + " " + A.fmtHM(A.NOW - 29*60000);
  return '<footer class="sysbar" id="sysbar">' +
    '<span><b>SC TRADING TERMINAL</b> · v5 / направление A</span>' +
    '<span>срез данных: <b>' + cut + '</b></span>' +
    '<span>регион: <b>RU</b></span>' +
    '<span>тариф: <b>' + tierName() + '</b>' + (hasRadar() ? ' <b>+ радар</b>' : '') + '</span>' +
    '<span>режим: <b>прототип · file://</b></span>' +
  '</footer>';
}

/* ---------- события оболочки ---------- */
function bind(shell){
  /* демо-переключатель тарифа */
  shell.querySelector("#demo-tier").addEventListener("change", function(e){
    try{ localStorage.setItem(TIER_KEY, e.target.value); }catch(err){}
    rerender();
  });
  shell.querySelector("#demo-radar").addEventListener("change", function(e){
    try{ localStorage.setItem(RADAR_KEY, e.target.checked ? "1" : "0"); }catch(err){}
    rerender();
  });
  /* замки и мёртвые пункты */
  Array.prototype.forEach.call(shell.querySelectorAll(".nav a"), function(a){
    a.addEventListener("click", function(e){
      if (a.classList.contains("locked")){
        e.preventDefault();
        A.toast(a.getAttribute("data-tip") || "Недоступно на текущем тарифе");
      } else if (a.getAttribute("href") === "#"){
        e.preventDefault();
      }
    });
  });
  var help = shell.querySelector('.ibtn[aria-label="Помощь"]');
  if (help) help.addEventListener("click", function(e){ e.preventDefault(); });
}
function rerender(){
  render(state.active);
  try{
    window.dispatchEvent(new CustomEvent("sc:tier", {detail:{tier:getTier(), radar:hasRadar()}}));
  }catch(e){}
}

/* ---------- публичный рендер ---------- */
function render(activePage){
  state.active = activePage;
  var shell = document.getElementById("shell");
  if (!shell){
    if (window.console) console.warn("SC_SHELL: контейнер #shell не найден");
    return;
  }
  shell.innerHTML = topbarHtml(activePage) + signalsHtml();
  fillSignals();
  var old = document.getElementById("sysbar");
  if (old) old.remove();
  document.body.insertAdjacentHTML("beforeend", sysbarHtml());
  bind(shell);
}

window.SC_SHELL = {
  render: render,
  getTier: getTier,
  hasRadar: hasRadar,
  tierAllows: tierAllows,
  tierName: tierName,
  requiredTier: requiredTier,
  lockSvg: lockSvg,
  onSignal: function(fn){ state.onSignal = fn; },
  setSignal: setSignal,
  refreshSignals: refreshSignals
};
})();
