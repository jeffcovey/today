// Run every suite against an empty config, as CI does, so a checkout with a
// real config.toml (or .data/config-path) can't leak deployment settings into
// tests. Suites that need a config set TODAY_CONFIG themselves.
import { join } from 'path';
import { fileURLToPath } from 'url';

process.env.TODAY_CONFIG = join(fileURLToPath(new URL('.', import.meta.url)), 'nonexistent-config.toml');
