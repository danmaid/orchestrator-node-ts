
import { Response, Request } from 'express';
import { ChannelName } from './types';

interface Client { id: string; res: Response; }

export class SSEHub {
  private channels: Record<ChannelName, Map<string, Client>> = {
    inputs: new Map(),
    outputs: new Map(),
    workflows: new Map(),
  };

  addClient(channel: ChannelName, req: Request, res: Response) {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    res.write(`event: hello
`);
    res.write(`data: {"channel":"${channel}","id":"${id}"}

`);

    const map = this.channels[channel];
    map.set(id, { id, res });

    const keepAlive = setInterval(() => {
      if (!res.writableEnded) {
        res.write(`:
`); // comment line as heartbeat
      }
    }, 15000);

    req.on('close', () => {
      clearInterval(keepAlive);
      map.delete(id);
    });
  }

  publish(channel: ChannelName, data: any, eventName = 'message') {
    const text = typeof data === 'string' ? data : JSON.stringify(data);
    for (const client of this.channels[channel].values()) {
      try {
        client.res.write(`event: ${eventName}
`);
        client.res.write(`data: ${text}

`);
      } catch (_) {
        // Ignore broken pipe; cleanup happens on close
      }
    }
  }
}
