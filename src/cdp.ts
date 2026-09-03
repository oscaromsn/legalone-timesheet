/*
 * A minimal Chrome DevTools Protocol client.
 *
 * Dependency-free on purpose: both Bun and Node ship a global `WebSocket`, and a
 * connector a lawyer installs should not pull a browser-automation stack to read
 * one cookie. What this needs from a browser is small — attach to a tab, navigate,
 * read cookies — so a driver of a hundred lines beats a dependency of a hundred
 * megabytes.
 *
 * The one rule that is not obvious: **a CDP session belongs to the connection that
 * created it.** Attaching to a target on one socket and listening for its events on
 * another silently yields nothing — no error, just no events. Everything here runs
 * on a single socket for that reason.
 */

/** A protocol error carries CDP's own message, which names the method that failed. */
export class CdpError extends Error {
  constructor(method: string, message: string) {
    super(`${method}: ${message}`);
    this.name = 'CdpError';
  }
}

export interface CdpEvent {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void; method: string };

export class Cdp {
  private readonly socket: WebSocket;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(e: CdpEvent) => void>();
  private seq = 0;
  private closed = false;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.onmessage = (ev) => this.dispatch(String(ev.data));
    // A socket that dies with commands in flight must fail them, or every caller
    // waits out its timeout for a connection that is already gone.
    socket.onclose = () => this.failAll(new Error('CDP connection closed'));
    socket.onerror = () => this.failAll(new Error('CDP connection error'));
  }

  /** Connects to the browser-level endpoint of a Chrome started with a debugging port. */
  static async attach(port: number, timeoutMs = 10_000): Promise<Cdp> {
    const deadline = Date.now() + timeoutMs;
    let lastError = '';
    // Chrome opens the port a beat after the process starts; poll rather than race it.
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`);
        const { webSocketDebuggerUrl } = (await response.json()) as { webSocketDebuggerUrl: string };
        return await Cdp.connect(webSocketDebuggerUrl);
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    throw new Error(`no CDP endpoint on port ${port} after ${timeoutMs}ms (${lastError})`);
  }

  static connect(url: string): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.onopen = () => resolve(new Cdp(socket));
      socket.onerror = () => reject(new Error(`cannot open CDP socket at ${url}`));
    });
  }

  private dispatch(raw: string): void {
    const message = JSON.parse(raw) as {
      id?: number; result?: unknown; error?: { message: string };
      method?: string; params?: Record<string, unknown>; sessionId?: string;
    };

    if (message.id !== undefined) {
      const waiting = this.pending.get(message.id);
      if (!waiting) return;
      this.pending.delete(message.id);
      if (message.error) waiting.reject(new CdpError(waiting.method, message.error.message));
      else waiting.resolve(message.result);
      return;
    }

    if (message.method) {
      const event: CdpEvent = {
        method: message.method,
        params: message.params ?? {},
        ...(message.sessionId ? { sessionId: message.sessionId } : {}),
      };
      for (const listener of this.listeners) listener(event);
    }
  }

  private failAll(error: Error): void {
    this.closed = true;
    for (const [, waiting] of this.pending) waiting.reject(error);
    this.pending.clear();
  }

  /**
   * Sends one command. Omit `sessionId` for browser-level domains (Target, Storage);
   * pass one for page-level domains (Page, Network, Runtime).
   */
  send<T = any>(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 30_000): Promise<T> {
    if (this.closed) return Promise.reject(new Error(`CDP closed; cannot send ${method}`));
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      const settle = (fn: (v: any) => void) => (v: any) => { clearTimeout(timer); fn(v); };
      this.pending.set(id, { resolve: settle(resolve), reject: settle(reject), method });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  /** Subscribes to every event; returns an unsubscribe function. */
  on(listener: (e: CdpEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Waits for the first event matching `method`, or rejects on timeout. */
  once(method: string, timeoutMs = 30_000): Promise<CdpEvent> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error(`no ${method} within ${timeoutMs}ms`)); }, timeoutMs);
      const off = this.on((event) => {
        if (event.method !== method) return;
        clearTimeout(timer); off(); resolve(event);
      });
    });
  }

  /** Opens a tab and attaches to it, returning both ids. `flatten` keeps one socket. */
  async openTab(url = 'about:blank'): Promise<{ targetId: string; sessionId: string }> {
    const { targetId } = await this.send<{ targetId: string }>('Target.createTarget', { url });
    const { sessionId } = await this.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });
    return { targetId, sessionId };
  }

  async closeTab(targetId: string): Promise<void> {
    await this.send('Target.closeTarget', { targetId }).catch(() => undefined);
  }

  close(): void {
    this.closed = true;
    this.socket.close();
  }
}
