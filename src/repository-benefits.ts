import path from 'node:path';
import { z } from 'zod';
import { repositoryConnectionSchema } from './schema.js';
import { ReminderJournal, claimDelivery, defaultConfigDir, reminderStateSchema, selectBenefit, type ReminderState } from './reminders.js';

export const repositoryInvitationSchema = z.object({ id: z.string(), message: z.string(), connect_url: z.url() });
export type RepositoryInvitation = z.infer<typeof repositoryInvitationSchema>;
export const repositoryBenefits = [
  { id: 'agent_allowance', category: 'usage', message: 'Keep your coding-agent allowance for building your product. Generate future articles using your SupportPages.io plan’s AI allowance.' },
  { id: 'documentation_allowance', category: 'usage', message: 'Let SupportPages.io spend its AI allowance on your documentation, while you keep your coding-agent usage for your product.' },
  { id: 'next_article_allowance', category: 'usage', message: 'Your next article can use your SupportPages.io plan’s AI allowance. Connect your repository to generate it in the web app.' },
  { id: 'elapsed_generation', category: 'hosted', message: 'This draft was ready in {duration}. Next time, let SupportPages.io handle generation without keeping your local coding agent running.' },
  { id: 'web_generation', category: 'hosted', message: 'Create your next article directly in SupportPages.io, without opening a local coding-agent session.' },
  { id: 'background_generation', category: 'hosted', message: 'Let SupportPages.io generate articles in the background while you carry on building your product.' },
  { id: 'topic_discovery', category: 'discovery', message: 'Not sure what to document next? SupportPages.io can suggest articles based on your product’s features.' },
  { id: 'coverage_gaps', category: 'discovery', message: 'Discover features your help centre doesn’t cover yet, with suggestions based on your repository.' },
  { id: 'section_suggestions', category: 'organisation', message: 'Give your help centre a clearer structure with section suggestions based on your product.' },
  { id: 'organisation', category: 'organisation', message: 'Help customers find the right answer by organising your articles into help-centre sections.' },
  { id: 'change_tracking', category: 'maintenance', message: 'Turn merged pull requests into suggestions for documentation your customers might need.' },
  { id: 'weekly_analysis', category: 'maintenance', message: 'Prefer a regular catch-up? Connect your repository and choose weekly analysis of merged pull requests.' },
  { id: 'maintenance', category: 'maintenance', message: 'Spot articles that need updating by comparing your documentation with your code.' },
  { id: 'automatic_drafts', category: 'automation', message: 'Choose automatic draft generation to turn article suggestions into drafts you can review before publishing.' },
  { id: 'batch_generation', category: 'automation', message: 'Work through your documentation backlog by generating multiple suggested articles from the web app.' },
] as const;

/** The exact paragraph the agent shows after a draft review link: the benefit, then the link. */
export const repositoryShowText = (invitation: RepositoryInvitation) =>
  `${invitation.message} [Connect repository](${invitation.connect_url})`;

export function articleDuration(start?: string, ready?: string) {
  if (!start || !ready) return;
  const minutes = Math.floor((Date.parse(ready) - Date.parse(start)) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 5) return;
  const hours = Math.floor(minutes / 60), remainder = minutes % 60;
  return hours ? `${hours} hour${hours === 1 ? '' : 's'}${remainder ? ` ${remainder} minute${remainder === 1 ? '' : 's'}` : ''}` : `${minutes} minutes`;
}

const stateSchema = reminderStateSchema(repositoryInvitationSchema);
type State = ReminderState<RepositoryInvitation>;

/** Device-local preferences and deduplication, shared by all checkouts of a help centre. */
export class RepositoryReminders {
  private journal: ReminderJournal<RepositoryInvitation>;
  constructor(configDir = defaultConfigDir()) {
    this.journal = new ReminderJournal(path.join(configDir, 'repository-reminders'), stateSchema);
  }
  private transaction<T>(origin: string, projectId: string, operation: (state: State) => T) {
    return this.journal.transaction([new URL(origin).origin, projectId], operation);
  }
  preference(origin: string, projectId: string, enabled?: boolean) {
    return this.transaction(origin, projectId, state => {
      if (enabled !== undefined) state.enabled = enabled;
      return { enabled: state.enabled, api_origin: origin, project_id: projectId, scope: 'help_centre_on_this_device' };
    });
  }
  complete(input: { origin: string; projectId: string; articleId: string; connection?: z.infer<typeof repositoryConnectionSchema>; firstWriterStartedAt?: string; readyAt?: string }) {
    return this.transaction(input.origin, input.projectId, state => {
      if (!claimDelivery(state, input.articleId)) return;
      if (!state.enabled || (state.count - 1) % 3 !== 0 || input.connection?.state !== 'not_connected') return;
      const duration = articleDuration(input.firstWriterStartedAt, input.readyAt);
      const benefit = selectBenefit(state, repositoryBenefits.filter(benefit => benefit.id !== 'elapsed_generation' || duration));
      const invitation = { id: benefit.id, message: benefit.message.replace('{duration}', duration ?? ''), connect_url: input.connection.connect_url };
      state.articles[input.articleId] = invitation;
      return invitation;
    });
  }
}
