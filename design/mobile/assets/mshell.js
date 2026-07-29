/* ============================================================
   SC TRADING · МОБИЛЬНЫЙ прототип · mshell.js
   Оболочка: верхний минибар + лента сигналов + нижний таб-бар +
   шит «Ещё» (навигация + демо-переключатель тарифа) + sysbar.
   Требует SC_DATA и SC_APP (порядок: data.js → app.js → mshell.js).
   Тарифная логика зеркалит v5/assets/shell.js. Глобал: SC_MSHELL.
   Использование:  SC_MSHELL.render("favorites");
   ============================================================ */
(function(){
"use strict";
var D = window.SC_DATA || {favorites:[]};
var A = window.SC_APP;

/* ---------- тарифы и гейтинг (зеркало shell.js) ---------- */
var TIER_KEY = "sc_demo_tier", RADAR_KEY = "sc_demo_radar";
var ORDER = ["base","advanced","advanced_plus","advanced_max"];
var TIER_NAME = {base:"БАЗОВАЯ", advanced:"ПРОДВИНУТАЯ", advanced_plus:"ПРОДВИНУТАЯ+", advanced_max:"ПРОДВИНУТАЯ МАКС"};
var WIN_NEED = {"24":"base","48":"base","7d":"advanced","30d":"advanced_plus"};
function getTier(){ var t=null; try{ t=localStorage.getItem(TIER_KEY); }catch(e){} return ORDER.indexOf(t)>=0?t:"advanced_plus"; }
function hasRadar(){ try{ return localStorage.getItem(RADAR_KEY)==="1"; }catch(e){ return false; } }
function tierAllows(win){ var need=WIN_NEED[win]||"base"; return ORDER.indexOf(getTier())>=ORDER.indexOf(need); }
function tierName(t){ return TIER_NAME[t||getTier()]; }
function requiredTier(win){ return TIER_NAME[WIN_NEED[win]||"base"]; }
function lotsOpen(){ return ORDER.indexOf(getTier())>=ORDER.indexOf("advanced_plus"); }  /* Лоты и Закупки */
var IS_ADMIN = true;  /* демо: показывать раздел «Админ» в шите «Ещё» */

function lockSvg(w,h,sw){
  return '<svg width="'+(w||12)+'" height="'+(h||13)+'" viewBox="0 0 11 12" fill="none" aria-hidden="true">'+
    '<rect x="1" y="5" width="9" height="6" stroke="currentColor" stroke-width="'+(sw||1.4)+'"/>'+
    '<path d="M3 5V3.5a2.5 2.5 0 0 1 5 0V5" stroke="currentColor" stroke-width="'+(sw||1.4)+'"/></svg>';
}

/* ---------- иконки (stroke=currentColor) ---------- */
var I = {
  fav:'<svg viewBox="0 0 24 24" fill="none"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
  catalog:'<svg viewBox="0 0 24 24" fill="none"><rect x="3.5" y="3.5" width="7" height="7" stroke="currentColor" stroke-width="1.6"/><rect x="13.5" y="3.5" width="7" height="7" stroke="currentColor" stroke-width="1.6"/><rect x="3.5" y="13.5" width="7" height="7" stroke="currentColor" stroke-width="1.6"/><rect x="13.5" y="13.5" width="7" height="7" stroke="currentColor" stroke-width="1.6"/></svg>',
  lots:'<svg viewBox="0 0 24 24" fill="none"><circle cx="10.5" cy="10.5" r="6.5" stroke="currentColor" stroke-width="1.7"/><path d="M15.5 15.5L21 21" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  buy:'<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="12" r="3.4" stroke="currentColor" stroke-width="1.6"/><path d="M12 1.5v4M12 18.5v4M1.5 12h4M18.5 12h4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  more:'<svg viewBox="0 0 24 24" fill="none"><circle cx="5" cy="12" r="1.7" fill="currentColor"/><circle cx="12" cy="12" r="1.7" fill="currentColor"/><circle cx="19" cy="12" r="1.7" fill="currentColor"/></svg>',
  feed:'<svg viewBox="0 0 24 24" fill="none"><path d="M4 6.5h16M4 12h16M4 17.5h10" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>',
  news:'<svg viewBox="0 0 24 24" fill="none"><rect x="3.5" y="4.5" width="17" height="15" rx="1" stroke="currentColor" stroke-width="1.6"/><path d="M7 8.5h6M7 12h10M7 15.5h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
  radar:'<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="12" r="4.5" stroke="currentColor" stroke-width="1.4"/><path d="M12 12l6-3.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/></svg>',
  settings:'<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="3.2" stroke="currentColor" stroke-width="1.6"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  help:'<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.6"/><path d="M9.2 9.3a2.8 2.8 0 1 1 4 2.6c-.8.5-1.3 1-1.3 1.9v.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="12" cy="17.4" r="1.1" fill="currentColor"/></svg>',
  logout:'<svg viewBox="0 0 24 24" fill="none"><path d="M15 3.5h4a.5.5 0 0 1 .5.5v16a.5.5 0 0 1-.5.5h-4" stroke="currentColor" stroke-width="1.6"/><path d="M10 7l-5 5 5 5M5 12h11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  admin:'<svg viewBox="0 0 24 24" fill="none"><path d="M12 2.5l7.5 2.7v5.5c0 4.8-3.2 8.4-7.5 10.3-4.3-1.9-7.5-5.5-7.5-10.3V5.2z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M9 12l2 2 4-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  gear:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="3.2" stroke="currentColor" stroke-width="1.6"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  exit:'<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M15 3.5h4a.5.5 0 0 1 .5.5v16a.5.5 0 0 1-.5.5h-4" stroke="currentColor" stroke-width="1.6"/><path d="M10 7l-5 5 5 5M5 12h11" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'
};

/* ---------- состояние ---------- */
var state = {active:null, onSignal:null, selected:null};
var SHEET_PAGES = ["feed","news","radar","settings","faq","admin"];

/* ---------- верхний минибар ---------- */
function topbarHtml(){
  return '<div class="mtop">'+
    '<a class="mbrand" href="favorites.html" aria-label="SC Trading — на главную">'+
      '<svg width="24" height="24" viewBox="0 0 26 26" fill="none" aria-hidden="true">'+
        '<path class="lg-o" d="M13 1.5 L24.5 13 L13 24.5 L1.5 13 Z" stroke-width="1.6"/>'+
        '<path class="lg-i" d="M13 6.5 L19.5 13 L13 19.5 L6.5 13 Z" stroke-width="1"/></svg>'+
      '<b>SC TRADING</b></a>'+
    '<div class="mtop-r">'+
      '<span class="memis" title="Последний выброс"><span class="dot" aria-hidden="true"></span><span class="v">2 ч</span></span>'+
      '<span class="mplan">'+tierName()+'</span>'+
      '<a class="ibtn" href="settings.html" aria-label="Настройки">'+I.gear+'</a>'+
      '<a class="ibtn" href="login.html" aria-label="Выход">'+I.exit+'</a>'+
    '</div></div>';
}

/* ---------- лента сигналов ---------- */
function signalsHtml(){
  return '<div class="msignals" id="msignals">'+
    '<div class="msig-h"><span class="t">Сигналы</span><span class="live" id="msiglive">срез —</span></div>'+
    '<div class="msig-track" id="msigtrack"></div></div>';
}
function fillSignals(){
  var track = document.getElementById("msigtrack");
  if (!track) return;
  var items = (D.favorites||[]).filter(function(f){ return f.market && f.market.lots && f.market.lots.length; });
  if (!items.length){
    track.innerHTML = '<div class="msig-empty">Сигналов нет — добавь предметы в избранное.</div>';
    document.getElementById("msiglive").textContent = "срез "+A.fmtHM(A.NOW);
    return;
  }
  var latest = 0;
  track.innerHTML = items.map(function(f){
    var n = A.goodCount(f), t = Date.parse(f.market.collectTime);
    if (t > latest) latest = t;
    return '<a class="msig'+(f.itemId===state.selected?" on":"")+'" href="favorites.html?item='+encodeURIComponent(f.itemId)+'" data-id="'+A.esc(f.itemId)+'">'+
      A.iconHtml(f,"sig-ico")+
      '<span class="m"><span class="nm">'+A.esc(f.nameRu)+'</span><span class="sb">обн. '+A.fmtHM(t)+'</span></span>'+
      (n>0?'<span class="badge">+'+n+'</span>':'')+'</a>';
  }).join("");
  document.getElementById("msiglive").textContent = "срез "+A.fmtHM(latest||A.NOW);
  Array.prototype.forEach.call(track.querySelectorAll(".msig"), function(el){
    el.addEventListener("click", function(e){
      if (state.onSignal){ e.preventDefault(); var id=el.getAttribute("data-id"); setSignal(id); state.onSignal(id); }
    });
  });
}
function setSignal(id){
  state.selected = id;
  var track = document.getElementById("msigtrack");
  if (!track) return;
  Array.prototype.forEach.call(track.querySelectorAll(".msig"), function(el){
    el.classList.toggle("on", el.getAttribute("data-id")===id);
  });
}
function refreshSignals(selectedId){ if (selectedId!==undefined) state.selected=selectedId; fillSignals(); }

/* ---------- нижний таб-бар ---------- */
function tabItems(){
  return [
    {id:"favorites", label:"Избранное", href:"favorites.html", icon:I.fav},
    {id:"catalog",   label:"Каталог",   href:"catalog.html",   icon:I.catalog},
    {id:"lots",      label:"Лоты",      href:"lots.html",      icon:I.lots, locked:!lotsOpen(), tip:"Доступно на тарифе ПРОДВИНУТАЯ+"},
    {id:"buy-sniper",label:"Закупки",   href:"buy-sniper.html",icon:I.buy,  locked:!lotsOpen(), tip:"Доступно на тарифе ПРОДВИНУТАЯ+"},
    {id:"more",      label:"Ещё",       icon:I.more}
  ];
}
function tabbarHtml(active){
  var moreActive = SHEET_PAGES.indexOf(active) >= 0;
  var links = tabItems().map(function(p){
    var cur = (p.id===active) || (p.id==="more" && moreActive);
    var attrs = cur ? ' aria-current="page"' : '';
    var lock = p.locked ? '<span class="tlock">'+lockSvg(9,10,1.6)+'</span>' : '';
    if (p.id==="more"){
      return '<a href="#" data-more="1"'+attrs+'><span class="ic" aria-hidden="true">'+p.icon+'</span><span class="lab">'+p.label+'</span></a>';
    }
    return '<a href="'+p.href+'" data-nav="'+p.id+'" data-locked="'+(p.locked?1:0)+'" data-tip="'+A.esc(p.tip||"")+'"'+attrs+'>'+
      '<span class="ic" aria-hidden="true">'+p.icon+lock+'</span><span class="lab">'+A.esc(p.label)+'</span></a>';
  }).join("");
  return '<nav class="mtab" aria-label="Основная навигация">'+links+'</nav>';
}

/* ---------- шит «Ещё» ---------- */
function sheetNavItem(id, label, href, icon, active, opts){
  opts = opts||{};
  var cur = id===active;
  var cls = "" + (opts.danger?" danger":"") + (opts.locked?" locked":"");
  var lock = opts.locked ? '<span class="tlock" style="margin-left:auto">'+lockSvg(11,12,1.5)+'</span>' : '';
  return '<a href="'+(opts.locked?"#":href)+'" data-sheet-nav="'+id+'" data-locked="'+(opts.locked?1:0)+'" data-tip="'+A.esc(opts.tip||"")+'"'+
    (cur?' aria-current="page"':'')+' class="'+cls.trim()+'">'+icon+'<span class="nl">'+A.esc(label)+'</span>'+lock+'</a>';
}
function sheetHtml(active){
  var tierOpts = ORDER.map(function(t){ return '<option value="'+t+'"'+(t===getTier()?" selected":"")+'>'+TIER_NAME[t]+'</option>'; }).join("");
  return '<div class="msheet-ov" id="more-ov" hidden>'+
    '<div class="msheet" role="dialog" aria-modal="true" aria-label="Меню">'+
      '<div class="msheet-grab" aria-hidden="true"></div>'+
      '<div class="msheet-h"><h3>Разделы</h3>'+
        '<button type="button" class="ibtn" id="more-close" aria-label="Закрыть">'+
        '<svg width="14" height="14" viewBox="0 0 12 12" fill="none"><path d="M1.5 1.5l9 9M10.5 1.5l-9 9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button></div>'+
      '<div class="msheet-nav">'+
        sheetNavItem("feed","Лента","feed.html",I.feed,active)+
        sheetNavItem("news","Новости","news.html",I.news,active)+
        sheetNavItem("radar","Радар рынка","radar.html",I.radar,active,{locked:!hasRadar(),tip:"Доступно как аддон «Радар рынка»"})+
        sheetNavItem("settings","Настройки","settings.html",I.settings,active)+
        sheetNavItem("faq","Помощь / FAQ","faq.html",I.help,active)+
        (IS_ADMIN ? sheetNavItem("admin","Админ","admin.html",I.admin,active) : "")+
        '<div class="msheet-sep"></div>'+
        sheetNavItem("logout","Выход","login.html",I.logout,active,{danger:true})+
      '</div>'+
      '<div class="msheet-sep"></div>'+
      '<div class="msheet-b">'+
        '<div class="kick" style="margin-bottom:8px">Демо-режим · тариф</div>'+
        '<div class="gap8">'+
          '<div class="frow"><select class="input" id="demo-tier" aria-label="Тариф (демо)">'+tierOpts+'</select></div>'+
          '<label class="sw"><span class="t">Аддон «Радар рынка»</span>'+
            '<span class="tgl"><input type="checkbox" id="demo-radar"'+(hasRadar()?" checked":"")+'><span class="tr"></span></span></label>'+
        '</div>'+
        '<div class="fnote" style="margin-top:8px">Переключатель — только в прототипе: имитирует тариф и включает замки на Лотах / Закупках / Радаре.</div>'+
      '</div>'+
    '</div></div>';
}

/* ---------- sysbar ---------- */
function sysbarHtml(){
  var cut = A.fmtDM(A.NOW)+"."+new Date(A.NOW).getFullYear()+" "+A.fmtHM(A.NOW-29*60000);
  return '<footer class="sysbar" id="sysbar">'+
    '<span><b>SC TRADING TERMINAL</b> · mobile</span>'+
    '<span>срез: <b>'+cut+'</b></span>'+
    '<span>регион: <b>RU</b></span>'+
    '<span>тариф: <b>'+tierName()+'</b>'+(hasRadar()?' <b>+ радар</b>':'')+'</span>'+
  '</footer>';
}

/* ---------- события ---------- */
function openSheet(){ var ov=document.getElementById("more-ov"); if(ov) ov.hidden=false; }
function closeSheet(){ var ov=document.getElementById("more-ov"); if(ov) ov.hidden=true; }

function bind(){
  /* таб-бар: замки → тост, «Ещё» → шит */
  Array.prototype.forEach.call(document.querySelectorAll(".mtab a"), function(a){
    a.addEventListener("click", function(e){
      if (a.getAttribute("data-more")==="1"){ e.preventDefault(); openSheet(); return; }
      if (a.getAttribute("data-locked")==="1"){ e.preventDefault(); A.toast(a.getAttribute("data-tip")||"Недоступно на текущем тарифе"); }
    });
  });
  var ov = document.getElementById("more-ov");
  if (ov){
    ov.addEventListener("click", function(e){ if (e.target===ov) closeSheet(); });
    document.getElementById("more-close").addEventListener("click", closeSheet);
    Array.prototype.forEach.call(ov.querySelectorAll("[data-sheet-nav]"), function(a){
      a.addEventListener("click", function(e){
        if (a.getAttribute("data-locked")==="1"){ e.preventDefault(); A.toast(a.getAttribute("data-tip")||"Недоступно"); }
      });
    });
    ov.querySelector("#demo-tier").addEventListener("change", function(e){
      try{ localStorage.setItem(TIER_KEY, e.target.value); }catch(err){}
      rerender();
    });
    ov.querySelector("#demo-radar").addEventListener("change", function(e){
      try{ localStorage.setItem(RADAR_KEY, e.target.checked?"1":"0"); }catch(err){}
      rerender();
    });
  }
}
function rerender(){
  var open = false; var ov=document.getElementById("more-ov"); if(ov) open=!ov.hidden;
  render(state.active);
  if (open) openSheet();
  try{ window.dispatchEvent(new CustomEvent("sc:tier",{detail:{tier:getTier(),radar:hasRadar()}})); }catch(e){}
}

/* ---------- публичный рендер ---------- */
function render(activePage){
  state.active = activePage;
  var shell = document.getElementById("mshell");
  if (!shell){ if(window.console) console.warn("SC_MSHELL: #mshell не найден"); return; }
  shell.innerHTML = topbarHtml() + signalsHtml() + tabbarHtml(activePage) + sheetHtml(activePage);
  fillSignals();
  var old = document.getElementById("sysbar"); if (old) old.remove();
  var main = document.querySelector(".mmain");
  if (main) main.insertAdjacentHTML("beforeend", sysbarHtml());
  else document.body.insertAdjacentHTML("beforeend", sysbarHtml());
  bind();
}

window.SC_MSHELL = {
  render: render,
  getTier: getTier, hasRadar: hasRadar, tierAllows: tierAllows,
  tierName: tierName, requiredTier: requiredTier, lockSvg: lockSvg,
  onSignal: function(fn){ state.onSignal = fn; },
  setSignal: setSignal, refreshSignals: refreshSignals,
  openSheet: openSheet, closeSheet: closeSheet
};
})();
