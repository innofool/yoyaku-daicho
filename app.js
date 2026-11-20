'use strict';
// 予約台帳の画面。データはすべてこのパソコンのサーバー（127.0.0.1）とだけやりとりする。
// お客様の文字は必ず textContent で表示する（画面に仕込まれた文字が命令として動かないように）。
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
  const yen = (n) => '¥' + Number(n || 0).toLocaleString('ja-JP');

  const S = { today: '', date: '', calYm: '', boot: null, day: [], view: 'ledger', custSel: null };

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
    } else if (p === '/month' && method === 'GET') out = L.month(q.ym);
    else if (p === '/customers' && method === 'GET') out = L.listCustomers({ q: q.q, stale: q.stale === '1', limit: q.limit });
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
  function toast(msg, bad) {
    const t = $('#toast'); t.textContent = msg; t.className = 'toast show' + (bad ? ' bad' : '');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.className = 'toast'; }, bad ? 4000 : 2000);
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
  $('#btn-lock').addEventListener('click', () => lockNow('ロック'));

  async function enter() {
    S.boot = await api('GET', '/bootstrap');
    $('#gate').hidden = true; $('#app').hidden = false;
    $('#store-name').textContent = S.boot.settings.storeName || '予約台帳';
    if (!S.date) S.date = S.today;
    S.calYm = S.date.slice(0, 7);
    fillSelects();
    show(S.view);
  }

  // ---------- 画面の切り替え ----------
  $$('.tabs button').forEach((b) => b.addEventListener('click', () => show(b.dataset.view)));
  function show(view) {
    S.view = view;
    $$('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
    $$('.view').forEach((v) => { v.hidden = v.id !== 'v-' + view; });
    ({ ledger: loadDay, list: initList, customers: loadCustomers, stats: initStats, settings: renderSettings })[view]().catch(fail);
  }

  // ---------- 台帳 ----------
  $('#d-prev').addEventListener('click', () => goDate(addDays(S.date, -1)));
  $('#d-next').addEventListener('click', () => goDate(addDays(S.date, 1)));
  $('#d-today').addEventListener('click', () => goDate(S.today));
  $('#show-cancel').addEventListener('change', () => renderDay());
  function goDate(d) { S.date = d; S.calYm = d.slice(0, 7); loadDay().catch(fail); }

  async function loadDay() {
    const [r, m] = await Promise.all([api('GET', '/reservations?from=' + S.date + '&to=' + S.date), api('GET', '/month?ym=' + S.calYm)]);
    S.day = r.reservations;
    S.month = m;
    renderDay();
    renderCal();
  }

  function hoursRange() {
    const st = S.boot.settings;
    let s = Math.floor(toMin(st.open) / 60) * 60, e = Math.ceil(toMin(st.close) / 60) * 60;
    for (const r of S.day) { s = Math.min(s, Math.floor(toMin(r.time) / 60) * 60); e = Math.max(e, Math.ceil((toMin(r.time) + r.stayMin) / 60) * 60); }
    return [s, Math.min(e, 30 * 60)];
  }

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

  function renderDay() {
    $('#day-title').textContent = jpDate(S.date) + (S.date === S.today ? ' 今日' : '');
    const showCancel = $('#show-cancel').checked;
    const list = S.day.filter((r) => showCancel || ACTIVE.has(r.status));
    const over = overlapIds(S.day);
    const [s, e] = hoursRange();
    const slot = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--slot')) || 44;
    const slots = (e - s) / 30;
    const px = (m) => ((m - s) / 30) * slot;

    const grid = $('#grid'); grid.replaceChildren();
    const head = h('div', { class: 'g-head' }, h('div', { class: 'g-corner' }));
    for (let m = s; m < e; m += 60) head.append(h('div', { class: 'g-hour', text: (m / 60) + ':00' }));
    grid.append(head);

    const tables = S.boot.tables;
    const unassigned = list.filter((r) => !r.tableIds.length);
    const rows = [{ id: '', name: '席未定', cap: '', area: '', un: true }, ...tables];
    let lastArea = null;
    for (const t of rows) {
      if (t.un && !unassigned.length) continue;
      const cells = h('div', { class: 'g-cells', style: 'width:' + slots * slot + 'px' });
      for (let i = 0; i < slots; i++) {
        const tm = s + i * 30;
        cells.append(h('div', { class: 'g-cell' + (tm % 60 === 0 ? ' h' : ''), title: toTime(tm) + ' ' + t.name + ' に予約を入れる', onclick: () => openRes(null, { date: S.date, time: toTime(tm), tableIds: t.id ? [t.id] : [] }) }));
      }
      const mine = t.un ? unassigned : list.filter((r) => r.tableIds.includes(t.id));
      for (const r of mine) {
        const nm = r.customer ? (r.customer.name || r.customer.phone || '（お名前なし）') : '（お名前なし）';
        const sub = [r.guests + '名', courseName(r.courseId), r.customer && r.customer.allergy ? '⚠' + r.customer.allergy : '', r.memo].filter(Boolean).join(' ');
        cells.append(h('div', {
          class: 'blk ' + r.status + (over.has(r.id) ? ' over' : ''),
          style: 'left:' + px(toMin(r.time)) + 'px;width:' + Math.max(slot - 4, (r.stayMin / 30) * slot - 3) + 'px',
          title: r.time + '〜' + toTime(toMin(r.time) + r.stayMin) + ' ' + nm + ' ' + sub + (over.has(r.id) ? '（席が重なっています）' : ''),
          onclick: (ev) => { ev.stopPropagation(); openRes(r); },
        }, h('div', { class: 't', text: r.time + ' ' + nm }), h('div', { class: 's', text: sub })));
      }
      if (S.date === S.today) {
        const now = new Date(), nm = now.getHours() * 60 + now.getMinutes();
        if (nm >= s && nm <= e) cells.append(h('div', { class: 'g-now', style: 'left:' + px(nm) + 'px' }));
      }
      const top = !t.un && t.area !== lastArea && lastArea !== null;
      if (!t.un) lastArea = t.area;
      grid.append(h('div', { class: 'g-row' + (t.un ? ' unassigned' : '') + (top ? ' area-top' : '') },
        h('div', { class: 'g-name' }, h('b', { text: t.name }), h('small', { text: t.un ? '席を決めてください' : [t.area, t.cap + '名'].filter(Boolean).join('・') })), cells));
    }
    // 今の時刻のあたりまで横に送る
    if (S.date === S.today) {
      const now = new Date(); const nm = now.getHours() * 60 + now.getMinutes();
      $('#grid-wrap').scrollLeft = Math.max(0, px(nm) - 3 * slot);
    }
    renderDayList(over);
  }

  // 画面の向き・大きさが変わったら、マスの幅に合わせて台帳を描き直す
  let resizeTimer;
  window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (L && S.view === 'ledger' && S.boot) renderDay(); }, 150); });

  function courseName(id) { const c = S.boot.courses.find((x) => x.id === id); return c ? c.name : ''; }
  function tableNames(ids) { return ids.map((id) => (S.boot.tables.find((t) => t.id === id) || {}).name).filter(Boolean).join('・'); }

  function renderDayList(over) {
    const box = $('#daylist'); box.replaceChildren();
    const act = S.day.filter((r) => ACTIVE.has(r.status));
    const sum = (f) => act.filter(f).reduce((a, r) => a + r.guests, 0);
    const le = toMin(S.boot.settings.lunchEnd);
    $('#day-sum').replaceChildren(
      kv('予約', act.length + '組 ' + sum(() => true) + '名'),
      kv('昼', act.filter((r) => toMin(r.time) < le).length + '組 ' + sum((r) => toMin(r.time) < le) + '名'),
      kv('夜', act.filter((r) => toMin(r.time) >= le).length + '組 ' + sum((r) => toMin(r.time) >= le) + '名'),
      kv('来店済み', act.filter((r) => r.status !== 'booked').length + '組'),
      kv('キャンセル', S.day.filter((r) => !ACTIVE.has(r.status)).length + '組'),
    );
    const lastB = L && L.db.lastBackupAt;
    if (L && L.db.reservations.length && (!lastB || Date.now() - Date.parse(lastB) > 7 * 86400000)) {
      $('#day-sum').append(h('button', { class: 'warn-btn', text: lastB ? 'バックアップが7日以上前です' : 'バックアップがまだありません', onclick: () => show('settings') }));
    }
    box.append(h('h3', { text: 'この日の予約（' + S.day.length + '件）' }));
    if (!S.day.length) box.append(h('p', { class: 'muted', text: '予約はまだありません。台帳のマスを押すと入れられます。' }));
    for (const r of S.day) {
      const c = r.customer;
      const badges = [];
      if (c) {
        badges.push(c.visits ? h('span', { class: 'badge', text: (r.status === 'booked' ? c.visits + 1 : c.visits) + '回目' }) : h('span', { class: 'badge new', text: '初めて' }));
        c.tags.forEach((t) => badges.push(h('span', { class: 'badge tag', text: t })));
      }
      const warns = [];
      if (c && c.allergy) warns.push('⚠ ' + c.allergy);
      if (c && (c.noshows || c.cancels)) warns.push('過去にキャンセル' + c.cancels + '回・無断' + c.noshows + '回');
      if (over.has(r.id)) warns.push('席が重なっています');
      if (!r.tableIds.length && ACTIVE.has(r.status)) warns.push('席が未定です');
      const acts = h('div', { class: 'acts' });
      const st = (s, label) => acts.append(h('button', { text: label, onclick: (ev) => { ev.stopPropagation(); setStatus(r, s); } }));
      if (r.status === 'booked') { st('seated', '来店'); st('cancel', 'キャンセル'); st('noshow', '無断'); }
      else if (r.status === 'seated') { st('left', '退店'); st('booked', '戻す'); }
      else st('booked', '予約に戻す');
      box.append(h('div', { class: 'card ' + r.status, onclick: () => openRes(r) },
        h('div', { class: 'l1' }, h('span', { class: 'tm', text: r.time }), h('span', { class: 'nm', text: c ? (c.name || c.phone) : '（お名前なし）' }), h('span', { text: r.guests + '名' })),
        h('div', { class: 'l2', text: [STATUS[r.status], tableNames(r.tableIds) || '席未定', courseName(r.courseId), r.source].filter(Boolean).join(' / ') }),
        badges.length ? h('div', { class: 'l2' }, badges) : null,
        r.memo ? h('div', { class: 'l2', text: '📝 ' + r.memo }) : null,
        warns.map((w) => h('div', { class: 'warn', text: w })),
        acts));
    }
  }
  function kv(k, v) { return h('div', { class: 'kv' }, h('span', { text: k }), h('b', { text: v })); }

  async function setStatus(r, s) {
    try { await api('PUT', '/reservations/' + r.id + '/status', { status: s }); toast(STATUS[s] + 'にしました'); await loadDay(); } catch (e) { fail(e); }
  }

  function renderCal() {
    const cal = $('#cal'); cal.replaceChildren();
    const [y, m] = S.calYm.split('-').map(Number);
    const first = new Date(y, m - 1, 1);
    const moveCal = (n) => { const d = new Date(y, m - 1 + n, 1); S.calYm = d.getFullYear() + '-' + pad(d.getMonth() + 1); api('GET', '/month?ym=' + S.calYm).then((r) => { S.month = r; renderCal(); }).catch(fail); };
    cal.append(h('div', { class: 'cap' }, h('button', { text: '‹', 'aria-label': '前の月', onclick: () => moveCal(-1) }), h('span', { text: y + '年' + m + '月' }), h('button', { text: '›', 'aria-label': '次の月', onclick: () => moveCal(1) })));
    WD.forEach((w, i) => cal.append(h('div', { class: 'wd' + (i === 0 ? ' sun' : i === 6 ? ' sat' : ''), text: w })));
    const start = new Date(first); start.setDate(1 - first.getDay());
    for (let i = 0; i < 42; i++) {
      const d = new Date(start); d.setDate(start.getDate() + i);
      const ds = fmtDate(d), info = (S.month && S.month.days[ds]) || null;
      if (i >= 35 && d.getMonth() !== m - 1) break;
      cal.append(h('button', {
        class: 'd' + (d.getMonth() !== m - 1 ? ' other' : '') + (ds === S.today ? ' today' : '') + (ds === S.date ? ' sel' : '') + (d.getDay() === 0 ? ' sun' : d.getDay() === 6 ? ' sat' : ''),
        title: info ? info.groups + '組 ' + info.guests + '名' : '', onclick: () => goDate(ds),
      }, h('span', { class: 'n', text: d.getDate() }), h('span', { class: 'c', text: info && info.groups ? info.groups + '組' : '' })));
    }
  }

  // ---------- 予約の入力 ----------
  const dlg = $('#dlg-res'), form = $('#res-form');
  let editing = null, linked = null, pickTables = [];
  function fillSelects() {
    const src = form.elements.source; src.replaceChildren(h('option', { value: '', text: '（選ぶ）' }), ...S.boot.sources.map((s) => h('option', { value: s, text: s })));
    const cs = form.elements.courseId; cs.replaceChildren(h('option', { value: '', text: 'なし・席のみ' }), ...S.boot.courses.map((c) => h('option', { value: c.id, text: c.name + (c.price ? '（' + yen(c.price) + '）' : '') })));
  }
  $('#btn-new').addEventListener('click', () => openRes(null, { date: S.view === 'ledger' ? S.date : S.today }));

  function openRes(r, preset) {
    editing = r; linked = r && r.customer ? r.customer : null;
    const f = form.elements, p = preset || {};
    $('#res-title').textContent = r ? '予約を直す' : '予約を入れる';
    f.date.value = r ? r.date : p.date || S.date;
    f.time.value = r ? r.time : p.time || '18:00';
    f.guests.value = r ? r.guests : 2;
    f.stayMin.value = r ? r.stayMin : S.boot.settings.defaultStayMin;
    f.source.value = r ? r.source : '電話';
    f.courseId.value = r ? r.courseId : '';
    f.status.value = r ? r.status : 'booked';
    f.memo.value = r ? r.memo : '';
    f.phone.value = linked ? linked.phone : ''; f.name.value = linked ? linked.name : ''; f.kana.value = linked ? linked.kana : ''; f.allergy.value = linked ? linked.allergy : '';
    pickTables = r ? [...r.tableIds] : [...(p.tableIds || [])];
    $('#res-del').hidden = !r;
    $('#res-err').textContent = '';
    renderMatch([]);
    renderTablePick();
    dlg.showModal();
    (r ? f.time : f.phone).focus();
  }

  function renderMatch(hits) {
    const box = $('#res-match'); box.replaceChildren();
    if (linked) {
      box.append(h('div', { class: 'hit linked' },
        h('b', { text: 'No.' + linked.no + ' ' + (linked.name || '') }),
        h('span', { text: '来店' + linked.visits + '回' + (linked.last ? '（前回 ' + linked.last + '）' : '') }),
        linked.cancels || linked.noshows ? h('span', { class: 'err', text: 'キャンセル' + linked.cancels + '・無断' + linked.noshows }) : null,
        linked.memo ? h('span', { class: 'muted', text: linked.memo }) : null,
        h('button', { type: 'button', text: '別の方にする', onclick: () => { linked = null; renderMatch([]); } })));
      return;
    }
    for (const c of hits.slice(0, 5)) {
      box.append(h('div', { class: 'hit' },
        h('b', { text: 'No.' + c.no + ' ' + (c.name || '（お名前なし）') }), h('span', { text: c.phone }),
        h('span', { text: '来店' + c.visits + '回' + (c.last ? '・前回 ' + c.last : '') }),
        c.allergy ? h('span', { class: 'err', text: '⚠' + c.allergy }) : null,
        h('button', { type: 'button', text: 'この方で入れる', onclick: () => useCustomer(c) })));
    }
  }
  function useCustomer(c) {
    linked = c; const f = form.elements;
    f.phone.value = c.phone; f.name.value = c.name; f.kana.value = c.kana; f.allergy.value = c.allergy;
    renderMatch([]);
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
    try {
      const date = f.date.value, s = toMin(f.time.value || '00:00'), e = s + (+f.stayMin.value || 0);
      const list = date === S.date ? S.day : (await api('GET', '/reservations?from=' + date + '&to=' + date)).reservations;
      for (const r of list) {
        if ((editing && r.id === editing.id) || !ACTIVE.has(r.status)) continue;
        const rs = toMin(r.time);
        if (s < rs + r.stayMin && rs < e) r.tableIds.forEach((t) => busy.add(t));
      }
    } catch (err) { busy = new Set(); }
    for (const t of S.boot.tables) {
      const on = pickTables.includes(t.id);
      box.append(h('button', {
        type: 'button', class: (on ? 'on' : '') + (busy.has(t.id) ? ' busy' : ''), title: busy.has(t.id) ? 'この時間は埋まっています' : '',
        text: t.name + '（' + t.cap + '）', onclick: () => { pickTables = on ? pickTables.filter((x) => x !== t.id) : [...pickTables, t.id]; renderTablePick(); },
      }));
    }
    if (!S.boot.tables.length) box.append(h('span', { class: 'muted', text: '設定で席を登録してください' }));
  }

  $('#res-cancel').addEventListener('click', () => dlg.close());
  $('#res-del').addEventListener('click', async () => {
    if (!editing) return;
    if (!confirm(editing.date + ' ' + editing.time + ' の予約を削除します。元に戻せません。\nキャンセルの記録を残したい時は「状態」をキャンセルにしてください。\n削除しますか？')) return;
    try { await api('DELETE', '/reservations/' + editing.id); dlg.close(); toast('削除しました'); refresh(); } catch (e) { fail(e); }
  });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = form.elements;
    const body = {
      date: f.date.value, time: f.time.value, guests: +f.guests.value, stayMin: +f.stayMin.value,
      source: f.source.value, courseId: f.courseId.value, status: f.status.value, memo: f.memo.value, tableIds: pickTables,
      customerId: linked ? linked.id : null,
      customer: { name: f.name.value, kana: f.kana.value, phone: f.phone.value, allergy: f.allergy.value },
    };
    $('#res-err').textContent = '';
    try {
      const url = editing ? '/reservations/' + editing.id : '/reservations';
      let r = await api(editing ? 'PUT' : 'POST', url, body);
      if (r.conflicts) {
        const msg = r.conflicts.map((c) => c.time + '〜 ' + (c.name || 'お名前なし') + '（' + c.tables.join('・') + '）').join('\n');
        if (!confirm('同じ席に重なる予約があります。\n' + msg + '\nこのまま保存しますか？')) return;
        r = await api(editing ? 'PUT' : 'POST', url, { ...body, allowOverlap: true });
      }
      dlg.close();
      toast('保存しました');
      if (S.view === 'ledger' && body.date !== S.date) { S.date = body.date; S.calYm = body.date.slice(0, 7); }
      refresh();
    } catch (err) { $('#res-err').textContent = err.message; }
  });
  function refresh() { show(S.view); }

  // ---------- 予約一覧 ----------
  let listInit = false;
  async function initList() {
    if (!listInit) { $('#l-from').value = S.today; $('#l-to').value = addDays(S.today, 30); listInit = true; }
    const from = $('#l-from').value, to = $('#l-to').value;
    const r = await api('GET', '/reservations?from=' + from + '&to=' + to);
    const q = $('#l-q').value.trim().toLowerCase();
    const list = r.reservations.filter((x) => !q || (x.customer && ((x.customer.name || '') + (x.customer.kana || '') + (x.customer.phone || '').replace(/\D/g, '')).toLowerCase().includes(q.replace(/-/g, ''))));
    const t = $('#l-table'); t.replaceChildren();
    t.append(h('thead', null, h('tr', null, ['日付', '時刻', 'お名前', '人数', '席', 'コース', '経路', '状態', 'メモ'].map((x) => h('th', { text: x, class: x === '人数' ? 'num' : '' })))));
    const tb = h('tbody');
    for (const x of list) tb.append(h('tr', { onclick: () => openRes(x) },
      h('td', { text: jpDate(x.date) }), h('td', { text: x.time }), h('td', { text: x.customer ? (x.customer.name || x.customer.phone) : '（お名前なし）' }),
      h('td', { class: 'num', text: x.guests }), h('td', { text: tableNames(x.tableIds) || '未定' }), h('td', { text: courseName(x.courseId) }),
      h('td', { text: x.source }), h('td', { text: STATUS[x.status] }), h('td', { class: 'wrap', text: x.memo })));
    if (!list.length) tb.append(h('tr', null, h('td', { colspan: 9, class: 'muted', text: 'この期間の予約はありません' })));
    t.append(tb);
  }
  $('#l-go').addEventListener('click', () => initList().catch(fail));
  $('#l-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') initList().catch(fail); });

  // ---------- お客様 ----------
  async function loadCustomers() {
    const r = await api('GET', '/customers?limit=500&q=' + encodeURIComponent($('#c-q').value) + ($('#c-stale').checked ? '&stale=1' : ''));
    $('#c-count').textContent = r.total + '名' + (r.total > r.customers.length ? '（上位' + r.customers.length + '名を表示）' : '') + ($('#c-stale').checked ? '・最後の予約が ' + r.staleBefore + ' より前' : '');
    const t = $('#c-table'); t.replaceChildren();
    t.append(h('thead', null, h('tr', null, ['No.', 'お名前', 'ふりがな', '電話番号', '来店', '前回', '次回', 'タグ'].map((x) => h('th', { text: x, class: x === '来店' ? 'num' : '' })))));
    const tb = h('tbody');
    for (const c of r.customers) tb.append(h('tr', { class: S.custSel === c.id ? 'sel' : '', onclick: (ev) => { S.custSel = c.id; $$('#c-table tr').forEach((x) => x.classList.remove('sel')); ev.currentTarget.classList.add('sel'); custDetail(c.id).catch(fail); } },
      h('td', { text: c.no }), h('td', { text: c.name }), h('td', { text: c.kana }), h('td', { text: c.phone }), h('td', { class: 'num', text: c.visits }),
      h('td', { text: c.last }), h('td', { text: c.next }), h('td', null, c.tags.map((x) => h('span', { class: 'badge tag', text: x })))));
    if (!r.customers.length) tb.append(h('tr', null, h('td', { colspan: 8, class: 'muted', text: '見つかりません' })));
    t.append(tb);
    if (S.custSel) custDetail(S.custSel).catch(() => { S.custSel = null; $('#c-detail').replaceChildren(h('p', { class: 'muted', text: 'お客様を選ぶと、来店の履歴が出ます。' })); });
  }
  let cTimer;
  $('#c-q').addEventListener('input', () => { clearTimeout(cTimer); cTimer = setTimeout(() => loadCustomers().catch(fail), 250); });
  $('#c-stale').addEventListener('change', () => loadCustomers().catch(fail));
  $('#c-new').addEventListener('click', () => openCust(null));

  async function custDetail(id) {
    const { customer: c, history } = await api('GET', '/customers/' + id);
    const box = $('#c-detail'); box.replaceChildren();
    box.append(h('h3', { text: c.name || '（お名前なし）' }), h('div', { class: 'muted', text: 'No.' + c.no + (c.kana ? '・' + c.kana : '') }),
      h('dl', { class: 'kvs' },
        h('dt', { text: '電話' }), h('dd', { text: c.phone || '—' }),
        h('dt', { text: '来店' }), h('dd', { text: c.visits + '回（キャンセル' + c.cancels + '・無断' + c.noshows + '）' }),
        h('dt', { text: '前回・次回' }), h('dd', { text: (c.last || '—') + ' ／ ' + (c.next || '—') }),
        h('dt', { text: 'タグ' }), h('dd', null, c.tags.length ? c.tags.map((x) => h('span', { class: 'badge tag', text: x })) : '—'),
        h('dt', { text: 'アレルギー' }), h('dd', { text: c.allergy || '—' }),
        h('dt', { text: 'メモ' }), h('dd', { text: c.memo || '—' })),
      h('div', { class: 'actions' }, h('button', { text: '直す', onclick: () => openCust(c) }), h('button', { class: 'primary', text: 'この方の予約を入れる', onclick: () => { openRes(null, { date: S.today }); useCustomer(c); } })),
      h('h3', { text: '履歴', style: 'font-size:14px;margin-top:16px' }));
    const t = h('table', { class: 'tbl' }, h('thead', null, h('tr', null, ['日付', '時刻', '人数', 'コース', '状態'].map((x) => h('th', { text: x })))));
    const tb = h('tbody');
    for (const r of history) tb.append(h('tr', { onclick: () => openRes({ ...r, customer: c }) }, h('td', { text: r.date }), h('td', { text: r.time }), h('td', { text: r.guests + '名' }), h('td', { text: courseName(r.courseId) }), h('td', { text: STATUS[r.status] })));
    if (!history.length) tb.append(h('tr', null, h('td', { colspan: 5, class: 'muted', text: '予約の記録はまだありません' })));
    t.append(tb); box.append(t);
  }

  const cdlg = $('#dlg-cust'), cform = $('#cust-form');
  let cEditing = null;
  function openCust(c) {
    cEditing = c; const f = cform.elements;
    $('#cust-title').textContent = c ? 'お客様の情報（No.' + c.no + '）' : 'お客様を登録';
    f.name.value = c ? c.name : ''; f.kana.value = c ? c.kana : ''; f.phone.value = c ? c.phone : '';
    f.tags.value = c ? c.tags.join('、') : ''; f.allergy.value = c ? c.allergy : ''; f.memo.value = c ? c.memo : '';
    $('#cust-del').hidden = !c; $('#cust-err').textContent = '';
    cdlg.showModal(); f.name.focus();
  }
  $('#cust-cancel').addEventListener('click', () => cdlg.close());
  cform.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = cform.elements;
    const body = { name: f.name.value, kana: f.kana.value, phone: f.phone.value, allergy: f.allergy.value, memo: f.memo.value, tags: f.tags.value.split(/[、,，\s]+/).filter(Boolean) };
    try {
      const r = await api(cEditing ? 'PUT' : 'POST', '/customers' + (cEditing ? '/' + cEditing.id : ''), body);
      S.custSel = r.customer.id; cdlg.close(); toast('保存しました'); loadCustomers().catch(fail);
    } catch (err) { $('#cust-err').textContent = err.message; }
  });
  $('#cust-del').addEventListener('click', async () => {
    if (!cEditing) return;
    if (!confirm('No.' + cEditing.no + ' ' + (cEditing.name || '') + ' 様の情報（お名前・電話・メモ）を消します。元に戻せません。\n予約の記録は「お名前なし」として残り、件数の集計には使われます。\n消しますか？')) return;
    try { await api('DELETE', '/customers/' + cEditing.id); S.custSel = null; cdlg.close(); $('#c-detail').replaceChildren(h('p', { class: 'muted', text: '消しました。' })); toast('消しました'); loadCustomers().catch(fail); } catch (err) { fail(err); }
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
      h('p', { class: 'hint', text: '状態を「来店中」「退店」にした予約だけを来店として数えます。予約なしのお客様（飛び込み）は、予約として入れた時だけ数に入ります。' })));
  }
  function bar(label, ratio, val) { return h('div', { class: 'bar' }, h('span', { text: label }), h('div', { class: 'track' }, h('div', { class: 'fill', style: 'width:' + Math.round(ratio * 100) + '%' })), h('span', { class: 'muted', text: val })); }
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

    // 席
    const tRows = h('tbody');
    const addTRow = (t) => tRows.append(h('tr', { 'data-id': t.id || '' },
      h('td', null, h('input', { value: t.name, 'data-k': 'name', 'aria-label': '席の名前' })), h('td', { class: 'small' }, h('input', { value: t.cap, type: 'number', min: 1, max: 200, 'data-k': 'cap', 'aria-label': '人数' })),
      h('td', null, h('input', { value: t.area, 'data-k': 'area', 'aria-label': 'エリア' })), h('td', { class: 'small' }, h('input', { value: t.pos, 'data-k': 'pos', 'aria-label': 'レジの席番号' })),
      h('td', null, h('button', { type: 'button', text: '↑', title: '上へ', onclick: (e) => { const tr = e.target.closest('tr'); if (tr.previousElementSibling) tr.parentNode.insertBefore(tr, tr.previousElementSibling); } }),
        h('button', { type: 'button', text: '外す', onclick: (e) => e.target.closest('tr').remove() }))));
    S.boot.tables.forEach(addTRow);
    const tPanel = h('div', { class: 'panel' }, h('h3', { text: '席' }),
      h('p', { class: 'hint', text: '「レジの席番号」は、あとでレジのデータとつなぐ時に使います（レジの伝票に出る席番号を入れる）。外した席に入っていた予約は「席未定」になります。' }),
      h('div', { class: 'table-wrap' }, h('table', { class: 'tbl edit-table' }, h('thead', null, h('tr', null, ['名前', '人数', 'エリア', 'レジの席番号', ''].map((x) => h('th', { text: x })))), tRows)),
      h('div', { class: 'actions' }, h('button', { type: 'button', text: '＋ 席を足す', onclick: () => addTRow({ name: '', cap: 4, area: '', pos: '' }) }), h('span', { class: 'sep' }),
        h('button', { class: 'primary', type: 'button', text: '席を保存', onclick: async () => {
          const tables = $$('tr', tRows).map((tr) => ({ id: tr.dataset.id, name: $('[data-k=name]', tr).value, cap: +$('[data-k=cap]', tr).value, area: $('[data-k=area]', tr).value, pos: $('[data-k=pos]', tr).value }));
          try { S.boot = await api('PUT', '/settings', { tables }); toast('席を保存しました'); renderSettings().catch(fail); } catch (err) { fail(err); }
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

  start().catch((e) => { document.body.textContent = '予約台帳のサーバーにつながりません。起動しているか確かめてください。（' + e.message + '）'; });
})();
