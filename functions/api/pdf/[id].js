/**
 * GET /api/pdf/:id -- PDF生成/ダウンロード（認証必須）
 * 線画画像からA4印刷用PDFを生成して返却
 */

import { errorResponse } from '../../lib/response.js';
import { authenticate } from '../../lib/auth.js';

/**
 * Uint8ArrayをBase64文字列に変換
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function uint8ArrayToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * 最小限のPDFを手動構築する
 * A4サイズ（595.28 x 841.89 pt）に画像を中央配置
 *
 * @param {Uint8Array} imageBytes - 画像のバイナリデータ
 * @param {string} mimeType - 画像のMIMEタイプ
 * @returns {Uint8Array} PDFバイナリ
 */
function buildSimplePdf(imageBytes, mimeType) {
  const pageWidth = 595.28;
  const pageHeight = 841.89;
  const margin = 36;

  const maxWidth = pageWidth - margin * 2;
  const maxHeight = pageHeight - margin * 2;

  const imageDisplaySize = Math.min(maxWidth, maxHeight);
  const imageX = (pageWidth - imageDisplaySize) / 2;
  const imageY = (pageHeight - imageDisplaySize) / 2;

  const isPng = mimeType === 'image/png';
  const imageFilter = isPng ? '/FlateDecode' : '/DCTDecode';
  const colorSpace = '/DeviceRGB';

  const imageBase64 = uint8ArrayToBase64(imageBytes);

  const objects = [];
  let objectIndex = 1;

  // オブジェクト1: カタログ
  const catalogId = objectIndex++;
  objects.push(`${catalogId} 0 obj\n<< /Type /Catalog /Pages ${catalogId + 1} 0 R >>\nendobj`);

  // オブジェクト2: ページツリー
  const pagesId = objectIndex++;
  objects.push(`${pagesId} 0 obj\n<< /Type /Pages /Kids [${pagesId + 1} 0 R] /Count 1 >>\nendobj`);

  // オブジェクト3: ページ
  const pageId = objectIndex++;
  const contentsId = pageId + 1;
  const imageObjId = pageId + 2;
  objects.push(
    `${pageId} 0 obj\n` +
    `<< /Type /Page /Parent ${pagesId} 0 R ` +
    `/MediaBox [0 0 ${pageWidth} ${pageHeight}] ` +
    `/Contents ${contentsId} 0 R ` +
    `/Resources << /XObject << /Img1 ${imageObjId} 0 R >> >> >>\n` +
    `endobj`
  );

  // オブジェクト4: ページコンテンツ
  objectIndex++;
  const contentStream =
    `1 1 1 rg\n` +
    `0 0 ${pageWidth} ${pageHeight} re f\n` +
    `q\n` +
    `${imageDisplaySize} 0 0 ${imageDisplaySize} ${imageX} ${imageY} cm\n` +
    `/Img1 Do\n` +
    `Q`;
  objects.push(
    `${contentsId} 0 obj\n` +
    `<< /Length ${contentStream.length} >>\n` +
    `stream\n${contentStream}\nendstream\n` +
    `endobj`
  );

  // オブジェクト5: 画像XObject
  objectIndex++;
  const imageStreamHeader =
    `${imageObjId} 0 obj\n` +
    `<< /Type /XObject /Subtype /Image ` +
    `/Width 512 /Height 512 ` +
    `/ColorSpace ${colorSpace} ` +
    `/BitsPerComponent 8 ` +
    `/Length ${imageBytes.length} ` +
    (isPng ? '' : `/Filter ${imageFilter} `) +
    `>>\n` +
    `stream\n`;
  const imageStreamFooter = `\nendstream\nendobj`;

  // PDF全体を組み立て
  const header = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const bodyParts = objects.join('\n');

  const bodyString = header + bodyParts + '\n';
  const xrefOffset = bodyString.length;

  const xref =
    `xref\n` +
    `0 ${objectIndex}\n` +
    `0000000000 65535 f \n`;

  const trailer =
    `trailer\n` +
    `<< /Size ${objectIndex} /Root ${catalogId} 0 R >>\n` +
    `startxref\n` +
    `${xrefOffset}\n` +
    `%%EOF`;

  const fullPdf = header + bodyParts + '\n' + xref + trailer;

  const encoder = new TextEncoder();
  return encoder.encode(fullPdf);
}

export async function onRequestGet(context) {
  const { request, env, params } = context;
  const generationId = params.id;

  const user = await authenticate(request, env);
  if (!user) {
    return errorResponse('認証が必要です。ログインしてください。', 401);
  }

  // 生成レコードを取得（所有者チェック含む）
  const gen = await env.NURIEL_DB
    .prepare(`
      SELECT id, user_id, line_art_image_key, pdf_key, status
      FROM generations WHERE id = ? AND user_id = ?
    `)
    .bind(generationId, user.id)
    .first();

  if (!gen) {
    return errorResponse('指定されたアイテムが見つかりません', 404);
  }

  if (gen.status !== 'completed') {
    return errorResponse('線画変換がまだ完了していません', 400);
  }

  if (!gen.line_art_image_key) {
    return errorResponse('線画画像が見つかりません', 404);
  }

  // 既にPDFが生成済みならR2からキャッシュを返す
  if (gen.pdf_key) {
    const cachedPdf = await env.NURIEL_STORAGE.get(gen.pdf_key);
    if (cachedPdf) {
      return new Response(cachedPdf.body, {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="nuriel-${generationId}.pdf"`,
          'Cache-Control': 'private, max-age=3600',
        },
      });
    }
  }

  // 線画画像をR2から取得
  const lineArtObject = await env.NURIEL_STORAGE.get(gen.line_art_image_key);
  if (!lineArtObject) {
    return errorResponse('線画画像ファイルが見つかりません', 404);
  }

  const imageBytes = new Uint8Array(await lineArtObject.arrayBuffer());
  const mimeType = lineArtObject.httpMetadata?.contentType || 'image/png';

  // PDFを生成
  const pdfBytes = buildSimplePdf(imageBytes, mimeType);

  // R2にPDFをキャッシュ保存
  const pdfKey = `pdf/${generationId}.pdf`;
  await env.NURIEL_STORAGE.put(pdfKey, pdfBytes, {
    httpMetadata: { contentType: 'application/pdf' },
  });

  // DBにPDFキーを記録
  await env.NURIEL_DB
    .prepare('UPDATE generations SET pdf_key = ? WHERE id = ?')
    .bind(pdfKey, generationId)
    .run();

  return new Response(pdfBytes, {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="nuriel-${generationId}.pdf"`,
      'Cache-Control': 'private, max-age=3600',
    },
  });
}
