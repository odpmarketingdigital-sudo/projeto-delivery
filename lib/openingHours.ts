import type { OpeningHours, OpeningHoursDay } from "@/lib/types";

/**
 * Fuso horário usado na comparação de horários. O servidor roda em UTC, então
 * dia/hora são convertidos para o horário de Brasília antes da comparação.
 */
export const STORE_TIME_ZONE = "America/Sao_Paulo";

/** Dia da semana com metadados de exibição (0 = domingo, 6 = sábado). */
export interface WeekdayInfo {
  /** Chave usada no jsonb (`"0"`..`"6"`). */
  key: string;
  index: number;
  label: string;
  short: string;
}

export const WEEKDAYS: readonly WeekdayInfo[] = [
  { key: "0", index: 0, label: "Domingo", short: "Dom" },
  { key: "1", index: 1, label: "Segunda-feira", short: "Seg" },
  { key: "2", index: 2, label: "Terça-feira", short: "Ter" },
  { key: "3", index: 3, label: "Quarta-feira", short: "Qua" },
  { key: "4", index: 4, label: "Quinta-feira", short: "Qui" },
  { key: "5", index: 5, label: "Sexta-feira", short: "Sex" },
  { key: "6", index: 6, label: "Sábado", short: "Sáb" },
];

export const DEFAULT_OPEN_TIME = "08:00";
export const DEFAULT_CLOSE_TIME = "18:00";

/** Formato aceito para os horários (00:00 até 23:59). */
const TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

type RecordLike = Record<string, unknown>;

function isRecord(value: unknown): value is RecordLike {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultDay(enabled: boolean): OpeningHoursDay {
  return {
    enabled,
    open_time: DEFAULT_OPEN_TIME,
    close_time: DEFAULT_CLOSE_TIME,
  };
}

/**
 * Cria a estrutura completa (7 dias) usada como valor inicial no formulário.
 * Por padrão todos os dias começam ativos, com 08:00–18:00.
 */
export function createDefaultOpeningHours(enabled = true): OpeningHours {
  return Object.fromEntries(
    WEEKDAYS.map((day) => [day.key, defaultDay(enabled)])
  ) as OpeningHours;
}

/**
 * Normaliza o jsonb vindo do banco para `OpeningHours` (tolerante a dados
 * legados/inválidos). Retorna `{}` quando não há nenhum dia válido.
 */
export function normalizeOpeningHours(value: unknown): OpeningHours {
  if (!isRecord(value)) return {};

  const result: OpeningHours = {};
  for (const day of WEEKDAYS) {
    const raw = value[day.key];
    if (!isRecord(raw)) continue;

    const openTime =
      typeof raw.open_time === "string" && TIME_REGEX.test(raw.open_time)
        ? raw.open_time
        : DEFAULT_OPEN_TIME;
    const closeTime =
      typeof raw.close_time === "string" && TIME_REGEX.test(raw.close_time)
        ? raw.close_time
        : DEFAULT_CLOSE_TIME;

    result[day.key] = {
      enabled: raw.enabled === true,
      open_time: openTime,
      close_time: closeTime,
    };
  }
  return result;
}

/**
 * Preenche os 7 dias para edição no painel. Se a loja ainda não tem horários,
 * parte de todos os dias ativos (08:00–18:00).
 */
export function toEditableOpeningHours(value: unknown): OpeningHours {
  const normalized = normalizeOpeningHours(value);
  const hasConfig = Object.keys(normalized).length > 0;

  return Object.fromEntries(
    WEEKDAYS.map((day) => [
      day.key,
      normalized[day.key] ?? defaultDay(!hasConfig),
    ])
  ) as OpeningHours;
}

export type OpeningHoursParseResult =
  | { ok: true; value: OpeningHours }
  | { ok: false; error: string };

/**
 * Valida o payload recebido pelo `PUT /api/establishment`. Diferente de
 * `normalizeOpeningHours`, rejeita valores inválidos em vez de silenciá-los.
 */
export function parseOpeningHours(value: unknown): OpeningHoursParseResult {
  if (!isRecord(value)) {
    return {
      ok: false,
      error: "opening_hours deve ser um objeto com os dias da semana (0 a 6).",
    };
  }

  const result: OpeningHours = {};
  for (const day of WEEKDAYS) {
    const raw = value[day.key];

    // Dias não enviados ficam desativados (com horários padrão).
    if (raw === undefined) {
      result[day.key] = defaultDay(false);
      continue;
    }
    if (!isRecord(raw)) {
      return { ok: false, error: `Horário inválido para ${day.label}.` };
    }
    if (typeof raw.enabled !== "boolean") {
      return {
        ok: false,
        error: `Informe "enabled" (true/false) para ${day.label}.`,
      };
    }

    const openValid =
      typeof raw.open_time === "string" && TIME_REGEX.test(raw.open_time);
    const closeValid =
      typeof raw.close_time === "string" && TIME_REGEX.test(raw.close_time);

    // Dias desativados não exigem horários válidos (o formulário pode enviar
    // campos vazios ao desmarcar o dia). Preenche com o padrão.
    if (!raw.enabled) {
      result[day.key] = {
        enabled: false,
        open_time: openValid ? (raw.open_time as string) : DEFAULT_OPEN_TIME,
        close_time: closeValid
          ? (raw.close_time as string)
          : DEFAULT_CLOSE_TIME,
      };
      continue;
    }

    if (!openValid) {
      return {
        ok: false,
        error: `Horário de abertura inválido para ${day.label} (use HH:mm).`,
      };
    }
    if (!closeValid) {
      return {
        ok: false,
        error: `Horário de fechamento inválido para ${day.label} (use HH:mm).`,
      };
    }

    result[day.key] = {
      enabled: true,
      open_time: raw.open_time as string,
      close_time: raw.close_time as string,
    };
  }

  return { ok: true, value: result };
}

/** Converte "HH:mm" em minutos desde 00:00. Retorna 0 para valores inválidos. */
export function timeToMinutes(time: string): number {
  if (!TIME_REGEX.test(time)) return 0;
  const [hour, minute] = time.split(":").map(Number);
  return hour * 60 + minute;
}

/** Data/hora atual convertida para o fuso da loja. */
export interface ZonedNow {
  dayIndex: number;
  minutes: number;
  time: string;
}

const SHORT_WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** Converte um instante para dia da semana + minutos no fuso informado. */
export function getZonedNow(
  now: Date = new Date(),
  timeZone: string = STORE_TIME_ZONE
): ZonedNow {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);

  const get = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "";

  const weekday = get("weekday");
  const hour = Number(get("hour")) || 0;
  const minute = Number(get("minute")) || 0;

  return {
    dayIndex: SHORT_WEEKDAY_INDEX[weekday] ?? 0,
    minutes: hour * 60 + minute,
    time: `${pad2(hour)}:${pad2(minute)}`,
  };
}

/** Verifica se o instante está dentro do intervalo do próprio dia. */
function isOpenAt(day: OpeningHoursDay | null, minutes: number): boolean {
  if (!day?.enabled) return false;

  const open = timeToMinutes(day.open_time);
  const close = timeToMinutes(day.close_time);

  // Abertura e fechamento iguais = funcionamento 24h nesse dia.
  if (open === close) return true;
  // Intervalo normal (ex.: 08:00–18:00).
  if (open < close) return minutes >= open && minutes < close;
  // Virada de noite (ex.: 18:00–02:00): aberto a partir da abertura.
  return minutes >= open;
}

/** Verifica se o expediente de ontem (com virada de noite) ainda está ativo. */
function isOvernightCarryover(
  day: OpeningHoursDay | null,
  minutes: number
): boolean {
  if (!day?.enabled) return false;

  const open = timeToMinutes(day.open_time);
  const close = timeToMinutes(day.close_time);

  return open > close && minutes < close;
}

/** Próxima abertura calculada a partir do instante atual. */
export interface NextOpening {
  dayIndex: number;
  dayLabel: string;
  time: string;
  /** 0 = hoje, 1 = amanhã, etc. */
  daysAhead: number;
}

export interface StoreOpenStatus {
  /** false = loja fechada no momento. */
  isOpen: boolean;
  /**
   * false = nenhum horário cadastrado. Nesse caso a loja é considerada aberta
   * (comportamento legado, antes da funcionalidade de horários).
   */
  configured: boolean;
  /** Dia da semana atual no fuso da loja (0 = domingo). */
  currentDayIndex: number;
  /** Hora atual no fuso da loja ("HH:mm"). */
  currentTime: string;
  /** Próxima abertura quando `isOpen` é false. */
  nextOpening: NextOpening | null;
}

function findNextOpening(
  hours: OpeningHours,
  currentDayIndex: number,
  currentMinutes: number
): NextOpening | null {
  for (let offset = 0; offset <= 7; offset += 1) {
    const dayIndex = (currentDayIndex + offset) % 7;
    const day = hours[String(dayIndex)];
    if (!day?.enabled) continue;

    const open = timeToMinutes(day.open_time);
    // Hoje, mas a abertura já passou: procura no próximo ciclo.
    if (offset === 0 && currentMinutes >= open) continue;

    return {
      dayIndex,
      dayLabel: WEEKDAYS[dayIndex]?.label ?? "",
      time: day.open_time,
      daysAhead: offset,
    };
  }
  return null;
}

/**
 * Informa se a loja está aberta no instante informado.
 *
 * Regras:
 *  - Sem horários cadastrados (`{}`/inválido): a loja é considerada ABERTA.
 *  - `close_time` menor que `open_time` cobre a madrugada do dia seguinte.
 *  - `open_time === close_time` significa 24h naquele dia.
 */
export function isStoreOpen(
  openingHours: unknown,
  now: Date = new Date(),
  timeZone: string = STORE_TIME_ZONE
): StoreOpenStatus {
  const hours = normalizeOpeningHours(openingHours);
  const configured = Object.keys(hours).length > 0;
  const zoned = getZonedNow(now, timeZone);

  const today = hours[String(zoned.dayIndex)] ?? null;
  const yesterday = hours[String((zoned.dayIndex + 6) % 7)] ?? null;

  const isOpen = configured
    ? isOpenAt(today, zoned.minutes) ||
      isOvernightCarryover(yesterday, zoned.minutes)
    : true;

  return {
    isOpen,
    configured,
    currentDayIndex: zoned.dayIndex,
    currentTime: zoned.time,
    nextOpening:
      configured && !isOpen
        ? findNextOpening(hours, zoned.dayIndex, zoned.minutes)
        : null,
  };
}

/**
 * Texto curto para exibir a próxima abertura:
 * "hoje às 18:00", "amanhã às 08:00" ou "segunda-feira às 08:00".
 */
export function describeNextOpening(next: NextOpening | null): string | null {
  if (!next) return null;
  if (next.daysAhead === 0) return `hoje às ${next.time}`;
  if (next.daysAhead === 1) return `amanhã às ${next.time}`;
  return `${next.dayLabel.toLowerCase()} às ${next.time}`;
}

