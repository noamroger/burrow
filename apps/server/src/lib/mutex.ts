/**
 * A minimal async mutex. Calls to {@link Mutex.run} execute one at a time,
 * in the order they were made.
 *
 * Burrow uses one around every tunnel configuration write, because the
 * Cloudflare endpoint replaces the whole document: two concurrent
 * read-modify-write cycles would lose an update.
 */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;

  /** Run `fn` once every previously queued call has settled. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    this.pending++;
    const result = this.tail.then(fn, fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result.finally(() => {
      this.pending--;
    });
  }

  /** True while a call is running or waiting. */
  get locked(): boolean {
    return this.pending > 0;
  }
}
