import { execFile } from 'node:child_process';

export async function openBrowser(url, { platform = process.platform, execute = execFile, env = process.env } = {}) {
  if (!['darwin', 'linux'].includes(platform)) return false;
  const safeEnv = { ...env };
  delete safeEnv.SUPPORTPAGES_API_TOKEN;
  delete safeEnv.SUPPORTPAGES_API_TOKEN_FILE;
  return new Promise(resolve => {
    execute(platform === 'darwin' ? 'open' : 'xdg-open', [url],
      { env: safeEnv, timeout: 5000 }, error => resolve(!error));
  });
}
