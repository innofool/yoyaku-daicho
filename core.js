'use strict';
// 予約台帳の決まり（予約・お客様・受付履歴・分析・CSV）。
// 保存や暗号化はしない（vault.js の役目）。iPadのブラウザでも、試験用のNodeでも同じものが動く。
(function (root) {
  const STATUSES = ['booked', 'seated', 'left', 'cancel', 'noshow'];
  const ACTIVE = new Set(['booked', 'seated', 'left']);
  const VISITED = new Set(['seated', 'left']);
  const SOURCES = ['電話', 'ウォークイン', 'ネット予約', 'LINE', 'その他'];
  const OLD_SOURCE = { 店頭: 'ウォークイン', 飛び込み: 'ウォークイン', ネット: 'ネット予約' };
  const DEFAULT_RES_TAGS = ['席指定', 'ケーキ用意', 'お子様連れ', 'ご接待', 'お誕生日', 'お祝い', 'VIP', '常連様'];
  const DEFAULT_CUST_ATTRS = ['VIP', '要注意', 'アレルギー', '無断キャンセルあり', '常連さま', '高単価', '低単価', 'スタッフ知人', '同業者', '取引先', '著名人', 'ワイン好き', '左利き'];
  // お客様の項目（名前・電話以外）と長さの上限
  const CUST_TEXT = { phone2: 30, company: 60, receiptName: 60, dept: 60, title: 60, email: 100, email2: 100, twitter: 100, facebook: 100, workZip: 10, workAddr: 200, homeZip: 10, homeAddr: 200, feature: 200, anniv: 60, allergy: 200, memo: 1000 };
  const KEEP_LOG = 3000;
  const WALKIN = '0000';

  function bad(msg, status) { return Object.assign(new Error(msg), { status: status || 400 }); }
  function pad(n) { return String(n).padStart(2, '0'); }
  function localDate(d) { d = d || new Date(); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function isDate(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const d = new Date(s + 'T00:00:00');
    return !isNaN(d) && localDate(d) === s;
  }
  function isTime(s) { return typeof s === 'string' && /^\d{2}:\d{2}$/.test(s) && +s.slice(0, 2) <= 29 && +s.slice(3) <= 59; }
  function toMin(t) { return +t.slice(0, 2) * 60 + +t.slice(3); }
  function toTime(m) { return pad(Math.floor(m / 60)) + ':' + pad(m % 60); }
  function str(v, max) { return (v == null ? '' : String(v)).normalize('NFC').replace(/[\u0000-\u0008\u000b-\u001f]/g, '').trim().slice(0, max || 200); }
  function int(v, lo, hi, name) {
    const n = Number(v);
    if (!Number.isInteger(n) || n < lo || n > hi) throw bad(name + 'の値が正しくありません');
    return n;
  }
  function normPhone(s) { return str(s, 40).normalize('NFKC').replace(/\D/g, ''); }
  // 検索用：全角半角・ひらがなカタカナ・空白の違いを無視する
  function normText(s) {
    return str(s, 200).normalize('NFKC').toLowerCase().replace(/\s+/g, '')
      .replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
  }
  function newId(prefix) {
    const b = new Uint8Array(8);
    root.crypto.getRandomValues(b);
    return prefix + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  }
  function addDays(s, n) { const d = new Date(s + 'T00:00:00'); d.setDate(d.getDate() + n); return localDate(d); }
  function ymOf(s) { return s.slice(0, 7); }
  function ymAdd(ym, n) { const d = new Date(+ym.slice(0, 4), +ym.slice(5, 7) - 1 + n, 1); return d.getFullYear() + '-' + pad(d.getMonth() + 1); }
  function ymRange(from, to) {
    if (!/^\d{4}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}$/.test(to || '') || from > to) throw bad('期間が正しくありません');
    const out = [];
    for (let m = from; m <= to; m = ymAdd(m, 1)) { out.push(m); if (out.length > 13) throw bad('期間は最長13か月までです'); }
    return out;
  }
  function monday(s) { const d = new Date(s + 'T00:00:00'); return addDays(s, -((d.getDay() + 6) % 7)); }
  function acceptDate(r) { return localDate(new Date(r.createdAt)); }
  function splitName(full) {
    const parts = str(full, 60).split(/[\s　]+/).filter(Boolean);
    return [parts[0] || '', parts.slice(1).join(' ')];
  }

  function emptyDb() {
    return {
      v: 2,
      seq: { customer: 0, reservation: 0 },
      settings: { storeName: '', open: '11:00', close: '23:00', defaultStayMin: 120, lunchEnd: '17:30', autoLockMin: 10, retentionYears: 3 },
      // 最初のテーブルは仮のもの。設定画面でお店のテーブルに直す。
      tables: [
        { id: newId('t_'), name: 'C1', min: 1, cap: 2, area: 'カウンター', pos: '', smoke: '禁煙' },
        { id: newId('t_'), name: 'C2', min: 1, cap: 2, area: 'カウンター', pos: '', smoke: '禁煙' },
        { id: newId('t_'), name: 'T1', min: 2, cap: 4, area: 'ホール', pos: '', smoke: '禁煙' },
        { id: newId('t_'), name: 'T2', min: 2, cap: 4, area: 'ホール', pos: '', smoke: '禁煙' },
        { id: newId('t_'), name: 'T3', min: 3, cap: 6, area: 'ホール', pos: '', smoke: '禁煙' },
        { id: newId('t_'), name: '個室1', min: 4, cap: 8, area: '個室', pos: '', smoke: '禁煙' },
      ],
      courses: [], customers: [], reservations: [], log: [],
      staff: [], resTags: DEFAULT_RES_TAGS.slice(), custAttrs: DEFAULT_CUST_ATTRS.slice(),
      free: { label: '自由設定欄', options: [] }, dayInfo: {},
    };
  }

  function strList(v, maxItems, maxLen, name) {
    if (!Array.isArray(v) || v.length > maxItems) throw bad(name + 'が正しくありません');
    return [...new Set(v.map((x) => str(x, maxLen)).filter(Boolean))];
  }

  class Ledger {
    constructor(db) {
      this.db = db; this._stats = null;
      this._migrate();
    }
    // 前の版で作った台帳にも、新しく足した項目を用意する
    _migrate() {
      const d = this.db;
      d.seq = d.seq || {};
      if (!Array.isArray(d.staff)) d.staff = [];
      if (!Array.isArray(d.resTags)) d.resTags = DEFAULT_RES_TAGS.slice();
      if (!Array.isArray(d.custAttrs)) d.custAttrs = DEFAULT_CUST_ATTRS.slice();
      if (!d.free) d.free = { label: '自由設定欄', options: [] };
      if (!d.dayInfo) d.dayInfo = {};
      for (const t of d.tables) { if (t.min == null) t.min = 1; if (t.smoke == null) t.smoke = ''; }
      if (d.seq.reservation == null) {
        d.seq.reservation = 0;
        for (const r of [...d.reservations].sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''))) r.no = ++d.seq.reservation;
      }
      for (const r of d.reservations) {
        if (OLD_SOURCE[r.source]) r.source = OLD_SOURCE[r.source];
        if (r.kids == null) r.kids = 0;
        if (r.adults == null) r.adults = r.guests - r.kids;
        if (r.adultsMin == null) r.adultsMin = r.adults;
        if (r.kidsMin == null) r.kidsMin = r.kids;
        if (r.guestsMin == null) r.guestsMin = r.adultsMin + r.kidsMin;
        if (!Array.isArray(r.courses)) r.courses = r.courseId ? [{ courseId: r.courseId, count: r.guests }] : [];
        if (!Array.isArray(r.tags)) r.tags = [];
        if (r.staff == null) r.staff = '';
        if (r.resetMin == null) r.resetMin = 0;
        if (r.timeLimit == null) r.timeLimit = false;
        if (r.free == null) r.free = '';
        if (!Array.isArray(r.history)) r.history = [{ t: r.createdAt, type: 'new', staff: r.staff || '' }];
      }
      for (const c of d.customers) {
        if (c.lastName == null) { const [l, f] = splitName(c.name); c.lastName = l; c.firstName = f; }
        if (c.lastKana == null) { const [l, f] = splitName(c.kana); c.lastKana = l; c.firstKana = f; }
      }
      d.v = 2;
    }
    changed() { this._stats = null; }

    _log(act, ref) {
      this.db.log.push({ t: new Date().toISOString(), act, ref: ref || '' });
      if (this.db.log.length > KEEP_LOG) this.db.log.splice(0, this.db.log.length - KEEP_LOG);
    }
    log(limit) { return this.db.log.slice(-(limit || 200)).reverse(); }

    // ---------- 設定 ----------
    bootstrap() {
      const d = this.db;
      return { settings: d.settings, tables: d.tables, courses: d.courses, sources: SOURCES, staff: d.staff, resTags: d.resTags, custAttrs: d.custAttrs, free: d.free, counts: { customers: d.customers.length, reservations: d.reservations.length } };
    }

    updateSettings(input) {
      const d = this.db;
      if (input.settings) {
        const s = input.settings;
        const open = str(s.open, 5), close = str(s.close, 5), lunchEnd = str(s.lunchEnd, 5);
        if (!isTime(open) || !isTime(close) || toMin(close) <= toMin(open)) throw bad('開店・閉店の時刻が正しくありません');
        if (!isTime(lunchEnd)) throw bad('昼と夜の境目の時刻が正しくありません');
        d.settings = {
          storeName: str(s.storeName, 60), open, close, lunchEnd,
          defaultStayMin: int(s.defaultStayMin, 15, 720, '滞在時間'),
          autoLockMin: int(s.autoLockMin, 1, 1440, '自動ロック'),
          retentionYears: int(s.retentionYears, 1, 20, '保管年数'),
        };
      }
      if (input.tables) {
        if (!Array.isArray(input.tables) || input.tables.length > 300) throw bad('テーブルの設定が正しくありません');
        const seen = new Set();
        d.tables = input.tables.map((t) => {
          const name = str(t.name, 30);
          if (!name) throw bad('テーブルの名前が空です');
          if (seen.has(name)) throw bad('同じ名前のテーブルがあります：' + name);
          seen.add(name);
          const old = d.tables.find((x) => x.id === t.id);
          const cap = int(t.cap, 1, 200, 'テーブルの人数');
          const min = int(t.min == null || t.min === '' ? 1 : t.min, 1, 200, 'テーブルの最小人数');
          if (min > cap) throw bad(name + 'の定員が正しくありません（最小が最大より大きい）');
          const smoke = ['禁煙', '喫煙', ''].includes(t.smoke) ? t.smoke : '';
          return { id: old ? old.id : newId('t_'), name, min, cap, area: str(t.area, 30), pos: str(t.pos, 30), smoke };
        });
        // 外したテーブルに入っていた予約はウェイティングにする
        const ids = new Set(d.tables.map((t) => t.id));
        for (const r of d.reservations) r.tableIds = r.tableIds.filter((t) => ids.has(t));
      }
      if (input.courses) {
        if (!Array.isArray(input.courses) || input.courses.length > 200) throw bad('コースの設定が正しくありません');
        d.courses = input.courses.map((c) => {
          const name = str(c.name, 60);
          if (!name) throw bad('コースの名前が空です');
          const old = d.courses.find((x) => x.id === c.id);
          return { id: old ? old.id : newId('k_'), name, price: int(c.price || 0, 0, 10000000, 'コースの金額') };
        });
      }
      if (input.staff) d.staff = strList(input.staff, 100, 30, '担当者');
      if (input.resTags) d.resTags = strList(input.resTags, 100, 20, '予約タグ');
      if (input.custAttrs) d.custAttrs = strList(input.custAttrs, 100, 20, 'お客様属性');
      if (input.free) d.free = { label: str(input.free.label, 20) || '自由設定欄', options: strList(input.free.options || [], 50, 30, '自由設定欄の選択肢') };
      this._log('設定を変更');
      this.changed();
      return this.bootstrap();
    }

    // 本日の情報（日ごとのお知らせ。スタッフ向けのメモ）
    setDayInfo(date, text) {
      if (!isDate(date)) throw bad('日付が正しくありません');
      const t = str(text, 1000);
      if (t) this.db.dayInfo[date] = t; else delete this.db.dayInfo[date];
      this._log('本日の情報を変更', date);
      return { date, info: t };
    }

    // ---------- お客様 ----------
    _custStats() {
      if (this._stats) return this._stats;
      const m = new Map();
      for (const r of this.db.reservations) {
        if (!r.customerId) continue;
        let s = m.get(r.customerId);
        if (!s) { s = { visits: 0, cancels: 0, noshows: 0, last: '', next: '', lastAny: '' }; m.set(r.customerId, s); }
        if (r.date > s.lastAny) s.lastAny = r.date;
        if (VISITED.has(r.status)) { s.visits++; if (r.date > s.last) s.last = r.date; }
        else if (r.status === 'cancel') s.cancels++;
        else if (r.status === 'noshow') s.noshows++;
        else if (r.status === 'booked' && (!s.next || r.date < s.next)) s.next = r.date;
      }
      this._stats = m;
      return m;
    }

    _brief(c) {
      if (!c) return null;
      const s = this._custStats().get(c.id) || { visits: 0, cancels: 0, noshows: 0, last: '', next: '' };
      const out = { id: c.id, no: c.no, name: c.name, kana: c.kana, lastName: c.lastName || '', firstName: c.firstName || '', lastKana: c.lastKana || '', firstKana: c.firstKana || '', phone: c.phone, hidden: !!c.hidden, tags: c.tags };
      for (const k of Object.keys(CUST_TEXT)) out[k] = c[k] || '';
      return Object.assign(out, { visits: s.visits, cancels: s.cancels, noshows: s.noshows, last: s.last, next: s.next });
    }

    _staleBefore() {
      const d = new Date();
      d.setFullYear(d.getFullYear() - this.db.settings.retentionYears);
      return localDate(d);
    }

    listCustomers(opt) {
      opt = opt || {};
      const q = normText(opt.q || '');
      const qd = normPhone(opt.q || '');
      const limit = Math.min(Math.max(+opt.limit || 200, 1), 1000);
      const stats = this._custStats();
      const staleBefore = this._staleBefore();
      // 「非表示」にしたお客様は、ふつうの一覧には出さない（非表示の一覧でだけ見る）
      let list = this.db.customers.filter((c) => (opt.hidden ? !!c.hidden : !c.hidden));
      if (q) {
        list = list.filter((c) => normText(c.name).includes(q) || normText(c.kana).includes(q) || normText(c.company).includes(q)
          || normText(c.memo).includes(q) || (qd.length >= 3 && (normPhone(c.phone).includes(qd) || normPhone(c.phone2).includes(qd))) || c.tags.some((t) => normText(t).includes(q)));
      }
      if (opt.tag) { const tg = normText(opt.tag); list = list.filter((c) => c.tags.some((t) => normText(t) === tg)); }
      if (opt.minVisits) { const mv = +opt.minVisits; list = list.filter((c) => ((stats.get(c.id) || {}).visits || 0) >= mv); }
      if (opt.stale) {
        list = list.filter((c) => {
          const s = stats.get(c.id);
          const lastAct = (s && s.lastAny) || (c.createdAt || '').slice(0, 10);
          return lastAct < staleBefore;
        });
      }
      const total = list.length;
      const byKana = (a, b) => (normText(a.kana || a.name) || '￿').localeCompare(normText(b.kana || b.name) || '￿', 'ja') || a.no - b.no;
      const sorters = {
        kana: byKana, // お名前順（ふりがながあればふりがなで）
        kanaDesc: (a, b) => byKana(b, a),
        visits: (a, b) => b.visits - a.visits || byKana(a, b), // ご来店回数順
        visitsAsc: (a, b) => a.visits - b.visits || byKana(a, b),
        recent: (a, b) => (b.last || '').localeCompare(a.last || '') || b.no - a.no,
      };
      const out = list.map((c) => this._brief(c)).sort(sorters[opt.sort] || sorters.recent).slice(0, limit);
      const tags = [...new Set(this.db.customers.flatMap((c) => c.tags))].sort((a, b) => a.localeCompare(b, 'ja'));
      return { customers: out, total, all: this.db.customers.filter((c) => !c.hidden).length, hiddenCount: this.db.customers.filter((c) => c.hidden).length, staleBefore, tags };
    }

    getCustomer(id) {
      const c = this.db.customers.find((x) => x.id === id);
      if (!c) throw bad('お客様が見つかりません', 404);
      const history = this.db.reservations.filter((r) => r.customerId === id)
        .sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time)).map((r) => this._resOut(r, true));
      return { customer: this._brief(c), history };
    }

    _custFields(input, cur) {
      // お名前は「姓・名」「せい・めい」で受け取る（1つの欄で来た時は空白で分ける）
      let last = input.lastName, first = input.firstName, lastK = input.lastKana, firstK = input.firstKana;
      if (last == null && first == null && input.name != null) [last, first] = splitName(input.name);
      if (lastK == null && firstK == null && input.kana != null) [lastK, firstK] = splitName(input.kana);
      if (last == null && first == null && cur) { last = cur.lastName; first = cur.firstName; }
      if (lastK == null && firstK == null && cur) { lastK = cur.lastKana; firstK = cur.firstKana; }
      last = str(last, 30); first = str(first, 30); lastK = str(lastK, 30); firstK = str(firstK, 30);
      const name = [last, first].filter(Boolean).join(' '), kana = [lastK, firstK].filter(Boolean).join(' ');
      let phone = str(input.phone != null ? input.phone : cur && cur.phone, 30).normalize('NFKC');
      if (normPhone(phone) === WALKIN) phone = '';
      if (!name && !kana && !normPhone(phone)) throw bad('携帯番号かお名前を入力してください');
      const tags = Array.isArray(input.tags) ? [...new Set(input.tags.map((t) => str(t, 20)).filter(Boolean))].slice(0, 20) : (cur ? cur.tags : []);
      const out = { name: name || kana, kana, lastName: last, firstName: first, lastKana: lastK, firstKana: firstK, phone, tags, hidden: input.hidden != null ? !!input.hidden : !!(cur && cur.hidden) };
      for (const [k, max] of Object.entries(CUST_TEXT)) out[k] = str(input[k] != null ? input[k] : cur && cur[k], max);
      out.phone2 = out.phone2.normalize('NFKC');
      for (const k of ['email', 'email2']) if (out[k] && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out[k])) throw bad('メールアドレスの形が正しくありません');
      return out;
    }

    saveCustomer(input, id) {
      const c = this._saveCustomer(input, id);
      this.changed();
      return { customer: this._brief(c) };
    }

    _saveCustomer(input, id) {
      const now = new Date().toISOString();
      if (id) {
        const c = this.db.customers.find((x) => x.id === id);
        if (!c) throw bad('お客様が見つかりません', 404);
        Object.assign(c, this._custFields(input, c), { updatedAt: now });
        this._log('お客様を変更', 'No.' + c.no);
        return c;
      }
      const c = { id: newId('c_'), no: ++this.db.seq.customer, ...this._custFields(input, null), createdAt: now, updatedAt: now };
      this.db.customers.push(c);
      this._log('お客様を登録', 'No.' + c.no);
      return c;
    }

    // お客様の情報を消す。予約の記録は「お名前なし」として残す（集計の件数を保つため）
    deleteCustomer(id) {
      const i = this.db.customers.findIndex((x) => x.id === id);
      if (i < 0) throw bad('お客様が見つかりません', 404);
      const no = this.db.customers[i].no;
      this.db.customers.splice(i, 1);
      for (const r of this.db.reservations) if (r.customerId === id) { r.customerId = null; r.memo = ''; }
      this._log('お客様の情報を消去', 'No.' + no);
      this.changed();
      return { ok: true };
    }

    // ---------- 予約 ----------
    _occEnd(r) { return toMin(r.time) + r.stayMin + (r.resetMin || 0); }

    // 予約の気になる点（受付履歴の「問題のある予約」、台帳の！の印）
    flags(r) {
      const d = this.db, st = d.settings, out = [];
      if (!ACTIVE.has(r.status)) return out;
      if (toMin(r.time) < toMin(st.open) || toMin(r.time) + r.stayMin > toMin(st.close)) out.push('営業時間外');
      const ts = r.tableIds.map((t) => d.tables.find((x) => x.id === t)).filter(Boolean);
      if (!ts.length) out.push('席未定');
      else {
        if (r.guests > ts.reduce((a, t) => a + t.cap, 0)) out.push('席不足');
        else if (r.guests < ts.reduce((a, t) => a + (t.min || 1), 0)) out.push('席過剰');
        if (this._conflicts(r).length) out.push('重複');
      }
      return out;
    }

    _resOut(r, noCustomer) {
      const out = { ...r, tableIds: [...r.tableIds], courses: r.courses.map((c) => ({ ...c })), tags: [...r.tags], history: r.history.map((x) => ({ ...x })), flags: this.flags(r) };
      if (!noCustomer) out.customer = r.customerId ? this._brief(this.db.customers.find((c) => c.id === r.customerId)) : null;
      return out;
    }

    listReservations(from, to) {
      if (!isDate(from) || !isDate(to)) throw bad('日付が正しくありません');
      const list = this.db.reservations.filter((r) => r.date >= from && r.date <= to)
        .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)).map((r) => this._resOut(r));
      return { reservations: list, info: from === to ? this.db.dayInfo[from] || '' : '' };
    }

    _conflicts(res) {
      if (!ACTIVE.has(res.status) || !res.tableIds.length) return [];
      const s = toMin(res.time), e = this._occEnd(res);
      return this.db.reservations.filter((o) => {
        if (o.id === res.id || o.date !== res.date || !ACTIVE.has(o.status)) return false;
        if (!o.tableIds.some((t) => res.tableIds.includes(t))) return false;
        return s < this._occEnd(o) && toMin(o.time) < e;
      }).map((o) => {
        const c = o.customerId && this.db.customers.find((x) => x.id === o.customerId);
        return { id: o.id, time: o.time, stayMin: o.stayMin, guests: o.guests, name: c ? c.name : '', tables: o.tableIds.filter((t) => res.tableIds.includes(t)).map((t) => (this.db.tables.find((x) => x.id === t) || {}).name || '') };
      });
    }

    // その時間に埋まっているテーブルと、自動で割り当てるテーブル（人数が定員の範囲に入る、いちばん小さい空きテーブル）
    availability(date, time, stayMin, guests, excludeId, resetMin) {
      if (!isDate(date)) throw bad('日付が正しくありません');
      if (!isTime(time)) throw bad('時刻が正しくありません');
      const s = toMin(time), e = s + int(stayMin, 15, 720, '滞在時間') + (+resetMin || 0);
      const busy = new Set();
      for (const r of this.db.reservations) {
        if (r.id === excludeId || r.date !== date || !ACTIVE.has(r.status)) continue;
        if (s < this._occEnd(r) && toMin(r.time) < e) r.tableIds.forEach((t) => busy.add(t));
      }
      const n = int(guests || 1, 1, 300, '人数');
      const fits = this.db.tables.map((t, i) => ({ t, i }))
        .filter(({ t }) => !busy.has(t.id) && (t.min || 1) <= n && n <= t.cap)
        .sort((a, b) => a.t.cap - b.t.cap || a.i - b.i);
      return { busy: [...busy], suggest: fits.length ? fits[0].t.id : null };
    }

    saveReservation(input, id) {
      const d = this.db;
      const now = new Date().toISOString();
      const cur = id ? d.reservations.find((x) => x.id === id) : null;
      if (id && !cur) throw bad('予約が見つかりません', 404);
      const date = str(input.date, 10), time = str(input.time, 5);
      if (!isDate(date)) throw bad('日付が正しくありません');
      if (!isTime(time)) throw bad('時刻が正しくありません');
      const status = input.status == null ? (cur ? cur.status : 'booked') : str(input.status, 10);
      if (!STATUSES.includes(status)) throw bad('状態が正しくありません');
      const tableIds = [...new Set(Array.isArray(input.tableIds) ? input.tableIds.map(String) : [])].filter((t) => d.tables.some((x) => x.id === t));
      const source = str(input.source, 20);
      if (source && !SOURCES.includes(source)) throw bad('予約経路が正しくありません');

      // 人数：大人・お子様それぞれ「最小〜最大」。最大の合計を人数として席に使う
      let adults, kids;
      if (input.adults != null && input.adults !== '') {
        adults = int(input.adults, 0, 300, '大人の人数');
        kids = int(input.kids == null || input.kids === '' ? 0 : input.kids, 0, 300, 'お子様の人数');
      } else {
        const g = int(input.guests, 1, 300, '人数');
        kids = int(input.kids == null || input.kids === '' ? (cur ? cur.kids || 0 : 0) : input.kids, 0, 300, 'お子様の人数');
        if (kids > g) throw bad('お子様の人数が、全体の人数より多くなっています');
        adults = g - kids;
      }
      const adultsMin = input.adultsMin == null || input.adultsMin === '' ? adults : int(input.adultsMin, 0, 300, '大人の人数');
      const kidsMin = input.kidsMin == null || input.kidsMin === '' ? kids : int(input.kidsMin, 0, 300, 'お子様の人数');
      if (adultsMin > adults || kidsMin > kids) throw bad('人数の「最小」が「最大」より多くなっています');
      const guests = adults + kids;
      if (guests < 1) throw bad('人数を入力してください');

      let stayMin;
      if (input.endTime) {
        const end = str(input.endTime, 5);
        if (!isTime(end) || toMin(end) <= toMin(time)) throw bad('終わりの時間が正しくありません');
        stayMin = int(toMin(end) - toMin(time), 15, 720, '滞在時間');
      } else stayMin = int(input.stayMin, 15, 720, '滞在時間');

      let courses;
      if (Array.isArray(input.courses)) {
        courses = input.courses.filter((c) => c && c.courseId).slice(0, 10).map((c) => {
          if (!d.courses.some((k) => k.id === c.courseId)) throw bad('コースが見つかりません');
          return { courseId: String(c.courseId), count: c.count === '' || c.count == null ? guests : int(c.count, 0, 300, 'コースの人数') };
        });
      } else if (input.courseId != null) {
        const cid = str(input.courseId, 40);
        if (cid && !d.courses.some((c) => c.id === cid)) throw bad('コースが見つかりません');
        courses = cid ? [{ courseId: cid, count: guests }] : [];
      } else courses = cur ? cur.courses : [];

      const free = str(input.free != null ? input.free : cur && cur.free, 30);
      const res = {
        id: cur ? cur.id : newId('r_'), no: cur ? cur.no : null, date, time, stayMin,
        timeLimit: input.timeLimit != null ? !!input.timeLimit : !!(cur && cur.timeLimit),
        resetMin: int(input.resetMin == null || input.resetMin === '' ? (cur ? cur.resetMin || 0 : 0) : input.resetMin, 0, 180, 'リセットタイム'),
        guests, guestsMin: adultsMin + kidsMin, adults, adultsMin, kids, kidsMin,
        tableIds, customerId: cur ? cur.customerId : null, courses, courseId: courses[0] ? courses[0].courseId : '', source, memo: str(input.memo, 1000), status,
        staff: str(input.staff != null ? input.staff : cur && cur.staff, 30),
        tags: Array.isArray(input.tags) ? [...new Set(input.tags.map((t) => str(t, 20)).filter(Boolean))].slice(0, 20) : (cur && cur.tags) || [],
        free, createdAt: cur ? cur.createdAt : now, updatedAt: now, history: cur ? cur.history : [],
      };
      const conflicts = this._conflicts(res);
      if (conflicts.length && !input.allowOverlap) return { conflicts };

      // お客様とのひも付け（携帯番号が「0000」はウォークイン）
      const ci = input.customer || {};
      let cust = { ...ci };
      if (normPhone(cust.phone) === WALKIN) cust.phone = '';
      const nameIn = str(cust.name, 60) || [cust.lastName, cust.firstName].map((x) => str(x, 30)).filter(Boolean).join(' ') || [cust.lastKana, cust.firstKana].map((x) => str(x, 30)).filter(Boolean).join(' ');
      const hasInfo = !!(nameIn || normPhone(cust.phone));
      if (input.customerId) {
        const c = d.customers.find((x) => x.id === input.customerId);
        if (!c) throw bad('お客様が見つかりません', 404);
        res.customerId = c.id;
        if (hasInfo) this._saveCustomer({ ...cust, tags: c.tags, memo: c.memo }, c.id);
      } else if (hasInfo) {
        // 電話番号とお名前が同じお客様がいれば、同じ人として扱う
        const ph = normPhone(cust.phone), nm = normText(nameIn);
        const same = ph ? d.customers.filter((c) => (normPhone(c.phone) === ph || normPhone(c.phone2) === ph) && (!nm || !c.name || normText(c.name) === nm || normText(c.kana) === nm)) : [];
        if (same.length === 1) {
          res.customerId = same[0].id;
          // 書き方だけ違う同じお名前なら、登録済みの書き方を残す
          const keepName = same[0].name ? { lastName: same[0].lastName, firstName: same[0].firstName, lastKana: cust.lastKana || same[0].lastKana, firstKana: cust.firstKana || same[0].firstKana } : {};
          this._saveCustomer({ ...cust, ...keepName, name: undefined, kana: undefined, phone: same[0].phone || cust.phone, allergy: cust.allergy != null ? cust.allergy : same[0].allergy, tags: same[0].tags, memo: same[0].memo }, same[0].id);
        } else {
          res.customerId = this._saveCustomer(cust, null).id;
        }
      } else if (input.customerId === null) {
        res.customerId = null;
      }

      if (!cur) res.no = ++d.seq.reservation;
      res.history = [...res.history, { t: now, type: cur ? (status === 'cancel' || status === 'noshow' ? 'cancel' : 'change') : 'new', staff: res.staff }];
      if (cur) Object.assign(cur, res); else d.reservations.push(res);
      this._log(cur ? '予約を変更' : '予約を登録', '#' + res.no + ' ' + res.date + ' ' + res.time);
      this.changed();
      return { reservation: this._resOut(cur || res) };
    }

    setStatus(id, status, staff) {
      const r = this.db.reservations.find((x) => x.id === id);
      if (!r) throw bad('予約が見つかりません', 404);
      if (!STATUSES.includes(status)) throw bad('状態が正しくありません');
      const was = r.status;
      r.status = status;
      r.updatedAt = new Date().toISOString();
      // 受付履歴：取消・無断はキャンセル、取消から戻した時は変更として残す（来店・退店は残さない）
      if ((status === 'cancel' || status === 'noshow') && ACTIVE.has(was)) r.history.push({ t: r.updatedAt, type: 'cancel', staff: str(staff, 30) || r.staff });
      else if (status === 'booked' && !ACTIVE.has(was)) r.history.push({ t: r.updatedAt, type: 'change', staff: str(staff, 30) || r.staff });
      this._log('予約の状態を変更', '#' + r.no + ' ' + r.date + ' ' + r.time + ' → ' + status);
      this.changed();
      return { reservation: this._resOut(r) };
    }

    deleteReservation(id) {
      const i = this.db.reservations.findIndex((x) => x.id === id);
      if (i < 0) throw bad('予約が見つかりません', 404);
      const r = this.db.reservations[i];
      this.db.reservations.splice(i, 1);
      this._log('予約を削除', '#' + r.no + ' ' + r.date + ' ' + r.time);
      this.changed();
      return { ok: true };
    }

    // ---------- 受付履歴・予約を検索 ----------
    received(tab, limit) {
      limit = Math.min(Math.max(+limit || 10, 1), 2000);
      let rows = [];
      if (tab === 'problem') {
        const today = localDate();
        rows = this.db.reservations.filter((r) => r.date >= today && this.flags(r).length)
          .map((r) => ({ ev: r.history[r.history.length - 1] || { t: r.updatedAt, type: 'change' }, r }));
      } else {
        for (const r of this.db.reservations) for (const ev of r.history) if (!tab || tab === 'all' || ev.type === tab) rows.push({ ev, r });
      }
      rows.sort((a, b) => (b.ev.t || '').localeCompare(a.ev.t || ''));
      return { total: rows.length, rows: rows.slice(0, limit).map(({ ev, r }) => ({ t: ev.t, type: ev.type, staff: ev.staff || '', reservation: this._resOut(r) })) };
    }

    search(q, limit) {
      q = str(q, 100);
      if (!q) return { reservations: [] };
      let list;
      const m = /^[#＃](\d+)$/.exec(q.normalize('NFKC'));
      if (m) list = this.db.reservations.filter((r) => r.no === +m[1]);
      else {
        const nq = normText(q), nd = normPhone(q);
        const custIds = new Set(this.db.customers.filter((c) => normText(c.name).includes(nq) || normText(c.kana).includes(nq) || normText(c.company).includes(nq)
          || (nd.length >= 3 && (normPhone(c.phone).includes(nd) || normPhone(c.phone2).includes(nd)))).map((c) => c.id));
        list = this.db.reservations.filter((r) => custIds.has(r.customerId) || normText(r.memo).includes(nq) || r.tags.some((t) => normText(t).includes(nq)));
      }
      list.sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
      return { reservations: list.slice(0, Math.min(+limit || 200, 1000)).map((r) => this._resOut(r)) };
    }

    // ---------- ホーム（月のカレンダー） ----------
    homeMonth(ym) {
      if (!/^\d{4}-\d{2}$/.test(ym || '')) throw bad('年月が正しくありません');
      const first = ym + '-01';
      const start = addDays(first, -new Date(first + 'T00:00:00').getDay());
      const lastDay = addDays(ymAdd(ym, 1) + '-01', -1);
      const end = addDays(lastDay, 6 - new Date(lastDay + 'T00:00:00').getDay());
      const le = toMin(this.db.settings.lunchEnd), days = {};
      for (let s = start; s <= end; s = addDays(s, 1)) days[s] = { lunch: { groups: 0, guests: 0 }, dinner: { groups: 0, guests: 0 }, info: this.db.dayInfo[s] || '' };
      for (const r of this.db.reservations) {
        if (r.date < start || r.date > end || !ACTIVE.has(r.status)) continue;
        const x = days[r.date][toMin(r.time) < le ? 'lunch' : 'dinner'];
        x.groups++; x.guests += r.guests;
      }
      return { ym, start, end, days };
    }

    month(ym) {
      if (!/^\d{4}-\d{2}$/.test(ym || '')) throw bad('年月が正しくありません');
      const days = {};
      for (const r of this.db.reservations) {
        if (!r.date.startsWith(ym)) continue;
        const x = days[r.date] || (days[r.date] = { groups: 0, guests: 0, cancels: 0 });
        if (ACTIVE.has(r.status)) { x.groups++; x.guests += r.guests; } else x.cancels++;
      }
      return { ym, days };
    }

    // ---------- 分析 ----------
    _active(from, to, basis) {
      return this.db.reservations.filter((r) => {
        if (!ACTIVE.has(r.status)) return false;
        const d = basis === 'accept' ? acceptDate(r) : r.date;
        return d >= from && d <= to;
      });
    }
    _sum(list) { return { groups: list.length, guests: list.reduce((a, r) => a + r.guests, 0) }; }

    analytics(kind, p) {
      p = p || {};
      const today = p.today && isDate(p.today) ? p.today : localDate();
      const ymNow = ymOf(today);
      const monthSpan = (ym) => [ym + '-01', addDays(ymAdd(ym, 1) + '-01', -1)];
      const res = this.db.reservations;
      if (kind === 'top') {
        const mon = monday(today);
        const weeks = [-1, 0, 1].map((w) => { const a = addDays(mon, 7 * w), b = addDays(a, 6); return { from: a, to: b, ...this._sum(this._active(a, b)) }; });
        const months = [-1, 0, 1].map((n) => { const ym = ymAdd(ymNow, n), [a, b] = monthSpan(ym); return { ym, ...this._sum(this._active(a, b)) }; });
        const days = [];
        for (let i = -7; i <= 7; i++) { const s = addDays(today, i); days.push({ date: s, ...this._sum(this._active(s, s)) }); }
        const off = int(p.week == null ? 0 : p.week, -1, 2, '週');
        const wStart = addDays(mon, 7 * off), wDays = [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(wStart, i));
        const courseRows = this.db.courses.map((c) => ({ id: c.id, name: c.name, price: c.price, days: wDays.map((s) => res.filter((r) => r.date === s && ACTIVE.has(r.status)).reduce((a, r) => a + r.courses.filter((x) => x.courseId === c.id).reduce((b, x) => b + x.count, 0), 0)) }));
        const dayGuests = wDays.map((s) => this._sum(this._active(s, s)).guests);
        return { weeks, months, days, course: { week: off, days: wDays, rows: courseRows, dayGuests } };
      }
      if (kind === 'counts') {
        const basis = p.basis === 'accept' ? 'accept' : 'visit';
        const mode = p.mode || 'day';
        const year = int(p.year || today.slice(0, 4), 2000, 2100, '年'), month = int(p.month || today.slice(5, 7), 1, 12, '月');
        const ym = year + '-' + pad(month), [a, b] = monthSpan(ym);
        const dateOf = (r) => (basis === 'accept' ? acceptDate(r) : r.date);
        let rows;
        if (mode === 'month') {
          rows = [];
          for (let m = 1; m <= 12; m++) { const [x, y] = monthSpan(year + '-' + pad(m)); rows.push({ label: m + '月', ...this._sum(this._active(x, y, basis)) }); }
        } else {
          const list = this._active(a, b, basis);
          if (mode === 'day') {
            rows = [];
            for (let s = a; s <= b; s = addDays(s, 1)) rows.push({ label: +s.slice(5, 7) + '月' + +s.slice(8) + '日', ...this._sum(list.filter((r) => dateOf(r) === s)) });
          } else if (mode === 'hour') {
            const hourOf = (r) => (basis === 'accept' ? new Date(r.createdAt).getHours() : +r.time.slice(0, 2));
            rows = [];
            for (let hh = 0; hh < 30; hh++) { const l = list.filter((r) => hourOf(r) === hh); if (l.length || (hh >= 10 && hh <= 23)) rows.push({ label: hh + '時台', ...this._sum(l) }); }
          } else if (mode === 'weekday') {
            const W = ['日', '月', '火', '水', '木', '金', '土'];
            rows = [1, 2, 3, 4, 5, 6, 0].map((w) => ({ label: W[w] + '曜日', ...this._sum(list.filter((r) => new Date(dateOf(r) + 'T00:00:00').getDay() === w)) }));
          } else if (mode === 'lead') {
            const B = [[0, 0, '当日'], [1, 1, '前日'], [2, 3, '2〜3日前'], [4, 7, '4〜7日前'], [8, 14, '8〜14日前'], [15, 30, '15〜30日前'], [31, 1e9, '31日以上前']];
            const lead = (r) => Math.round((new Date(r.date + 'T00:00:00') - new Date(acceptDate(r) + 'T00:00:00')) / 86400000);
            rows = B.map(([x, y, label]) => ({ label, ...this._sum(list.filter((r) => { const n = Math.max(0, lead(r)); return n >= x && n <= y; })) }));
          } else throw bad('集計の種類が正しくありません');
        }
        return { mode, basis, year, month, rows };
      }
      if (kind === 'sources' || kind === 'cancels') {
        const months = ymRange(p.from || ymAdd(ymNow, -5), p.to || ymNow);
        if (kind === 'sources') {
          const rows = months.map((ym) => { const [a, b] = monthSpan(ym), list = this._active(a, b); const by = {}; for (const s of SOURCES) by[s] = this._sum(list.filter((r) => (r.source || 'その他') === s)); return { ym, by, total: this._sum(list) }; });
          return { sources: SOURCES, rows };
        }
        const rows = months.map((ym) => {
          const [a, b] = monthSpan(ym), all = res.filter((r) => r.date >= a && r.date <= b);
          const c = this._sum(all.filter((r) => r.status === 'cancel')), n = this._sum(all.filter((r) => r.status === 'noshow')), t = this._sum(all);
          return { ym, cancel: c, noshow: n, web: { groups: 0, guests: 0 }, total: { groups: c.groups + n.groups, guests: c.guests + n.guests }, all: t };
        });
        return { rows };
      }
      if (kind === 'visits') {
        const n = +p.months === 13 ? 13 : 6;
        const order = this._visitOrder();
        const rows = [];
        for (let i = n - 1; i >= 0; i--) {
          const ym = ymAdd(ymNow, -i), [a, b] = monthSpan(ym), c = [0, 0, 0, 0];
          for (const r of res) if (VISITED.has(r.status) && r.date >= a && r.date <= b && r.customerId) c[Math.min(order.get(r.id) || 1, 4) - 1]++;
          rows.push({ ym, counts: c });
        }
        return { rows };
      }
      if (kind === 'staff' || kind === 'course' || kind === 'free' || kind === 'tags') {
        const ym = p.ym && /^\d{4}-\d{2}$/.test(p.ym) ? p.ym : ymNow, [a, b] = monthSpan(ym), list = this._active(a, b);
        const m = new Map();
        const add = (key, groups, guests, amount) => { const x = m.get(key) || { name: key, groups: 0, guests: 0, amount: 0 }; x.groups += groups; x.guests += guests; x.amount += amount || 0; m.set(key, x); };
        for (const r of list) {
          if (kind === 'staff') add(r.staff || '（未選択）', 1, r.guests);
          else if (kind === 'free') { if (r.free) add(r.free, 1, r.guests); }
          else if (kind === 'tags') for (const t of r.tags) add(t, 1, r.guests);
          else for (const c of r.courses) { const k = this.db.courses.find((x) => x.id === c.courseId); if (k) add(k.name, 1, c.count, k.price * c.count); }
        }
        const rows = [...m.values()].sort((x, y) => (kind === 'course' ? y.guests - x.guests : y.groups - x.groups));
        return { ym, rows };
      }
      throw bad('分析の種類が正しくありません');
    }

    stats(from, to) {
      if (!isDate(from) || !isDate(to)) throw bad('日付が正しくありません');
      const lunchEnd = toMin(this.db.settings.lunchEnd);
      const t = { all: 0, groups: 0, guests: 0, visitedGroups: 0, cancels: 0, noshows: 0, lunchGroups: 0, lunchGuests: 0, dinnerGroups: 0, dinnerGuests: 0, firstTime: 0, repeat: 0, noName: 0 };
      const bySource = {}, byWeekday = [0, 1, 2, 3, 4, 5, 6].map(() => ({ groups: 0, guests: 0 }));
      const order = this._visitOrder();
      for (const r of this.db.reservations) {
        if (r.date < from || r.date > to) continue;
        t.all++;
        const src = r.source || '（未入力）';
        const bs = bySource[src] || (bySource[src] = { all: 0, groups: 0, guests: 0, cancels: 0, noshows: 0 });
        bs.all++;
        if (r.status === 'cancel') { t.cancels++; bs.cancels++; continue; }
        if (r.status === 'noshow') { t.noshows++; bs.noshows++; continue; }
        t.groups++; t.guests += r.guests; bs.groups++; bs.guests += r.guests;
        if (VISITED.has(r.status)) {
          t.visitedGroups++;
          if (!r.customerId) t.noName++;
          else if (order.get(r.id) === 1) t.firstTime++;
          else t.repeat++;
        }
        if (toMin(r.time) < lunchEnd) { t.lunchGroups++; t.lunchGuests += r.guests; } else { t.dinnerGroups++; t.dinnerGuests += r.guests; }
        const wd = new Date(r.date + 'T00:00:00').getDay();
        byWeekday[wd].groups++; byWeekday[wd].guests += r.guests;
      }
      const rep = { customers: 0, once: 0, twoPlus: 0, fivePlus: 0 };
      for (const s of this._custStats().values()) {
        if (!s.visits) continue;
        rep.customers++;
        if (s.visits === 1) rep.once++; else rep.twoPlus++;
        if (s.visits >= 5) rep.fivePlus++;
      }
      return { from, to, totals: t, bySource, byWeekday, repeat: rep };
    }

    // 来店した予約が、そのお客様の何回目の来店か
    _visitOrder() {
      const per = new Map(), out = new Map();
      const list = this.db.reservations.filter((r) => r.customerId && VISITED.has(r.status))
        .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
      for (const r of list) { const n = (per.get(r.customerId) || 0) + 1; per.set(r.customerId, n); out.set(r.id, n); }
      return out;
    }

    // ---------- CSV ----------
    _csv(rows) { const q = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; return '﻿' + rows.map((r) => r.map(q).join(',')).join('\r\n') + '\r\n'; }

    // 予約の一覧（お名前・電話番号が入る。この端末の中だけで使い、外へ送らない）
    reservationsCsv(from, to) {
      if (!isDate(from) || !isDate(to)) throw bad('日付が正しくありません');
      const d = this.db, label = { booked: '予約', seated: '来店', left: '退店', cancel: '予約取消', noshow: 'No Show' };
      const rows = [['予約番号', '来店日', '開始', '終了', '大人', 'お子様', '人数', 'テーブル', 'ご予約者', 'ふりがな', '携帯番号', '携帯番号2', '会社名', 'コース', '予約経路', '予約タグ', d.free.label, 'メモ', '状態', '担当者', '受付日時', '更新日時', '来店回数']];
      for (const r of d.reservations.filter((x) => x.date >= from && x.date <= to).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))) {
        const c = r.customerId && d.customers.find((x) => x.id === r.customerId), b = c ? this._brief(c) : null;
        rows.push(['#' + r.no, r.date, r.time, toTime(toMin(r.time) + r.stayMin), r.adultsMin === r.adults ? r.adults : r.adultsMin + '-' + r.adults, r.kidsMin === r.kids ? r.kids : r.kidsMin + '-' + r.kids, r.guests,
          r.tableIds.map((t) => (d.tables.find((x) => x.id === t) || {}).name).filter(Boolean).join('/'), c ? c.name : '', c ? c.kana : '', c ? c.phone : '', c ? c.phone2 : '', c ? c.company : '',
          r.courses.map((x) => { const k = d.courses.find((y) => y.id === x.courseId); return k ? k.name + '×' + x.count : ''; }).filter(Boolean).join('/'),
          r.source, r.tags.join('/'), r.free, r.memo, label[r.status], r.staff, new Date(r.createdAt).toLocaleString('ja-JP'), new Date(r.updatedAt).toLocaleString('ja-JP'), b ? b.visits : '']);
      }
      this._log('予約のCSVを書き出し', from + '〜' + to);
      return this._csv(rows);
    }

    // レジ（POS）のデータと突き合わせるための一覧。お名前・電話番号・メモは入れない。
    posLinkCsv(from, to) {
      if (!isDate(from) || !isDate(to)) throw bad('日付が正しくありません');
      const d = this.db, order = this._visitOrder();
      const rows = [['日付', '時刻', '滞在分', '人数', '席', 'レジの席番号', '顧客番号', '何回目の来店', 'コース', '経路', '状態']];
      const label = { booked: '予約', seated: '来店', left: '退店', cancel: 'キャンセル', noshow: '無断キャンセル' };
      for (const r of d.reservations.filter((x) => x.date >= from && x.date <= to).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))) {
        const ts = r.tableIds.map((t) => d.tables.find((x) => x.id === t)).filter(Boolean);
        const c = r.customerId && d.customers.find((x) => x.id === r.customerId);
        const course = d.courses.find((x) => x.id === r.courseId);
        rows.push([r.date, r.time, r.stayMin, r.guests, ts.map((t) => t.name).join('/'), ts.map((t) => t.pos).filter(Boolean).join('/'),
          c ? c.no : '', order.get(r.id) || '', course ? course.name : '', r.source, label[r.status]]);
      }
      this._log('レジ連携用の一覧を書き出し', from + '〜' + to);
      return this._csv(rows);
    }
  }

  const api = { Ledger, emptyDb, SOURCES, STATUSES, normPhone, normText, localDate, toMin, toTime, isDate, addDays, ymAdd, monday, WALKIN };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.YoyakuCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
