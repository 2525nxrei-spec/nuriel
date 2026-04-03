-- ============================================================
-- マイグレーション: cancel_at_period_end カラム追加
-- 実行方法: Cloudflare Dashboard > D1 > NURIEL_DB > Console でこのSQLを実行
-- ============================================================

ALTER TABLE users ADD COLUMN cancel_at_period_end INTEGER NOT NULL DEFAULT 0;
