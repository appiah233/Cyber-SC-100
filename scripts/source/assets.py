#!/usr/bin/env python3
"""Private, pinned SC-100 exhibit inventory and single-placement crop tools."""

from __future__ import annotations

import argparse
from contextlib import contextmanager
from dataclasses import dataclass
import hashlib
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import sys
import tempfile
from typing import Any, Iterator

import fitz

SOURCE_SHA256 = "c1afae23f990c0ee3fc1a20b38ca2f945c244a8b827c50ce0b7e51a785003041"
SOURCE_PAGE_COUNT = 358
SOURCE_BYTES = 7_724_826
SOURCE_PLACEMENT_COUNT = 27
QUESTION_PAGE_COUNT = 26
SCHEMA_VERSION = 1
TOOL_VERSION = "sc100-private-assets-v1"
PROJECT_ROOT = Path(__file__).resolve().parents[2]
ASSET_ID = re.compile(r"sc100-q\d{3}-p\d{3}-exhibit-\d{2}")
FILE_NAME = re.compile(r"[a-z0-9-]+\.png")
DIGEST = re.compile(r"[a-f0-9]{64}")
PAGES_WITH_PLACEHOLDERS = {44: 44, 113: 112}
E_COMMERCE_QUESTIONS = {327, 328, 329, 330}
Bounds = tuple[float, float, float, float]


class AssetError(ValueError):
    """A rejected operation; source and existing manifest are left unchanged."""


@dataclass(frozen=True)
class Placement:
    question: int
    page: int
    ordinal: int
    xref: int
    bounds: Bounds
    original_dimensions: tuple[int, int]

    @property
    def asset_id(self) -> str:
        return f"sc100-q{self.question:03d}-p{self.page:03d}-exhibit-{self.ordinal:02d}"

    @property
    def classification(self) -> str:
        if self.question in PAGES_WITH_PLACEHOLDERS:
            return "SOURCE_PLACEHOLDER_NO_RECOVERABLE_EXHIBIT"
        return "MEANINGFUL_CONTENT"

    @property
    def relationship(self) -> str:
        if self.question in PAGES_WITH_PLACEHOLDERS:
            return "SOURCE_PLACEHOLDER"
        if self.question in E_COMMERCE_QUESTIONS:
            return "CASE_CANDIDATE_SHARED_EXHIBIT"
        if self.question == 360:
            return "SOURCE_INTERACTION_SCREENSHOT"
        return "QUESTION_EXHIBIT"

    @property
    def required(self) -> bool:
        return self.question not in {*PAGES_WITH_PLACEHOLDERS, 360}


def sha256(payload: bytes) -> str:
    return hashlib.sha256(payload).hexdigest()


def path_components(path: Path) -> Iterator[Path]:
    yield from reversed(path.parents)
    yield path


def reject_symlinks(path: Path) -> None:
    if any(part.is_symlink() for part in path_components(path)):
        raise AssetError("Symlink paths are not permitted for asset output.")


def private_output(path: Path, *, create: bool = False) -> Path:
    """Resolve only absolute, non-symlink destinations outside Git worktrees."""
    if not path.is_absolute() or ".." in path.parts:
        raise AssetError("Use an absolute private output directory without traversal segments.")
    reject_symlinks(path)
    dest = path.resolve()
    if dest == PROJECT_ROOT or dest.is_relative_to(PROJECT_ROOT):
        raise AssetError("Source imagery must be generated outside the project repository.")
    for parent in path_components(dest):
        marker = parent / ".git"
        if marker.is_file() or (marker / "HEAD").is_file() or parent.name == ".git":
            raise AssetError("Source imagery must be generated outside Git worktrees.")
    if create:
        dest.mkdir(parents=True, mode=0o700, exist_ok=True)
    if not dest.is_dir():
        raise AssetError("The private output directory does not exist.")
    # The files themselves are additionally created owner-only.
    if os.name == "posix" and dest.stat().st_mode & 0o077:
        raise AssetError("Use a private output directory with owner-only permissions (0700).")
    return dest


def checked_asset_path(output: Path, relative: str, folder: str = "assets") -> Path:
    if not isinstance(relative, str) or "\\" in relative:
        raise AssetError("Invalid generated asset path.")
    rel = PurePosixPath(relative)
    if (
        len(rel.parts) != 2
        or rel.parts[0] != folder
        or not FILE_NAME.fullmatch(rel.parts[1])
        or relative != rel.as_posix()
    ):
        raise AssetError("Invalid generated asset path.")
    candidate = output / rel.parts[0] / rel.parts[1]
    reject_symlinks(candidate)
    if not candidate.resolve().is_relative_to(output):
        raise AssetError("Asset path escaped its private output directory.")
    return candidate


def atomic_write(path: Path, content: bytes, *, overwrite: bool = False) -> None:
    reject_symlinks(path)
    if path.exists() and not overwrite:
        if not path.is_file() or path.read_bytes() != content:
            raise AssetError("An existing asset differs; it was not overwritten.")
        return
    path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
    temporary: str | None = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as handle:
            temporary = handle.name
            handle.write(content)
        if overwrite:
            os.replace(temporary, path)
        else:
            # Link a complete file without clobbering a concurrently added destination.
            try:
                os.link(temporary, path)
            except FileExistsError:
                reject_symlinks(path)
                if path.read_bytes() != content:
                    raise AssetError("An existing asset differs; it was not overwritten.") from None
    finally:
        if temporary is not None and os.path.exists(temporary):
            os.unlink(temporary)


@contextmanager
def manifest_lock(output: Path) -> Iterator[None]:
    lock = output / ".assets-manifest.lock"
    try:
        descriptor = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError as error:
        raise AssetError("Another asset manifest write is active. No changes were made.") from error
    try:
        yield
    finally:
        os.close(descriptor)
        lock.unlink()


def pinned_pdf(path: Path) -> fitz.Document:
    if not path.is_absolute() or not path.is_file():
        raise AssetError("Provide an absolute path to the protected source PDF.")
    # Read and verify the same bytes passed to the PDF parser.
    with path.open("rb") as source:
        payload = source.read(SOURCE_BYTES + 1)
    if len(payload) != SOURCE_BYTES or sha256(payload) != SOURCE_SHA256:
        raise AssetError("Source PDF checksum does not match the approved SC-100.pdf.")
    document = fitz.open(stream=payload, filetype="pdf")
    if len(document) != SOURCE_PAGE_COUNT:
        document.close()
        raise AssetError("Source PDF page count does not match the approved inventory.")
    return document


def normalize_bounds(values: Any) -> Bounds:
    if not isinstance(values, (list, tuple)) or len(values) != 4:
        raise AssetError("Crop bounds must contain four finite PDF-point coordinates.")
    if any(
        isinstance(value, bool)
        or not isinstance(value, (int, float))
        or not -100_000 <= value <= 100_000
        for value in values
    ):
        raise AssetError("Crop bounds must contain four finite PDF-point coordinates.")
    x0, y0, x1, y1 = (round(float(value), 5) for value in values)
    if x0 >= x1 or y0 >= y1:
        raise AssetError("Crop bounds must be ordered and nonempty.")
    return (x0, y0, x1, y1)


def scan_page(document: fitz.Document, page_number: int) -> list[Placement]:
    if not isinstance(page_number, int) or not 2 <= page_number <= SOURCE_PAGE_COUNT:
        raise AssetError("Source page is outside the question inventory.")
    page = document[page_number - 1]
    if page.rotation != 0:
        raise AssetError("Unexpected rotated question page; stop for manual review.")
    question_match = re.search(r"(?m)^Question ([1-9][0-9]*)\s*$", page.get_text())
    if question_match is None:
        raise AssetError("Could not trace a question page to its original source ID.")
    question = int(question_match[1])
    items = sorted(
        (
            (normalize_bounds(info["bbox"]), info)
            for info in page.get_image_info(xrefs=True)
        ),
        key=lambda item: (item[0][1], item[0][0], item[0][3], item[0][2], item[1]["xref"]),
    )
    result: list[Placement] = []
    for position, (bounds, info) in enumerate(items, start=1):
        xref = info["xref"]
        width, height = info["width"], info["height"]
        if xref <= 0 or width <= 0 or height <= 0:
            raise AssetError("Unexpected or untraceable raster on a question page.")
        if question in PAGES_WITH_PLACEHOLDERS and (
            PAGES_WITH_PLACEHOLDERS[question] != page_number or (width, height) != (9, 6)
        ):
            raise AssetError("Source placeholder attributes differ from the reviewed placement.")
        if question in E_COMMERCE_QUESTIONS and xref != 1333:
            raise AssetError("The reviewed shared case-candidate exhibit identity changed.")
        result.append(Placement(question, page_number, position, xref, bounds, (width, height)))
    return result


def scan_all(document: fitz.Document) -> list[Placement]:
    # Cover-page graphics are not question assets.
    placements = [
        placement
        for page_number in range(2, len(document) + 1)
        for placement in scan_page(document, page_number)
    ]
    if (
        len(placements) != SOURCE_PLACEMENT_COUNT
        or len({item.page for item in placements}) != QUESTION_PAGE_COUNT
        or len({item.asset_id for item in placements}) != SOURCE_PLACEMENT_COUNT
    ):
        raise AssetError("Asset inventory count does not match the reviewed source.")
    return placements


def native_png(document: fitz.Document, placement: Placement) -> tuple[bytes, tuple[int, int]]:
    pixels = fitz.Pixmap(document, placement.xref)
    smask = document.extract_image(placement.xref).get("smask", 0)
    if smask > 0:
        pixels = fitz.Pixmap(pixels, fitz.Pixmap(document, smask))
    if pixels.colorspace is None:
        raise AssetError("Raster has no usable color space.")
    if pixels.colorspace.n > 3:
        pixels = fitz.Pixmap(fitz.csRGB, pixels)
    size = (pixels.width, pixels.height)
    if size != placement.original_dimensions:
        raise AssetError("Native raster dimensions differ from its source placement.")
    return pixels.tobytes("png"), size


def crop_bounds(placement: Placement, values: Any) -> Bounds:
    if placement.classification != "MEANINGFUL_CONTENT":
        raise AssetError("Source placeholders cannot be cropped into replacement exhibits.")
    bounds = normalize_bounds(values)
    x0, y0, x1, y1 = bounds
    sx0, sy0, sx1, sy1 = placement.bounds
    if x0 < sx0 or y0 < sy0 or x1 > sx1 or y1 > sy1:
        raise AssetError("Crop must remain inside the source exhibit; no adjacent question or answer text.")
    if x1 - x0 < 4 or y1 - y0 < 4:
        raise AssetError("Crop is too small to be meaningful.")
    return bounds


def render_crop(
    document: fitz.Document, placement: Placement, bounds: Bounds
) -> tuple[bytes, tuple[int, int]]:
    x0, y0, x1, y1 = crop_bounds(placement, bounds)
    # MuPDF rounds render bounds outward. Align inward to the 216 dpi grid first,
    # so no neighboring page content can enter through a fractional edge pixel.
    clip = fitz.Rect(
        math.ceil(x0 * 3) / 3,
        math.ceil(y0 * 3) / 3,
        math.floor(x1 * 3) / 3,
        math.floor(y1 * 3) / 3,
    )
    page = document[placement.page - 1]
    pixels = page.get_pixmap(matrix=fitz.Matrix(3, 3), clip=clip, colorspace=fitz.csRGB, alpha=False)
    return pixels.tobytes("png"), (pixels.width, pixels.height)


def placement_record(
    document: fitz.Document, placement: Placement, repaired_bounds: Bounds | None = None
) -> tuple[dict[str, Any], bytes | None]:
    original, original_size = native_png(document, placement)
    source_digest = sha256(original)
    review = "VALIDATED_SOURCE_PLACEMENT"
    if placement.question == 360:
        review = "SOURCE_INTERACTION_REVIEW_REQUIRED"
    if placement.classification != "MEANINGFUL_CONTENT":
        if repaired_bounds is not None:
            raise AssetError("Source placeholders must not receive a replacement asset.")
        review = placement.classification
        payload = None
        size = None
        relative = None
        crop: dict[str, Any] | None = None
    elif repaired_bounds is not None:
        if placement.question == 360:
            raise AssetError("Q360 remains on source-interaction hold; do not reinterpret its screenshot.")
        payload, size = render_crop(document, placement, repaired_bounds)
        relative = f"assets/{placement.asset_id}-crop-{sha256(payload)[:16]}.png"
        crop = {"mode": "SOURCE_PAGE_CROP", "bounds": list(repaired_bounds), "scale": 3}
        review = "REVIEWED_PRIVATE_CROP_PRODUCTION_REVIEW_REQUIRED"
    else:
        payload, size = original, original_size
        # Shared source XObjects reference the same byte-preserving generated PNG.
        relative = f"assets/sc100-x{placement.xref:04d}-{source_digest[:16]}.png"
        crop = {"mode": "NATIVE_RASTER", "bounds": list(placement.bounds)}
    return {
        "assetId": placement.asset_id,
        "sourceQuestionId": f"Q{placement.question}",
        "sourcePage": placement.page,
        "sourceBounds": list(placement.bounds),
        "originalDimensions": list(placement.original_dimensions),
        "sourceXref": placement.xref,
        "sourceRasterChecksum": source_digest,
        "classification": placement.classification,
        "relationshipType": placement.relationship,
        "requiredForInteraction": placement.required,
        "reviewStatus": review,
        "productionEligibility": False,
        "crop": crop,
        "outputDimensions": list(size) if size is not None else None,
        "checksum": sha256(payload) if payload is not None else None,
        "path": relative,
    }, payload


def summary(placements: list[dict[str, Any]]) -> dict[str, int]:
    placeholders = sum(item["classification"] != "MEANINGFUL_CONTENT" for item in placements)
    return {
        "placements": len(placements),
        "affectedPages": len({item["sourcePage"] for item in placements}),
        "meaningful": len(placements) - placeholders,
        "placeholders": placeholders,
        "interactionReviewRequired": sum(
            item["reviewStatus"] == "SOURCE_INTERACTION_REVIEW_REQUIRED" for item in placements
        ),
        "privateAssetFiles": len({item["path"] for item in placements if item["path"]}),
        "productionEligible": 0,
    }


def encode_manifest(document: dict[str, Any]) -> bytes:
    return (json.dumps(document, indent=2, sort_keys=True, allow_nan=False) + "\n").encode()


def manifest_path(output: Path) -> Path:
    path = output / "assets.json"
    reject_symlinks(path)
    return path


def manifest_header() -> dict[str, Any]:
    return {
        "schemaVersion": SCHEMA_VERSION,
        "toolVersion": TOOL_VERSION,
        "sourceDocumentChecksum": SOURCE_SHA256,
        "boundsConvention": "PDF_POINTS_TOP_LEFT_X0_Y0_X1_Y1_ZERO_ROTATION",
        "scope": "PRIVATE_DEVELOPMENT_ONLY",
    }


def unique_json_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    data: dict[str, Any] = {}
    for key, value in pairs:
        if key in data:
            raise AssetError("Duplicate key in the asset manifest.")
        data[key] = value
    return data


def load_manifest(output: Path) -> dict[str, Any]:
    path = manifest_path(output)
    if not path.is_file() or path.stat().st_size > 300_000:
        raise AssetError("Missing or invalid private assets.json; run extract first.")
    try:
        data = json.loads(path.read_bytes(), object_pairs_hook=unique_json_object)
    except (UnicodeError, json.JSONDecodeError) as error:
        raise AssetError("The asset manifest is not valid JSON.") from error
    if (
        not isinstance(data, dict)
        or set(data) != {*manifest_header(), "placements", "summary"}
        or any(data.get(k) != v for k, v in manifest_header().items())
    ):
        raise AssetError("The asset manifest does not match this source or schema.")
    placements = data.get("placements")
    if not isinstance(placements, list) or len(placements) != SOURCE_PLACEMENT_COUNT:
        raise AssetError("The asset manifest has an unexpected number of placements.")
    ids: set[str] = set()
    for item in placements:
        if (
            not isinstance(item, dict)
            or not isinstance(item.get("assetId"), str)
            or not ASSET_ID.fullmatch(item["assetId"])
            or item["assetId"] in ids
            or type(item.get("sourcePage")) is not int
            or not 2 <= item["sourcePage"] <= SOURCE_PAGE_COUNT
            or (item.get("path") is not None and not isinstance(item["path"], str))
            or item.get("productionEligibility") is not False
            or not isinstance(item.get("classification"), str)
        ):
            raise AssetError("Invalid or duplicate asset placement metadata.")
        if item["path"] is not None:
            checked_asset_path(output, item["path"])
        ids.add(item["assetId"])
    if data.get("summary") != summary(placements):
        raise AssetError("Asset summary does not match the placement records.")
    return data


def selected_placement(
    document: fitz.Document, manifest: dict[str, Any], asset_id: str
) -> tuple[int, dict[str, Any], Placement]:
    if not ASSET_ID.fullmatch(asset_id):
        raise AssetError("Invalid asset ID.")
    for index, item in enumerate(manifest["placements"]):
        if item["assetId"] == asset_id:
            candidates = scan_page(document, item["sourcePage"])
            for candidate in candidates:
                if candidate.asset_id == asset_id:
                    return index, item, candidate
            raise AssetError("The asset ID is not traceable to its recorded source page.")
    raise AssetError("Asset ID is not in the manifest.")


def validate_entry(
    document: fitz.Document, output: Path, item: dict[str, Any], placement: Placement
) -> None:
    crop = item.get("crop")
    repaired = (
        crop_bounds(placement, crop.get("bounds"))
        if isinstance(crop, dict) and crop.get("mode") == "SOURCE_PAGE_CROP"
        else None
    )
    expected, payload = placement_record(document, placement, repaired)
    if expected != item:
        raise AssetError(f"Asset metadata differs from pinned source for {placement.asset_id}.")
    if payload is not None:
        path = checked_asset_path(output, expected["path"])
        if (
            not path.is_file()
            or path.stat().st_size != len(payload)
            or sha256(path.read_bytes()) != expected["checksum"]
        ):
            raise AssetError(f"Private asset bytes differ for {placement.asset_id}.")


def extract(document: fitz.Document, output: Path) -> dict[str, int]:
    with manifest_lock(output):
        planned = [placement_record(document, placement) for placement in scan_all(document)]
        records = [record for record, _ in planned]
        data = {**manifest_header(), "placements": records, "summary": summary(records)}
        path = manifest_path(output)
        manifest_data = encode_manifest(data)
        if path.exists() and path.read_bytes() != manifest_data:
            raise AssetError("An existing asset manifest differs. Use validate or repair; no reimport overwrite.")
        for record, payload in planned:
            if payload is not None:
                atomic_write(checked_asset_path(output, record["path"]), payload)
        atomic_write(path, manifest_data)
        return data["summary"]


def validate(document: fitz.Document, output: Path, asset_id: str | None) -> dict[str, Any]:
    data = load_manifest(output)
    if asset_id:
        _, item, placement = selected_placement(document, data, asset_id)
        validate_entry(document, output, item, placement)
        return {"assetId": asset_id, "validatedPlacements": 1}
    expected = scan_all(document)
    if [p.asset_id for p in expected] != [item["assetId"] for item in data["placements"]]:
        raise AssetError("Asset placement identities or source ordering differ from the pinned PDF.")
    for item, placement in zip(data["placements"], expected, strict=True):
        validate_entry(document, output, item, placement)
    return {"validatedPlacements": len(expected), **data["summary"]}


def preview_or_repair(
    document: fitz.Document,
    output: Path,
    asset_id: str,
    values: list[float],
    expected_preview: str | None,
) -> dict[str, Any]:
    with manifest_lock(output):
        data = load_manifest(output)
        index, item, placement = selected_placement(document, data, asset_id)
        validate_entry(document, output, item, placement)
        new_record, payload = placement_record(document, placement, crop_bounds(placement, values))
        if payload is None:
            raise AssetError("No source crop bytes are available.")
        digest = new_record["checksum"]
        if expected_preview is None:
            relative = f"previews/{placement.asset_id}-{digest[:16]}.png"
            atomic_write(checked_asset_path(output, relative, "previews"), payload)
            return {
                "assetId": asset_id,
                "previewPath": relative,
                "previewSha256": digest,
                "outputDimensions": new_record["outputDimensions"],
                "crop": new_record["crop"],
            }
        if not DIGEST.fullmatch(expected_preview) or expected_preview != digest:
            raise AssetError("Reviewed preview checksum does not match the requested crop; no changes written.")
        preview = checked_asset_path(output, f"previews/{placement.asset_id}-{digest[:16]}.png", "previews")
        if not preview.is_file() or preview.stat().st_size != len(payload) or sha256(preview.read_bytes()) != digest:
            raise AssetError("Generate and inspect the matching private preview before saving repair metadata.")
        atomic_write(checked_asset_path(output, new_record["path"]), payload)
        validate_entry(document, output, new_record, placement)
        data["placements"][index] = new_record
        data["summary"] = summary(data["placements"])
        atomic_write(manifest_path(output), encode_manifest(data), overwrite=True)
        return {
            "assetId": asset_id,
            "sha256": digest,
            "validatedPlacements": 1,
            "productionEligible": False,
        }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="operation", required=True)
    for name in ("extract", "validate", "preview", "repair"):
        command = commands.add_parser(name)
        command.add_argument("--pdf", required=True, type=Path)
        command.add_argument("--output-dir", required=True, type=Path)
        if name != "extract":
            command.add_argument("--asset-id", required=name in ("preview", "repair"))
        if name in ("preview", "repair"):
            command.add_argument("--crop", type=float, nargs=4, required=True, metavar="PT")
        if name == "repair":
            command.add_argument("--expected-preview-sha256", required=True)
    options = parser.parse_args(argv)
    try:
        with pinned_pdf(options.pdf) as document:
            output = private_output(options.output_dir, create=options.operation == "extract")
            if options.operation == "extract":
                result = extract(document, output)
            elif options.operation == "validate":
                result = validate(document, output, options.asset_id)
            else:
                result = preview_or_repair(
                    document,
                    output,
                    options.asset_id,
                    options.crop,
                    getattr(options, "expected_preview_sha256", None),
                )
    except (AssetError, OSError, RuntimeError, IndexError, KeyError) as error:
        # Don't echo OS errors containing private absolute paths into build or shell logs.
        message = str(error) if isinstance(error, AssetError) else "Local PDF/asset operation could not complete."
        print(f"Asset pipeline: {message}", file=sys.stderr)
        return 1
    print(json.dumps({"result": "PASS", **result}, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
