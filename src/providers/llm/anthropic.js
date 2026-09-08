import config from '../../config.js';
import { request, ProviderError } from '../http-client.js';

/**
 * Anthropic Messages API, over raw HTTP.
 *
 * Why raw HTTP rather than @anthropic-ai/sdk: this application has zero npm
 * dependencies by design, and it uses exactly one endpoint. The request shape
 * below follows the documented wire format for strict tool use; if this file
 * ever needs streaming, batching or the Files API, install the SDK instead of
 * growing this.
 *
 * Structured output uses **forced strict tool use** (§65): one tool whose
 * input_schema is the output schema, `strict: true`, and `tool_choice` pinned
 * to it. The model cannot reply with prose, and the input validates exactly.
 *
 * A NOTE ON §65's "temperature 0"
 * -------------------------------
 * The brief asks for temperature 0 for determinism. Current Claude models
 * (Opus 5, Sonnet 5, Fable 5, Opus 4.7/4.8) removed the sampling parameters
 * and reject `temperature` with a 400. Determinism now comes from the strict
 * schema, a pinned tool choice, and a fixed effort level instead. We send
 * `temperature` only to models that still accept it, so setting an older model
 * in .env keeps the original behaviour.
 */

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

// $ per 1M tokens. Used for the cost ledger (§66) and the per-entity ceiling.
const PRICING = {
  'claude-opus-5': { in: 5, out: 25 },
  'claude-opus-4-8': { in: 5, out: 25 },
  'claude-opus-4-7': { in: 5, out: 25 },
  'claude-opus-4-6': { in: 5, out: 25 },
  'claude-fable-5': { in: 10, out: 50 },
  'claude-sonnet-5': { in: 2, out: 10 },
  'claude-sonnet-4-6': { in: 3, out: 15 },
  'claude-haiku-4-5': { in: 1, out: 5 },
};

// Models that removed the sampling parameters.
const NO_SAMPLING = /^claude-(opus-5|opus-4-[678]|sonnet-5|fable-5|mythos-5)/;

export function estimateCost(model, usage = {}) {
  const price = PRICING[model] ?? PRICING['claude-opus-5'];
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  // Cache reads bill at roughly a tenth of input; cache writes at 1.25x.
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  return (
    (input * price.in + cacheWrite * price.in * 1.25 + cacheRead * price.in * 0.1 + output * price.out) / 1_000_000
  );
}

export const anthropicProvider = {
  name: 'anthropic',
  get model() {
    return config.llm.anthropicModel;
  },
  available: () => Boolean(config.llm.anthropicKey),

  /**
   * One structured call. `schema` is a JSON Schema object describing the
   * result; the parsed, validated tool input comes back as `data`.
   *
   * `cacheSystem` puts a cache breakpoint at the end of the system prompt.
   * Extraction sends the same system prompt (taxonomy + identity profile) for
   * every document in a corpus, so this is the difference between paying for
   * those tokens once per entity and paying for them thousands of times.
   */
  async json({ system, user, schema, schemaName = 'result', schemaDescription = '', maxTokens = 4000, effort = 'low', cacheSystem = true }) {
    if (!config.llm.anthropicKey) {
      throw new ProviderError('ANTHROPIC_API_KEY is not set.', { provider: 'anthropic', status: 412 });
    }
    const model = config.llm.anthropicModel;

    const body = {
      model,
      max_tokens: maxTokens,
      system: [
        {
          type: 'text',
          text: system,
          ...(cacheSystem ? { cache_control: { type: 'ephemeral' } } : {}),
        },
      ],
      messages: [{ role: 'user', content: user }],
      tools: [
        {
          name: schemaName,
          description: schemaDescription || `Return the extraction result as ${schemaName}.`,
          input_schema: schema,
          strict: true,
        },
      ],
      tool_choice: { type: 'tool', name: schemaName },
      output_config: { effort },
      ...(NO_SAMPLING.test(model) ? {} : { temperature: 0 }),
    };

    const res = await request('anthropic', API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': config.llm.anthropicKey,
        'anthropic-version': API_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    // A safety decline is an HTTP 200 with stop_reason "refusal", not an error.
    if (res?.stop_reason === 'refusal') {
      throw new ProviderError(
        `Anthropic declined this passage (${res.stop_details?.category ?? 'unspecified'}).`,
        { provider: 'anthropic', status: 422, body: res.stop_details }
      );
    }

    const toolUse = (res?.content ?? []).find((b) => b.type === 'tool_use');
    if (!toolUse) {
      throw new ProviderError('Anthropic returned no structured result', { provider: 'anthropic', body: res });
    }

    return {
      data: toolUse.input,
      model,
      tokens_in: res.usage?.input_tokens ?? 0,
      tokens_out: res.usage?.output_tokens ?? 0,
      cache_read: res.usage?.cache_read_input_tokens ?? 0,
      cost: estimateCost(model, res.usage ?? {}),
    };
  },
};

export default anthropicProvider;
