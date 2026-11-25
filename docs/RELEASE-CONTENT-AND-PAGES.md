# Release content and GitHub Pages

Examination Hub is a browser-only application. The public build is a **synthetic practice preview**. A successful build, push, pull request, or merge is not authorization to publish a different question bank or to deploy the site.

## Two separate content decisions

1. **Candidate eligibility:** The corrected SC-100 policy requires all 357 source records in each protected cycle. A documented source limitation does not exclude an item when its original text, options, printed answer, available assets and interaction can be represented faithfully. Retain the limitation in the private audit, not the candidate view. If any source record cannot be represented or scored faithfully, stop the corrected release and report the exact evidence; never invent a replacement.
2. **Public distribution:** Verify authorization for the particular runtime prompts, options, scenarios, diagrams, and grading mappings before making them public. Candidate eligibility is not a license. The existing public build does not import or package the protected candidate. If the source cannot be cleared, a public release needs independently authored or appropriately licensed content, under a separately approved scope.

Never publish the source PDF, extraction archives, raw answer maps, raw review records, private validation packages, or developer-only evidence. Keep them outside the repository, public Actions jobs and artifacts, and GitHub Pages. A separately cleared static release would need only the normalized display records and referenced assets, an examination policy, and the minimum grading data required by the app. Approval to use that exact public payload and a verified way to separate it from internal inputs are prerequisites, not features of the public preview.

## Protected release verification

The local compiler verifies the pinned PDF, extraction, asset manifest, review metadata, reference batch, and independently recorded source-answer mapping. It writes display, scoring, and audit files outside Git. The local runtime builder then copies only the candidate display payload, selected verified PNGs, and a separate scorer. The audit and source files are not served. Protected compilation and serving are disabled in CI.

For an authorized reviewer on a trusted computer with the pinned inputs, Node.js 24, and Python with PyMuPDF available:

```sh
node scripts/question-bank/build-release-bank.mjs \
  "$SOURCE_PDF" "$SOURCE_EXTRACTION" "$ASSET_MANIFEST" "$REVIEW_METADATA" \
  "$REFERENCE_MANIFEST" "$SOURCE_ORACLE" "$NEW_PRIVATE_BANK_DIR"

EXAM_DURATION_MINUTES="$TEST_MINUTES" \
  node scripts/question-bank/build-candidate.mjs --release "$NEW_PRIVATE_BANK_DIR" "$NEW_PRIVATE_BUILD_DIR"

node scripts/question-bank/serve-candidate.mjs "$NEW_PRIVATE_BUILD_DIR" 4179 --pages-equivalent
```

Use fresh output directories outside any Git checkout. Visit `http://127.0.0.1:4179/Cyber-SC-100/` on the same computer; the server intentionally provides no remote access. The corrected SC-100 passing threshold is **90%**, compared before display rounding using each exam's actual maximum score. Exam duration is configurable and still requires an owner decision. Explicit test minutes are for evaluation only. The browser retains local attempts and results; use a fresh browser profile for clean-state verification. The corrected content and policy do not change previous attempts' persisted scores.

## What the app protects

The normal exam UI does not show correctness, scores, explanations, or pass/fail information while an exam is active. Manual submission or expiry freezes the answer snapshot before scoring. Results use the actual number of questions and the approved aggregate-only review policy. The synthetic preview is not an official certification exam and its synthetic settings do not set the SC-100 duration or passing policy.

A static browser app cannot hide answer data from someone able to inspect the resources it downloads. Deferring the scoring resource until finalization enforces the normal UI sequence, not confidentiality. Browser storage, time, and tab coordination are not proctoring or tamper resistance. There is no backend, authentication, or secret client credential.

## Before enabling Pages

- Run the locked unit, integration, source-boundary, browser accessibility, and build checks. Confirm whether a check used synthetic input or protected source-derived input; synthetic CI cannot certify the real bank.
- Test the exact artifact at `/Cyber-SC-100/` in a clean browser. Verify entry point, assets and paths, hash-route reloads, local persistence, timer and finalization, results, and complete-cycle navigation.
- Inspect the artifact and reachable Git history for private inputs, raw answer packages, source maps, and unexpected assets. Verify the artifact corresponds to the reviewed commit. Do not upload the protected test build as a Pages artifact.
- Wait for the owner to review and merge the release PR. A merge alone does not authorize deployment. Only after explicit deployment authorization, verify the approved artifact and Pages configuration, enable the selected deployment method, and smoke-test the published URL.

The current CI workflow validates without deploying. Do not add deployment on push or merge to a readiness PR.
