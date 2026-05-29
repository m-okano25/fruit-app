// ============================================================
// 果物売上管理アプリ - Google Apps Script（同期用・分割保存版）
// ============================================================
// データ量が増えても保存できるように、JSONを複数行に分割して保存します。
// Apps Scriptにこのファイルの内容をすべて貼り付けて、既存デプロイを更新してください。
// ============================================================

var SHEET_NAME = 'FruitData';
var CHUNK_SIZE = 40000;

function getDataSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);
  return sheet;
}

function readJsonText_(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 1) return '{}';

  var mode = String(sheet.getRange('A1').getValue() || '');

  // 新方式: A1に FRUIT_APP_CHUNK_V2、A2以降に分割JSON
  if (mode === 'FRUIT_APP_CHUNK_V2') {
    var chunkCount = Number(sheet.getRange('B1').getValue() || 0);
    if (!chunkCount) return '{}';
    var values = sheet.getRange(2, 1, chunkCount, 1).getValues();
    return values.map(function(row) { return row[0] || ''; }).join('');
  }

  // 旧方式: A1にJSONを丸ごと保存
  var legacy = sheet.getRange('A1').getValue();
  return legacy || '{}';
}

function writeJsonText_(sheet, jsonText) {
  var chunks = [];
  for (var i = 0; i < jsonText.length; i += CHUNK_SIZE) {
    chunks.push([jsonText.slice(i, i + CHUNK_SIZE)]);
  }

  sheet.clearContents();
  sheet.getRange('A1').setValue('FRUIT_APP_CHUNK_V2');
  sheet.getRange('B1').setValue(chunks.length);
  sheet.getRange('C1').setValue('最終同期：' + new Date().toLocaleString('ja-JP'));

  if (chunks.length > 0) {
    sheet.getRange(2, 1, chunks.length, 1).setValues(chunks);
  }
}

function makeOutput_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// データ取得（GET）
function doGet(e) {
  var sheet = getDataSheet_();
  var data = { sales: [], products: [], inventory: [], stockHistory: [] };

  try {
    var text = readJsonText_(sheet);
    if (text && text !== '{}') data = JSON.parse(text);
  } catch (err) {
    data = {
      sales: [],
      products: [],
      inventory: [],
      stockHistory: [],
      error: String(err)
    };
  }

  return makeOutput_(data);
}

// データ保存（POST）
function doPost(e) {
  var sheet = getDataSheet_();

  try {
    var newText = e && e.postData && e.postData.contents ? e.postData.contents : '{}';
    var newData = JSON.parse(newText);
    var newCount = newData.sales ? newData.sales.length : 0;

    // 念のため、クラウド側の件数も確認する。ただし「多い端末から保存」は許可する。
    var currentCount = 0;
    try {
      var currentText = readJsonText_(sheet);
      var currentData = currentText && currentText !== '{}' ? JSON.parse(currentText) : {};
      currentCount = currentData.sales ? currentData.sales.length : 0;
    } catch (_) {}

    // 少ないデータで多いクラウドを上書きしない保護
    if (newCount < currentCount) {
      return makeOutput_({
        success: false,
        rejected: true,
        reason: 'クラウド側の売上' + currentCount + '件より少ない売上' + newCount + '件のため、上書きを拒否しました。',
        cloudSales: currentCount,
        receivedSales: newCount
      });
    }

    writeJsonText_(sheet, newText);

    sheet.getRange('C2').setValue('売上件数：' + newCount + ' 件');
    sheet.getRange('C3').setValue('商品数：' + (newData.products ? newData.products.length : 0) + ' 件');
    sheet.getRange('C4').setValue('在庫管理商品数：' + (newData.inventory ? newData.inventory.length : 0) + ' 件');
    sheet.getRange('C5').setValue('入出荷履歴：' + (newData.stockHistory ? newData.stockHistory.length : 0) + ' 件');

    return makeOutput_({
      success: true,
      timestamp: new Date().toISOString(),
      savedSales: newCount
    });
  } catch (err) {
    return makeOutput_({
      success: false,
      error: String(err)
    });
  }
}
