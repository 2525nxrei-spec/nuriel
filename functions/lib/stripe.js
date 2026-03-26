/**
 * Stripe関連ユーティリティ（Pages Functions用）
 * Stripe REST API直接呼び出し、Webhook署名検証、共通定数
 */

// ============================================================
// 定数
// ============================================================

export const STRIPE_API_BASE = 'https://api.stripe.com/v1';

// プランIDとD1の値のマッピング検証用
export const VALID_PLAN_IDS = ['otameshi', 'tappuri'];
export const VALID_BILLING_PERIODS = ['monthly', 'yearly'];

// Stripe本番Price IDマッピング（D1にPrice IDが未設定の場合のフォールバック）
export const STRIPE_PRICE_IDS = {
  otameshi: {
    monthly: 'price_1TF9k09Fc8Hnuaoko8QNE9PR',  // ¥100/月
    yearly: 'price_1TFFQ99Fc8HnuaokGaHGFIWS',   // ¥1,000/年
  },
  tappuri: {
    monthly: 'price_1TF9k09Fc8HnuaokNAzdNPRv',   // ¥300/月
    yearly: 'price_1TFFRU9Fc8HnuaokqFdzJaJk',    // ¥3,000/年
  },
};

// ============================================================
// Stripe APIヘルパー
// ============================================================

/**
 * Stripe REST APIを呼び出す汎用ヘルパー
 *
 * @param {string} endpoint - APIエンドポイント（例: 'customers'）
 * @param {string} method - HTTPメソッド
 * @param {Object|null} body - リクエストボディ（form-urlencoded形式で送信）
 * @param {string} apiKey - Stripe Secret Key
 * @returns {Promise<Object>} Stripe APIレスポンス
 * @throws {Error} API呼び出し失敗時
 */
export async function stripeRequest(endpoint, method, body, apiKey) {
  const options = {
    method,
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  };

  // GETリクエストの場合はbodyを送らない（クエリパラメータに変換）
  if (body && method !== 'GET') {
    options.body = buildFormBody(body);
  }

  let url = `${STRIPE_API_BASE}/${endpoint}`;
  if (body && method === 'GET') {
    url += '?' + buildFormBody(body);
  }

  const response = await fetch(url, options);
  const data = await response.json();

  // Stripe APIエラーのハンドリング
  if (data.error) {
    const errMsg = data.error.message || 'Stripe APIエラー';
    console.error(`Stripe APIエラー [${endpoint}]:`, JSON.stringify(data.error));
    throw new StripeApiError(errMsg, data.error.type, data.error.code, response.status);
  }

  return data;
}

/**
 * オブジェクトをx-www-form-urlencoded形式の文字列に変換
 * ネストされたオブジェクトはStripeの形式（例: metadata[key]=value）に対応
 *
 * @param {Object} obj - 変換対象オブジェクト
 * @param {string} prefix - ネスト時のプレフィックス
 * @returns {string} エンコード済み文字列
 */
export function buildFormBody(obj, prefix = '') {
  const params = new URLSearchParams();

  function flatten(o, p) {
    for (const [key, value] of Object.entries(o)) {
      const fullKey = p ? `${p}[${key}]` : key;
      if (value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value)) {
        flatten(value, fullKey);
      } else if (Array.isArray(value)) {
        // 配列はStripeの形式: items[0][price]=xxx
        value.forEach((item, i) => {
          if (typeof item === 'object' && item !== null) {
            flatten(item, `${fullKey}[${i}]`);
          } else {
            params.append(`${fullKey}[${i}]`, String(item));
          }
        });
      } else if (value !== null && value !== undefined) {
        params.append(fullKey, String(value));
      }
    }
  }

  flatten(obj, prefix);
  return params.toString();
}

/**
 * Stripe API固有のエラークラス
 */
export class StripeApiError extends Error {
  constructor(message, type, code, httpStatus) {
    super(message);
    this.name = 'StripeApiError';
    this.type = type;
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

// ============================================================
// Stripe Webhook署名検証
// ============================================================

/**
 * Stripe Webhookの署名を検証する
 * crypto.subtleを使用してHMAC-SHA256で検証
 *
 * @param {string} payload - リクエストボディ（生テキスト）
 * @param {string} signatureHeader - Stripe-Signatureヘッダー値
 * @param {string} secret - Webhook Signing Secret
 * @param {number} toleranceSec - タイムスタンプ許容範囲（秒）。デフォルト300秒（5分）
 * @returns {Promise<Object>} 検証済みイベントオブジェクト
 * @throws {Error} 署名検証失敗時
 */
export async function verifyStripeSignature(payload, signatureHeader, secret, toleranceSec = 300) {
  if (!signatureHeader) {
    throw new Error('Stripe-Signatureヘッダーがありません');
  }

  // ヘッダーからtimestampとsignatureを分離
  const elements = signatureHeader.split(',');
  let timestamp = null;
  const signatures = [];

  for (const element of elements) {
    const [key, value] = element.split('=', 2);
    if (key === 't') {
      timestamp = parseInt(value, 10);
    } else if (key === 'v1') {
      signatures.push(value);
    }
  }

  if (!timestamp || signatures.length === 0) {
    throw new Error('Stripe-Signatureヘッダーの形式が不正です');
  }

  // タイムスタンプの許容範囲チェック（リプレイ攻撃防止）
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > toleranceSec) {
    throw new Error(`Webhookタイムスタンプが許容範囲外です（差分: ${Math.abs(now - timestamp)}秒）`);
  }

  // 署名対象文字列を構築: timestamp.payload
  const signedPayload = `${timestamp}.${payload}`;

  // HMAC-SHA256で期待署名を計算
  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);
  const msgData = encoder.encode(signedPayload);

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signatureBuffer = await crypto.subtle.sign('HMAC', cryptoKey, msgData);

  // バイナリをhex文字列に変換
  const expectedSignature = Array.from(new Uint8Array(signatureBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  // タイミングセーフ比較（定数時間比較）
  const isValid = signatures.some(sig => timingSafeEqual(sig, expectedSignature));

  if (!isValid) {
    throw new Error('Webhook署名の検証に失敗しました');
  }

  // 検証成功: ペイロードをパースして返却
  return JSON.parse(payload);
}

/**
 * タイミングセーフな文字列比較
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) {
    b = a;
  }

  let result = a.length === b.length ? 0 : 1;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

// ============================================================
// モックモード判定
// ============================================================

/**
 * Stripeのモックモード判定
 * @param {Object} env - 環境変数
 * @returns {boolean}
 */
export function isMockMode(env) {
  return !env.STRIPE_SECRET_KEY;
}
