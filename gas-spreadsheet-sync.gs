// ============================================
// 賞味期限リマインダー - チーム共有（スプレッドシート版 v3）
// gas-spreadsheet-sync.gs
//
// 【セットアップ】
// 1. script.google.com で新しいプロジェクトを作成（既存を置き換えてもOK）
// 2. このコードを貼り付け、下の TOKEN をチームの合言葉に変更
// 3. デプロイ → 新しいデプロイ → ウェブアプリ
//    - 次のユーザーとして実行: 自分
//    - アクセスできるユーザー: 全員
// 4. URLと合言葉をチーム全員のアプリ設定画面に入力
//
// データは Google スプレッドシート「賞味期限リマインダー_データ」に
// 表形式で保存されます（商品/履歴/設定の3シート）。Drive上で直接閲覧・分析できます。
// ※ 画像（写真）はスプレッドシート版では保存されません。
// ============================================

var SHEET_NAME = '賞味期限リマインダー_データ';
var TOKEN = 'mokume-Kx72-stock';

var ITEM_COLS = ['id', 'name', 'expiry', 'remind', 'supplier', 'createdAt'];
var HIST_COLS = ['id', 'name', 'expiry', 'remind', 'supplier', 'createdAt', 'type', 'disposedAt', 'daysLeft'];

function doPost(e) {
  var req;
  try { req = JSON.parse(e.postData.contents); }
  catch (err) { return jsonOut({ error: 'invalid request' }); }
  if (!req.token || req.token !== TOKEN) return jsonOut({ error: 'unauthorized' });

  var lock = LockService.getScriptLock();
  try { lock.waitLock(15000); }
  catch (err) { return jsonOut({ error: 'busy' }); }

  try {
    var ss = getSpreadsheet();
    var state = readState(ss);
    var a = req.action;

    if (a === 'load') {
      // 読み取りのみ
    } else if (a === 'save') {
      var d = req.data || {};
      state = { items: d.items || [], history: d.history || [], settings: d.settings || {} };
    } else if (a === 'addItems') {
      var have = {};
      state.items.forEach(function(i) { have[i.id] = true; });
      (req.items || []).forEach(function(i) { if (!have[i.id]) state.items.push(i); });
    } else if (a === 'updateItem') {
      for (var i = 0; i < state.items.length; i++) {
        if (String(state.items[i].id) === String(req.item.id)) { state.items[i] = req.item; break; }
      }
    } else if (a === 'process') {
      var ids = {};
      (req.ids || []).forEach(function(id) { ids[String(id)] = true; });
      state.items = state.items.filter(function(i) { return !ids[String(i.id)]; });
      state.history = (req.entries || []).concat(state.history);
    } else if (a === 'deleteItems') {
      var ids2 = {};
      (req.ids || []).forEach(function(id) { ids2[String(id)] = true; });
      state.items = state.items.filter(function(i) { return !ids2[String(i.id)]; });
    } else if (a === 'saveSettings') {
      state.settings = req.settings || state.settings;
    } else if (a === 'renameSupplier') {
      var o = req.oldName, n = req.newName, s = state.settings;
      s.suppliers = (s.suppliers || []).map(function(x) { return x === o ? n : x; });
      if (s.supplierNotify && (o in s.supplierNotify)) {
        s.supplierNotify[n] = s.supplierNotify[o];
        delete s.supplierNotify[o];
      }
      state.items.forEach(function(i) { if (i.supplier === o) i.supplier = n; });
      state.history.forEach(function(h) { if (h.supplier === o) h.supplier = n; });
    } else if (a === 'removeSupplier') {
      var nm = req.name, s2 = state.settings;
      s2.suppliers = (s2.suppliers || []).filter(function(x) { return x !== nm; });
      if (s2.supplierNotify) delete s2.supplierNotify[nm];
      state.items.forEach(function(i) { if (i.supplier === nm) i.supplier = ''; });
    } else if (a === 'clearAll') {
      state.items = [];
    } else if (a === 'clearHistory') {
      state.history = [];
    } else {
      return jsonOut({ error: 'unknown action' });
    }

    if (state.history.length > 500) state.history = state.history.slice(0, 500);
    if (a !== 'load') writeState(ss, state);
    return jsonOut({ ok: true, state: state, savedAt: new Date().toISOString() });
  } finally {
    lock.releaseLock();
  }
}

// ============================================
// 毎日の自動リマインドメール
// 【有効化の手順】このGASエディタで一度だけ setupDailyTrigger を実行する
//   1. 上部の関数選択で「setupDailyTrigger」を選ぶ
//   2. ▶実行 を押す（権限承認を求められたら許可）
//   これで毎朝8時台に自動チェック＆送信が始まる（PCを開いていなくてOK）
// 【停止したいとき】removeDailyTrigger を同様に実行する
// 通知先は「設定」シートの email、送信ON/OFFは仕入れ先ごとの supplierNotify に従う
// ============================================

var SEND_HOUR = 8; // 送信時刻（8 = 8:00〜9:00台）

function setupDailyTrigger() {
  removeDailyTrigger();
  ScriptApp.newTrigger('dailyReminder')
    .timeBased().everyDays(1).atHour(SEND_HOUR).create();
  Logger.log('毎日' + SEND_HOUR + '時台の自動送信を設定しました');
}

function removeDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(function(t) {
    if (t.getHandlerFunction() === 'dailyReminder') ScriptApp.deleteTrigger(t);
  });
  Logger.log('自動送信トリガーを解除しました');
}

// トリガーから毎日呼ばれる本体
function dailyReminder() {
  var ss = getSpreadsheet();
  var state = readState(ss);
  var email = state.settings.email;
  if (!email || String(email).indexOf('@') < 0) {
    Logger.log('通知先メールが未設定のため送信しません');
    return;
  }

  var notify = state.settings.supplierNotify || {};
  function enabled(sup) { return notify[sup || ''] !== false; }

  var today = new Date();
  today.setHours(0, 0, 0, 0);

  var targets = [], expired = [];
  state.items.forEach(function(i) {
    if (!enabled(i.supplier)) return;
    var d = Math.round((new Date(i.expiry) - today) / 86400000);
    var remind = Number(i.remind) || 3;
    if (d < 0) expired.push({ name: i.name, expiry: i.expiry, d: d, supplier: i.supplier });
    else if (d <= remind) targets.push({ name: i.name, expiry: i.expiry, d: d, supplier: i.supplier });
  });

  if (targets.length === 0 && expired.length === 0) {
    Logger.log('通知対象なし');
    return;
  }

  var body = '賞味期限リマインダーからの自動通知です。\n\n';
  if (targets.length) {
    body += '■ まもなく期限の商品\n';
    targets.forEach(function(t) {
      var when = t.d === 0 ? '今日まで！' : t.d === 1 ? '明日まで！' : 'あと' + t.d + '日';
      body += '・' + t.name + '（期限: ' + t.expiry + '、' + when + (t.supplier ? '、仕入れ先: ' + t.supplier : '') + '）\n';
    });
    body += '\n';
  }
  if (expired.length) {
    body += '■ 期限切れの商品\n';
    expired.forEach(function(t) {
      body += '・' + t.name + '（期限: ' + t.expiry + '、' + Math.abs(t.d) + '日超過' + (t.supplier ? '、仕入れ先: ' + t.supplier : '') + '）\n';
    });
    body += '\n';
  }
  body += '早めにご確認ください。\n\n--\n賞味期限リマインダー（自動送信）';

  var count = targets.length + expired.length;
  MailApp.sendEmail(email, '【賞味期限アラート】' + count + '件の商品にご注意ください', body);
  Logger.log(count + '件を ' + email + ' に送信しました');
}

// 動作テスト用：今すぐ1通送ってみる（エディタから実行）
function testReminderNow() {
  dailyReminder();
}

function doGet() {
  var file = findSpreadsheet();
  var msg = file
    ? '共有スプレッドシートは存在します。\nURL: ' + file.getUrl()
    : '共有スプレッドシートはまだ作成されていません（最初の保存時に自動作成されます）';
  var hasTrigger = ScriptApp.getProjectTriggers().some(function(t) {
    return t.getHandlerFunction() === 'dailyReminder';
  });
  msg += '\n自動リマインドメール: ' + (hasTrigger ? '有効（毎日' + SEND_HOUR + '時台）' : '未設定（setupDailyTrigger を実行してください）');
  return ContentService.createTextOutput('賞味期限リマインダー スプレッドシート版 v3: 稼働中\n' + msg);
}

// ---------- スプレッドシート入出力 ----------

function getSpreadsheet() {
  var file = findSpreadsheet();
  if (file) return SpreadsheetApp.openById(file.getId());
  var ss = SpreadsheetApp.create(SHEET_NAME);
  initSheets(ss);
  return ss;
}

function findSpreadsheet() {
  var files = DriveApp.getFilesByName(SHEET_NAME);
  return files.hasNext() ? files.next() : null;
}

function initSheets(ss) {
  var first = ss.getSheets()[0];
  first.setName('商品');
  first.getRange(1, 1, 1, ITEM_COLS.length).setValues([ITEM_COLS]).setFontWeight('bold');
  var hist = ss.insertSheet('履歴');
  hist.getRange(1, 1, 1, HIST_COLS.length).setValues([HIST_COLS]).setFontWeight('bold');
  var set = ss.insertSheet('設定');
  set.getRange(1, 1, 1, 2).setValues([['key', 'value']]).setFontWeight('bold');
}

function readState(ss) {
  return {
    items: readSheet(ss.getSheetByName('商品'), ITEM_COLS),
    history: readSheet(ss.getSheetByName('履歴'), HIST_COLS),
    settings: readSettings(ss.getSheetByName('設定'))
  };
}

function readSheet(sheet, cols) {
  if (!sheet || sheet.getLastRow() < 2) return [];
  var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, cols.length).getValues();
  var out = [];
  values.forEach(function(row) {
    if (row[0] === '' && row[1] === '') return;
    var obj = {};
    cols.forEach(function(c, idx) {
      var v = row[idx];
      if (c === 'id' || c === 'remind' || c === 'daysLeft') {
        obj[c] = (v === '' ? '' : Number(v));
      } else if (v instanceof Date) {
        obj[c] = Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
      } else {
        obj[c] = (v === '' ? '' : String(v));
      }
    });
    out.push(obj);
  });
  return out;
}

function readSettings(sheet) {
  var settings = {};
  if (!sheet || sheet.getLastRow() < 2) return settings;
  var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 2).getValues();
  values.forEach(function(row) {
    if (row[0] === '') return;
    try { settings[row[0]] = JSON.parse(row[1]); }
    catch (e) { settings[row[0]] = row[1]; }
  });
  return settings;
}

function writeState(ss, state) {
  writeSheet(ss.getSheetByName('商品'), ITEM_COLS, state.items);
  writeSheet(ss.getSheetByName('履歴'), HIST_COLS, state.history);
  writeSettings(ss.getSheetByName('設定'), state.settings);
}

function writeSheet(sheet, cols, rows) {
  var last = sheet.getMaxRows();
  if (last > 1) sheet.getRange(2, 1, last - 1, cols.length).clearContent();
  if (!rows.length) return;
  var data = rows.map(function(obj) {
    return cols.map(function(c) {
      var v = obj[c];
      return (v === undefined || v === null) ? '' : v;
    });
  });
  sheet.getRange(2, 1, data.length, cols.length).setValues(data);
}

function writeSettings(sheet, settings) {
  var last = sheet.getMaxRows();
  if (last > 1) sheet.getRange(2, 1, last - 1, 2).clearContent();
  var keys = Object.keys(settings || {});
  if (!keys.length) return;
  var data = keys.map(function(k) {
    var v = settings[k];
    return [k, (typeof v === 'object') ? JSON.stringify(v) : String(v)];
  });
  sheet.getRange(2, 1, data.length, 2).setValues(data);
}

function jsonOut(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
