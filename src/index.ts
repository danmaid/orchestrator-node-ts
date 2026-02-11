
import express from 'express';
import cors from 'cors';
import morgan from 'morgan';
import path from 'path';
import { createApi } from './api';

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(morgan('dev'));

const staticDir = path.join(__dirname, '..', 'public');
const { router } = createApi(staticDir);

// Mount under /v1/orchestrator
app.use('/v1/orchestrator', router);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Orchestrator listening on http://localhost:${PORT}/v1/orchestrator`);
});
