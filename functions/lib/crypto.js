/**
 * 暗号化ユーティリティ
 * Web Crypto API を使用（Pages Functions環境対応）
 */

/**
 * UUIDv4を生成
 * @returns {string}
 */
export function generateId() {
  return crypto.randomUUID();
}

/**
 * セッショントークンを生成（64文字のランダム16進文字列）
 * @returns {string}
 */
export function generateSessionToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * パスワードをハッシュ化（PBKDF2）
 * bcryptはWorkers環境で使えないため、PBKDF2を使用
 * @param {string} password
 * @returns {Promise<string>} salt:hash 形式
 */
export async function hashPassword(password) {
  const salt = new Uint8Array(16);
  crypto.getRandomValues(salt);

  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations: 100000,
      hash: 'SHA-256',
    },
    keyMaterial,
    256
  );

  const saltHex = Array.from(salt).map(b => b.toString(16).padStart(2, '0')).join('');
  const hashHex = Array.from(new Uint8Array(derivedBits)).map(b => b.toString(16).padStart(2, '0')).join('');

  return `${saltHex}:${hashHex}`;
}

/**
 * パスワードを検証
 * @param {string} password - 入力パスワード
 * @param {string} stored - 保存済みハッシュ（salt:hash形式）
 * @returns {Promise<boolean>}
 */
/**
 * ArrayBufferをBase64文字列に変換
 * @param {ArrayBuffer} buffer
 * @returns {string}
 */
/**
 * 次回の月次リセット日を計算（翌月1日 00:00 UTC）
 * @returns {string} ISO8601形式
 */
export function getNextMonthlyResetDate() {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0));
  return next.toISOString();
}

export function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export async function verifyPassword(password, stored) {
  const [saltHex, expectedHash] = stored.split(':');
  const salt = new Uint8Array(saltHex.match(/.{2}/g).map(byte => parseInt(byte, 16)));

  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt,
      iterations: 100000,
      hash: 'SHA-256',
    },
    keyMaterial,
    256
  );

  const hashHex = Array.from(new Uint8Array(derivedBits)).map(b => b.toString(16).padStart(2, '0')).join('');
  return hashHex === expectedHash;
}
