/**
 * ヌリエル — Stripe決済ハンドラ
 *
 * ペット写真→塗り絵線画AI変換サービスの課金処理を担当。
 * Cloudflare Workers環境のためStripe SDKは使わず、fetch()でREST API直接呼び出し。
 * STRIPE_SECRET_KEY未設定時はモックモードで安全に動作。
 */

// ============================================================
// 定数
// ============================================================

const STRIPE_API_BASE = 'https://api.stripe.com/v1';

// プランIDとD1の値のマッピング検証用
const VALID_PLAN_IDS = ['otameshi', 'tappuri'];
const VALID_BILLING_PERIODS = ['monthly', 'yearly'];

// Stripe本番Price IDマッピング（D1にPrice IDが未設定の場合のフォールバック）
const STRIPE_PRICE_IDS = {
  otameshi: {
    monthly: 'price_1TF9k09Fc8Hnuaoko8QNE9PR',  // ¥100/月
    yearly: null,                                   // 年額は未設定
  },
  tappuri: {
    monthly: 'price_1TF9k09Fc8HnuaokNAzdNPRv',   // ¥300/月
    yearly: null,                                   // 年額は未設定
  },
};

// ============================================================
// ユーティリティ: JSON/エラーレスポンス
// ============================================================

/**
 * JSONレスポンスを生成
 * @param {Object} data - レスポンスボディ
 * @param {number} status - HTTPステータスコード
 * @returns {Response}
 */
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify({ ok: true, ...data }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

/**
 * エラーレスポンスを生成
 * @param {string} message - エラーメッセージ
 * @param {number} status - HTTPステータスコード
 * @returns {Response}
 */
function errorResponse(message, status = 400) {
  return new Response(JSON.stringify({ ok: false, error: message }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

// ============================================================
// ユーティリティ: UUID生成
// ============================================================

/**
 * UUIDv4を生成（crypto.randomUUID使用）
 * @returns {string}
 */
function generateUUID() {
  return crypto.randomUUID();
}

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
async function stripeRequest(endpoint, method, body, apiKey) {
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
function buildFormBody(obj, prefix = '') {
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
class StripeApiError extends Error {
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
async function verifyStripeSignature(payload, signatureHeader, secret, toleranceSec = 300) {
  if (!signatureHeader) {
    throw new Error('Stripe-Signatureヘッダーがありません');
  }

  // ヘッダーからtimestampとsignatureを分離
  // 形式: t=timestamp,v1=signature,v0=signature(旧形式)
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
 * サイドチャネル攻撃を防ぐため、常に全文字を比較する
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) {
    // 長さが異なる場合もダミー比較を実行（タイミングリーク防止）
    // ただし長さ不一致自体は漏洩するが、Stripe署名は固定長なので問題ない
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
 * STRIPE_SECRET_KEY未設定時はモックで動作
 *
 * @param {Object} env - Workers環境変数
 * @returns {boolean}
 */
function isMockMode(env) {
  return !env.STRIPE_SECRET_KEY;
}

// ============================================================
// ハンドラ: プラン一覧取得
// ============================================================

/**
 * GET /api/billing/plans
 * D1からプラン一覧を取得して返却（認証不要）
 *
 * @param {Request} request
 * @param {Object} env
 * @returns {Promise<Response>}
 */
export async function handlePlans(request, env) {
  try {
    const { results } = await env.NURIEL_DB
      .prepare('SELECT id, name, price_monthly, price_yearly, monthly_limit, styles_allowed, gallery_limit FROM plans ORDER BY price_monthly ASC')
      .all();

    // styles_allowedをJSON配列にパース
    const plans = results.map(plan => ({
      id: plan.id,
      name: plan.name,
      price_monthly: plan.price_monthly,
      price_yearly: plan.price_yearly,
      monthly_limit: plan.monthly_limit,
      styles_allowed: JSON.parse(plan.styles_allowed || '[]'),
      gallery_limit: plan.gallery_limit,
    }));

    return jsonResponse({ plans });
  } catch (err) {
    console.error('プラン一覧取得エラー:', err.message);
    return errorResponse('プラン情報の取得に失敗しました', 500);
  }
}

// ============================================================
// ハンドラ: Checkoutセッション作成
// ============================================================

/**
 * POST /api/billing/checkout
 * Stripe Checkout Sessionを作成し、checkout URLを返却
 *
 * @param {Request} request
 * @param {Object} env
 * @param {Object} user - 認証済みユーザー
 * @returns {Promise<Response>}
 */
export async function handleCheckout(request, env, user) {
  try {
    // --- リクエストバリデーション ---
    const body = await request.json();
    const { plan_id, billing_period } = body;

    if (!plan_id || !VALID_PLAN_IDS.includes(plan_id)) {
      return errorResponse('無効なプランIDです。otameshi または tappuri を指定してください。', 400);
    }

    if (!billing_period || !VALID_BILLING_PERIODS.includes(billing_period)) {
      return errorResponse('無効な請求期間です。monthly または yearly を指定してください。', 400);
    }

    // --- D1からプラン情報取得 ---
    const plan = await env.NURIEL_DB
      .prepare('SELECT * FROM plans WHERE id = ?')
      .bind(plan_id)
      .first();

    if (!plan) {
      return errorResponse('指定されたプランが見つかりません', 404);
    }

    // 対応するStripe Price IDを決定（D1の値を優先、未設定なら定数からフォールバック）
    const periodKey = billing_period === 'monthly' ? 'monthly' : 'yearly';
    const priceId = (billing_period === 'monthly' ? plan.stripe_price_id_monthly : plan.stripe_price_id_yearly)
      || STRIPE_PRICE_IDS[plan_id]?.[periodKey]
      || null;

    if (!priceId) {
      return errorResponse('このプランの価格設定が見つかりません', 500);
    }

    // --- モックモード ---
    if (isMockMode(env)) {
      const frontendUrl = env.FRONTEND_URL || 'http://localhost:8788';
      const mockCheckoutUrl = `${frontendUrl}/app.html#plan?mock_checkout=success&plan_id=${plan_id}&billing_period=${billing_period}&methods=card,paypay,applepay,googlepay`;

      console.log(`[モック] Checkoutセッション作成: plan=${plan_id}, period=${billing_period}, user=${user.id}`);
      return jsonResponse({ checkout_url: mockCheckoutUrl });
    }

    // --- Stripe顧客の確認/作成 ---
    let stripeCustomerId = user.stripe_customer_id;

    if (!stripeCustomerId) {
      // 新規Stripe顧客を作成
      const customer = await stripeRequest('customers', 'POST', {
        email: user.email,
        name: user.display_name || user.email,
        metadata: {
          nuriel_user_id: user.id,
        },
      }, env.STRIPE_SECRET_KEY);

      stripeCustomerId = customer.id;

      // D1にStripe顧客IDを保存
      await env.NURIEL_DB
        .prepare('UPDATE users SET stripe_customer_id = ?, updated_at = datetime(\'now\') WHERE id = ?')
        .bind(stripeCustomerId, user.id)
        .run();
    }

    // --- Stripe Checkout Session作成 ---
    const frontendUrl = env.FRONTEND_URL || 'http://localhost:8788';

    // PayPay・カード決済対応（Apple Pay/Google PayはStripe Checkout側で自動有効化）
    const session = await stripeRequest('checkout/sessions', 'POST', {
      mode: 'subscription',
      customer: stripeCustomerId,
      'payment_method_types[0]': 'card',
      'payment_method_types[1]': 'paypay',
      locale: 'ja',
      'line_items[0][price]': priceId,
      'line_items[0][quantity]': '1',
      success_url: `${frontendUrl}/app.html#plan?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${frontendUrl}/app.html#plan`,
      metadata: {
        user_id: user.id,
        plan_id: plan_id,
      },
      subscription_data: {
        metadata: {
          user_id: user.id,
          plan_id: plan_id,
        },
      },
    }, env.STRIPE_SECRET_KEY);

    console.log(`Checkoutセッション作成: session=${session.id}, plan=${plan_id}, user=${user.id}`);
    return jsonResponse({ checkout_url: session.url });
  } catch (err) {
    if (err instanceof StripeApiError) {
      console.error('Stripe Checkoutエラー:', err.message, err.type, err.code);
      return errorResponse('決済セッションの作成に失敗しました。しばらくしてからお試しください。', 502);
    }
    console.error('Checkoutエラー:', err.message, err.stack);
    return errorResponse('決済処理中にエラーが発生しました', 500);
  }
}

// ============================================================
// ハンドラ: Stripe Webhook
// ============================================================

/**
 * POST /api/billing/webhook
 * Stripe Webhookイベントを検証・処理（認証不要・署名検証で保護）
 *
 * @param {Request} request
 * @param {Object} env
 * @returns {Promise<Response>}
 */
export async function handleWebhook(request, env) {
  // --- モックモード: Webhookはスキップ ---
  if (isMockMode(env)) {
    console.log('[モック] Webhookリクエストをスキップ');
    return jsonResponse({ received: true });
  }

  try {
    // --- 署名検証 ---
    const payload = await request.text();
    const signatureHeader = request.headers.get('stripe-signature');

    if (!env.STRIPE_WEBHOOK_SECRET) {
      console.error('STRIPE_WEBHOOK_SECRETが設定されていません');
      return errorResponse('Webhook設定エラー', 500);
    }

    let event;
    try {
      event = await verifyStripeSignature(payload, signatureHeader, env.STRIPE_WEBHOOK_SECRET);
    } catch (verifyErr) {
      console.error('Webhook署名検証失敗:', verifyErr.message);
      return errorResponse('Webhook署名の検証に失敗しました', 400);
    }

    // --- 冪等性チェック: 同じイベントIDの二重処理を防止 ---
    const existingEvent = await env.NURIEL_DB
      .prepare('SELECT id FROM webhooks_log WHERE stripe_event_id = ?')
      .bind(event.id)
      .first();

    if (existingEvent) {
      console.log(`Webhook冪等性: イベント ${event.id} は処理済み。スキップ。`);
      return jsonResponse({ received: true, status: 'already_processed' });
    }

    // --- イベント処理 ---
    console.log(`Webhook受信: type=${event.type}, id=${event.id}`);

    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(event, env);
        break;

      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(event, env);
        break;

      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event, env);
        break;

      case 'invoice.payment_succeeded':
        await handlePaymentSucceeded(event, env);
        break;

      case 'invoice.payment_failed':
        await handlePaymentFailed(event, env);
        break;

      default:
        console.log(`未対応のWebhookイベント: ${event.type}`);
        break;
    }

    // --- Webhookログに記録 ---
    await logWebhookEvent(event, env);

    return jsonResponse({ received: true });
  } catch (err) {
    console.error('Webhook処理エラー:', err.message, err.stack);
    // Webhookは500を返すとStripeがリトライするので、処理不能な場合でも200を返す場面もあるが、
    // 予期しないエラーの場合はリトライを促すため500を返す
    return errorResponse('Webhook処理中にエラーが発生しました', 500);
  }
}

// ============================================================
// Webhookイベント処理: 個別ハンドラ
// ============================================================

/**
 * checkout.session.completed — 新規サブスクリプション開始
 * Checkout完了後にユーザーのプランを更新し、サブスクリプションIDを保存
 *
 * @param {Object} event - Stripeイベント
 * @param {Object} env
 */
async function handleCheckoutCompleted(event, env) {
  const session = event.data.object;
  const userId = session.metadata?.user_id;
  const planId = session.metadata?.plan_id;
  const subscriptionId = session.subscription;
  const customerId = session.customer;

  if (!userId || !planId) {
    console.error('checkout.session.completed: metadataにuser_idまたはplan_idがありません', JSON.stringify(session.metadata));
    return;
  }

  // プランIDの妥当性検証
  if (!VALID_PLAN_IDS.includes(planId)) {
    console.error(`checkout.session.completed: 無効なplan_id: ${planId}`);
    return;
  }

  // ユーザーのプラン・サブスク情報を更新
  const result = await env.NURIEL_DB
    .prepare(`
      UPDATE users
      SET plan = ?,
          stripe_customer_id = COALESCE(stripe_customer_id, ?),
          stripe_subscription_id = ?,
          updated_at = datetime('now')
      WHERE id = ?
    `)
    .bind(planId, customerId, subscriptionId, userId)
    .run();

  if (result.meta.changes === 0) {
    console.error(`checkout.session.completed: ユーザー ${userId} が見つかりません`);
    return;
  }

  console.log(`サブスク開始: user=${userId}, plan=${planId}, subscription=${subscriptionId}`);
}

/**
 * customer.subscription.updated — サブスクリプション変更（プランアップ/ダウングレード）
 *
 * @param {Object} event - Stripeイベント
 * @param {Object} env
 */
async function handleSubscriptionUpdated(event, env) {
  const subscription = event.data.object;
  const subscriptionId = subscription.id;
  const customerId = subscription.customer;

  // サブスクリプションのmetadataからplan_idを取得
  let planId = subscription.metadata?.plan_id;

  // metadataにplan_idがない場合、price_idからプランを逆引き
  if (!planId) {
    const priceId = subscription.items?.data?.[0]?.price?.id;
    if (priceId) {
      const plan = await env.NURIEL_DB
        .prepare('SELECT id FROM plans WHERE stripe_price_id_monthly = ? OR stripe_price_id_yearly = ?')
        .bind(priceId, priceId)
        .first();
      planId = plan?.id;
    }
  }

  if (!planId) {
    console.error(`subscription.updated: plan_idを特定できません。subscription=${subscriptionId}`);
    return;
  }

  // ステータスが有効でない場合（past_due, unpaid等）はプラン更新しない
  // ただしcanceledの場合はsubscription.deletedで処理される
  if (subscription.status !== 'active' && subscription.status !== 'trialing') {
    console.log(`subscription.updated: ステータスが ${subscription.status} のためプラン更新スキップ。subscription=${subscriptionId}`);
    return;
  }

  // stripe_customer_idからユーザーを特定してプラン更新
  const result = await env.NURIEL_DB
    .prepare(`
      UPDATE users
      SET plan = ?,
          stripe_subscription_id = ?,
          updated_at = datetime('now')
      WHERE stripe_customer_id = ?
    `)
    .bind(planId, subscriptionId, customerId)
    .run();

  if (result.meta.changes === 0) {
    console.error(`subscription.updated: 顧客 ${customerId} に対応するユーザーが見つかりません`);
    return;
  }

  console.log(`プラン変更: customer=${customerId}, plan=${planId}, subscription=${subscriptionId}`);
}

/**
 * customer.subscription.deleted — サブスクリプション解約
 * ユーザーのプランをfreeに戻す
 *
 * @param {Object} event - Stripeイベント
 * @param {Object} env
 */
async function handleSubscriptionDeleted(event, env) {
  const subscription = event.data.object;
  const subscriptionId = subscription.id;
  const customerId = subscription.customer;

  // ユーザーのプランをfreeに戻し、サブスクIDをクリア
  const result = await env.NURIEL_DB
    .prepare(`
      UPDATE users
      SET plan = 'free',
          stripe_subscription_id = NULL,
          updated_at = datetime('now')
      WHERE stripe_customer_id = ?
    `)
    .bind(customerId)
    .run();

  if (result.meta.changes === 0) {
    console.error(`subscription.deleted: 顧客 ${customerId} に対応するユーザーが見つかりません`);
    return;
  }

  console.log(`サブスク解約: customer=${customerId}, subscription=${subscriptionId}。プランをfreeに変更。`);
}

/**
 * invoice.payment_succeeded — 支払い成功
 * 継続課金の成功ログ。月次リセット日を更新。
 *
 * @param {Object} event - Stripeイベント
 * @param {Object} env
 */
async function handlePaymentSucceeded(event, env) {
  const invoice = event.data.object;
  const customerId = invoice.customer;
  const subscriptionId = invoice.subscription;
  const amountPaid = invoice.amount_paid;

  // 月次生成カウントをリセット & リセット日を更新
  const result = await env.NURIEL_DB
    .prepare(`
      UPDATE users
      SET monthly_generation_count = 0,
          monthly_reset_date = datetime('now'),
          updated_at = datetime('now')
      WHERE stripe_customer_id = ?
    `)
    .bind(customerId)
    .run();

  if (result.meta.changes === 0) {
    // 初回請求時など、まだWebhookのcheckout.session.completedが来ていない場合がある
    console.warn(`payment_succeeded: 顧客 ${customerId} に対応するユーザーが見つかりません（初回請求の可能性）`);
    return;
  }

  console.log(`支払い成功: customer=${customerId}, subscription=${subscriptionId}, amount=${amountPaid}円`);
}

/**
 * invoice.payment_failed — 支払い失敗
 * ユーザーへの通知フラグを立てる（payment_failed_at列に日時を記録）
 *
 * 注意: usersテーブルに payment_failed_at 列がない場合は、
 * updated_atを更新してログ記録のみ行う。
 * 本番運用時にはメール通知等の仕組みを追加する。
 *
 * @param {Object} event - Stripeイベント
 * @param {Object} env
 */
async function handlePaymentFailed(event, env) {
  const invoice = event.data.object;
  const customerId = invoice.customer;
  const subscriptionId = invoice.subscription;
  const attemptCount = invoice.attempt_count;

  // 支払い失敗をログに記録
  // 現在のスキーマにはpayment_failed_atカラムが無いため、
  // webhooks_logへの記録で追跡可能とする
  console.error(
    `支払い失敗: customer=${customerId}, subscription=${subscriptionId}, ` +
    `試行回数=${attemptCount}, invoice=${invoice.id}`
  );

  // ユーザーのupdated_atを更新（支払い失敗の検知用）
  await env.NURIEL_DB
    .prepare(`
      UPDATE users
      SET updated_at = datetime('now')
      WHERE stripe_customer_id = ?
    `)
    .bind(customerId)
    .run();
}

// ============================================================
// Webhookログ記録
// ============================================================

/**
 * WebhookイベントをD1のwebhooks_logテーブルに記録
 * stripe_event_idにUNIQUEインデックスがあるため、二重挿入は自動で防止される
 *
 * @param {Object} event - Stripeイベント
 * @param {Object} env
 */
async function logWebhookEvent(event, env) {
  try {
    await env.NURIEL_DB
      .prepare(`
        INSERT INTO webhooks_log (id, event_type, stripe_event_id, payload, processed_at)
        VALUES (?, ?, ?, ?, datetime('now'))
      `)
      .bind(
        generateUUID(),
        event.type,
        event.id,
        JSON.stringify(event),
      )
      .run();
  } catch (logErr) {
    // UNIQUE制約違反（冪等性チェックをすり抜けた場合）は無視
    if (logErr.message && logErr.message.includes('UNIQUE')) {
      console.log(`Webhookログ: イベント ${event.id} は既に記録済み`);
    } else {
      // ログ記録の失敗でWebhook処理自体を失敗させない
      console.error('Webhookログ記録エラー:', logErr.message);
    }
  }
}

// ============================================================
// ハンドラ: Customer Portal
// ============================================================

/**
 * POST /api/billing/portal
 * Stripe Customer Portalセッションを作成し、URLを返却
 *
 * @param {Request} request
 * @param {Object} env
 * @param {Object} user - 認証済みユーザー
 * @returns {Promise<Response>}
 */
export async function handlePortal(request, env, user) {
  try {
    const frontendUrl = env.FRONTEND_URL || 'http://localhost:8788';

    // --- モックモード ---
    if (isMockMode(env)) {
      const mockPortalUrl = `${frontendUrl}/app.html#plan?mock_portal=true`;
      console.log(`[モック] Customer Portalセッション作成: user=${user.id}`);
      return jsonResponse({ portal_url: mockPortalUrl });
    }

    // --- Stripe顧客IDの確認 ---
    if (!user.stripe_customer_id) {
      return errorResponse('Stripe顧客情報が見つかりません。まずプランに登録してください。', 400);
    }

    // --- Customer Portalセッション作成 ---
    const session = await stripeRequest('billing_portal/sessions', 'POST', {
      customer: user.stripe_customer_id,
      return_url: `${frontendUrl}/app.html#plan`,
    }, env.STRIPE_SECRET_KEY);

    console.log(`Customer Portal作成: user=${user.id}, customer=${user.stripe_customer_id}`);
    return jsonResponse({ portal_url: session.url });
  } catch (err) {
    if (err instanceof StripeApiError) {
      console.error('Stripe Portalエラー:', err.message);
      return errorResponse('カスタマーポータルの作成に失敗しました', 502);
    }
    console.error('Portalエラー:', err.message, err.stack);
    return errorResponse('カスタマーポータルの処理中にエラーが発生しました', 500);
  }
}

// ============================================================
// ハンドラ: 課金ステータス取得
// ============================================================

/**
 * GET /api/billing/status
 * ユーザーの現在のプラン、利用状況、次回請求日を返却
 *
 * @param {Request} request
 * @param {Object} env
 * @param {Object} user - 認証済みユーザー
 * @returns {Promise<Response>}
 */
export async function handleBillingStatus(request, env, user) {
  try {
    // --- D1からプラン情報取得 ---
    const plan = await env.NURIEL_DB
      .prepare('SELECT * FROM plans WHERE id = ?')
      .bind(user.plan || 'free')
      .first();

    if (!plan) {
      return errorResponse('プラン情報の取得に失敗しました', 500);
    }

    // --- 基本レスポンス（D1の情報のみ） ---
    const status = {
      plan: {
        id: plan.id,
        name: plan.name,
        price_monthly: plan.price_monthly,
        price_yearly: plan.price_yearly,
        monthly_limit: plan.monthly_limit,
        styles_allowed: JSON.parse(plan.styles_allowed || '[]'),
        gallery_limit: plan.gallery_limit,
      },
      usage: {
        monthly_generation_count: user.monthly_generation_count || 0,
        monthly_limit: plan.monthly_limit,
        remaining: Math.max(0, plan.monthly_limit - (user.monthly_generation_count || 0)),
        gallery_count: user.gallery_count || 0,
        gallery_limit: plan.gallery_limit,
      },
      subscription: null, // Stripe情報がある場合に埋める
    };

    // --- Stripeからサブスク情報を取得（モックモードでなくサブスクIDがある場合） ---
    if (!isMockMode(env) && user.stripe_subscription_id) {
      try {
        const subscription = await stripeRequest(
          `subscriptions/${user.stripe_subscription_id}`,
          'GET',
          null,
          env.STRIPE_SECRET_KEY
        );

        status.subscription = {
          id: subscription.id,
          status: subscription.status,
          current_period_start: subscription.current_period_start,
          current_period_end: subscription.current_period_end,
          cancel_at_period_end: subscription.cancel_at_period_end,
          canceled_at: subscription.canceled_at,
          // 次回請求日（UNIXタイムスタンプ→ISO8601）
          next_billing_date: subscription.current_period_end
            ? new Date(subscription.current_period_end * 1000).toISOString()
            : null,
          // 請求間隔
          billing_period: subscription.items?.data?.[0]?.price?.recurring?.interval || null,
        };
      } catch (stripeErr) {
        // Stripeからの情報取得失敗はステータス全体を失敗させない
        console.error('Stripeサブスク情報取得エラー:', stripeErr.message);
        status.subscription = { error: 'サブスクリプション情報の取得に失敗しました' };
      }
    }

    return jsonResponse(status);
  } catch (err) {
    console.error('課金ステータス取得エラー:', err.message, err.stack);
    return errorResponse('課金ステータスの取得に失敗しました', 500);
  }
}
