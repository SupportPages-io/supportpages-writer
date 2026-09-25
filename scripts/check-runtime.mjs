#!/usr/bin/env node
// Run by the installer before switching releases: the bundled Node must be able
// to run the article renderer on this machine.
try {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (!(major > 22 || major === 22 && minor >= 12)) throw Error('The local article renderer requires Node.js 22.12 or later.');
} catch (error) {
  process.stderr.write(error.message + '\n');
  process.exitCode = 1;
}
