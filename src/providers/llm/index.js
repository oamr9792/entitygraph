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
/**
 * A key that is present but rejected is worse than no key at all.
 *
 * `available()` can only see whether a key was configured, not whether the
 * provider accepts it. With a bad key every call fails, the heuristic fallback
 * never engages because the provider looks available, extraction yields
 * nothing, and the job still reports success — a build that costs real money
 * for the corpus and produces an empty dashboard.
 *
 * So: count consecutive failures and trip a breaker. Past the threshold the
 * provider is treated as unavailable for the rest of the process, which routes
 * work to the heuristic extractor and makes the degradation visible in
 * llmStatus() rather than silent in the results.
 */
const BREAKER_THRESHOLD = 5;
const health = { consecutiveFailures: 0, lastError: null, trippedAt: null };

export const noteLlmFailure = (message) => {
  health.consecutiveFailures += 1;
  health.lastError = String(message ?? '').slice(0, 300);
  if (health.consecutiveFailures >= BREAKER_THRESHOLD && !health.trippedAt) {
    health.trippedAt = new Date().toISOString();
    console.error(
      `[llm] ${config.llm.provider} failed ${health.consecutiveFailures} times in a row — falling back to the heuristic extractor. Last error: ${health.lastError}`
    );
  }
};

export const noteLlmSuccess = () => {
  health.consecutiveFailures = 0;
  health.lastError = null;
  health.trippedAt = null;
};

/** Lets an operator retry a provider after fixing its key without a restart. */
export const resetLlmBreaker = () => noteLlmSuccess();

const breakerTripped = () => Boolean(health.trippedAt);

export function getLlm() {
  const chosen = PROVIDERS[config.llm.provider];
  if (!chosen || !chosen.available() || breakerTripped()) return null;
  return chosen;
}

export function llmStatus() {
  const chosen = PROVIDERS[config.llm.provider] ?? null;
  const configured = Boolean(chosen?.available());
  const degraded = configured && breakerTripped();
  return {
    configured_provider: config.llm.provider,
    // "available" means usable right now, which is what every caller actually
    // wants to know — not merely that someone pasted a key somewhere.
    available: configured && !degraded,
    key_configured: configured,
    degraded,
    // The breaker's own state, independent of whether a provider is configured
    // at all. Reported separately so it can be asserted and displayed without
    // inferring it from two other fields.
    breaker_open: breakerTripped(),
    last_error: health.lastError,
    consecutive_failures: health.consecutiveFailures,
    model: chosen?.model ?? null,
    fallback: configured && !degraded ? null : 'heuristic',
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
    noteLlmSuccess();
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
    noteLlmFailure(err.message);
    recordUsage({ provider: provider.name, endpoint, entityId, jobId, ok: false, detail: err.message });
    throw err;
  }
}
