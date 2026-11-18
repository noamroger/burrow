import { EventEmitter } from 'node:events';
import type { LogLevel, LogLine } from '@burrow/shared';

/**
 * Fixed-size ring buffer of log lines with monotonic sequence numbers.
 * Emits `line` for every pushed line (consumed by the SSE stream).
 */
export class LogBuffer extends EventEmitter<{ line: [LogLine] }> {
  private readonly lines: LogLine[] = [];
  private seq = 0;

  constructor(private readonly capacity = 2000) {
    super();
    this.setMaxListeners(0);
  }

  /** Append a line and return it with its sequence number. */
  push(entry: {
    level: LogLevel;
    message: string;
    source: LogLine['source'];
    time?: string;
  }): LogLine {
    const line: LogLine = {
      seq: ++this.seq,
      time: entry.time ?? new Date().toISOString(),
      level: entry.level,
      source: entry.source,
      message: entry.message,
    };
    this.lines.push(line);
    if (this.lines.length > this.capacity) this.lines.shift();
    this.emit('line', line);
    return line;
  }

  /** The most recent `limit` lines, oldest first. */
  recent(limit = 500): LogLine[] {
    return this.lines.slice(-Math.max(0, limit));
  }

  /** Lines with a sequence number greater than `seq` (for `Last-Event-ID` resume). */
  since(seq: number): LogLine[] {
    return this.lines.filter((l) => l.seq > seq);
  }

  get size(): number {
    return this.lines.length;
  }
}
