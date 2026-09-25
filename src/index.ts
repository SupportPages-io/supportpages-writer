#!/usr/bin/env node
import { Session, defaultConfigDir } from './session.js';
import { parseArgs } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pinSkills, startBackgroundUpdate } from './runtime.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { apiOrigin, defaultOrigin, developmentMode } from './api.js';
import { createServer } from './server.js';
import { fail, publicError } from './errors.js';
import { configureTelemetry, reportError } from './telemetry.js';
try {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  if (major < 22 || major === 22 && minor < 12) {
    fail('missing_dependency', `SupportPages Writer needs Node.js 22.12 or later; this is ${process.version}. Install a newer Node.js and restart your coding agent.`);
  }
  const { values } = parseArgs({ options: { workspace: { type: 'string' }, 'api-url': { type: 'string' }, 'skills-dir': { type: 'string' }, 'token-file': { type: 'string' }, 'config-dir': { type: 'string' }, dev: { type: 'boolean' }, help: { type: 'boolean' }, doctor: { type: 'boolean' } } });
  if (values.help) {
    process.stdout.write('Usage: supportpages-mcp [--workspace /absolute/product/path] [--dev] [--api-url ORIGIN] [--skills-dir /path/to/engine] [--token-file /private/credential.json] [--doctor]\nUse --dev (or SUPPORTPAGES_DEV=true) for https://app.lvh.me:3443. Call supportpages_init in your agent to connect this project. Without --doctor, starts an MCP stdio server.\n');
  } else {
    // Coding clients launch Node directly, without the supportpages shell launcher.
    process.env.PATH = path.dirname(process.execPath) + path.delimiter + (process.env.PATH ?? '');
    const dev = values.dev ?? developmentMode(process.env.SUPPORTPAGES_DEV);
    const origin = apiOrigin(values['api-url'] ?? process.env.SUPPORTPAGES_API_URL ?? defaultOrigin(dev), dev);
    const installRoot = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
    const configDir = path.resolve(values['config-dir'] ?? defaultConfigDir());
    const telemetry = configureTelemetry({ configDir, origin, installRoot });
    const skillsDir = await pinSkills(installRoot, path.resolve(values['skills-dir'] ?? process.env.RTFM_SKILLS_DIR ?? path.join(installRoot, 'engine')));
    const session = new Session({ workspace: values.workspace ?? process.env.RTFM_WORKSPACE,
      projectDir: process.env.CLAUDE_PROJECT_DIR, cwd: process.cwd(), origin, dev,
      configDir,
      tokenFile: values['token-file'] ?? process.env.SUPPORTPAGES_API_TOKEN_FILE, token: process.env.SUPPORTPAGES_API_TOKEN,
      skillsDir });
    if (values.doctor) process.stdout.write(JSON.stringify(await (await session.bridge()).doctor(), null, 2) + '\n');
    else {
      await createServer(session).connect(new StdioServerTransport());
      telemetry?.start();
      startBackgroundUpdate(installRoot);
    }
  }
} catch (error) {
  reportError(error);
  process.stderr.write(JSON.stringify(publicError(error)) + '\n');
  process.exitCode = 1;
}
