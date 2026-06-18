create table if not exists turmas (
  turma_id text primary key,
  nome text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists users (
  user_id text primary key,
  nome text not null,
  turma_id text not null references turmas(turma_id),
  email_informado text,
  papel text,
  instituicao text,
  agent_permission_level integer not null default 3,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists invites (
  invite_id text primary key,
  user_id text not null unique references users(user_id) on delete cascade,
  status text not null,
  created_at timestamptz not null default now(),
  first_access_at timestamptz,
  last_access_at timestamptz
);

create table if not exists google_connections (
  id text primary key,
  user_id text not null references users(user_id) on delete cascade,
  provider text not null,
  google_email text not null,
  access_token_encrypted text not null,
  refresh_token_encrypted text not null,
  scopes text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique(user_id, provider)
);

create table if not exists agent_logs (
  id text primary key,
  user_id text not null references users(user_id) on delete cascade,
  turma_id text not null references turmas(turma_id),
  action_type text not null,
  tool_name text not null,
  status text not null,
  created_at timestamptz not null default now()
);

create table if not exists sessions (
  session_id text primary key,
  user_id text not null references users(user_id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists oauth_states (
  nonce text primary key,
  user_id text not null references users(user_id) on delete cascade,
  provider text not null,
  created_at timestamptz not null default now()
);

create table if not exists pending_actions (
  id text primary key,
  user_id text not null references users(user_id) on delete cascade,
  turma_id text not null references turmas(turma_id),
  tool_name text not null,
  permission_level integer not null,
  title text not null,
  summary text not null,
  confirm_label text not null,
  editable boolean not null default false,
  preview_text text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  executed_at timestamptz,
  error_message text,
  execution_result jsonb
);
