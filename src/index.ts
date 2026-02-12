
import http from 'http';
import path from 'path';
import { createApi } from './api';
import { isChannelName } from './ws';

const staticDir = path.join(__dirname, '..', 'public');
const { handle, ws } = createApi(staticDir);

const PORT = process.env.PORT || 3000;

const server = http.createServer(async (req, res) => {
  const start = Date.now();
  try {
    await handle(req, res);
  } catch (err) {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'internal_server_error' }));
    } else {
      res.end();
    }
    console.error(err);
  } finally {
    const ms = Date.now() - start;
    const method = req.method || '-';
    const url = req.url || '-';
    console.log(`${method} ${url} ${res.statusCode} ${ms}ms`);
  }
});

server.on('upgrade', (req, socket, head) => {
  try {
    const host = req.headers.host || 'localhost';
    const url = new URL(req.url || '/', `http://${host}`);
    const basePath = '/v1/orchestrator';
    if (!url.pathname.startsWith(basePath)) {
      socket.destroy();
      return;
    }
    const segments = url.pathname.slice(basePath.length).split('/').filter(Boolean);
      if (segments.length === 2) {
        const channel = segments[0];
        const endpoint = segments[1];
        if (isChannelName(channel) && (endpoint === 'ws' || endpoint === 'stream')) {
          ws.handleUpgrade(req, socket, head, channel);
          return;
        }
      }
    socket.destroy();
  } catch (err) {
    socket.destroy();
  }
});

server.listen(PORT, () => {
  console.log(`Orchestrator listening on http://localhost:${PORT}/v1/orchestrator`);
});
