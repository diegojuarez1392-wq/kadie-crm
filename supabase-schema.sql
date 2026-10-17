create extension if not exists pgcrypto;
create table if not exists conversations (
  id uuid primary key default gen_random_uuid(), phone text unique not null, customer_name text default 'Cliente WhatsApp', product text,
  mode text default 'bot' check (mode in ('bot','human','paused')), status text default 'Abierto', source text default 'whatsapp',
  referral_source_id text, ctwa_clid text, referral jsonb default '{}'::jsonb, last_inbound_at timestamptz,
  service_window_until timestamptz, entry_window_until timestamptz, created_at timestamptz default now(), updated_at timestamptz default now()
);
create table if not exists messages (
  id uuid primary key default gen_random_uuid(), conversation_id uuid references conversations(id) on delete cascade,
  direction text not null check (direction in ('inbound','outbound')), type text default 'text', body text,
  wa_message_id text unique, status text, metadata jsonb default '{}'::jsonb, created_at timestamptz default now()
);
create table if not exists orders (
  id uuid primary key default gen_random_uuid(), customer_name text, phone text, product text, amount numeric(10,2) default 0,
  district text, address text, reference text, status text default 'Confirmado', created_at timestamptz default now(), updated_at timestamptz default now()
);
create index if not exists idx_messages_conversation on messages(conversation_id, created_at);
create index if not exists idx_conversations_updated on conversations(updated_at desc);
