# Examination Hub

A browser-only practice examination. The public build uses **synthetic content** and has no backend, authentication, or runtime API. The built-in fictional practice exam can demonstrate scoring only after finalization. Local progress is saved in the browser. Building or testing the app does not deploy it.

```sh
npm ci
npm run dev
```

Open the Vite URL under `/Cyber-SC-100/`. Start explicitly, take the sections in order and review responses before submitting each section. A submitted section cannot be reopened through the app.

See [the Phase 5 runbook](docs/PHASE-5-CANDIDATE-EXAM.md) for local testing and the separate protected development workflow. Do not place any source PDF, answer keys, private question bank, or generated protected build in this repository, GitHub Actions, or GitHub Pages.

The [adaptive batch policy](docs/ADAPTIVE-BATCH-EXHAUSTION.md) defines 59 as the preferred size, not a minimum. Existing sections use their actual counts. The cycle engine keeps using unused eligible questions after a special pool is exhausted and does not pad the final batch.

See [Phase 6 interaction and exam lifecycle guidance](docs/PHASE-6-INTERACTIONS-AND-FINALIZATION.md) for controls, the optional configured deadline, and the no-live-scoring boundary.

See [Phase 7 scoring and results](docs/PHASE-7-SCORING-AND-RESULTS.md) for the scoring policy, result boundary, and isolated local verification.
