-- ============================================================
-- ヌリエル D1データベーススキーマ
-- ペット写真→塗り絵線画AI変換サービス
-- ============================================================

-- ユーザーテーブル
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,                          -- UUIDv4
    email TEXT UNIQUE NOT NULL,                   -- メールアドレス（ログインID）
    password_hash TEXT NOT NULL,                  -- bcryptハッシュ
    display_name TEXT,                            -- 表示名
    plan TEXT NOT NULL DEFAULT 'free',            -- 契約プラン: free / otameshi / tappuri
    stripe_customer_id TEXT,                      -- Stripe顧客ID
    stripe_subscription_id TEXT,                  -- StripeサブスクリプションID
    monthly_generation_count INTEGER NOT NULL DEFAULT 0, -- 今月の生成回数
    monthly_reset_date TEXT,                      -- 月次リセット日（ISO8601）
    gallery_count INTEGER NOT NULL DEFAULT 0,     -- ギャラリー保存数
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- セッションテーブル（トークンベース認証）
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,                          -- セッショントークン
    user_id TEXT NOT NULL,                        -- ユーザーID
    expires_at TEXT NOT NULL,                     -- 有効期限（ISO8601）
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- 線画生成テーブル
CREATE TABLE IF NOT EXISTS generations (
    id TEXT PRIMARY KEY,                          -- UUIDv4
    user_id TEXT NOT NULL,                        -- ユーザーID
    original_image_key TEXT,                      -- R2: アップロード画像キー
    line_art_image_key TEXT,                      -- R2: 線画画像キー
    pdf_key TEXT,                                 -- R2: 生成PDFキー
    style TEXT NOT NULL DEFAULT 'standard',        -- 線画スタイル: gentle / standard / sketch / manga
    status TEXT NOT NULL DEFAULT 'pending',       -- 状態: pending / processing / completed / failed
    replicate_prediction_id TEXT,                 -- Replicate API 予測ID
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

-- プランマスタテーブル
CREATE TABLE IF NOT EXISTS plans (
    id TEXT PRIMARY KEY,                          -- プラン識別子
    name TEXT NOT NULL,                           -- プラン表示名
    price_monthly INTEGER NOT NULL,               -- 月額料金（円）
    price_yearly INTEGER NOT NULL,                -- 年額料金（円）
    monthly_limit INTEGER NOT NULL,               -- 月間生成上限
    styles_allowed TEXT NOT NULL DEFAULT '[]',    -- 利用可能スタイル（JSON配列）
    gallery_limit INTEGER NOT NULL,               -- ギャラリー保存上限
    stripe_price_id_monthly TEXT,                 -- Stripe月額Price ID
    stripe_price_id_yearly TEXT                   -- Stripe年額Price ID
);

-- ログイン試行テーブル（ブルートフォース対策）
CREATE TABLE IF NOT EXISTS login_attempts (
    id TEXT PRIMARY KEY,                          -- UUIDv4
    identifier TEXT NOT NULL,                     -- IPアドレスまたはメールアドレス
    success INTEGER NOT NULL DEFAULT 0,           -- 成功=1, 失敗=0
    attempted_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ログイン試行検索の高速化
CREATE INDEX IF NOT EXISTS idx_login_attempts_identifier ON login_attempts(identifier);
CREATE INDEX IF NOT EXISTS idx_login_attempts_attempted_at ON login_attempts(attempted_at);

-- Webhookログテーブル（Stripe Webhook受信記録）
CREATE TABLE IF NOT EXISTS webhooks_log (
    id TEXT PRIMARY KEY,                          -- UUIDv4
    event_type TEXT NOT NULL,                     -- イベントタイプ（例: checkout.session.completed）
    stripe_event_id TEXT,                         -- StripeイベントID（冪等性チェック用）
    payload TEXT,                                 -- イベントペイロード（JSON文字列）
    processed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- インデックス
-- ============================================================

-- ユーザー検索の高速化
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_stripe_customer_id ON users(stripe_customer_id);
CREATE INDEX IF NOT EXISTS idx_users_plan ON users(plan);

-- セッション検索（認証時に頻繁にアクセス）
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);

-- 生成履歴検索
CREATE INDEX IF NOT EXISTS idx_generations_user_id ON generations(user_id);
CREATE INDEX IF NOT EXISTS idx_generations_status ON generations(status);
CREATE INDEX IF NOT EXISTS idx_generations_replicate_id ON generations(replicate_prediction_id);
CREATE INDEX IF NOT EXISTS idx_generations_created_at ON generations(created_at);

-- Webhookログの重複チェック
CREATE UNIQUE INDEX IF NOT EXISTS idx_webhooks_stripe_event_id ON webhooks_log(stripe_event_id);

-- ============================================================
-- 初期データ: プランマスタ
-- ============================================================

INSERT OR REPLACE INTO plans (id, name, price_monthly, price_yearly, monthly_limit, styles_allowed, gallery_limit, stripe_price_id_monthly, stripe_price_id_yearly)
VALUES
    ('free', '無料体験', 0, 0, 1, '["gentle"]', 3, NULL, NULL),
    ('otameshi', 'おためし', 100, 1000, 3, '["gentle","standard"]', 10, 'price_1TF9k09Fc8Hnuaoko8QNE9PR', 'price_1TFFQ99Fc8HnuaokGaHGFIWS'),
    ('tappuri', 'たっぷり', 300, 3000, 20, '["gentle","standard","sketch","manga"]', -1, 'price_1TF9k09Fc8HnuaokNAzdNPRv', 'price_1TFFRU9Fc8HnuaokqFdzJaJk');
