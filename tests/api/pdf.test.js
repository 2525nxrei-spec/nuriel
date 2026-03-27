/**
 * GET /api/pdf/:id のテスト
 */
import { describe, it, expect } from 'vitest';
import { onRequestGet } from '../../functions/api/pdf/[id].js';
import {
  createMockDB,
  createMockR2,
  createTestUser,
  createTestSession,
  createTestGeneration,
} from '../helpers/mock-env.js';

describe('GET /api/pdf/:id', () => {
  it('認証なしで401を返す', async () => {
    const request = new Request('https://example.com/api/pdf/gen-001');
    const env = { NURIEL_DB: createMockDB(), NURIEL_STORAGE: createMockR2() };

    const res = await onRequestGet({ request, env, params: { id: 'gen-001' } });
    expect(res.status).toBe(401);
  });

  it('存在しない生成IDで404を返す', async () => {
    const user = createTestUser();
    const session = createTestSession(user.id);
    const db = createMockDB({ users: [user], sessions: [session] });
    const r2 = createMockR2();

    const request = new Request('https://example.com/api/pdf/nonexistent', {
      headers: { 'Authorization': `Bearer ${session.id}` },
    });

    const res = await onRequestGet({
      request,
      env: { NURIEL_DB: db, NURIEL_STORAGE: r2 },
      params: { id: 'nonexistent' },
    });
    expect(res.status).toBe(404);
  });

  it('未完了の生成で400を返す', async () => {
    const user = createTestUser();
    const session = createTestSession(user.id);
    const gen = createTestGeneration(user.id, { status: 'processing' });
    const db = createMockDB({
      users: [user],
      sessions: [session],
      generations: [gen],
    });

    const request = new Request('https://example.com/api/pdf/gen-001', {
      headers: { 'Authorization': `Bearer ${session.id}` },
    });

    const res = await onRequestGet({
      request,
      env: { NURIEL_DB: db, NURIEL_STORAGE: createMockR2() },
      params: { id: gen.id },
    });
    expect(res.status).toBe(400);

    const body = await res.json();
    expect(body.error).toContain('完了');
  });

  it('線画が存在しない場合は404を返す', async () => {
    const user = createTestUser();
    const session = createTestSession(user.id);
    const gen = createTestGeneration(user.id, {
      status: 'completed',
      line_art_image_key: null,
    });
    const db = createMockDB({
      users: [user],
      sessions: [session],
      generations: [gen],
    });

    const request = new Request('https://example.com/api/pdf/gen-001', {
      headers: { 'Authorization': `Bearer ${session.id}` },
    });

    const res = await onRequestGet({
      request,
      env: { NURIEL_DB: db, NURIEL_STORAGE: createMockR2() },
      params: { id: gen.id },
    });
    expect(res.status).toBe(404);
  });

  it('完了済みでPDFを生成して返す', async () => {
    const user = createTestUser();
    const session = createTestSession(user.id);
    const gen = createTestGeneration(user.id, {
      status: 'completed',
      line_art_image_key: 'line_art/gen-001.png',
      pdf_key: null,
    });
    const db = createMockDB({
      users: [user],
      sessions: [session],
      generations: [gen],
    });
    const r2 = createMockR2();
    // 線画ファイルをR2に配置
    await r2.put('line_art/gen-001.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00, 0x00]));

    const request = new Request('https://example.com/api/pdf/gen-001', {
      headers: { 'Authorization': `Bearer ${session.id}` },
    });

    const res = await onRequestGet({
      request,
      env: { NURIEL_DB: db, NURIEL_STORAGE: r2 },
      params: { id: gen.id },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/pdf');
    expect(res.headers.get('Content-Disposition')).toContain('nuriel-gen-001.pdf');
  });
});
