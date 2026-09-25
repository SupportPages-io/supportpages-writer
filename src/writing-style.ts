// Local workspaces have no server to compose writing guidance. These four tone
// presets mirror the SupportPages.io WritingStyle module so a locally written article sounds
// the same as one generated for a help centre with the same setting.
export const writingStylePresets: Record<string, { label: string; hint: string }> = {
  friendly: { label: 'Friendly & conversational', hint: 'Warm, everyday language' },
  minimal: { label: 'Minimal & scannable', hint: 'Short explanations and easy-to-scan steps' },
  technical: { label: 'Technical & precise', hint: 'Detailed explanations with precise terminology' },
  formal: { label: 'Formal & professional', hint: 'Professional language with a more reserved tone' },
};

const toneGuidance: Record<string, string> = {
  technical: [
    'Voice: precise and authoritative. Assume the reader is comfortable with software and wants accuracy over reassurance.',
    'Vocabulary: exact terminology — real field names, menu paths, error codes, and feature names. Don\'t soften technical terms.',
    'Sentence structure: short, declarative sentences. State the action and its target directly.',
    'Point of view: address the reader as "you", but skip pleasantries and filler.',
    'Do: "Configure the SMTP relay with TLS enabled." / "Set the retention window in **Settings → Data**."',
    'Don\'t: "Let\'s get your email all set up!" / "Don\'t worry, this part is easy."',
  ].join('\n'),
  friendly: [
    'Voice: warm and conversational, but never saccharine. Helpful colleague, not a marketing campaign.',
    'Vocabulary: everyday language over jargon — "set up" rather than "configure", "turn on" rather than "enable" where it reads naturally.',
    'Sentence structure: brief and natural. One friendly sentence beats three wordy ones.',
    'Point of view: address the reader directly as "you".',
    'Do: "Open **Settings** and pick the workspace you want to share." / "You\'re all set — changes save automatically."',
    'Don\'t: "We\'re SO excited for you to try this amazing feature!" / corporate cheerfulness or exclamation pile-ups.',
  ].join('\n'),
  minimal: [
    'Voice: terse quick-reference, not a tutorial. Every word earns its place.',
    'Vocabulary: plain and concrete. Name the control, name the action, stop.',
    'Sentence structure: sentence fragments and imperative verbs. No introductions, transitions, or encouragement.',
    'Point of view: implied "you" through imperatives.',
    'Do: "Click **Save**." / "Enter your email." / "Select a plan."',
    'Don\'t: "Now that you\'ve done that, the next thing you\'ll want to do is…" / any framing or wind-up.',
  ].join('\n'),
  formal: [
    'Voice: neutral and authoritative. Suitable for compliance or regulated contexts.',
    'Vocabulary: complete, proper terms. No slang, no casual asides, no contractions ("do not", not "don\'t").',
    'Sentence structure: complete, well-formed sentences — but concise; formal does not mean verbose.',
    'Point of view: address the reader as "you" or use neutral phrasing ("Users may…"); maintain a professional distance.',
    'Do: "Select **Save** to apply your changes." / "Ensure the certificate is valid before proceeding."',
    'Don\'t: "Just hit save and you\'re good to go." / emoji, slang, or jokey asides.',
  ].join('\n'),
};

export const defaultWritingStyle = 'friendly';

/** A preset keyword expands to its guidance; anything else is free-form guidance used verbatim. */
export function composeWritingStyle(tone?: string | null): string {
  const key = (tone ?? '').trim().toLowerCase();
  if (!key) return toneGuidance[defaultWritingStyle]!;
  return toneGuidance[key] ?? tone!.trim();
}
