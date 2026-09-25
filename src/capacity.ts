import type { z } from 'zod';
import { articleCapacitySchema } from './schema.js';
import { fail } from './errors.js';

export type ArticleCapacity = z.infer<typeof articleCapacitySchema>;
export function capacityMessage(capacity: ArticleCapacity) {
  return `This account is using ${capacity.used} of ${capacity.limit} article hosting slots across all its help centres. Drafts also count; deleted articles do not. Upgrade your account: ${capacity.upgrade_url} · Manage help centres and articles: ${capacity.manage_articles_url}`;
}
export function checkArticleCapacity(capacity?: ArticleCapacity) {
  if (!capacity) fail('server_update_required', 'Update the SupportPages.io server before generating this article: it does not provide the article capacity check yet.');
  if (!capacity.can_create) fail('plan_limit', `Article generation has not started. ${capacityMessage(capacity)} Free up space or upgrade, then ask to try again.`, { article_capacity: capacity });
}
