/**
 * A tiny typed event emitter that runs in Node and browsers. A listener that throws is reported on the console and
 * doesn't stop the others: one bad message handler shouldn't take the link down.
 */
export class Emitter<Events extends Record<string, unknown[]>> {
  private readonly listeners: { [K in keyof Events]?: Set<(...args: Events[K]) => void> } = {};
  /** Adds a listener; returns a function that removes it. */
  on<K extends keyof Events>(event: K, listener: (...args: Events[K]) => void): () => void {
    (this.listeners[event] ??= new Set()).add(listener);
    return () => this.off(event, listener);
  }
  off<K extends keyof Events>(event: K, listener: (...args: Events[K]) => void): void { this.listeners[event]?.delete(listener); }
  /** A listener for the next event only. */
  once<K extends keyof Events>(event: K, listener: (...args: Events[K]) => void): () => void {
    const off = this.on(event, (...args) => { off(); listener(...args); });
    return off;
  }
  protected emit<K extends keyof Events>(event: K, ...args: Events[K]): void {
    for (const listener of [...(this.listeners[event] ?? [])]) {
      try { listener(...args); } catch (error) { console.error(`Marionette: a ${String(event)} listener failed`, error); }
    }
  }
}
