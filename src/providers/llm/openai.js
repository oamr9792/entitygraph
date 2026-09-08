import config from '../../config.js';
import { request, ProviderError } from '../http-client.js';

/**
 * OpenAI chat completions with a json_schema response format.
 *
 * Present because §64 requires the NLP layer to be a provider abstraction and
 * not a coupling. It is a second implementation of the same interface, kept
 * deliberately thin.
 */

const API_URL = 'https://api.openai.com/v1/chat/completions';

const PRICING = {
  'gpt-4o-mini': { in: 0.15, out: 0.6 },
  'gpt-4o': { in: 2.5, out: 10 },
};

export const openaiProvider = {
  name: 'openai',
  get model() {
    return config.llm.openaiModel;
  },
  available: () => Boolean(config.llm.openaiKey),

  async json({ system, user, schema, schemaName = 'result', maxTokens = 4000 }) {
    if (!config.llm.openaiKey) {
      throw new ProviderError('OPENAI_API_KEY is not set.', { provider: 'openai', status: 412 });
    }
    const model = config.llm.openaiModel;
    const res = await request('openai', API_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.llm.openaiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_completion_tokens: maxTokens,
        temperature: 0,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: schemaName, schema, strict: true },
        },
      }),
    });

    const content = res?.choices?.[0]?.message?.content;
    if (!content) throw new ProviderError('OpenAI returned no content', { provider: 'openai', body: res });
    let data;
    try {
      data = JSON.parse(content);
    } catch {
      throw new ProviderError('OpenAI returned unparseable JSON', { provider: 'openai', body: content.slice(0, 400) });
    }

    const price = PRICING[model] ?? PRICING['gpt-4o-mini'];
    const tokensIn = res.usage?.prompt_tokens ?? 0;
    const tokensOut = res.usage?.completion_tokens ?? 0;
    return {
      data,
      model,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      cache_read: 0,
      cost: (tokensIn * price.in + tokensOut * price.out) / 1_000_000,
    };
  },
};

export default openaiProvider;
