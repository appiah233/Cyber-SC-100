# Phase 4: deterministic batch and cycle engine

This branch builds on verified Phase 3. It adds a pure planner, exact capacity analysis, and a browser-local cycle controller. It adds no source data to the repository or release build, no account/backend/hosted database, and no deployment. The visible candidate page retains the Phase 2 layout and offers one generated **synthetic** preview; the new full registry is exercised separately in an actual Chromium IndexedDB test. A full candidate cycle UI, scoring, and publication are later work.

## Planner and eligibility

Normal membership is fixed to ordered sections: two distinct case families, three unused children each; 49 standard; four interactive. Exactly 59 original IDs, all distinct. Family reuse is allowed with different children. Selected interactive priority is image HOTSPOT, dropdown HOTSPOT, diagram-dependent, drag/drop, matching, ordering, then statement. An exact per-source-capacity assignment reserves one unit per ID across overlapping pools; preference never makes an invalid or smaller batch count as normal.

Inputs are pinned bank version, cycle ID/state, eligibility policy, and seed. IDs are canonically sorted for seed-reproducibility; independent streams order disjoint roles and groups. Stable option IDs are never reassigned; only declared shuffle-safe order is permuted and persisted. In protected-bank qualification, real option groups conservatively retain their reviewed source order. Shared statement choices stay the same source IDs rather than manufacturing target-specific answer identities. No answer key is part of the planner contract.

DEVELOPMENT excludes holds and unapproved development questions; PRODUCTION insists on explicit production eligibility. The current protected import holds the reviewed 59-ID manifest as distinct from any generated order and refuses additions to that approval set. Production with zero approved items reports INSUFFICIENT_PRODUCTION_CONTENT.

## Exact capacity and remainder

The analyzer returns a global maximum under the same eligibility and no-reuse rules, not the sum of independent pool capacities. It bounds candidate batch counts by total/standard/interactive limits and feasible distinct-case appearances. For each bounded number it searches case-family appearance counts and uses capacitated Hall tests plus exact disjoint allocation to construct a witness. Family child membership is canonical (one family per source ID). Reordering a feasible witness does not change feasibility. The cycle controller normally preserves the seed-selected batch; if that choice would strand another feasible batch, it uses a deterministic revalidated witness partition instead.

Inventory scanning is linear in source IDs and role incidences; sorting for seed stability is O(n log n). Exact one-batch selection explores at most F(F-1)/2 family pairs, with at most 59 unit augmentations for one assignment. The global search is bounded by available batch and family counts and prunes by Hall deficits; do not describe it as globally linear or promise arbitrary-bank scalability. For the current source size it avoids repeatedly re-scanning all records inside the search. Diagnostics separate holds/review, committed exclusions and production eligibility, and show remaining case, standard and interactive inventory.

If no normal batch exists and eligible unused content remains, emit an explicit FINAL_REMAINDER_BATCH. Keep coherent case-family groups in order without inventing a second family, then the standard section, an explicitly labeled unsectioned remainder for eligible items without a clean role, and the final interactive section. Deduplicate across every section, retain the source interaction, report the actual count and reason. A remainder can have 59 or more leftover IDs when blocked by section constraints; it is never presented as a compliant normal batch. Zero unused IDs is exhaustion, not an empty batch.

## Local cycle transitions

- **GENERATED:** immutable draft snapshot; no reservation. Drafts cannot override a live attempt, cycle consumption or other locks.
- **STARTED:** reserve membership atomically against the current revision, scope and writer fence. Its version, sections, options and seed cannot change.
- **COMPLETED:** release its reservation and permanently consume its IDs in this cycle.
- **ABANDONED/INVALIDATED:** a started attempt retires those IDs for the remainder of the cycle; a never-started invalidated draft consumes nothing. This avoids replay after exposure. Logs distinguish status, and old draft conflicts cannot silently replace a batch.
- **Cycle completion:** exhaustion proven by the planner, or terminal transition of the final remainder. No auto-reset. Explicitly allocate a fresh unique cycle ID on a completed predecessor, preserve the previous ledger, and restart eligible selection from zero consumption.

The controller checks the active writer before planning, then persists through the existing IndexedDB compare-and-swap abstraction. The registry stores full cycle history under one fenced row, including generated membership/status, option order, seed, consumption, policy and version. It uses a separate namespace from the synthetic candidate-preview attempt. Reload verifies the stored snapshot and exact version; a different loaded bank reports MIGRATION_REQUIRED if the exact old bank is still available, otherwise INCOMPATIBLE. Neither state substitutes IDs. A new explicit cycle may have a new version. Cooperating tabs must use unique identities; a second tab is read-only while a lease is active, and a copied observed lease is not a controller-issued mutation session. Client state is tamperable and browser storage can be evicted; this is not authentication or tamper-proof exam security.

## Verification boundary

`npm test` is synthetic in public CI (protected-input checks skip by default); `npm run test:pages` exercises the existing synthetic app and includes a disposable synthetic browser probe for the real IndexedDB cycle registry. The probe is not in application dist. Real-bank capacity and reference validation are run only against verified protected inputs kept outside Git. Do not wire private bank, PDF, maps, answers, or real fixture into public Actions, browser bundles or output. See Phase 3's protected-bank runbook for provenance. Publication and Phase 5 require separate authorization.
