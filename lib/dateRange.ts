import { STORE_TIME_ZONE } from "@/lib/openingHours";

/**
 * Utilitários de data/período usados no painel (pedidos e dashboard).
 *
 * O banco grava `created_at` em UTC e a loja opera no horário de Brasília.
 * Como o Brasil não possui horário de verão desde 2019, usamos o offset fixo
 * `-03:00` para montar os limites de cada dia no fuso da loja.
 */
export const STORE_UTC_OFFSET = "-03:00";

export const MONTH_SHORT = [
  "Jan",
  "Fev",
  "Mar",
  "Abr",
  "Mai",
  "Jun",
  "Jul",
  "Ago",
  "Set",
  "Out",
  "Nov",
  "Dez",
] as const;

export interface DateRange {
  /** Início inclusivo em ISO/UTC (ex.: 2026-10-20T03:00:00.000Z). */
  startIso: string;
  /** Fim exclusivo em ISO/UTC. */
  endIso: string;
}

export interface ZonedDateParts {
  year: number;
  month: number;
  day: number;
  hour: number;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_RE = /^(\d{4})-(\d{2})$/;
const YEAR_RE = /^\d{4}$/;

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** Valida uma data no formato YYYY-MM-DD (incluindo dias existentes no mês). */
export function isValidDateValue(value: string): boolean {
  const match = DATE_RE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/** Valida um mês no formato YYYY-MM. */
export function isValidMonthValue(value: string): boolean {
  const match = MONTH_RE.exec(value);
  if (!match) return false;
  const month = Number(match[2]);
  return month >= 1 && month <= 12;
}

/** Valida um ano no formato YYYY. */
export function isValidYearValue(value: string): boolean {
  return YEAR_RE.test(value);
}

function zonedParts(
  date: Date,
  timeZone: string,
  includeHour: boolean
): ZonedDateParts {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...(includeHour ? { hour: "2-digit", hourCycle: "h23" } : {}),
  }).formatToParts(date);

  const get = (type: string) =>
    Number(parts.find((part) => part.type === type)?.value ?? 0);

  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: includeHour ? get("hour") : 0,
  };
}

/** Data atual no fuso da loja, no formato YYYY-MM-DD. */
export function todayDateValue(
  now: Date = new Date(),
  timeZone: string = STORE_TIME_ZONE
): string {
  const parts = zonedParts(now, timeZone, false);
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

/** Mês atual no fuso da loja, no formato YYYY-MM. */
export function currentMonthValue(
  now: Date = new Date(),
  timeZone: string = STORE_TIME_ZONE
): string {
  const parts = zonedParts(now, timeZone, false);
  return `${parts.year}-${pad2(parts.month)}`;
}

/** Ano atual no fuso da loja, no formato YYYY. */
export function currentYearValue(
  now: Date = new Date(),
  timeZone: string = STORE_TIME_ZONE
): string {
  return String(zonedParts(now, timeZone, false).year);
}

/** Limites [início, fim) de um dia no fuso da loja. */
export function dayRange(value: string): DateRange {
  const start = new Date(`${value}T00:00:00${STORE_UTC_OFFSET}`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

/** Limites [início, fim) de um mês no fuso da loja. */
export function monthRange(value: string): DateRange {
  const [year, month] = value.split("-").map(Number);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const start = new Date(
    `${year}-${pad2(month)}-01T00:00:00${STORE_UTC_OFFSET}`
  );
  const end = new Date(
    `${nextYear}-${pad2(nextMonth)}-01T00:00:00${STORE_UTC_OFFSET}`
  );
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

/** Limites [início, fim) de um ano no fuso da loja. */
export function yearRange(value: string): DateRange {
  const year = Number(value);
  const start = new Date(
    `${year}-01-01T00:00:00${STORE_UTC_OFFSET}`
  );
  const end = new Date(
    `${year + 1}-01-01T00:00:00${STORE_UTC_OFFSET}`
  );
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

/** Converte um timestamp ISO para as partes de data/hora no fuso da loja. */
export function getZonedDateParts(
  iso: string,
  timeZone: string = STORE_TIME_ZONE
): ZonedDateParts {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return { year: 0, month: 0, day: 0, hour: 0 };
  }
  return zonedParts(date, timeZone, true);
}

/** Quantidade de dias de um mês (month 1-12). */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Formata YYYY-MM-DD como DD/MM/YYYY (para exibição). */
export function formatDateBR(value: string): string {
  const match = DATE_RE.exec(value);
  if (!match) return value;
  return `${match[3]}/${match[2]}/${match[1]}`;
}
