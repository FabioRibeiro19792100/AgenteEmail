create table if not exists operational_notes (
  id text primary key,
  user_id text not null references users(user_id) on delete cascade,
  turma_id text not null references turmas(turma_id),
  agent_id text,
  type text not null,
  title text not null,
  summary text not null,
  next_action text,
  evidence_indexes jsonb not null default '[]'::jsonb,
  sources jsonb not null default '[]'::jsonb,
  status text not null default 'open',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists operational_notes_user_status_idx
  on operational_notes (user_id, status, created_at desc);

create index if not exists operational_notes_user_created_idx
  on operational_notes (user_id, created_at desc);
