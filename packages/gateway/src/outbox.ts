import { type GatewayDelivery, WebhookHttpStatusError } from "@clawler/contracts";

export interface WebhookOutboxHost {
  /** Oldest pending delivery with its serialized payload, or null when nothing is due. */
  nextPending(): { entry: GatewayDelivery; payload: string } | null;
  /** Persist an updated entry durably; a rejection halts the loop. */
  commit(entry: GatewayDelivery): Promise<void>;
  /** False once the queue is closing, has not started, or failed storage. */
  running(): boolean;
}

export interface WebhookOutboxOptions {
  fetch?: typeof fetch;
  /** Delay in ms before attempt N (1-based) after N-1 failures. Default exponential, capped at 5 min. */
  backoffMs?: (attempt: number) => number;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Reliable webhook delivery loop (outbox pattern). Attempt state is committed
 * before the request fires, so a crash never duplicates an in-flight attempt;
 * delivery is at-least-once across restarts.
 */
export class WebhookOutbox {
  private readonly fetchFn: typeof fetch;
  private readonly backoffMs: (attempt: number) => number;
  private loop: Promise<void> | undefined;
  private stopped = false;

  constructor(
    private readonly host: WebhookOutboxHost,
    options: WebhookOutboxOptions = {},
  ) {
    this.fetchFn = options.fetch ?? fetch;
    this.backoffMs =
      options.backoffMs ?? ((attempt: number) => Math.min(500 * 2 ** (attempt - 1), 300_000));
  }

  start(): void {
    if (this.loop || this.stopped) return;
    this.loop = this.run()
      .catch(() => undefined)
      .finally(() => {
        this.loop = undefined;
      });
  }

  private async run(): Promise<void> {
    let iter = 0;
    while (this.host.running()) {
      const next = this.host.nextPending();
      if (iter++ < 5) console.log("outbox iter", iter, "pending:", next?.entry.jobId ?? null);
      if (!next) {
        await sleep(200);
        continue;
      }
      const { entry, payload } = next;
      const dueIn = entry.lastAttemptedAt
        ? Date.parse(entry.lastAttemptedAt) + this.backoffMs(entry.attempts) - Date.now()
        : 0;
      if (dueIn > 0) {
        // Re-check every second so new entries and shutdown are not blocked by a long backoff.
        await sleep(Math.min(dueIn, 1000));
        continue;
      }
      console.log("outbox fetching attempt", entry.attempts + 1);
      let updated: GatewayDelivery = {
        ...entry,
        attempts: entry.attempts + 1,
        lastAttemptedAt: new Date().toISOString(),
      };
      try {
        const response = await this.fetchFn(entry.delivery.url, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...entry.delivery.headers },
          body: payload,
          signal: AbortSignal.timeout(entry.delivery.timeoutMs),
        });
        if (!(response.status >= 200 && response.status < 300))
          throw new WebhookHttpStatusError(response.status);
        updated = {
          ...updated,
          status: "delivered",
          deliveredAt: new Date().toISOString(),
          lastStatusCode: response.status,
          lastError: null,
        };
      } catch (error) {
        updated = {
          ...updated,
          lastStatusCode: error instanceof WebhookHttpStatusError ? error.statusCode : null,
          lastError:
            error instanceof Error ? error.message.slice(0, 400) : "delivery attempt failed",
        };
        if (updated.attempts >= entry.delivery.maxAttempts) updated.status = "failed";
      }
      // A commit rejection means storage failed; running() turns false and the loop exits.
      await this.host.commit(updated);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.loop;
  }
}
