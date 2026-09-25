import path from 'node:path';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { fail } from '../../dist/errors.js';
import { command } from './install.mjs';

const versionPattern = /^\d+\.\d+\.\d+$/;
export function compareVersions(left, right) {
  if (!versionPattern.test(left) || !versionPattern.test(right)) fail('invalid_release', 'The release version must be X.Y.Z. Retry after the release has been corrected.');
  const a = left.split('.').map(BigInt), b = right.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}

/** Update the managed executable without opening a workspace or authenticating. */
export async function releaseInstallation(installRoot, env = process.env) {
  const reinstall = 'Rerun the SupportPages Writer installer with your original --data-dir and --bin-dir to enable updates. Your configuration and article files are kept.';
  let receipt;
  const home = env.SUPPORTPAGES_CLI_HOME;
  if (!home) fail('unmanaged_installation', 'This command is running from a source or unmanaged installation. Rerun ./install-cli.sh from your source checkout, or use the public installer.');
  const root = path.dirname(path.resolve(home));
  try {
    if (path.basename(home) !== 'current' || await realpath(path.join(home, 'mcp')) !== await realpath(installRoot)) throw Error();
    const file = path.join(root, 'install.json');
    if (!(await lstat(file)).isFile()) throw Error();
    receipt = JSON.parse(await readFile(file, 'utf8'));
    if (receipt.version !== 1 || !['release', 'local'].includes(receipt.type) ||
        typeof receipt.data_dir !== 'string' || !path.isAbsolute(receipt.data_dir) ||
        await realpath(receipt.data_dir) !== await realpath(root) ||
        typeof receipt.bin_dir !== 'string' || !path.isAbsolute(receipt.bin_dir)) throw Error();
    const url = new URL(receipt.release_url);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw Error();
  } catch { fail('invalid_installation', `The installation receipt is missing or invalid. ${reinstall}`); }
  if (receipt.type === 'local') fail('local_installation', 'This is a local development build. Rerun ./install-cli.sh from your source checkout to update it.');
  return receipt;
}

export async function updateCli({ installRoot, env = process.env, run = command, ui, checkTimeout = 60 }) {
  const receipt = await releaseInstallation(installRoot, env);
  const current = JSON.parse(await readFile(path.join(installRoot, 'package.json'), 'utf8')).version;
  const releaseUrl = receipt.release_url.replace(/\/$/, '');
  ui.line('Checking for a SupportPages Writer update…');
  const latest = await run('curl', ['--proto', '=https', '--proto-redir', '=https', '-fsSL', '--max-time', String(checkTimeout), `${releaseUrl}/latest.txt`], { capture: true, env });
  if (latest.code !== 0) fail('update_unavailable', 'Could not check for updates. Ensure curl is installed and your network is available, then rerun supportpages update.');
  const next = latest.stdout.trim();
  if (compareVersions(current, next) >= 0) {
    ui.line(`SupportPages Writer ${current} is up to date. No update needed.`);
    return { status: 'current', version: current };
  }
  ui.line(`Updating SupportPages Writer ${current} to ${next}…`);
  const result = await run('bash', [path.join(installRoot, 'install-cli.sh'), '--yes', '--update', '--version', next,
    '--data-dir', receipt.data_dir, '--bin-dir', receipt.bin_dir], { env: { ...env, SUPPORTPAGES_CLI_RELEASE_URL: releaseUrl } });
  if (result.code !== 0) fail('update_failed', 'Update could not finish. Your previous version remains available. Resolve the installer error above and rerun supportpages update.');
  return { status: 'updated', version: next };
}
