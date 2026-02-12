import { IncomingMessage } from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import { ChannelName } from './types';

export const channelNames: ChannelName[] = ['inputs', 'outputs', 'workflows', 'events', 'broadcast'];

export function isChannelName(value: string): value is ChannelName {
  return channelNames.includes(value as ChannelName);
}

interface WsClient {
  id: string;
  socket: WebSocket;
}

export class WsHub {
  private wss = new WebSocketServer({ noServer: true });
  private channels: Record<ChannelName, Map<string, WsClient>> = {
    inputs: new Map(),
    outputs: new Map(),
    workflows: new Map(),
    events: new Map(),
    broadcast: new Map(),
  };

  handleUpgrade(req: IncomingMessage, socket: any, head: Buffer, channel: ChannelName) {
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const map = this.channels[channel];
      map.set(id, { id, socket: ws });

      ws.send(JSON.stringify({ event: 'hello', channel, id }));

      const cleanup = () => map.delete(id);
      ws.on('close', cleanup);
      ws.on('error', cleanup);
    });
  }

  publish(channel: ChannelName, data: any) {
    const text = typeof data === 'string' ? data : JSON.stringify(data);
    for (const client of this.channels[channel].values()) {
      if (client.socket.readyState === WebSocket.OPEN) {
        try {
          client.socket.send(text);
        } catch (_) {
          // ignore broken connections
        }
      }
    }
  }
}
