/**
 * ヌリエル API ルーター
 * ペット写真→塗り絵線画AI変換サービス
 *
 * Cloudflare Workers上で動作するAPIサーバー。
 * フレームワーク不使用、シンプルなURL解析によるルーティング。
 */

import { handleCors, addCorsHeaders } from './middleware/cors.js';
import { authenticate } from './middleware/auth.js';
import { jsonResponse, errorResponse } from './utils/response.js';

// --- ハンドラ群 ---
import { handleRegister, handleLogin, handleLogout, handleMe } from './handlers/auth.js';
import { handleUpload } from './handlers/upload.js';
import { handleConvert, handleConvertStatus, handleConvertResult } from './handlers/convert.js';
import { handleGalleryList, handleGalleryDelete } from './handlers/gallery.js';
import { handlePlans, handleCheckout, handleWebhook, handlePortal, handleBillingStatus } from './handlers/billing.js';
import { handlePdfDownload } from './handlers/pdf.js';

export default {
  /**
   * リクエストハンドラ（Workersエントリポイント）
   * @param {Request} request
   * @param {Object} env - バインディング（NURIEL_DB, NURIEL_STORAGE, シークレット等）
   * @param {Object} ctx - 実行コンテキスト
   */
  async fetch(request, env, ctx) {
    // --- CORSプリフライト ---
    if (request.method === 'OPTIONS') {
      return handleCors(request, env);
    }

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      // --- ルーティング ---
      const response = await route(request, env, ctx, method, path);
      return addCorsHeaders(response, env);
    } catch (err) {
      // 予期しないエラーのキャッチ
      console.error('未処理エラー:', err.message, err.stack);
      return addCorsHeaders(
        errorResponse('サーバー内部エラーが発生しました', 500),
        env
      );
    }
  },
};

/**
 * URLパスとHTTPメソッドに基づいてハンドラを呼び分ける
 * @param {Request} request
 * @param {Object} env
 * @param {Object} ctx
 * @param {string} method - HTTPメソッド
 * @param {string} path - URLパス
 * @returns {Promise<Response>}
 */
async function route(request, env, ctx, method, path) {
  // ==========================================================
  // 認証系（ログイン不要）
  // ==========================================================
  if (path === '/api/auth/register' && method === 'POST') {
    return handleRegister(request, env);
  }
  if (path === '/api/auth/login' && method === 'POST') {
    return handleLogin(request, env);
  }

  // --- Stripe Webhook（認証不要・署名検証で保護） ---
  if (path === '/api/billing/webhook' && method === 'POST') {
    return handleWebhook(request, env);
  }

  // --- プラン一覧（認証不要・公開API） ---
  if (path === '/api/billing/plans' && method === 'GET') {
    return handlePlans(request, env);
  }

  // ==========================================================
  // 以下は認証必須ルート
  // ==========================================================
  const user = await authenticate(request, env);
  if (!user) {
    return errorResponse('認証が必要です。ログインしてください。', 401);
  }

  // --- 認証系（ログイン必須） ---
  if (path === '/api/auth/logout' && method === 'POST') {
    return handleLogout(request, env, user);
  }
  if (path === '/api/auth/me' && method === 'GET') {
    return handleMe(request, env, user);
  }

  // --- アップロード ---
  if (path === '/api/upload' && method === 'POST') {
    return handleUpload(request, env, user);
  }

  // --- 線画変換 ---
  if (path === '/api/convert' && method === 'POST') {
    return handleConvert(request, env, ctx, user);
  }

  // --- 動的パスの解析: /api/convert/:id/status ---
  const convertStatusMatch = path.match(/^\/api\/convert\/([a-zA-Z0-9_-]+)\/status$/);
  if (convertStatusMatch && method === 'GET') {
    return handleConvertStatus(request, env, user, convertStatusMatch[1]);
  }

  // --- 動的パスの解析: /api/convert/:id/result ---
  const convertResultMatch = path.match(/^\/api\/convert\/([a-zA-Z0-9_-]+)\/result$/);
  if (convertResultMatch && method === 'GET') {
    return handleConvertResult(request, env, user, convertResultMatch[1]);
  }

  // --- ギャラリー ---
  if (path === '/api/gallery' && method === 'GET') {
    return handleGalleryList(request, env, user);
  }
  const galleryDeleteMatch = path.match(/^\/api\/gallery\/([a-zA-Z0-9_-]+)$/);
  if (galleryDeleteMatch && method === 'DELETE') {
    return handleGalleryDelete(request, env, user, galleryDeleteMatch[1]);
  }

  // --- 課金 ---
  if (path === '/api/billing/checkout' && method === 'POST') {
    return handleCheckout(request, env, user);
  }
  if (path === '/api/billing/portal' && method === 'POST') {
    return handlePortal(request, env, user);
  }
  if (path === '/api/billing/status' && method === 'GET') {
    return handleBillingStatus(request, env, user);
  }

  // --- PDF生成/ダウンロード ---
  const pdfMatch = path.match(/^\/api\/pdf\/([a-zA-Z0-9_-]+)$/);
  if (pdfMatch && method === 'GET') {
    return handlePdfDownload(request, env, user, pdfMatch[1]);
  }

  // ==========================================================
  // 404: 一致するルートなし
  // ==========================================================
  return errorResponse('エンドポイントが見つかりません', 404);
}
