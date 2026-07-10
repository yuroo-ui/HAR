import { WebSocketServer, WebSocket } from 'ws';
import { EventEmitter } from 'node:events';
import { BRIDGE_HOST, BRIDGE_PORT, BridgeMessage, PROTOCOL_VERSION } from '@har-suite/shared';

const AUTH_GRACE_MS = 5000;

export class BridgeServer extends EventEmitter {
  private wss: WebSocketServer | null = null;
  private clients = new Set<WebSocket>();
  private token = '';

  setToken(token: string) {
    this.token = token;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.wss = new WebSocketServer({ host: BRIDGE_HOST, port: BRIDGE_PORT });
        this.wss.on('connection', (ws) => this.onConnection(ws));
        this.wss.on('listening', () => resolve());
        this.wss.on('error', (err) => reject(err));
      } catch (e) {
        reject(e);
      }
    });
  }

  private onConnection(ws: WebSocket) {
    let authed = false;
    const killTimer = setTimeout(() => {
      if (!authed) {
        try {
          ws.close();
        } catch {}
      }
    }, AUTH_GRACE_MS);

    ws.on('message', (data) => {
      let parsed: BridgeMessage | null = null;
      try {
        parsed = JSON.parse(data.toString()) as BridgeMessage;
      } catch {
        if (!authed) {
          // Garbage during the auth window — fail loudly instead of waiting
          // for the grace timer to silently close the socket.
          this.sendTo(ws, { kind: 'auth-fail', reason: 'malformed handshake' });
          try {
            ws.close();
          } catch {}
        }
        return;
      }
      if (!authed) {
        if (parsed?.kind !== 'auth') {
          this.sendTo(ws, { kind: 'auth-fail', reason: 'must authenticate first' });
          try {
            ws.close();
          } catch {}
          return;
        }
        if (parsed.protocol !== PROTOCOL_VERSION) {
          this.sendTo(ws, {
            kind: 'auth-fail',
            reason: `protocol mismatch (need v${PROTOCOL_VERSION})`,
          });
          try {
            ws.close();
          } catch {}
          return;
        }
        if (!this.token || parsed.token !== this.token) {
          this.sendTo(ws, { kind: 'auth-fail', reason: 'invalid token' });
          try {
            ws.close();
          } catch {}
          return;
        }
        authed = true;
        clearTimeout(killTimer);
        this.clients.add(ws);
        this.sendTo(ws, { kind: 'auth-ok' });
        this.emit('connected', { extensionVersion: parsed.extensionVersion });
        return;
      }
      this.emit('message', parsed);
    });

    ws.on('close', () => {
      clearTimeout(killTimer);
      if (authed) {
        this.clients.delete(ws);
        this.emit('disconnected');
      }
    });
  }

  private sendTo(ws: WebSocket, msg: BridgeMessage) {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(msg));
      } catch {}
    }
  }

  send(msg: BridgeMessage) {
    const data = JSON.stringify(msg);
    for (const ws of this.clients) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(data);
        } catch {}
      }
    }
  }

  stop() {
    for (const ws of this.clients) {
      try {
        ws.close();
      } catch {}
    }
    this.clients.clear();
    this.wss?.close();
    this.wss = null;
  }

  hasClient(): boolean {
    return this.clients.size > 0;
  }
}
// trigger reload
