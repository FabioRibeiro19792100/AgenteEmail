create table if not exists agent_instructions (
  id text primary key,
  user_id text not null references users(user_id) on delete cascade,
  instruction text not null,
  applies_from date not null default current_date,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
