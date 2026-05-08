import { z } from "zod";

export const IanaTimezoneLikeSchema = z.string().min(1).describe("IANA timezone identifier, for example Asia/Shanghai or UTC");

const UtcTimestampMillisSchema = z.string().regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
  "expected UTC timestamp in YYYY-MM-DDTHH:mm:ss.SSSZ format"
);
const LocalTimestampWithOffsetSchema = z.string().regex(
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/,
  "expected local timestamp in YYYY-MM-DDTHH:mm:ss±HH:MM format"
);
const LocalDateSchema = z.string().regex(
  /^\d{4}-\d{2}-\d{2}$/,
  "expected local date in YYYY-MM-DD format"
);
const LocalTimeSchema = z.string().regex(
  /^\d{2}:\d{2}$/,
  "expected local time in HH:MM format"
);

export const CurrentTurnTimeTimezoneSourceSchema = z.enum(["owner_preference", "server_default"]);
export const CurrentTurnTimeWeekdaySchema = z.enum(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
export const CurrentTurnTimeDayPartSchema = z.enum(["early_morning", "morning", "afternoon", "evening", "night"]);
export const CurrentTurnTimeGapKindSchema = z.enum(["first_turn", "same_day", "overnight", "multi_day"]);
export const CurrentTurnTimeContextSchema = z.object({
  timezone: IanaTimezoneLikeSchema,
  timezoneSource: CurrentTurnTimeTimezoneSourceSchema,
  nowUtc: UtcTimestampMillisSchema,
  localNow: LocalTimestampWithOffsetSchema,
  localDate: LocalDateSchema,
  localTime: LocalTimeSchema,
  weekday: CurrentTurnTimeWeekdaySchema,
  dayPart: CurrentTurnTimeDayPartSchema,
  previousInteractionAtUtc: UtcTimestampMillisSchema.optional(),
  previousInteractionLocal: LocalTimestampWithOffsetSchema.optional(),
  elapsedSincePreviousInteractionMinutes: z.number().int().nonnegative().optional(),
  calendarDayDelta: z.number().int().nonnegative().optional(),
  gapKind: CurrentTurnTimeGapKindSchema,
  summary: z.string()
});

export type CurrentTurnTimeTimezoneSource = z.infer<typeof CurrentTurnTimeTimezoneSourceSchema>;
export type CurrentTurnTimeWeekday = z.infer<typeof CurrentTurnTimeWeekdaySchema>;
export type CurrentTurnTimeDayPart = z.infer<typeof CurrentTurnTimeDayPartSchema>;
export type CurrentTurnTimeGapKind = z.infer<typeof CurrentTurnTimeGapKindSchema>;
export type CurrentTurnTimeContext = z.infer<typeof CurrentTurnTimeContextSchema>;
