# Phase 6: question interactions and exam finalization

## Permanent owner rule

> “The exam must only be scored after the candidate explicitly ends and
> submits the exam or when the configured examination timer expires.
> No correctness, score, explanation, or pass/fail information may be
> shown during an active examination. Timer expiration automatically locks
> and submits the attempt and scoring uses the finalized candidate-answer
> snapshot.”

Phase 6 implements response capture, rendering, timing, and the terminal snapshot boundary. **Phase 7 owns scoring and results.** No active attempt can yield a finalized scoring input. No correctness styling, answer keys, score, or explanation belong in candidate controls.

## Renderer and data integrity

Use the typed interaction registry and immutable source option, target, item, and statement IDs. Native choices and labeled menus preserve keyboard/touch semantics; matching, ordering and generic drag/drop offer keyboard equivalents rather than demanding a gesture. A dropdown HOTSPOT is a target-based dropdown, not a map. Q104 and Q225 remain dropdown HOTSPOTs; the reviewed matching interactions preserve their original mappings. No coordinate geometry has been verified in the authorized reference. IMAGE_HOTSPOT fails closed rather than synthesizing regions. Sections, counts, and progression still follow the adaptive policy.

Verified exhibits are viewable without modifying or redrawing the source. The reusable viewer supports expansion, zoom, and focus return. Unverified URLs and SVG are not rendered. Broken or missing images render a clear unavailable state; an answer that depends on a required exhibit is not enabled while it is missing. The protected builder reads only explicitly referenced, digest-pinned PNG files from the approved offline directory and never publishes them. The current 59-question reference needs no exhibits; other renderer shapes and exhibit controls are verified with synthetic data, not promoted from the source.

Source holds remain unchanged: Q44 and Q113 are unrecoverable source placeholders; Q360 remains on interaction review; Q58 keeps its recorded ordering ambiguity; Q6 keeps the recorded wording discrepancy. No held content was promoted. Renderer capability does not approve content.

## Timer configuration and submission

The trusted candidate source can set `examDurationMinutes` and optional `timerWarningMinutes`. No duration is inferred from Microsoft or hardcoded for a real exam. The default synthetic demo and previously saved untimed attempts remain untimed without an approved configuration. For a separately approved local development run, the protected builder accepts `EXAM_DURATION_MINUTES` (whole positive minutes) and optional comma-separated `EXAM_TIMER_WARNING_MINUTES` (unique whole positive minutes, each below the duration). Rebuild the local candidate to change available settings. A started attempt keeps its persisted deadline; a new config cannot reset it.

The display derives from persisted `startedAt` and `expiresAt`; it does not count interval callbacks. It continues across sections and Review and checks again on reload or resume. Screen readers hear configured warning milestones and expiration, not every tick. This is a browser-local deadline, not server-grade tamper resistance: someone who changes the device clock or manually edits IndexedDB may evade it.

A confirmed **End exam** is available from an active section or its Review, including with unanswered questions. Existing explicit **Submit exam** remains available at final review. Configured timeout freezes edits and automatically submits without a second click. Both paths use the same terminal write boundary, lock all sections, record the terminal reason, and keep a final candidate-answer snapshot. Responses validly accepted before the deadline are prioritized in that write. The preexisting save recovery behavior still applies if the device refuses all writes; a storage failure cannot silently become a durable success. Reopening a terminal attempt shows the submitted state and does not reopen its answers. This phase does not calculate a score or fabricate a result.

## Development and verification boundary

Run the ordinary synthetic build and Chromium test suite at `/Cyber-SC-100/`. The exact protected walkthrough remains a separate, approved local-only path: see [the protected runbook](PHASE-5-CANDIDATE-EXAM.md). Real PDFs, maps, protected projections, and rendered evidence of private answers must not enter Git, CI, Pages, or public screenshots. Branch review is not merge or deployment permission.
