export type LessonStatus = 'planned' | 'confirmed' | 'done' | 'cancelled' | 'burned' | 'rescheduled';

/** Статусы, при которых занятие списывается из оплаченных. */
export const CHARGED_STATUSES: readonly LessonStatus[] = ['done', 'burned'];
/** Статусы, при которых занятие ещё не закрыто. */
export const OPEN_STATUSES: readonly LessonStatus[] = ['planned', 'confirmed'];

export interface Lesson {
  id: string;
  starts_at: string;
  duration_min: number;
  status: LessonStatus;
  slot_key: string | null;
  rescheduled_from: string | null;
  note: string | null;
  resolved_at: string | null;
  /** Когда отмечено «ДЗ сделано»; null — напоминать о домашке. */
  homework_done_at: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface Payment {
  id: string;
  paid_at: string;
  lessons: number;
  amount: number | null;
  kind: 'payment' | 'adjustment';
  note: string | null;
  created_at?: string;
}

export interface Slot {
  id: number;
  weekday: number;
  /** 'HH:MM:SS' как возвращает Postgres time. */
  start_time: string;
  duration_min: number;
  active: boolean;
}

export interface Pause {
  id: number;
  starts_on: string;
  ends_on: string;
  note: string | null;
}

export type Entity = 'lessons' | 'payments' | 'pauses';

/** Одна операция в журнале: before = null — вставка, after = null — удаление. */
export interface LoggedOp {
  entity: Entity;
  id: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

export interface ActionLogEntry {
  id: number;
  created_at: string;
  kind: string;
  summary: string;
  ops: LoggedOp[];
  undone_at: string | null;
}

export const isCharged = (s: LessonStatus): boolean => CHARGED_STATUSES.includes(s);
export const isOpen = (s: LessonStatus): boolean => OPEN_STATUSES.includes(s);
