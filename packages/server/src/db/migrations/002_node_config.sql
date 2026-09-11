-- Structural workflow nodes (join, parallel, timer, conditional) are control
-- flow, not agent work. They need their graph configuration at execution time,
-- which the task row did not previously carry.
ALTER TABLE task ADD COLUMN node_config jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Set when a timer node parks. The dependency resolver releases the task once
-- this moment has passed, so a timer survives a worker restart: the wait is a
-- row in the database, not a setTimeout in a process that may not exist later.
ALTER TABLE task ADD COLUMN scheduled_for timestamptz;

CREATE INDEX task_scheduled_idx ON task (workspace_id, scheduled_for)
  WHERE scheduled_for IS NOT NULL;
