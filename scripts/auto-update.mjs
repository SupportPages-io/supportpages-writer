#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { automaticUpdate } from './lib/auto-update.mjs';

// This worker is launched with all streams disconnected from the MCP transport.
await automaticUpdate({ installRoot: path.dirname(path.dirname(fileURLToPath(import.meta.url))) });
