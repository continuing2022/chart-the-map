CREATE TABLE assets (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  client_record_id text,
  object_key text NOT NULL UNIQUE,
  mime_type text NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png')),
  width integer NOT NULL CHECK (width > 0),
  height integer NOT NULL CHECK (height > 0),
  kind text NOT NULL CHECK (kind IN ('original', 'stylized')),
  bound_meal_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE UNIQUE INDEX assets_owner_client_original_unique
  ON assets (owner_id, client_record_id)
  WHERE kind = 'original' AND client_record_id IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX assets_owner_meal_idx ON assets (owner_id, bound_meal_id);

CREATE TABLE meals (
  id text PRIMARY KEY,
  owner_id text NOT NULL,
  client_record_id text NOT NULL,
  date_key date NOT NULL,
  slot_key text NOT NULL CHECK (slot_key IN ('breakfast', 'lunch', 'dinner', 'lateNight')),
  style text NOT NULL CHECK (style IN ('插画', '黏土', '漫画')),
  note text NOT NULL DEFAULT '',
  original_asset_id text NOT NULL REFERENCES assets(id),
  nutrition jsonb,
  candidate_nutrition jsonb,
  manually_confirmed boolean NOT NULL DEFAULT false,
  deleting boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (owner_id, client_record_id)
);

ALTER TABLE assets
  ADD CONSTRAINT assets_bound_meal_fk
  FOREIGN KEY (bound_meal_id) REFERENCES meals(id);

CREATE INDEX meals_owner_date_idx ON meals (owner_id, date_key DESC) WHERE deleted_at IS NULL;

CREATE TABLE processing_tasks (
  id text PRIMARY KEY,
  meal_id text NOT NULL REFERENCES meals(id),
  type text NOT NULL CHECK (type IN ('stylization', 'nutrition')),
  client_task_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
  is_current boolean NOT NULL DEFAULT true,
  result jsonb,
  error jsonb,
  attempt_count integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  UNIQUE (meal_id, type, client_task_id)
);

CREATE UNIQUE INDEX processing_tasks_current_type_unique
  ON processing_tasks (meal_id, type)
  WHERE is_current;

CREATE INDEX processing_tasks_queue_idx
  ON processing_tasks (status, available_at)
  WHERE status IN ('queued', 'processing') AND is_current;

CREATE TABLE cost_ledger (
  id bigserial PRIMARY KEY,
  owner_id text NOT NULL,
  task_id text NOT NULL REFERENCES processing_tasks(id),
  amount_cny numeric(12, 4) NOT NULL CHECK (amount_cny >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task_id)
);

CREATE INDEX cost_ledger_owner_idx ON cost_ledger (owner_id, created_at);

CREATE TABLE deletion_jobs (
  id bigserial PRIMARY KEY,
  asset_id text NOT NULL REFERENCES assets(id),
  object_key text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  attempt_count integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (asset_id)
);

CREATE INDEX deletion_jobs_queue_idx
  ON deletion_jobs (status, available_at)
  WHERE status IN ('pending', 'failed');
