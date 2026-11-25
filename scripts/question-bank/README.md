# Protected question-bank compiler

Use the [Phase 3 runbook](../../docs/PHASE-3-PROTECTED-BANK.md) for offline build, source-answer verification and the private reviewer. The compiler is outside the application entry graph. Private artifacts are separate from public synthetic CI and not eligible for production.

## Full protected release candidate

The release compiler is a **local-only** build. Practice eligibility is not distribution authority. Neither this compiler nor its candidate builder produces an approved public question bank; the public Pages artifact remains synthetic.

The command takes these six separately protected files in this order: original PDF, Phase 3 extraction JSON, Phase 3 asset manifest, Phase 3 review metadata, original Phase 1 reference fixture, and the independent Phase 0 source-map JSON. The original PNG files must be beside the asset manifest under `assets/`. All input paths and newly allocated output directories must be outside Git worktrees.

```sh
node scripts/question-bank/build-release-bank.mjs \
  "$PRIVATE_PDF" "$PHASE3_EXTRACTION" "$PHASE3_ASSET_MANIFEST" \
  "$PHASE3_REVIEW" "$PHASE1_REFERENCE" "$PHASE0_ORACLE" \
  "$NEW_PRIVATE_BANK_DIRECTORY"
```

Use Python 3 with PyMuPDF for the PDF placement check. The compiler refuses missing or changed historical digests, checks every source mapping against the independent oracle, then reviews identity, interaction instructions, asset dependency, case relationship and known anomalies per source record. It verifies each declared image placement is above the answer section of the pinned PDF. Files: `release-bank.json` (eligible display data and inventory), `release-scoring.json` (separate verified ID mappings), `release-audit.json` (full disposition for all records), and `release-manifest.json` (checksums); only redacted counts appear on standard output.

To exercise the protected site, supply the authorized or test-only local configuration explicitly. There is no default exam duration or passing percentage here:

```sh
EXAM_DURATION_MINUTES="$CONFIGURED_MINUTES" \
EXAM_PASSING_PERCENTAGE="$CONFIGURED_PASSING_PERCENTAGE" \
node scripts/question-bank/build-candidate.mjs --release \
  "$PRIVATE_BANK_DIRECTORY" "$NEW_PRIVATE_BROWSER_OUTPUT"

node scripts/question-bank/serve-candidate.mjs \
  "$PRIVATE_BROWSER_OUTPUT" 4194 --pages-equivalent
```

Open the loopback URL shown by the command at `/Cyber-SC-100/`. The server only accepts localhost requests for specific whitelisted files; it is not a deployment tool. The browser build checks independently pinned display/scoring bytes and verified raster digests. The application requests the separate scoring module only after durable terminal finalization. A person able to inspect or fetch local browser assets can still inspect that module. Do not upload the protected output, even as a Pages artifact or CI artifact. Historical reference-only commands remain available and retain their original pins.

Public synthetic policy checks: `node --test scripts/question-bank/release-bank.test.mjs`.
