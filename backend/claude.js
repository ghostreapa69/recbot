// Call scoring and the agent/customer speaker check on Claude, used when ANTHROPIC_API_KEY
// is set (redaction also goes to Claude then, through scriberr.js). Transcription stays on
// the local Scriberr server.
//
// Structured outputs guarantee each reply matches its schema, so the JSON always parses
// and always has the scores. The returned function has the same shape as Scriberr's llm()
// (prompt in, JSON text out), so analysis.js validates either the same way.
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import * as z from 'zod/v4';
import { TOPICS } from './analysis.js';

// Same setting as the redaction path in scriberr.js, so one model does both.
export const CLAUDE_SCORING_MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-5-5';
export const claudeConfigured = Boolean(process.env.ANTHROPIC_API_KEY);

const category = z.object({ score: z.number(), reason: z.string(), quote: z.string(), at: z.string() });
const scores = z.object({
  intro: category,
  retention: category,
  info: category,
  sentiment: category,
  objection: category.extend({ present: z.boolean() }),
  control: category
});

export const SCHEMAS = {
  speaker: z.object({
    agent_speaker: z.string(),
    confidence: z.enum(['high', 'medium', 'low']),
    reason: z.string()
  }),
  analysis: z.object({
    agent_speaker: z.string(),
    summary: z.array(z.string()),
    call_reason: z.string(),
    outcome: z.string(),
    scores,
    topics: z.array(z.enum(TOPICS)),
    keywords: z.array(z.string()),
    key_moments: z.array(z.object({ at: z.string(), label: z.string() })),
    objections: z.array(z.object({ at: z.string(), text: z.string(), handled: z.boolean() })),
    action_items: z.array(z.string()),
    sentiment_timeline: z.array(z.object({ at: z.string(), score: z.number() })),
    coaching_tips: z.array(z.string())
  }),
  scores: z.object({ agent_speaker: z.string(), scores })
};

// Returns llm(prompt, { schema }) -> JSON text. Throws on API errors (the SDK already
// retries 429, 5xx and connection errors twice), on a refusal, or on a cut-off reply.
export function createClaudeLlm({ client = new Anthropic() } = {}) {
  return async (prompt, { schema } = {}) => {
    const format = SCHEMAS[schema];
    if (!format) throw new Error(`Unknown scoring schema "${schema}"`);
    const response = await client.messages.parse({
      model: CLAUDE_SCORING_MODEL,
      max_tokens: 16000,
      output_config: { effort: 'medium', format: zodOutputFormat(format) },
      messages: [{ role: 'user', content: prompt }]
    });
    if (response.stop_reason === 'refusal') {
      throw new Error(`Claude declined to score the call (${response.stop_details?.category || 'no category'})`);
    }
    if (response.stop_reason === 'max_tokens') throw new Error('Claude reply was cut off at max_tokens');
    if (response.parsed_output === null || response.parsed_output === undefined) throw new Error('Claude reply did not match the schema');
    return JSON.stringify(response.parsed_output);
  };
}
