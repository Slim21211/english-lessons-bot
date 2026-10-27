-- Отметка «ДЗ сделано»: пока её нет, перед занятием приходят напоминания о домашке.
alter table public.lessons add column if not exists homework_done_at timestamptz;
