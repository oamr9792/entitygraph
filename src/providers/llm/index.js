import config from '../../config.js';
import { recordUsage } from '../http-client.js';
import anthropicProvider from './anthropic.js';
import openaiProvider from './openai.js';

/**
 * §64 — the NLP provider abstraction. Business logic (what to extract, what
 * counts as an association, how confidence is scored) lives in services/, not
 * here. This module knows only how to turn a prompt plus a schema into
 * validated JSON, and how to record what that cost.
 */

const PROVIDERS = {
  anthropic: anthropicProvider,
  openai: openaiProvider,
};

/**
 * Returns the configured provider, or null when the pipeline should fall back
 * to the deterministic non-LLM extractor. Null is a supported state, not an
 * error: the corpus, disambiguation, duplicate and scoring stages all work
 * without a key, and refusing to run any of them because one stage is
 * unconfigured would make the tool untestable.
 */
export function getLlm() {
  const chosen = PROVIDERS[config.llm.provider];
  if (!chosen || !chosen.available()) return null;
  return chosen;
}

export function llmStatus() {
  const chosen = PROVIDERS[config.llm.provider] ?? null;
  return {
    configured_provider: config.llm.provider,
    available: Boolean(chosen?.available()),
    model: chosen?.model ?? null,
    fallback: chosen?.available() ? null : 'heuristic',
    providers: Object.values(PROVIDERS).map((p) => ({ name: p.name, available: p.available(), model: p.model })),
  };
}

/**
 * Calls the provider and books the cost against the entity, so §66's ceilings
 * see LLM spend and API spend in the same ledger.
 */
export async function llmJson(args, { entityId = null, jobId = null, endpoint = 'llm' } = {}) {
  const provider = getLlm();
  if (!provider) return null;
  try {
    const res = await provider.json(args);
    recordUsage({
      provider: provider.name,
      endpoint,
      entityId,
      jobId,
      costUsd: res.cost ?? 0,
      tokensIn: res.tokens_in ?? 0,
      tokensOut: res.tokens_out ?? 0,
    });
    return res;
  } catch (err) {
    recordUsage({ provider: provider.name, endpoint, entityId, jobId, ok: false, detail: err.message });
    throw err;
  }
}
