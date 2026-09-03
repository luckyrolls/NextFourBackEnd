import 'dotenv/config';

import express from 'express';
import { MulterError } from 'multer';

import { env } from './lib/env';
import { columnMappingsRouter } from './routes/columnMappings';
import { healthRouter } from './routes/health';
import { importsRouter } from './routes/imports';
import { SERVICE_VERSION } from './lib/version';

// Fail fast: validate the whole environment contract before binding a port, so a
// missing SUPABASE_URL or SUPABASE_SECRET_KEY is a startup crash with a clear
// message rather than a runtime surprise on the first request.
const config = env();

const app = express();

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

app.use(healthRouter);
app.use(columnMappingsRouter);
app.use(importsRouter);

app.use((_req, res) => {
  res.status(404).json({ error: 'not_found' });
});

// Central error handler: multer size limits become 413s; everything else is a
// logged 500 with no internals leaked.
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof MulterError) {
    res.status(413).json({ error: 'upload_rejected', detail: err.code });
    return;
  }
  // eslint-disable-next-line no-console
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'internal_error' });
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
