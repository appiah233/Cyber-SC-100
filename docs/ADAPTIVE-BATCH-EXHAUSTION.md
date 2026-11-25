# Adaptive batch exhaustion

## Current owner rule (verbatim)

> “59 questions is the preferred size for normal Examination Hub exams.
> The system must consume every source question exactly once per cycle.
> Special question types must never be manufactured after their inventory
> is exhausted. The final exam contains all remaining source questions and
> may therefore contain fewer or more than 59 questions. For the
> current SC-100 source bank, all 357 questions must participate in the
> cycle, including the five questions carrying documented source
> limitations, without altering their source content or answers.”

This supersedes the previous absolute ceiling for the final exam. The five reviewed source-limited items are designated final-only in the protected bank so the earlier normal/adaptive allocation uses the ordinary pool. Final-only is a planning and auditing designation, not a question type or a candidate-facing warning. This decision does not authorize public distribution or deployment.

## Selection and counts

- **NORMAL:** 59 unique unused eligible source IDs, drawn from two distinct case-study families (three children each), 49 standard questions, and four genuine interactive questions. Prefer this composition when it is feasible without counting the same ID in two roles.
- **ADAPTIVE:** if at least 59 eligible unused IDs remain but the normal composition is not feasible, generate 59 unique questions. Prefer up to two genuine case families and up to three available children per family, then up to four genuine interactive items. Fill from genuine standard inventory first, then other eligible items in their actual roles if room remains. One family, a partial family, fewer interactive questions, and standard-only exams are legitimate. Never invent a family, child, source ID, or interaction to fill a slot.
- **FINAL_REMAINDER:** include all unused eligible IDs, with real section membership and actual counts. Without final-only items, an ordinary residual below 59 is final; an ordinary 59 with nonnormal composition is adaptive even if it is the last exam. With final-only items, use the terminal allocator once the ordinary residual is no greater than 59; this avoids a separate final-only mini-exam. The final exam may exceed 59, without an arbitrary cap or fixed count. Zero is exhaustion, not an exam.
- Normal and adaptive batches keep the 59-question ceiling. IDs remain tied to their source records and source interaction kinds. When an ID with two reviewed roles appears in a non-case section, show its approved source context for that question without changing the section or its lock rules. Validated case context belongs to its real family. An actual source-limited item may participate only when its unchanged source text, options, mapping and available interaction evidence can be represented faithfully. Eligible IDs lacking an approved section role must not be discarded or mislabeled.
- A batch stores its batch/cycle identity, mode, actual and target counts, section-role counts, ordered source IDs, seed, and bank version. Counts are derived from selected sections, not from quotas. The actual total is the number of distinct selected IDs; role counts do not double-count IDs. Candidate section navigation, Review and progress use actual sections/counts; no empty section appears. Any future scoring denominator uses the number actually scored, not 59.

## Cycle and persisted progress

Bank version and eligibility policy pin the cycle. Within that cycle, every eligible ID may be included only once. Generating or saving a draft does not consume questions. A new draft must not overlap another live generated plan, a reservation, or consumed IDs. Starting reserves IDs, and durable final submission consumes those reserved IDs. Reservation must not allow a second writable attempt or mark the cycle complete. The prior no-replay rule still applies if an already started attempt is abandoned or invalidated: its exposed IDs are retired distinctly from a completed exam. Invalidating an unstarted draft retires no IDs. Complete the cycle only after every eligible ID has been consumed and no attempt is outstanding, even if the last batch is full-sized. Keep section submission irreversible and advance to the next actual section or to final review if there is none.

Preserve the accepted exact normal development reference, its section order, IDs and option order. A compatible persisted Phase 5 normal attempt must retain its saved answers, marks, cursor/Review, section locks and completion. Where an older snapshot requires migration, validate its pinned identity/shape, migrate explicitly, and keep attempt and cycle data consistent. Legacy ledger entries are historical; do not replay their IDs, reinterpret them as new batches, or silently reopen their cycles. Only a plan matching the currently verified terminal inventory can be admitted as a new oversized exam. Do not silently erase browser storage, reopen a submitted section, remap IDs across content versions, rescore old results against the corrected threshold, or treat malformed data as valid. Keep the writer lease, revision checks, and atomic save behavior for dynamic batches.

## Capacity and review cases

The analyzer reports feasible normal and full-sized adaptive batches, the terminal remainder (zero if none), and total eligible inventory accounted for. Special-pool exhaustion never terminates a cycle. The terminal remainder reflects the final-only policy as well as all unused ordinary inventory.

| Inventory or boundary | Required outcome |
| --- | --- |
| 118 standard only | Two 59-question adaptive batches; complete after both submissions. |
| 100 standard only | 59 adaptive, then 41 final; no omissions. |
| 6 contextual children (two valid families), 4 interactive, 90 standard | 59 normal, then 41 final. |
| One family or only one/two children left | Keep genuine family and context; don't fabricate another family or child. |
| Cases exhausted; interactive remains | Continue; include available genuine interactive content and fill with eligible inventory. |
| Interactive exhausted; cases remain | Continue without an empty interactive stage. |
| Both special pools exhausted | Continue with available standard content. |
| 2 contextual children, 1 interactive, 20 standard | A 23-question final examination. |
| One question left | One-question final examination; complete only after submission. |
| Section pools overlap | Each selected source ID appears once; never infer another interaction or case relationship from a slot. |
| 59 or more ordinary items remain but no normal batch is feasible | Use full-size adaptive batches until the terminal condition is met. |
| 57 ordinary plus 5 final-only items remain | One final exam uses all 62; no 3-item tail. |
| 59 ordinary plus final-only items remain | One final exam uses both pools; no isolated final-only tail. |
| Generated or started last batch | Keep the cycle active until durable final submission. |
| Only records not approved for this cycle remain | No promotion, no fabricated content, and no empty exam. |

The end-to-end proof compares the set of all generated IDs with the eligible source set and independently checks that the sum of actual batch counts is exactly the size of that set. Retain the Phase 5 candidate-flow regression alongside adaptive tests. Public code, tests, and builds use synthetic content only. The exact protected reference is loaded only in a separately built, loopback-only local entry on an approved computer, under its existing development eligibility. This remediation does not authorize uploading or publishing private source material, answer keys, or scoring data.
