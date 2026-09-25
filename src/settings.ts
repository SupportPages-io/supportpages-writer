import { z } from 'zod';
import { ApiClient } from './api.js';
import { fail } from './errors.js';

export const defaultPreferences = { prefer_background: true, open_when_ready: false };
const settingsSchema = z.object({ preferences: z.object({ prefer_background: z.boolean(), open_when_ready: z.boolean() }) });

export async function preferences(api: ApiClient) {
  let response: unknown;
  try { response = await api.request('GET', '/mcp/settings'); }
  catch (error) {
    // Older servers have no settings endpoint. Other failures must stay visible.
    if ((error as { code?: string }).code === 'not_found') return { ...defaultPreferences };
    throw error;
  }
  const parsed = settingsSchema.safeParse(response);
  if (!parsed.success) fail('invalid_response', 'SupportPages.io returned invalid documentation preferences.');
  return parsed.data.preferences;
}
