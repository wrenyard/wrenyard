/**
 * Incremental SSE data reader shared by the Gateway's passive stream observers.
 * Handles arbitrary chunk fragmentation, CRLF, comments and multi-line data,
 * and hands each complete event's joined `data` payload to `onData`.
 */
export class SseDataReader {
  private buffer = '';
  private readonly dataLines: string[] = [];

  constructor(private readonly onData: (payload: string) => void) {}

  feed(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      this.consumeLine(line);
    }
  }

  /** Flushes a trailing unterminated line and an event left open without its blank separator. */
  end(): void {
    if (this.buffer) {
      const line = this.buffer;
      this.buffer = '';
      this.consumeLine(line);
    }
    this.flush();
  }

  private consumeLine(raw: string): void {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line === '') { this.flush(); return; }
    if (line.startsWith(':')) return;
    const field = /^data:\s?(.*)$/u.exec(line);
    if (field) this.dataLines.push(field[1]!);
  }

  private flush(): void {
    if (this.dataLines.length === 0) return;
    const payload = this.dataLines.join('\n');
    this.dataLines.length = 0;
    this.onData(payload);
  }
}
