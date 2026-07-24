import { BRIDGE_HOST, BRIDGE_PORT, BridgeMessage, PROTOCOL_VERSION } from '@har-suite/shared';

type IncomingHandler = (msg: BridgeMessage) => void;
type AuthHandler = () => void;

const RECONNECT_MS = 2000;
const AUTH_TIMEOUT_MS = 5000;

/**
 * Bridge transport used by the extension.
 * - Default: local desktop app ws://127.0.0.1:9876 (waguri original)
 * - Optional: remote wss://capture... with HTTP polling fallback (custom useful)
 */
export class Bridge {
  private ws: WebSocket | null = null;
  private queue: BridgeMessage[] = [];
  private handlers: IncomingHandler[] = [];
  private authHandlers: AuthHandler[] = [];
  private connectTimer: number | null = null;
  private getToken: () => Promise<string>;
  private getUrl: () => string;
  private authed = false;
  private authTimer: number | null = null;
  private keepAliveTimer: number | null = null;
  private usePolling = false;
  private allowPolling: boolean;

  constructor(getToken: () => Promise<string>, getUrl?: () => string, opts?: { allowPolling?: boolean }) {
    this.getToken = getToken;
    this.getUrl = getUrl || (() => `ws://${BRIDGE_HOST}:${BRIDGE_PORT}`);
    // Polling only makes sense for remote https endpoints, not local desktop.
    this.allowPolling = opts?.allowPolling ?? false;
  }

  start() {
    this.connect();
  }

  onMessage(fn: IncomingHandler) {
    this.handlers.push(fn);
  }

  onAuthenticated(fn: AuthHandler) {
    this.authHandlers.push(fn);
  }

  send(msg: BridgeMessage) {
    if (this.usePolling) {
      this.sendViaHttp(msg);
      return;
    }
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.authed) {
      try {
        this.ws.send(JSON.stringify(msg));
      } catch (e) {
        console.warn('[bridge] send failed', e);
        this.queue.push(msg);
      }
    } else {
      if (this.queue.length < 2000) this.queue.push(msg);
    }
  }

  isOpen() {
    if (this.usePolling) return this.authed;
    return this.authed && this.ws?.readyState === WebSocket.OPEN;
  }

  forceReconnect() {
    this.stopPolling();
    const old = this.ws;
    this.ws = null;
    this.authed = false;
    this.usePolling = false;
    if (this.authTimer != null) {
      clearTimeout(this.authTimer);
      this.authTimer = null;
    }
    if (old) {
      try {
        old.close();
      } catch {}
    }
    this.connect();
  }

  private async connect() {
    if (this.ws || this.usePolling) return;
    const url = this.getUrl();
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (e) {
      console.warn('[bridge] cannot open', url, e);
      if (this.allowPolling) this.fallbackToPolling();
      else this.scheduleReconnect();
      return;
    }
    this.ws = socket;

    const openTimeout = this.allowPolling
      ? self.setTimeout(() => {
          if (this.ws === socket && !this.authed) {
            console.warn('[bridge] ws open timeout, falling back to HTTP polling');
            try {
              socket.close();
            } catch {}
            this.ws = null;
            this.fallbackToPolling();
          }
        }, 5000)
      : null;

    socket.addEventListener('open', async () => {
      if (this.ws !== socket) return;
      if (openTimeout != null) clearTimeout(openTimeout);
      const token = await this.getToken();
      const auth: BridgeMessage = {
        kind: 'auth',
        token,
        extensionVersion: chrome.runtime.getManifest().version,
        protocol: PROTOCOL_VERSION,
      };
      try {
        socket.send(JSON.stringify(auth));
      } catch {}
      this.authTimer = self.setTimeout(() => {
        if (this.ws === socket && !this.authed) {
          console.warn('[bridge] auth timeout');
          try {
            socket.close();
          } catch {}
        }
      }, AUTH_TIMEOUT_MS);
    });

    socket.addEventListener('message', (ev) => {
      if (this.ws !== socket) return;
      try {
        const parsed = JSON.parse(ev.data) as BridgeMessage;
        if (parsed.kind === 'auth-ok') {
          this.authed = true;
          if (this.authTimer != null) {
            clearTimeout(this.authTimer);
            this.authTimer = null;
          }
          console.log('[bridge] authenticated', url);
          this.startKeepAlive();
          const drain = this.queue.splice(0);
          for (const m of drain) this.send(m);
          for (const fn of this.authHandlers) {
            try {
              fn();
            } catch (e) {
              console.warn('[bridge] auth handler threw', e);
            }
          }
          return;
        }
        if (parsed.kind === 'auth-fail') {
          console.warn('[bridge] auth failed:', parsed.reason);
          try {
            socket.close();
          } catch {}
          return;
        }
        for (const h of this.handlers) h(parsed);
      } catch (e) {
        console.warn('[bridge] bad message', e);
      }
    });

    socket.addEventListener('close', () => {
      this.stopKeepAlive();
      if (this.ws === socket) {
        this.ws = null;
        this.authed = false;
        if (this.authTimer != null) {
          clearTimeout(this.authTimer);
          this.authTimer = null;
        }
        this.scheduleReconnect();
      }
    });

    socket.addEventListener('error', () => {
      try {
        socket.close();
      } catch {}
    });
  }

  private async fallbackToPolling() {
    if (!this.allowPolling || this.usePolling) return;
    this.usePolling = true;
    const url = this.getUrl();
    const serverUrl = url.replace(/^wss?:\/\//, 'https://').replace(/\/bridge\/ws$/, '');
    const token = await this.getToken();

    console.log('[bridge] using HTTP polling to', serverUrl);

    try {
      const resp = await fetch(`${serverUrl}/api/bridge/poll?token=${encodeURIComponent(token)}`);
      if (!resp.ok) {
        console.warn('[bridge] HTTP poll auth failed');
        this.usePolling = false;
        this.scheduleReconnect();
        return;
      }
    } catch (e) {
      console.warn('[bridge] HTTP poll failed', e);
      this.usePolling = false;
      this.scheduleReconnect();
      return;
    }

    this.authed = true;
    console.log('[bridge] HTTP polling authenticated');
    for (const fn of this.authHandlers) {
      try {
        fn();
      } catch {}
    }

    const drain = this.queue.splice(0);
    for (const m of drain) this.sendViaHttp(m);
  }

  private async sendViaHttp(msg: BridgeMessage) {
    const url = this.getUrl();
    const serverUrl = url.replace(/^wss?:\/\//, 'https://').replace(/\/bridge\/ws$/, '');
    const token = await this.getToken();
    try {
      await fetch(`${serverUrl}/api/bridge/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...msg, token }),
      });
    } catch (e) {
      console.warn('[bridge] HTTP send failed', e);
      if (this.queue.length < 2000) this.queue.push(msg);
    }
  }

  private stopPolling() {
    this.usePolling = false;
  }

  private scheduleReconnect() {
    if (this.connectTimer != null) return;
    this.connectTimer = self.setTimeout(() => {
      this.connectTimer = null;
      this.connect();
    }, RECONNECT_MS);
  }

  private startKeepAlive() {
    this.stopKeepAlive();
    this.keepAliveTimer = self.setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(JSON.stringify({ kind: 'ping' }));
        } catch {}
      }
    }, 25000) as unknown as number;
  }

  private stopKeepAlive() {
    if (this.keepAliveTimer != null) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }
}
