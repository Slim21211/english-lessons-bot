-- Планировщик: pg_cron каждые 5 минут вызывает POST /api/tick на Vercel через pg_net.
-- Адрес и секрет хранятся в Supabase Vault, их записывает CI после деплоя (scripts/post-deploy.ts),
-- поэтому в репозитории нет ни URL, ни секретов.

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

create or replace function public.configure_tick(p_url text, p_secret text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  if p_url is null or p_url !~ '^https://' then
    raise exception 'tick url must start with https://';
  end if;
  if p_secret is null or length(p_secret) < 16 then
    raise exception 'tick secret is too short';
  end if;

  select id into v_id from vault.secrets where name = 'lessons_bot_tick_url';
  if v_id is null then
    perform vault.create_secret(p_url, 'lessons_bot_tick_url');
  else
    perform vault.update_secret(v_id, p_url);
  end if;

  v_id := null;
  select id into v_id from vault.secrets where name = 'lessons_bot_tick_secret';
  if v_id is null then
    perform vault.create_secret(p_secret, 'lessons_bot_tick_secret');
  else
    perform vault.update_secret(v_id, p_secret);
  end if;
end;
$$;

create or replace function public.call_tick()
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_secret text;
begin
  select decrypted_secret into v_url
    from vault.decrypted_secrets where name = 'lessons_bot_tick_url';
  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'lessons_bot_tick_secret';

  -- До первого деплоя адреса ещё нет: тихо выходим.
  if v_url is null or v_secret is null then
    return null;
  end if;

  return net.http_post(
    url := v_url,
    body := jsonb_build_object('source', 'pg_cron'),
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || v_secret
    ),
    timeout_milliseconds := 30000
  );
end;
$$;

revoke all on function public.configure_tick(text, text) from public, anon, authenticated;
revoke all on function public.call_tick() from public, anon, authenticated;
grant execute on function public.configure_tick(text, text) to service_role;

-- cron.schedule с тем же именем обновляет существующую задачу.
select cron.schedule('lessons-bot-tick', '*/5 * * * *', $$select public.call_tick()$$);

-- Чистим историю pg_net и cron, чтобы не копилась.
select cron.schedule(
  'lessons-bot-cleanup',
  '17 3 * * *',
  $$
    delete from cron.job_run_details where end_time < now() - interval '7 days';
    delete from public.notifications where sent_at < now() - interval '120 days';
    delete from public.bot_state where expires_at is not null and expires_at < now();
  $$
);
