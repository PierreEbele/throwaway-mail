type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

/** Structured JSON-lines logger. Never pass mail bodies or codes at info level. */
export function createLogger(level: Level = "info", base: Record<string, unknown> = {}, sink: (line: string) => void = (l) => process.stdout.write(l + "\n")): Logger {
  const min = ORDER[level];
  const write = (lvl: Level, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[lvl] < min) return;
    const rec: Record<string, unknown> = { time: new Date().toISOString(), level: lvl, msg, ...base, ...fields };
    if (rec.err instanceof Error) rec.err = { message: rec.err.message, stack: rec.err.stack };
    sink(JSON.stringify(rec));
  };
  return {
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
    child: (f) => createLogger(level, { ...base, ...f }, sink),
  };
}

export const silentLogger: Logger = createLogger("error", {}, () => {});
