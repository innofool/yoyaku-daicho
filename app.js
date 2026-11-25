'use strict';
// 予約台帳の画面。データはこの端末の中だけで扱い、外へは送らない。
// お客様の文字は必ず textContent で表示する（画面に仕込まれた文字が命令として動かないように）。
// 画面の並びと操作は、飲食店でよく使われる予約台帳の管理画面（本人が見せてくれた画面写真）に合わせている。
(function () {
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'style') el.style.cssText = v; // 属性ではなくCSSOMで入れる（厳しいCSPのままで使える）
      else if (k in el && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const k of kids.flat()) if (k != null && k !== false) el.append(k instanceof Node ? k : String(k));
    return el;
  }
  const SVGNS = 'http://www.w3.org/2000/svg';
  function sv(tag, attrs, ...kids) {
    const el = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
    for (const k of kids.flat()) if (k != null) el.append(k instanceof Node ? k : document.createTextNode(String(k)));
    return el;
  }
  const pad = (n) => String(n).padStart(2, '0');
  const fmtDate = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const parseDate = (s) => new Date(s + 'T00:00:00');
  const addDays = (s, n) => { const d = parseDate(s); d.setDate(d.getDate() + n); return fmtDate(d); };
  const toMin = (t) => +t.slice(0, 2) * 60 + +t.slice(3);
  const toTime = (m) => pad(Math.floor(m / 60)) + ':' + pad(m % 60);
  const WD = ['日', '月', '火', '水', '木', '金', '土'];
  const jpDate = (s) => { const d = parseDate(s); return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日(' + WD[d.getDay()] + ')'; };
  const mdw = (s) => { const d = parseDate(s); return (d.getMonth() + 1) + '月' + d.getDate() + '日(' + WD[d.getDay()] + ')'; };
  const stamp = (iso) => { const d = new Date(iso); return mdw(fmtDate(d)) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); };
  const ymLabel = (ym) => +ym.slice(0, 4) + '年' + +ym.slice(5, 7) + '月';
  const STATUS = { booked: '予約', seated: '来店中', left: '退店', cancel: '予約取消', noshow: 'No Show' };
  const EV = { new: '新規', change: '変更', cancel: '取消' };
  const ACTIVE = new Set(['booked', 'seated', 'left']);
  const COLORS = ['#1d6fd8', '#22a06b', '#f59e0b', '#dc2626', '#7c3aed', '#0891b2', '#db2777', '#65a30d', '#9ca3af', '#a16207'];
  const coarse = matchMedia('(pointer: coarse)').matches;
  const wide = () => matchMedia('(min-width: 1001px)').matches;
  const yen = (n) => '¥' + Number(n || 0).toLocaleString('ja-JP');

  const S = { today: '', date: '', view: 'ledger', lmode: 'time', boot: null, day: [], homeYm: '', homeMode: 'count', rcTab: 'all', rcLimit: 10, cTab: 'list', cSort: 'kana', aTab: 'top', ap: {}, pTab: 'list' };

  // ---------- 台帳とのやりとり（すべてこの端末の中で完結する） ----------
  const C = window.YoyakuCore, V = window.YoyakuVault;
  const vault = new V.Vault(V.idbStorage());
  let L = null; // 開いている間だけの台帳（ロックすると消える）
  let saving = Promise.resolve();
  function persist() { saving = saving.catch(() => {}).then(() => vault.save(L.db)); return saving; }
  async function api(method, url, body) {
    if (!L) { showGate(); throw new Error('ロックされています'); }
    touch();
    const u = new URL(url, 'http://local'); const q = Object.fromEntries(u.searchParams); const p = u.pathname;
    const b = body || {};
    let out, m;
    if (p === '/bootstrap' && method === 'GET') out = L.bootstrap();
    else if (p === '/settings' && method === 'PUT') out = L.updateSettings(b);
    else if (p === '/reservations' && method === 'GET') out = L.listReservations(q.from, q.to);
    else if (p === '/reservations' && method === 'POST') out = L.saveReservation(b);
    else if ((m = /^\/reservations\/(r_[a-f0-9]{16})(\/status)?$/.exec(p))) {
      if (method === 'PUT' && !m[2]) out = L.saveReservation(b, m[1]);
      else if (method === 'PUT') out = L.setStatus(m[1], b.status, b.staff);
      else if (method === 'DELETE') out = L.deleteReservation(m[1]);
    } else if (p === '/availability' && method === 'GET') out = L.availability(q.date, q.time, q.stayMin, q.guests, q.exclude, q.resetMin);
    else if (p === '/home' && method === 'GET') out = L.homeMonth(q.ym);
    else if (p === '/month' && method === 'GET') out = L.month(q.ym);
    else if (p === '/dayinfo' && method === 'PUT') out = L.setDayInfo(b.date, b.text);
    else if (p === '/received' && method === 'GET') out = L.received(q.tab, q.limit);
    else if (p === '/search' && method === 'GET') out = L.search(q.q);
    else if (p === '/analytics' && method === 'GET') out = L.analytics(q.kind, q);
    else if (p === '/customers' && method === 'GET') out = L.listCustomers({ q: q.q, stale: q.stale === '1', hidden: q.hidden === '1', limit: q.limit, sort: q.sort, tag: q.tag, minVisits: q.minVisits });
    else if (p === '/customers' && method === 'POST') out = L.saveCustomer(b);
    else if ((m = /^\/customers\/(c_[a-f0-9]{16})$/.exec(p))) {
      if (method === 'GET') out = L.getCustomer(m[1]);
      else if (method === 'PUT') out = L.saveCustomer(b, m[1]);
      else if (method === 'DELETE') out = L.deleteCustomer(m[1]);
    } else if (p === '/log' && method === 'GET') out = { log: L.log(300) };
    if (out === undefined) throw new Error('見つかりません');
    if (method !== 'GET' && !out.conflicts) {
      try { await persist(); } catch (e) { throw new Error('保存できませんでした。端末の空き容量を確かめてください（' + e.message + '）'); }
    }
    return JSON.parse(JSON.stringify(out)); // 画面側で書き換えても台帳に響かないよう写しを渡す
  }
  const qs = (o) => Object.entries(o).filter(([, v]) => v !== '' && v != null).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');

  // 操作がない時・アプリを閉じて時間がたった時に、自動でロックする
  let lastTouch = Date.now();
  function touch() { lastTouch = Date.now(); }
  ['pointerdown', 'keydown'].forEach((ev) => document.addEventListener(ev, touch, { passive: true }));
  function idleLimit() { return (L ? L.db.settings.autoLockMin : 10) * 60000; }
  function checkIdle() { if (L && Date.now() - lastTouch > idleLimit()) lockNow('自動ロック'); }
  setInterval(checkIdle, 15000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') checkIdle(); });
  async function lockNow(why) {
    if (L) { try { L._log(why || 'ロック'); await persist(); } catch (e) { /* 保存できなくてもロックはする */ } }
    L = null; vault.lock();
    gateMode = 'unlock'; showGate();
  }

  function download(name, blob) {
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  // iPadでは共有メニュー（「ファイル」に保存・AirDrop）を出す。出せない端末ではダウンロード
  async function shareOrDownload(name, blob) {
    const file = new File([blob], name, { type: blob.type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: name }); return 'shared'; } catch (e) { if (e.name === 'AbortError') return 'aborted'; }
    }
    download(name, blob);
    return 'downloaded';
  }
  let toastTimer;
  function toast(msg, bad, action) {
    const t = $('#toast'), b = $('#toast-act');
    $('#toast-text').textContent = msg; t.className = 'toast show' + (bad ? ' bad' : '');
    b.hidden = !action; b.onclick = null;
    if (action) { b.textContent = action.label; b.onclick = () => { t.className = 'toast'; action.fn(); }; }
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = 'toast'; }, action ? 7000 : bad ? 4000 : 2000);
  }
  const fail = (e) => toast(e.message || String(e), true);

  // 確認の小窓（OKなら true、入力欄つきなら入力した文字）
  function ask(title, body, opt) {
    opt = opt || {};
    const d = $('#dlg-ask');
    $('#ask-title').textContent = title;
    const box = $('#ask-body'); box.replaceChildren();
    let ta = null;
    if (opt.input != null) { ta = h('textarea', { value: opt.input, 'aria-label': title }); box.append(ta); }
    else box.textContent = body;
    $('#ask-yes').textContent = opt.ok || 'OK';
    $('#ask-no').textContent = opt.cancel || 'キャンセル';
    return new Promise((resolve) => {
      const done = (v) => { d.close(); $('#ask-yes').onclick = null; $('#ask-no').onclick = null; $('#ask-x').onclick = null; resolve(v); };
      $('#ask-yes').onclick = () => done(ta ? ta.value : true);
      $('#ask-no').onclick = () => done(ta ? null : false);
      $('#ask-x').onclick = () => done(ta ? null : false);
      d.oncancel = (e) => { e.preventDefault(); done(ta ? null : false); };
      d.showModal();
      if (ta) ta.focus();
    });
  }

  // ---------- 合言葉 ----------
  let gateMode = 'unlock';
  async function start() {
    if (!window.isSecureContext || !window.crypto || !crypto.subtle || !window.indexedDB) {
      document.body.textContent = 'この開き方では暗号化が使えないため、台帳を開けません。https:// で始まるアドレスか、ホーム画面のアイコンから開いてください。';
      return;
    }
    S.today = C.localDate();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { /* なくても台帳は使える */ });
    if (navigator.storage && navigator.storage.persist) { try { S.persisted = await navigator.storage.persist(); } catch (e) { S.persisted = false; } }
    gateMode = (await vault.exists()) ? 'unlock' : 'setup';
    showGate();
  }
  function showGate() {
    $('#app').hidden = true; $('#gate').hidden = false;
    $$('dialog[open]').forEach((d) => d.close());
    $('#movebar').hidden = true;
    closePanel(true);
    const setup = gateMode === 'setup';
    $('#gate-pass2-wrap').hidden = !setup;
    $('#gate-pass2').required = setup;
    $('#gate-btn').textContent = setup ? '台帳を作る' : '開く';
    $('#gate-hint').textContent = setup ? 'はじめに合言葉を決めます（8文字以上）。忘れるとデータを開けません。紙に書いて金庫など安全な場所に保管してください。' : '';
    $('#gate-pass').value = ''; $('#gate-pass2').value = ''; $('#gate-err').textContent = '';
    $('#gate-pass').focus();
  }
  $('#gate-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#gate-err').textContent = '';
    $('#gate-btn').disabled = true;
    $('#gate-btn').textContent = '確かめています…';
    try {
      const pass = $('#gate-pass').value;
      if (gateMode === 'setup') {
        if (pass !== $('#gate-pass2').value) throw new Error('確認用の合言葉が一致しません');
        const db = C.emptyDb();
        L = new C.Ledger(db);
        L._log('台帳を作成');
        await vault.setup(pass, db);
      } else {
        const db = await vault.unlock(pass);
        if (!db) throw new Error('合言葉が違います');
        L = new C.Ledger(db);
        L._log('開く');
        await persist();
      }
      gateMode = 'unlock';
      touch();
      await enter();
    } catch (err) { if (!vault.unlocked) L = null; $('#gate-err').textContent = err.message; }
    finally { $('#gate-btn').disabled = false; $('#gate-btn').textContent = gateMode === 'setup' ? '台帳を作る' : '開く'; $('#gate-pass').value = ''; $('#gate-pass2').value = ''; }
  });

  async function enter() {
    S.boot = await api('GET', '/bootstrap');
    $('#gate').hidden = true; $('#app').hidden = false;
    $('#store-name').textContent = S.boot.settings.storeName || '予約台帳';
    if (!S.date) S.date = S.today;
    if (!S.homeYm) S.homeYm = S.today.slice(0, 7);
    show(S.view);
  }

  // ---------- 左のメニュー・画面の切り替え ----------
  $('#btn-side').addEventListener('click', () => {
    if (wide()) document.body.classList.toggle('side-closed');
    else document.body.classList.toggle('side-open');
  });
  $$('#side [data-go]').forEach((b) => b.addEventListener('click', () => { if (!wide()) document.body.classList.remove('side-open'); show(b.dataset.go); }));
  $$('#side .grp').forEach((b) => b.addEventListener('click', () => { $('#grp-' + b.dataset.grp).classList.toggle('open'); }));
  $('#btn-lock').addEventListener('click', () => lockNow('ロック'));

  function show(view) {
    if (view !== 'ledger' && P) closePanel(true);
    S.view = view;
    $$('#side [data-go]').forEach((b) => b.classList.toggle('on', b.dataset.go === view));
    $$('main > .view').forEach((v) => { v.hidden = v.id !== 'v-' + view; });
    if (['print', 'csv', 'widget'].includes(view)) $('#grp-tools').classList.add('open');
    if (['settings', 'security'].includes(view)) $('#grp-settings').classList.add('open');
    const run = { home: renderHome, received: renderReceived, ledger: loadDay, search: renderSearch, customers: renderCustomers, analytics: renderAnalytics, print: renderPrint, csv: renderCsv, widget: renderWidget, settings: renderSettings, security: renderSecurity }[view];
    $('#main').scrollTop = 0;
    run().catch(fail);
  }

  function courseName(id) { const c = S.boot.courses.find((x) => x.id === id); return c ? c.name : ''; }
  function tableNames(ids) { return ids.map((id) => (S.boot.tables.find((t) => t.id === id) || {}).name).filter(Boolean).join(', '); }
  function capText(t) { return (t.min || 1) === t.cap ? t.cap + ' 名' : (t.min || 1) + '-' + t.cap + ' 名'; }
  function sama(c) { return c ? (c.name || c.kana || c.phone || 'お名前なし') + ' 様' : 'お名前なし'; }
  function guestsText(r) { return (r.guestsMin && r.guestsMin !== r.guests ? r.guestsMin + '-' : '') + r.guests + '名様'; }
  function smokeIcon(t) { return t.smoke === '喫煙' ? '🚬' : t.smoke === '禁煙' ? '🚭' : ''; }
  function isVip(c) { return c && c.tags.some((t) => /^vip$/i.test(t)); }

  // ---------- ホーム（月のカレンダー） ----------
  $('#h-today').addEventListener('click', () => { S.homeYm = S.today.slice(0, 7); renderHome().catch(fail); });
  $('#h-prev').addEventListener('click', () => { S.homeYm = C.ymAdd(S.homeYm, -1); renderHome().catch(fail); });
  $('#h-next').addEventListener('click', () => { S.homeYm = C.ymAdd(S.homeYm, 1); renderHome().catch(fail); });
  $$('#h-mode button').forEach((b) => b.addEventListener('click', () => { S.homeMode = b.dataset.mode; renderHome().catch(fail); }));
  async function renderHome() {
    const r = await api('GET', '/home?ym=' + S.homeYm);
    $('#h-title').textContent = ymLabel(S.homeYm);
    $$('#h-mode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === S.homeMode));
    const cal = $('#h-cal'); cal.replaceChildren();
    WD.forEach((w, i) => cal.append(h('div', { class: 'wd' + (i === 0 ? ' sun' : i === 6 ? ' sat' : ''), text: w })));
    for (let s = r.start; s <= r.end; s = addDays(s, 1)) {
      const d = r.days[s], wd = parseDate(s).getDay();
      const cell = h('button', { class: 'day' + (wd === 0 ? ' sun' : wd === 6 ? ' sat' : '') + (s.slice(0, 7) !== S.homeYm ? ' other' : '') + (s === S.today ? ' today' : ''), onclick: () => { S.date = s; show('ledger'); } },
        h('span', { class: 'dn', text: +s.slice(8) }));
      if (S.homeMode === 'count') {
        cell.append(h('span', { class: 'cnt', text: '☀ ' + d.lunch.groups + '組 (' + d.lunch.guests + '名)' }), h('span', { class: 'cnt', text: '☾ ' + d.dinner.groups + '組 (' + d.dinner.guests + '名)' }));
      } else if (d.info) cell.append(h('span', { class: 'memo', text: d.info }));
      cal.append(cell);
    }
    const ti = (r.days[S.today] && r.days[S.today].info) || L.db.dayInfo[S.today] || '';
    $('#h-info').replaceChildren(h('b', { text: '本日の情報（' + mdw(S.today) + '）' }), h('div', { text: ti || '情報はありません', style: 'white-space:pre-wrap;margin-top:6px' }));
  }

  // ---------- 受付履歴 ----------
  $$('#rc-tabs button').forEach((b) => b.addEventListener('click', () => { S.rcTab = b.dataset.tab; S.rcLimit = 10; renderReceived().catch(fail); }));
  $('#rc-more').addEventListener('click', () => { S.rcLimit += 10; renderReceived().catch(fail); });
  async function renderReceived() {
    $$('#rc-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === S.rcTab));
    const r = await api('GET', '/received?tab=' + S.rcTab + '&limit=' + S.rcLimit);
    const t = $('#rc-table'); t.replaceChildren();
    t.append(h('thead', null, h('tr', null, ['更新日', '来店日時', 'ご予約者', '人数, テーブル', '備考'].map((x) => h('th', { text: x })))));
    const tb = h('tbody');
    for (const row of r.rows) {
      const x = row.reservation;
      tb.append(h('tr', { class: 'click', onclick: () => openReservation(x) },
        h('td', null, h('div', { text: stamp(row.t) + ' ' + (row.type === 'new' ? '受付' : row.type === 'cancel' ? '取消' : '変更') }), row.staff ? h('div', { class: 'muted', text: row.staff }) : null, h('span', { class: 'badge ' + row.type, text: EV[row.type] })),
        h('td', { text: mdw(x.date) + ' ' + x.time }),
        h('td', null, h('b', { class: 'who', text: sama(x.customer) })),
        h('td', null, h('div', { text: guestsText(x) }), h('div', { class: 'muted', text: tableNames(x.tableIds) || 'ウェイティング' })),
        h('td', null, x.tags.map((g) => h('div', { class: 'badge tag', text: g })), x.flags.map((f) => h('div', null, h('span', { class: 'badge flag' + (f === '営業時間外' ? '' : ' f2'), text: f }))))));
    }
    if (!r.rows.length) tb.append(h('tr', null, h('td', { colspan: 5, class: 'muted', text: '該当する受付はありません' })));
    t.append(tb);
    $('#rc-more').hidden = r.total <= r.rows.length;
  }

  // ---------- 予約台帳 ----------
  $('#d-prev').addEventListener('click', () => goDate(addDays(S.date, -1)));
  $('#d-next').addEventListener('click', () => goDate(addDays(S.date, 1)));
  $('#d-today').addEventListener('click', () => goDate(S.today));
  $('#d-input').addEventListener('change', (e) => { if (e.target.value) goDate(e.target.value); });
  $$('#l-mode [data-mode]').forEach((b) => b.addEventListener('click', () => { S.lmode = b.dataset.mode; S.floor = false; loadDay().catch(fail); }));
  $('#btn-new').addEventListener('click', () => openForm(null, { date: S.date }));
  $('#btn-more').addEventListener('click', () => { $('#morebox').hidden = !$('#morebox').hidden; });
  $('#show-cancel').addEventListener('change', () => renderDayViews());
  $('#btn-floor').addEventListener('click', () => { S.floor = true; $('#morebox').hidden = true; renderDayViews(); });
  $('#floor-close').addEventListener('click', () => { S.floor = false; renderDayViews(); });
  $('#btn-print-day').addEventListener('click', () => { S.printDate = S.date; show('print'); });
  function goDate(d) {
    S.date = d;
    if (P && P.f) { P.f.date = d; renderPanel(); }
    loadDay().catch(fail);
  }

  async function loadDay() {
    const r = await api('GET', '/reservations?from=' + S.date + '&to=' + S.date);
    S.day = r.reservations; S.dayInfo = r.info;
    $('#d-label').textContent = jpDate(S.date);
    $('#d-input').value = S.date;
    $$('#l-mode [data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === S.lmode));
    const info = $('#day-info');
    info.replaceChildren(h('span', { class: 'ic', text: 'ⓘ' }), h('div', { class: 'txt' }, h('span', { class: 'ttl', text: '本日の情報' }), r.info || '情報はありません'),
      h('button', { class: 'link', text: '変更', onclick: editDayInfo }));
    renderDayViews();
  }
  async function editDayInfo() {
    const v = await ask('本日の情報（' + mdw(S.date) + '）', '', { input: S.dayInfo || '', ok: '保存' });
    if (v == null) return;
    try { await api('PUT', '/dayinfo', { date: S.date, text: v }); toast('保存しました'); loadDay().catch(fail); } catch (e) { fail(e); }
  }
  function renderDayViews() {
    $('#l-time').hidden = S.lmode !== 'time' || S.floor;
    $('#l-list').hidden = S.lmode !== 'list' || S.floor;
    $('#l-floor').hidden = !S.floor;
    if (S.floor) renderFloor();
    else if (S.lmode === 'time') renderTime();
    else renderList();
  }

  function hoursRange(list) {
    const st = S.boot.settings;
    let s = Math.floor(toMin(st.open) / 60) * 60, e = Math.ceil(toMin(st.close) / 60) * 60;
    for (const r of list) { s = Math.min(s, Math.floor(toMin(r.time) / 60) * 60); e = Math.max(e, Math.ceil((toMin(r.time) + r.stayMin) / 60) * 60); }
    if (P && P.f && P.f.start && P.f.end) { s = Math.min(s, Math.floor(toMin(P.f.start) / 60) * 60); e = Math.max(e, Math.ceil(toMin(P.f.end) / 60) * 60); }
    return [s, Math.min(e, 30 * 60)];
  }
  function slotW() { return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--slot')) || 44; }

  function renderTime() {
    const showCancel = $('#show-cancel').checked;
    const list = S.day.filter((r) => showCancel || ACTIVE.has(r.status));
    const [s, e] = hoursRange(list);
    const slot = slotW(), slots = (e - s) / 30, px = (m) => ((m - s) / 30) * slot;
    const st = S.boot.settings, o0 = toMin(st.open), o1 = toMin(st.close);
    const grid = $('#grid'); grid.replaceChildren();
    const head = h('div', { class: 'g-head' }, h('div', { class: 'g-corner', text: 'テーブル' }));
    for (let m = s; m < e; m += 60) head.append(h('div', { class: 'g-hour', text: toTime(m) }));
    grid.append(head);
    const picking = P && P.f && (P.step === 'form');
    const rows = S.boot.tables.slice();
    const waiting = list.filter((r) => !r.tableIds.length);
    if (waiting.length) rows.unshift({ id: '', name: 'ウェイティング', waiting: true });
    const rowEls = [];
    for (const t of rows) {
      const cells = h('div', { class: 'g-cells', style: 'width:' + slots * slot + 'px' });
      for (let i = 0; i < slots; i++) {
        const tm = s + i * 30;
        cells.append(h('div', { class: 'g-cell' + (tm % 60 === 0 ? ' h' : '') + (tm >= o0 && tm < o1 ? ' open' : ''), 'data-tm': tm }));
      }
      if (!t.waiting && !picking) {
        cells.addEventListener('click', (ev) => {
          const cell = ev.target.closest('.g-cell'); if (!cell) return;
          openForm(null, { date: S.date, time: toTime(+cell.dataset.tm), tableIds: [t.id] });
        });
      }
      const row = h('div', { class: 'g-row' + (t.waiting ? ' waiting' : ''), 'data-tid': t.id },
        h('div', { class: 'g-name' }, h('span', { class: 'tn' }, h('span', { class: 'smk', text: t.waiting ? '' : smokeIcon(t) }), t.name), h('span', { class: 'tc', text: t.waiting ? '' : capText(t) })), cells);
      rowEls.push({ t, row, cells });
      grid.append(row);
    }
    const g = { s, e, slot, px, rowEls };
    for (const { t, cells } of rowEls) {
      const mine = t.waiting ? waiting : list.filter((r) => r.tableIds.includes(t.id));
      for (const r of mine) {
        if (picking && P.r && r.id === P.r.id) continue; // 変更中の予約は、選び直す枠で表す
        const el = blockEl(r, px, slot);
        if (!picking) attachDrag(el, r, t.id, g);
        cells.append(el);
      }
      if (picking && !t.waiting) cells.append(pickSlot(t, px, slot));
    }
    if (S.date === S.today) {
      const now = new Date(), nm = now.getHours() * 60 + now.getMinutes();
      if (nm >= s && nm <= e) for (const { cells } of rowEls) cells.append(h('div', { class: 'g-now', style: 'left:' + px(nm) + 'px' }));
    }
    S.grid = g;
    const wrap = $('#l-time');
    const focus = picking && P.f.start ? toMin(P.f.start) : (S.date === S.today ? new Date().getHours() * 60 : toMin(st.open));
    if (picking || S.scrollKey !== S.date) { wrap.scrollLeft = Math.max(0, px(focus) - 2 * slot); S.scrollKey = S.date; }
  }

  function blockEl(r, px, slot) {
    const c = r.customer;
    const el = h('div', {
      class: 'blk ' + r.status + (r.flags.includes('重複') ? ' over' : '') + (P && P.r && P.r.id === r.id ? ' sel' : ''),
      style: 'left:' + px(toMin(r.time)) + 'px;width:' + Math.max(slot - 4, (r.stayMin / 30) * slot - 3) + 'px',
      title: r.time + '-' + toTime(toMin(r.time) + r.stayMin) + ' ' + guestsText(r) + ' ' + sama(c) + (r.flags.length ? '（' + r.flags.join('・') + '）' : ''),
    },
    r.flags.length ? h('span', { class: 'warn-ic', text: '!' }) : null,
    h('div', { class: 'bi' }, h('div', { class: 't', text: r.time + ' - ' + guestsText(r) }), h('div', { class: 'n' }, sama(c), c ? h('span', { class: 'vc', text: c.visits }) : null)),
    r.tags.length ? h('span', { class: 'tg', text: '🏷' }) : null);
    return el;
  }

  // テーブルを選ぶ枠（右の入力欄が開いている時）：押すと選ぶ／外す
  function pickSlot(t, px, slot) {
    const f = P.f, on = f.tableIds.includes(t.id);
    const st = toMin(f.start), en = toMin(f.end);
    const busy = S.day.some((r) => ACTIVE.has(r.status) && r.id !== (P.r && P.r.id) && r.tableIds.includes(t.id) && st < toMin(r.time) + r.stayMin + (r.resetMin || 0) && toMin(r.time) < en + (+f.resetMin || 0));
    const n = (+f.adults || 0) + (+f.kids || 0);
    const unfit = n && (n > t.cap || n < (t.min || 1));
    return h('div', {
      class: 'slot' + (on ? ' on' : '') + (busy ? ' busy' : '') + (unfit ? ' unfit' : ''),
      style: 'left:' + px(st) + 'px;width:' + Math.max(slot - 4, ((en - st) / 30) * slot - 3) + 'px',
      title: t.name + (busy ? '（この時間は別の予約があります）' : '') + (unfit ? '（人数が定員の範囲外）' : ''),
      text: on ? '✓' : '',
      onclick: (ev) => { ev.stopPropagation(); f.tableIds = on ? f.tableIds.filter((x) => x !== t.id) : [...f.tableIds, t.id]; renderTime(); renderPanel(); },
    });
  }

  // 予約の枠を指でつかんで、別のテーブル・時刻へ動かす（動かした後に確認を出す）
  function attachDrag(el, r, fromTid, g) {
    el.addEventListener('pointerdown', (e) => {
      if (e.button) return;
      e.preventDefault();
      const sx = e.clientX, sy = e.clientY, rect = el.getBoundingClientRect();
      const offX = e.clientX - rect.left, offY = e.clientY - rect.top;
      let moved = false, ghost = null, target = null;
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* 古い端末 */ }
      const move = (ev) => {
        if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 8) return;
        if (!moved) {
          moved = true;
          ghost = el.cloneNode(true); ghost.classList.add('ghost-blk');
          ghost.style.width = rect.width + 'px'; ghost.style.height = rect.height + 'px';
          document.body.append(ghost); el.classList.add('dragging');
        }
        ghost.style.left = (ev.clientX - offX) + 'px'; ghost.style.top = (ev.clientY - offY) + 'px';
        target = dropTarget(ev.clientX - offX, ev.clientY, g);
        markDrop(target, r, g);
      };
      const end = (cancelled) => {
        el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', onUp); el.removeEventListener('pointercancel', onCancel);
        if (ghost) ghost.remove();
        el.classList.remove('dragging');
        if (!moved) { if (!cancelled) openReservation(r); return; }
        if (cancelled || !target) { renderTime(); return; }
        proposeMove(r, fromTid, target);
      };
      const onUp = () => end(false), onCancel = () => end(true);
      el.addEventListener('pointermove', move); el.addEventListener('pointerup', onUp); el.addEventListener('pointercancel', onCancel);
    });
  }
  function dropTarget(x, y, g) {
    for (const { t, row, cells } of g.rowEls) {
      const rr = row.getBoundingClientRect();
      if (y < rr.top || y > rr.bottom) continue;
      const cr = cells.getBoundingClientRect();
      let m = g.s + Math.round((((x - cr.left) / g.slot) * 30) / 15) * 15;
      m = Math.max(g.s, Math.min(m, g.e - 15));
      return { tid: t.id, time: toTime(m), row, cells, t };
    }
    return null;
  }
  function markDrop(target, r, g) {
    $$('.drop-mark').forEach((x) => x.remove());
    $$('.g-row.drop').forEach((x) => x.classList.remove('drop'));
    if (!target) return;
    target.row.classList.add('drop');
    target.cells.append(h('div', { class: 'drop-mark', style: 'left:' + g.px(toMin(target.time)) + 'px;width:' + Math.max(g.slot - 4, (r.stayMin / 30) * g.slot - 3) + 'px' }));
  }
  function resInput(r, change) {
    return { date: r.date, time: r.time, stayMin: r.stayMin, resetMin: r.resetMin, timeLimit: r.timeLimit, adults: r.adults, adultsMin: r.adultsMin, kids: r.kids, kidsMin: r.kidsMin, tableIds: r.tableIds, customerId: r.customerId || null, courses: r.courses, source: r.source, memo: r.memo, status: r.status, staff: r.staff, tags: r.tags, free: r.free, ...change };
  }
  function proposeMove(r, fromTid, target) {
    let tables;
    if (!target.tid) tables = [];
    else if (r.tableIds.length <= 1) tables = [target.tid];
    else tables = [...new Set(r.tableIds.map((t) => (t === fromTid ? target.tid : t)))];
    if (target.time === r.time && tables.join() === r.tableIds.join()) { renderTime(); return; }
    const bar = $('#movebar');
    $('#mv-text').replaceChildren(h('b', { text: target.time + ' - ' + guestsText(r) }), h('br'), document.createTextNode(sama(r.customer)), h('br'),
      h('span', { class: 'muted', text: (r.time !== target.time ? r.time + ' → ' + target.time + '　' : '') + (tableNames(r.tableIds) || 'ウェイティング') + ' → ' + (tableNames(tables) || 'ウェイティング') }));
    bar.hidden = false;
    const close = () => { bar.hidden = true; $('#mv-ok').onclick = null; $('#mv-cancel').onclick = null; };
    $('#mv-cancel').onclick = () => { close(); renderTime(); };
    $('#mv-ok').onclick = async () => {
      close();
      const prev = resInput(r, {});
      try {
        const ok = await saveChecked(resInput(r, { time: target.time, tableIds: tables }), r.id);
        if (!ok) { renderTime(); return; }
        await loadDay();
        toast('動かしました', false, { label: '元に戻す', fn: async () => { try { await api('PUT', '/reservations/' + r.id, { ...prev, allowOverlap: true }); await loadDay(); toast('元に戻しました'); } catch (e) { fail(e); } } });
      } catch (e) { fail(e); renderTime(); }
    };
  }
  // 保存（営業時間外・テーブルの重なりは確かめてから）
  async function saveChecked(body, id, opts) {
    const st = S.boot.settings;
    const endM = toMin(body.time) + (body.stayMin || (body.endTime ? toMin(body.endTime) - toMin(body.time) : 0));
    if (opts && opts.hoursCheck && (toMin(body.time) < toMin(st.open) || endM > toMin(st.close))) {
      if (!(await ask('営業時間外です', 'ご予約が休業時間帯にかかっています。\nこのまま登録してよろしいですか？'))) return null;
    }
    const url = id ? '/reservations/' + id : '/reservations';
    let r = await api(id ? 'PUT' : 'POST', url, body);
    if (r.conflicts) {
      const msg = r.conflicts.map((c) => c.time + '〜 ' + (c.name ? c.name + ' 様' : 'お名前なし') + '（' + c.tables.join(', ') + '）').join('\n');
      if (!(await ask('テーブルが重なっています', '同じテーブルに重なる予約があります。\n' + msg + '\nこのまま登録してよろしいですか？'))) return null;
      r = await api(id ? 'PUT' : 'POST', url, { ...body, allowOverlap: true });
    }
    return r;
  }

  let resizeTimer;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (L && S.view === 'ledger' && S.lmode === 'time' && S.boot) renderTime(); }, 150); });

  // 予約リスト
  function renderList() {
    const showCancel = $('#show-cancel').checked;
    const list = S.day.filter((r) => showCancel || ACTIVE.has(r.status));
    const t = $('#day-table'); t.replaceChildren();
    t.append(h('thead', null, h('tr', null, ['時間', 'ご予約者', '人数', 'テーブル', 'コース', '予約タグ', 'メモ', '状態'].map((x) => h('th', { text: x })))));
    const tb = h('tbody');
    for (const r of list) {
      const c = r.customer;
      tb.append(h('tr', { class: 'click', onclick: () => openReservation(r) },
        h('td', null, h('b', { text: r.time }), h('div', { class: 'muted', text: '- ' + toTime(toMin(r.time) + r.stayMin) })),
        h('td', null, h('b', { class: 'who', text: sama(c) }), c ? h('span', { class: 'vbadge', text: c.visits }) : null, isVip(c) ? h('span', { class: 'badge vip', text: 'VIP' }) : null,
          c && c.phone ? h('div', { class: 'muted', text: c.phone }) : null, c && c.allergy ? h('div', { class: 'err', text: '⚠ ' + c.allergy }) : null),
        h('td', { class: 'num', text: guestsText(r) }), h('td', { text: tableNames(r.tableIds) || 'ウェイティング' }),
        h('td', { text: r.courses.map((x) => courseName(x.courseId) + '×' + x.count).join(', ') }),
        h('td', null, r.tags.map((g) => h('div', { class: 'badge tag', text: g }))), h('td', { text: r.memo }),
        h('td', null, h('span', { class: 'pill ' + r.status, text: STATUS[r.status] }), r.flags.map((f) => h('div', null, h('span', { class: 'badge flag f2', text: f }))))));
    }
    if (!list.length) tb.append(h('tr', null, h('td', { colspan: 8, class: 'muted', text: 'この日の予約はありません' })));
    t.append(tb);
  }

  // テーブル配置図
  $('#floor-time').addEventListener('change', (e) => { S.floorTime = e.target.value; renderFloor(); });
  function renderFloor() {
    const st = S.boot.settings, sel = $('#floor-time');
    const o0 = toMin(st.open), o1 = toMin(st.close);
    if (!S.floorTime || S.floorDate !== S.date) {
      const now = new Date(), nm = now.getHours() * 60 + now.getMinutes();
      S.floorTime = toTime(S.date === S.today && nm >= o0 && nm < o1 ? Math.floor(nm / 30) * 30 : (o0 <= 1080 && 1080 < o1 ? 1080 : o0)); S.floorDate = S.date;
    }
    sel.replaceChildren();
    for (let m = Math.floor(o0 / 30) * 30; m < o1; m += 30) sel.append(h('option', { value: toTime(m), text: toTime(m) }));
    sel.value = S.floorTime;
    const tm = toMin(S.floorTime), act = S.day.filter((r) => ACTIVE.has(r.status));
    const box = $('#floor'); box.replaceChildren();
    let used = 0;
    for (const area of [...new Set(S.boot.tables.map((t) => t.area))]) {
      const tiles = h('div', { class: 'tiles' });
      for (const t of S.boot.tables.filter((x) => x.area === area)) {
        const mine = act.filter((r) => r.tableIds.includes(t.id)).sort((a, b) => a.time.localeCompare(b.time));
        const now = mine.find((r) => toMin(r.time) <= tm && tm < toMin(r.time) + r.stayMin);
        const next = mine.find((r) => toMin(r.time) > tm);
        if (now) used++;
        tiles.append(h('div', { class: 'tile ' + (now ? now.status : 'free'), onclick: () => (now ? openReservation(now) : openForm(null, { date: S.date, time: S.floorTime, tableIds: [t.id] })) },
          h('div', { class: 'tt' }, h('span', { text: smokeIcon(t) + ' ' + t.name }), h('small', { text: capText(t) })),
          h('div', { class: 'who2', text: now ? sama(now.customer) : '空き' }),
          now ? h('div', { class: 'sub', text: now.time + '-' + toTime(toMin(now.time) + now.stayMin) + '・' + guestsText(now) }) : null,
          next ? h('div', { class: 'sub', text: '次：' + next.time + ' ' + sama(next.customer) }) : null));
      }
      box.append(h('div', null, h('div', { class: 'area-h', text: area || 'エリアなし' }), tiles));
    }
    $('#floor-note').textContent = S.floorTime + ' の時点：' + used + ' / ' + S.boot.tables.length + ' テーブルが使用中';
  }

  // ---------- 右側の入力欄（新規予約・変更・詳細） ----------
  let P = null; // { step: 'form'|'confirm'|'detail', r, f }
  $('#pn-close').addEventListener('click', () => closePanel());
  function closePanel(silent) {
    P = null;
    $('#panel').hidden = true;
    if (!silent && S.view === 'ledger') renderDayViews();
  }
  function timeOptions(sel) {
    const st = S.boot.settings, out = [];
    const a = Math.max(0, Math.floor(toMin(st.open) / 60) * 60 - 120), b = Math.min(30 * 60 - 15, Math.ceil(toMin(st.close) / 60) * 60 + 180);
    for (let m = a; m <= b; m += 15) out.push(toTime(m));
    if (sel && !out.includes(sel)) out.push(sel), out.sort();
    return out;
  }
  function blankForm(p) {
    const st = S.boot.settings;
    const start = p.time || (S.date === S.today ? toTime(Math.max(toMin(st.open), Math.ceil((new Date().getHours() * 60 + new Date().getMinutes()) / 15) * 15)) : '18:00');
    return {
      date: p.date || S.date, start, end: toTime(Math.min(toMin(start) + st.defaultStayMin, 30 * 60 - 15)), timeLimit: false, resetMin: 0,
      adultsMin: '', adults: '', kidsMin: 0, kids: 0, tableIds: p.tableIds || [],
      phone: '', phone2: '', lastKana: '', firstKana: '', lastName: '', firstName: '', company: '',
      courses: [{ courseId: '', count: '' }], memo: '', tags: [], free: '', source: '電話', staff: '', customer: null, hits: [],
    };
  }
  function formFrom(r) {
    const c = r.customer || {};
    return {
      date: r.date, start: r.time, end: toTime(toMin(r.time) + r.stayMin), timeLimit: r.timeLimit, resetMin: r.resetMin || 0,
      adultsMin: r.adultsMin, adults: r.adults, kidsMin: r.kidsMin, kids: r.kids, tableIds: [...r.tableIds],
      phone: c.phone || '', phone2: c.phone2 || '', lastKana: c.lastKana || '', firstKana: c.firstKana || '', lastName: c.lastName || '', firstName: c.firstName || '', company: c.company || '',
      courses: r.courses.length ? r.courses.map((x) => ({ ...x })) : [{ courseId: '', count: '' }], memo: r.memo, tags: [...r.tags], free: r.free || '', source: r.source || '', staff: r.staff || '',
      customer: r.customer || null, hits: [],
    };
  }
  function openForm(r, preset) {
    if (S.view !== 'ledger') show('ledger');
    P = { step: 'form', r: r || null, f: r ? formFrom(r) : blankForm(preset || {}) };
    if (P.f.date !== S.date) { S.date = P.f.date; loadDay().catch(fail); }
    $('#panel').hidden = false;
    renderPanel();
    S.lmode = 'time'; S.floor = false;
    renderDayViews();
  }
  function openReservation(r) {
    if (S.view !== 'ledger') { S.date = r.date; show('ledger'); }
    else if (r.date !== S.date) { S.date = r.date; loadDay().catch(fail); }
    P = { step: 'detail', r, f: null };
    $('#panel').hidden = false;
    renderPanel();
    if (S.lmode === 'time') renderTime();
  }

  function renderPanel() {
    if (!P) return;
    const body = $('#pn-body'), foot = $('#pn-foot');
    body.replaceChildren(); foot.replaceChildren();
    $('#pn-title').textContent = jpDate(P.f ? P.f.date : P.r.date);
    if (P.step === 'detail') return panelDetail(body, foot);
    if (P.step === 'confirm') return panelConfirm(body, foot);
    return panelForm(body, foot);
  }

  function fld(label, ...kids) { return h('div', { class: 'fld' }, label ? h('span', { class: 'fl', text: label }) : null, ...kids); }
  function panelForm(body, foot) {
    const f = P.f;
    const bind = (k, el, num) => { el.value = f[k] == null ? '' : f[k]; el.addEventListener('input', () => { f[k] = num ? (el.value === '' ? '' : +el.value) : el.value; }); return el; };
    const sel = (k, opts, onch) => { const el = h('select', null, opts.map(([v, t]) => h('option', { value: v, text: t }))); el.value = f[k]; el.addEventListener('change', () => { f[k] = el.value; if (onch) onch(); }); return el; };
    const reTime = () => { renderTime(); renderPanel(); };
    const startSel = sel('start', timeOptions(f.start).map((t) => [t, t]), () => { if (toMin(f.end) <= toMin(f.start)) f.end = toTime(toMin(f.start) + S.boot.settings.defaultStayMin); reTime(); });
    const endSel = sel('end', timeOptions(f.end).map((t) => [t, t]), reTime);
    const tl = h('input', { type: 'checkbox', checked: f.timeLimit, onchange: (e) => { f.timeLimit = e.target.checked; } });
    const reset = sel('resetMin', [0, 15, 30, 45, 60].map((m) => [m, m + '分']), reTime);
    reset.value = String(f.resetMin);
    const num = (k, ph) => { const el = bind(k, h('input', { type: 'number', min: 0, max: 300, inputmode: 'numeric', placeholder: ph || '' }), true); el.addEventListener('change', () => { if (k === 'adults' && (f.adultsMin === '' || f.adultsMin > f.adults)) f.adultsMin = f.adults; if (k === 'kids' && (f.kidsMin === '' || f.kidsMin > f.kids)) f.kidsMin = f.kids; renderTime(); renderPanel(); }); return el; };
    const n = (+f.adults || 0) + (+f.kids || 0);
    body.append(h('div', { class: 'pn-sec', text: P.r ? '予約の変更' : '基本情報' }),
      fld('時間', h('div', { class: 'pair' }, startSel, h('span', { text: '-' }), endSel), h('label', { class: 'chk' }, tl, '時間制限あり')),
      fld('リセットタイム', reset),
      h('hr', { class: 'thin' }),
      fld('大人', h('div', { class: 'pair' }, num('adultsMin', '最小'), h('span', { text: '-' }), num('adults', '最大'))),
      fld('お子様', h('div', { class: 'pair' }, num('kidsMin'), h('span', { text: '-' }), num('kids')), h('span', { class: 'hint', text: '(お席が必要なお子様)' })),
      h('hr', { class: 'thin' }),
      fld('テーブル', f.tableIds.length ? h('div', { text: (f.tableIds.map((id) => { const t = S.boot.tables.find((x) => x.id === id); return t ? smokeIcon(t) + ' ' + t.name : ''; }).join(', ')) })
        : h('div', { class: 'red', text: '席を選択してください（左の表で、テーブルの枠を押します）' }),
        wide() ? null : tablePicker(),
        h('button', { class: 'addlink', text: '空いているテーブルを自動で選ぶ', onclick: autoPick }), n ? null : h('div', { class: 'red', text: '人数を入れると、定員に合うテーブルが分かります' })));
    // 携帯番号・お名前
    const ph1 = bind('phone', h('input', { type: 'tel', inputmode: 'tel', placeholder: '携帯番号1 (ウォークインは0000)' }));
    ph1.addEventListener('input', () => { if (String(f.phone).replace(/\D/g, '').length >= 4 && !f.customer) findCust(f.phone); });
    const ph2 = bind('phone2', h('input', { type: 'tel', inputmode: 'tel', placeholder: '携帯番号2' }));
    const nameMissing = !String(f.phone).replace(/\D/g, '') && !f.lastName && !f.firstName && !f.lastKana && !f.firstKana && !f.customer;
    body.append(h('hr', { class: 'thin' }),
      fld('携帯番号', h('div', { class: 'with-btn' }, ph1, h('button', { class: 'circle-btn', text: '⌕', 'aria-label': '電話番号で探す', onclick: () => findCust(f.phone) })), h('div', { class: 'with-btn' }, ph2, h('span'))),
      fld('お名前', h('div', { class: 'with-btn' }, h('div', { class: 'two' }, bind('lastKana', h('input', { placeholder: 'せい' })), bind('firstKana', h('input', { placeholder: 'めい' }))),
        h('button', { class: 'circle-btn', text: '⌕', 'aria-label': 'お名前で探す', onclick: () => findCust((f.lastKana + f.firstKana) || (f.lastName + f.firstName)) })),
        h('div', { class: 'two' }, bind('lastName', h('input', { placeholder: '姓' })), bind('firstName', h('input', { placeholder: '名' })))),
      h('div', { class: 'hits', id: 'pn-hits' }),
      nameMissing ? h('div', { class: 'red', text: '携帯番号かお名前を入力してください' }) : null);
    renderHits();
    // 詳細情報
    const courseRows = h('div');
    f.courses.forEach((x, i) => {
      const cs = h('select', null, h('option', { value: '', text: '' }), S.boot.courses.map((k) => h('option', { value: k.id, text: k.name + (k.price ? '（' + yen(k.price) + '）' : '') })));
      cs.value = x.courseId; cs.addEventListener('change', () => { x.courseId = cs.value; });
      const cn = h('input', { type: 'number', min: 0, max: 300, value: x.count, placeholder: '', oninput: (e) => { x.count = e.target.value === '' ? '' : +e.target.value; } });
      courseRows.append(h('div', { class: 'with-btn', style: 'grid-template-columns:1fr 64px auto;margin-bottom:6px' }, cs, cn, h('span', { text: '名' })));
    });
    const tagBox = h('div', { class: 'chips' }, S.boot.resTags.map((g) => h('button', { type: 'button', class: f.tags.includes(g) ? 'on' : '', text: g, onclick: () => { f.tags = f.tags.includes(g) ? f.tags.filter((x) => x !== g) : [...f.tags, g]; renderPanel(); } })));
    body.append(h('hr', { class: 'thin' }), h('div', { class: 'pn-sec', text: '詳細情報' }),
      fld('会社名', bind('company', h('input'))),
      fld('コース', courseRows, S.boot.courses.length ? h('button', { class: 'addlink', text: '⊕ コースを追加', onclick: () => { f.courses.push({ courseId: '', count: '' }); renderPanel(); } }) : h('div', { class: 'hint', text: 'コースは「設定」で登録します' })),
      fld('メモ', bind('memo', h('textarea', { rows: 3 }))),
      fld('予約タグ', tagBox),
      S.boot.free.options.length ? fld(S.boot.free.label, sel('free', [['', ''], ...S.boot.free.options.map((o) => [o, o])])) : null,
      fld('予約経路', sel('source', [['', ''], ...S.boot.sources.map((s) => [s, s])])));
    // 下のボタン
    foot.append(h('div', { class: 'err', id: 'pn-err' }), h('div', { class: 'row2' }, h('button', { class: 'primary-line', text: '予約内容を確認', onclick: toConfirm })));
  }
  // 狭い画面（iPhone・縦のiPad）では入力欄が表を隠すので、入力欄の中でテーブルを選べるようにする
  function tablePicker() {
    const f = P.f, st = toMin(f.start), en = toMin(f.end), n = (+f.adults || 0) + (+f.kids || 0);
    return h('div', { class: 'tchips' }, S.boot.tables.map((t) => {
      const on = f.tableIds.includes(t.id);
      const busy = S.day.some((r) => ACTIVE.has(r.status) && r.id !== (P.r && P.r.id) && r.tableIds.includes(t.id) && st < toMin(r.time) + r.stayMin + (r.resetMin || 0) && toMin(r.time) < en + (+f.resetMin || 0));
      const unfit = n && (n > t.cap || n < (t.min || 1));
      return h('button', { type: 'button', class: (on ? 'on' : '') + (busy ? ' busy' : '') + (unfit ? ' unfit' : ''), title: busy ? 'この時間は別の予約があります' : '',
        text: t.name + ' ' + capText(t), onclick: () => { f.tableIds = on ? f.tableIds.filter((x) => x !== t.id) : [...f.tableIds, t.id]; renderPanel(); renderTime(); } });
    }));
  }
  async function autoPick() {
    const f = P.f, n = (+f.adults || 0) + (+f.kids || 0);
    if (!n) return toast('先に人数を入れてください', true);
    try {
      const a = await api('GET', '/availability?' + qs({ date: f.date, time: f.start, stayMin: toMin(f.end) - toMin(f.start), guests: n, exclude: P.r && P.r.id, resetMin: f.resetMin }));
      if (!a.suggest) return toast('人数に合う空きテーブルがありません', true);
      f.tableIds = [a.suggest]; renderTime(); renderPanel();
    } catch (e) { fail(e); }
  }
  let findTimer;
  function findCust(q) {
    clearTimeout(findTimer);
    findTimer = setTimeout(async () => {
      if (!P || !P.f) return;
      q = String(q || '').trim();
      if (q.replace(/\D/g, '') === C.WALKIN) { P.f.hits = []; renderHits(); return; }
      P.f.hits = q.length >= 2 ? (await api('GET', '/customers?limit=5&q=' + encodeURIComponent(q))).customers : [];
      renderHits();
    }, 200);
  }
  function renderHits() {
    const box = $('#pn-hits'); if (!box || !P || !P.f) return;
    const f = P.f; box.replaceChildren();
    if (String(f.phone).replace(/\D/g, '') === C.WALKIN) box.append(h('div', { class: 'hint', text: 'ウォークイン（お名前を入れなければ、お客様は登録しません）' }));
    if (f.customer) {
      const c = f.customer;
      box.append(h('div', { class: 'hit linked' }, h('b', { text: sama(c) }), h('span', { text: '来店' + c.visits + '回' + (c.last ? '・前回 ' + c.last : '') }),
        c.allergy ? h('span', { class: 'err', text: '⚠' + c.allergy }) : null, c.cancels || c.noshows ? h('span', { class: 'err', text: '取消' + c.cancels + '・No Show' + c.noshows }) : null,
        h('button', { text: '別の方にする', onclick: () => { f.customer = null; renderPanel(); } })));
      return;
    }
    for (const c of f.hits) {
      box.append(h('div', { class: 'hit' }, h('b', { text: sama(c) }), h('span', { text: c.phone }), h('span', { text: '来店' + c.visits + '回' }), c.allergy ? h('span', { class: 'err', text: '⚠' + c.allergy }) : null,
        h('button', { class: 'blue', text: 'この方', onclick: () => { Object.assign(f, { customer: c, phone: c.phone, phone2: c.phone2, lastName: c.lastName, firstName: c.firstName, lastKana: c.lastKana, firstKana: c.firstKana, company: c.company }); f.hits = []; renderPanel(); } })));
    }
  }
  function formBody() {
    const f = P.f;
    return {
      date: f.date, time: f.start, endTime: f.end, timeLimit: f.timeLimit, resetMin: +f.resetMin || 0,
      adults: f.adults === '' ? 0 : +f.adults, adultsMin: f.adultsMin === '' ? '' : +f.adultsMin, kids: +f.kids || 0, kidsMin: f.kidsMin === '' ? '' : +f.kidsMin,
      tableIds: f.tableIds, courses: f.courses.filter((x) => x.courseId), memo: f.memo, tags: f.tags, free: f.free, source: f.source, staff: f.staff,
      status: P.r ? P.r.status : 'booked',
      customerId: f.customer ? f.customer.id : null,
      customer: { phone: f.phone, phone2: f.phone2, lastName: f.lastName, firstName: f.firstName, lastKana: f.lastKana, firstKana: f.firstKana, company: f.company },
    };
  }
  function toConfirm() {
    const f = P.f, err = $('#pn-err');
    const n = (+f.adults || 0) + (+f.kids || 0);
    if (!n) { err.textContent = '人数を入力してください'; return; }
    if (toMin(f.end) <= toMin(f.start)) { err.textContent = '時間を確かめてください（終わりが始まりより前です）'; return; }
    if (!String(f.phone).replace(/\D/g, '') && !f.lastName && !f.firstName && !f.lastKana && !f.firstKana && !f.customer) { err.textContent = '携帯番号かお名前を入力してください（ウォークインは0000）'; return; }
    P.step = 'confirm'; renderPanel(); renderTime();
  }
  function panelConfirm(body, foot) {
    const f = P.f, b = formBody();
    const who = f.customer ? sama(f.customer) : ([f.lastName, f.firstName].filter(Boolean).join(' ') || [f.lastKana, f.firstKana].filter(Boolean).join(' ') || (String(f.phone).replace(/\D/g, '') === C.WALKIN ? 'ウォークイン' : 'お名前なし')) + (f.lastName || f.firstName || f.lastKana || f.firstKana ? ' 様' : '');
    const ln = (ic, ...t) => h('div', { class: 'ln' }, h('i', { text: ic }), h('div', null, ...t));
    body.append(h('div', { class: 'dl' },
      ln('⏰', f.start + ' - ' + f.end + (f.timeLimit ? '（時間制限あり）' : '') + (+f.resetMin ? '　リセット' + f.resetMin + '分' : '')),
      ln('👤', guestsText({ guests: b.adults + b.kids, guestsMin: (b.adultsMin === '' ? b.adults : b.adultsMin) + (b.kidsMin === '' ? b.kids : b.kidsMin) }) + (b.kids ? '（お子様' + b.kids + '名）' : '')),
      ln('▢', tableNames(f.tableIds) || 'ウェイティング（テーブル未定）'),
      h('hr'), ln('☺', who), f.phone ? ln('☎', f.phone + (f.phone2 ? ' / ' + f.phone2 : '')) : null, f.company ? ln('🏢', f.company) : null,
      h('hr'), b.courses.length ? ln('🍽', b.courses.map((x) => courseName(x.courseId) + ' ' + (x.count === '' ? b.adults + b.kids : x.count) + '名').join(', ')) : null,
      f.tags.length ? ln('🏷', f.tags.join(', ')) : null, f.memo ? ln('📝', f.memo) : null, f.free ? ln('◇', S.boot.free.label + '：' + f.free) : null, f.source ? ln('☏', '予約経路：' + f.source) : null));
    const staffSel = h('select', null, h('option', { value: '', text: '(担当者を選んでください)' }), S.boot.staff.map((s) => h('option', { value: s, text: s })), h('option', { value: 'その他', text: 'その他' }));
    staffSel.value = f.staff || '';
    const ok = h('button', { class: 'blue', text: '確定', disabled: S.boot.staff.length && !f.staff, onclick: confirmSave });
    staffSel.addEventListener('change', () => { f.staff = staffSel.value; ok.disabled = S.boot.staff.length && !f.staff; });
    foot.append(fld('担当者', staffSel), h('div', { class: 'row2' }, h('button', { class: 'primary-line', text: '戻る', onclick: () => { P.step = 'form'; renderPanel(); renderTime(); } }), ok));
  }
  async function confirmSave() {
    try {
      const body = formBody();
      const r = await saveChecked(body, P.r && P.r.id, { hoursCheck: true });
      if (!r) return;
      const saved = r.reservation;
      toast(P.r ? '予約を変更しました' : '予約を登録しました（#' + saved.no + '）');
      S.date = saved.date;
      P = { step: 'detail', r: saved, f: null };
      await loadDay();
      const fresh = S.day.find((x) => x.id === saved.id);
      if (fresh) P.r = fresh;
      renderPanel();
    } catch (e) { fail(e); }
  }
  function panelDetail(body, foot) {
    const r = P.r, c = r.customer;
    const ln = (ic, ...t) => h('div', { class: 'ln' }, h('i', { text: ic }), h('div', null, ...t));
    body.append(h('div', { class: 'dl' },
      h('div', { class: 'muted', text: '予約番号 #' + r.no }),
      ln('⏰', r.time + ' - ' + toTime(toMin(r.time) + r.stayMin) + (r.timeLimit ? '（時間制限あり）' : '')),
      ln('👤', guestsText(r) + (r.kids ? '（お子様' + (r.kidsMin !== r.kids ? r.kidsMin + '-' : '') + r.kids + '名）' : '')),
      ln('▢', r.tableIds.length ? r.tableIds.map((id) => { const t = S.boot.tables.find((x) => x.id === id); return t ? smokeIcon(t) + ' ' + t.name : ''; }).join(', ') : 'ウェイティング'),
      h('hr'), ln('☺', h('b', { text: sama(c) }), c ? h('span', { class: 'vbadge', text: c.visits }) : null, isVip(c) ? h('span', { class: 'badge vip', text: 'VIP' }) : null),
      c && c.phone ? ln('☎', c.phone + (c.phone2 ? ' / ' + c.phone2 : '')) : null, c && c.company ? ln('🏢', c.company) : null,
      c && c.allergy ? ln('⚠', h('span', { class: 'err', text: c.allergy })) : null,
      h('hr'), r.tags.length ? ln('🏷', r.tags.join(', ')) : null,
      r.courses.length ? ln('🍽', r.courses.map((x) => courseName(x.courseId) + ' ' + x.count + '名').join(', ')) : null,
      r.memo ? ln('📝', r.memo) : null, r.free ? ln('◇', S.boot.free.label + '：' + r.free) : null, r.source ? ln('☏', '予約経路：' + r.source) : null,
      r.staff ? ln('✎', '担当者：' + r.staff) : null,
      r.flags.length ? ln('!', r.flags.map((f) => h('span', { class: 'badge flag f2', text: f }))) : null));
    const stRow = h('div', { class: 'st-row' });
    for (const [s, label] of [['booked', '予約'], ['seated', '来店'], ['left', '退店'], ['cancel', '予約取消'], ['noshow', 'No Show']]) {
      stRow.append(h('button', { class: r.status === s ? 'on' : '', text: label, onclick: async () => {
        if (r.status === s) return;
        if ((s === 'cancel' || s === 'noshow') && !(await ask(label + 'にします', sama(c) + '\n' + r.time + ' ' + guestsText(r) + '\nこの予約を「' + label + '」にしてよろしいですか？'))) return;
        try { const x = await api('PUT', '/reservations/' + r.id + '/status', { status: s }); P.r = x.reservation; toast(label + 'にしました'); await loadDay(); P.r = S.day.find((y) => y.id === r.id) || x.reservation; renderPanel(); } catch (e) { fail(e); }
      } }));
    }
    body.append(stRow, h('div', { class: 'hist' }, r.history.slice().reverse().map((x) => h('div', { text: stamp(x.t) + ' ' + EV[x.type] + (x.staff ? '（' + x.staff + '）' : '') }))));
    foot.append(h('div', { class: 'row2' },
      h('button', { class: 'danger', text: '削除', onclick: async () => {
        if (!(await ask('予約を削除します', '#' + r.no + ' ' + r.date + ' ' + r.time + ' の予約を削除します。元に戻せません。\nキャンセルの記録を残したい時は「予約取消」を押してください。', { ok: '削除する' }))) return;
        try { await api('DELETE', '/reservations/' + r.id); toast('削除しました'); closePanel(); loadDay().catch(fail); } catch (e) { fail(e); }
      } }),
      h('button', { class: 'primary-line', text: '変更', onclick: () => openForm(r) })));
  }

  // ---------- 予約を検索 ----------
  $('#s-go').addEventListener('click', () => doSearch().catch(fail));
  $('#s-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch().catch(fail); });
  async function renderSearch() { $('#s-q').focus(); if ($('#s-q').value) await doSearch(); }
  async function doSearch() {
    const q = $('#s-q').value.trim();
    const wrap = $('#s-wrap');
    if (!q) { wrap.hidden = true; return; }
    const r = await api('GET', '/search?q=' + encodeURIComponent(q));
    const t = $('#s-table'); t.replaceChildren();
    t.append(h('thead', null, h('tr', null, ['来店日時', 'ご予約者', '人数', 'テーブル', '予約タグ'].map((x) => h('th', { text: x })))));
    const tb = h('tbody');
    for (const x of r.reservations) tb.append(h('tr', { class: 'click', onclick: () => openReservation(x) },
      h('td', { text: jpDate(x.date).replace(/^\d+年/, (y) => y) + ' ' + x.time }), h('td', null, h('b', { class: 'who', text: sama(x.customer) }), x.status !== 'booked' ? h('span', { class: 'pill ' + x.status, text: STATUS[x.status] }) : null),
      h('td', { text: guestsText(x) }), h('td', { text: tableNames(x.tableIds) || 'ウェイティング' }), h('td', null, x.tags.map((g) => h('div', { class: 'badge tag', text: '🏷 ' + g })))));
    if (!r.reservations.length) tb.append(h('tr', null, h('td', { colspan: 5, class: 'muted', text: '見つかりませんでした' })));
    t.append(tb); wrap.hidden = false;
  }

  // ---------- 顧客台帳 ----------
  $$('#c-tabs button').forEach((b) => b.addEventListener('click', () => { S.cTab = b.dataset.tab; S.cEdit = null; renderCustomers().catch(fail); }));
  $('#c-go').addEventListener('click', () => renderCustomers().catch(fail));
  $('#c-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') renderCustomers().catch(fail); });
  let cqTimer;
  $('#c-q').addEventListener('input', () => { clearTimeout(cqTimer); cqTimer = setTimeout(() => renderCustomers().catch(fail), 300); });
  $$('#c-sort button').forEach((b) => b.addEventListener('click', () => {
    const k = b.dataset.sort;
    S.cSort = k === 'kana' ? (S.cSort === 'kana' ? 'kanaDesc' : 'kana') : (S.cSort === 'visits' ? 'visitsAsc' : 'visits');
    renderCustomers().catch(fail);
  }));
  async function renderCustomers() {
    $$('#c-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === S.cTab && !S.cEdit));
    const formMode = S.cTab === 'new' || S.cEdit;
    $('#c-listbox').hidden = !!formMode; $('#c-form').hidden = !formMode;
    $('#c-vt').textContent = S.cEdit ? '顧客の詳細' : S.cTab === 'new' ? '新規顧客' : '顧客台帳';
    if (formMode) return renderCustForm(S.cEdit);
    $$('#c-sort button').forEach((b) => b.classList.toggle('on', S.cSort.startsWith(b.dataset.sort)));
    const r = await api('GET', '/customers?' + qs({ limit: 1000, q: $('#c-q').value, sort: S.cSort, hidden: S.cTab === 'hidden' ? 1 : '' }));
    const t = $('#c-table'); t.replaceChildren();
    t.append(h('thead', null, h('tr', null, h('th', { text: 'お名前' }), h('th', { class: 'num', text: '来店回数' }), h('th', { text: '' }))));
    const tb = h('tbody');
    for (const c of r.customers) tb.append(h('tr', { class: 'click', onclick: () => { S.cEdit = c.id; renderCustomers().catch(fail); } },
      h('td', null, h('b', { text: c.name || c.kana || c.phone || 'お名前なし' }), c.kana && c.name ? h('span', { class: 'muted', text: '　' + c.kana }) : null, isVip(c) ? h('span', { class: 'badge vip', text: 'VIP' }) : null,
        c.tags.filter((x) => !/^vip$/i.test(x)).length ? h('div', { class: 'muted', text: c.tags.filter((x) => !/^vip$/i.test(x)).join('・') }) : null),
      h('td', { class: 'num', text: c.visits }), h('td', { class: 'num' }, h('span', { class: 'link', text: '詳細 ›' }))));
    if (!r.customers.length) tb.append(h('tr', null, h('td', { colspan: 3, class: 'muted', text: S.cTab === 'hidden' ? '非表示のお客様はいません' : r.all ? '見つかりません' : 'お客様はまだいません。予約を入れると自動で登録されます。' })));
    t.append(tb);
  }
  async function renderCustForm(id) {
    const box = $('#c-form'); box.replaceChildren();
    let c = null, history = [];
    if (id) { const r = await api('GET', '/customers/' + id); c = r.customer; history = r.history; }
    const v = (k) => (c ? c[k] || '' : '');
    const inp = (k, ph, type) => h('input', { name: k, value: v(k), placeholder: ph || '', type: type || 'text' });
    let attrs = c ? [...c.tags] : [];
    const chipBox = h('div', { class: 'chips' });
    const drawChips = () => { chipBox.replaceChildren(...[...new Set([...S.boot.custAttrs, ...attrs])].map((g) => h('button', { type: 'button', class: attrs.includes(g) ? 'on' : '', text: g, onclick: () => { attrs = attrs.includes(g) ? attrs.filter((x) => x !== g) : [...attrs, g]; drawChips(); } }))); };
    drawChips();
    const row = (label, ...kids) => h('div', { class: 'cf' }, h('span', { class: 'fl', text: label }), h('div', { class: 'stack' }, ...kids));
    const form = h('form', { class: 'cform', autocomplete: 'off' },
      row('お名前', h('div', { class: 'two' }, inp('lastKana', 'せい'), inp('firstKana', 'めい')), h('div', { class: 'two' }, inp('lastName', '姓'), inp('firstName', '名'))),
      row('携帯番号', inp('phone', '', 'tel'), inp('phone2', '', 'tel')),
      row('会社名', inp('company')),
      row('メモ', h('textarea', { name: 'memo', rows: 5, value: v('memo') })),
      row('お客様属性', chipBox),
      row('アレルギー', inp('allergy')),
      row('記念日', inp('anniv', '例：誕生日 5/3')),
      row('領収書名', inp('receiptName')), row('部署名', inp('dept')), row('役職名', inp('title')),
      row('メールアドレス', inp('email', 'メールアドレス1', 'email'), inp('email2', 'メールアドレス2', 'email')),
      row('Twitter', inp('twitter')), row('Facebook', inp('facebook')),
      row('勤務先住所', inp('workZip', '郵便番号'), inp('workAddr', '住所')),
      row('自宅住所', inp('homeZip', '郵便番号'), inp('homeAddr', '住所')),
      row('特徴', inp('feature')),
      row('', h('label', { class: 'chk' }, h('input', { type: 'checkbox', name: 'hidden', checked: !!(c && c.hidden) }), '非表示にする（ふだんの顧客一覧に出さない）')),
      h('p', { class: 'hint', text: '住所・メール・SNSは、必要な時だけ入れてください（持っている情報が少ないほど、漏れた時の被害が小さくなります）。' }),
      h('p', { class: 'err', id: 'cf-err' }),
      h('div', { class: 'actions' },
        c ? h('button', { type: 'button', class: 'danger', text: 'このお客様の情報を消す', onclick: async () => {
          if (!(await ask('お客様の情報を消します', sama(c) + 'の情報（お名前・電話・メモなど）を消します。元に戻せません。\n予約の記録は「お名前なし」として残ります。', { ok: '消す' }))) return;
          try { await api('DELETE', '/customers/' + c.id); toast('消しました'); S.cEdit = null; S.cTab = 'list'; renderCustomers().catch(fail); } catch (e) { fail(e); }
        } }) : null,
        h('span', { class: 'sep' }),
        h('button', { type: 'button', text: '戻る', onclick: () => { S.cEdit = null; if (S.cTab === 'new') S.cTab = 'list'; renderCustomers().catch(fail); } }),
        c ? h('button', { type: 'button', text: 'この方の予約を入れる', onclick: () => { openForm(null, { date: S.today }); Object.assign(P.f, { customer: c, phone: c.phone, phone2: c.phone2, lastName: c.lastName, firstName: c.firstName, lastKana: c.lastKana, firstKana: c.firstKana, company: c.company }); renderPanel(); } }) : null,
        h('button', { class: 'blue', text: c ? '保存' : '登録' })));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(form), body = { tags: attrs, hidden: fd.get('hidden') === 'on' };
      for (const k of ['lastKana', 'firstKana', 'lastName', 'firstName', 'phone', 'phone2', 'company', 'memo', 'allergy', 'anniv', 'receiptName', 'dept', 'title', 'email', 'email2', 'twitter', 'facebook', 'workZip', 'workAddr', 'homeZip', 'homeAddr', 'feature']) body[k] = fd.get(k) || '';
      try {
        const r = await api(c ? 'PUT' : 'POST', '/customers' + (c ? '/' + c.id : ''), body);
        toast(c ? '保存しました' : '登録しました'); S.cEdit = r.customer.id; S.cTab = r.customer.hidden ? 'hidden' : 'list'; renderCustomers().catch(fail);
      } catch (err) { $('#cf-err').textContent = err.message; }
    });
    box.append(form);
    if (c) {
      box.append(h('div', { class: 'card', style: 'max-width:760px;margin-top:12px' }, h('h3', { text: '来店の履歴（来店 ' + c.visits + '回・予約取消 ' + c.cancels + '回・No Show ' + c.noshows + '回）' }),
        h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' }, h('thead', null, h('tr', null, ['来店日時', '人数', 'テーブル', 'コース', '状態'].map((x) => h('th', { text: x })))),
          h('tbody', null, history.length ? history.map((r) => h('tr', { class: 'click', onclick: () => openReservation({ ...r, customer: c, flags: r.flags || [] }) }, h('td', { text: mdw(r.date) + ' ' + r.time }), h('td', { text: guestsText(r) }), h('td', { text: tableNames(r.tableIds) || 'ウェイティング' }), h('td', { text: r.courses.map((x) => courseName(x.courseId)).join(', ') }), h('td', null, h('span', { class: 'pill ' + r.status, text: STATUS[r.status] }))))
            : h('tr', null, h('td', { colspan: 5, class: 'muted', text: '予約の記録はまだありません' })))))));
    }
  }

  // ---------- 分析 ----------
  $$('#a-tabs button').forEach((b) => b.addEventListener('click', () => { S.aTab = b.dataset.tab; renderAnalytics().catch(fail); }));
  function niceMax(v) { if (v <= 5) return 5; const p = Math.pow(10, Math.floor(Math.log10(v))); for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p; return v; }
  // 棒（組数）と線（人数）のグラフ。stacked＝積み上げ、percent＝100%積み上げ
  function chart(o) {
    const labels = o.labels, bars = o.series.filter((s) => s.type !== 'line'), lines = o.series.filter((s) => s.type === 'line');
    const many = labels.length > 12;
    const W = Math.max(560, labels.length * (many ? 26 : 60) + 90), H = o.height || 240, padL = 44, padR = lines.length ? 44 : 16, padT = 12, padB = many ? 58 : 30;
    const iw = W - padL - padR, ih = H - padT - padB;
    let maxL = 0;
    labels.forEach((_, i) => { const vals = bars.map((s) => s.values[i] || 0); maxL = Math.max(maxL, o.stacked ? vals.reduce((a, b) => a + b, 0) : Math.max(0, ...vals)); });
    maxL = o.percent ? 100 : niceMax(maxL);
    const maxR = niceMax(Math.max(0, ...lines.flatMap((s) => s.values)));
    const g = sv('svg', { width: W, height: H, viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': o.title || 'グラフ' });
    for (let k = 0; k <= 5; k++) {
      const y = padT + ih - (ih * k) / 5;
      g.append(sv('line', { x1: padL, x2: W - padR, y1: y, y2: y, stroke: '#e5e7eb' }));
      g.append(sv('text', { x: padL - 6, y: y + 3, 'text-anchor': 'end', 'font-size': 10, fill: '#6b7280' }, (o.percent ? Math.round(maxL * k / 5) + '%' : Math.round((maxL * k / 5) * 10) / 10 + (o.unitL || '組'))));
      if (lines.length) g.append(sv('text', { x: W - padR + 6, y: y + 3, 'font-size': 10, fill: '#6b7280' }, Math.round((maxR * k / 5) * 10) / 10 + (o.unitR || '名')));
    }
    const band = iw / labels.length;
    labels.forEach((lab, i) => {
      const cx = padL + band * i + band / 2;
      let acc = 0;
      const sum = bars.reduce((a, s) => a + (s.values[i] || 0), 0);
      bars.forEach((s, j) => {
        let v = s.values[i] || 0;
        if (o.percent) v = sum ? (v / sum) * 100 : 0;
        const bw = o.stacked ? Math.min(30, band * 0.6) : Math.min(22, (band * 0.7) / bars.length);
        const x = o.stacked ? cx - bw / 2 : cx - (bw * bars.length) / 2 + bw * j;
        const bh = maxL ? (v / maxL) * ih : 0;
        const y = padT + ih - (o.stacked ? acc + bh : bh);
        if (bh > 0) g.append(sv('rect', { x, y, width: bw, height: bh, fill: s.color }));
        if (o.stacked) acc += bh;
      });
      const tx = sv('text', { x: cx, y: padT + ih + 14, 'font-size': 10, fill: '#4b5563', 'text-anchor': many ? 'end' : 'middle' }, lab);
      if (many) tx.setAttribute('transform', 'rotate(-45 ' + cx + ' ' + (padT + ih + 14) + ')');
      g.append(tx);
    });
    for (const s of lines) {
      const pts = s.values.map((v, i) => (padL + band * i + band / 2) + ',' + (padT + ih - (maxR ? (v / maxR) * ih : 0)));
      g.append(sv('polyline', { points: pts.join(' '), fill: 'none', stroke: s.color, 'stroke-width': 1.5 }));
      pts.forEach((p) => { const [x, y] = p.split(','); g.append(sv('circle', { cx: x, cy: y, r: 3, fill: s.color })); });
    }
    return h('div', { class: 'card' }, o.title ? h('h3', { text: o.title }) : null, h('div', { class: 'chart' }, g),
      h('div', { class: 'legend' }, o.series.map((s) => h('span', null, h('i', { style: 'background:' + s.color }), s.name))));
  }
  function pie(title, rows, key) {
    const total = rows.reduce((a, r) => a + r[key], 0);
    let acc = 0;
    const stops = rows.map((r, i) => { const a = acc; acc += total ? (r[key] / total) * 360 : 0; return COLORS[i % COLORS.length] + ' ' + a + 'deg ' + acc + 'deg'; });
    const p = total ? h('div', { class: 'pie', style: 'background:conic-gradient(' + stops.join(',') + ')' }) : h('div', { class: 'pie empty', text: 'データがありません' });
    return h('div', { class: 'card' }, h('h3', { text: title }), h('div', { class: 'pie-wrap' }, p,
      h('div', { class: 'legend' }, rows.map((r, i) => h('span', null, h('i', { style: 'background:' + COLORS[i % COLORS.length] }), r.name)))));
  }
  function table(head, rows, opt) {
    return h('div', { class: 'table-wrap' + (opt && opt.flat ? '' : ''), style: 'border:none' }, h('table', { class: 'tbl' }, h('thead', null, h('tr', null, head.map((x, i) => h('th', { class: i && !(opt && opt.left) ? 'num' : '', text: x })))),
      h('tbody', null, rows.map((r) => h('tr', { class: r.total ? 'total' : '' }, r.cells.map((x, i) => h('td', { class: i && !(opt && opt.left) ? 'num' : '' }, x)))))));
  }
  function ymSelects(ym, onApply, label) {
    const ysel = h('select', null, [-2, -1, 0, 1].map((n) => { const y = +S.today.slice(0, 4) + n; return h('option', { value: y, text: y }); }));
    const msel = h('select', null, Array.from({ length: 12 }, (_, i) => h('option', { value: i + 1, text: i + 1 })));
    ysel.value = +ym.slice(0, 4); msel.value = +ym.slice(5, 7);
    return [label ? h('span', { text: label }) : null, ysel, h('span', { text: '年' }), msel, h('span', { text: '月' }), { ysel, msel, onApply }];
  }
  function applyBtn(fn) { return h('button', { class: 'blue', text: '適用', onclick: fn }); }
  const pct = (a, b) => (b ? (Math.round((a / b) * 1000) / 10).toFixed(1) : 'NaN') + '%';
  const now = () => h('div', { class: 'updated', text: '更新日時: ' + new Date().toLocaleString('ja-JP') });

  async function renderAnalytics() {
    $$('#a-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === S.aTab));
    const box = $('#a-body'); box.replaceChildren();
    const ap = S.ap, ymNow = S.today.slice(0, 7);
    const t = S.aTab;
    if (t === 'top') {
      const p = ap.top || (ap.top = { week: 0 });
      const r = await api('GET', '/analytics?' + qs({ kind: 'top', week: p.week, today: S.today }));
      const wl = ['先週', '今週', '来週'], ml = ['先月', '今月', '来月'];
      box.append(h('div', { class: 'cards2' },
        h('div', { class: 'card' }, table(['週の予約', '組数', '人数'], r.weeks.map((w, i) => ({ cells: [wl[i] + ' (' + mdw(w.from).replace(/\(.\)/, '') + ' - ' + mdw(w.to).replace(/\(.\)/, '') + ')', w.groups, w.guests] })))),
        h('div', { class: 'card' }, table(['月の予約', '組数', '人数'], r.months.map((m, i) => ({ cells: [ml[i] + ' (' + ymLabel(m.ym) + ')', m.groups, m.guests] }))))),
      chart({ title: '予約状況 (本日を中心とした前後7日分)', labels: r.days.map((d) => mdw(d.date).replace(/\(.\)/, '')), series: [{ name: '組数', color: '#8cc63f', values: r.days.map((d) => d.groups) }, { name: '人数', type: 'line', color: '#9ca3af', values: r.days.map((d) => d.guests) }] }));
      const wk = h('div', { class: 'opts' }, ['先週', '今週', '来週', '再来週'].map((l, i) => h('label', null, h('input', { type: 'radio', name: 'cw', checked: p.week === i - 1, onchange: () => { p.week = i - 1; renderAnalytics().catch(fail); } }), l)));
      const c = r.course;
      box.append(h('div', { class: 'card' }, h('h3', { text: 'コース注文状況', style: 'font-size:18px;font-weight:700' }), wk,
        table(['コース名', ...c.days.map((d) => mdw(d).replace(/\(.\)/, '')), '合計'], [
          ...c.rows.map((x) => ({ cells: [x.name + ' (' + yen(x.price) + ')', ...x.days, x.days.reduce((a, b) => a + b, 0)] })),
          { total: true, cells: ['合計', ...c.days.map((_, i) => c.rows.reduce((a, x) => a + x.days[i], 0)), c.rows.reduce((a, x) => a + x.days.reduce((p2, q2) => p2 + q2, 0), 0)] },
          { cells: ['(当日の予約人数)', ...c.dayGuests.map((g) => '(' + g + ')'), '(' + c.dayGuests.reduce((a, b) => a + b, 0) + ')'] }]),
        c.rows.length ? null : h('p', { class: 'hint', text: 'コースは「設定」で登録します' })), now());
      return;
    }
    if (t === 'counts') {
      const p = ap.counts || (ap.counts = { mode: 'day', basis: 'visit', year: +ymNow.slice(0, 4), month: +ymNow.slice(5, 7) });
      const r = await api('GET', '/analytics?' + qs({ kind: 'counts', ...p, today: S.today }));
      const radio = (name, val, label, key) => h('label', null, h('input', { type: 'radio', name, checked: p[key] === val, onchange: () => { p[key] = val; renderAnalytics().catch(fail); } }), label);
      const [ys] = [ymSelects(p.year + '-' + pad(p.month))];
      const ctl = ys.pop();
      box.append(h('div', { class: 'card' },
        h('div', { class: 'opts' }, h('span', { text: '集計の種類:' }), radio('cm', 'day', '日別', 'mode'), radio('cm', 'month', '月別', 'mode'), radio('cm', 'hour', '時間帯別', 'mode'), radio('cm', 'weekday', '曜日別', 'mode'), radio('cm', 'lead', '何日前に予約しているか', 'mode')),
        h('div', { class: 'opts' }, h('span', { text: '対象とする日時:' }), radio('cb', 'visit', '来店日時', 'basis'), radio('cb', 'accept', '受付日時', 'basis')),
        h('div', { class: 'opts' }, ...ys, applyBtn(() => { p.year = +ctl.ysel.value; p.month = +ctl.msel.value; renderAnalytics().catch(fail); }))),
      chart({ title: '予約数', labels: r.rows.map((x) => x.label), series: [{ name: '組数', color: '#8cc63f', values: r.rows.map((x) => x.groups) }, { name: '人数', type: 'line', color: '#9ca3af', values: r.rows.map((x) => x.guests) }] }),
      h('div', { class: 'card' }, table([p.mode === 'day' ? '日付' : p.mode === 'month' ? '月' : p.mode === 'hour' ? '時間帯' : p.mode === 'weekday' ? '曜日' : '何日前', '組数', '人数'], [...r.rows.map((x) => ({ cells: [x.label, x.groups, x.guests] })), { total: true, cells: ['合計', r.rows.reduce((a, x) => a + x.groups, 0), r.rows.reduce((a, x) => a + x.guests, 0)] }])), now());
      return;
    }
    if (t === 'sources' || t === 'cancels') {
      const p = ap[t] || (ap[t] = { from: C.ymAdd(ymNow, -5), to: ymNow });
      const r = await api('GET', '/analytics?' + qs({ kind: t, from: p.from, to: p.to, today: S.today }));
      const a = ymSelects(p.from), ac = a.pop(), b = ymSelects(p.to), bc = b.pop();
      box.append(h('div', { class: 'card' },
        t === 'sources' ? h('div', { class: 'opts' }, h('label', null, h('input', { type: 'radio', checked: true }), '予約経路（月別）'), h('label', null, h('input', { type: 'radio', disabled: true }), '予約経路（全店舗）')) : null,
        h('div', { class: 'opts' }, ...a, h('span', { text: '-' }), ...b, applyBtn(() => { p.from = ac.ysel.value + '-' + pad(ac.msel.value); p.to = bc.ysel.value + '-' + pad(bc.msel.value); renderAnalytics().catch(fail); }), h('span', { class: 'hint', text: '※最長13ヶ月まで期間指定が可能' }))));
      if (t === 'sources') {
        const srcs = r.sources;
        box.append(chart({ title: '予約経路', stacked: true, labels: r.rows.map((x) => ymLabel(x.ym)), series: srcs.map((s, i) => ({ name: s, color: COLORS[i], values: r.rows.map((x) => x.by[s].groups) })) }));
        const rows = [];
        const cell = (v, tot) => v + ' 組 (' + pct(v, tot) + ')';
        for (const x of r.rows) { rows.push({ cells: [ymLabel(x.ym), ...srcs.map((s) => cell(x.by[s].groups, x.total.groups)), x.total.groups + ' 組'] }); rows.push({ cells: ['', ...srcs.map((s) => x.by[s].guests + ' 名 (' + pct(x.by[s].guests, x.total.guests) + ')'), x.total.guests + ' 名'] }); }
        const tg = r.rows.reduce((q2, x) => q2 + x.total.groups, 0), tp = r.rows.reduce((q2, x) => q2 + x.total.guests, 0);
        rows.push({ total: true, cells: ['合計', ...srcs.map((s) => cell(r.rows.reduce((q2, x) => q2 + x.by[s].groups, 0), tg)), tg + ' 組'] });
        rows.push({ total: true, cells: ['', ...srcs.map((s) => r.rows.reduce((q2, x) => q2 + x.by[s].guests, 0) + ' 名 (' + pct(r.rows.reduce((q2, x) => q2 + x.by[s].guests, 0), tp) + ')'), tp + ' 名'] });
        box.append(h('div', { class: 'card' }, table(['日付', ...srcs, '合計'], rows)), now());
      } else {
        box.append(chart({ title: 'キャンセル', stacked: true, labels: r.rows.map((x) => ymLabel(x.ym)), series: [{ name: '予約取消', color: '#e8562a', values: r.rows.map((x) => x.cancel.groups) }, { name: 'No Show', color: '#f08080', values: r.rows.map((x) => x.noshow.groups) }, { name: 'ウェブ取消', color: '#f9c0cb', values: r.rows.map((x) => x.web.groups) }, { name: 'キャンセル率', type: 'line', color: '#374151', values: r.rows.map((x) => (x.all.groups ? (x.total.groups / x.all.groups) * 100 : 0)) }], unitR: '%' }));
        const rows = [];
        const sum = (k, f2) => r.rows.reduce((q2, x) => q2 + x[k][f2], 0);
        for (const x of r.rows) {
          rows.push({ cells: [ymLabel(x.ym), x.cancel.groups + ' 組 (' + pct(x.cancel.groups, x.all.groups) + ')', x.noshow.groups + ' 組 (' + pct(x.noshow.groups, x.all.groups) + ')', '0 組 (' + pct(0, x.all.groups) + ')', x.total.groups + ' 組', pct(x.total.groups, x.all.groups)] });
          rows.push({ cells: ['', x.cancel.guests + ' 名 (' + pct(x.cancel.guests, x.all.guests) + ')', x.noshow.guests + ' 名 (' + pct(x.noshow.guests, x.all.guests) + ')', '0 名 (' + pct(0, x.all.guests) + ')', x.total.guests + ' 名', pct(x.total.guests, x.all.guests)] });
        }
        rows.push({ total: true, cells: ['合計', sum('cancel', 'groups') + ' 組 (' + pct(sum('cancel', 'groups'), sum('all', 'groups')) + ')', sum('noshow', 'groups') + ' 組 (' + pct(sum('noshow', 'groups'), sum('all', 'groups')) + ')', '0 組', sum('total', 'groups') + ' 組', pct(sum('total', 'groups'), sum('all', 'groups'))] });
        box.append(h('div', { class: 'card' }, table(['日付', '予約取消', 'No Show', 'ウェブ取消', '合計', 'キャンセル率'], rows)), now());
      }
      return;
    }
    if (t === 'visits') {
      const p = ap.visits || (ap.visits = { months: 6, pct: true });
      const r = await api('GET', '/analytics?' + qs({ kind: 'visits', months: p.months, today: S.today }));
      box.append(h('div', { class: 'card' },
        h('div', { class: 'opts' }, h('label', null, h('input', { type: 'radio', name: 'vm', checked: p.months === 6, onchange: () => { p.months = 6; } }), '6ヶ月'), h('label', null, h('input', { type: 'radio', name: 'vm', checked: p.months === 13, onchange: () => { p.months = 13; } }), '13ヶ月'), applyBtn(() => renderAnalytics().catch(fail))),
        h('div', { class: 'opts' }, h('label', null, h('input', { type: 'radio', name: 'vp', checked: p.pct, onchange: () => { p.pct = true; renderAnalytics().catch(fail); } }), '100%積み上げ縦棒'), h('label', null, h('input', { type: 'radio', name: 'vp', checked: !p.pct, onchange: () => { p.pct = false; renderAnalytics().catch(fail); } }), '積み上げ縦棒 (実数)'))),
      chart({ title: '来店回数', stacked: true, percent: p.pct, unitL: '組', labels: r.rows.map((x) => ymLabel(x.ym)), series: ['1回目', '2回目', '3回目', '4回目以上'].map((n, i) => ({ name: n, color: ['#fde9b0', '#f5c242', '#f59e0b', '#e8562a'][i], values: r.rows.map((x) => x.counts[i]) })) }),
      h('div', { class: 'card' }, table(['日付', '1回目', '2回目', '3回目', '4回目以上'], [...r.rows.map((x) => ({ cells: [ymLabel(x.ym), ...x.counts] })), { total: true, cells: ['合計', ...[0, 1, 2, 3].map((i) => r.rows.reduce((a, x) => a + x.counts[i], 0))] }])),
      h('p', { class: 'hint', text: '状態を「来店」「退店」にした予約を、お客様ごとに何回目の来店かで数えます。お名前のない予約は入りません。' }), now());
      return;
    }
    if (['staff', 'course', 'free', 'tags'].includes(t)) {
      const p = ap[t] || (ap[t] = { ym: ymNow });
      const r = await api('GET', '/analytics?' + qs({ kind: t, ym: p.ym, today: S.today }));
      const a = ymSelects(p.ym), ac = a.pop();
      const title = { staff: '担当者', course: 'コース', free: S.boot.free.label, tags: '予約タグ' }[t];
      box.append(h('div', { class: 'card' }, h('div', { class: 'opts' }, ...a, applyBtn(() => { p.ym = ac.ysel.value + '-' + pad(ac.msel.value); renderAnalytics().catch(fail); }))));
      const key = t === 'course' ? 'guests' : 'groups';
      box.append(pie(title, r.rows, key));
      if (t === 'course') box.append(h('div', { class: 'card' }, table(['#', '名前', '人数', '金額'], [...r.rows.map((x, i) => ({ cells: [i + 1, x.name, x.guests, yen(x.amount)] })), { total: true, cells: ['', '合計', r.rows.reduce((q2, x) => q2 + x.guests, 0), yen(r.rows.reduce((q2, x) => q2 + x.amount, 0))] }], { left: true })));
      else if (t === 'free') box.append(h('div', { class: 'card' }, table(['#', '名前', '組数', '人数'], r.rows.map((x, i) => ({ cells: [i + 1, x.name, x.groups, x.guests] })), { left: true }), S.boot.free.options.length ? null : h('p', { class: 'hint', text: '自由設定欄の選択肢は「設定」で決めます' })));
      else box.append(h('div', { class: 'card' }, table(['#', '名前', '組数'], r.rows.map((x, i) => ({ cells: [i + 1, x.name, x.groups] })), { left: true })));
      box.append(now());
      return;
    }
    if (t === 'params') {
      const a = ymSelects(ymNow); a.pop();
      box.append(h('div', { class: 'card' }, h('div', { class: 'opts' }, h('span', { text: '対象とする日時:' }), h('label', null, h('input', { type: 'radio', checked: true }), '来店日時'), h('label', null, h('input', { type: 'radio' }), '受付日時')), h('div', { class: 'opts' }, ...a, applyBtn(() => {}))),
        pie('カスタムパラメーター', [], 'groups'),
        h('div', { class: 'card' }, table(['#', '名前', '組数', '人数'], [{ total: true, cells: ['', '合計', 0, 0] }], { left: true }),
          h('p', { class: 'hint', text: 'カスタムパラメーターは、ネット予約（ウェブ予約）がどこから来たかを数える機能です。ネット予約にはインターネット上の受け口が要るため、この台帳ではまだ使えません（手順書「インターネットの受け口が要る機能」を参照）。' })), now());
    }
  }

  // ---------- 印刷マネージャー ----------
  $$('#p-tabs button').forEach((b) => b.addEventListener('click', () => { S.pTab = b.dataset.tab; renderPrint().catch(fail); }));
  async function renderPrint() {
    $$('#p-tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === S.pTab));
    const box = $('#p-form'); box.replaceChildren();
    const date = h('input', { type: 'date', value: S.printDate || S.date || S.today });
    const hours = Array.from({ length: 30 }, (_, i) => i);
    const from = h('select', null, hours.map((x) => h('option', { value: x, text: x + '時から' }))), to = h('select', null, hours.map((x) => h('option', { value: x + 1, text: (x + 1) + '時まで' })));
    from.value = Math.floor(toMin(S.boot.settings.lunchEnd) / 60); to.value = 24;
    const paper = h('select', null, ['A4・タテ', 'A4・ヨコ'].map((x) => h('option', { value: x, text: x })));
    const ck = (label, on) => h('label', { class: 'chk' }, h('input', { type: 'checkbox', checked: on !== false, 'data-k': label }), label);
    const checks = S.pTab === 'list'
      ? ['本日の情報', 'ご予約者様名の表示は漢字を優先', 'VIP/要注意マーク', '会社名', '来店回数', '電話番号', 'お客様属性', 'コースとお客様のアレルギー情報', '予約タグ', '自由設定欄', '予約メモ', '受付情報', '書き込み用の空白行', 'コースの集計ページ']
      : ['本日の情報', 'ご予約者様名の表示は漢字を優先', '来店回数', '予約タグ'];
    box.append(h('p', { text: '印刷したい日時、用紙レイアウト、表示オプションを選択し「印刷用PDFを出力」ボタンを押してください。（印刷の画面で「PDFとして保存」も選べます）' }),
      h('div', { class: 'row' }, h('select', { disabled: true }, h('option', { text: S.boot.settings.storeName || 'この店舗' })), date),
      h('div', { class: 'row' }, from, to, paper),
      h('div', { class: 'checks' }, checks.map((x) => ck(x))),
      h('div', null, h('button', { class: 'primary', text: '印刷用PDFを出力', onclick: async () => {
        const opt = {}; $$('input[data-k]', box).forEach((c) => { opt[c.dataset.k] = c.checked; });
        try { await buildPrint(date.value, +from.value, +to.value, paper.value, opt); window.print(); } catch (e) { fail(e); }
      } })));
  }
  async function buildPrint(date, fromH, toH, paper, opt) {
    const r = await api('GET', '/reservations?from=' + date + '&to=' + date);
    const list = r.reservations.filter((x) => ACTIVE.has(x.status) && toMin(x.time) >= fromH * 60 && toMin(x.time) < toH * 60);
    const area = $('#print-area'); area.replaceChildren();
    const nm = (c) => (c ? (opt['ご予約者様名の表示は漢字を優先'] ? c.name || c.kana : c.kana || c.name) || c.phone : 'お名前なし');
    const head = h('div', null, h('h1', { text: (S.boot.settings.storeName || '予約台帳') + '　' + jpDate(date) + '　' + fromH + '時〜' + toH + '時（' + list.length + '組 ' + list.reduce((a, x) => a + x.guests, 0) + '名）' }),
      opt['本日の情報'] && r.info ? h('p', { text: '本日の情報：' + r.info }) : null);
    const sheet = h('div', { class: 'pg' }, head);
    if (S.pTab === 'list') {
      const cols = ['時間', 'ご予約者', '人数', 'テーブル'];
      if (opt['来店回数']) cols.push('来店'); if (opt['電話番号']) cols.push('電話'); if (opt['会社名']) cols.push('会社名'); if (opt['お客様属性']) cols.push('お客様属性');
      if (opt['コースとお客様のアレルギー情報']) cols.push('コース・アレルギー'); if (opt['予約タグ']) cols.push('予約タグ'); if (opt['自由設定欄']) cols.push(S.boot.free.label); if (opt['予約メモ']) cols.push('メモ'); if (opt['受付情報']) cols.push('受付');
      const rows = list.map((x) => {
        const c = x.customer, cells = [x.time + '-' + toTime(toMin(x.time) + x.stayMin), (opt['VIP/要注意マーク'] && c && c.tags.some((t) => /^(vip|要注意)$/i.test(t)) ? '★' : '') + nm(c) + ' 様', guestsText(x), tableNames(x.tableIds) || '未定'];
        if (opt['来店回数']) cells.push(c ? c.visits : ''); if (opt['電話番号']) cells.push(c ? c.phone : ''); if (opt['会社名']) cells.push(c ? c.company : ''); if (opt['お客様属性']) cells.push(c ? c.tags.join('・') : '');
        if (opt['コースとお客様のアレルギー情報']) cells.push(x.courses.map((k) => courseName(k.courseId) + '×' + k.count).join(', ') + (c && c.allergy ? ' ⚠' + c.allergy : '')); if (opt['予約タグ']) cells.push(x.tags.join('・'));
        if (opt['自由設定欄']) cells.push(x.free); if (opt['予約メモ']) cells.push(x.memo); if (opt['受付情報']) cells.push(stamp(x.createdAt) + (x.staff ? ' ' + x.staff : ''));
        return cells;
      });
      if (opt['書き込み用の空白行']) for (let i = 0; i < 5; i++) rows.push(cols.map(() => ' '));
      sheet.append(h('table', null, h('thead', null, h('tr', null, cols.map((x) => h('th', { text: x })))), h('tbody', null, rows.map((cells) => h('tr', null, cells.map((x) => h('td', { text: x })))))));
      area.append(sheet);
      if (opt['コースの集計ページ']) {
        const sum = new Map();
        for (const x of list) for (const k of x.courses) sum.set(k.courseId, (sum.get(k.courseId) || 0) + k.count);
        area.append(h('div', { class: 'pg' }, h('h1', { text: 'コースの集計　' + jpDate(date) }), h('table', null, h('thead', null, h('tr', null, h('th', { text: 'コース' }), h('th', { text: '人数' }))),
          h('tbody', null, sum.size ? [...sum].map(([id, n]) => h('tr', null, h('td', { text: courseName(id) }), h('td', { text: n }))) : h('tr', null, h('td', { colspan: 2, text: 'コースの予約はありません' }))))));
      }
    } else {
      const hrs = []; for (let x = fromH; x < toH; x++) hrs.push(x);
      const tableEl = h('table', null, h('thead', null, h('tr', null, h('th', { text: 'テーブル' }), hrs.map((x) => h('th', { colspan: 2, text: x + ':00' })))));
      const tb = h('tbody');
      for (const t of S.boot.tables) {
        const tr = h('tr', null, h('td', { text: t.name + '（' + capText(t) + '）' }));
        const mine = list.filter((x) => x.tableIds.includes(t.id)).sort((a, b) => a.time.localeCompare(b.time));
        let slot = fromH * 2;
        for (const x of mine) {
          const st = Math.max(fromH * 2, Math.floor(toMin(x.time) / 30)), en = Math.min(toH * 2, Math.ceil((toMin(x.time) + x.stayMin) / 30));
          if (st < slot || en <= st) continue;
          for (; slot < st; slot++) tr.append(h('td'));
          tr.append(h('td', { colspan: en - st, style: 'background:#ddd', text: x.time + ' ' + nm(x.customer) + ' 様 ' + guestsText(x) + (opt['来店回数'] && x.customer ? '(' + x.customer.visits + ')' : '') + (opt['予約タグ'] && x.tags.length ? ' ' + x.tags.join('・') : '') }));
          slot = en;
        }
        for (; slot < toH * 2; slot++) tr.append(h('td'));
        tb.append(tr);
      }
      tableEl.append(tb); sheet.append(tableEl); area.append(sheet);
    }
    let pg = document.getElementById('page-size');
    if (pg) pg.remove();
    // 用紙の向き（CSPでstyle要素を足せないため、印刷の向きは印刷の画面で選んでもらう）
    if (paper === 'A4・ヨコ') toast('印刷の画面で「横」を選んでください');
    L._log('印刷', date); persist().catch(() => {});
  }

  // ---------- CSVダウンロード ----------
  async function renderCsv() {
    const box = $('#csv-body'); box.replaceChildren();
    const y = h('select', null, [-1, 0, 1].map((n) => { const v = +S.today.slice(0, 4) + n; return h('option', { value: v, text: v }); }));
    const m = h('select', null, Array.from({ length: 12 }, (_, i) => h('option', { value: i + 1, text: i + 1 })));
    const d = h('select', null, Array.from({ length: 31 }, (_, i) => h('option', { value: i + 1, text: i + 1 })));
    y.value = +S.today.slice(0, 4); m.value = +S.today.slice(5, 7); d.value = +S.today.slice(8, 10);
    const dl = async (from, to, name) => {
      try {
        if (!(await ask('CSVを書き出します', 'このファイルには、お客様のお名前・電話番号が入ります。\nこの端末やお店のパソコンの中だけで使い、メールやAIなど外のサービスには送らないでください。', { ok: '書き出す' }))) return;
        const csv = L.reservationsCsv(from, to); await persist();
        const r = await shareOrDownload(name, new Blob([csv], { type: 'text/csv' }));
        if (r !== 'aborted') toast('書き出しました');
      } catch (e) { fail(e); }
    };
    const months = [];
    for (let i = -11; i <= 3; i++) months.push(C.ymAdd(S.today.slice(0, 7), i));
    const lastUpd = (ym) => { const xs = L.db.reservations.filter((r) => r.date.startsWith(ym)).map((r) => r.updatedAt).sort(); return xs.length ? new Date(xs[xs.length - 1]).toLocaleString('ja-JP') : '—'; };
    box.append(h('div', { class: 'csv-sec' }, h('h3', { text: '店舗、日別を指定してダウンロード' }),
      h('div', { class: 'opts' }, h('select', { disabled: true }, h('option', { text: S.boot.settings.storeName || 'この店舗' })), y, h('span', { text: '年' }), m, h('span', { text: '月' }), d, h('span', { text: '日' }),
        h('button', { class: 'primary', text: 'ダウンロード', onclick: () => { const s = y.value + '-' + pad(m.value) + '-' + pad(d.value); if (!C.isDate(s)) return toast('日付が正しくありません', true); dl(s, s, '予約_' + s + '.csv'); } }))),
    h('div', { class: 'csv-sec' }, h('h3', { text: '月別データをダウンロード' }),
      h('div', { class: 'table-wrap' }, h('table', { class: 'tbl' }, h('thead', null, h('tr', null, ['ファイル名', '更新日', ''].map((x) => h('th', { text: x })))),
        h('tbody', null, months.reverse().map((ym) => h('tr', null, h('td', { text: ym.replace('-', '_') + '.csv' }), h('td', { text: lastUpd(ym) }),
          h('td', null, h('button', { class: 'primary', text: 'ダウンロード', onclick: () => dl(ym + '-01', C.addDays(C.ymAdd(ym, 1) + '-01', -1), ym.replace('-', '_') + '.csv') })))))))),
    h('div', { class: 'csv-sec' }, h('h3', { text: 'レジ連携用CSV（お名前・電話番号は入りません）' }), h('p', { class: 'hint', text: 'レジ（POS）のデータと突き合わせて、お客様ごとの注文の傾向を分析する時に使います。' }),
      (() => { const a = h('input', { type: 'date', value: S.today.slice(0, 8) + '01' }), b = h('input', { type: 'date', value: S.today }); return h('div', { class: 'opts' }, a, h('span', { text: '〜' }), b, h('button', { text: '書き出す', onclick: async () => { try { const csv = L.posLinkCsv(a.value, b.value); await persist(); const r = await shareOrDownload('レジ連携用_' + a.value + '_' + b.value + '.csv', new Blob([csv], { type: 'text/csv' })); if (r !== 'aborted') toast('書き出しました'); } catch (e) { fail(e); } } })); })()));
  }

  // ---------- ウェブ予約ウィジェット（インターネット上の受け口が要るため、まだ使えない） ----------
  async function renderWidget() {
    $('#widget-body').replaceChildren(h('div', { class: 'csv-sec' },
      h('p', { text: 'お店のホームページやGoogleマップに「ウェブ予約」の窓口を置く機能です。' }),
      h('p', { text: 'お客様のスマホから予約を受けるには、インターネット上に受け口（予約を受け取って、iPadへ暗号化して届ける場所）が必要です。この台帳はお客様の情報をiPadの外に置かない作りのため、受け口を用意するまで、この機能は使えません。' }),
      h('p', { class: 'hint', text: '受け口の作り方・守り方・費用・手順は、手順書「インターネットの受け口が要る機能」（予約台帳のフォルダの「2026-11-25_手順書_インターネットの受け口が要る機能.md」）にまとめています。' }),
      h('div', { class: 'pie empty', style: 'width:280px;height:200px;border-radius:6px', text: 'ウィジェットのプレビュー（準備中）' })));
  }

  // ---------- 設定 ----------
  async function renderSettings() {
    S.boot = await api('GET', '/bootstrap');
    const st = S.boot.settings, box = $('#set-body'); box.replaceChildren();
    const inp = (name, val, type, extra) => h('input', { name, value: val, type: type || 'text', ...(extra || {}) });
    const lab = (t, el) => h('label', null, t, el);
    const save = async (body, msg) => { try { S.boot = await api('PUT', '/settings', body); $('#store-name').textContent = S.boot.settings.storeName || '予約台帳'; toast(msg || '保存しました'); renderSettings().catch(fail); } catch (err) { fail(err); } };

    const sform = h('form', { class: 'panel-box' }, h('h3', { text: 'お店' }),
      h('div', { class: 'row' }, lab('お店の名前（画面の左上に出ます）', inp('storeName', st.storeName)), lab('開店', inp('open', st.open, 'time')), lab('閉店', inp('close', st.close, 'time')), lab('昼と夜の境目', inp('lunchEnd', st.lunchEnd, 'time'))),
      h('div', { class: 'row' }, lab('ふつうの滞在時間（分）', inp('defaultStayMin', st.defaultStayMin, 'number', { min: 15, max: 720, step: 15 })),
        lab('操作がない時に自動でロック（分）', inp('autoLockMin', st.autoLockMin, 'number', { min: 1, max: 1440 })),
        lab('お客様情報の保管年数（最後の予約から）', inp('retentionYears', st.retentionYears, 'number', { min: 1, max: 20 }))),
      h('div', { class: 'actions' }, h('span', { class: 'sep' }), h('button', { class: 'primary', text: '保存' })));
    sform.addEventListener('submit', (e) => {
      e.preventDefault(); const f = sform.elements, s = {};
      ['storeName', 'open', 'close', 'lunchEnd'].forEach((k) => { s[k] = f[k].value; }); ['defaultStayMin', 'autoLockMin', 'retentionYears'].forEach((k) => { s[k] = +f[k].value; });
      save({ settings: s });
    });

    const tRows = h('tbody');
    const addTRow = (t) => tRows.append(h('tr', { 'data-id': t.id || '' },
      h('td', null, h('input', { value: t.name, 'data-k': 'name', 'aria-label': 'テーブルの名前' })),
      h('td', { class: 'small' }, h('input', { value: t.min || 1, type: 'number', min: 1, max: 200, 'data-k': 'min', 'aria-label': '最小人数' })),
      h('td', { class: 'small' }, h('input', { value: t.cap, type: 'number', min: 1, max: 200, 'data-k': 'cap', 'aria-label': '最大人数' })),
      h('td', null, h('input', { value: t.area, 'data-k': 'area', 'aria-label': 'エリア' })),
      h('td', null, (() => { const s = h('select', { 'data-k': 'smoke', 'aria-label': '喫煙' }, ['禁煙', '喫煙', ''].map((x) => h('option', { value: x, text: x || '—' }))); s.value = t.smoke || ''; return s; })()),
      h('td', { class: 'small' }, h('input', { value: t.pos, 'data-k': 'pos', 'aria-label': 'レジの席番号' })),
      h('td', null, h('button', { type: 'button', text: '↑', onclick: (e) => { const tr = e.target.closest('tr'); if (tr.previousElementSibling) tr.parentNode.insertBefore(tr, tr.previousElementSibling); } }), h('button', { type: 'button', text: '外す', onclick: (e) => e.target.closest('tr').remove() }))));
    S.boot.tables.forEach(addTRow);
    const tPanel = h('div', { class: 'panel-box' }, h('h3', { text: 'テーブル（予約台帳の上から順に並びます）' }),
      h('p', { class: 'hint', text: '定員は「最小-最大」の人数です。人数が最小より少ないと「席過剰」、最大より多いと「席不足」の印が付きます。「レジの席番号」は、レジのデータとつなぐ時に使います。外したテーブルの予約はウェイティングに移ります。' }),
      h('div', { class: 'table-wrap' }, h('table', { class: 'tbl edit-table' }, h('thead', null, h('tr', null, ['名前', '最小', '最大', 'エリア', '喫煙', 'レジの席番号', ''].map((x) => h('th', { text: x })))), tRows)),
      h('div', { class: 'actions' }, h('button', { type: 'button', text: '＋ テーブルを足す', onclick: () => addTRow({ name: '', min: 1, cap: 4, area: '', pos: '', smoke: '禁煙' }) }), h('span', { class: 'sep' }),
        h('button', { class: 'primary', type: 'button', text: 'テーブルを保存', onclick: () => save({ tables: $$('tr', tRows).map((tr) => ({ id: tr.dataset.id, name: $('[data-k=name]', tr).value, min: +$('[data-k=min]', tr).value, cap: +$('[data-k=cap]', tr).value, area: $('[data-k=area]', tr).value, smoke: $('[data-k=smoke]', tr).value, pos: $('[data-k=pos]', tr).value })) }, 'テーブルを保存しました') })));

    const kRows = h('tbody');
    const addKRow = (c) => kRows.append(h('tr', { 'data-id': c.id || '' },
      h('td', null, h('input', { value: c.name, 'data-k': 'name', 'aria-label': 'コース名' })), h('td', { class: 'small' }, h('input', { value: c.price, type: 'number', min: 0, 'data-k': 'price', 'aria-label': '金額' })),
      h('td', null, h('button', { type: 'button', text: '外す', onclick: (e) => e.target.closest('tr').remove() }))));
    S.boot.courses.forEach(addKRow);
    const kPanel = h('div', { class: 'panel-box' }, h('h3', { text: 'コース' }),
      h('div', { class: 'table-wrap' }, h('table', { class: 'tbl edit-table' }, h('thead', null, h('tr', null, ['コース名（レジの商品名と同じにすると、あとでつなぎやすい）', '金額（1人）', ''].map((x) => h('th', { text: x })))), kRows)),
      h('div', { class: 'actions' }, h('button', { type: 'button', text: '＋ コースを足す', onclick: () => addKRow({ name: '', price: 0 }) }), h('span', { class: 'sep' }),
        h('button', { class: 'primary', type: 'button', text: 'コースを保存', onclick: () => save({ courses: $$('tr', kRows).map((tr) => ({ id: tr.dataset.id, name: $('[data-k=name]', tr).value, price: +$('[data-k=price]', tr).value || 0 })) }, 'コースを保存しました') })));

    // 担当者・予約タグ・お客様属性：テーブルやコースと同じく、1行ずつ足して・外して・並べ替える
    const listBox = (title, key, hint, cur, maxLen) => {
      const rows = h('tbody');
      const addRow = (val, focus) => {
        const input = h('input', { value: val, maxlength: maxLen, 'data-k': 'name', 'aria-label': title + 'の名前' });
        rows.append(h('tr', null, h('td', null, input),
          h('td', { class: 'btns' }, h('button', { type: 'button', text: '↑', 'aria-label': '上へ', onclick: (e) => { const tr = e.target.closest('tr'); if (tr.previousElementSibling) tr.parentNode.insertBefore(tr, tr.previousElementSibling); } }),
            h('button', { type: 'button', text: '外す', onclick: (e) => e.target.closest('tr').remove() }))));
        if (focus) input.focus();
      };
      cur.forEach((x) => addRow(x));
      const collect = () => $$('[data-k=name]', rows).map((x) => x.value.trim()).filter(Boolean);
      return h('div', { class: 'panel-box' }, h('h3', { text: title }), h('p', { class: 'hint', text: hint + '。上から順に選択肢として並びます。' }),
        h('div', { class: 'table-wrap' }, h('table', { class: 'tbl edit-table' }, h('thead', null, h('tr', null, h('th', { text: '名前' }), h('th'))), rows)),
        h('div', { class: 'actions' }, h('button', { type: 'button', text: '＋ ' + title + 'を足す', onclick: () => addRow('', true) }), h('span', { class: 'sep' }),
          h('button', { class: 'primary', type: 'button', text: title + 'を保存', onclick: () => {
            const list = collect(), dup = list.filter((x, i) => list.indexOf(x) !== i);
            if (dup.length) { toast('「' + dup[0] + '」が2つあります。どちらかを外してください', true); return; }
            save({ [key]: list }, title + 'を保存しました');
          } })));
    };
    const fLabel = h('input', { value: S.boot.free.label }), fOpts = h('textarea', { rows: 4, value: S.boot.free.options.join('\n') });
    const freeBox = h('div', { class: 'panel-box' }, h('h3', { text: '自由設定欄' }), h('p', { class: 'hint', text: '予約ごとに選べる項目を、お店で自由に決められます（例：「来店のきっかけ」→ 紹介／チラシ／Instagram）。選択肢を空にすると、予約の入力欄に出ません。' }),
      h('div', { class: 'row' }, h('label', null, '項目の名前', fLabel), h('label', null, '選択肢（1行に1つ）', fOpts)),
      h('div', { class: 'actions' }, h('span', { class: 'sep' }), h('button', { class: 'primary', type: 'button', text: '保存', onclick: () => save({ free: { label: fLabel.value, options: fOpts.value.split('\n').map((x) => x.trim()).filter(Boolean) } }) })));
    box.append(sform, tPanel, kPanel,
      listBox('担当者', 'staff', '予約を確定する時に選ぶスタッフの名前', S.boot.staff, 30),
      listBox('予約タグ', 'resTags', '予約に付ける印（例：ケーキ用意、お誕生日）', S.boot.resTags, 20),
      listBox('お客様属性', 'custAttrs', 'お客様に付ける印（例：VIP、要注意、常連さま）', S.boot.custAttrs, 20), freeBox);
  }

  async function renderSecurity() {
    const box = $('#sec-body'); box.replaceChildren();
    const inp = (name, type) => h('input', { name, type: type || 'password', autocomplete: 'off' });
    const lab = (t, el) => h('label', null, t, el);
    const pform = h('form', { class: 'panel-box', autocomplete: 'off' }, h('h3', { text: '合言葉を変える' }),
      h('div', { class: 'row' }, lab('今の合言葉', inp('oldPass')), lab('新しい合言葉（8文字以上）', inp('newPass')), lab('もう一度', inp('newPass2'))),
      h('div', { class: 'actions' }, h('span', { class: 'sep' }), h('button', { class: 'primary', text: '変える' })));
    pform.addEventListener('submit', async (e) => {
      e.preventDefault(); const f = pform.elements;
      try {
        if (f.newPass.value !== f.newPass2.value) throw new Error('確認用の合言葉が一致しません');
        touch(); L._log('合言葉を変更'); await saving.catch(() => {});
        await vault.changePass(f.oldPass.value, f.newPass.value, L.db);
        pform.reset(); toast('合言葉を変えました。新しい合言葉を紙に控え、バックアップも書き出し直してください');
      } catch (err) { fail(err); }
    });
    const lg = await api('GET', '/log');
    const snaps = await vault.snapshots();
    const last = L.db.lastBackupAt;
    const doExport = async (snap) => {
      try {
        const text = await vault.exportText(snap);
        const r = await shareOrDownload('予約台帳_' + (snap || C.localDate()) + '.yoyaku', new Blob([text], { type: 'application/octet-stream' }));
        if (r === 'aborted') return;
        if (!snap) { L.db.lastBackupAt = new Date().toISOString(); L._log('バックアップを書き出し'); await persist(); }
        toast('書き出しました。iPadの外（Macや外付け）にも置いてください');
        renderSecurity().catch(fail);
      } catch (err) { fail(err); }
    };
    const snapSel = h('select', { 'aria-label': '控えの日付' }, snaps.map((d) => h('option', { value: d, text: d })));
    const fileIn = h('input', { type: 'file', accept: '.yoyaku,application/octet-stream,application/json,text/plain' });
    const passIn = h('input', { type: 'password', placeholder: 'そのバックアップを作った時の合言葉', autocomplete: 'off' });
    const bPanel = h('div', { class: 'panel-box' }, h('h3', { text: '保存場所とバックアップ' }),
      h('dl', { class: 'kvs' },
        h('dt', { text: '保存場所' }), h('dd', { text: 'このiPad（このブラウザ）の中。暗号化して保存しています。' }),
        h('dt', { text: '勝手に消されない設定' }), h('dd', { text: S.persisted ? 'オン' : 'オフ（ホーム画面に追加したアイコンから開くと、オンになりやすくなります）' }),
        h('dt', { text: '最後のバックアップ' }), h('dd', { text: last ? new Date(last).toLocaleString('ja-JP') : 'まだありません' }),
        h('dt', { text: '毎日の控え' }), h('dd', { text: snaps.length ? snaps.length + '日分（14日分を残します）' : 'まだありません（明日以降の最初の保存で作られます）' })),
      h('p', { class: 'hint', text: 'iPadが壊れた・なくした・ブラウザのデータを消した時に備えて、週に1回はバックアップを書き出し、「ファイル」アプリやAirDropでiPadの外に置いてください。ファイルは暗号化されたままで、合言葉がなければ読めません。' }),
      h('div', { class: 'actions' }, h('button', { class: 'primary', type: 'button', text: 'バックアップを書き出す', onclick: () => doExport(null) }),
        snaps.length ? snapSel : null, snaps.length ? h('button', { type: 'button', text: 'この日の控えを書き出す', onclick: () => doExport(snapSel.value) }) : null),
      h('details', { style: 'margin-top:10px' }, h('summary', { text: 'バックアップから戻す' }),
        h('p', { class: 'hint', text: '今の台帳は、その日の控えに残してから置き換えます。戻したあとは、そのバックアップを作った時の合言葉で開きます。' }),
        h('div', { class: 'row' }, fileIn, passIn),
        h('div', { class: 'actions' }, h('span', { class: 'sep' }), h('button', { class: 'danger', type: 'button', text: '戻す', onclick: async () => {
          try {
            const f = fileIn.files && fileIn.files[0];
            if (!f) throw new Error('バックアップのファイルを選んでください');
            if (!(await ask('バックアップから戻します', '今の台帳を「' + f.name + '」の中身で置き換えます。\n今の台帳は今日の控えに残ります。', { ok: '戻す' }))) return;
            const db = await vault.importText(await f.text(), passIn.value);
            L = new C.Ledger(db); L._log('バックアップから戻す'); await persist();
            toast('戻しました'); await enter();
          } catch (err) { fail(err); }
        } }))));
    const lPanel = h('details', { class: 'panel-box' }, h('summary', { text: '操作の記録（だれが何をしたかの目安。お客様の名前は記録しません）' }),
      h('div', { class: 'table-wrap', style: 'max-height:300px;margin-top:8px' }, h('table', { class: 'tbl' }, h('tbody', null, lg.log.map((x) => h('tr', null, h('td', { text: new Date(x.t).toLocaleString('ja-JP') }), h('td', { text: x.act }), h('td', { text: x.ref })))))));
    box.append(pform, bPanel, lPanel, h('div', { class: 'panel-box' }, h('h3', { text: 'ロック' }), h('p', { class: 'hint', text: '席を離れる時は、ロックしてください。開くには合言葉が要ります。' }), h('button', { class: 'primary', text: 'ロックする', onclick: () => lockNow('ロック') })));
  }

  start().catch((e) => { document.body.textContent = '予約台帳を開けませんでした。（' + e.message + '）'; });
})();
