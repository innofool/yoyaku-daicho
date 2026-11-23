'use strict';
// 予約台帳の画面。データはこの端末の中だけで扱い、外へは送らない。
// お客様の文字は必ず textContent で表示する（画面に仕込まれた文字が命令として動かないように）。
// 画面の並び・予約の入れ方は、飲食店でよく使われる予約台帳（公開情報）の使い勝手に合わせている。
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
  const pad = (n) => String(n).padStart(2, '0');
  const fmtDate = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  const parseDate = (s) => new Date(s + 'T00:00:00');
  const addDays = (s, n) => { const d = parseDate(s); d.setDate(d.getDate() + n); return fmtDate(d); };
  const toMin = (t) => +t.slice(0, 2) * 60 + +t.slice(3);
  const toTime = (m) => pad(Math.floor(m / 60)) + ':' + pad(m % 60);
  const WD = ['日', '月', '火', '水', '木', '金', '土'];
  const jpDate = (s) => { const d = parseDate(s); return (d.getMonth() + 1) + '月' + d.getDate() + '日（' + WD[d.getDay()] + '）'; };
  const STATUS = { booked: '予約', seated: '来店中', left: '退店', cancel: 'キャンセル', noshow: '無断キャンセル' };
  const ACTIVE = new Set(['booked', 'seated', 'left']);
  const LEDGER_VIEWS = new Set(['time', 'floor', 'list']);
  const AREA_COLORS = ['#f59e0b', '#10b981', '#3b82f6', '#a855f7', '#ef4444', '#14b8a6', '#84cc16', '#ec4899'];
  const coarse = matchMedia('(pointer: coarse)').matches;
  const yen = (n) => '¥' + Number(n || 0).toLocaleString('ja-JP');

  const S = { today: '', date: '', calYm: '', boot: null, day: [], view: 'time', ledgerView: 'time', custSel: null, custSort: 'kana', custTag: '', custVisits: 0, floorTime: '' };

  // ---------- 台帳とのやりとり（すべてこの端末の中で完結する） ----------
  const C = window.YoyakuCore, V = window.YoyakuVault;
  const vault = new V.Vault(V.idbStorage());
  let L = null; // 開いている間だけの台帳（ロックすると消える）
  let saving = Promise.resolve();
  function persist() {
    saving = saving.catch(() => {}).then(() => vault.save(L.db));
    return saving;
  }
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
      else if (method === 'PUT') out = L.setStatus(m[1], b.status);
      else if (method === 'DELETE') out = L.deleteReservation(m[1]);
    } else if (p === '/availability' && method === 'GET') out = L.availability(q.date, q.time, q.stayMin, q.guests, q.exclude);
    else if (p === '/month' && method === 'GET') out = L.month(q.ym);
    else if (p === '/customers' && method === 'GET') out = L.listCustomers({ q: q.q, stale: q.stale === '1', limit: q.limit, sort: q.sort, tag: q.tag, minVisits: q.minVisits });
    else if (p === '/customers' && method === 'POST') out = L.saveCustomer(b);
    else if ((m = /^\/customers\/(c_[a-f0-9]{16})$/.exec(p))) {
      if (method === 'GET') out = L.getCustomer(m[1]);
      else if (method === 'PUT') out = L.saveCustomer(b, m[1]);
      else if (method === 'DELETE') out = L.deleteCustomer(m[1]);
    } else if (p === '/stats' && method === 'GET') out = L.stats(q.from, q.to);
    else if (p === '/log' && method === 'GET') out = { log: L.log(300) };
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
    b.hidden = !action;
    b.onclick = null;
    if (action) { b.textContent = action.label; b.onclick = () => { t.className = 'toast'; action.fn(); }; }
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = 'toast'; }, action ? 7000 : bad ? 4000 : 2000);
  }
  const fail = (e) => toast(e.message || String(e), true);

  // ---------- 合言葉 ----------
  let gateMode = 'unlock';
  async function start() {
    if (!window.isSecureContext || !window.crypto || !crypto.subtle || !window.indexedDB) {
      document.body.textContent = 'この開き方では暗号化が使えないため、台帳を開けません。https:// で始まるアドレスか、ホーム画面のアイコンから開いてください。';
      return;
    }
    S.today = C.localDate();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { /* なくても台帳は使える */ });
    // 端末の空きが減っても、ブラウザが勝手に台帳を消さないよう頼む
    if (navigator.storage && navigator.storage.persist) { try { S.persisted = await navigator.storage.persist(); } catch (e) { S.persisted = false; } }
    gateMode = (await vault.exists()) ? 'unlock' : 'setup';
    showGate();
  }
  function showGate() {
    $('#app').hidden = true; $('#gate').hidden = false;
    $$('dialog[open]').forEach((d) => d.close());
    $('#movebar').hidden = true; $('#menu').hidden = true; $('#cal-pop').hidden = true;
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
    S.calYm = S.date.slice(0, 7);
    fillSelects();
    show(S.view);
  }

  // ---------- 上の帯・メニュー・画面の切り替え ----------
  $('#btn-menu').addEventListener('click', (e) => { e.stopPropagation(); $('#menu').hidden = !$('#menu').hidden; $('#cal-pop').hidden = true; });
  document.addEventListener('click', (e) => {
    if (!$('#menu').hidden && !e.target.closest('#menu')) $('#menu').hidden = true;
    if (!$('#cal-pop').hidden && !e.target.closest('#cal-pop') && !e.target.closest('#d-label')) $('#cal-pop').hidden = true;
  });
  $$('#menu [data-go]').forEach((b) => b.addEventListener('click', () => { $('#menu').hidden = true; show(b.dataset.go === 'time' ? S.ledgerView : b.dataset.go); }));
  $('#btn-lock').addEventListener('click', () => { $('#menu').hidden = true; lockNow('ロック'); });
  $$('#view-seg button').forEach((b) => b.addEventListener('click', () => show(b.dataset.view)));
  $('#btn-print').addEventListener('click', () => { if (!LEDGER_VIEWS.has(S.view)) show(S.ledgerView); setTimeout(() => window.print(), 300); });
  $('#btn-new').addEventListener('click', () => openWizard({ date: LEDGER_VIEWS.has(S.view) ? S.date : S.today }));

  function show(view) {
    S.view = view;
    if (LEDGER_VIEWS.has(view)) S.ledgerView = view;
    const ledger = LEDGER_VIEWS.has(view);
    $$('#view-seg button').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
    $('#bar-date').style.visibility = ledger ? 'visible' : 'hidden';
    $('#sumbar').hidden = !ledger;
    $$('.view').forEach((v) => { v.hidden = v.id !== 'v-' + view; });
    const run = ledger ? loadDay : ({ customers: loadCustomers, stats: initStats, settings: renderSettings })[view];
    run().catch(fail);
  }
  function refresh() { show(S.view); }

  // ---------- 日付 ----------
  $('#d-prev').addEventListener('click', () => goDate(addDays(S.date, -1)));
  $('#d-next').addEventListener('click', () => goDate(addDays(S.date, 1)));
  $('#d-today').addEventListener('click', () => goDate(S.today));
  $('#d-label').addEventListener('click', (e) => {
    e.stopPropagation();
    const pop = $('#cal-pop');
    pop.hidden = !pop.hidden; $('#menu').hidden = true;
    if (!pop.hidden) { S.calYm = S.date.slice(0, 7); api('GET', '/month?ym=' + S.calYm).then((r) => { S.month = r; renderCal(); }).catch(fail); }
  });
  function goDate(d) { S.date = d; S.calYm = d.slice(0, 7); $('#cal-pop').hidden = true; if (!LEDGER_VIEWS.has(S.view)) show(S.ledgerView); else loadDay().catch(fail); }

  function renderCal() {
    const cal = $('#cal'); cal.replaceChildren();
    const [y, m] = S.calYm.split('-').map(Number);
    const first = new Date(y, m - 1, 1);
    const moveCal = (n) => { const d = new Date(y, m - 1 + n, 1); S.calYm = d.getFullYear() + '-' + pad(d.getMonth() + 1); api('GET', '/month?ym=' + S.calYm).then((r) => { S.month = r; renderCal(); }).catch(fail); };
    cal.append(h('div', { class: 'cap' }, h('button', { text: '‹', 'aria-label': '前の月', onclick: (e) => { e.stopPropagation(); moveCal(-1); } }), h('span', { text: y + '年' + m + '月' }), h('button', { text: '›', 'aria-label': '次の月', onclick: (e) => { e.stopPropagation(); moveCal(1); } })));
    WD.forEach((w, i) => cal.append(h('div', { class: 'wd' + (i === 0 ? ' sun' : i === 6 ? ' sat' : ''), text: w })));
    const start = new Date(first); start.setDate(1 - first.getDay());
    for (let i = 0; i < 42; i++) {
      const d = new Date(start); d.setDate(start.getDate() + i);
      if (i >= 35 && d.getMonth() !== m - 1) break;
      const ds = fmtDate(d), info = (S.month && S.month.days[ds]) || null;
      cal.append(h('button', {
        class: 'd' + (d.getMonth() !== m - 1 ? ' other' : '') + (ds === S.today ? ' today' : '') + (ds === S.date ? ' sel' : '') + (d.getDay() === 0 ? ' sun' : d.getDay() === 6 ? ' sat' : ''),
        title: info ? info.groups + '組 ' + info.guests + '名' : '', onclick: () => goDate(ds),
      }, h('span', { class: 'n', text: d.getDate() }), h('span', { class: 'c', text: info && info.groups ? info.groups + '組' : '' })));
    }
  }

  // ---------- その日の予約 ----------
  async function loadDay() {
    const r = await api('GET', '/reservations?from=' + S.date + '&to=' + S.date);
    S.day = r.reservations;
    $('#d-label').textContent = jpDate(S.date);
    $('#d-today').classList.toggle('is-today', S.date === S.today);
    renderSum();
    if (S.view === 'time') renderTime();
    else if (S.view === 'floor') renderFloor();
    else renderList();
  }

  function renderSum() {
    const act = S.day.filter((r) => ACTIVE.has(r.status));
    const g = (list) => list.reduce((a, r) => a + r.guests, 0);
    const le = toMin(S.boot.settings.lunchEnd);
    const lunch = act.filter((r) => toMin(r.time) < le), dinner = act.filter((r) => toMin(r.time) >= le);
    const item = (k, v) => h('span', null, k + ' ', h('b', { text: v }));
    const box = $('#sumbar'); box.replaceChildren(
      item('予約', act.length + '組 ' + g(act) + '名'), item('昼', lunch.length + '組 ' + g(lunch) + '名'), item('夜', dinner.length + '組 ' + g(dinner) + '名'),
      item('来店済み', act.filter((r) => r.status !== 'booked').length + '組'), item('キャンセル', S.day.filter((r) => !ACTIVE.has(r.status)).length + '組'),
      item('ウェイティング', act.filter((r) => !r.tableIds.length).length + '組'));
    const lastB = L && L.db.lastBackupAt;
    if (L && L.db.reservations.length && (!lastB || Date.now() - Date.parse(lastB) > 7 * 86400000)) {
      box.append(h('button', { class: 'warn-btn', text: lastB ? 'バックアップが7日以上前です' : 'バックアップがまだありません', onclick: () => show('settings') }));
    }
  }

  function courseName(id) { const c = S.boot.courses.find((x) => x.id === id); return c ? c.name : ''; }
  function tableNames(ids) { return ids.map((id) => (S.boot.tables.find((t) => t.id === id) || {}).name).filter(Boolean).join('・'); }
  function capText(t) { return (t.min || 1) === t.cap ? String(t.cap) : (t.min || 1) + '〜' + t.cap; }
  function custName(c) { return c ? (c.name || c.phone || 'お名前なし') : 'お名前なし'; }
  function sama(c) { return c && c.name ? c.name + ' 様' : custName(c); }
  function areaColor(area) { const areas = [...new Set(S.boot.tables.map((t) => t.area))]; return AREA_COLORS[Math.max(0, areas.indexOf(area)) % AREA_COLORS.length]; }
  function isVip(c) { return c && c.tags.some((t) => /^vip$/i.test(t)); }

  function hoursRange(list) {
    const st = S.boot.settings;
    let s = Math.floor(toMin(st.open) / 60) * 60, e = Math.ceil(toMin(st.close) / 60) * 60;
    for (const r of list) { s = Math.min(s, Math.floor(toMin(r.time) / 60) * 60); e = Math.max(e, Math.ceil((toMin(r.time) + r.stayMin) / 60) * 60); }
    return [s, Math.min(e, 30 * 60)];
  }
  function slotW() { return parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--slot')) || 44; }

  function overlapIds(list) {
    const over = new Set();
    const act = list.filter((r) => ACTIVE.has(r.status));
    for (let i = 0; i < act.length; i++) for (let j = i + 1; j < act.length; j++) {
      const a = act[i], b = act[j];
      if (!a.tableIds.some((t) => b.tableIds.includes(t))) continue;
      const as = toMin(a.time), bs = toMin(b.time);
      if (as < bs + b.stayMin && bs < as + a.stayMin) { over.add(a.id); over.add(b.id); }
    }
    return over;
  }

  // ---------- タイムテーブル ----------
  // 表の骨組み（席の列・時間の見出し）を作る。台帳と、新規予約のテーブル選択で使い回す
  function buildGrid(box, list, opt) {
    const [s, e] = hoursRange(list);
    const slot = slotW(), slots = (e - s) / 30, px = (m) => ((m - s) / 30) * slot;
    const st = S.boot.settings, o0 = toMin(st.open), o1 = toMin(st.close);
    box.replaceChildren();
    const head = h('div', { class: 'g-head' }, h('div', { class: 'g-corner' }, h('span', { text: 'テーブル' }), h('span', { text: '定員' })));
    for (let m = s; m < e; m += 60) head.append(h('div', { class: 'g-hour', text: (m / 60) + ':00' }));
    box.append(head);
    const rows = [{ id: '', name: 'ウェイティングリスト', waiting: true }, ...S.boot.tables];
    let lastArea = null;
    const rowEls = [];
    for (const t of rows) {
      const cells = h('div', { class: 'g-cells', style: 'width:' + slots * slot + 'px' });
      for (let i = 0; i < slots; i++) {
        const tm = s + i * 30;
        cells.append(h('div', { class: 'g-cell' + (tm % 60 === 0 ? ' h' : '') + (tm >= o0 && tm < o1 ? ' open' : ''), 'data-tm': tm }));
      }
      const top = !t.waiting && lastArea !== null && t.area !== lastArea;
      if (!t.waiting) lastArea = t.area;
      const name = h('div', { class: 'g-name', style: t.waiting ? '' : '--area:' + areaColor(t.area) },
        h('span', { class: 'tn', text: t.name, title: t.name + (t.area ? '（' + t.area + '）' : '') }), h('span', { class: 'tc', text: t.waiting ? '' : capText(t) }));
      const row = h('div', { class: 'g-row' + (t.waiting ? ' waiting' : '') + (top ? ' area-top' : ''), 'data-tid': t.id }, name, cells);
      rowEls.push({ t, row, cells });
      box.append(row);
      if (opt && opt.onRow) opt.onRow(t, row, cells);
    }
    if (S.date === S.today || (opt && opt.date === S.today)) {
      const now = new Date(), nm = now.getHours() * 60 + now.getMinutes();
      if (nm >= s && nm <= e) for (const { cells } of rowEls) cells.append(h('div', { class: 'g-now', style: 'left:' + px(nm) + 'px' }));
    }
    return { s, e, slot, px, rowEls };
  }

  function blockEl(r, px, slot, over) {
    const c = r.customer;
    const vc = c && c.visits ? h('span', { class: 'vc', text: c.visits, title: '来店回数' }) : null;
    const el = h('div', {
      class: 'blk ' + r.status + (over && over.has(r.id) ? ' over' : ''),
      style: 'left:' + px(toMin(r.time)) + 'px;width:' + Math.max(slot - 4, (r.stayMin / 30) * slot - 3) + 'px',
      title: r.time + '〜' + toTime(toMin(r.time) + r.stayMin) + ' ' + r.guests + '名様 ' + sama(c) + (r.memo ? ' ' + r.memo : '') + (over && over.has(r.id) ? '（席が重なっています）' : ''),
    }, h('div', { class: 't', text: r.time + ' - ' + r.guests + '名様' + (r.kids ? '（子' + r.kids + '）' : '') + (courseName(r.courseId) ? ' ' + courseName(r.courseId) : '') }),
    h('div', { class: 'n' }, sama(c), vc, isVip(c) ? h('span', { class: 'badge vip', text: 'VIP' }) : null, c && c.allergy ? h('span', { class: 'badge', text: '⚠' }) : null));
    return el;
  }

  function renderTime() {
    const showCancel = false;
    const list = S.day.filter((r) => showCancel || ACTIVE.has(r.status));
    const over = overlapIds(S.day);
    const g = buildGrid($('#grid'), list, {
      onRow: (t, row, cells) => {
        cells.addEventListener('click', (ev) => {
          const cell = ev.target.closest('.g-cell'); if (!cell) return;
          openWizard({ date: S.date, time: toTime(+cell.dataset.tm), tableIds: t.id ? [t.id] : [], fromGrid: true });
        });
      },
    });
    for (const { t, cells } of g.rowEls) {
      const mine = t.waiting ? list.filter((r) => !r.tableIds.length) : list.filter((r) => r.tableIds.includes(t.id));
      for (const r of mine) {
        const el = blockEl(r, g.px, g.slot, over);
        attachDrag(el, r, t.id, g);
        cells.append(el);
      }
    }
    S.grid = g;
    if (S.date === S.today && !S.scrolledToday) {
      const now = new Date();
      $('#grid-wrap').scrollLeft = Math.max(0, g.px(now.getHours() * 60 + now.getMinutes()) - 3 * g.slot);
      S.scrolledToday = true;
    }
  }

  // 予約の枠を指でつかんで、別の席・時刻へ動かす（動かした後に確認を出す）
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
        target = dropTarget(ev.clientX - offX, ev.clientY, g, r);
        markDrop(target, r, g);
      };
      const end = (ev, cancelled) => {
        el.removeEventListener('pointermove', move);
        el.removeEventListener('pointerup', onUp);
        el.removeEventListener('pointercancel', onCancel);
        if (ghost) ghost.remove();
        el.classList.remove('dragging');
        if (!moved) { if (!cancelled) openRes(r); return; }
        if (cancelled || !target) { renderTime(); return; }
        proposeMove(r, fromTid, target);
      };
      const onUp = (ev) => end(ev, false), onCancel = (ev) => end(ev, true);
      el.addEventListener('pointermove', move);
      el.addEventListener('pointerup', onUp);
      el.addEventListener('pointercancel', onCancel);
    });
  }
  function dropTarget(x, y, g, r) {
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
    return { date: r.date, time: r.time, stayMin: r.stayMin, guests: r.guests, kids: r.kids || 0, tableIds: r.tableIds, customerId: r.customerId || null, courseId: r.courseId, source: r.source, memo: r.memo, status: r.status, ...change };
  }
  function proposeMove(r, fromTid, target) {
    let tables;
    if (!target.tid) tables = [];
    else if (r.tableIds.length <= 1) tables = [target.tid];
    else tables = [...new Set(r.tableIds.map((t) => (t === fromTid ? target.tid : t)))];
    if (target.time === r.time && tables.join() === r.tableIds.join()) { renderTime(); return; }
    const bar = $('#movebar');
    $('#mv-text').replaceChildren(
      h('b', { text: target.time + ' - ' + r.guests + '名様' }), h('br'), document.createTextNode(sama(r.customer)), h('br'),
      h('span', { class: 'muted', text: (r.time !== target.time ? r.time + ' → ' + target.time + '　' : '') + (tableNames(r.tableIds) || 'ウェイティング') + ' → ' + (tableNames(tables) || 'ウェイティング') }));
    bar.hidden = false;
    const close = () => { bar.hidden = true; $('#mv-ok').onclick = null; $('#mv-cancel').onclick = null; };
    $('#mv-cancel').onclick = () => { close(); renderTime(); };
    $('#mv-ok').onclick = async () => {
      close();
      const prev = resInput(r, {});
      try {
        const ok = await saveWithOverlapCheck(resInput(r, { time: target.time, tableIds: tables }), r.id);
        if (!ok) { renderTime(); return; }
        await loadDay();
        toast('動かしました', false, { label: '元に戻す', fn: async () => { try { await api('PUT', '/reservations/' + r.id, { ...prev, allowOverlap: true }); await loadDay(); toast('元に戻しました'); } catch (e) { fail(e); } } });
      } catch (e) { fail(e); renderTime(); }
    };
  }
  async function saveWithOverlapCheck(body, id) {
    const url = id ? '/reservations/' + id : '/reservations';
    let r = await api(id ? 'PUT' : 'POST', url, body);
    if (r.conflicts) {
      const msg = r.conflicts.map((c) => c.time + '〜 ' + (c.name ? c.name + ' 様' : 'お名前なし') + '（' + c.tables.join('・') + '）').join('\n');
      if (!confirm('同じテーブルに重なる予約があります。\n' + msg + '\nこのまま入れますか？')) return null;
      r = await api(id ? 'PUT' : 'POST', url, { ...body, allowOverlap: true });
    }
    return r;
  }

  // 画面の向き・大きさが変わったら、マスの幅に合わせて描き直す
  let resizeTimer;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (L && S.view === 'time' && S.boot) renderTime(); }, 150); });

  // ---------- テーブル配置図 ----------
  $('#floor-time').addEventListener('change', (e) => { S.floorTime = e.target.value; renderFloor(); });
  function renderFloor() {
    const st = S.boot.settings, sel = $('#floor-time');
    const o0 = toMin(st.open), o1 = toMin(st.close);
    if (!S.floorTime || S.floorDate !== S.date) {
      const now = new Date(), nm = now.getHours() * 60 + now.getMinutes();
      let t = S.date === S.today && nm >= o0 && nm < o1 ? Math.floor(nm / 30) * 30 : (o0 <= 18 * 60 && 18 * 60 < o1 ? 18 * 60 : o0);
      S.floorTime = toTime(t); S.floorDate = S.date;
    }
    sel.replaceChildren();
    for (let m = Math.floor(o0 / 30) * 30; m < o1; m += 30) sel.append(h('option', { value: toTime(m), text: toTime(m) }));
    sel.value = S.floorTime;
    const tm = toMin(S.floorTime);
    const act = S.day.filter((r) => ACTIVE.has(r.status));
    const box = $('#floor'); box.replaceChildren();
    const areas = [...new Set(S.boot.tables.map((t) => t.area))];
    let used = 0;
    for (const area of areas) {
      const tiles = h('div', { class: 'tiles' });
      for (const t of S.boot.tables.filter((x) => x.area === area)) {
        const mine = act.filter((r) => r.tableIds.includes(t.id)).sort((a, b) => a.time.localeCompare(b.time));
        const now = mine.find((r) => toMin(r.time) <= tm && tm < toMin(r.time) + r.stayMin);
        const next = mine.find((r) => toMin(r.time) > tm);
        if (now) used++;
        tiles.append(h('div', {
          class: 'tile ' + (now ? now.status : 'free'),
          onclick: () => (now ? openRes(now) : openWizard({ date: S.date, time: S.floorTime, tableIds: [t.id], fromGrid: true })),
        }, h('div', { class: 'tt' }, h('span', { text: t.name }), h('small', { text: capText(t) + '名' })),
        now ? h('div', { class: 'who', text: sama(now.customer) }) : h('div', { class: 'who', text: '空き' }),
        now ? h('div', { class: 'sub', text: now.time + '〜' + toTime(toMin(now.time) + now.stayMin) + '・' + now.guests + '名様・' + STATUS[now.status] }) : null,
        next ? h('div', { class: 'sub', text: '次：' + next.time + ' ' + sama(next.customer) + ' ' + next.guests + '名様' }) : null));
      }
      box.append(h('div', null, h('div', { class: 'area-h', style: '--area:' + areaColor(area), text: area || 'エリアなし' }), tiles));
    }
    $('#floor-note').textContent = S.floorTime + ' の時点：' + used + ' / ' + S.boot.tables.length + ' テーブルが使用中';
  }

  // ---------- 一覧表 ----------
  $('#list-cancel').addEventListener('change', () => renderList());
  function renderList() {
    const showCancel = $('#list-cancel').checked;
    const list = S.day.filter((r) => showCancel || ACTIVE.has(r.status));
    const over = overlapIds(S.day);
    const t = $('#day-table'); t.replaceChildren();
    t.append(h('thead', null, h('tr', null, ['時間', 'お名前', '人数', 'テーブル', 'コース', '経路', 'メモ', '状態', ''].map((x) => h('th', { text: x, class: x === '人数' ? 'num' : '' })))));
    const tb = h('tbody');
    for (const r of list) {
      const c = r.customer;
      const btns = h('div', { class: 'st-btns' });
      const sb = (s, label) => btns.append(h('button', { type: 'button', text: label, onclick: (ev) => { ev.stopPropagation(); setStatus(r, s); } }));
      if (r.status === 'booked') { sb('seated', '来店'); sb('cancel', 'キャンセル'); }
      else if (r.status === 'seated') sb('left', '退店');
      else sb('booked', '予約に戻す');
      const warns = [];
      if (c && c.allergy) warns.push('⚠ ' + c.allergy);
      if (c && (c.noshows || c.cancels)) warns.push('過去にキャンセル' + c.cancels + '・無断' + c.noshows);
      if (over.has(r.id)) warns.push('テーブルが重なっています');
      tb.append(h('tr', { class: r.status, onclick: () => openRes(r) },
        h('td', null, h('div', { class: 'tm', text: r.time }), h('div', { class: 'muted', text: '〜' + toTime(toMin(r.time) + r.stayMin) })),
        h('td', { class: 'wrap' }, h('b', { text: sama(c) }), c ? h('span', { class: c.visits ? 'badge' : 'badge new', text: c.visits ? '来店' + c.visits + '回' : '初めて' }) : null,
          isVip(c) ? h('span', { class: 'badge vip', text: 'VIP' }) : null, c ? c.tags.filter((x) => !/^vip$/i.test(x)).map((x) => h('span', { class: 'badge tag', text: x })) : null,
          c && c.phone ? h('div', { class: 'muted', text: c.phone }) : null, warns.map((w) => h('div', { class: 'warn-t', text: w }))),
        h('td', { class: 'num', text: r.guests + '名' + (r.kids ? '（子' + r.kids + '）' : '') }),
        h('td', { text: tableNames(r.tableIds) || 'ウェイティング' }), h('td', { text: courseName(r.courseId) }), h('td', { text: r.source }),
        h('td', { class: 'wrap', text: r.memo }), h('td', null, h('span', { class: 'pill ' + r.status, text: STATUS[r.status] })), h('td', null, btns)));
    }
    if (!list.length) tb.append(h('tr', null, h('td', { colspan: 9, class: 'muted', text: 'この日の予約はありません。右上の ＋ から入れられます。' })));
    t.append(tb);
  }
  async function setStatus(r, s) {
    try { await api('PUT', '/reservations/' + r.id + '/status', { status: s }); toast(STATUS[s] + 'にしました'); await loadDay(); } catch (e) { fail(e); }
  }

  // ---------- 予約の詳細・変更 ----------
  const dlg = $('#dlg-res'), form = $('#res-form');
  let editing = null, linked = null, pickTables = [];
  function fillSelects() {
    const src = form.elements.source; src.replaceChildren(h('option', { value: '', text: '（選ぶ）' }), ...S.boot.sources.map((s) => h('option', { value: s, text: s })));
    const cs = form.elements.courseId; cs.replaceChildren(h('option', { value: '', text: 'なし・席のみ' }), ...S.boot.courses.map((c) => h('option', { value: c.id, text: c.name + (c.price ? '（' + yen(c.price) + '）' : '') })));
  }
  function renderStatusSeg() {
    const box = $('#res-status'); box.replaceChildren();
    for (const [s, label] of [['booked', '予約'], ['seated', '来店'], ['left', '退店'], ['cancel', 'キャンセル'], ['noshow', '無断']]) {
      box.append(h('button', {
        type: 'button', class: s + (editing && editing.status === s ? ' on' : ''), text: label,
        onclick: async () => {
          if (!editing || editing.status === s) return;
          try { const r = await api('PUT', '/reservations/' + editing.id + '/status', { status: s }); editing.status = r.reservation.status; renderStatusSeg(); toast(STATUS[s] + 'にしました'); refreshBehind(); } catch (e) { fail(e); }
        },
      }));
    }
  }
  function refreshBehind() { if (LEDGER_VIEWS.has(S.view)) loadDay().catch(fail); else if (S.view === 'customers') loadCustomers().catch(fail); }

  function openRes(r) {
    editing = r; linked = r.customer || null;
    const f = form.elements;
    $('#res-title').textContent = r.date + ' ' + r.time + '〜 の予約';
    f.date.value = r.date; f.time.value = r.time; f.guests.value = r.guests; f.kids.value = r.kids || 0; f.stayMin.value = r.stayMin;
    f.source.value = r.source; f.courseId.value = r.courseId; f.memo.value = r.memo;
    f.phone.value = linked ? linked.phone : ''; f.name.value = linked ? linked.name : ''; f.kana.value = linked ? linked.kana : ''; f.allergy.value = linked ? linked.allergy : '';
    pickTables = [...r.tableIds];
    $('#res-err').textContent = '';
    renderStatusSeg();
    renderMatch([]);
    renderTablePick();
    dlg.showModal();
  }
  function renderMatch(hits) {
    const box = $('#res-match'); box.replaceChildren();
    if (linked) {
      box.append(h('div', { class: 'hit linked' },
        h('b', { text: 'No.' + linked.no + ' ' + sama(linked) }),
        h('span', { text: '来店' + linked.visits + '回' + (linked.last ? '（前回 ' + linked.last + '）' : '') }),
        linked.cancels || linked.noshows ? h('span', { class: 'warn-t', text: 'キャンセル' + linked.cancels + '・無断' + linked.noshows }) : null,
        linked.memo ? h('span', { class: 'muted', text: linked.memo }) : null,
        h('button', { type: 'button', text: '別の方にする', onclick: () => { linked = null; renderMatch([]); } })));
      return;
    }
    for (const c of hits.slice(0, 5)) {
      box.append(h('div', { class: 'hit' },
        h('b', { text: 'No.' + c.no + ' ' + sama(c) }), h('span', { text: c.phone }),
        h('span', { text: '来店' + c.visits + '回' + (c.last ? '・前回 ' + c.last : '') }),
        c.allergy ? h('span', { class: 'warn-t', text: '⚠' + c.allergy }) : null,
        h('button', { type: 'button', text: 'この方にする', onclick: () => { linked = c; const f = form.elements; f.phone.value = c.phone; f.name.value = c.name; f.kana.value = c.kana; f.allergy.value = c.allergy; renderMatch([]); } })));
    }
  }
  let searchTimer;
  function searchCust() {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      if (linked) return;
      const f = form.elements; const q = f.phone.value.replace(/\D/g, '').length >= 4 ? f.phone.value : f.name.value;
      if (!q || q.trim().length < 2) return renderMatch([]);
      try { renderMatch((await api('GET', '/customers?limit=5&q=' + encodeURIComponent(q))).customers); } catch (e) { /* 入力中は黙る */ }
    }, 250);
  }
  // iPadのキーボード・日本語の変換確定でも確実に探すよう、いくつかの合図で探す
  for (const n of ['phone', 'name']) for (const ev of ['input', 'keyup', 'change', 'compositionend']) form.elements[n].addEventListener(ev, searchCust);
  ['date', 'time', 'stayMin'].forEach((n) => form.elements[n].addEventListener('change', renderTablePick));

  async function renderTablePick() {
    const f = form.elements, box = $('#res-tables'); box.replaceChildren();
    let busy = new Set();
    try { busy = new Set((await api('GET', '/availability?' + qs({ date: f.date.value, time: f.time.value || '00:00', stayMin: +f.stayMin.value || 60, guests: 1, exclude: editing && editing.id }))).busy); } catch (err) { busy = new Set(); }
    for (const t of S.boot.tables) {
      const on = pickTables.includes(t.id);
      box.append(h('button', {
        type: 'button', class: (on ? 'on' : '') + (busy.has(t.id) ? ' busy' : ''), title: busy.has(t.id) ? 'この時間は埋まっています' : '',
        text: t.name + '（' + capText(t) + '）', onclick: () => { pickTables = on ? pickTables.filter((x) => x !== t.id) : [...pickTables, t.id]; renderTablePick(); },
      }));
    }
  }
  $('#res-cancel').addEventListener('click', () => dlg.close());
  $('#res-del').addEventListener('click', async () => {
    if (!editing) return;
    if (!confirm(editing.date + ' ' + editing.time + ' の予約を削除します。元に戻せません。\nキャンセルの記録を残したい時は「キャンセル」を押してください。\n削除しますか？')) return;
    try { await api('DELETE', '/reservations/' + editing.id); dlg.close(); toast('削除しました'); refreshBehind(); } catch (e) { fail(e); }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = form.elements;
    const body = {
      date: f.date.value, time: f.time.value, guests: +f.guests.value, kids: +f.kids.value || 0, stayMin: +f.stayMin.value,
      source: f.source.value, courseId: f.courseId.value, status: editing.status, memo: f.memo.value, tableIds: pickTables,
      customerId: linked ? linked.id : null,
      customer: { name: f.name.value, kana: f.kana.value, phone: f.phone.value, allergy: f.allergy.value },
    };
    $('#res-err').textContent = '';
    try {
      const r = await saveWithOverlapCheck(body, editing.id);
      if (!r) return;
      dlg.close();
      toast('保存しました');
      if (LEDGER_VIEWS.has(S.view) && body.date !== S.date) { S.date = body.date; S.calYm = body.date.slice(0, 7); }
      refreshBehind();
    } catch (err) { $('#res-err').textContent = err.message; }
  });

  // ---------- 新規予約（日時／人数 → テーブル選択 → 詳細 → 確認） ----------
  const wiz = $('#dlg-wiz');
  let W = null;
  function openWizard(p) {
    const st = S.boot.settings;
    W = {
      step: 0, maxStep: 0, date: p.date || S.date, time: p.time || '', adults: '', kids: '', stayMin: st.defaultStayMin,
      tableIds: p.tableIds || [], presetTables: !!(p.tableIds && p.tableIds.length), autoNote: '', avail: null,
      phone: '', name: '', kana: '', allergy: '', courseId: '', source: '電話', memo: '', customer: null, hits: [], key: 'adults',
    };
    renderWiz();
    wiz.showModal();
  }
  $('#wiz-close').addEventListener('click', () => { if (wizDirty() && !confirm('入力中の予約を閉じますか？（保存されません）')) return; wiz.close(); });
  wiz.addEventListener('cancel', (e) => { if (wizDirty() && !confirm('入力中の予約を閉じますか？（保存されません）')) e.preventDefault(); });
  function wizDirty() { return W && (W.adults || W.phone || W.name); }
  $$('#wiz-steps [data-step]').forEach((b) => b.addEventListener('click', () => { const n = +b.dataset.step; if (n <= W.maxStep) { W.step = n; renderWiz(); } }));
  $('#wiz-back').addEventListener('click', () => { if (W.step > 0) { W.step--; renderWiz(); } });
  $('#wiz-next').addEventListener('click', () => wizNext().catch(fail));

  const guestsOf = () => (+W.adults || 0) + (+W.kids || 0);
  function wizError() {
    if (W.step === 0) {
      if (!C.isDate(W.date)) return '日付を入れてください。';
      if (!/^\d{2}:\d{2}$/.test(W.time)) return '時間を入れてください。';
      if (guestsOf() < 1) return '人数を入力してください。';
    }
    return '';
  }
  async function wizNext() {
    const err = wizError();
    const msg = $('#wiz-msg');
    if (err) { msg.textContent = err; msg.classList.add('show'); return; }
    msg.classList.remove('show');
    if (W.step < 3) { W.step++; W.maxStep = Math.max(W.maxStep, W.step); renderWiz(); return; }
    const body = {
      date: W.date, time: W.time, guests: guestsOf(), kids: +W.kids || 0, stayMin: W.stayMin, tableIds: W.tableIds,
      courseId: W.courseId, source: W.source, memo: W.memo, status: 'booked',
      customerId: W.customer ? W.customer.id : null,
      customer: { name: W.name, kana: W.kana, phone: W.phone, allergy: W.allergy },
    };
    const r = await saveWithOverlapCheck(body, null);
    if (!r) return;
    wiz.close();
    S.date = W.date; S.calYm = W.date.slice(0, 7);
    toast(W.date.slice(5).replace('-', '/') + ' ' + W.time + ' ' + guestsOf() + '名様の予約を入れました');
    show(LEDGER_VIEWS.has(S.view) ? S.view : S.ledgerView);
  }

  function renderWiz() {
    const body = $('#wiz-body'); body.replaceChildren(); body.className = 'wiz-body';
    $('#wiz-msg').classList.remove('show');
    $$('#wiz-steps [data-step]').forEach((b) => { const n = +b.dataset.step; b.classList.toggle('on', n === W.step); b.classList.toggle('done', n < W.step || (n <= W.maxStep && n !== W.step)); });
    $('#wiz-back').style.visibility = W.step ? 'visible' : 'hidden';
    $('#wiz-next').textContent = W.step === 3 ? '✓' : '›';
    $('#wiz-next').setAttribute('aria-label', W.step === 3 ? '予約を確定' : '次へ');
    const p = [stepDatePeople, stepTable, stepDetail, stepConfirm][W.step](body);
    if (p && p.catch) p.catch(fail);
  }
  const q = (title, ...kids) => h('div', { class: 'q' }, h('div', { class: 'qt', text: title }), ...kids);
  function quick(items, cur, onPick) { return h('div', { class: 'quick' }, items.map(([v, label]) => h('button', { type: 'button', class: v === cur ? 'on' : '', text: label, onclick: () => onPick(v) }))); }
  // iPadでは画面の大きなテンキーで入れる。iPhoneの幅では画面に収まらないので、iPhoneの数字キーボードを使う
  const narrow = () => matchMedia('(max-width: 700px)').matches;
  function numInput(field, label) {
    const native = field === 'phone' ? 'tel' : 'numeric';
    const el = h('input', { type: 'text', inputmode: coarse && !narrow() ? 'none' : native, value: W[field], 'aria-label': label, class: W.key === field ? 'on-key' : '' });
    el.addEventListener('focus', () => { W.key = field; $$('.on-key', $('#wiz-body')).forEach((x) => x.classList.remove('on-key')); el.classList.add('on-key'); const k = $('.keypad .k-lbl'); if (k) k.textContent = label + 'を入力'; });
    el.addEventListener('input', () => { W[field] = el.value.replace(/\D/g, '').slice(0, field === 'phone' ? 15 : 3); el.value = W[field]; if (field === 'phone') phoneSearch(); });
    el.dataset.field = field;
    return el;
  }
  // 大きな数字のボタン（電話を受けながら指で押しやすいように）
  function keypad(labelOf) {
    if (narrow()) return null;
    const pad = h('div', { class: 'keypad' }, h('div', { class: 'k-lbl', text: labelOf() + 'を入力' }));
    const press = (k) => {
      const f = W.key; let v = String(W[f] || '');
      v = k === 'del' ? v.slice(0, -1) : (v + k).slice(0, f === 'phone' ? 15 : 3);
      if (f !== 'phone') v = v.replace(/^0+(?=\d)/, '');
      W[f] = v;
      const inp = $('#wiz-body [data-field="' + f + '"]'); if (inp) inp.value = v;
      if (f === 'phone') phoneSearch();
    };
    for (const k of ['1', '2', '3', '4', '5', '6', '7', '8', '9']) pad.append(h('button', { type: 'button', text: k, onclick: () => press(k) }));
    pad.append(h('span'), h('button', { type: 'button', text: '0', onclick: () => press('0') }), h('button', { type: 'button', class: 'k-del', text: '⌫', 'aria-label': '1文字消す', onclick: () => press('del') }));
    return pad;
  }

  function stepDatePeople(body) {
    const st = S.boot.settings;
    if (W.key !== 'adults' && W.key !== 'kids') W.key = 'adults';
    const dateIn = h('input', { type: 'date', value: W.date, onchange: (e) => { W.date = e.target.value; W.avail = null; renderWiz(); } });
    const timeIn = h('input', { type: 'time', step: 900, value: W.time, onchange: (e) => { W.time = e.target.value; W.avail = null; renderWiz(); } });
    const times = [];
    for (let m = Math.ceil(toMin(st.open) / 30) * 30; m < toMin(st.close); m += 30) times.push([toTime(m), toTime(m)]);
    const left = h('div', null,
      q('お日にちはいつですか？', dateIn, quick([[S.today, '今日'], [addDays(S.today, 1), '明日'], [addDays(S.today, 2), '明後日']], W.date, (v) => { W.date = v; W.avail = null; renderWiz(); }), h('div', { class: 'hint', text: C.isDate(W.date) ? jpDate(W.date) : '' })),
      q('お時間は何時からですか？', timeIn, quick(times, W.time, (v) => { W.time = v; W.avail = null; renderWiz(); })),
      q('人数は何名様ですか？', h('div', { class: 'ppl' },
        h('span', { text: '大人' }), numInput('adults', '大人の人数'), h('span', { text: '名様' }),
        h('span', { text: 'お子様' }), numInput('kids', 'お子様の人数'), h('span', { text: '名様（お席が必要なお子様）' }))));
    body.append(left, keypad(() => (W.key === 'kids' ? 'お子様の人数' : '大人の人数')));
  }

  async function stepTable(body) {
    body.className = 'wiz-body one';
    const n = guestsOf();
    const a = await api('GET', '/availability?' + qs({ date: W.date, time: W.time, stayMin: W.stayMin, guests: n }));
    const busy = new Set(a.busy);
    // 席を自動で割り当てる（空いている時刻の席から、人数に合う一番小さい席）。手で選んだ席はそのまま
    const key = W.date + W.time + n + W.stayMin;
    if (W.autoKey !== key) {
      W.autoKey = key;
      if (W.presetTables && W.tableIds.length && !W.tableIds.some((t) => busy.has(t))) W.autoNote = 'タップしたテーブルに入れます。';
      else if (a.suggest) { W.tableIds = [a.suggest]; W.autoNote = '空いているテーブルから自動で選びました。'; }
      else { W.tableIds = []; W.autoNote = '人数に合う空きテーブルがありません。ウェイティングリストに入れるか、テーブルを選んでください（複数選べます）。'; }
    }
    const capSum = W.tableIds.reduce((s, id) => s + ((S.boot.tables.find((t) => t.id === id) || {}).cap || 0), 0);
    const day = (await api('GET', '/reservations?from=' + W.date + '&to=' + W.date)).reservations.filter((r) => ACTIVE.has(r.status));
    body.append(
      h('p', { class: 'wiz-note' }, h('b', { text: jpDate(W.date) + ' ' + W.time + '〜 ' + n + '名様' }), '　' + W.autoNote),
      q('滞在時間', quick([60, 90, 120, 150, 180].map((m) => [m, m + '分']), W.stayMin, (v) => { W.stayMin = v; renderWiz(); })),
      h('p', { class: 'wiz-note' }, '選んだテーブル：', h('b', { text: tableNames(W.tableIds) || 'ウェイティングリスト' }),
        W.tableIds.length ? '（定員 ' + capSum + '名' + (capSum < n ? '・人数より少ないです' : '') + '）' : ''),
      h('div', { class: 'quick' }, h('button', { type: 'button', text: 'ウェイティングリストに入れる（席を決めない）', onclick: () => { W.tableIds = []; W.autoNote = 'ウェイティングリストに入れます。'; renderWiz(); } })));
    const mini = h('div', { class: 'grid mini-grid' });
    const wrap = h('div', { class: 'mini' }, mini);
    body.append(wrap);
    const g = buildGrid(mini, day, {
      date: W.date,
      onRow: (t, row) => {
        if (t.waiting) { if (!W.tableIds.length) row.classList.add('pick'); return; }
        if (W.tableIds.includes(t.id)) row.classList.add('pick');
        if (busy.has(t.id)) row.classList.add('busyrow');
        if (n > t.cap || n < (t.min || 1)) row.classList.add('unfit');
        row.addEventListener('click', () => {
          W.tableIds = W.tableIds.includes(t.id) ? W.tableIds.filter((x) => x !== t.id) : [...W.tableIds, t.id];
          W.autoNote = busy.has(t.id) ? 'このテーブルは、その時間に別の予約があります。' : '';
          renderWiz();
        });
      },
    });
    for (const { t, cells } of g.rowEls) {
      const mine = t.waiting ? day.filter((r) => !r.tableIds.length) : day.filter((r) => r.tableIds.includes(t.id));
      for (const r of mine) { const el = blockEl(r, g.px, g.slot, null); el.style.cursor = 'default'; cells.append(el); }
      cells.append(h('div', { class: 'sel-win', style: 'left:' + g.px(toMin(W.time)) + 'px;width:' + (W.stayMin / 30) * g.slot + 'px' }));
    }
    wrap.scrollLeft = Math.max(0, g.px(toMin(W.time)) - 2 * g.slot);
  }

  let phoneTimer;
  function phoneSearch() {
    clearTimeout(phoneTimer);
    phoneTimer = setTimeout(async () => {
      if (W.customer || W.step !== 2) return;
      const digits = String(W.phone).replace(/\D/g, '');
      W.hits = digits.length >= 4 ? (await api('GET', '/customers?limit=5&q=' + digits)).customers : [];
      renderHits();
    }, 200);
  }
  function renderHits() {
    const box = $('#wiz-hits'); if (!box) return;
    box.replaceChildren();
    if (W.customer) {
      const c = W.customer;
      box.append(h('div', { class: 'hit linked' }, h('b', { text: 'No.' + c.no + ' ' + sama(c) }), h('span', { text: c.phone }),
        h('span', { text: '来店' + c.visits + '回' + (c.last ? '・前回 ' + c.last : '') }),
        c.allergy ? h('span', { class: 'warn-t', text: '⚠' + c.allergy }) : null,
        c.cancels || c.noshows ? h('span', { class: 'warn-t', text: 'キャンセル' + c.cancels + '・無断' + c.noshows }) : null,
        c.memo ? h('span', { class: 'muted', text: c.memo }) : null,
        h('button', { type: 'button', text: '別の方にする', onclick: () => { W.customer = null; W.name = ''; W.kana = ''; W.allergy = ''; renderWiz(); } })));
      return;
    }
    for (const c of W.hits) {
      box.append(h('div', { class: 'hit' }, h('b', { text: 'No.' + c.no + ' ' + sama(c) }), h('span', { text: c.phone }),
        h('span', { text: '来店' + c.visits + '回' + (c.last ? '・前回 ' + c.last : '') }),
        c.allergy ? h('span', { class: 'warn-t', text: '⚠' + c.allergy }) : null,
        h('button', { type: 'button', class: 'primary', text: 'この方で入れる', onclick: () => { W.customer = c; W.phone = c.phone.replace(/\D/g, ''); W.name = c.name; W.kana = c.kana; W.allergy = c.allergy; renderWiz(); } })));
    }
    if (!W.hits.length && String(W.phone).replace(/\D/g, '').length >= 10) box.append(h('p', { class: 'hint', text: '登録のない電話番号です。初めてのお客様として登録されます。' }));
  }

  function stepDetail(body) {
    W.key = 'phone';
    const txt = (field, ph) => h('input', { type: 'text', value: W[field], placeholder: ph || '', oninput: (e) => { W[field] = e.target.value; } });
    const course = h('select', { onchange: (e) => { W.courseId = e.target.value; } }, h('option', { value: '', text: 'なし・席のみ' }), S.boot.courses.map((c) => h('option', { value: c.id, text: c.name + (c.price ? '（' + yen(c.price) + '）' : '') })));
    course.value = W.courseId;
    const left = h('div', null,
      q('お電話番号を教えてください。', numInput('phone', '電話番号'), h('div', { id: 'wiz-hits', class: 'match' })),
      q('お名前を教えてください。', h('div', { class: 'row' }, txt('name', 'お名前'), txt('kana', 'ふりがな'))),
      q('アレルギーや苦手なものはありますか？', txt('allergy', 'なければ空のまま')),
      q('コース', course),
      q('ご予約の経路', quick(S.boot.sources.map((s) => [s, s]), W.source, (v) => { W.source = v; renderWiz(); })),
      q('メモ', h('textarea', { rows: 2, value: W.memo, oninput: (e) => { W.memo = e.target.value; } })));
    body.append(left, keypad(() => '電話番号'));
    renderHits();
    if (!W.customer && W.phone) phoneSearch();
  }

  function stepConfirm(body) {
    body.className = 'wiz-body one';
    const n = guestsOf(), c = W.customer;
    const dl = h('dl', { class: 'confirm-list' });
    const row = (k, v) => dl.append(h('dt', { text: k }), h('dd', { text: v || '—' }));
    row('日付', jpDate(W.date));
    row('時間', W.time + '〜' + toTime(toMin(W.time) + W.stayMin) + '（' + W.stayMin + '分）');
    row('人数', n + '名様' + (+W.kids ? '（大人' + (+W.adults || 0) + '・お子様' + W.kids + '）' : ''));
    row('テーブル', tableNames(W.tableIds) || 'ウェイティングリスト');
    row('お名前', W.name ? W.name + ' 様' + (W.kana ? '（' + W.kana + '）' : '') : '');
    row('電話番号', W.phone);
    row('お客様', c ? 'No.' + c.no + '・来店' + c.visits + '回' : (W.name || W.phone ? '初めてのお客様（新しく登録）' : 'お名前なし'));
    row('アレルギー', W.allergy);
    row('コース', courseName(W.courseId) || 'なし・席のみ');
    row('経路', W.source);
    row('メモ', W.memo);
    body.append(h('p', { class: 'wiz-note', text: 'この内容でよければ、右下の ✓ を押してください。' }), dl);
  }

  // ---------- 顧客台帳 ----------
  let cTimer;
  $('#c-q').addEventListener('input', () => { clearTimeout(cTimer); cTimer = setTimeout(() => loadCustomers().catch(fail), 250); });
  $('#c-stale').addEventListener('change', () => loadCustomers().catch(fail));
  $('#c-reset').addEventListener('click', () => { $('#c-q').value = ''; $('#c-stale').checked = false; S.custTag = ''; S.custVisits = 0; loadCustomers().catch(fail); });
  $('#c-new').addEventListener('click', () => openCust(null));
  $$('#c-sort button').forEach((b) => b.addEventListener('click', () => { S.custSort = b.dataset.sort; loadCustomers().catch(fail); }));

  async function loadCustomers() {
    const r = await api('GET', '/customers?' + qs({ limit: 1000, q: $('#c-q').value, sort: S.custSort, tag: S.custTag, minVisits: S.custVisits || '', stale: $('#c-stale').checked ? 1 : '' }));
    const filtered = $('#c-q').value || S.custTag || S.custVisits || $('#c-stale').checked;
    $('#c-title').textContent = '顧客台帳：' + (filtered ? '絞り込み' : '全てのお客様') + '（' + r.total + '人' + (filtered ? '／全' + r.all + '人' : '') + '）';
    $$('#c-sort button').forEach((b) => b.classList.toggle('on', b.dataset.sort === S.custSort));
    const tags = $('#c-tags'); tags.replaceChildren();
    for (const t of r.tags) tags.append(h('button', { type: 'button', class: S.custTag === t ? 'on' : '', text: t, onclick: () => { S.custTag = S.custTag === t ? '' : t; loadCustomers().catch(fail); } }));
    if (!r.tags.length) tags.append(h('span', { class: 'hint', text: 'タグはまだありません' }));
    const vs = $('#c-visits'); vs.replaceChildren();
    for (const n of [1, 2, 5, 10]) vs.append(h('button', { type: 'button', class: S.custVisits === n ? 'on' : '', text: n + '回以上', onclick: () => { S.custVisits = S.custVisits === n ? 0 : n; loadCustomers().catch(fail); } }));
    const ul = $('#c-list'); ul.replaceChildren();
    for (const c of r.customers) {
      const sub = [c.company, c.tags.filter((x) => !/^vip$/i.test(x)).join('・'), c.allergy ? '⚠' + c.allergy : '', c.memo].filter(Boolean).join('　');
      ul.append(h('li', { class: S.custSel === c.id ? 'sel' : '', onclick: () => { S.custSel = c.id; $$('#c-list li').forEach((x) => x.classList.remove('sel')); ul.children[r.customers.indexOf(c)].classList.add('sel'); custDetail(c.id).catch(fail); } },
        h('div', { class: 'cn' }, h('b', { text: c.name || c.phone || 'お名前なし' }), h('small', { text: sub || (c.kana || '') })),
        isVip(c) ? h('span', { class: 'badge vip', text: 'VIP' }) : null,
        h('span', { class: 'vcircle', text: c.visits, title: '来店回数' })));
    }
    if (!r.customers.length) ul.append(h('li', { class: 'muted', text: r.all ? '見つかりません' : 'お客様はまだいません。予約を入れると自動で登録されます。' }));
    if (S.custSel) custDetail(S.custSel).catch(() => { S.custSel = null; clearDetail(); }); else clearDetail();
  }
  function clearDetail() { const d = $('#c-detail'); d.classList.add('empty'); d.replaceChildren(h('p', { class: 'muted', text: 'お客様を選ぶと、ここに詳しい情報が出ます。' })); }

  async function custDetail(id) {
    const { customer: c, history } = await api('GET', '/customers/' + id);
    const box = $('#c-detail'); box.classList.remove('empty'); box.replaceChildren();
    const kv = (k, v) => [h('dt', { text: k }), h('dd', null, v || '—')];
    box.append(
      h('div', { class: 'actions' }, h('span', { class: 'muted', text: 'No.' + c.no }), h('span', { class: 'sep' }), h('button', { text: '✕', 'aria-label': '閉じる', class: 'ghost', onclick: () => { S.custSel = null; $$('#c-list li').forEach((x) => x.classList.remove('sel')); clearDetail(); } })),
      h('h3', null, c.name ? c.name + ' 様' : (c.phone || 'お名前なし'), isVip(c) ? h('span', { class: 'badge vip', text: 'VIP' }) : null),
      h('div', { class: 'muted', text: c.kana || '' }),
      h('dl', { class: 'kvs' },
        kv('電話番号', c.phone), kv('会社名', c.company), kv('記念日', c.anniv),
        kv('タグ', c.tags.length ? c.tags.map((x) => h('span', { class: /^vip$/i.test(x) ? 'badge vip' : 'badge tag', text: x })) : ''),
        kv('アレルギー', c.allergy), kv('来店', c.visits + '回（キャンセル' + c.cancels + '・無断' + c.noshows + '）'),
        kv('前回・次回', (c.last || '—') + ' ／ ' + (c.next || '—')), kv('メモ', c.memo)),
      h('div', { class: 'actions' }, h('button', { text: '編集', onclick: () => openCust(c) }), h('button', { class: 'primary', text: 'この方の予約を入れる', onclick: () => { openWizard({ date: S.today }); W.customer = c; W.phone = c.phone.replace(/\D/g, ''); W.name = c.name; W.kana = c.kana; W.allergy = c.allergy; } })),
      h('h3', { text: '来店の履歴', style: 'font-size:14px;margin-top:18px' }));
    const t = h('table', { class: 'tbl' }, h('thead', null, h('tr', null, ['日付', '時刻', '人数', 'テーブル', 'コース', '状態'].map((x) => h('th', { text: x })))));
    const tb = h('tbody');
    for (const r of history) tb.append(h('tr', { onclick: () => openRes({ ...r, customer: c }) }, h('td', { text: r.date }), h('td', { text: r.time }), h('td', { text: r.guests + '名' }), h('td', { text: tableNames(r.tableIds) || 'ウェイティング' }), h('td', { text: courseName(r.courseId) }), h('td', null, h('span', { class: 'pill ' + r.status, text: STATUS[r.status] }))));
    if (!history.length) tb.append(h('tr', null, h('td', { colspan: 6, class: 'muted', text: '予約の記録はまだありません' })));
    t.append(tb); box.append(t);
  }

  const cdlg = $('#dlg-cust'), cform = $('#cust-form');
  let cEditing = null;
  function openCust(c) {
    cEditing = c; const f = cform.elements;
    $('#cust-title').textContent = c ? 'お客様の情報（No.' + c.no + '）' : 'お客様を登録';
    for (const k of ['name', 'kana', 'phone', 'company', 'anniv', 'allergy', 'memo']) f[k].value = c ? c[k] || '' : '';
    f.tags.value = c ? c.tags.join('、') : '';
    $('#cust-del').hidden = !c; $('#cust-err').textContent = '';
    cdlg.showModal(); f.name.focus();
  }
  $('#cust-cancel').addEventListener('click', () => cdlg.close());
  cform.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = cform.elements;
    const body = { tags: f.tags.value.split(/[、,，\s]+/).filter(Boolean) };
    for (const k of ['name', 'kana', 'phone', 'company', 'anniv', 'allergy', 'memo']) body[k] = f[k].value;
    try {
      const r = await api(cEditing ? 'PUT' : 'POST', '/customers' + (cEditing ? '/' + cEditing.id : ''), body);
      S.custSel = r.customer.id; cdlg.close(); toast('保存しました'); loadCustomers().catch(fail);
    } catch (err) { $('#cust-err').textContent = err.message; }
  });
  $('#cust-del').addEventListener('click', async () => {
    if (!cEditing) return;
    if (!confirm('No.' + cEditing.no + ' ' + (cEditing.name || '') + ' 様の情報（お名前・電話・メモ）を消します。元に戻せません。\n予約の記録は「お名前なし」として残り、件数の集計には使われます。\n消しますか？')) return;
    try { await api('DELETE', '/customers/' + cEditing.id); S.custSel = null; cdlg.close(); toast('消しました'); loadCustomers().catch(fail); } catch (err) { fail(err); }
  });

  // ---------- 集計 ----------
  let statsInit = false;
  async function initStats() {
    if (!statsInit) { const d = parseDate(S.today); $('#s-from').value = fmtDate(new Date(d.getFullYear(), d.getMonth(), 1)); $('#s-to').value = fmtDate(new Date(d.getFullYear(), d.getMonth() + 1, 0)); statsInit = true; }
    const r = await api('GET', '/stats?from=' + $('#s-from').value + '&to=' + $('#s-to').value);
    const t = r.totals, box = $('#s-body'); box.replaceChildren();
    const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : 0) + '%';
    const card = (k, v, u) => h('div', { class: 'stat' }, h('div', { class: 'k', text: k }), h('span', { class: 'v', text: v }), h('span', { class: 'u', text: u || '' }));
    box.append(h('div', { class: 'stat-cards' },
      card('予約（キャンセル除く）', t.groups, '組'), card('人数', t.guests, '名'), card('昼', t.lunchGroups + '組', t.lunchGuests + '名'), card('夜', t.dinnerGroups + '組', t.dinnerGuests + '名'),
      card('キャンセル率', pct(t.cancels + t.noshows, t.all), '（無断 ' + t.noshows + '件）'),
      card('来店のうち初めて', pct(t.firstTime, t.visitedGroups), t.firstTime + '組'), card('来店のうち2回目以上', pct(t.repeat, t.visitedGroups), t.repeat + '組'), card('お名前なしの来店', t.noName, '組')));
    const two = h('div', { class: 'two' });
    const srcP = h('div', { class: 'panel' }, h('h3', { text: '予約の経路' }));
    const maxS = Math.max(1, ...Object.values(r.bySource).map((x) => x.all));
    for (const [k, v] of Object.entries(r.bySource).sort((a, b) => b[1].all - a[1].all)) srcP.append(bar(k, v.all / maxS, v.groups + '組 ' + v.guests + '名' + (v.cancels + v.noshows ? '・取消' + (v.cancels + v.noshows) : '')));
    if (!Object.keys(r.bySource).length) srcP.append(h('p', { class: 'muted', text: 'この期間の予約はありません' }));
    const wdP = h('div', { class: 'panel' }, h('h3', { text: '曜日（キャンセル除く）' }));
    const maxW = Math.max(1, ...r.byWeekday.map((x) => x.groups));
    [1, 2, 3, 4, 5, 6, 0].forEach((i) => wdP.append(bar(WD[i] + '曜', r.byWeekday[i].groups / maxW, r.byWeekday[i].groups + '組 ' + r.byWeekday[i].guests + '名')));
    two.append(srcP, wdP);
    const rp = r.repeat;
    box.append(two, h('div', { class: 'panel' }, h('h3', { text: 'お客様の来店回数（全期間・予約で来店したお客様）' }),
      h('p', { text: '来店したお客様 ' + rp.customers + '名のうち、1回だけ ' + rp.once + '名（' + pct(rp.once, rp.customers) + '）、2回以上 ' + rp.twoPlus + '名（' + pct(rp.twoPlus, rp.customers) + '）、5回以上 ' + rp.fivePlus + '名（' + pct(rp.fivePlus, rp.customers) + '）' }),
      h('p', { class: 'hint', text: '状態を「来店」「退店」にした予約だけを来店として数えます。予約なしのお客様（飛び込み）は、予約として入れた時だけ数に入ります。' })));
  }
  function bar(label, ratio, val) { return h('div', { class: 'bar-row' }, h('span', { text: label }), h('div', { class: 'track' }, h('div', { class: 'fill', style: 'width:' + Math.round(ratio * 100) + '%' })), h('span', { class: 'muted', text: val })); }
  $('#s-go').addEventListener('click', () => initStats().catch(fail));
  $('#s-csv').addEventListener('click', async () => {
    try {
      if (!L) return showGate();
      const from = $('#s-from').value, to = $('#s-to').value;
      const csv = L.posLinkCsv(from, to);
      await persist();
      const r = await shareOrDownload('レジ連携用_' + from + '_' + to + '.csv', new Blob([csv], { type: 'text/csv' }));
      if (r !== 'aborted') toast('書き出しました（お名前・電話番号は入っていません）');
    } catch (e) { fail(e); }
  });

  // ---------- 設定 ----------
  async function renderSettings() {
    S.boot = await api('GET', '/bootstrap');
    const st = S.boot.settings, box = $('#set-body'); box.replaceChildren();
    const inp = (name, val, type, extra) => h('input', { name, value: val, type: type || 'text', ...(extra || {}) });
    const lab = (t, el) => h('label', null, t, el);

    const sform = h('form', { class: 'panel' },
      h('h3', { text: 'お店' }),
      h('div', { class: 'row' }, lab('お店の名前（画面の左上に出ます）', inp('storeName', st.storeName)), lab('開店', inp('open', st.open, 'time')), lab('閉店', inp('close', st.close, 'time')), lab('昼と夜の境目', inp('lunchEnd', st.lunchEnd, 'time'))),
      h('div', { class: 'row' }, lab('ふつうの滞在時間（分）', inp('defaultStayMin', st.defaultStayMin, 'number', { min: 15, max: 720, step: 15 })),
        lab('操作がない時に自動でロック（分）', inp('autoLockMin', st.autoLockMin, 'number', { min: 1, max: 1440 })),
        lab('お客様情報の保管年数（最後の予約から）', inp('retentionYears', st.retentionYears, 'number', { min: 1, max: 20 }))),
      h('div', { class: 'actions' }, h('span', { class: 'sep' }), h('button', { class: 'primary', text: '保存' })));
    sform.addEventListener('submit', async (e) => {
      e.preventDefault();
      const f = sform.elements;
      const s = {}; ['storeName', 'open', 'close', 'lunchEnd'].forEach((k) => { s[k] = f[k].value; }); ['defaultStayMin', 'autoLockMin', 'retentionYears'].forEach((k) => { s[k] = +f[k].value; });
      try { S.boot = await api('PUT', '/settings', { settings: s }); $('#store-name').textContent = S.boot.settings.storeName || '予約台帳'; toast('保存しました'); renderSettings().catch(fail); } catch (err) { fail(err); }
    });

    // テーブル
    const tRows = h('tbody');
    const addTRow = (t) => tRows.append(h('tr', { 'data-id': t.id || '' },
      h('td', null, h('input', { value: t.name, 'data-k': 'name', 'aria-label': 'テーブルの名前' })),
      h('td', { class: 'small' }, h('input', { value: t.min || 1, type: 'number', min: 1, max: 200, 'data-k': 'min', 'aria-label': '最小人数' })),
      h('td', { class: 'small' }, h('input', { value: t.cap, type: 'number', min: 1, max: 200, 'data-k': 'cap', 'aria-label': '最大人数' })),
      h('td', null, h('input', { value: t.area, 'data-k': 'area', 'aria-label': 'エリア' })), h('td', { class: 'small' }, h('input', { value: t.pos, 'data-k': 'pos', 'aria-label': 'レジの席番号' })),
      h('td', null, h('button', { type: 'button', text: '↑', title: '上へ', onclick: (e) => { const tr = e.target.closest('tr'); if (tr.previousElementSibling) tr.parentNode.insertBefore(tr, tr.previousElementSibling); } }),
        h('button', { type: 'button', text: '外す', onclick: (e) => e.target.closest('tr').remove() }))));
    S.boot.tables.forEach(addTRow);
    const tPanel = h('div', { class: 'panel' }, h('h3', { text: 'テーブル（タイムテーブルの上から順に並びます）' }),
      h('p', { class: 'hint', text: '定員は「最小〜最大」の人数です。新規予約では、人数がこの範囲に入る空きテーブルのうち、いちばん小さいものを自動で選びます。「レジの席番号」は、あとでレジのデータとつなぐ時に使います。外したテーブルに入っていた予約はウェイティングリストに移ります。' }),
      h('div', { class: 'table-wrap' }, h('table', { class: 'tbl edit-table' }, h('thead', null, h('tr', null, ['名前', '最小', '最大', 'エリア', 'レジの席番号', ''].map((x) => h('th', { text: x })))), tRows)),
      h('div', { class: 'actions' }, h('button', { type: 'button', text: '＋ テーブルを足す', onclick: () => addTRow({ name: '', min: 1, cap: 4, area: '', pos: '' }) }), h('span', { class: 'sep' }),
        h('button', { class: 'primary', type: 'button', text: 'テーブルを保存', onclick: async () => {
          const tables = $$('tr', tRows).map((tr) => ({ id: tr.dataset.id, name: $('[data-k=name]', tr).value, min: +$('[data-k=min]', tr).value, cap: +$('[data-k=cap]', tr).value, area: $('[data-k=area]', tr).value, pos: $('[data-k=pos]', tr).value }));
          try { S.boot = await api('PUT', '/settings', { tables }); toast('テーブルを保存しました'); renderSettings().catch(fail); } catch (err) { fail(err); }
        } })));

    // コース
    const kRows = h('tbody');
    const addKRow = (c) => kRows.append(h('tr', { 'data-id': c.id || '' },
      h('td', null, h('input', { value: c.name, 'data-k': 'name', 'aria-label': 'コース名' })), h('td', { class: 'small' }, h('input', { value: c.price, type: 'number', min: 0, 'data-k': 'price', 'aria-label': '金額' })),
      h('td', null, h('button', { type: 'button', text: '外す', onclick: (e) => e.target.closest('tr').remove() }))));
    S.boot.courses.forEach(addKRow);
    const kPanel = h('div', { class: 'panel' }, h('h3', { text: 'コース' }),
      h('div', { class: 'table-wrap' }, h('table', { class: 'tbl edit-table' }, h('thead', null, h('tr', null, ['コース名（レジの商品名と同じにすると、あとでつなぎやすい）', '金額（税込・1人）', ''].map((x) => h('th', { text: x })))), kRows)),
      h('div', { class: 'actions' }, h('button', { type: 'button', text: '＋ コースを足す', onclick: () => addKRow({ name: '', price: 0 }) }), h('span', { class: 'sep' }),
        h('button', { class: 'primary', type: 'button', text: 'コースを保存', onclick: async () => {
          const courses = $$('tr', kRows).map((tr) => ({ id: tr.dataset.id, name: $('[data-k=name]', tr).value, price: +$('[data-k=price]', tr).value || 0 }));
          try { S.boot = await api('PUT', '/settings', { courses }); fillSelects(); toast('コースを保存しました'); renderSettings().catch(fail); } catch (err) { fail(err); }
        } })));

    // 合言葉
    const pform = h('form', { class: 'panel', autocomplete: 'off' }, h('h3', { text: '合言葉を変える' }),
      h('div', { class: 'row' }, lab('今の合言葉', inp('oldPass', '', 'password')), lab('新しい合言葉（8文字以上）', inp('newPass', '', 'password')), lab('もう一度', inp('newPass2', '', 'password'))),
      h('div', { class: 'actions' }, h('span', { class: 'sep' }), h('button', { class: 'primary', text: '変える' })));
    pform.addEventListener('submit', async (e) => {
      e.preventDefault(); const f = pform.elements;
      try {
        if (f.newPass.value !== f.newPass2.value) throw new Error('確認用の合言葉が一致しません');
        touch();
        L._log('合言葉を変更');
        await saving.catch(() => {});
        await vault.changePass(f.oldPass.value, f.newPass.value, L.db);
        pform.reset(); toast('合言葉を変えました。新しい合言葉を紙に控え、バックアップも書き出し直してください');
      } catch (err) { fail(err); }
    });

    // バックアップと記録
    const lg = await api('GET', '/log');
    const snaps = await vault.snapshots();
    const last = L.db.lastBackupAt;
    const doExport = async (snap) => {
      try {
        const text = await vault.exportText(snap);
        const name = '予約台帳_' + (snap || C.localDate()) + '.yoyaku';
        const r = await shareOrDownload(name, new Blob([text], { type: 'application/octet-stream' }));
        if (r === 'aborted') return;
        if (!snap) { L.db.lastBackupAt = new Date().toISOString(); L._log('バックアップを書き出し'); await persist(); }
        toast('書き出しました。iPadの外（Macや外付け）にも置いてください');
        renderSettings().catch(fail);
      } catch (err) { fail(err); }
    };
    const snapSel = h('select', { 'aria-label': '控えの日付' }, snaps.map((d) => h('option', { value: d, text: d })));
    const fileIn = h('input', { type: 'file', accept: '.yoyaku,application/octet-stream,application/json,text/plain' });
    const passIn = h('input', { type: 'password', placeholder: 'そのバックアップを作った時の合言葉', autocomplete: 'off' });
    const bPanel = h('div', { class: 'panel' }, h('h3', { text: '保存場所とバックアップ' }),
      h('dl', { class: 'kvs' },
        h('dt', { text: '保存場所' }), h('dd', { text: 'このiPad（このブラウザ）の中。暗号化して保存しています。' }),
        h('dt', { text: '勝手に消されない設定' }), h('dd', { text: S.persisted ? 'オン' : 'オフ（ホーム画面に追加したアイコンから開くと、オンになりやすくなります）' }),
        h('dt', { text: '最後のバックアップ' }), h('dd', { text: last ? new Date(last).toLocaleString('ja-JP') : 'まだありません' }),
        h('dt', { text: '毎日の控え' }), h('dd', { text: snaps.length ? snaps.length + '日分（14日分を残します）' : 'まだありません（明日以降の最初の保存で作られます）' })),
      h('p', { class: 'hint', text: 'iPadが壊れた・なくした・ブラウザのデータを消した時に備えて、週に1回はバックアップを書き出し、「ファイル」アプリやAirDropでiPadの外に置いてください。ファイルは暗号化されたままで、合言葉がなければ読めません。' }),
      h('div', { class: 'actions' }, h('button', { class: 'primary', type: 'button', text: 'バックアップを書き出す', onclick: () => doExport(null) }),
        snaps.length ? h('span', { class: 'muted', text: '／ 控えから：' }) : null, snaps.length ? snapSel : null,
        snaps.length ? h('button', { type: 'button', text: 'この日の控えを書き出す', onclick: () => doExport(snapSel.value) }) : null),
      h('details', { style: 'margin-top:10px' }, h('summary', { text: 'バックアップから戻す' }),
        h('p', { class: 'hint', text: '今の台帳は、その日の控えに残してから置き換えます。戻したあとは、そのバックアップを作った時の合言葉で開きます。' }),
        h('div', { class: 'row' }, fileIn, passIn),
        h('div', { class: 'actions' }, h('span', { class: 'sep' }), h('button', { class: 'danger', type: 'button', text: '戻す', onclick: async () => {
          try {
            const f = fileIn.files && fileIn.files[0];
            if (!f) throw new Error('バックアップのファイルを選んでください');
            if (!confirm('今の台帳を「' + f.name + '」の中身で置き換えます。\n今の台帳は今日の控えに残ります。\n戻しますか？')) return;
            const db = await vault.importText(await f.text(), passIn.value);
            L = new C.Ledger(db); L._log('バックアップから戻す'); await persist();
            toast('戻しました'); await enter();
          } catch (err) { fail(err); }
        } }))));
    const lPanel = h('details', { class: 'panel' }, h('summary', { text: '操作の記録（だれが何をしたかの目安。お客様の名前は記録しません）' }),
      h('div', { class: 'table-wrap', style: 'max-height:300px;margin-top:8px' }, h('table', { class: 'tbl' }, h('tbody', null, lg.log.map((x) => h('tr', null, h('td', { text: new Date(x.t).toLocaleString('ja-JP') }), h('td', { text: x.act }), h('td', { text: x.ref })))))));

    box.append(sform, tPanel, kPanel, pform, bPanel, lPanel);
  }

  start().catch((e) => { document.body.textContent = '予約台帳を開けませんでした。（' + e.message + '）'; });
})();
