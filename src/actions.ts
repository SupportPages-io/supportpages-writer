import { z } from 'zod';
import type { Bridge } from './bridge.js';
import { fail, publicError } from './errors.js';

export const writerAction = z.enum(['read_articles', 'create_article', 'update_article', 'edit_article', 'publish_article', 'unpublish_article', 'delete_article', 'find_article_gaps', 'suggest_sections', 'recommend_articles', 'review_sections', 'review_recommendations', 'create_video_walkthrough', 'get_operation']);
export type WriterAction = z.infer<typeof writerAction>;
export const actionDecisionSchema = z.object({ action: writerAction, allowed: z.boolean(), execution: z.enum(['local', 'remote', 'hosted']), required_scopes: z.array(z.string()),
  next_step: z.object({ code: z.string().max(100), message: z.string().max(1000), requested_action: writerAction, missing_scopes: z.array(z.enum(['read', 'import', 'publish', 'manage', 'generate'])).optional(), url: z.url().optional() }).nullable(),
}).refine(value => value.allowed === (value.next_step === null));
export const writerCapabilitiesSchema = z.object({ version: z.literal(1), actions: z.record(writerAction, actionDecisionSchema) });
export type ActionDecision = z.infer<typeof actionDecisionSchema>;

const blocked = (action: WriterAction, code: string, message: string): ActionDecision => ({ action, allowed: false, execution: 'remote', required_scopes: [], next_step: { code, message, requested_action: action } });

/** Both terminal and MCP entrypoints use this read-only dispatcher. It never
 * starts authentication or replaces hosted work with a local writer. */
export async function resolveAction(bridge: Bridge, action: WriterAction, articleId?: string): Promise<ActionDecision> {
  writerAction.parse(action);
  const destination = await bridge.destination();
  if (action === 'create_article' && (destination === 'local' || destination === 'none' && !bridge.api.configured())) {
    return { action, allowed: true, execution: 'local', required_scopes: [], next_step: null };
  }
  if (!bridge.api.configured()) return blocked(action, 'authentication_required', 'Sign in or create an account with supportpages login, then select a help centre and retry this action.');
  try {
    if (destination !== 'hosted') {
      await bridge.listProjects(); // Validate credentials before asking for a project.
      return blocked(action, 'project_required', 'Select or create a help centre with supportpages_init, then retry this action.');
    }
    const context = await bridge.context();
    let decision = context.repository_connection?.writer?.actions[action];
    if (articleId) {
      if (!/^[1-9][0-9]*$/.test(articleId)) fail('invalid_article', 'Choose an article ID from this project.');
      const response = z.object({ version: z.literal(1), decision: actionDecisionSchema }).safeParse(await bridge.api.request('GET', `/projects/${context.project.id}/writer/capabilities?action_name=${action}&article_id=${articleId}`));
      if (!response.success) fail('invalid_response', 'The server returned an invalid action decision.');
      decision = response.data.decision;
    }
    // Preserve legacy local authoring only when the server explicitly confirms
    // there is no repository. Unknown or broken servers never imply local work.
    if (!decision && action === 'create_article' && context.repository_connection?.state === 'not_connected') {
      return { action, allowed: true, execution: 'local', required_scopes: ['read', 'import'], next_step: null };
    }
    if (!decision) return blocked(action, 'server_update_required', 'Update the SupportPages server and Writer to use this action. The server did not advertise a supported action contract.');
    if (decision.action !== action || decision.next_step && decision.next_step.requested_action !== action) fail('invalid_response', 'The server returned a decision for another action.');
    if (decision.next_step?.url) {
      const url = new URL(decision.next_step.url);
      const transport = new URL(bridge.api.origin);
      const developmentUpgrade = bridge.api.dev && transport.hostname === url.hostname && url.protocol === 'https:';
      if ((url.origin !== bridge.api.origin && !developmentUpgrade) || url.username || url.password) fail('invalid_response', 'The server returned an invalid recovery link.');
    }
    return decision;
  } catch (error) {
    const safe = publicError(error);
    if (safe.code === 'invalid_credentials') return blocked(action, 'authentication_required', 'Device sign-in has expired or was revoked. Sign in again, then retry this action.');
    if (safe.code === 'not_found') return blocked(action, 'resource_unavailable', 'This project or article is unavailable. Restore access or select an accessible resource before retrying.');
    throw error;
  }
}

export function requireExecution(decision: ActionDecision, execution: ActionDecision['execution']) {
  if (!decision.allowed) {
    const next = decision.next_step!;
    const guidance = next.url ? ` Open: ${next.url}` : next.missing_scopes?.length ? ` Run supportpages login --scopes ${next.missing_scopes.join(',')}, or use supportpages_request_permissions.` : '';
    fail(next.code, next.message + guidance, { writer_action: decision });
  }
  if (decision.execution !== execution) fail('hosted_action_required', 'This action runs in SupportPages. Use the hosted action tool; do not launch a local writer.', { writer_action: decision });
}
