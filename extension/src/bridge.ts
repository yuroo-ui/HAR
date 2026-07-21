import { BRIDGE_HOST, BRIDGE_PORT, BridgeMessage, PROTOCOL_VERSION } from '@har-suite/shared';

type IncomingHandler = (msg: BridgeMessage) => void;
type AuthHandler = () => void;

const RECONNECT_MS = 2000;
const AUTH_TIMEOUT_MS = 5000;

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

  constructor(getToken: () => Promise<string>, getUrl?: () => string) {
    this.getToken = getToken;
    this.getUrl = getUrl || (() => `ws://${BRIDGE_HOST}:${BRIDGE_PORT}`);
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
    return this.authed && this.ws?.readyState === WebSocket.OPEN;
  }

  forceReconnect() {
    const old = this.ws;
    this.ws = null;
    this.authed = false;
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
    if (this.ws) return;
    const url = this.getUrl();
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
    } catch (e) {
      console.warn('[bridge] cannot open', url, e);
      this.scheduleReconnect();
      return;
    }
    this.ws = socket;

    socket.addEventListener('open', async () => {
      // Guard: if a forceReconnect raced us, this socket is no longer current.
      if (this.ws !== socket) return;
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
      if (this.ws !== socket) return; // stale socket
      try {
        const parsed = JSON.parse(ev.data) as BridgeMessage;
        if (parsed.kind === 'auth-ok') {
          this.authed = true;
          if (this.authTimer != null) {
            clearTimeout(this.authTimer);
            this.authTimer = null;
          }
          console.log('[bridge] authenticated', url);
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
      // Only reset state if this socket is still the current one.
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

  private scheduleReconnect() {
    if (this.connectTimer != null) return;
    this.connectTimer = self.setTimeout(() => {
      this.connectTimer = null;
      this.connect();
    }, RECONNECT_MS);
  }
}
