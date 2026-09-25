// Cited source paths: project-relative, or `../<sibling>/<path>` into another
// checkout of a multi-repo product. Siblings are only reachable when the
// harness set RTFM_REPOS_ROOT and the project directory sits directly inside
// it (see related_repos.sh) — interactive single-repo runs keep the strict
// project-relative rule. The resolved file must stay inside its checkout.
const fs = require('fs');
const path = require('path');

function reposRoot() {
    const root = process.env.RTFM_REPOS_ROOT;
    return typeof root === 'string' && root.trim() ? root : null;
}

// Syntactic check, no filesystem: a plain relative path, or (with
// RTFM_REPOS_ROOT set) exactly one leading `..` followed by a sibling name.
function isSafeSourcePath(value) {
    if (typeof value !== 'string' || !value.trim() || path.isAbsolute(value)) return false;
    const parts = value.split(/[\\/]/);
    if (!parts.includes('..')) return true;
    return Boolean(reposRoot()) && parts[0] === '..' && parts.length > 2 &&
        Boolean(parts[1]) && parts[1] !== '.' && !parts.slice(1).includes('..');
}

// Absolute real path of a cited file, or throws. Sibling citations must land
// in a git checkout that is a direct child of RTFM_REPOS_ROOT, next to the
// project directory.
function resolveSourcePath(projectDir, file) {
    if (!isSafeSourcePath(file)) throw Error('cite a project-relative source file (or ../<repo>/<path> for a related repository)');
    const base = fs.realpathSync(projectDir);
    const parts = file.split(/[\\/]/);
    let checkout = base;
    if (parts[0] === '..') {
        const root = fs.realpathSync(reposRoot());
        if (path.dirname(base) !== root) throw Error('related repositories are only reachable from a checkout inside RTFM_REPOS_ROOT');
        checkout = fs.realpathSync(path.join(root, parts[1]));
        if (path.dirname(checkout) !== root || checkout === base || !fs.existsSync(path.join(checkout, '.git'))) {
            throw Error(`${parts[0]}/${parts[1]} is not a related repository`);
        }
    }
    const resolved = fs.realpathSync(path.join(base, file));
    if (!resolved.startsWith(checkout + path.sep)) throw Error('source resolves outside the project');
    return resolved;
}

function sourceExists(projectDir, file) {
    try { resolveSourcePath(projectDir, file); return true; } catch { return false; }
}

module.exports = { isSafeSourcePath, resolveSourcePath, sourceExists };
