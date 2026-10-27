-- Стартовое расписание: понедельник и среда в 16:40 по Москве, 60 минут.
-- Меняется командой /schedule в боте; эта миграция срабатывает только на пустой таблице.

insert into public.schedule_slots (weekday, start_time, duration_min)
select v.weekday, v.start_time, v.duration_min
from (values (1, time '16:40', 60), (3, time '16:40', 60)) as v(weekday, start_time, duration_min)
where not exists (select 1 from public.schedule_slots);
