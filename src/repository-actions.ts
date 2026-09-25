import type { Bridge } from './bridge.js';
import { resolveAction } from './actions.js';
export type RepositoryFeature = 'article_gaps' | 'video_walkthrough';
/** Preserve the requested action through account, permission and repository setup. */
export async function repositoryAction(bridge: Bridge, action: 'find_article_gaps' | 'create_video_walkthrough' | 'connect_repository', feature: RepositoryFeature = 'article_gaps') {
  const requested = action === 'connect_repository' ? feature === 'video_walkthrough' ? 'create_video_walkthrough' : 'find_article_gaps' : action;
  const decision = await resolveAction(bridge, requested);
  return { status: decision.allowed ? 'available' : 'action_required', ...decision,
    instructions: 'Show the action-specific next step and preserve the requested action. The user must approve browser consent. Retry the original action after setup; do not start local analysis or generation.' };
}
