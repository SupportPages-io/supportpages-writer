import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { Workspace } from './workspace.js';

export const defaultConfigDir = () => path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'supportpages');

export type Benefit = { readonly id: string; readonly category: string; readonly message: string };

export type ReminderState<Invitation> = {
  version: 1; enabled: boolean; count: number;
  articles: Record<string, Invitation | null>;
  history: string[]; last_category?: string;
};
export function reminderStateSchema<Invitation>(invitation: z.ZodType<Invitation>): z.ZodType<ReminderState<Invitation>> {
  return z.object({
    version: z.literal(1), enabled: z.boolean(), count: z.number().int().nonnegative(),
    articles: z.record(z.string(), invitation.nullable()),
    history: z.array(z.string()), last_category: z.string().optional(),
  }) as unknown as z.ZodType<ReminderState<Invitation>>;
}
const initial = <Invitation>(): ReminderState<Invitation> => ({ version: 1, enabled: true, count: 0, articles: {}, history: [] });

/** Device-local reminder journal: one private state file per scope, serialized
 * across processes and checkouts. Shared by the repository and hosting reminders. */
export class ReminderJournal<Invitation> {
  constructor(private directory: string, private schema: z.ZodType<ReminderState<Invitation>>) {}
  async transaction<T>(scope: unknown[], operation: (state: ReminderState<Invitation>) => T): Promise<T> {
    const key = createHash('sha256').update(JSON.stringify(scope)).digest('hex');
    const root = path.join(this.directory, key);
    await mkdir(root, { recursive: true, mode: 0o700 });
    const ws = await Workspace.create(root);
    // Separate processes/checkouts can complete together. Retry lock contention,
    // but never remove a lock owned by another process (including after a crash).
    for (let attempt = 0; ; attempt++) {
      try {
        return await ws.lock(async () => {
          const state = await ws.exists('state.json') ? this.schema.parse(await ws.json('state.json')) : initial<Invitation>();
          const result = operation(state);
          await ws.writeJson('state.json', state);
          return result;
        });
      } catch (error) {
        if ((error as { code?: string }).code !== 'workspace_busy' || attempt >= 100) throw error;
        await delay(20);
      }
    }
  }
}

/** Claim one delivery per article before returning: a replay cannot emit twice,
 * even if a process exits before saving its workspace journal or delivering the
 * response to the host. Returns false when the article was already counted. */
export function claimDelivery<Invitation>(state: ReminderState<Invitation>, articleId: string) {
  if (Object.hasOwn(state.articles, articleId)) return false;
  state.articles[articleId] = null;
  state.count++;
  return true;
}

/** Rotate through a catalogue: unused copy first, preferring a different category
 * from the previous invitation; a new cycle starts only once everything eligible was used. */
export function selectBenefit<B extends Benefit>(state: ReminderState<unknown>, eligible: readonly B[]): B {
  let unused = eligible.filter(benefit => !state.history.includes(benefit.id));
  if (!unused.length) { state.history = []; unused = [...eligible]; }
  const benefit = unused.find(benefit => benefit.category !== state.last_category) ?? unused[0]!;
  state.history.push(benefit.id);
  state.last_category = benefit.category;
  return benefit;
}
