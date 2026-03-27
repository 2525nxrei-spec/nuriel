/**
 * テスト用モック環境
 * D1、R2、環境変数をインメモリでシミュレート
 */

/**
 * D1データベースのモック
 * prepare → bind → first/all/run のチェーンをシミュレート
 */
export function createMockDB(data = {}) {
  // テーブルごとのデータストア
  const store = {
    users: data.users || [],
    sessions: data.sessions || [],
    generations: data.generations || [],
    plans: data.plans || getDefaultPlans(),
    webhooks_log: data.webhooks_log || [],
    login_attempts: data.login_attempts || [],
  };

  // 最後に実行されたSQLを記録（テスト検証用）
  const queries = [];

  function createStatement(sql) {
    let boundParams = [];

    const statement = {
      bind(...params) {
        boundParams = params;
        return statement;
      },

      async first() {
        queries.push({ sql, params: boundParams });
        return resolveQuery(sql, boundParams, store, 'first');
      },

      async all() {
        queries.push({ sql, params: boundParams });
        return resolveQuery(sql, boundParams, store, 'all');
      },

      async run() {
        queries.push({ sql, params: boundParams });
        return resolveQuery(sql, boundParams, store, 'run');
      },
    };

    return statement;
  }

  return {
    prepare: (sql) => createStatement(sql),
    batch: async (statements) => {
      const results = [];
      for (const stmt of statements) {
        results.push(await stmt.run());
      }
      return results;
    },
    _store: store,
    _queries: queries,
  };
}

/**
 * クエリを簡易的に解決する
 * 完全なSQLパーサーではなく、テストに必要な主要パターンをカバー
 */
function resolveQuery(sql, params, store, mode) {
  const sqlLower = sql.toLowerCase().trim();

  // SELECT文: テーブル名とWHERE条件からデータを返す
  if (sqlLower.startsWith('select')) {
    const tableMatch = sql.match(/FROM\s+(\w+)/i);
    if (!tableMatch) return mode === 'first' ? null : { results: [] };

    const tableName = tableMatch[1];
    const rows = store[tableName] || [];

    // WHERE句の簡易マッチ（最初のパラメータで絞り込み）
    let filtered = rows;
    if (sqlLower.includes('where') && params.length > 0) {
      const whereMatch = sql.match(/WHERE\s+(\w+(?:\.\w+)?)\s*=\s*\?/i);
      if (whereMatch) {
        const col = whereMatch[1].split('.').pop();
        filtered = rows.filter(r => r[col] === params[0]);
      }
    }

    // COUNT(*)
    if (sqlLower.includes('count(*)')) {
      const result = { total: filtered.length };
      return mode === 'first' ? result : { results: [result] };
    }

    if (mode === 'first') {
      return filtered[0] || null;
    }
    return { results: filtered };
  }

  // INSERT文
  if (sqlLower.startsWith('insert')) {
    const tableMatch = sql.match(/INTO\s+(\w+)/i);
    if (tableMatch) {
      const tableName = tableMatch[1];
      if (!store[tableName]) store[tableName] = [];
      // paramsからオブジェクトを構築（カラム名はSQL文から抽出）
      const colMatch = sql.match(/\(([^)]+)\)\s*VALUES/i);
      if (colMatch) {
        const cols = colMatch[1].split(',').map(c => c.trim());
        const row = {};
        cols.forEach((col, i) => {
          row[col] = params[i] !== undefined ? params[i] : null;
        });
        store[tableName].push(row);
      }
    }
    return { meta: { changes: 1 } };
  }

  // UPDATE文
  if (sqlLower.startsWith('update')) {
    return { meta: { changes: 1 } };
  }

  // DELETE文
  if (sqlLower.startsWith('delete')) {
    return { meta: { changes: 1 } };
  }

  return mode === 'first' ? null : { results: [], meta: { changes: 0 } };
}

/**
 * デフォルトプランデータ
 */
function getDefaultPlans() {
  return [
    {
      id: 'free',
      name: '無料体験',
      price_monthly: 0,
      price_yearly: 0,
      monthly_limit: 1,
      styles_allowed: '["gentle"]',
      gallery_limit: 3,
      stripe_price_id_monthly: null,
      stripe_price_id_yearly: null,
    },
    {
      id: 'otameshi',
      name: 'おためし',
      price_monthly: 100,
      price_yearly: 1000,
      monthly_limit: 3,
      styles_allowed: '["gentle","standard"]',
      gallery_limit: 10,
      stripe_price_id_monthly: 'price_1TF9k09Fc8Hnuaoko8QNE9PR',
      stripe_price_id_yearly: 'price_1TFFQ99Fc8HnuaokGaHGFIWS',
    },
    {
      id: 'tappuri',
      name: 'たっぷり',
      price_monthly: 300,
      price_yearly: 3000,
      monthly_limit: 20,
      styles_allowed: '["gentle","standard","sketch","manga"]',
      gallery_limit: -1,
      stripe_price_id_monthly: 'price_1TF9k09Fc8HnuaokNAzdNPRv',
      stripe_price_id_yearly: 'price_1TFFRU9Fc8HnuaokqFdzJaJk',
    },
  ];
}

/**
 * R2ストレージのモック
 */
export function createMockR2() {
  const objects = new Map();

  return {
    async put(key, body, options = {}) {
      objects.set(key, {
        body,
        httpMetadata: options.httpMetadata || {},
        customMetadata: options.customMetadata || {},
      });
    },

    async get(key) {
      const obj = objects.get(key);
      if (!obj) return null;
      return {
        body: obj.body,
        httpMetadata: obj.httpMetadata,
        async arrayBuffer() {
          if (obj.body instanceof ArrayBuffer) return obj.body;
          if (obj.body instanceof Uint8Array) return obj.body.buffer;
          return new TextEncoder().encode(String(obj.body)).buffer;
        },
      };
    },

    async head(key) {
      return objects.has(key) ? { key } : null;
    },

    async delete(key) {
      objects.delete(key);
    },

    _objects: objects,
  };
}

/**
 * テスト用の環境オブジェクトを構築
 */
export function createMockEnv(overrides = {}) {
  return {
    NURIEL_DB: overrides.NURIEL_DB || createMockDB(overrides.dbData),
    NURIEL_STORAGE: overrides.NURIEL_STORAGE || createMockR2(),
    STRIPE_SECRET_KEY: overrides.STRIPE_SECRET_KEY || '',
    STRIPE_WEBHOOK_SECRET: overrides.STRIPE_WEBHOOK_SECRET || '',
    STRIPE_PUBLISHABLE_KEY: overrides.STRIPE_PUBLISHABLE_KEY || '',
    REPLICATE_API_TOKEN: overrides.REPLICATE_API_TOKEN || '',
    FRONTEND_URL: overrides.FRONTEND_URL || 'https://photo-nurie.com',
    ...overrides,
  };
}

/**
 * テスト用のRequestオブジェクト生成
 */
export function createMockRequest(url, options = {}) {
  const {
    method = 'GET',
    headers = {},
    body = null,
    token = null,
  } = options;

  const reqHeaders = new Headers(headers);
  if (token) {
    reqHeaders.set('Authorization', `Bearer ${token}`);
  }
  if (body && !reqHeaders.has('Content-Type')) {
    reqHeaders.set('Content-Type', 'application/json');
  }

  const init = { method, headers: reqHeaders };
  if (body && method !== 'GET') {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }

  return new Request(url, init);
}

/**
 * テスト用ユーザーデータ
 */
export function createTestUser(overrides = {}) {
  return {
    id: 'test-user-001',
    email: 'test@example.com',
    password_hash: '0123456789abcdef0123456789abcdef:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789ab',
    display_name: 'テストユーザー',
    plan: 'free',
    stripe_customer_id: null,
    stripe_subscription_id: null,
    monthly_generation_count: 0,
    monthly_reset_date: new Date(Date.UTC(2026, 3, 1)).toISOString(),
    gallery_count: 0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * テスト用セッションデータ
 */
export function createTestSession(userId = 'test-user-001', overrides = {}) {
  return {
    id: 'test-session-token-abc123',
    user_id: userId,
    expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * テスト用の生成レコード
 */
export function createTestGeneration(userId = 'test-user-001', overrides = {}) {
  return {
    id: 'gen-001',
    user_id: userId,
    original_image_key: 'originals/test-user-001/2026/03/27/file-001.png',
    line_art_image_key: 'line_art/gen-001.png',
    pdf_key: null,
    style: 'standard',
    status: 'completed',
    replicate_prediction_id: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}
