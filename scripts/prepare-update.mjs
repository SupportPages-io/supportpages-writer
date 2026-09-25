#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareUpdate } from './lib/prepare-update.mjs';

try {
  if (!process.argv[2]) throw Error('The previous installation is required.');
  await prepareUpdate(process.argv[2], path.dirname(path.dirname(fileURLToPath(import.meta.url))));
} catch (error) {
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
}
