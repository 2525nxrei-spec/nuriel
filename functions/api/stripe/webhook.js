/**
 * POST /api/stripe/webhook -- Stripe Webhookのリダイレクト
 * Stripeダッシュボードが /api/stripe/webhook に送信するため、
 * 実際のハンドラー /api/billing/webhook.js を再エクスポート
 */
export { onRequestPost } from '../billing/webhook.js';
