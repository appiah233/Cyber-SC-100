"""Synthetic unit checks plus an opt-in, private source smoke test."""

from __future__ import annotations

import contextlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

import fitz

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts" / "source"))
import assets as pipeline


def synthetic_pdf() -> fitz.Document:
    pdf = fitz.open()
    pdf.new_page()
    page = pdf.new_page()
    page.insert_text((24, 24), "Question 1")
    samples = bytes((11, 22, 33)) * 20 * 12
    pixmap = fitz.Pixmap(fitz.csRGB, 20, 12, samples, 0)
    page.insert_image(fitz.Rect(30, 45, 90, 81), pixmap=pixmap)
    return pdf


class AssetPipelineTests(unittest.TestCase):
    def test_unapproved_pdf_is_rejected_before_output_creation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "different.pdf"
            source.write_bytes(b"not the pinned document")
            output = root / "new"
            with contextlib.redirect_stderr(io.StringIO()) as stderr:
                outcome = pipeline.main(
                    ["extract", "--pdf", str(source), "--output-dir", str(output)]
                )
            self.assertEqual(outcome, 1)
            self.assertIn("checksum does not match", stderr.getvalue())
            self.assertFalse(output.exists())

    def test_private_output_refuses_project_relative_and_traversal_paths(self) -> None:
        with self.assertRaises(pipeline.AssetError):
            pipeline.private_output(pipeline.PROJECT_ROOT / "public" / "private", create=True)
        with self.assertRaises(pipeline.AssetError):
            pipeline.private_output(Path("relative"), create=True)
        with self.assertRaises(pipeline.AssetError):
            pipeline.private_output(Path("/tmp/one/../escape"), create=True)

    def test_private_output_refuses_symlink_and_other_git_worktree(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            real = root / "real"
            real.mkdir(mode=0o700)
            alias = root / "alias"
            alias.symlink_to(real, target_is_directory=True)
            with self.assertRaises(pipeline.AssetError):
                pipeline.private_output(alias / "child", create=True)
            (real / ".git").mkdir()
            (real / ".git" / "HEAD").write_text("ref: refs/heads/demo", encoding="utf-8")
            with self.assertRaises(pipeline.AssetError):
                pipeline.private_output(real / "child", create=True)
            self.assertFalse((real / "child").exists())

    @unittest.skipUnless(os.name == "posix", "POSIX permissions only")
    def test_private_output_refuses_world_accessible_directory(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            exposed = Path(directory) / "exposed"
            exposed.mkdir(mode=0o755)
            exposed.chmod(0o755)
            with self.assertRaisesRegex(pipeline.AssetError, "owner-only"):
                pipeline.private_output(exposed)

    def test_unsafe_manifest_asset_paths_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            dest = Path(directory)
            for candidate in (
                "../outside.png", "/assets/ab.png", "assets/../ab.png",
                "assets/%2e%2e.png", "assets//ab.png", "assets\\ab.png",
                "assets/ab.svg", "assets/ab.html", "elsewhere/ab.png", "assets/./ab.png",
            ):
                with self.subTest(candidate=candidate), self.assertRaises(pipeline.AssetError):
                    pipeline.checked_asset_path(dest, candidate)
            self.assertEqual(
                pipeline.checked_asset_path(dest, "assets/sc100-exhibit-01.png"),
                dest / "assets" / "sc100-exhibit-01.png",
            )

    def test_generated_asset_symlink_does_not_write_external_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            dest = root / "private"
            outside = root / "other-location"
            dest.mkdir(mode=0o700)
            outside.mkdir()
            (dest / "assets").symlink_to(outside, target_is_directory=True)
            with self.assertRaisesRegex(pipeline.AssetError, "Symlink"):
                pipeline.checked_asset_path(dest, "assets/sc100-fixture.png")
            self.assertEqual(list(outside.iterdir()), [])

    def test_synthetic_raster_has_reproducible_provenance_and_bytes(self) -> None:
        with synthetic_pdf() as document:
            placement, = pipeline.scan_page(document, 2)
            self.assertEqual(placement.asset_id, "sc100-q001-p002-exhibit-01")
            self.assertEqual(placement.bounds, (30.0, 45.0, 90.0, 81.0))
            first, pixels = pipeline.placement_record(document, placement)
            second, again = pipeline.placement_record(document, placement)
            self.assertEqual(first, second)
            self.assertEqual(pixels, again)
            self.assertEqual(first["checksum"], pipeline.sha256(pixels))
            self.assertEqual(first["originalDimensions"], [20, 12])
            self.assertEqual(first["outputDimensions"], [20, 12])
            self.assertFalse(first["productionEligibility"])

    def test_crop_must_stay_within_meaningful_reviewed_exhibit_bounds(self) -> None:
        with synthetic_pdf() as document:
            placement, = pipeline.scan_page(document, 2)
            invalid = [
                (29.0, 45.0, 90.0, 81.0), (30.0, 45.0, 91.0, 81.0),
                (float("nan"), 45.0, 90.0, 81.0), (True, 45.0, 90.0, 81.0),
                (30.0, 45.0, 33.0, 48.0), (30.0, 45.0, 10**1000, 81.0),
            ]
            for bounds in invalid:
                with self.subTest(bounds=bounds), self.assertRaises(pipeline.AssetError):
                    pipeline.crop_bounds(placement, bounds)
            output = pipeline.crop_bounds(placement, (34.1, 48.2, 76.5, 79.5))
            image, shape = pipeline.render_crop(document, placement, output)
            self.assertGreater(len(image), 0)
            self.assertEqual(shape, (126, 93))
        placeholder = pipeline.Placement(44, 44, 1, 187, (30.0, 45.0, 90.0, 81.0), (9, 6))
        with self.assertRaisesRegex(pipeline.AssetError, "placeholders"):
            pipeline.crop_bounds(placeholder, placeholder.bounds)

    def test_private_manifest_write_does_not_clobber_an_existing_file(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "asset.png"
            pipeline.atomic_write(destination, b"original")
            pipeline.atomic_write(destination, b"original")
            with self.assertRaisesRegex(pipeline.AssetError, "not overwritten"):
                pipeline.atomic_write(destination, b"different")
            self.assertEqual(destination.read_bytes(), b"original")

    def test_manifest_rejects_ambiguous_duplicate_json_keys(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            dest = Path(directory)
            (dest / "assets.json").write_text('{"schemaVersion": 1, "schemaVersion": 1}', encoding="utf-8")
            with self.assertRaisesRegex(pipeline.AssetError, "Duplicate key"):
                pipeline.load_manifest(dest)


@unittest.skipUnless(os.environ.get("SC100_PRIVATE_PDF"), "protected source not available in public tests")
class ProtectedAssetSmoke(unittest.TestCase):
    def test_all_placements_and_isolated_preview_repair(self) -> None:
        pdf = Path(os.environ["SC100_PRIVATE_PDF"])
        with tempfile.TemporaryDirectory() as directory, pipeline.pinned_pdf(pdf) as source:
            output = pipeline.private_output(Path(directory))
            self.assertEqual(pipeline.extract(source, output)["placements"], 27)
            self.assertEqual(pipeline.validate(source, output, None)["validatedPlacements"], 27)
            initial_bytes = (output / "assets.json").read_bytes()
            before = json.loads(initial_bytes)
            self.assertEqual(pipeline.extract(source, output)["privateAssetFiles"], 22)
            self.assertEqual((output / "assets.json").read_bytes(), initial_bytes)
            placements = before["placements"]
            placeholder = [x for x in placements if x["sourceQuestionId"] in {"Q44", "Q113"}]
            self.assertEqual(len(placeholder), 2)
            self.assertTrue(all(x["path"] is None and not x["requiredForInteraction"] for x in placeholder))
            q360, = [x for x in placements if x["sourceQuestionId"] == "Q360"]
            self.assertEqual(q360["reviewStatus"], "SOURCE_INTERACTION_REVIEW_REQUIRED")
            shared = [x["path"] for x in placements if x["relationshipType"] == "CASE_CANDIDATE_SHARED_EXHIBIT"]
            self.assertEqual(len(shared), 4)
            self.assertEqual(len(set(shared)), 1)

            exhibit = placements[0]
            asset_id, original_bounds = exhibit["assetId"], exhibit["sourceBounds"]
            coords = [
                original_bounds[0] + 0.25, original_bounds[1] + 0.25,
                original_bounds[2] - 0.25, original_bounds[3] - 0.25,
            ]
            previous_paths = {p.relative_to(output): p.read_bytes() for p in (output / "assets").iterdir()}
            preview = pipeline.preview_or_repair(source, output, asset_id, coords, None)
            with self.assertRaisesRegex(pipeline.AssetError, "checksum"):
                pipeline.preview_or_repair(source, output, asset_id, coords, "0" * 64)
            with self.assertRaisesRegex(pipeline.AssetError, "inside"):
                pipeline.preview_or_repair(source, output, asset_id, [0, 0, 500, 400], None)
            self.assertEqual((output / "assets.json").read_bytes(), initial_bytes)

            checksum = preview["previewSha256"]
            saved = pipeline.preview_or_repair(source, output, asset_id, coords, checksum)
            self.assertEqual(saved["sha256"], checksum)
            self.assertFalse(saved["productionEligible"])
            after = pipeline.load_manifest(output)["placements"]
            self.assertNotEqual(placements[0], after[0])
            self.assertEqual(placements[1:], after[1:])
            self.assertTrue(all((output / p).read_bytes() == b for p, b in previous_paths.items()))
            self.assertEqual(pipeline.validate(source, output, asset_id)["validatedPlacements"], 1)
            self.assertEqual(pipeline.validate(source, output, None)["validatedPlacements"], 27)
            with self.assertRaisesRegex(pipeline.AssetError, "manifest differs"):
                pipeline.extract(source, output)

            # Corrupt just the regenerated private asset. SHA validation must fail closed.
            (output / after[0]["path"]).write_bytes(b"not the verified asset")
            with self.assertRaisesRegex(pipeline.AssetError, "bytes differ"):
                pipeline.validate(source, output, asset_id)


if __name__ == "__main__":
    unittest.main()
