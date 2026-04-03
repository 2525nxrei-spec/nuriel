/**
 * POST /api/convert -- AI線画変換を開始（認証必須）
 *
 * 注意: Pages Functionsではctx.waitUntil()が使えないため、
 * context.waitUntil()を使用してバックグラウンド処理を実行する。
 */

import { jsonResponse, errorResponse } from '../../lib/response.js';
import { generateId } from '../../lib/crypto.js';
import { authenticate } from '../../lib/auth.js';

/** Replicateモデルバージョン（環境変数 REPLICATE_MODEL_VERSION で上書き可能） */
const DEFAULT_REPLICATE_MODEL_VERSION = 'jagilley/controlnet-canny:aff48af9c68d162388d230a2ab003f68d2638d88307bdaf1c2f1ac95079c9613';

/**
 * ArrayBufferをBase64文字列に変換
 * @param {ArrayBuffer} buffer
 * @returns {string}
 */
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * 最小限のモックPNG画像を生成（プレースホルダー用）
 * @returns {Uint8Array}
 */
function createMockPng() {
  return new Uint8Array([
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
    0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
    0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41,
    0x54, 0x08, 0xD7, 0x63, 0xF8, 0xCF, 0xC0, 0x00,
    0x00, 0x00, 0x02, 0x00, 0x01, 0xE2, 0x21, 0xBC,
    0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E,
    0x44, 0xAE, 0x42, 0x60, 0x82,
  ]);
}

/**
 * スタイルに対応するプロンプトを返す
 * @param {string} style
 * @returns {string}
 */
function getStylePrompt(style) {
  const prompts = {
    gentle: 'simple clean line art, coloring book page, bold outlines, minimal detail, for children, soft rounded lines',
    standard: 'detailed line art, coloring book page, fine outlines, balanced detail, clean and clear',
    sketch: 'realistic pencil sketch line art, coloring book page, fine delicate lines, intricate detail, for adults',
    manga: 'manga anime style line art, coloring book page, fun playful outlines, cute deformed style, screen tones',
  };
  return prompts[style] || prompts.standard;
}

/**
 * モック変換（APIキーなし時）
 */
async function simulateMockConversion(env, generationId) {
  await new Promise(resolve => setTimeout(resolve, 2000));

  const mockPng = createMockPng();
  const lineArtKey = `line_art/${generationId}.png`;

  await env.NURIEL_STORAGE.put(lineArtKey, mockPng, {
    httpMetadata: { contentType: 'image/png' },
    customMetadata: { mock: 'true' },
  });

  await env.NURIEL_DB
    .prepare("UPDATE generations SET line_art_image_key = ?, status = 'completed' WHERE id = ?")
    .bind(lineArtKey, generationId)
    .run();

  // ギャラリーカウントをインクリメント（整合性維持）
  const gen = await env.NURIEL_DB
    .prepare('SELECT user_id FROM generations WHERE id = ?')
    .bind(generationId)
    .first();
  if (gen) {
    await env.NURIEL_DB
      .prepare('UPDATE users SET gallery_count = gallery_count + 1, updated_at = datetime(\'now\') WHERE id = ?')
      .bind(gen.user_id)
      .run();
  }

  console.log(`[モック] 線画変換完了: ${generationId}`);
}

/**
 * Replicate APIを呼び出してControlNet予測を開始
 */
async function callReplicateApi(apiToken, imageBase64, style, modelVersion) {
  const response = await fetch('https://api.replicate.com/v1/predictions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      version: modelVersion,
      input: {
        image: imageBase64,
        prompt: getStylePrompt(style),
        a_prompt: 'best quality, clean line art, coloring book, black and white, no shading',
        n_prompt: 'color, shading, realistic, photo, blurry, low quality',
        num_samples: '1',
        image_resolution: '512',
        detect_resolution: 512,
        low_threshold: 100,
        high_threshold: 200,
      },
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Replicate API呼び出し失敗 (${response.status}): ${errorText}`);
  }

  return response.json();
}

/**
 * Replicate APIの結果をポーリングで取得
 */
async function pollReplicateResult(apiToken, predictionId) {
  const maxAttempts = 60;
  const intervalMs = 5000;

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(resolve => setTimeout(resolve, intervalMs));

    const response = await fetch(`https://api.replicate.com/v1/predictions/${predictionId}`, {
      headers: { 'Authorization': `Bearer ${apiToken}` },
    });

    if (!response.ok) {
      throw new Error(`ポーリング失敗 (${response.status})`);
    }

    const result = await response.json();

    if (result.status === 'succeeded' || result.status === 'failed' || result.status === 'canceled') {
      return result;
    }
  }

  throw new Error('変換がタイムアウトしました（5分超過）');
}

/**
 * Replicate APIで線画変換を実行（バックグラウンド処理）
 */
async function startConversion(env, generationId, imageKey, style) {
  try {
    await env.NURIEL_DB
      .prepare("UPDATE generations SET status = 'processing' WHERE id = ?")
      .bind(generationId)
      .run();

    const apiToken = env.REPLICATE_API_TOKEN;

    if (!apiToken) {
      console.log(`[モック] 線画変換をシミュレート: ${generationId}`);
      await simulateMockConversion(env, generationId);
      return;
    }

    // 元画像をR2から取得
    const originalImage = await env.NURIEL_STORAGE.get(imageKey);
    if (!originalImage) {
      throw new Error('元画像がR2に見つかりません');
    }

    const imageBuffer = await originalImage.arrayBuffer();
    const imageBase64 = `data:${originalImage.httpMetadata?.contentType || 'image/png'};base64,${arrayBufferToBase64(imageBuffer)}`;

    const modelVersion = env.REPLICATE_MODEL_VERSION || DEFAULT_REPLICATE_MODEL_VERSION;
    const prediction = await callReplicateApi(apiToken, imageBase64, style, modelVersion);

    await env.NURIEL_DB
      .prepare('UPDATE generations SET replicate_prediction_id = ? WHERE id = ?')
      .bind(prediction.id, generationId)
      .run();

    const result = await pollReplicateResult(apiToken, prediction.id);

    if (result.status === 'succeeded' && result.output) {
      const outputUrl = Array.isArray(result.output) ? result.output[0] : result.output;
      const outputResponse = await fetch(outputUrl);
      const outputBuffer = await outputResponse.arrayBuffer();

      const lineArtKey = `line_art/${generationId}.png`;
      await env.NURIEL_STORAGE.put(lineArtKey, outputBuffer, {
        httpMetadata: { contentType: 'image/png' },
      });

      await env.NURIEL_DB
        .prepare("UPDATE generations SET line_art_image_key = ?, status = 'completed' WHERE id = ?")
        .bind(lineArtKey, generationId)
        .run();

      // ギャラリーカウントをインクリメント（整合性維持）
      const gen = await env.NURIEL_DB
        .prepare('SELECT user_id FROM generations WHERE id = ?')
        .bind(generationId)
        .first();
      if (gen) {
        await env.NURIEL_DB
          .prepare('UPDATE users SET gallery_count = gallery_count + 1, updated_at = datetime(\'now\') WHERE id = ?')
          .bind(gen.user_id)
          .run();
      }
    } else {
      throw new Error(`Replicate処理失敗: ${result.error || '不明なエラー'}`);
    }
  } catch (err) {
    console.error(`線画変換エラー [${generationId}]:`, err.message);
    await env.NURIEL_DB
      .prepare("UPDATE generations SET status = 'failed' WHERE id = ?")
      .bind(generationId)
      .run();
  }
}

export async function onRequestPost(context) {
  const { request, env } = context;

  const user = await authenticate(request, env);
  if (!user) {
    return errorResponse('認証が必要です。ログインしてください。', 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse('リクエストボディが不正です', 400);
  }

  const { imageKey, style = 'standard' } = body;

  if (!imageKey) {
    return errorResponse('imageKey（アップロード済み画像のキー）は必須です', 400);
  }

  // R2に画像が存在するか確認
  const imageObject = await env.NURIEL_STORAGE.head(imageKey);
  if (!imageObject) {
    return errorResponse('指定された画像が見つかりません', 404);
  }

  // プラン情報を取得してスタイル利用可否と月間上限をチェック
  const plan = await env.NURIEL_DB
    .prepare('SELECT monthly_limit, styles_allowed FROM plans WHERE id = ?')
    .bind(user.plan)
    .first();

  if (!plan) {
    return errorResponse('プラン情報の取得に失敗しました', 500);
  }

  // スタイル利用可否チェック
  const allowedStyles = JSON.parse(plan.styles_allowed);
  if (!allowedStyles.includes(style)) {
    return errorResponse(
      `「${style}」スタイルは現在のプランでは利用できません。利用可能: ${allowedStyles.join(', ')}`,
      403
    );
  }

  // 月間生成上限チェック
  const freshUser = await env.NURIEL_DB
    .prepare('SELECT monthly_generation_count, monthly_reset_date FROM users WHERE id = ?')
    .bind(user.id)
    .first();

  if (freshUser.monthly_generation_count >= plan.monthly_limit) {
    return errorResponse(
      `今月の変換回数が上限（${plan.monthly_limit}回）に達しました。プランをアップグレードするか、来月までお待ちください。`,
      429
    );
  }

  // 生成レコード作成
  const generationId = generateId();
  const now = new Date().toISOString();

  await env.NURIEL_DB
    .prepare(`
      INSERT INTO generations (id, user_id, original_image_key, style, status, created_at)
      VALUES (?, ?, ?, ?, 'pending', ?)
    `)
    .bind(generationId, user.id, imageKey, style, now)
    .run();

  // 月間カウントをインクリメント
  await env.NURIEL_DB
    .prepare('UPDATE users SET monthly_generation_count = monthly_generation_count + 1, updated_at = ? WHERE id = ?')
    .bind(now, user.id)
    .run();

  // バックグラウンドでReplicate APIを呼び出す
  // Pages Functionsでは context.waitUntil() を使用
  context.waitUntil(startConversion(env, generationId, imageKey, style));

  return jsonResponse({
    generationId,
    status: 'pending',
    message: '線画変換を開始しました。ステータスAPIで進捗を確認できます。',
  }, 202);
}
