-- Учёт занятий: расписание, занятия, оплаты, паузы, служебное состояние бота.
-- Все таблицы закрыты RLS без политик: доступ только у service_role (серверная часть на Vercel).

create extension if not exists pgcrypto with schema extensions;

create type public.lesson_status as enum (
  'planned',      -- запланировано, ещё не подтверждено
  'confirmed',    -- подтверждено, что состоится
  'done',         -- состоялось (списывается из оплаченных)
  'cancelled',    -- отменено без списания
  'burned',       -- отменено, но сгорело (списывается)
  'rescheduled'   -- перенесено (вместо него создаётся новое занятие)
);

-- Регулярное расписание. weekday по ISO: 1 = понедельник ... 7 = воскресенье.
create table public.schedule_slots (
  id            bigint generated always as identity primary key,
  weekday       smallint not null check (weekday between 1 and 7),
  start_time    time not null,
  duration_min  integer not null default 60 check (duration_min between 10 and 600),
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

create table public.lessons (
  id                uuid primary key default gen_random_uuid(),
  starts_at         timestamptz not null,
  duration_min      integer not null default 60 check (duration_min between 10 and 600),
  status            public.lesson_status not null default 'planned',
  -- Ключ занятия из расписания: 'YYYY-MM-DD@HH:MM' в локальной зоне.
  -- Уникальность не даёт сгенерировать занятие повторно, даже если его перенесли или отменили.
  slot_key          text unique,
  rescheduled_from  uuid references public.lessons(id) on delete set null,
  note              text,
  resolved_at       timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index lessons_starts_at_idx on public.lessons (starts_at);
create index lessons_status_idx on public.lessons (status);

-- Оплаты и ручные корректировки баланса (kind = 'adjustment').
create table public.payments (
  id          uuid primary key default gen_random_uuid(),
  paid_at     timestamptz not null default now(),
  lessons     integer not null check (lessons <> 0),
  amount      numeric(12, 2) check (amount is null or amount >= 0),
  kind        text not null default 'payment' check (kind in ('payment', 'adjustment')),
  note        text,
  created_at  timestamptz not null default now()
);

create index payments_paid_at_idx on public.payments (paid_at);

-- Отпуска и перерывы: занятия из расписания в эти даты не создаются.
create table public.pauses (
  id          bigint generated always as identity primary key,
  starts_on   date not null,
  ends_on     date not null,
  note        text,
  created_at  timestamptz not null default now(),
  check (ends_on >= starts_on)
);

-- Отправленные уведомления. Первичный ключ работает как блокировка:
-- тик сначала вставляет ключ и только потом шлёт сообщение, поэтому дублей не будет.
create table public.notifications (
  key         text primary key,
  sent_at     timestamptz not null default now(),
  message_id  bigint,
  payload     jsonb
);

create index notifications_sent_at_idx on public.notifications (sent_at);

-- Состояние диалога (ожидание ответа, черновики разобранных команд, отложенные напоминания).
create table public.bot_state (
  key         text primary key,
  value       jsonb not null,
  expires_at  timestamptz,
  updated_at  timestamptz not null default now()
);

-- Журнал изменений для отмены действий. ops: [{entity, id, before, after}].
create table public.action_log (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  kind        text not null,
  summary     text not null,
  ops         jsonb not null,
  undone_at   timestamptz
);

create index action_log_created_at_idx on public.action_log (created_at desc);

create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger lessons_touch_updated_at
  before update on public.lessons
  for each row execute function public.touch_updated_at();

-- Сумма купленных занятий одним запросом, без выгрузки всех оплат.
create or replace function public.balance_totals()
returns table (credits bigint, used bigint)
language sql
stable
set search_path = ''
as $$
  select
    coalesce((select sum(p.lessons) from public.payments p), 0)::bigint as credits,
    (select count(*) from public.lessons l where l.status in ('done', 'burned'))::bigint as used;
$$;

alter table public.schedule_slots enable row level security;
alter table public.lessons        enable row level security;
alter table public.payments       enable row level security;
alter table public.pauses         enable row level security;
alter table public.notifications  enable row level security;
alter table public.bot_state      enable row level security;
alter table public.action_log     enable row level security;

revoke all on function public.balance_totals() from public, anon, authenticated;
grant execute on function public.balance_totals() to service_role;

-- Явные права: работаем только от service_role, роли клиентского API (anon/authenticated) не получают ничего,
-- даже если в проекте отключено автоматическое открытие новых таблиц.
revoke all on
  public.schedule_slots, public.lessons, public.payments, public.pauses,
  public.notifications, public.bot_state, public.action_log
from anon, authenticated;

grant select, insert, update, delete on
  public.schedule_slots, public.lessons, public.payments, public.pauses,
  public.notifications, public.bot_state, public.action_log
to service_role;

grant usage, select on all sequences in schema public to service_role;
