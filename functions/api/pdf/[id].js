/**
 * GET /api/pdf/:id -- PDF生成/ダウンロード（認証必須）
 * 線画画像からA4印刷用PDFを生成して返却
 */

import { errorResponse } from '../../lib/response.js';
import { authenticate } from '../../lib/auth.js';

/**
 * PNGファイルからIHDRチャンクを解析して画像サイズを取得
 * @param {Uint8Array} bytes - PNGバイナリ
 * @returns {{ width: number, height: number, colorType: number, bitDepth: number }}
 */
function parsePngHeader(bytes) {
  // PNGシグネチャ(8バイト)の後にIHDRチャンクがある
  // チャンク構造: length(4) + type(4) + data + crc(4)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  const bitDepth = bytes[24];
  const colorType = bytes[25];
  return { width, height, colorType, bitDepth };
}

/**
 * PNGファイルから全IDATチャンクのデータを結合して取得
 * IDATにはzlib圧縮されたフィルタ付きピクセルデータが格納されている
 * @param {Uint8Array} bytes - PNGバイナリ
 * @returns {Uint8Array} 結合されたIDATデータ（zlib圧縮済み）
 */
function extractPngIdatData(bytes) {
  const chunks = [];
  let offset = 8; // PNGシグネチャをスキップ
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  while (offset < bytes.length) {
    const chunkLength = view.getUint32(offset);
    const chunkType = String.fromCharCode(
      bytes[offset + 4], bytes[offset + 5],
      bytes[offset + 6], bytes[offset + 7]
    );

    if (chunkType === 'IDAT') {
      chunks.push(bytes.slice(offset + 8, offset + 8 + chunkLength));
    }

    // 次のチャンクへ: length(4) + type(4) + data + crc(4)
    offset += 4 + 4 + chunkLength + 4;
  }

  // 全IDATチャンクを結合
  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  const combined = new Uint8Array(totalLength);
  let pos = 0;
  for (const chunk of chunks) {
    combined.set(chunk, pos);
    pos += chunk.length;
  }
  return combined;
}

/**
 * JPEG画像からSOFマーカーを解析して画像サイズを取得
 * @param {Uint8Array} bytes - JPEGバイナリ
 * @returns {{ width: number, height: number }}
 */
function parseJpegSize(bytes) {
  let offset = 2; // SOIマーカー(FF D8)をスキップ
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  while (offset < bytes.length - 1) {
    if (bytes[offset] !== 0xFF) {
      offset++;
      continue;
    }
    const marker = bytes[offset + 1];

    // SOF0〜SOF3マーカー（フレームヘッダ）
    if (marker >= 0xC0 && marker <= 0xC3) {
      const height = view.getUint16(offset + 5);
      const width = view.getUint16(offset + 7);
      return { width, height };
    }

    // その他のマーカー: セグメント長を読んでスキップ
    if (marker === 0xD9 || marker === 0xDA) break; // EOIまたはSOS
    const segLength = view.getUint16(offset + 2);
    offset += 2 + segLength;
  }
  // 取得できなかった場合のフォールバック
  return { width: 512, height: 512 };
}

/**
 * 最小限のPDFを手動構築する（バイナリストリーム対応）
 * A4サイズ（595.28 x 841.89 pt）に画像を中央配置
 *
 * PNG: IDATチャンクのzlibデータを/FlateDecodeで埋め込み
 *      /DecodeParms で行フィルタ（PNG Predictor）を指定
 * JPEG: 生バイトをそのまま/DCTDecodeで埋め込み
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

  const isPng = mimeType === 'image/png';

  // 画像サイズの取得
  let imgWidth, imgHeight;
  if (isPng) {
    const info = parsePngHeader(imageBytes);
    imgWidth = info.width;
    imgHeight = info.height;
  } else {
    const info = parseJpegSize(imageBytes);
    imgWidth = info.width;
    imgHeight = info.height;
  }

  // アスペクト比を維持してA4に収まるサイズを計算
  const scaleX = maxWidth / imgWidth;
  const scaleY = maxHeight / imgHeight;
  const scale = Math.min(scaleX, scaleY);
  const displayWidth = imgWidth * scale;
  const displayHeight = imgHeight * scale;
  const imageX = (pageWidth - displayWidth) / 2;
  const imageY = (pageHeight - displayHeight) / 2;

  // 画像ストリームデータとフィルタ設定の決定
  let streamData;
  let filterEntry;
  let colorSpace = '/DeviceRGB';
  let bitsPerComponent = 8;

  if (isPng) {
    const pngInfo = parsePngHeader(imageBytes);
    bitsPerComponent = pngInfo.bitDepth;

    // colorTypeに応じたColorSpace設定
    // 0: Grayscale, 2: RGB, 4: Grayscale+Alpha, 6: RGBA
    // PDF XObjectではアルファチャネルを直接扱えないため、RGB/Grayで埋め込む
    let columns = imgWidth;
    let colors = 3; // デフォルトRGB
    if (pngInfo.colorType === 0) {
      colorSpace = '/DeviceGray';
      colors = 1;
    } else if (pngInfo.colorType === 4) {
      // Grayscale+Alpha → 2コンポーネントとして扱う
      colorSpace = '/DeviceGray';
      colors = 2;
    } else if (pngInfo.colorType === 6) {
      // RGBA → 4コンポーネントとして扱う
      colors = 4;
    }

    streamData = extractPngIdatData(imageBytes);
    filterEntry = `/Filter /FlateDecode /DecodeParms << /Predictor 15 /Colors ${colors} /BitsPerComponent ${bitsPerComponent} /Columns ${columns} >>`;
  } else {
    // JPEG: そのまま埋め込み
    streamData = imageBytes;
    filterEntry = '/Filter /DCTDecode';
  }

  // --- PDFオブジェクトをバイナリとして構築 ---
  const te = new TextEncoder();

  // 各オブジェクトのバイトオフセットを記録
  const offsets = [];
  const parts = [];
  let currentSize = 0;

  /** テキストパートを追加しオフセットを記録 */
  function addTextObj(text) {
    offsets.push(currentSize);
    const encoded = te.encode(text);
    parts.push(encoded);
    currentSize += encoded.length;
  }

  /** バイナリを含むオブジェクトを追加 */
  function addBinaryObj(header, binary, footer) {
    offsets.push(currentSize);
    const hBytes = te.encode(header);
    const fBytes = te.encode(footer);
    parts.push(hBytes, binary, fBytes);
    currentSize += hBytes.length + binary.length + fBytes.length;
  }

  // ヘッダー
  const headerStr = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const headerBytes = te.encode(headerStr);
  parts.push(headerBytes);
  currentSize += headerBytes.length;

  // オブジェクト1: カタログ
  addTextObj('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  // オブジェクト2: ページツリー
  addTextObj('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');

  // オブジェクト3: ページ
  addTextObj(
    '3 0 obj\n' +
    '<< /Type /Page /Parent 2 0 R ' +
    `/MediaBox [0 0 ${pageWidth} ${pageHeight}] ` +
    '/Contents 4 0 R ' +
    '/Resources << /XObject << /Img1 5 0 R >> >> >>\n' +
    'endobj\n'
  );

  // オブジェクト4: ページコンテンツ
  const contentStream =
    `1 1 1 rg\n` +
    `0 0 ${pageWidth} ${pageHeight} re f\n` +
    `q\n` +
    `${displayWidth} 0 0 ${displayHeight} ${imageX} ${imageY} cm\n` +
    `/Img1 Do\n` +
    `Q`;
  addTextObj(
    '4 0 obj\n' +
    `<< /Length ${contentStream.length} >>\n` +
    `stream\n${contentStream}\nendstream\n` +
    'endobj\n'
  );

  // オブジェクト5: 画像XObject（バイナリストリーム）
  const imgHeader =
    '5 0 obj\n' +
    '<< /Type /XObject /Subtype /Image ' +
    `/Width ${imgWidth} /Height ${imgHeight} ` +
    `/ColorSpace ${colorSpace} ` +
    `/BitsPerComponent ${bitsPerComponent} ` +
    `/Length ${streamData.length} ` +
    `${filterEntry} ` +
    '>>\n' +
    'stream\n';
  const imgFooter = '\nendstream\nendobj\n';
  addBinaryObj(imgHeader, streamData, imgFooter);

  // xrefテーブル
  const numObjects = 6; // 0(フリー) + 5オブジェクト
  let xrefStr = `xref\n0 ${numObjects}\n`;
  xrefStr += '0000000000 65535 f \n';
  for (const off of offsets) {
    xrefStr += String(off).padStart(10, '0') + ' 00000 n \n';
  }

  const xrefOffset = currentSize;
  const xrefBytes = te.encode(xrefStr);
  parts.push(xrefBytes);
  currentSize += xrefBytes.length;

  // トレイラー
  const trailerStr =
    'trailer\n' +
    `<< /Size ${numObjects} /Root 1 0 R >>\n` +
    'startxref\n' +
    `${xrefOffset}\n` +
    '%%EOF';
  parts.push(te.encode(trailerStr));

  // 全パートを結合して1つのUint8Arrayに
  const totalSize = parts.reduce((sum, p) => sum + p.length, 0);
  const result = new Uint8Array(totalSize);
  let pos = 0;
  for (const part of parts) {
    result.set(part, pos);
    pos += part.length;
  }

  return result;
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
