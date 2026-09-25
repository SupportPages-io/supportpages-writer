import { constants } from 'node:fs';
import { mkdir, realpath, lstat, open, rename, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fail } from './errors.js';
export class Workspace {
  private constructor(public root: string) {}
  static async create(root: string) {
    const canonical = await realpath(root);
    if (!(await lstat(canonical)).isDirectory()) fail('invalid_workspace', 'The workspace must be a directory.');
    return new Workspace(canonical);
  }
  private contains(p: string) { const rel = path.relative(this.root, p); return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel)); }
  async resolve(relative: string) {
    if (path.isAbsolute(relative) || relative.includes('\0')) fail('invalid_path', 'Use a path relative to the configured workspace.');
    const candidate = path.resolve(this.root, relative);
    if (!this.contains(candidate)) fail('invalid_path', 'Path escapes the configured workspace.');
    let cursor = this.root;
    for (const part of path.relative(this.root, candidate).split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, part);
      try { if ((await lstat(cursor)).isSymbolicLink()) fail('invalid_path', 'Artifact and state paths must not contain symlinks.'); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    }
    return candidate;
  }
  async read(relative: string, limit = 2 * 1024 * 1024) {
    const p = await this.resolve(relative);
    let file;
    try { file = await open(p, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') fail('missing_artifact', `Missing ${relative}`); throw e; }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > limit) fail('invalid_artifact', `${relative} is not a regular file within the size limit.`);
      const data = await file.readFile();
      if (data.length > limit) fail('invalid_artifact', `${relative} exceeds the size limit.`);
      return data;
    } finally { await file.close(); }
  }
  async json(relative: string) {
    const data = await this.read(relative);
    try { return JSON.parse(data.toString('utf8')) as unknown; }
    catch { fail('invalid_artifact', `${relative} is not valid JSON.`); }
  }
  async exists(relative: string) { try { await lstat(await this.resolve(relative)); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; } }
  async write(relative: string, data: string | Buffer) {
    const target = await this.resolve(relative);
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await this.resolve(relative);
    const temp = `${target}.${randomUUID()}.tmp`;
    const file = await open(temp, 'wx', 0o600);
    try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
    try { await rename(temp, target); } finally { await rm(temp, { force: true }); }
    return target;
  }
  async writeJson(relative: string, data: unknown) { return this.write(relative, JSON.stringify(data, null, 2) + '\n'); }
  async list(relative: string) {
    if (!await this.exists(relative)) return [];
    return readdir(await this.resolve(relative), { withFileTypes: true });
  }
  async lock<T>(fn: () => Promise<T>): Promise<T> {
    const dir = await this.resolve('.rtfm/supportpages');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const lock = await this.resolve('.rtfm/supportpages/operation.lock');
    try { await mkdir(lock); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') fail('workspace_busy', 'Another operation holds the workspace lock. If its process crashed, remove .rtfm/supportpages/operation.lock after confirming it has stopped.'); throw e; }
    try { return await fn(); } finally { await rm(lock, { recursive: true, force: true }); }
  }
}
