import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Workspace } from './workspace.js';
import { fail, publicError } from './errors.js';
import { articleType, remoteId } from './schema.js';

const text = z.string().trim().min(1).max(500);
export const sectionProposal = z.object({ name: text, slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(120),
  description: z.string().max(5000).default(''), icon: z.string().max(100).default('document-text'), justification: z.string().max(5000).optional(), id: remoteId.optional() });
export const recommendation = z.object({ id: z.string().max(100), title: text, description: z.string().max(10000),
  previous_titles: z.array(text).max(100).default([]),
  justification: z.string().max(10000).default(''), type: articleType.default('how-to'), section_id: remoteId.nullable().default(null),
  section_slug: z.string().nullable().default(null), status: z.enum(['pending', 'dismissed', 'completed']).default('pending') });
export const planSchema = z.object({ version: z.literal(1), project_id: remoteId,
  sections: z.array(sectionProposal).max(1000).default([]), sections_generated: z.boolean().default(false),
  section_suggestions: z.array(sectionProposal.omit({ id: true })).max(1000).default([]),
  dismissed_section_slugs: z.array(z.string().max(120)).max(1000).default([]),
  recommendations: z.array(recommendation).max(2000).default([]), recommendations_generated: z.boolean().default(false),
  feature_inventory: z.array(z.record(z.string(), z.unknown())).max(2000).default([]) });
export type LocalPlan = z.infer<typeof planSchema>;
const receiptSchema = z.object({ version: z.literal(1), workspace: z.string(), output_dir: z.string(), completed_at: z.string(),
  codebase_dir: z.string().default('.'),
  skills_version: z.string(), agent: z.string(), source_commit: z.string().nullable().optional(), hashes: z.record(z.string(), z.string()) });
export const cacheFiles = ['.rtfm/branding.json', '.rtfm/project_map.json', '.rtfm/branding.css'];
export function projectCacheFiles(codebaseDir = '.') {
  return cacheFiles.map(file => codebaseDir === '.' ? file : `${codebaseDir}/${file}`);
}
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');

/** detect-project names the app type an incomplete map needs; that is the recovery hint. */
export function requiredAppType(block?: string | null): string | undefined {
  return /(?<![\w])app_type=([a-z0-9]+)/i.exec(block ?? '')?.[1]?.toLowerCase();
}

/** Shared by the CLI and MCP: a successful agent message is not a readiness check. */
export class LocalSetup {
  constructor(public ws: Workspace, public root: string) {}
  async validate(outputDir: string, codebaseDir?: string) {
    if (outputDir !== 'output/detect-project' && !outputDir.startsWith(`${this.root}/setup/tasks/`)) fail('invalid_analysis', 'Analysis output must belong to this workspace.');
    if (codebaseDir === undefined && await this.ws.exists(`${outputDir}/analysis-target.json`)) {
      codebaseDir = z.object({ codebase_dir: z.string() }).parse(await this.ws.json(`${outputDir}/analysis-target.json`)).codebase_dir;
    }
    codebaseDir ??= '.';
    if (codebaseDir !== '.' && (!codebaseDir || codebaseDir.split('/').some(part => !part || part === '.' || part === '..') || codebaseDir.includes('\\'))) fail('invalid_analysis', 'The analysed application must be a directory inside this workspace.');
    await this.ws.resolve(codebaseDir);
    const filesForProject = projectCacheFiles(codebaseDir);
    const branding = z.object({ framework: text }).passthrough().parse(await this.ws.json(filesForProject[0]!));
    const index = z.union([z.array(z.unknown()), z.record(z.string(), z.unknown())]);
    const map = z.object({ framework: text, app_type: z.enum(['web', 'terminal', 'mobile', 'desktop', 'win32', 'macos', 'game']).default('web'),
      route_index: index, dir_map: z.record(z.string(), z.unknown()).optional() }).passthrough().parse(await this.ws.json(filesForProject[1]!));
    // detect-project stamps its own verdict. A map that says it could not finish
    // must not pass as ready: the article skill then refuses the wrong app_type and
    // the run fails far from the cause.
    const detection = z.object({ detection_status: z.string().optional(), detection_block: z.string().nullish(), app_type_source: z.string().optional() })
      .passthrough().parse(await this.ws.json(filesForProject[1]!));
    if (detection.detection_status === 'incomplete') {
      fail('analysis_incomplete', detection.detection_block?.trim() || 'Project detection reported an incomplete result. Rerun it with the app type it requires.', { app_type: requiredAppType(detection.detection_block) });
    }
    const capability = ({ terminal: 'command_index', mobile: 'screen_index', win32: 'dialog_index', macos: 'view_index' } as Record<string, string>)[map.app_type];
    if (capability && !Object.keys(index.parse(map[capability])).length) fail('invalid_analysis', `Analysis must include a nonempty ${capability}.`);
    if (!capability && (map.app_type !== 'web' || map.dir_map?.routes) && !Object.keys(map.route_index).length) fail('invalid_analysis', 'Analysis must index the project’s user-facing routes or screens.');
    const files = [...filesForProject, `${outputDir}/summary.md`, `${outputDir}/overview.txt`];
    const hashes: Record<string, string> = {};
    for (const file of files) {
      const bytes = await this.ws.read(file, file.endsWith('.css') ? 10 * 1024 * 1024 : 2 * 1024 * 1024);
      if (!bytes.toString('utf8').trim()) fail('invalid_analysis', `Analysis output is empty: ${file}`);
      hashes[file] = sha(bytes);
    }
    return { codebase_dir: codebaseDir, branding, map, detection, hashes, summary: (await this.ws.read(`${outputDir}/summary.md`)).toString(), overview: (await this.ws.read(`${outputDir}/overview.txt`)).toString() };
  }
  async accept(outputDir: string, agent: string, skillsVersion: string, sourceCommit: string | null = null, codebaseDir?: string) {
    const valid = await this.validate(outputDir, codebaseDir);
    await this.ws.writeJson(`${this.root}/setup/analysis.json`, { version: 1, workspace: this.ws.root, output_dir: outputDir,
      codebase_dir: valid.codebase_dir,
      completed_at: new Date().toISOString(), skills_version: skillsVersion, agent, source_commit: sourceCommit, hashes: valid.hashes });
    return valid;
  }
  async analysis() {
    try {
      if (!await this.ws.exists(`${this.root}/setup/analysis.json`)) return { status: 'required' as const };
      const receipt = receiptSchema.parse(await this.ws.json(`${this.root}/setup/analysis.json`));
      if (receipt.workspace !== this.ws.root) return { status: 'required' as const };
      const valid = await this.validate(receipt.output_dir, receipt.codebase_dir);
      // Generator skills legitimately enrich the shared branding/structure cache.
      // The accepted full analysis itself must remain intact.
      if (Object.entries(valid.hashes).some(([file, hash]) => !projectCacheFiles(receipt.codebase_dir).includes(file) && receipt.hashes[file] !== hash)) return { status: 'invalid' as const };
      return { status: 'ready' as const, completed_at: receipt.completed_at, skills_version: receipt.skills_version,
        output_dir: receipt.output_dir, source_commit: receipt.source_commit ?? null,
        codebase_dir: receipt.codebase_dir,
        summary: valid.summary, overview: valid.overview, app_type: valid.map.app_type, framework: valid.branding.framework };
    } catch (error) {
      // Keep the reason: an incomplete detection tells the user exactly what to rerun.
      const safe = publicError(error);
      return { status: 'invalid' as const, error: safe, ...(safe.details && typeof safe.details === 'object' ? safe.details as Record<string, unknown> : {}) };
    }
  }
  async requireAnalysis() {
    const analysis = await this.analysis();
    if (analysis.status !== 'ready') {
      const appType = (analysis as { app_type?: string }).app_type;
      fail('analysis_required', analysis.status === 'invalid' && 'error' in analysis && analysis.error?.message
        ? `Project analysis is not usable: ${analysis.error.message}`
        : 'Analyse this workspace first: run supportpages analyse in its terminal.',
      appType ? { app_type: appType, rerun: `supportpages analyse --app-type ${appType}` } : undefined);
    }
    return analysis;
  }
  async progress() {
    try {
      const task = z.object({ skill: z.enum(['detect-project', 'suggest-sections', 'recommend-articles', 'generate-illustrated-article']),
        status: z.enum(['running', 'completed', 'cancelled', 'failed']), started_at: z.string(), finished_at: z.string().optional(),
        total: z.number().int().optional(), completed: z.number().int().optional(), failed: z.number().int().optional() })
        .parse(await this.ws.json(`${this.root}/setup/task.json`));
      return { ...task, progress_source: 'last_reported' as const };
    } catch { return null; }
  }
  async plan(projectId: string): Promise<LocalPlan> {
    const file = `${this.root}/setup/plan.json`;
    if (!await this.ws.exists(file)) return planSchema.parse({ version: 1, project_id: projectId });
    const plan = planSchema.parse(await this.ws.json(file));
    if (plan.project_id !== projectId) fail('destination_mismatch', 'The local plan belongs to a different help centre.');
    return plan;
  }
  async savePlan(plan: LocalPlan) { await this.ws.writeJson(`${this.root}/setup/plan.json`, planSchema.parse(plan)); }
}
