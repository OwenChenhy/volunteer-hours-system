-- 启用 UUID 扩展
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 枚举类型
CREATE TYPE user_role    AS ENUM ('organizer', 'admin');
CREATE TYPE activity_status AS ENUM ('active', 'archived');
CREATE TYPE log_source   AS ENUM ('online', 'imported');
CREATE TYPE log_status   AS ENUM ('pending', 'approved', 'rejected');

-- 用户表
CREATE TABLE users (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  username      VARCHAR(64)  UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  real_name     VARCHAR(64)  NOT NULL,
  role          user_role    NOT NULL,
  org_name      VARCHAR(128),
  is_active     BOOLEAN      DEFAULT true,
  created_at    TIMESTAMPTZ  DEFAULT now(),
  updated_at    TIMESTAMPTZ  DEFAULT now()
);

-- 活动表
CREATE TABLE activities (
  id          UUID            PRIMARY KEY DEFAULT gen_random_uuid(),
  name        VARCHAR(256)    NOT NULL,
  start_time  TIMESTAMPTZ     NOT NULL,
  end_time    TIMESTAMPTZ     NOT NULL,
  location    VARCHAR(256),
  org_name    VARCHAR(128),
  description TEXT,
  created_by  UUID            REFERENCES users(id),
  status      activity_status DEFAULT 'active',
  created_at  TIMESTAMPTZ     DEFAULT now()
);

-- 导入批次表
CREATE TABLE import_batches (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  filename     VARCHAR(256) NOT NULL,
  imported_by  UUID         REFERENCES users(id),
  record_count INTEGER,
  note         TEXT,
  created_at   TIMESTAMPTZ  DEFAULT now()
);

-- 志愿时长记录表（核心）
CREATE TABLE volunteer_logs (
  id                  UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id          VARCHAR(32)   NOT NULL,
  student_name        VARCHAR(64)   NOT NULL,
  college             VARCHAR(128),
  grade               VARCHAR(16),
  phone               VARCHAR(20),
  activity_id         UUID          REFERENCES activities(id),
  activity_name       VARCHAR(256)  NOT NULL,
  activity_date       DATE          NOT NULL,
  hours               NUMERIC(6,1)  NOT NULL CHECK (hours > 0),
  source              log_source    NOT NULL,
  status              log_status    DEFAULT 'pending',
  reject_reason       TEXT,
  import_batch_id     UUID          REFERENCES import_batches(id),
  is_legacy_processed BOOLEAN       DEFAULT false,
  submitted_by        UUID          REFERENCES users(id),
  reviewed_by         UUID          REFERENCES users(id),
  reviewed_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ   DEFAULT now()
);

-- 操作日志表
CREATE TABLE operation_logs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID REFERENCES users(id),
  username    VARCHAR(64),
  action      VARCHAR(64) NOT NULL,
  target_type VARCHAR(64),
  target_id   UUID,
  detail      JSONB,
  ip          VARCHAR(64),
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- 索引
CREATE INDEX idx_logs_student ON volunteer_logs(student_id, student_name);
CREATE INDEX idx_logs_status  ON volunteer_logs(status);
CREATE INDEX idx_logs_source  ON volunteer_logs(source);
CREATE INDEX idx_logs_activity ON volunteer_logs(activity_id);
CREATE INDEX idx_logs_legacy  ON volunteer_logs(is_legacy_processed) WHERE source = 'imported';
CREATE INDEX idx_operation_logs_created_at ON operation_logs(created_at DESC);
