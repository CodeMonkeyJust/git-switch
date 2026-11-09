export type LogLevel = 'info' | 'ok' | 'warn' | 'error' | 'dim';

const COLORS: Record<LogLevel, string> = {
  info: '\u001b[36m',
  ok: '\u001b[32m',
  warn: '\u001b[33m',
  error: '\u001b[31m',
  dim: '\u001b[2m',
};
const RESET = '\u001b[0m';

export interface LoggerOptions {
  json?: boolean;
  color?: boolean;
  stream?: NodeJS.WriteStream;
  /** Send every level to `stream` so a report never interleaves with stderr. */
  unifiedErrors?: boolean;
}

export interface Logger {
  info(message: string): void;
  ok(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  dim(message: string): void;
  json(value: unknown): void;
  /**
   * Raw output (diff bodies, tables) on the same stream as the other levels.
   * Commands must not write to process.stdout directly: that bypasses the
   * injected stream, breaks `--json` parsing and makes output untestable.
   */
  write(text: string): void;
  readonly isJson: boolean;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const isJson = options.json === true;
  const stream = options.stream ?? process.stdout;
  const errStream = process.stderr;
  const color = options.color ?? (process.stdout.isTTY === true && !isJson);
  // report streams want a single ordered stream; errors-only mode keeps stderr
  const unified = options.unifiedErrors === true;

  const paint = (level: LogLevel, text: string) => (color ? `${COLORS[level]}${text}${RESET}` : text);
  const prefix: Record<LogLevel, string> = {
    info: 'i',
    ok: '✓',
    warn: '!',
    error: '✗',
    dim: '·',
  };

  const emit = (level: LogLevel, message: string) => {
    if (isJson && level !== 'error') return;
    const target = level === 'error' && !unified ? errStream : stream;
    target.write(`${paint(level, prefix[level])} ${message}\n`);
  };

  return {
    isJson,
    info: (m) => emit('info', m),
    ok: (m) => emit('ok', m),
    warn: (m) => emit('warn', m),
    error: (m) => emit('error', m),
    dim: (m) => emit('dim', m),
    write: (text) => {
      if (isJson) return;
      stream.write(text);
    },
    json: (value: unknown) => {
      stream.write(`${JSON.stringify(value, null, 2)}\n`);
    },
  };
}
