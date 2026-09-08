# EntityGraph

An entity-association intelligence platform: given a person or organisation, it
builds a measurable map of the concepts, organisations, people, events and
topics the observable web associates with them — and separates three things
that are routinely conflated.

> **What has the web historically associated with this entity?** — Historical Association Score
> **What is the web associating with it now?** — Current Entity Score
> **What is Google currently surfacing?** — Google Retrieval Score

The product is the difference between those three.

---

## What this is not

**PIAS is not Google's association score.** It is a *Patent-Inspired Association
Score*: an external estimate that approximates factors described in Google
patents (US10198491B1, US8682913B1, US9830390B2, US9336211B1, US9189526B1)
using observable web data. Google's internal weights are unknown and are not
reproduced here. Every screen carries this sentence:

> This is an external estimate of entity-association strength. It does not expose Google's internal Knowledge Graph or ranking scores.

Three specific disclaimers are built into the code, not just the copy:

- **Source reliability is not Domain Authority.** It is an *External Source
  Reliability Proxy* blending domain rank, URL rank, citation prominence and a
  source classification, with human override. It is not a measure of Google's
  trust.
- **The query-behaviour variable from US9830390B2 is never estimated.** Later
  searches involving related entities are not observable from outside Google,
  so `query_behavior_score` is `null` and stays `null`.
- **Every weight in the model is ours.** They live in one object
  (`MODEL` in `src/config.js`) so §56's empirical calibration can replace them
  without touching scoring code.

---

## Running it

Node 22.5 or later. **No dependencies** — `node:sqlite`, `node:crypto` and
`node:http` do all the work.

```bash
cd entitygraph
cp .env.example .env
npm start
```

Then <http://127.0.0.1:8788>.

```bash
npm run demo          # full pipeline on a synthetic corpus — no keys, no spend
npm test              # 52 tests, including §73's success criteria
npm run dev           # auto-restart on change
npm run reset -- --yes
```

**Start with `npm run demo`.** It runs the entire pipeline offline against a
corpus built to exercise the mechanisms that are easy to get wrong: a press
release syndicated across four domains, three separate articles on one domain,
a stale high-volume lawsuit, a fresh philanthropy story, and three documents
about a different John Smith. It prints the leaderboard, the duplicate
handling, the disambiguation rejections, the old-vs-current split, the Google
overlay and the written summary.

### Credentials

Both go in `.env`.

| Key | Powers | Where |
|---|---|---|
| `DATAFORSEO_LOGIN` / `DATAFORSEO_PASSWORD` | Corpus discovery (§9), phrase trends (§11), SERP (§13) | [app.dataforseo.com/api-access](https://app.dataforseo.com/api-access) — the password is the **API password** on that page, not your account login password |
| `ANTHROPIC_API_KEY` | Association extraction (§16), disambiguation adjudication, SERP classification | console.anthropic.com |

**Neither is required to run.** Without DataForSEO you can still import URLs
manually and use every scoring and analysis screen. Without an LLM key the
pipeline falls back to a deterministic heuristic extractor — materially lower
precision, disclosed in the coverage panel and stamped on every evidence row it
writes.

---

## The pipeline (§67)

```
CREATE ENTITY → BUILD IDENTITY PROFILE → FETCH ENTITY CITATIONS →
FETCH CORPUS HISTORY → FETCH EVIDENCE WINDOWS → ENTITY DISAMBIGUATION →
EXTRACT ASSOCIATIONS → CANONICALISE ASSOCIATIONS → DETECT DUPLICATES →
CALCULATE DOCUMENT SCORES → CALCULATE ASSOCIATION SCORES →
RUN SERP QUERIES → GENERATE DASHBOARD
```

Each step reports progress and is individually skippable. The job queue is a
single in-process worker over a SQLite-backed table: jobs survive a restart,
progress is visible while one runs, and two builds of the same entity cannot
interleave.

### The five mechanisms that carry the product

**1. Disambiguation (§6, §8).** A noisy-OR over identity markers. Evidence
accumulates towards 1.0 without reaching it, and a bare name with no supporting
marker scores near zero rather than near a half — the null hypothesis for a
common name is "different person", and a document has to earn its way out.
Calibrated against §8's worked examples:

| Passage | Brief | This system |
|---|---|---|
| "John Smith, founder of ABC Capital…" | 0.99 | 0.97 accept |
| "New York businessman John Smith…" | 0.75 | 0.74 accept |
| "John Smith scored twice Saturday…" | 0.02 | 0.05 reject |

**2. Independence (§21, §22).** The corroboration patent's whole point is that
forty syndicated copies are not forty pieces of evidence. Documents are
fingerprinted three ways (canonical URL, content hash, simhash confirmed by
MinHash), clustered, and weighted: the original keeps 1.0, an exact duplicate
gets 0, a syndicated near-duplicate 0.2, a second genuine article on the same
domain 0.35. The demo shows five copies of one release contributing exactly 1.0
independent sources.

**3. Proximity (§24, §25).** Token distance blended with grammatical boundary,
because neither is sufficient alone: 30 tokens inside one sentence means more
than 30 tokens across a paragraph break. A comma does **not** break a clause —
the strongest association pattern in this corpus is the appositive ("John
Smith, founder of ABC Capital"), and treating its comma as a clause break would
systematically under-score the clearest evidence available.

**4. Recency (§29, §30, §36).** Five discrete windows *and* a continuous
half-life decay, switchable between 180/365/730 days. The current score is a
ratio of decayed to undecayed evidence, not "days since the newest document" —
one fresh article does not make a stale association current.

**5. Repetition cap (§32).** One article saying "philanthropy" ten times is one
confident document, not ten. Weights are 1.0, +0.2, +0.1, then nothing. Raw
mention counts stay visible; weighted evidence does not scale with them.

---

## Scores (§79)

| Metric | Meaning |
|---|---|
| **PIAS** | Patent-Inspired Association Score, lifetime. 30% independent corroboration + 25% authority-weighted evidence + 20% recency + 15% relationship/proximity + 10% corpus share |
| **CES** | Current Entity Score — the same model over the current window only |
| **HAS** | Historical Association Score — evidence older than the current window |
| **ACS** | Association Corpus Share — documents carrying the association ÷ documents confidently about the entity |
| **AM** | Association Momentum — share-adjusted change over the last period against the one before |
| **GRS** | Google Retrieval Score — share of the classified first-page weight |

**PIAS is a within-entity ranking.** Every component is normalised against the
strongest association for the same entity, so the leader always lands near 100
whether the corpus holds 40 documents or 40,000. Comparing PIAS across entities
is meaningless; Coverage Confidence is what tells you how much a ranking is
worth.

### One thing worth understanding about the corpus/Google comparison

Corpus share (§37) is a share of *documents*, and one document supports several
associations, so those shares sum well past 100%. GRS is a share of first-page
weight and sums to 100%. Comparing them directly makes every association look
under-served. So the gap in the Google overlay is computed against each
association's share of the entity's total **association evidence mass**, which
sums to 100% by construction. Corpus share is still reported, unchanged, beside
it.

---

## Screens

| Screen | Brief | What it answers |
|---|---|---|
| Dashboard | §44, §45 | Current entity state header and the sortable leaderboard |
| Graph | §46 | Radial entity graph, node size and edge thickness by PIAS, edge colour by sentiment, year slider |
| Timeline | §47 | Association share of each month's evidence — current-state replacement, visually |
| Old vs current | §50 | The same corpus split at a date you choose |
| Compare | §51 | Two associations on every metric |
| Google overlay | §52, §53, §77 | What Google retrieves versus what the corpus says |
| Gaps & priorities | §59, §60 | Defend / build / monitor / historical / risk |
| Evidence explorer | §48 | Every supporting source, every factor, with include/exclude/wrong-entity actions |
| Review queue | §8, §74 | The 0.40–0.69 confidence band, awaiting a human |
| Identity profile | §7 | The markers that decide which documents count |
| Jobs & cost | §66 | Step-by-step progress and the API/LLM spend ledger |
| Settings & model | §3, §27, §33 | Every model parameter, and what the tool does not claim |

---

## Cost control (§66)

Per entity: `MAX_DOCUMENTS`, `MAX_API_COST_USD`, `MAX_LLM_TOKENS`, each
overridable on the entity itself. Checked *before* a call, not reported after.
Every provider response is cached; the extraction system prompt carries a cache
breakpoint so the taxonomy and identity profile are paid for once per entity
rather than once per document.

The four passes are real: cheap candidate discovery, then marker-based
disambiguation (free), then extraction only on accepted documents, then LLM
adjudication only for the uncertain band and only up to a budget.

A **rescore** costs nothing. Every factor is stored per evidence row, so
changing the half-life or a model weight recomputes in seconds without touching
a provider.

---

## Architecture

```
server.js              node:http, static + API, strict CSP
src/config.js          env loading and MODEL — every scoring parameter, one object
src/db.js              26 tables (§61), node:sqlite
src/util/              text mechanics, fingerprinting, statistics
src/providers/
  http-client.js       throttle, retry, cache, cost ledger, budget ceilings
  dataforseo.js        content analysis, phrase trends, SERP, content parsing
  corpus/              CorpusProvider interface + DataForSEO, Google SERP,
                       Common Crawl, manual (§12)
  llm/                 provider abstraction + Anthropic, OpenAI (§64)
  embeddings/          local hashing embedder (default) + OpenAI
src/services/          identity, disambiguation, fetch, extraction,
                       canonicalize, duplicates, scoring, metrics, serp,
                       coverage, insights, alerts, ingest
src/jobs/              the §67 pipeline and its queue
src/routes/            entities, analysis, evidence/QA
public/                vanilla ES modules, one stylesheet, one SVG graph
```

**Departures from the brief's stack**, and why: the brief specifies FastAPI +
PostgreSQL/pgvector + Celery/Redis. None of that infrastructure exists on the
target machine, and the sibling project on it is Node 22 with `node:sqlite` and
zero dependencies. This follows that. The consequences are real and worth
stating: `pgvector` is replaced by Float32 BLOBs with cosine similarity computed
in process (fine at tens of thousands of rows — that table is the first thing
that has to move at scale), and Celery is replaced by a single in-process
worker (correct for a workload bottlenecked on throttled outbound HTTP).

Two other deliberate deviations:

- **§65 asks for `temperature: 0`.** Current Claude models removed the sampling
  parameters and reject `temperature` with a 400. Determinism comes from a
  strict output schema, a pinned tool choice and a fixed effort level instead.
  Older models that still accept it are sent `temperature: 0`.
- **Anthropic is called over raw HTTP** rather than through `@anthropic-ai/sdk`,
  because this application has zero npm dependencies by design and uses exactly
  one endpoint. If streaming, batching or the Files API are ever needed, install
  the SDK rather than growing that file.

---

## What is built, and what is not

**Built — MVP 1 through 11, and V1's definition of done (§80).** Entity
creation and identity profile; corpus ingestion with pagination and alias
merging; disambiguation with a review queue; association extraction;
canonicalisation and hierarchy; raw counts; PIAS and every derived score;
leaderboard; timeline; evidence explorer; SERP overlay; snapshots; the graph
with its time slider; alerts; coverage confidence; the written summary.

**Deliberately not built,** per §72's instruction not to build predictive
modelling before the core pipeline is reliable:

- **§57 Campaign simulator** — Phase 2.
- **§58 Placement planning** — depends on the simulator.
- **§56 Model calibration** — regression and gradient-boosted models over
  observed outcomes. The data collection this needs *is* built: weekly
  snapshots store PIAS, CES, corpus share, GRS and momentum per association,
  and `snapshotSeries()` reports how many have accumulated. It refuses to fit
  anything until there are at least eight, because a model fitted to three
  observations is a decoration.

**Known limits.**

- The local embedder is a hashed bag of n-grams, not a semantic model. It
  shortlists candidate merges; it does not know "charitable giving" means
  "philanthropy". §19 forbids merging on embedding similarity alone anyway, so
  without an LLM key similar-but-unproven pairs are recorded as *suggestions*
  and left unmerged — an unmerged pair understates a score, a wrong merge
  invents one.
- The heuristic extractor is regex NER plus a gazetteer. It produces occasional
  junk labels ("ABC Capital Regulators"). Every row it writes is stamped
  `extractor: heuristic` and the coverage panel says so.
- Momentum over a 90-day window needs volume to be meaningful. With three or
  four documents a period it is noise, and the demo shows this honestly rather
  than smoothing it away.
- Publication dates are missing on a large minority of Content Analysis items;
  `group_date` substitutes, and the coverage panel reports how many documents
  were dated by inference rather than by their publisher.
- `phrase_trends` accepts `search_mode` on the REST API but the parameter is not
  exposed by every client; if the `one_per_domain` series ever starts returning
  numbers identical to `as_is`, check that first.

---

## The final principle

The system is not trying to answer *"how many times does the phrase 'John Smith
philanthropy' exist?"*

It is trying to answer: **given the observable web corpus, how strongly,
independently, authoritatively and recently is John Smith associated with
philanthropy relative to every other concept associated with John Smith?**
