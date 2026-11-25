# Phase 2 foundation

This is a static, independent examination-training shell. It is not a Microsoft product, production content release, proctoring system, or a deployment. No backend, runtime API, accounts, credentials, or hosted database. Browser-local state is stored using IndexedDB; losing site data may prevent resume.

## Run and verify

Use Node 24 and the lockfile. Run `npm ci`, then `npm run dev`, and open the displayed `/Cyber-SC-100/` path. The repository preview is explicitly synthetic wiring, not substitute SC-100 content. It supports navigation, marks, section review and irreversible normal-flow locks with local persistence. It is intentionally not a scored exam or general production batch generator.

Checks: `npm run typecheck`, `npm run lint`, `npm test`, `npm run validate:source`, `npm run build`, `npm run validate:dist`, and `npm run test:pages`. Browser tests use Chromium from Playwright or an explicitly configured executable. For local Playwright-managed Chromium run `npx playwright install chromium` before browser tests. Tests serve only built static files under the exact project prefix; hash routes require no rewrites.

## Layer boundaries

- `src/app`, `src/features`, `src/design-system`: accessible shell, controls and registry-based interaction display. Presentation never receives source answer fields.
- `src/domain`: read-only source and runtime model, transition table, cardinality and stable-seed rules.
- `src/storage`: IndexedDB repository; bounded writer lease and transactional revision checks. Runtime storage is not tamper-proof.
- `src/integration`: keeps asynchronous local writes ahead of navigation and commits, restores on reopen, refuses stale writers, adapts display responses to domain commands.
- `scripts/source`, `scripts/question-bank`: future private pipeline boundaries; no production bank or public import is enabled.

## Protected reference fixture

The approved Phase 1 ZIP contains the canonical `REFERENCE-BATCH-001.json`. Unpack it into an access-controlled folder **outside the repository**, alongside but separate from the protected Phase 0 answer map and original PDF. Run `npm run verify:private-reference -- /absolute/private/path/REFERENCE-BATCH-001.json`. This checks the exact approved digest and 59-ID policy without printing IDs. If it fails, recover the approved file; never recreate or substitute the 49 IDs.

When the private preview adapter is separately built, it must read the exact ordered fixture, project matching records from the protected source/validation files, and run exclusively in a private development environment. No real fixture, source text, answers, or assets are in the repository, public CI, or public build. A static client cannot keep scoring data secret from someone inspecting the browser; the UI must not reveal correctness during an attempt.

## Release boundary

CI validates the synthetic project and allowlisted build output only. No deploy job or Pages settings are configured. Content review, redistribution permission, scoring/remainder decisions, private validation and explicit release approval are future gates.
