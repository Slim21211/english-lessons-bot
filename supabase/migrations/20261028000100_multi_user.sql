-- Несколько пользователей в одном боте: у каждого (по Telegram id) свои расписание, занятия, оплаты,
-- паузы, уведомления, состояние диалога и журнал отмены.
--
-- Существующие данные достаются одному пользователю. Если в базе уже есть данные, перед миграцией
-- в той же сессии выполните:  select set_config('app.owner_id', '<Telegram id>', false);
-- На пустой базе ничего задавать не нужно. Миграцию можно запускать повторно.

do $$
declare
  t text;
  owner bigint := nullif(current_setting('app.owner_id', true), '')::bigint;
  orphans boolean;
begin
  foreach t in array array[
    'schedule_slots', 'lessons', 'payments', 'pauses', 'notifications', 'bot_state', 'action_log'
  ] loop
    execute format('alter table public.%I add column if not exists user_id bigint', t);
    if owner is not null then
      execute format('update public.%I set user_id = $1 where user_id is null', t) using owner;
    elsif t = 'schedule_slots' then
      -- Стартовое расписание из seed-миграции без владельца не нужно: каждый задаёт своё через /schedule
      delete from public.schedule_slots where user_id is null;
    end if;
    execute format('select exists (select 1 from public.%I where user_id is null)', t) into orphans;
    if orphans then
      raise exception 'В % есть данные без владельца. Задайте app.owner_id (см. комментарий в начале миграции)', t;
    end if;
    execute format('alter table public.%I alter column user_id set not null', t);
  end loop;
end $$;

-- Ключ занятия из расписания уникален в пределах пользователя
alter table public.lessons drop constraint if exists lessons_slot_key_key;
alter table public.lessons drop constraint if exists lessons_user_slot_key_key;
alter table public.lessons add constraint lessons_user_slot_key_key unique (user_id, slot_key);

alter table public.notifications drop constraint if exists notifications_pkey;
alter table public.notifications add primary key (user_id, key);

alter table public.bot_state drop constraint if exists bot_state_pkey;
alter table public.bot_state add primary key (user_id, key);

create index if not exists lessons_user_starts_at_idx on public.lessons (user_id, starts_at);
create index if not exists payments_user_paid_at_idx on public.payments (user_id, paid_at);
create index if not exists pauses_user_ends_on_idx on public.pauses (user_id, ends_on);
create index if not exists schedule_slots_user_idx on public.schedule_slots (user_id) where active;
create index if not exists action_log_user_id_idx on public.action_log (user_id, id desc);

drop function if exists public.balance_totals();
create or replace function public.balance_totals(p_user_id bigint)
returns table (credits bigint, used bigint)
language sql
stable
set search_path = ''
as $$
  select
    coalesce((select sum(p.lessons) from public.payments p where p.user_id = p_user_id), 0)::bigint as credits,
    (select count(*) from public.lessons l
      where l.user_id = p_user_id and l.status in ('done', 'burned'))::bigint as used;
$$;

revoke all on function public.balance_totals(bigint) from public, anon, authenticated;
grant execute on function public.balance_totals(bigint) to service_role;
