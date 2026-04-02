/**
 * POST /api/billing/webhook -- Stripe Webhook（認証不要・署名検証で保護）
 */

import { jsonResponse, errorResponse } from '../../lib/response.js';
import {
  stripeRequest,
  verifyStripeSignature,
  VALID_PLAN_IDS,
  isMockMode,
} from '../../lib/stripe.js';
import { generateId } from '../../lib/crypto.js';

export async function onRequestPost(context) {
  const { request, env } = context;

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

    // --- 冪等性チェック ---
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
    return errorResponse('Webhook処理中にエラーが発生しました', 500);
  }
}

// ============================================================
// Webhookイベント処理: 個別ハンドラ
// ============================================================

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

  if (!VALID_PLAN_IDS.includes(planId)) {
    console.error(`checkout.session.completed: 無効なplan_id: ${planId}`);
    return;
  }

  const result = await env.NURIEL_DB
    .prepare(`
      UPDATE users
      SET plan = ?,
          cancel_at_period_end = 0,
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

async function handleSubscriptionUpdated(event, env) {
  const subscription = event.data.object;
  const subscriptionId = subscription.id;
  const customerId = subscription.customer;

  let planId = subscription.metadata?.plan_id;

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

  if (subscription.status !== 'active' && subscription.status !== 'trialing') {
    console.log(`subscription.updated: ステータスが ${subscription.status} のためプラン更新スキップ。subscription=${subscriptionId}`);
    return;
  }

  const result = await env.NURIEL_DB
    .prepare(`
      UPDATE users
      SET plan = ?,
          cancel_at_period_end = ?,
          stripe_subscription_id = ?,
          updated_at = datetime('now')
      WHERE stripe_customer_id = ?
    `)
    .bind(planId, subscription.cancel_at_period_end ? 1 : 0, subscriptionId, customerId)
    .run();

  if (result.meta.changes === 0) {
    console.error(`subscription.updated: 顧客 ${customerId} に対応するユーザーが見つかりません`);
    return;
  }

  console.log(`プラン変更: customer=${customerId}, plan=${planId}, subscription=${subscriptionId}`);
}

async function handleSubscriptionDeleted(event, env) {
  const subscription = event.data.object;
  const subscriptionId = subscription.id;
  const customerId = subscription.customer;

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

async function handlePaymentSucceeded(event, env) {
  const invoice = event.data.object;
  const customerId = invoice.customer;
  const subscriptionId = invoice.subscription;
  const amountPaid = invoice.amount_paid;

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
    console.warn(`payment_succeeded: 顧客 ${customerId} に対応するユーザーが見つかりません（初回請求の可能性）`);
    return;
  }

  console.log(`支払い成功: customer=${customerId}, subscription=${subscriptionId}, amount=${amountPaid}円`);
}

async function handlePaymentFailed(event, env) {
  const invoice = event.data.object;
  const customerId = invoice.customer;
  const subscriptionId = invoice.subscription;
  const attemptCount = invoice.attempt_count;

  console.error(
    `支払い失敗: customer=${customerId}, subscription=${subscriptionId}, ` +
    `試行回数=${attemptCount}, invoice=${invoice.id}`
  );

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

async function logWebhookEvent(event, env) {
  try {
    await env.NURIEL_DB
      .prepare(`
        INSERT INTO webhooks_log (id, event_type, stripe_event_id, payload, processed_at)
        VALUES (?, ?, ?, ?, datetime('now'))
      `)
      .bind(
        generateId(),
        event.type,
        event.id,
        JSON.stringify(event),
      )
      .run();
  } catch (logErr) {
    if (logErr.message && logErr.message.includes('UNIQUE')) {
      console.log(`Webhookログ: イベント ${event.id} は既に記録済み`);
    } else {
      console.error('Webhookログ記録エラー:', logErr.message);
    }
  }
}
