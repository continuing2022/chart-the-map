ALTER TABLE processing_tasks ADD COLUMN provider_job_id text;
ALTER TABLE processing_tasks ADD COLUMN provider_submitted_at timestamptz;
