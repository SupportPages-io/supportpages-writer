import { lstat, mkdir, open, readFile, rename, rm, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export async function installManagedWriter({ config, name, extension, contents, marker, existingOnly = false }) {
  return installManagedFile({ config, parts: ['agents', `${name}.${extension}`], contents, marker, kind: 'agent', existingOnly });
}

/** Shared ownership, backup and atomic-write rules for installed agent instructions. */
export async function installManagedFile({ config, parts, contents, marker, kind, existingOnly = false }) {
  const entries = [config];
  for (const part of parts) entries.push(path.join(entries.at(-1), part));
  const filename = entries.at(-1), directory = path.dirname(filename);
  for (const entry of entries) {
    try {
      const info = await lstat(entry);
      if (info.isSymbolicLink() || (entry === filename ? !info.isFile() : !info.isDirectory())) throw Error(`Cannot install the SupportPages.io ${kind} over an unsafe path: ${entry}`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  let previous;
  try { previous = await readFile(filename, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existingOnly && (previous === undefined || !previous.includes(marker))) return { filename, changed: false };
  if (previous === contents) return { filename, changed: false };
  if (previous !== undefined && !previous.includes(marker)) {
    throw Error(`A custom ${kind} already exists at ${filename}. Keep or rename it before installing SupportPages.io instructions.`);
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (previous !== undefined) await copyFile(filename, `${filename}.backup-${randomUUID()}`);
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(contents); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, filename);
  } finally { await rm(temporary, { force: true }); }
  return { filename, changed: true };
}
