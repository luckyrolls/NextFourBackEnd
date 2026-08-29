import 'dotenv/config';

import express from 'express';

import { env } from './lib/env';
import { healthRouter } from './routes/health';
import { SERVICE_VERSION } from './lib/version';

// Fail fast: validate the whole environment contract before binding a port, so a
// missing SUPABASE_URL or SUPABASE_SECRET_KEY is a startup crash with a clear
// message rather than a runtime surprise on the first request.
const config = env();

const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

app.use(healthRouter);

app.use((_req, res) => {
  res.status(404).json({ error: 'not_found' });
});

const server = app.listen(config.PORT, () => {
  // eslint-disable-next-line no-console
  console.log(
    `nextfour-backend v${SERVICE_VERSION} listening on port ${config.PORT} (${config.NODE_ENV})`,
  );
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
