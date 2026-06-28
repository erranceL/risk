create table if not exists risk_events (
  event_id text primary key,
  sequence bigint not null,
  type text not null,
  occurred_at timestamptz not null,
  published_at timestamptz not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create unique index if not exists risk_events_sequence_idx on risk_events (sequence);

create table if not exists risk_quotes (
  quote_id text primary key,
  symbol text not null,
  period text not null,
  r_up numeric not null,
  r_down numeric not null,
  platform_edge numeric not null,
  house_edge numeric not null,
  generated_at timestamptz not null,
  expires_at timestamptz not null,
  exposure_cursor text not null,
  config_version text not null,
  model_version text not null,
  clamp_reason text,
  risk_signal text not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists risk_quotes_product_generated_idx
  on risk_quotes (symbol, period, generated_at desc);

create table if not exists risk_configs (
  symbol text not null,
  period text not null,
  config_version text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  primary key (symbol, period, config_version)
);
