import { randomBytes } from 'node:crypto';
import { Bot, type Context, GrammyError } from 'grammy';
import type { DateTime } from 'luxon';
import { config } from '../config.js';
import * as repo from '../db.js';
import {
  parseScheduleArgs,
  parseSlotSpec,
  type SlotSpec,
  sameSlotTime,
  slotToSpec,
  specToSlot,
} from '../domain/schedule.js';
import { isOpen } from '../domain/types.js';
import { isLlmConfigured, LlmUnavailableError } from '../llm/client.js';
import { buildRefs, parseIntentWithLlm } from '../llm/parse-intent.js';
import { extractDate, parseDateTime } from '../nlu/datetime.js';
import { type Intent, MUTATING_INTENTS } from '../nlu/intent.js';
import { parseByRules } from '../nlu/rules.js';
import * as svc from '../services/lessons.js';
import { buildMonthStats } from '../services/stats.js';
import { fmtShort, lessonStart, nowIn } from '../time.js';
import { runAs } from '../user.js';
import { describeAction, performAction, type Reply, type ResolvedAction, resolveIntent } from './actions.js';
import * as views from './views.js';

type AwaitState =
  | { kind: 'reschedule'; lessonId: string }
  | { kind: 'amount'; paymentId: string }
  /** Пошаговый ввод расписания: сколько всего занятий и уже введённые. */
  | { kind: 'slots'; total: number; specs: SlotSpec[] }
  /** Изменение одного слота; slotId = null — новый слот. */
  | { kind: 'slot'; slotId: number | null };

/** Изменение регулярного расписания, ждущее подтверждения. */
type PendingSchedule = { specs: SlotSpec[]; head: string };

const COMMANDS = [
  { command: 'status', description: 'Сколько осталось и ближайшие занятия' },
  { command: 'paid', description: 'Записать оплату: /paid 4 8000' },
  { command: 'setbalance', description: 'Выставить остаток оплаченных' },
  { command: 'add', description: 'Разовое занятие: /add 5.11 18:00' },
  { command: 'hw', description: 'ДЗ к ближайшему занятию сделано' },
  { command: 'schedule', description: 'Расписание и паузы' },
  { command: 'pause', description: 'Перерыв: /pause 28.12 10.01' },
  { command: 'history', description: 'Последние занятия и оплаты' },
  { command: 'stats', description: 'Статистика по месяцам' },
  { command: 'undo', description: 'Отменить последнее действие' },
  { command: 'help', description: 'Что я умею' },
];

export const BOT_COMMANDS = COMMANDS;

let instance: Bot | undefined;

export function getBot(): Bot {
  if (instance) return instance;
  const cfg = config();
  const bot = new Bot(cfg.TELEGRAM_BOT_TOKEN, {
    client: cfg.TELEGRAM_API_ROOT ? { apiRoot: cfg.TELEGRAM_API_ROOT } : {},
  });

  // Только пользователи из ALLOWED_TELEGRAM_IDS, у каждого свои данные. Остальным — отказ и их id
  // (удобно при добавлении нового пользователя).
  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (userId && cfg.ALLOWED_TELEGRAM_IDS.includes(userId)) return runAs(userId, next);
    if (ctx.chat?.type === 'private' && ctx.message) {
      await ctx.reply(`Это личный бот. Ваш Telegram id: ${ctx.from?.id ?? 'неизвестен'}`);
    }
    if (ctx.callbackQuery) await ctx.answerCallbackQuery();
  });

  // ---------- Команды ----------

  bot.command('start', async (ctx) => {
    await svc.materializeSchedule(nowIn(cfg.TIME_ZONE));
    const [snap, slots] = await Promise.all([svc.loadSnapshot(), repo.getActiveSlots()]);
    await ctx.reply(views.HELP_TEXT);
    if (slots.length === 0) {
      await ctx.reply('Для начала настроим расписание. Сколько занятий в неделю?', {
        reply_markup: views.slotsCountKeyboard(),
      });
    } else if (snap.balance.credits === 0 && snap.balance.used === 0) {
      await ctx.reply(SET_BALANCE_HINT);
    }
  });

  bot.command('help', (ctx) => ctx.reply(views.HELP_TEXT));

  bot.command('status', async (ctx) => {
    await sendReply(ctx, await statusReply());
  });

  bot.command('history', async (ctx) => {
    const [lessons, payments] = await Promise.all([repo.getRecentResolvedLessons(12), repo.getRecentPayments(6)]);
    await ctx.reply(views.historyText(lessons, payments, cfg.TIME_ZONE));
  });

  bot.command('stats', async (ctx) => {
    await ctx.reply(await statsReply());
  });

  bot.command('schedule', async (ctx) => {
    const args = ctx.match.trim();
    if (!args) {
      await sendReply(ctx, await scheduleReply());
      return;
    }
    // Быстрый способ одной строкой: /schedule пн ср 16:40
    const specs = parseScheduleArgs(args, cfg.DEFAULT_DURATION_MIN);
    if (!specs) {
      await ctx.reply('Не понял расписание. Примеры:\n/schedule пн ср 16:40\n/schedule пн 16:40 чт 18:00 90');
      return;
    }
    await saveOrProposeSchedule(ctx, specs);
  });

  bot.command('paid', async (ctx) => {
    const numbers = (ctx.match.match(/\d+(?:[.,]\d+)?/g) ?? []).map((n) => Number(n.replace(',', '.')));
    const [first, second] = numbers;
    let lessons = cfg.PACK_SIZE;
    let amount: number | null = null;
    if (first !== undefined && first >= 100) amount = first;
    else if (first !== undefined) lessons = first;
    if (second !== undefined) amount = second;
    if (!Number.isInteger(lessons) || lessons < 1 || lessons > 100) {
      await ctx.reply('Число занятий должно быть от 1 до 100. Пример: /paid 4 8000');
      return;
    }
    await sendReply(ctx, await performAction({ type: 'payment', lessons, amount }));
  });

  bot.command('setbalance', async (ctx) => {
    const n = Number.parseInt(ctx.match.trim(), 10);
    if (!Number.isFinite(n) || n < -50 || n > 200) {
      await ctx.reply('Укажи, сколько оплаченных занятий осталось сейчас: /setbalance 3');
      return;
    }
    await sendReply(ctx, await performAction({ type: 'set_balance', remaining: n }));
  });

  bot.command('add', async (ctx) => {
    const args = ctx.match.trim();
    const now = nowIn(cfg.TIME_ZONE);
    const durationMatch = /\s(\d{2,3})\s*(мин)?$/.exec(args);
    const duration = durationMatch ? Number(durationMatch[1]) : cfg.DEFAULT_DURATION_MIN;
    const when = parseDateTime(durationMatch ? args.slice(0, durationMatch.index) : args, now);
    if (!args || !when) {
      await ctx.reply('Укажи дату и время: /add 5.11 18:00 или /add пт 18:00 90');
      return;
    }
    await sendReply(
      ctx,
      await performAction({ type: 'add_lesson', start: when.toISO() as string, durationMin: duration }),
    );
  });

  bot.command('pause', async (ctx) => {
    const now = nowIn(cfg.TIME_ZONE);
    const parts = ctx.match
      .trim()
      .split(/\s*(?:—|–|-|\s по\s|\s)\s*/)
      .filter((p) => p && p !== 'с' && p !== 'по');
    const from = parts[0] ? extractDate(parts[0], now) : null;
    const to = parts[1] ? extractDate(parts[1], from ?? now) : from;
    if (!from || !to) {
      await ctx.reply('Укажи даты паузы: /pause 28.12 10.01 (или одну дату — на один день)');
      return;
    }
    if (to < from) {
      await ctx.reply('Конец паузы раньше начала — проверь даты.');
      return;
    }
    await sendReply(
      ctx,
      await performAction({ type: 'pause', from: from.toISODate() as string, to: to.toISODate() as string }),
    );
  });

  bot.command('hw', async (ctx) => {
    const snap = await svc.loadSnapshot();
    const lesson = svc.pickDefaultLesson('homework', snap.balance.upcoming, snap.now, snap.zone);
    if (!lesson) {
      await ctx.reply('Впереди нет запланированных занятий.');
      return;
    }
    await sendReply(ctx, await performAction({ type: 'homework', lessonId: lesson.id }));
  });

  bot.command('undo', async (ctx) => {
    await sendReply(ctx, await performAction({ type: 'undo' }));
  });

  bot.command('cancel', async (ctx) => {
    await repo.deleteState('await');
    await ctx.reply('Ок, отменил ожидание ответа.');
  });

  // ---------- Кнопки ----------

  bot.callbackQuery(/^ls:(done|cancelled|burned|confirmed):([0-9a-f-]{36})$/, async (ctx) => {
    const [, status, lessonId] = ctx.match as RegExpMatchArray as [
      string,
      'done' | 'cancelled' | 'burned' | 'confirmed',
      string,
    ];
    await ctx.answerCallbackQuery();
    const reply = await performAction({ type: 'status', lessonId, status });
    await closeButtons(ctx);
    await sendReply(ctx, reply);
  });

  bot.callbackQuery(/^hw:([0-9a-f-]{36})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const reply = await performAction({ type: 'homework', lessonId: ctx.match[1] as string });
    await closeButtons(ctx);
    await sendReply(ctx, reply);
  });

  bot.callbackQuery(/^lr:([0-9a-f-]{36})$/, async (ctx) => {
    const lessonId = ctx.match[1] as string;
    await ctx.answerCallbackQuery();
    const lesson = await repo.getLesson(lessonId);
    if (!lesson || !isOpen(lesson.status)) {
      await ctx.reply('Это занятие уже закрыто.');
      return;
    }
    await repo.setState('await', { kind: 'reschedule', lessonId } satisfies AwaitState, 60);
    await closeButtons(ctx);
    await ctx.reply(
      `На когда перенесли занятие ${fmtShort(lessonStart(lesson, cfg.TIME_ZONE))}? Переносится только это занятие, регулярное расписание не меняется.\nНапример: «чт 18:00», «завтра в 17», «5.11 16:40». /cancel — отмена.`,
    );
  });

  bot.callbackQuery(/^pay:(\d{1,3})$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await closeButtons(ctx);
    await sendReply(ctx, await performAction({ type: 'payment', lessons: Number(ctx.match[1]), amount: null }));
  });

  bot.callbackQuery('pay:snooze', async (ctx) => {
    const tomorrow = nowIn(cfg.TIME_ZONE).plus({ days: 1 }).startOf('day').set({ hour: cfg.PAY_REMIND_HOUR });
    await repo.setState('pay_snooze_until', tomorrow.toISO());
    await ctx.answerCallbackQuery({ text: 'Напомню завтра' });
    await closeButtons(ctx);
  });

  // ---------- Расписание ----------

  bot.callbackQuery(/^sch:n:([1-7])$/, async (ctx) => {
    const total = Number(ctx.match[1]);
    await ctx.answerCallbackQuery();
    await closeButtons(ctx);
    await repo.setState('await', { kind: 'slots', total, specs: [] } satisfies AwaitState, 60);
    await ctx.reply(views.slotPrompt(1, total, cfg.DEFAULT_DURATION_MIN));
  });

  bot.callbackQuery('sch:new', async (ctx) => {
    await ctx.answerCallbackQuery();
    await closeButtons(ctx);
    await ctx.reply('Сколько занятий в неделю?', { reply_markup: views.slotsCountKeyboard() });
  });

  bot.callbackQuery('sch:add', async (ctx) => {
    await ctx.answerCallbackQuery();
    await closeButtons(ctx);
    await repo.setState('await', { kind: 'slot', slotId: null } satisfies AwaitState, 60);
    await ctx.reply(views.slotPrompt(1, 1, cfg.DEFAULT_DURATION_MIN));
  });

  bot.callbackQuery(/^sch:e:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const slot = (await repo.getActiveSlots()).find((s) => s.id === Number(ctx.match[1]));
    if (!slot) {
      await ctx.reply('Расписание уже изменилось — открой /schedule заново.');
      return;
    }
    await closeButtons(ctx);
    await repo.setState('await', { kind: 'slot', slotId: slot.id } satisfies AwaitState, 60);
    await ctx.reply(
      [
        `Меняем регулярное занятие «${views.slotLabel(slot)}» на все будущие недели.`,
        'Новый день и время? Например «вт 16:40» или «вт 18:00 90». /cancel — отмена.',
        '',
        views.ONE_OFF_HINT,
      ].join('\n'),
    );
  });

  bot.callbackQuery(/^sch:d:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const slots = await repo.getActiveSlots();
    const slot = slots.find((s) => s.id === Number(ctx.match[1]));
    if (!slot) {
      await ctx.reply('Расписание уже изменилось — открой /schedule заново.');
      return;
    }
    await closeButtons(ctx);
    await proposeSchedule(
      ctx,
      slots.filter((s) => s.id !== slot.id).map(slotToSpec),
      `убрать: ${views.slotLabel(slot)}`,
      'Занятие убрано из расписания.',
    );
  });

  bot.callbackQuery(/^sch:(ok|no)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await closeButtons(ctx);
    const pending = await repo.getState<PendingSchedule>('pending_schedule');
    await repo.deleteState('pending_schedule');
    if (ctx.match[1] === 'no') {
      await ctx.reply('Ок, расписание не меняю.');
      return;
    }
    if (!pending) {
      await ctx.reply('Подтверждение устарело — открой /schedule заново.');
      return;
    }
    await saveSchedule(ctx, pending.specs, pending.head);
  });

  bot.callbackQuery(/^undo:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const res = await svc.undo(Number(ctx.match[1]));
    await closeButtons(ctx);
    await ctx.reply(res ? `↩️ Отменил: ${res.summary}.` : 'Это действие уже отменено.');
  });

  bot.callbackQuery(/^int:(ok|no):([A-Za-z0-9_-]{6,32})$/, async (ctx) => {
    const [, answer, token] = ctx.match as RegExpMatchArray as [string, 'ok' | 'no', string];
    await ctx.answerCallbackQuery();
    const key = `intent:${token}`;
    const action = await repo.getState<ResolvedAction>(key);
    await repo.deleteState(key);
    await closeButtons(ctx);
    if (answer === 'no') {
      await ctx.reply('Ок, ничего не меняю. Можно сформулировать иначе или воспользоваться командами — /help.');
      return;
    }
    if (!action) {
      await ctx.reply('Подтверждение устарело, повтори, пожалуйста.');
      return;
    }
    await sendReply(ctx, await performAction(action));
  });

  // ---------- Свободный текст ----------

  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) {
      await ctx.reply('Не знаю такой команды. /help');
      return;
    }
    const now = nowIn(cfg.TIME_ZONE);

    // 1. Ждём конкретный ответ (время переноса или сумму оплаты)
    const awaiting = await repo.getState<AwaitState>('await');
    if (awaiting?.kind === 'reschedule') {
      const handled = await handleRescheduleAnswer(ctx, awaiting.lessonId, text, now);
      if (handled) return;
    }
    if (awaiting?.kind === 'slots' || awaiting?.kind === 'slot') {
      await handleSlotAnswer(ctx, awaiting, text);
      return;
    }
    if (awaiting?.kind === 'amount') {
      const amount = Number(
        text
          .replace(/\s/g, '')
          .replace(',', '.')
          .replace(/(₽|р|руб\.?|рублей)$/i, ''),
      );
      if (Number.isFinite(amount) && amount >= 0) {
        await repo.deleteState('await');
        await repo.updateRow('payments', awaiting.paymentId, { amount });
        await ctx.reply(`Сумма сохранена: ${amount} ₽.`);
        return;
      }
      await repo.deleteState('await');
    }

    // 2. Простые фразы — без модели и сразу (с кнопкой «отменить»)
    const rule = parseByRules(text, { now, packSize: cfg.PACK_SIZE });
    if (rule) {
      await handleIntent(ctx, rule, { confirm: false });
      return;
    }

    // 3. Всё остальное — модель, с подтверждением изменений
    if (!isLlmConfigured()) {
      await ctx.reply('Не понял. Без подключённой модели я понимаю только простые фразы и команды — /help.');
      return;
    }
    await ctx.replyWithChatAction('typing');
    await handleIntent(ctx, text, { confirm: true });
  });

  bot.catch(async (err) => {
    console.error('Bot error', err.error);
    const isTelegramNoise =
      err.error instanceof GrammyError && /message is not modified|query is too old/.test(err.error.description);
    if (isTelegramNoise) return;
    try {
      await err.ctx.reply('Что-то пошло не так 😕 Попробуй ещё раз или используй команду из /help.');
    } catch {
      // ignore
    }
  });

  instance = bot;
  return bot;
}

// ---------- Вспомогательное ----------

async function sendReply(ctx: Context, reply: Reply): Promise<void> {
  await ctx.reply(reply.text, reply.keyboard ? { reply_markup: reply.keyboard } : {});
}

/** Убирает кнопки у сообщения, на которое нажали, чтобы не нажать дважды. */
async function closeButtons(ctx: Context): Promise<void> {
  try {
    await ctx.editMessageReplyMarkup({ reply_markup: undefined });
  } catch {
    // сообщение слишком старое или уже без кнопок
  }
}

async function statusReply(): Promise<Reply> {
  const cfg = config();
  await svc.materializeSchedule(nowIn(cfg.TIME_ZONE));
  const snap = await svc.loadSnapshot();
  const needPay = snap.balance.upcoming.length > 0 && snap.balance.paidAhead <= cfg.PAY_REMIND_THRESHOLD;
  return {
    text: views.statusText(snap.balance, snap.zone, snap.now),
    keyboard: needPay ? views.paymentKeyboard(cfg.PACK_SIZE) : undefined,
  };
}

const SET_BALANCE_HINT =
  'Теперь скажи, сколько оплаченных занятий у тебя сейчас осталось: /setbalance 3 (или «осталось 3 оплаченных»).';

async function scheduleReply(): Promise<Reply> {
  const cfg = config();
  const [slots, pauses] = await Promise.all([
    repo.getActiveSlots(),
    repo.getPauses(nowIn(cfg.TIME_ZONE).toISODate() as string),
  ]);
  return { text: views.scheduleText(slots, pauses), keyboard: views.scheduleKeyboard(slots) };
}

/** Сохраняет расписание целиком и показывает результат; при первой настройке — подсказка про остаток. */
async function saveSchedule(ctx: Context, specs: SlotSpec[], head = 'Расписание сохранено.'): Promise<void> {
  const cfg = config();
  const res = await svc.applySchedule(specs, nowIn(cfg.TIME_ZONE));
  const changes = [res.created ? `создано занятий: ${res.created}` : '', res.removed ? `убрано: ${res.removed}` : '']
    .filter(Boolean)
    .join(', ');
  const schedule = await scheduleReply();
  await sendReply(ctx, { ...schedule, text: `✅ ${head}${changes ? ` Вперёд ${changes}.` : ''}\n\n${schedule.text}` });
  const totals = await repo.getBalanceTotals();
  if (specs.length > 0 && totals.credits === 0 && totals.used === 0) await ctx.reply(SET_BALANCE_HINT);
}

/** Первая настройка сохраняется сразу; замена существующего расписания — только после подтверждения. */
async function saveOrProposeSchedule(ctx: Context, specs: SlotSpec[]): Promise<void> {
  const current = await repo.getActiveSlots();
  if (current.length === 0) {
    await saveSchedule(ctx, specs);
    return;
  }
  const list = (labels: string[]) => labels.join('; ') || 'пусто';
  await proposeSchedule(
    ctx,
    specs,
    `было: ${list(current.map((s) => views.slotLabel(s)))}\nстанет: ${list(specs.map((s) => views.slotLabel(specToSlot(s))))}`,
    'Расписание сохранено.',
  );
}

/** Показывает, что изменится в будущих занятиях, и ждёт «Да, изменить расписание». */
async function proposeSchedule(ctx: Context, specs: SlotSpec[], change: string, head: string): Promise<void> {
  const cfg = config();
  const preview = await svc.previewSchedule(specs, nowIn(cfg.TIME_ZONE));
  await repo.setState('pending_schedule', { specs, head } satisfies PendingSchedule, 30);
  await ctx.reply(views.scheduleChangeText(change, preview.removed, preview.added.length, cfg.TIME_ZONE), {
    reply_markup: views.scheduleConfirmKeyboard(),
  });
}

/** Ответ «пн 16:40» при пошаговом вводе расписания или изменении одного слота. */
async function handleSlotAnswer(
  ctx: Context,
  awaiting: Extract<AwaitState, { kind: 'slots' | 'slot' }>,
  text: string,
): Promise<void> {
  const cfg = config();
  const spec = parseSlotSpec(text, cfg.DEFAULT_DURATION_MIN);
  if (!spec) {
    await ctx.reply('Не понял. Нужны день недели и время: «пн 16:40» или «вт 18:00 90». /cancel — отмена.');
    return;
  }

  if (awaiting.kind === 'slots') {
    if (awaiting.specs.some((s) => sameSlotTime(s, spec))) {
      await ctx.reply('Это занятие уже есть в списке — введи другое время.');
      return;
    }
    const specs = [...awaiting.specs, spec];
    if (specs.length < awaiting.total) {
      await repo.setState('await', { ...awaiting, specs } satisfies AwaitState, 60);
      await ctx.reply(views.slotPrompt(specs.length + 1, awaiting.total, cfg.DEFAULT_DURATION_MIN));
      return;
    }
    await repo.deleteState('await');
    await saveOrProposeSchedule(ctx, specs);
    return;
  }

  const slots = await repo.getActiveSlots();
  const others = slots.filter((s) => s.id !== awaiting.slotId).map(slotToSpec);
  if (awaiting.slotId !== null && others.length === slots.length) {
    await repo.deleteState('await');
    await ctx.reply('Расписание уже изменилось — открой /schedule заново.');
    return;
  }
  if (others.some((s) => sameSlotTime(s, spec))) {
    await ctx.reply('В это время уже есть занятие — введи другое. /cancel — отмена.');
    return;
  }
  await repo.deleteState('await');
  const edited = slots.find((s) => s.id === awaiting.slotId);
  const next = views.slotLabel(specToSlot(spec));
  await proposeSchedule(
    ctx,
    [...others, spec],
    edited ? `${views.slotLabel(edited)} → ${next}` : `добавить: ${next}`,
    edited ? 'Регулярное занятие изменено.' : 'Занятие добавлено в расписание.',
  );
}

async function statsReply(): Promise<string> {
  const cfg = config();
  const since = nowIn(cfg.TIME_ZONE).minus({ months: 12 }).startOf('month').toUTC().toISO() as string;
  const [lessons, payments] = await Promise.all([repo.getAllLessonsSince(since), repo.getPaymentsSince(since)]);
  return views.statsText(buildMonthStats(lessons, payments, cfg.TIME_ZONE));
}

async function handleRescheduleAnswer(ctx: Context, lessonId: string, text: string, now: DateTime): Promise<boolean> {
  const cfg = config();
  const lesson = await repo.getLesson(lessonId);
  if (!lesson || !isOpen(lesson.status)) {
    await repo.deleteState('await');
    return false;
  }
  const original = lessonStart(lesson, cfg.TIME_ZONE);
  const when = parseDateTime(text, now, { defaultTime: { hour: original.hour, minute: original.minute } });
  if (!when) {
    await ctx.reply('Не понял время. Например: «чт 18:00», «завтра в 17», «5.11 16:40». /cancel — отмена.');
    return true;
  }
  await repo.deleteState('await');
  await sendReply(ctx, await performAction({ type: 'reschedule', lessonId, newStart: when.toISO() as string }));
  return true;
}

async function handleIntent(ctx: Context, input: Intent | string, opts: { confirm: boolean }): Promise<void> {
  const cfg = config();
  const snap = await svc.loadSnapshot();
  const open = [...snap.balance.pendingPast, ...snap.balance.upcoming];
  // Для модели — занятия рядом с сегодняшним днём, кроме перенесённых-закрытых
  const refs = buildRefs(
    snap.nearby.filter((l) => {
      const start = lessonStart(l, snap.zone);
      return l.status !== 'rescheduled' && start > snap.now.minus({ days: 7 }) && start < snap.now.plus({ days: 15 });
    }),
  );

  let intent: Intent;
  if (typeof input === 'string') {
    try {
      intent = await parseIntentWithLlm(input, {
        now: snap.now,
        zone: snap.zone,
        packSize: cfg.PACK_SIZE,
        remaining: snap.balance.remaining,
        refs,
      });
    } catch (error) {
      console.error('LLM parse failed', error);
      const why = error instanceof LlmUnavailableError ? 'модель сейчас недоступна' : 'не смог разобрать фразу';
      await ctx.reply(
        `Не понял: ${why}. Попробуй проще («было», «перенесли на чт 18:00», «оплатил 4») или командой — /help.`,
      );
      return;
    }
  } else {
    intent = input;
  }

  if (intent.type === 'chat') {
    await ctx.reply(intent.reply);
    return;
  }
  if (intent.type === 'query') {
    if (intent.what === 'status') await sendReply(ctx, await statusReply());
    if (intent.what === 'history') {
      const [lessons, payments] = await Promise.all([repo.getRecentResolvedLessons(12), repo.getRecentPayments(6)]);
      await ctx.reply(views.historyText(lessons, payments, cfg.TIME_ZONE));
    }
    if (intent.what === 'stats') await ctx.reply(await statsReply());
    if (intent.what === 'schedule') await sendReply(ctx, await scheduleReply());
    return;
  }

  const resolved = resolveIntent(intent, {
    now: snap.now,
    zone: snap.zone,
    open,
    refs,
    defaultDuration: cfg.DEFAULT_DURATION_MIN,
  });
  if (resolved === null) {
    await ctx.reply('Не понял, что сделать. /help');
    return;
  }
  if (typeof resolved === 'string') {
    await ctx.reply(resolved);
    return;
  }

  if (opts.confirm && MUTATING_INTENTS.has(intent.type)) {
    const token = randomBytes(9).toString('base64url');
    await repo.setState(`intent:${token}`, resolved, 30);
    await ctx.reply(`Понял так:\n${await describeAction(resolved)}\n\nВерно?`, {
      reply_markup: views.confirmKeyboard(token),
    });
    return;
  }

  await sendReply(ctx, await performAction(resolved));
}
