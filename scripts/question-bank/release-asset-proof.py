#!/usr/bin/env python3
"""Offline visual-boundary check: all pinned PDF image placements precede the answer area."""
import hashlib
import json
import re
import sys
from pathlib import Path

import fitz

SOURCE_SHA = "c1afae23f990c0ee3fc1a20b38ca2f945c244a8b827c50ce0b7e51a785003041"
HEADING = re.compile(r"^(?:correct answer|explanation)(?:\s*:)?(?:\s|$)", re.I)


def audit(pdf_path, manifest_path):
    data = Path(pdf_path).read_bytes()
    if hashlib.sha256(data).hexdigest() != SOURCE_SHA:
        raise ValueError("source digest")
    manifest = json.loads(Path(manifest_path).read_bytes())
    if manifest["sourceDocumentChecksum"] != SOURCE_SHA:
        raise ValueError("asset digest")
    crossing = total = 0
    with fitz.open(stream=data, filetype="pdf") as document:
        if len(document) != 358:
            raise ValueError("source page count")
        for asset in manifest["placements"]:
            page = document[asset["sourcePage"] - 1]
            boxes = [(line["bbox"][1], "".join(run["text"] for run in line["spans"]).strip())
                     for block in page.get_text("dict")["blocks"] for line in block.get("lines", [])]
            heading_tops = [top for top, line in boxes if HEADING.match(line)]
            if not heading_tops:
                raise ValueError("answer separation")
            x0, y0, x1, y1 = asset["sourceBounds"]
            bounds = (x0, y0, x1, y1)
            if not any(len(rect) == 4 and all(abs(a - b) <= 0.02 for a, b in zip(rect, bounds))
                       for rect in page.get_image_rects(asset["sourceXref"])):
                raise ValueError("source placement mismatch")
            crop = asset.get("crop")
            if y1 >= min(heading_tops) or (crop and crop["mode"] == "SOURCE_PAGE_CROP" and crop["bounds"][3] >= min(heading_tops)):
                crossing += 1
            total += 1
    return {"placementsChecked": total, "crossingAnswerBoundary": crossing}


try:
    print(json.dumps(audit(*sys.argv[1:]), sort_keys=True))
except Exception:
    # This evidence gate must never print any protected text or raw paths.
    sys.exit("RELEASE_PDF_PLACEMENT_CHECK_FAILED")
