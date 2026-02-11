
import http from 'http';
import path from 'path';
import { createApi } from './api';

const staticDir = path.join(__dirname, '..', 'public');
const { handle } = createApi(staticDir);

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

server.listen(PORT, () => {
  console.log(`Orchestrator listening on http://localhost:${PORT}/v1/orchestrator`);
});
