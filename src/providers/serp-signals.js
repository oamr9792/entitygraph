/**
 * What Google itself associates with a query, beyond the organic results.
 *
 * The organic page is one surface. Google also states its associations
 * directly: the searches it relates to this one, the questions it expects
 * people to ask next, and the facts it puts in the knowledge panel. These
 * routinely disagree with each other and with the organic page. For one
 * lawyer the related searches were his firm, his university and his net worth,
 * the knowledge panel described a law-firm career, and roughly a fifth of the
 * organic results were about a former client. All three are "what Google
 * associates", on different surfaces — so they are kept apart and never
 * averaged into one number that would hide the disagreement.
 *
 * The DataForSEO SERP response already contains all of this. The pipeline paid
 * for it on every build and threw it away.
 */
export function parseSerpSignals(items = []) {
  const list = (value) => (Array.isArray(value) ? value : []);
  const strings = (value) =>
    list(value).filter((s) => typeof s === 'string' && s.trim()).map((s) => s.trim());

  const relatedSearches = items
    .filter((i) => i?.type === 'related_searches')
    .flatMap((i) => strings(i.items));

  const peopleAlsoAsk = items
    .filter((i) => i?.type === 'people_also_ask')
    .flatMap((i) => list(i.items).map((q) => q?.title).filter(Boolean));

  const peopleAlsoSearch = items
    .filter((i) => i?.type === 'people_also_search')
    .flatMap((i) => list(i.items).map((x) => (typeof x === 'string' ? x : x?.title)).filter(Boolean));

  const topStories = items
    .filter((i) => i?.type === 'top_stories')
    .flatMap((i) =>
      list(i.items).map((s) => ({
        title: s?.title ?? null,
        url: s?.url ?? null,
        source: s?.source ?? s?.domain ?? null,
      }))
    )
    .filter((s) => s.title);

  const kg = items.find((i) => i?.type === 'knowledge_graph');
  const knowledgeGraph = kg
    ? {
        title: kg.title ?? null,
        subtitle: kg.subtitle ?? null,
        description: kg.description ?? null,
        facts: list(kg.items)
          .filter((x) => x?.type === 'knowledge_graph_row_item' && x.text)
          .map((x) => ({ label: x.title ?? null, text: x.text })),
        sources: [
          ...new Set(
            list(kg.items)
              .flatMap((x) => list(x?.links))
              .map((l) => l?.domain)
              .filter(Boolean)
          ),
        ],
      }
    : null;

  return {
    related_searches: [...new Set(relatedSearches)],
    people_also_ask: [...new Set(peopleAlsoAsk)],
    people_also_search: [...new Set(peopleAlsoSearch)],
    top_stories: topStories,
    knowledge_graph: knowledgeGraph,
  };
}

// Related searches for a person are dominated by celebrity-profile furniture —
// net worth, wife, height, religion. These describe what people are curious
// about, not what the person is associated with, and probing the corpus for
// "Jay Lefkowitz" + "wife" would spend budget finding gossip pages.
const GENERIC_PROFILE_TERMS = new Set([
  'net worth', 'worth', 'wife', 'husband', 'spouse', 'married', 'marriage', 'age',
  'height', 'weight', 'salary', 'income', 'religion', 'ethnicity', 'nationality',
  'bio', 'biography', 'wiki', 'wikipedia', 'instagram', 'twitter', 'linkedin',
  'facebook', 'tiktok', 'youtube', 'email', 'phone', 'address', 'contact',
  'family', 'children', 'kids', 'son', 'daughter', 'parents', 'father', 'mother',
  'brother', 'sister', 'girlfriend', 'boyfriend', 'dating', 'news', 'today',
  'latest', 'photos', 'photo', 'images', 'pictures', 'birthday', 'born', 'house',
  'home', 'hometown', 'car', 'cars', 'education', 'career', 'profile', 'dead',
  'death', 'died', 'alive', 'young', 'now', 'website',
]);

/**
 * Subjects worth probing the corpus for, taken from what Google relates to the
 * name.
 *
 * A related search like "Jay Lefkowitz Columbia" is Google reporting that people
 * look for that subject alongside the entity. Removing the entity's own name
 * leaves the subject, which becomes a paired corpus probe — so the corpus is
 * searched for what Google associates, not only for what an analyst thought to
 * type in.
 */
export function probeTermsFromSignals(signals, names = [], { limit = 8 } = {}) {
  if (!signals) return [];
  const stripEnds = (token) => token.replace(/^[^\p{L}\p{N}&]+|[^\p{L}\p{N}&]+$/gu, '');
  const nameTokens = new Set(
    names
      .flatMap((n) => String(n ?? '').split(/[\s,]+/))
      .map((t) => stripEnds(t).toLowerCase())
      .filter(Boolean)
  );

  const out = [];
  for (const phrase of [...(signals.related_searches ?? []), ...(signals.people_also_search ?? [])]) {
    const kept = String(phrase)
      .split(/[\s,]+/)
      .map(stripEnds)
      .filter((t) => t && !nameTokens.has(t.toLowerCase()));
    if (!kept.length || kept.length > 4) continue;

    const term = kept.join(' ');
    const lower = term.toLowerCase();
    if (GENERIC_PROFILE_TERMS.has(lower)) continue;
    if (kept.every((t) => GENERIC_PROFILE_TERMS.has(t.toLowerCase()))) continue;
    if (/^\d+$/.test(term) || term.length < 3) continue;
    if (out.some((existing) => existing.toLowerCase() === lower)) continue;

    out.push(term);
    if (out.length >= limit) break;
  }
  return out;
}
