import path from 'node:path';

// The engine's renderer resolves puppeteer from the package's node_modules.
// Plugin installs run npm without lifecycle scripts, so puppeteer's own
// Chromium download may never have happened: run it here instead.
const resolvePuppeteer = articleDir => [
  '--input-type=module', '-e',
  "import {createRequire} from 'node:module'; const require=createRequire(process.argv[1]+'/package.json'); process.stdout.write(require.resolve('puppeteer/package.json'));",
  articleDir,
];
const checkBrowser = articleDir => [
  '--input-type=module', '-e',
  "import {createRequire} from 'node:module'; import {accessSync} from 'node:fs'; const require=createRequire(process.argv[1]+'/package.json'); const p=require('puppeteer'); accessSync(await p.executablePath());",
  articleDir,
];

/** True when puppeteer loads and its Chromium is on disk. */
export async function rendererReady(skillsDir, run, node = process.execPath) {
  const articleDir = path.join(skillsDir, 'generate-illustrated-article');
  return (await run(node, checkBrowser(articleDir), { capture: true })).code === 0;
}

/** Download puppeteer's pinned Chromium when it is missing. Returns true when ready. */
export async function ensureRenderer(skillsDir, run, { node = process.execPath, ui } = {}) {
  if (await rendererReady(skillsDir, run, node)) return true;
  const articleDir = path.join(skillsDir, 'generate-illustrated-article');
  const located = await run(node, resolvePuppeteer(articleDir), { capture: true });
  if (located.code !== 0 || !located.stdout.trim()) return false;
  ui?.line?.('  Downloading Chromium for article screenshots. This can take a few minutes the first time.');
  // puppeteer's postinstall script: downloads the pinned browsers into its cache.
  const installer = path.join(path.dirname(located.stdout.trim()), 'install.mjs');
  const result = await run(node, [installer], { cwd: path.dirname(installer) });
  return result.code === 0 && rendererReady(skillsDir, run, node);
}
