import { mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcDir = join(__dirname, '../src/db/migrations');
const distDir = join(__dirname, '../dist/db/migrations');

try {
  mkdirSync(distDir, { recursive: true });
  const files = readdirSync(srcDir).filter((f) => f.endsWith('.sql'));
  for (const file of files) {
    copyFileSync(join(srcDir, file), join(distDir, file));
    console.log(`Copied ${file} to dist/db/migrations`);
  }
} catch (err) {
  console.error('Failed to copy migration files:', err);
}

