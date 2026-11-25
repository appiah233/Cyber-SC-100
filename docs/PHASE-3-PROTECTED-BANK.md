# Phase 3: protected source ingestion and static question bank

Phase 3 extends the verified Phase 2 base with an offline, private content pipeline. The candidate app remains the synthetic static foundation. No private source, bank, real fixture, image or review page is included in the public repository, Actions, or Pages output. No deployment, backend, hosted database, authentication, runtime service, or credentials.

## Inputs and access boundaries

Use a protected directory outside Git (0700 on POSIX). Obtain the original PDF directly from the authorized private source; do not download a replacement. The required SHA-256 is `c1afae23f990c0ee3fc1a20b38ca2f945c244a8b827c50ce0b7e51a785003041`. Keep the owner-reviewed metadata JSON, the exact Phase 1 reference manifest, and the prior independently verified Phase 0 source map privately alongside it. The CLI pins the original oracle and manifest bytes rather than trusting identifiers in filenames. A digest proves same bytes, not authority to publish those bytes.

The extraction tool uses Python, Poppler pdftotext and PyMuPDF. The verified local run used Python 3.12, Poppler 25.03.0 and PyMuPDF 1.26.6. The extraction code generates immutable traceable records rather than using a model to produce answers. Use `-B` to avoid sending Python cache files to a checkout.

## Private commands

From the repository, set shell variables to authorized absolute paths outside Git. `ASSET_DIR` and `BANK_DIR` are separate new directories below a protected existing parent. Outputs may not overwrite a previous snapshot.

```sh
python3 -B scripts/source/extract.py --pdf "$PDF" --output "$EXTRACTION"
python3 -B scripts/source/assets.py extract --pdf "$PDF" --output-dir "$ASSET_DIR"
python3 -B scripts/source/assets.py validate --pdf "$PDF" --output-dir "$ASSET_DIR"
npm run build:bank -- --source "$EXTRACTION" --assets "$ASSET_DIR/assets.json" \
  --review "$REVIEW" --reference "$REFERENCE" --oracle "$ORACLE" --output-dir "$BANK_DIR"
npm run verify:source-answers -- --source "$EXTRACTION" --assets "$ASSET_DIR/assets.json" \
  --review "$REVIEW" --reference "$REFERENCE" --oracle "$ORACLE" --bank "$BANK_DIR/bank.json"
SC100_PRIVATE_DISPLAY="$BANK_DIR/display-bank.json" npm test -- tests/development-bank.test.ts
npm run review:bank -- --bank "$BANK_DIR/bank.json" --id Q253 --output "$PRIVATE_DIR/review-page.html"
```

The viewer writes offline escaped HTML with a restrictive CSP and no scripts, asset requests, or served endpoint. Open it only in the protected workspace; it is intentionally answer-bearing. Its asset metadata points to source evidence without fetching it. View independent PNGs separately.

The build emits a deterministic `manifest.json`, a private review aggregate (`bank.json`), a renderer-oriented `display-bank.json` with no answer definitions or reviewer notes, separate `scoring-bank.json`, an exact byte copy of the approved private reference manifest, and hash-verified PNGs. The version- and scope-checked consumer in `src/data/development-bank.ts` is not in the public Vite entry graph. It rejects a production load or a mismatched pinned version; it clones display-only fields and does not access scoring inputs. Type and identifier checks preserve ordering positions separately from the available choices; matching, dropdown and statements preserve target IDs and their source choice IDs.

### Independent exhibit repair

Use the manifest's stable placement ID. Four crop values are top-left PDF page points. Review the preview against its source page; retain the native dimensions and placement metadata. Apply only the reviewed digest:

```sh
python3 -B scripts/source/assets.py preview --pdf "$PDF" --output-dir "$ASSET_DIR" \
  --asset-id "$PLACEMENT" --crop "$LEFT" "$TOP" "$RIGHT" "$BOTTOM"
python3 -B scripts/source/assets.py repair --pdf "$PDF" --output-dir "$ASSET_DIR" \
  --asset-id "$PLACEMENT" --crop "$LEFT" "$TOP" "$RIGHT" "$BOTTOM" --expected-preview-sha256 "$PREVIEW_SHA"
python3 -B scripts/source/assets.py validate --pdf "$PDF" --output-dir "$ASSET_DIR" --asset-id "$PLACEMENT"
```

Only the selected placement changes. Recompile into a new bank revision and re-run the integrity gate; do not rebuild all source extraction just to fix a crop. Q44/Q113 retain no-recoverable-exhibit placeholder provenance, and Q360 retains the source-interaction review hold. The tool does not synthesize missing diagrams or HOTSPOT geometry.

## What the checks mean

1. Answer block present in the pinned source.
2. Source block structurally parsed to stable source option/target identities.
3. Source mapping identity compared with the earlier verified oracle, and signed-off semantic review tracked separately. Structural checks never promote an item to semantic or content approval.
4. Candidate bank mapping identity checked. A PASS for the private candidate proves matching answers and scoped provenance; it does not validate published/public content or grant production eligibility.

The verifier refuses malformed or duplicated IDs, missing traces, bad crop/hash data, unexpected answer changes, changed private fixture bytes, unapproved eligibility and stale/missing runtime views. A mismatch fails closed and logs only generic codes/counts. Source-only check without a bank returns INCOMPLETE (nonzero). Real production approval remains 0 in Phase 3. No answer derivation from explanations, external documentation, or model knowledge.

## CI and release

Public CI tests only synthetic contracts and negative cases, including mutation, trace, duplicates, missing source data and eligibility checks, before building the existing synthetic Pages app. It does not receive the pinned PDF or the real candidate bank. Actual source-to-bank comparison must also pass in the protected lane. Rights, semantic content review, and explicit release authorization are separate gates. A future static client cannot hide data needed for local scoring from a technical user; ordinary active UI must not render it.
