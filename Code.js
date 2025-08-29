// 定数定義
const COLUMN_MAPPING = {
  NODE_URL: 2, // B列: ノードURL
  STATUS: 3, // C列: ステータス
  ERROR_TYPE: 4, // D列: エラータイプ
  DB: 5, // E列: DB
  API: 6, // F列: API
  BLOCK_HEIGHT: 7, // G列: ブロック高
  ERROR_DETECTED: 8, // H列: エラー発生日時
  LAST_NOTIFIED: 9, // I列: エラー最終通知日時
  DISABLED: 10, // J列: 無効フラグ
};

const STATUS_TYPES = {
  RUNNING: "Running",
  ERROR: "Error",
  DELAY: "Delay",
};

const ERROR_TYPES = {
  TIMEOUT: "Timeout",
  DB_API: "DB/API",
  BLOCK_DELAY: "BlockDelay",
  SSL_CERT: "SSL証明書期限切れ",
};

const FIRST_DATA_ROW = 4; // データ開始行
const REQUEST_TIMEOUT = 5000; // 5秒
const NOTIFICATION_INTERVAL = 30 * 60 * 1000; // 30分

/**
 * エントリーポイント - 5分毎にトリガーされる
 */
function main() {
  try {
    console.log("Symbol Node Monitoring開始");

    const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();

    // mainnetとtestnetのシートを処理
    processSheet(spreadsheet, "mainnet", true); // 通知あり
    // processSheet(spreadsheet, "testnet", false); // 通知なし

    console.log("Symbol Node Monitoring完了");
  } catch (error) {
    console.error("予期しないエラーが発生しました:", error);
    notifyError(`GASスクリプト実行エラー: ${error.toString()}`);
  }
}

/**
 * 指定されたシートの監視処理を実行
 * @param {GoogleAppsScript.Spreadsheet.Spreadsheet} spreadsheet
 * @param {string} sheetName
 * @param {boolean} enableNotification
 */
function processSheet(spreadsheet, sheetName, enableNotification) {
  const sheet = spreadsheet.getSheetByName(sheetName);
  if (!sheet) {
    console.log(`シート ${sheetName} が見つかりません`);
    return;
  }

  console.log(`${sheetName}シートの処理開始`);

  // 監視対象ノードの取得
  const nodes = getMonitoringNodes(sheet);
  if (nodes.length === 0) {
    console.log(`${sheetName}: 監視対象ノードが見つかりません`);
    return;
  }

  // 各ノードの監視
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    console.log(`${sheetName}: ${node.url} の監視開始`);
    monitorNode(sheet, node.row, node.url);
  }

  // ブロック遅延チェック
  checkBlockDelay(sheet, nodes);

  // 通知処理
  if (enableNotification) {
    processNotifications(sheet, nodes);
  }

  console.log(`${sheetName}シートの処理完了`);
}

/**
 * 監視対象ノードの一覧を取得
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @returns {Array<{row: number, url: string}>}
 */
function getMonitoringNodes(sheet) {
  const lastRow = sheet.getLastRow();
  const nodes = [];

  for (let row = FIRST_DATA_ROW; row <= lastRow; row++) {
    const url = sheet.getRange(row, COLUMN_MAPPING.NODE_URL).getValue();
    const disabled = sheet.getRange(row, COLUMN_MAPPING.DISABLED).getValue();

    if (url && url.toString().trim() !== "" && disabled !== "無効") {
      nodes.push({ row: row, url: url.toString().trim() });
    }
  }

  return nodes;
}

/**
 * 単一ノードの監視処理
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {number} row
 * @param {string} nodeUrl
 */
function monitorNode(sheet, row, nodeUrl) {
  try {
    // ヘルスチェック
    const healthResult = checkNodeHealth(nodeUrl);

    if (healthResult.timeout) {
      // タイムアウト
      setNodeError(sheet, row, STATUS_TYPES.ERROR, ERROR_TYPES.TIMEOUT);
      clearHealthData(sheet, row);
      return;
    }
    
    if (healthResult.sslError) {
      // SSL証明書エラー
      setNodeError(sheet, row, STATUS_TYPES.ERROR, ERROR_TYPES.SSL_CERT);
      clearHealthData(sheet, row);
      return;
    }

    if (healthResult.error) {
      console.warn(`${nodeUrl}: ヘルスチェックエラー - ${healthResult.error}`);
      return;
    }

    // ヘルスデータの更新
    sheet.getRange(row, COLUMN_MAPPING.DB).setValue(healthResult.db);
    sheet.getRange(row, COLUMN_MAPPING.API).setValue(healthResult.api);

    // ブロック高の取得
    const chainResult = getChainHeight(nodeUrl);
    if (chainResult.height !== null) {
      sheet
        .getRange(row, COLUMN_MAPPING.BLOCK_HEIGHT)
        .setValue(chainResult.height);
    }

    // DB/APIエラーチェック
    if (healthResult.db !== "up" || healthResult.api !== "up") {
      setNodeError(sheet, row, STATUS_TYPES.ERROR, ERROR_TYPES.DB_API);
    } else {
      // 正常状態の場合、エラー状態をクリア
      clearNodeError(sheet, row);
    }
  } catch (error) {
    console.error(`${nodeUrl}: 監視処理エラー - ${error}`);
  }
}

/**
 * ノードのヘルスチェック
 * @param {string} nodeUrl
 * @returns {{timeout: boolean, sslError: boolean, error: string|null, db: string, api: string}}
 */
function checkNodeHealth(nodeUrl) {
  try {
    const response = UrlFetchApp.fetch(`${nodeUrl}/node/health`, {
      method: "GET",
      muteHttpExceptions: true,
      timeout: REQUEST_TIMEOUT,
    });

    if (response.getResponseCode() !== 200) {
      return {
        timeout: false,
        sslError: false,
        error: `HTTP ${response.getResponseCode()}`,
        db: "",
        api: "",
      };
    }

    const data = JSON.parse(response.getContentText());
    const status = data.status || {};

    return {
      timeout: false,
      sslError: false,
      error: null,
      db: status.db || "unknown",
      api: status.apiNode || "unknown",
    };
  } catch (error) {
    const errorStr = error.toString();
    if (errorStr.includes("timeout") || errorStr.includes("Timeout")) {
      return { timeout: true, sslError: false, error: null, db: "", api: "" };
    }
    if (errorStr.includes("certificate") || errorStr.includes("SSL") || errorStr.includes("TLS")) {
      return { timeout: false, sslError: true, error: errorStr, db: "", api: "" };
    }
    return { timeout: false, sslError: false, error: errorStr, db: "", api: "" };
  }
}

/**
 * チェーンの高さを取得
 * @param {string} nodeUrl
 * @returns {{height: number|null, error: string|null}}
 */
function getChainHeight(nodeUrl) {
  try {
    const response = UrlFetchApp.fetch(`${nodeUrl}/chain/info`, {
      method: "GET",
      muteHttpExceptions: true,
      timeout: REQUEST_TIMEOUT,
    });

    if (response.getResponseCode() !== 200) {
      return { height: null, error: `HTTP ${response.getResponseCode()}` };
    }

    const data = JSON.parse(response.getContentText());
    const height = parseInt(data.height);

    return { height: isNaN(height) ? null : height, error: null };
  } catch (error) {
    return { height: null, error: error.toString() };
  }
}

/**
 * ノードのエラー状態を設定
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {number} row
 * @param {string} status
 * @param {string} errorType
 */
function setNodeError(sheet, row, status, errorType) {
  sheet.getRange(row, COLUMN_MAPPING.STATUS).setValue(status);
  sheet.getRange(row, COLUMN_MAPPING.ERROR_TYPE).setValue(errorType);

  // エラー発生日時が空白の場合のみ設定
  const errorDetected = sheet
    .getRange(row, COLUMN_MAPPING.ERROR_DETECTED)
    .getValue();
  if (!errorDetected) {
    sheet.getRange(row, COLUMN_MAPPING.ERROR_DETECTED).setValue(new Date());
  }
}

/**
 * ノードのエラー状態をクリア
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {number} row
 */
function clearNodeError(sheet, row) {
  // 復旧通知が必要かチェック
  const lastNotified = sheet
    .getRange(row, COLUMN_MAPPING.LAST_NOTIFIED)
    .getValue();
  const nodeUrl = sheet.getRange(row, COLUMN_MAPPING.NODE_URL).getValue();

  if (lastNotified) {
    // 復旧通知を送信
    sendRecoveryNotification(nodeUrl);
  }

  sheet.getRange(row, COLUMN_MAPPING.STATUS).setValue(STATUS_TYPES.RUNNING);
  sheet.getRange(row, COLUMN_MAPPING.ERROR_TYPE).setValue("");
  sheet.getRange(row, COLUMN_MAPPING.ERROR_DETECTED).setValue("");
  sheet.getRange(row, COLUMN_MAPPING.LAST_NOTIFIED).setValue("");
}

/**
 * ヘルスデータをクリア
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {number} row
 */
function clearHealthData(sheet, row) {
  sheet.getRange(row, COLUMN_MAPPING.DB).setValue("");
  sheet.getRange(row, COLUMN_MAPPING.API).setValue("");
  sheet.getRange(row, COLUMN_MAPPING.BLOCK_HEIGHT).setValue("");
}

/**
 * ブロック遅延チェック
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {Array<{row: number, url: string}>} nodes
 */
function checkBlockDelay(sheet, nodes) {
  const maxHeight = sheet.getRange(1, 3).getValue(); // C1: 基準ブロック高
  const threshold = sheet.getRange(1, 7).getValue(); // G1: ブロックしきい値

  if (!maxHeight || !threshold) {
    console.log("基準ブロック高またはしきい値が設定されていません");
    return;
  }

  const minAcceptableHeight = maxHeight - threshold;

  for (const node of nodes) {
    const currentHeight = sheet
      .getRange(node.row, COLUMN_MAPPING.BLOCK_HEIGHT)
      .getValue();

    if (currentHeight && currentHeight < minAcceptableHeight) {
      setNodeError(
        sheet,
        node.row,
        STATUS_TYPES.DELAY,
        ERROR_TYPES.BLOCK_DELAY
      );
      console.log(
        `${node.url}: ブロック遅延検出 (${currentHeight} < ${minAcceptableHeight})`
      );
    }
  }
}

/**
 * 通知処理
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {Array<{row: number, url: string}>} nodes
 */
function processNotifications(sheet, nodes) {
  const now = new Date();
  const notificationTargets = [];

  for (const node of nodes) {
    const status = sheet.getRange(node.row, COLUMN_MAPPING.STATUS).getValue();
    const lastNotified = sheet
      .getRange(node.row, COLUMN_MAPPING.LAST_NOTIFIED)
      .getValue();

    if (status !== STATUS_TYPES.RUNNING) {
      const shouldNotify =
        !lastNotified || now - lastNotified >= NOTIFICATION_INTERVAL;

      if (shouldNotify) {
        const errorType = sheet
          .getRange(node.row, COLUMN_MAPPING.ERROR_TYPE)
          .getValue();
        const errorDetected = sheet
          .getRange(node.row, COLUMN_MAPPING.ERROR_DETECTED)
          .getValue();

        notificationTargets.push({
          url: node.url,
          status: status,
          errorType: errorType,
          errorDetected: errorDetected,
          row: node.row,
        });
      }
    }
  }

  if (notificationTargets.length > 0) {
    sendNotification(sheet, notificationTargets);
  }
}

/**
 * 通知送信
 * @param {GoogleAppsScript.Spreadsheet.Sheet} sheet
 * @param {Array} targets
 */
function sendNotification(sheet, targets) {
  const now = new Date();
  const message = createNotificationMessage(targets);

  // メール通知
  try {
    let email = Session.getActiveUser().getEmail();
    if (!email) {
      email =
        PropertiesService.getScriptProperties().getProperty("EMAIL_ADDRESS");
    }

    if (email) {
      MailApp.sendEmail({
        to: email,
        subject: "Symbolノード監視アラート",
        body: message,
      });
      console.log(`メール通知送信完了: ${email}`);
    }
  } catch (error) {
    console.error("メール通知エラー:", error);
  }

  // Slack通知
  try {
    sendSlackNotification(message);
  } catch (error) {
    console.error("Slack通知エラー:", error);
  }

  // 最終通知日時を更新
  for (const target of targets) {
    sheet.getRange(target.row, COLUMN_MAPPING.LAST_NOTIFIED).setValue(now);
  }
}

/**
 * 通知メッセージを作成
 * @param {Array} targets
 * @returns {string}
 */
function createNotificationMessage(targets) {
  let message = "Symbolノード監視アラート\n\n";

  for (const target of targets) {
    message += `URL: ${target.url}\n`;
    message += `ステータス: ${target.status}\n`;
    message += `エラータイプ: ${target.errorType}\n`;
    message += `エラー検出日時: ${target.errorDetected}\n`;
    message += "\n";
  }

  return message;
}

/**
 * Slack通知
 * @param {string} message
 */
function sendSlackNotification(message) {
  const properties = PropertiesService.getScriptProperties();
  const webhookUrl = properties.getProperty("SLACK_WEBHOOK_URL");
  const token = properties.getProperty("SLACK_TOKEN");
  const channel = properties.getProperty("SLACK_CHANNEL");

  if (!webhookUrl && (!token || !channel)) {
    console.log("Slack設定が不完全です。通知をスキップします。");
    return;
  }

  const payload = {
    text: message,
  };

  if (webhookUrl) {
    // Webhook使用
    UrlFetchApp.fetch(webhookUrl, {
      method: "POST",
      contentType: "application/json",
      payload: JSON.stringify(payload),
    });
  } else if (token && channel) {
    // Bot token使用
    UrlFetchApp.fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      payload: JSON.stringify({
        channel: channel,
        text: message,
      }),
    });
  }

  console.log("Slack通知送信完了");
}

/**
 * 復旧通知
 * @param {string} nodeUrl
 */
function sendRecoveryNotification(nodeUrl) {
  const message = `Symbolノード復旧通知\n\nURL: ${nodeUrl}\nステータス: 復旧完了\n復旧確認日時: ${new Date()}\n\nノードは正常に動作しています。`;

  // メール通知
  try {
    let email = Session.getActiveUser().getEmail();
    if (!email) {
      email =
        PropertiesService.getScriptProperties().getProperty("EMAIL_ADDRESS");
    }

    if (email) {
      MailApp.sendEmail({
        to: email,
        subject: "Symbolノード監視 - 復旧通知",
        body: message,
      });
      console.log(`復旧通知メール送信完了: ${email}`);
    }
  } catch (error) {
    console.error("復旧通知メールエラー:", error);
  }

  // Slack通知
  try {
    sendSlackNotification(message);
  } catch (error) {
    console.error("復旧通知Slackエラー:", error);
  }
}

/**
 * エラー通知
 * @param {string} errorMessage
 */
function notifyError(errorMessage) {
  try {
    let email = Session.getActiveUser().getEmail();
    if (!email) {
      email =
        PropertiesService.getScriptProperties().getProperty("EMAIL_ADDRESS");
    }

    if (email) {
      MailApp.sendEmail({
        to: email,
        subject: "Symbolノード監視 - システムエラー",
        body: errorMessage,
      });
    }

    sendSlackNotification(`System Error: ${errorMessage}`);
  } catch (error) {
    console.error("エラー通知の送信に失敗:", error);
  }
}
