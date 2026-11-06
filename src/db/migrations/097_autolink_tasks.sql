-- Durable Professional Autolink tasks and exact, single-use action approvals.
CREATE TABLE autolink_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES accountant_conversations(id) ON DELETE CASCADE,
  goal text NOT NULL CHECK (length(goal) BETWEEN 1 AND 12000),
  status text NOT NULL DEFAULT 'planning' CHECK (status IN ('planning','review','running','ready','answered','paused','blocked')),
  answer text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX autolink_tasks_user_recent ON autolink_tasks(user_id,updated_at DESC);
CREATE INDEX autolink_tasks_conversation ON autolink_tasks(conversation_id);

CREATE TABLE autolink_action_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES autolink_tasks(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  args jsonb NOT NULL,
  summary text NOT NULL,
  execution_context jsonb NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','succeeded','review','cancelled')),
  result jsonb,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '30 minutes',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX autolink_proposals_task ON autolink_action_proposals(task_id,created_at);
CREATE INDEX autolink_proposals_user ON autolink_action_proposals(user_id);
CREATE UNIQUE INDEX autolink_one_pending_proposal ON autolink_action_proposals(task_id) WHERE status IN ('pending','running');
ALTER TABLE autolink_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE autolink_action_proposals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON autolink_tasks,autolink_action_proposals FROM PUBLIC,anon,authenticated;
