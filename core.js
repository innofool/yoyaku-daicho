'use strict';
// 予約台帳の決まり（予約・お客様・集計・レジ連携用の一覧）。
// 保存や暗号化はしない（vault.js の役目）。iPadのブラウザでも、試験用のNodeでも同じものが動く。
(function (root) {
  const STATUSES = ['booked', 'seated', 'left', 'cancel', 'noshow'];
  const ACTIVE = new Set(['booked', 'seated', 'left']);
  const VISITED = new Set(['seated', 'left']);
  const SOURCES = ['電話', '店頭', 'LINE', 'ネット', '飛び込み', 'その他'];
  const KEEP_LOG = 3000;

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

  function emptyDb() {
    return {
      v: 1,
      seq: { customer: 0 },
      settings: { storeName: '', open: '11:00', close: '23:00', defaultStayMin: 120, lunchEnd: '17:30', autoLockMin: 10, retentionYears: 3 },
      // 最初の席は仮のもの。設定画面でお店の席に直す。
      tables: [
        { id: newId('t_'), name: 'テーブル1', cap: 4, area: 'ホール', pos: '' },
        { id: newId('t_'), name: 'テーブル2', cap: 4, area: 'ホール', pos: '' },
        { id: newId('t_'), name: 'テーブル3', cap: 4, area: 'ホール', pos: '' },
        { id: newId('t_'), name: 'カウンター1', cap: 2, area: 'カウンター', pos: '' },
        { id: newId('t_'), name: 'カウンター2', cap: 2, area: 'カウンター', pos: '' },
        { id: newId('t_'), name: '個室1', cap: 8, area: '個室', pos: '' },
      ],
      courses: [],
      customers: [],
      reservations: [],
      log: [],
    };
  }

  class Ledger {
    constructor(db) { this.db = db; this._stats = null; }
    changed() { this._stats = null; }

    _log(act, ref) {
      this.db.log.push({ t: new Date().toISOString(), act, ref: ref || '' });
      if (this.db.log.length > KEEP_LOG) this.db.log.splice(0, this.db.log.length - KEEP_LOG);
    }
    log(limit) { return this.db.log.slice(-(limit || 200)).reverse(); }

    // ---------- 設定 ----------
    bootstrap() {
      const d = this.db;
      return { settings: d.settings, tables: d.tables, courses: d.courses, sources: SOURCES, counts: { customers: d.customers.length, reservations: d.reservations.length } };
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
        if (!Array.isArray(input.tables) || input.tables.length > 300) throw bad('席の設定が正しくありません');
        const seen = new Set();
        d.tables = input.tables.map((t) => {
          const name = str(t.name, 30);
          if (!name) throw bad('席の名前が空です');
          if (seen.has(name)) throw bad('同じ名前の席があります：' + name);
          seen.add(name);
          const old = d.tables.find((x) => x.id === t.id);
          return { id: old ? old.id : newId('t_'), name, cap: int(t.cap, 1, 200, '席の人数'), area: str(t.area, 30), pos: str(t.pos, 30) };
        });
        // 外した席に入っていた予約は「席未定」にする
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
      this._log('設定を変更');
      this.changed();
      return this.bootstrap();
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
      return { id: c.id, no: c.no, name: c.name, kana: c.kana, phone: c.phone, tags: c.tags, allergy: c.allergy, memo: c.memo, visits: s.visits, cancels: s.cancels, noshows: s.noshows, last: s.last, next: s.next };
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
      let list = this.db.customers;
      if (q) {
        list = list.filter((c) => normText(c.name).includes(q) || normText(c.kana).includes(q)
          || (qd.length >= 3 && normPhone(c.phone).includes(qd)) || c.tags.some((t) => normText(t).includes(q)));
      }
      if (opt.stale) {
        list = list.filter((c) => {
          const s = stats.get(c.id);
          const lastAct = (s && s.lastAny) || (c.createdAt || '').slice(0, 10);
          return lastAct < staleBefore;
        });
      }
      const total = list.length;
      const out = list.map((c) => this._brief(c))
        .sort((a, b) => (b.last || '').localeCompare(a.last || '') || b.no - a.no).slice(0, limit);
      return { customers: out, total, staleBefore };
    }

    getCustomer(id) {
      const c = this.db.customers.find((x) => x.id === id);
      if (!c) throw bad('お客様が見つかりません', 404);
      const history = this.db.reservations.filter((r) => r.customerId === id)
        .sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time)).map((r) => this._resOut(r, true));
      return { customer: this._brief(c), history };
    }

    _custFields(input, cur) {
      const name = str(input.name, 60), kana = str(input.kana, 60), phone = str(input.phone, 30).normalize('NFKC');
      if (!name && !normPhone(phone)) throw bad('お名前か電話番号のどちらかを入れてください');
      const tags = Array.isArray(input.tags) ? [...new Set(input.tags.map((t) => str(t, 20)).filter(Boolean))].slice(0, 10) : (cur ? cur.tags : []);
      return { name, kana, phone, tags, allergy: str(input.allergy != null ? input.allergy : cur && cur.allergy, 200), memo: str(input.memo != null ? input.memo : cur && cur.memo, 1000) };
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
    _resOut(r, noCustomer) {
      const out = { ...r, tableIds: [...r.tableIds] };
      if (!noCustomer) out.customer = r.customerId ? this._brief(this.db.customers.find((c) => c.id === r.customerId)) : null;
      return out;
    }

    listReservations(from, to) {
      if (!isDate(from) || !isDate(to)) throw bad('日付が正しくありません');
      const list = this.db.reservations.filter((r) => r.date >= from && r.date <= to)
        .sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time)).map((r) => this._resOut(r));
      return { reservations: list };
    }

    _conflicts(res) {
      if (!ACTIVE.has(res.status) || !res.tableIds.length) return [];
      const s = toMin(res.time), e = s + res.stayMin;
      return this.db.reservations.filter((o) => {
        if (o.id === res.id || o.date !== res.date || !ACTIVE.has(o.status)) return false;
        if (!o.tableIds.some((t) => res.tableIds.includes(t))) return false;
        const os = toMin(o.time), oe = os + o.stayMin;
        return s < oe && os < e;
      }).map((o) => {
        const c = o.customerId && this.db.customers.find((x) => x.id === o.customerId);
        return { id: o.id, time: o.time, stayMin: o.stayMin, guests: o.guests, name: c ? c.name : '', tables: o.tableIds.filter((t) => res.tableIds.includes(t)).map((t) => (this.db.tables.find((x) => x.id === t) || {}).name || '') };
      });
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
      const courseId = str(input.courseId, 40);
      if (courseId && !d.courses.some((c) => c.id === courseId)) throw bad('コースが見つかりません');
      const source = str(input.source, 20);
      if (source && !SOURCES.includes(source)) throw bad('予約の経路が正しくありません');
      const res = {
        id: cur ? cur.id : newId('r_'), date, time,
        stayMin: int(input.stayMin, 15, 720, '滞在時間'), guests: int(input.guests, 1, 300, '人数'),
        tableIds, customerId: cur ? cur.customerId : null, courseId, source, memo: str(input.memo, 500), status,
        createdAt: cur ? cur.createdAt : now, updatedAt: now,
      };
      const conflicts = this._conflicts(res);
      if (conflicts.length && !input.allowOverlap) return { conflicts };

      // お客様とのひも付け
      const ci = input.customer || {};
      const hasInfo = !!(str(ci.name, 60) || normPhone(ci.phone));
      if (input.customerId) {
        const c = d.customers.find((x) => x.id === input.customerId);
        if (!c) throw bad('お客様が見つかりません', 404);
        res.customerId = c.id;
        if (hasInfo) this._saveCustomer({ ...ci, tags: c.tags, memo: c.memo }, c.id);
      } else if (hasInfo) {
        // 電話番号とお名前が同じお客様がいれば、同じ人として扱う
        const ph = normPhone(ci.phone), nm = normText(ci.name);
        const same = ph ? d.customers.filter((c) => normPhone(c.phone) === ph && (!nm || !c.name || normText(c.name) === nm)) : [];
        if (same.length === 1) {
          res.customerId = same[0].id;
          // 書き方だけ違う同じお名前なら、登録済みの書き方を残す
          this._saveCustomer({ name: same[0].name || ci.name, kana: ci.kana || same[0].kana, phone: ci.phone, allergy: ci.allergy != null ? ci.allergy : same[0].allergy, tags: same[0].tags, memo: same[0].memo }, same[0].id);
        } else {
          res.customerId = this._saveCustomer(ci, null).id;
        }
      } else if (input.customerId === null) {
        res.customerId = null;
      }

      if (cur) Object.assign(cur, res); else d.reservations.push(res);
      this._log(cur ? '予約を変更' : '予約を登録', res.date + ' ' + res.time);
      this.changed();
      return { reservation: this._resOut(cur || res) };
    }

    setStatus(id, status) {
      const r = this.db.reservations.find((x) => x.id === id);
      if (!r) throw bad('予約が見つかりません', 404);
      if (!STATUSES.includes(status)) throw bad('状態が正しくありません');
      r.status = status;
      r.updatedAt = new Date().toISOString();
      this._log('予約の状態を変更', r.date + ' ' + r.time + ' → ' + status);
      this.changed();
      return { reservation: this._resOut(r) };
    }

    deleteReservation(id) {
      const i = this.db.reservations.findIndex((x) => x.id === id);
      if (i < 0) throw bad('予約が見つかりません', 404);
      const r = this.db.reservations[i];
      this.db.reservations.splice(i, 1);
      this._log('予約を削除', r.date + ' ' + r.time);
      this.changed();
      return { ok: true };
    }

    // ---------- 月の一覧・集計 ----------
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
      // お客様の来店回数の分布（全期間）
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

    // レジ（POS）のデータと突き合わせるための一覧。お名前・電話番号・メモは入れない。
    posLinkCsv(from, to) {
      if (!isDate(from) || !isDate(to)) throw bad('日付が正しくありません');
      const d = this.db, order = this._visitOrder();
      const q = (v) => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
      const rows = [['日付', '時刻', '滞在分', '人数', '席', 'レジの席番号', '顧客番号', '何回目の来店', 'コース', '経路', '状態'].map(q).join(',')];
      const label = { booked: '予約', seated: '来店', left: '退店', cancel: 'キャンセル', noshow: '無断キャンセル' };
      for (const r of d.reservations.filter((x) => x.date >= from && x.date <= to).sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time))) {
        const ts = r.tableIds.map((t) => d.tables.find((x) => x.id === t)).filter(Boolean);
        const c = r.customerId && d.customers.find((x) => x.id === r.customerId);
        const course = d.courses.find((x) => x.id === r.courseId);
        rows.push([r.date, r.time, r.stayMin, r.guests, ts.map((t) => t.name).join('/'), ts.map((t) => t.pos).filter(Boolean).join('/'),
          c ? c.no : '', order.get(r.id) || '', course ? course.name : '', r.source, label[r.status]].map(q).join(','));
      }
      this._log('レジ連携用の一覧を書き出し', from + '〜' + to);
      return '﻿' + rows.join('\r\n') + '\r\n';
    }
  }

  const api = { Ledger, emptyDb, SOURCES, STATUSES, normPhone, normText, localDate, toMin, isDate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.YoyakuCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
