import { z } from 'zod';

/**
 * Environment contract. Parsed once at startup so a misconfigured deploy fails
 * immediately and loudly, rather than at the first request that needs a key.
 */
const envSchema = z.object({
  SUPABASE_URL: z
    .string({ required_error: 'SUPABASE_URL is required' })
    .url('SUPABASE_URL must be a full URL, e.g. https://<project-ref>.supabase.co'),
  SUPABASE_SECRET_KEY: z
    .string({ required_error: 'SUPABASE_SECRET_KEY is required' })
    .min(1, 'SUPABASE_SECRET_KEY must not be empty'),
  PORT: z.coerce.number().int().positive().max(65535).default(3000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Validates `process.env` against the contract above.
 * Throws with every missing/invalid variable listed, not just the first.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(
      `Invalid environment configuration:\n${details}\n\n` +
        'Copy .env.example to .env and fill in the values (locally), or set them in the ' +
        'Render dashboard (deployed).',
    );
  }

  return result.data;
}

let cached: Env | undefined;

/** Memoised accessor — the contract is validated on first use and reused thereafter. */
export function env(): Env {
  if (!cached) {
    cached = loadEnv();
  }
  return cached;
}
