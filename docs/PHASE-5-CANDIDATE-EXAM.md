# Phase 5: candidate examination

The normal website build uses fictional controls. Do not publish protected practice content, commit it, add it to an Actions job or copy it under any Git checkout. Phase 5 did not give production content approval. Review and submission show response completion only, not correctness, a result or a score.

## Run the public synthetic candidate

Run `npm ci`, then `npm run dev` and open the Vite URL under `/Cyber-SC-100/`. To test the same static assets as CI, run `npm run build` and `npm run test:pages`.

## Run the exact approved development reference on an approved computer

1. Use Node 24 and this branch with its dependencies installed. Extract the previously delivered Phase 3 **private development bank** to a restricted directory outside the checkout. For the local candidate, the only input files used are `bank.json`, `display-bank.json`, and `reference-batch.json` together in that directory. Do not point a web server at this bank directory.
2. From the checkout, run this with a **new**, separate output path whose parent already exists:
   ```sh
   node scripts/question-bank/build-candidate.mjs "/absolute/path/to/verified-bank" "/absolute/path/to/new-local-candidate"
   ```
3. Serve only the three emitted static files on loopback:
   ```sh
   node scripts/question-bank/serve-candidate.mjs "/absolute/path/to/new-local-candidate" 4177
   ```
   Open `http://127.0.0.1:4177/` on that computer. Leave the server on while using the exam. Use the same address, port and browser profile to resume. Stop with Ctrl+C. The helper has no API or write handlers, serves no bank/PDF, and is not a deployment. The generated directory contains protected **display** content; never upload or share it.
4. Choose **Start exam** explicitly. Complete the sections in order. A section remains editable until the confirmed submit action, then it is locked. The active section, position, Review screen, marks and saved responses are restored by the same origin on reload. Only one cooperating tab can edit. Failed saves can be retried or deliberately discarded before submission. Final submission is recorded locally; scoring and results are not implemented here.

The build script verifies the exact bank, display projection and reference SHA-256 digests; rejects GitHub CI, in-checkout output, pre-existing output and linked inputs; and projects only the 59 approved development display items in reference order plus their two case contexts. It never sends the answer/scoring files or original PDF to the browser. The approved reference has no required graphics and no coordinate HOTSPOT geometry. The two dropdown HOTSPOTs use ordinary labeled selects; the two matching questions use labeled keyboard-operable selects with source-permitted reuse. The public graph is independently verified to exclude this local entry and its projection.

## Limits

IndexedDB and its cooperating-tab lock are not tamper-proof or remotely backed up. Clearing browser/site data or switching profiles, origins, browsers or devices can make an attempt unavailable. The local HTTPS-equivalent loopback context supports the needed browser APIs; production availability is not implied. Formal source rights and semantic review are separate. Do not merge or deploy from this phase.
