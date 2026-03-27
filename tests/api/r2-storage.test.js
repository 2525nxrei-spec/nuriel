/**
 * R2ストレージ操作・ギャラリー・PDF詳細テスト（第2ラウンド強化）
 * - gallery削除でR2ファイルが実際に消えたか検証
 * - PDFキャッシュの利用テスト
 * - R2モックの境界値テスト
 * - upload後のR2メタデータ検証
 */
import { describe, it, expect } from 'vitest';
import { onRequestDelete as onGalleryDelete } from '../../functions/api/gallery/[id].js';
import { onRequestGet as onPdfGet } from '../../functions/api/pdf/[id].js';
import { onRequestPost as onUploadPost } from '../../functions/api/upload.js';
import {
  createMockDB,
  createMockR2,
  createTestUser,
  createTestSession,
  createTestGeneration,
} from '../helpers/mock-env.js';

// ============================================================
// Gallery削除: R2ファイル削除の検証
// ============================================================

describe('Gallery削除: R2ファイル実体の削除検証', () => {
  it('削除後にR2から元画像が消えていることを検証', async () => {
    const user = createTestUser();
    const session = createTestSession(user.id);
    const gen = createTestGeneration(user.id, {
      original_image_key: 'originals/test-user-001/2026/03/27/file-001.png',
      line_art_image_key: 'line_art/gen-001.png',
      pdf_key: 'pdf/gen-001.pdf',
    });

    const r2 = createMockR2();
    // R2にファイルを配置
    await r2.put('originals/test-user-001/2026/03/27/file-001.png', new Uint8Array([1, 2, 3]));
    await r2.put('line_art/gen-001.png', new Uint8Array([4, 5, 6]));
    await r2.put('pdf/gen-001.pdf', new Uint8Array([7, 8, 9]));

    // 削除前に存在確認
    expect(await r2.head('originals/test-user-001/2026/03/27/file-001.png')).not.toBeNull();
    expect(await r2.head('line_art/gen-001.png')).not.toBeNull();
    expect(await r2.head('pdf/gen-001.pdf')).not.toBeNull();

    const db = createMockDB({
      users: [user],
      sessions: [session],
      generations: [gen],
    });

    const request = new Request('https://example.com/api/gallery/gen-001', {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${session.id}` },
    });

    const res = await onGalleryDelete({
      request,
      env: { NURIEL_DB: db, NURIEL_STORAGE: r2 },
      params: { id: gen.id },
    });
    expect(res.status).toBe(200);

    // 削除後に全R2ファイルが消えていることを確認
    expect(await r2.head('originals/test-user-001/2026/03/27/file-001.png')).toBeNull();
    expect(await r2.head('line_art/gen-001.png')).toBeNull();
    expect(await r2.head('pdf/gen-001.pdf')).toBeNull();
  });

  it('pdf_keyがnullの場合でもエラーにならない', async () => {
    const user = createTestUser();
    const session = createTestSession(user.id);
    const gen = createTestGeneration(user.id, {
      pdf_key: null,
    });

    const r2 = createMockR2();
    await r2.put('originals/test-user-001/2026/03/27/file-001.png', new Uint8Array([1]));
    await r2.put('line_art/gen-001.png', new Uint8Array([2]));

    const db = createMockDB({
      users: [user],
      sessions: [session],
      generations: [gen],
    });

    const request = new Request('https://example.com/api/gallery/gen-001', {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${session.id}` },
    });

    const res = await onGalleryDelete({
      request,
      env: { NURIEL_DB: db, NURIEL_STORAGE: r2 },
      params: { id: gen.id },
    });
    expect(res.status).toBe(200);
  });

  it('line_art_image_keyもnullの場合でもエラーにならない', async () => {
    const user = createTestUser();
    const session = createTestSession(user.id);
    const gen = createTestGeneration(user.id, {
      line_art_image_key: null,
      pdf_key: null,
    });

    const r2 = createMockR2();
    await r2.put('originals/test-user-001/2026/03/27/file-001.png', new Uint8Array([1]));

    const db = createMockDB({
      users: [user],
      sessions: [session],
      generations: [gen],
    });

    const request = new Request('https://example.com/api/gallery/gen-001', {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${session.id}` },
    });

    const res = await onGalleryDelete({
      request,
      env: { NURIEL_DB: db, NURIEL_STORAGE: r2 },
      params: { id: gen.id },
    });
    expect(res.status).toBe(200);
  });
});

// ============================================================
// PDF: キャッシュ利用テスト
// ============================================================

describe('PDF: キャッシュ済みPDFの利用', () => {
  it('pdf_keyが設定されている場合はR2キャッシュから返す', async () => {
    const user = createTestUser();
    const session = createTestSession(user.id);
    const gen = createTestGeneration(user.id, {
      status: 'completed',
      line_art_image_key: 'line_art/gen-001.png',
      pdf_key: 'pdf/gen-001.pdf',
    });

    const r2 = createMockR2();
    // キャッシュPDFを配置
    const cachedPdf = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF
    await r2.put('pdf/gen-001.pdf', cachedPdf);
    // 線画も配置（フォールバック用）
    await r2.put('line_art/gen-001.png', new Uint8Array([0x89, 0x50, 0x4E, 0x47]));

    const db = createMockDB({
      users: [user],
      sessions: [session],
      generations: [gen],
    });

    const request = new Request('https://example.com/api/pdf/gen-001', {
      headers: { 'Authorization': `Bearer ${session.id}` },
    });

    const res = await onPdfGet({
      request,
      env: { NURIEL_DB: db, NURIEL_STORAGE: r2 },
      params: { id: gen.id },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
  });

  it('pdf_keyが設定されているがR2から消えている場合は再生成する', async () => {
    const user = createTestUser();
    const session = createTestSession(user.id);
    const gen = createTestGeneration(user.id, {
      status: 'completed',
      line_art_image_key: 'line_art/gen-001.png',
      pdf_key: 'pdf/gen-001.pdf', // 設定されているがR2には存在しない
    });

    const r2 = createMockR2();
    // pdf_keyのファイルは入れない（消えた状態）
    // 線画だけ配置
    await r2.put('line_art/gen-001.png', new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x00, 0x00, 0x00, 0x00]));

    const db = createMockDB({
      users: [user],
      sessions: [session],
      generations: [gen],
    });

    const request = new Request('https://example.com/api/pdf/gen-001', {
      headers: { 'Authorization': `Bearer ${session.id}` },
    });

    const res = await onPdfGet({
      request,
      env: { NURIEL_DB: db, NURIEL_STORAGE: r2 },
      params: { id: gen.id },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/pdf');

    // 再生成されたPDFがR2に保存されたことを確認
    const regeneratedPdf = await r2.head('pdf/gen-001.pdf');
    expect(regeneratedPdf).not.toBeNull();
  });
});

// ============================================================
// R2モック: エッジケース
// ============================================================

describe('R2モック: エッジケース', () => {
  it('putしてgetするとデータが一致する', async () => {
    const r2 = createMockR2();
    const data = new Uint8Array([10, 20, 30, 40, 50]);
    await r2.put('test/data.bin', data);

    const obj = await r2.get('test/data.bin');
    expect(obj).not.toBeNull();

    const buffer = await obj.arrayBuffer();
    const retrieved = new Uint8Array(buffer);
    expect(retrieved).toEqual(data);
  });

  it('存在しないキーのgetはnullを返す', async () => {
    const r2 = createMockR2();
    const result = await r2.get('nonexistent/key');
    expect(result).toBeNull();
  });

  it('存在しないキーのheadはnullを返す', async () => {
    const r2 = createMockR2();
    const result = await r2.head('nonexistent/key');
    expect(result).toBeNull();
  });

  it('deleteした後にgetするとnullを返す', async () => {
    const r2 = createMockR2();
    await r2.put('test/delete-me.bin', new Uint8Array([1]));

    // 存在確認
    expect(await r2.head('test/delete-me.bin')).not.toBeNull();

    // 削除
    await r2.delete('test/delete-me.bin');

    // 削除確認
    expect(await r2.get('test/delete-me.bin')).toBeNull();
    expect(await r2.head('test/delete-me.bin')).toBeNull();
  });

  it('同じキーにputすると上書きされる', async () => {
    const r2 = createMockR2();
    await r2.put('test/overwrite.bin', new Uint8Array([1, 2, 3]));
    await r2.put('test/overwrite.bin', new Uint8Array([4, 5, 6]));

    const obj = await r2.get('test/overwrite.bin');
    const buffer = await obj.arrayBuffer();
    const data = new Uint8Array(buffer);
    expect(data).toEqual(new Uint8Array([4, 5, 6]));
  });

  it('httpMetadataが正しく保存・取得される', async () => {
    const r2 = createMockR2();
    await r2.put('test/meta.png', new Uint8Array([1]), {
      httpMetadata: { contentType: 'image/png' },
    });

    const obj = await r2.get('test/meta.png');
    expect(obj.httpMetadata.contentType).toBe('image/png');
  });

  it('存在しないキーのdeleteはエラーにならない', async () => {
    const r2 = createMockR2();
    // 存在しないキーの削除が問題なく動作することを確認
    await expect(r2.delete('nonexistent/key')).resolves.not.toThrow();
  });
});

// ============================================================
// Upload: R2メタデータ検証
// ============================================================

describe('Upload: R2メタデータ検証', () => {
  it('アップロード後のR2キーがユーザーID・日付を含む形式になっている', async () => {
    const user = createTestUser();
    const session = createTestSession(user.id);
    const r2 = createMockR2();
    const db = createMockDB({ users: [user], sessions: [session] });

    const request = new Request('https://example.com/api/upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'image/jpeg',
        'Authorization': `Bearer ${session.id}`,
      },
      body: new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0]),
    });

    const res = await onUploadPost({ request, env: { NURIEL_DB: db, NURIEL_STORAGE: r2 } });
    expect(res.status).toBe(201);

    const body = await res.json();
    // originals/ユーザーID/年/月/日/ファイルID.拡張子 の形式
    expect(body.imageKey).toMatch(/^originals\/test-user-001\/\d{4}\/\d{2}\/\d{2}\/[a-f0-9-]+\.jpg$/);
    expect(body.mimeType).toBe('image/jpeg');
    expect(body.size).toBe(4);
  });

  it('0バイトの画像でもアップロードは成功する', async () => {
    const user = createTestUser();
    const session = createTestSession(user.id);
    const r2 = createMockR2();
    const db = createMockDB({ users: [user], sessions: [session] });

    const request = new Request('https://example.com/api/upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'image/png',
        'Authorization': `Bearer ${session.id}`,
      },
      body: new Uint8Array([]),
    });

    const res = await onUploadPost({ request, env: { NURIEL_DB: db, NURIEL_STORAGE: r2 } });
    // 0バイトでも受け入れられる（サイズ上限内なので）
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.size).toBe(0);
  });

  it('ちょうど10MBのファイルは受け入れられる', async () => {
    const user = createTestUser();
    const session = createTestSession(user.id);
    const r2 = createMockR2();
    const db = createMockDB({ users: [user], sessions: [session] });

    // 10MB = 10 * 1024 * 1024 バイト（境界値）
    const exactLimit = new ArrayBuffer(10 * 1024 * 1024);

    const request = new Request('https://example.com/api/upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'image/png',
        'Authorization': `Bearer ${session.id}`,
      },
      body: exactLimit,
    });

    const res = await onUploadPost({ request, env: { NURIEL_DB: db, NURIEL_STORAGE: r2 } });
    expect(res.status).toBe(201);
  });

  it('10MB + 1バイトのファイルは拒否される', async () => {
    const user = createTestUser();
    const session = createTestSession(user.id);
    const r2 = createMockR2();
    const db = createMockDB({ users: [user], sessions: [session] });

    const overLimit = new ArrayBuffer(10 * 1024 * 1024 + 1);

    const request = new Request('https://example.com/api/upload', {
      method: 'POST',
      headers: {
        'Content-Type': 'image/png',
        'Authorization': `Bearer ${session.id}`,
      },
      body: overLimit,
    });

    const res = await onUploadPost({ request, env: { NURIEL_DB: db, NURIEL_STORAGE: r2 } });
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toContain('10MB');
  });
});

// ============================================================
// PDF: 線画画像が見つからないケース
// ============================================================

describe('PDF: R2から線画画像取得失敗', () => {
  it('line_art_image_keyはあるがR2にファイルがない場合は404', async () => {
    const user = createTestUser();
    const session = createTestSession(user.id);
    const gen = createTestGeneration(user.id, {
      status: 'completed',
      line_art_image_key: 'line_art/gen-001.png',
      pdf_key: null, // キャッシュなし
    });

    const r2 = createMockR2();
    // 線画ファイルを入れない

    const db = createMockDB({
      users: [user],
      sessions: [session],
      generations: [gen],
    });

    const request = new Request('https://example.com/api/pdf/gen-001', {
      headers: { 'Authorization': `Bearer ${session.id}` },
    });

    const res = await onPdfGet({
      request,
      env: { NURIEL_DB: db, NURIEL_STORAGE: r2 },
      params: { id: gen.id },
    });
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.error).toContain('線画');
  });
});
