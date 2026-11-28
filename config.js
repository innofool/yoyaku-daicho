'use strict';
// 受け口（インターネット上の置き場所）のアドレス。
// ・空のとき：前と同じ「合言葉・この端末の中だけ」の形で動く。
// ・決めたとき：メールアドレスとパスワードで使う形になる（同じIDの端末どうしで同じ台帳）。
// 本番の受け口を作ったら、下の PRODUCTION に Cloudflare のアドレスを入れ、index.html の connect-src にも足す。
(function () {
  var PRODUCTION = 'https://yoyaku-daicho-api.innofool.workers.dev';
  var DEV = 'http://127.0.0.1:8787'; // 手元の試験用（node server/dev.mjs）
  var local = location.hostname === '127.0.0.1' || location.hostname === 'localhost';
  window.YOYAKU_API = local ? DEV : PRODUCTION;
  // 正式に案内するアドレス（緊急キットに印刷する）。前のアドレス（innofool.github.io）からも当面は開ける
  var HOME = 'https://omotenasi-yoyaku.pages.dev/';
  window.YOYAKU_HOME = local ? location.origin + location.pathname : HOME;
})();
