/**
 * 線画変換ハンドラ
 * Replicate API（ControlNet）を使用してペット写真を塗り絵線画に変換
 * REPLICATE_API_TOKENが未設定の場合はモックデータで動作
 */

import { jsonResponse, errorResponse } from '../utils/response.js';
import { generateId } from '../utils/crypto.js';

/**
 * POST /api/convert — AI線画変換を開始
 * リクエストボディ: { imageKey: string, style?: string }
 */
export async function handleConvert(request, env, ctx, user) {
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

  // 月間生成上限チェック（リセット判定含む）
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
  ctx.waitUntil(startConversion(env, generationId, imageKey, style));

  return jsonResponse({
    generationId,
    status: 'pending',
    message: '線画変換を開始しました。ステータスAPIで進捗を確認できます。',
  }, 202);
}

/**
 * GET /api/convert/:id/status — 変換ステータス確認
 */
export async function handleConvertStatus(request, env, user, generationId) {
  const gen = await env.NURIEL_DB
    .prepare('SELECT id, status, style, created_at FROM generations WHERE id = ? AND user_id = ?')
    .bind(generationId, user.id)
    .first();

  if (!gen) {
    return errorResponse('変換記録が見つかりません', 404);
  }

  return jsonResponse({
    generationId: gen.id,
    status: gen.status,
    style: gen.style,
    createdAt: gen.created_at,
  });
}

/**
 * GET /api/convert/:id/result — 変換結果取得（線画画像の署名付きURL等）
 */
export async function handleConvertResult(request, env, user, generationId) {
  const gen = await env.NURIEL_DB
    .prepare(`
      SELECT id, status, original_image_key, line_art_image_key, pdf_key, style, created_at
      FROM generations WHERE id = ? AND user_id = ?
    `)
    .bind(generationId, user.id)
    .first();

  if (!gen) {
    return errorResponse('変換記録が見つかりません', 404);
  }

  if (gen.status !== 'completed') {
    return errorResponse(
      `変換がまだ完了していません（現在のステータス: ${gen.status}）`,
      400
    );
  }

  // 線画画像をR2から取得してBase64で返す（小さい画像なので直接返却）
  let lineArtBase64 = null;
  if (gen.line_art_image_key) {
    const obj = await env.NURIEL_STORAGE.get(gen.line_art_image_key);
    if (obj) {
      const buffer = await obj.arrayBuffer();
      lineArtBase64 = arrayBufferToBase64(buffer);
    }
  }

  return jsonResponse({
    generationId: gen.id,
    status: gen.status,
    style: gen.style,
    lineArtImageKey: gen.line_art_image_key,
    lineArtBase64: lineArtBase64 ? `data:image/png;base64,${lineArtBase64}` : null,
    pdfKey: gen.pdf_key,
    pdfUrl: gen.pdf_key ? `/api/pdf/${gen.id}` : null,
    createdAt: gen.created_at,
  });
}

// ==========================================================
// 内部ヘルパー
// ==========================================================

/**
 * Replicate APIで線画変換を実行（バックグラウンド処理）
 * APIキーが未設定の場合はモックデータで完了扱いにする
 */
async function startConversion(env, generationId, imageKey, style) {
  try {
    // ステータスを processing に更新
    await env.NURIEL_DB
      .prepare("UPDATE generations SET status = 'processing' WHERE id = ?")
      .bind(generationId)
      .run();

    const apiToken = env.REPLICATE_API_TOKEN;

    if (!apiToken) {
      // --- モックモード: APIキーなし ---
      console.log(`[モック] 線画変換をシミュレート: ${generationId}`);
      await simulateMockConversion(env, generationId);
      return;
    }

    // --- 本番モード: Replicate API呼び出し ---
    // 元画像をR2から取得
    const originalImage = await env.NURIEL_STORAGE.get(imageKey);
    if (!originalImage) {
      throw new Error('元画像がR2に見つかりません');
    }

    const imageBuffer = await originalImage.arrayBuffer();
    const imageBase64 = `data:${originalImage.httpMetadata?.contentType || 'image/png'};base64,${arrayBufferToBase64(imageBuffer)}`;

    // Replicate APIでControlNet線画変換を実行
    const prediction = await callReplicateApi(apiToken, imageBase64, style);

    // 予測IDを保存
    await env.NURIEL_DB
      .prepare('UPDATE generations SET replicate_prediction_id = ? WHERE id = ?')
      .bind(prediction.id, generationId)
      .run();

    // 結果をポーリングで待機
    const result = await pollReplicateResult(apiToken, prediction.id);

    if (result.status === 'succeeded' && result.output) {
      // 出力画像をダウンロードしてR2に保存
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

/**
 * モック変換（APIキーなし時）
 * 1秒待ってから白い線画プレースホルダーを生成
 */
async function simulateMockConversion(env, generationId) {
  // 処理時間をシミュレート（2秒）
  await new Promise(resolve => setTimeout(resolve, 2000));

  // 1x1ピクセルの白PNGをモックとして保存
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

  console.log(`[モック] 線画変換完了: ${generationId}`);
}

/**
 * Replicate APIを呼び出してControlNet予測を開始
 * @param {string} apiToken
 * @param {string} imageBase64 - data:URI形式のBase64画像
 * @param {string} style - 線画スタイル
 * @returns {Promise<Object>} 予測オブジェクト
 */
async function callReplicateApi(apiToken, imageBase64, style) {
  // ControlNet Cannyエッジ検出モデルを使用して線画生成
  const response = await fetch('https://api.replicate.com/v1/predictions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      // ControlNet線画変換に適したモデル
      version: 'jagilley/controlnet-canny:aff48af9c68d162388d230a2ab003f68d2638d88307bdaf1c2f1ac95079c9613',
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
 * @param {string} apiToken
 * @param {string} predictionId
 * @returns {Promise<Object>}
 */
async function pollReplicateResult(apiToken, predictionId) {
  const maxAttempts = 60; // 最大60回（約5分）
  const intervalMs = 5000; // 5秒間隔

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
    // starting / processing の場合は継続
  }

  throw new Error('変換がタイムアウトしました（5分超過）');
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
 * 最小限のモックPNG画像を生成（プレースホルダー用）
 * @returns {Uint8Array}
 */
function createMockPng() {
  // 1x1 白ピクセルの最小PNG（67バイト）
  return new Uint8Array([
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNGシグネチャ
    0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, // IHDR
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
    0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, // IDAT
    0x54, 0x08, 0xD7, 0x63, 0xF8, 0xCF, 0xC0, 0x00,
    0x00, 0x00, 0x02, 0x00, 0x01, 0xE2, 0x21, 0xBC,
    0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, // IEND
    0x44, 0xAE, 0x42, 0x60, 0x82,
  ]);
}

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
