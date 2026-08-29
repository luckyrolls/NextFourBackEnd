import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Service version, read from package.json at startup.
 * Resolves to the repo root from both `src/lib` (tsx) and `dist/lib` (compiled).
 */
function readVersion(): string {
  try {
    const pkgPath = resolve(__dirname, '..', '..', 'package.json');
    const parsed: unknown = JSON.parse(readFileSync(pkgPath, 'utf8'));
    if (typeof parsed === 'object' && parsed !== null && 'version' in parsed) {
      const { version } = parsed as { version?: unknown };
      if (typeof version === 'string') return version;
    }
  } catch {
    // Fall through to the env/unknown fallback below.
  }
  return process.env['npm_package_version'] ?? '0.0.0';
}

export const SERVICE_VERSION = readVersion();
