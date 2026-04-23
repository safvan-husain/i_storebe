import { mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';

export type LogLevel = 'log' | 'error' | 'debug';

export type LogMeta = {
  requestId?: string;
  method?: string;
  pathname?: string;
  query?: string;
  status?: number;
  durationMs?: number;
  errorMessage?: string;
  errorStack?: string;
  details?: unknown;
  [key: string]: unknown;
};

export type LogEntry = LogMeta & {
  timestamp: string;
  level: LogLevel;
  message: string;
};

type FileLoggerOptions = {
  logDir?: string;
};

function sanitizeValue(value: unknown): unknown {
  if (value === undefined) {
    return undefined;
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }

  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, nestedValue]) => {
        const sanitized = sanitizeValue(nestedValue);
        return sanitized === undefined ? [] : [[key, sanitized]];
      }),
    );
  }

  return value;
}

function toLogLine(entry: LogEntry): string {
  return `${JSON.stringify(sanitizeValue(entry))}\n`;
}

export function createFileLogger(options: FileLoggerOptions = {}) {
  const logDir = options.logDir ?? process.env.LOG_DIR ?? path.join(process.cwd(), 'logs');
  const appLogPath = path.join(logDir, 'app.log');
  const errorLogPath = path.join(logDir, 'error.log');
  let writeQueue = Promise.resolve();

  async function appendEntry(filePath: string, line: string) {
    await mkdir(logDir, { recursive: true });
    await appendFile(filePath, line, 'utf8');
  }

  function enqueueWrite(task: () => Promise<void>) {
    writeQueue = writeQueue.catch(() => undefined).then(task);
    return writeQueue.catch((error) => {
      console.error('Failed to write log entry', error);
    });
  }

  async function write(level: LogLevel, message: string, meta: LogMeta = {}) {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      ...meta,
    };
    const line = toLogLine(entry);

    await enqueueWrite(async () => {
      await appendEntry(appLogPath, line);

      if (level === 'error') {
        await appendEntry(errorLogPath, line);
      }
    });
  }

  return {
    log(message: string, meta?: LogMeta) {
      return write('log', message, meta);
    },
    error(message: string, meta?: LogMeta) {
      return write('error', message, meta);
    },
    debug(message: string, meta?: LogMeta) {
      return write('debug', message, meta);
    },
    paths: {
      logDir,
      appLogPath,
      errorLogPath,
    },
  };
}

export const logger = createFileLogger();
