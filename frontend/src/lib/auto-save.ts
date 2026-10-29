/**
 * Debounced auto-save gate (phase B).
 *
 * Auto-save is intentionally disabled by default: the base contract is
 * "manual save + recovery drafts". When enabled in settings, each dirty
 * document with a path is written after `delayMs` of quiet, using the
 * stamp-checked save transaction so an external edit can never be overwritten
 * silently.
 *
 * This class owns only timer/gating policy. It does not perform IO, so it can
 * be driven with a fake clock in headless tests. `schedule()` is a no-op while
 * disabled, which is what enforces the "false means drafts only" contract.
 */

export interface AutoSaveTimers {
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const browserAutoSaveTimers: AutoSaveTimers = {
  setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimeout: (handle) => {
    globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export interface AutoSaveConfig {
  enabled: boolean;
  delayMs: number;
}

export class AutoSaver {
  private enabled = false;
  private delayMs: number;
  private readonly timers: AutoSaveTimers;
  private readonly pending = new Map<string, unknown>();

  constructor(
    config: AutoSaveConfig = { enabled: false, delayMs: 5000 },
    timers: AutoSaveTimers = browserAutoSaveTimers,
  ) {
    this.delayMs = Math.max(0, config.delayMs);
    this.enabled = config.enabled;
    this.timers = timers;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  get delay(): number {
    return this.delayMs;
  }

  /** Apply live settings changes; disabling immediately cancels pending saves. */
  configure(config: AutoSaveConfig): void {
    this.enabled = config.enabled;
    this.delayMs = Math.max(0, config.delayMs);
    if (!this.enabled) this.cancelAll();
  }

  /**
   * Arm (or re-arm) the auto-save timer for one document. Returns false when
   * auto-save is off or the document has no stable id to key the timer on.
   */
  schedule(id: string, save: () => void | Promise<void>): boolean {
    if (!this.enabled || !id) return false;
    this.cancel(id);
    const handle = this.timers.setTimeout(() => {
      this.pending.delete(id);
      try {
        void save();
      } catch (error) {
        console.error("auto-save callback failed:", error);
      }
    }, this.delayMs);
    this.pending.set(id, handle);
    return true;
  }

  cancel(id: string): void {
    const handle = this.pending.get(id);
    if (handle === undefined) return;
    this.timers.clearTimeout(handle);
    this.pending.delete(id);
  }

  cancelAll(): void {
    for (const id of [...this.pending.keys()]) this.cancel(id);
  }

  isPending(id: string): boolean {
    return this.pending.has(id);
  }
}
