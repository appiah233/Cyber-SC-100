#!/usr/bin/env python3
"""Extract the pinned PDF in a private, local lane. Never invoked by public CI."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import unicodedata
from collections import Counter
from pathlib import Path
from typing import Any

PDF_SHA256 = "c1afae23f990c0ee3fc1a20b38ca2f945c244a8b827c50ce0b7e51a785003041"
PAGE_COUNT = 358
QUESTION_IDS = set(range(1, 361)) - {33, 110, 121}
SOURCE_COUNTS = {"Multiple Choice": 226, "Dropdown": 117, "Drag Drop": 12, "Statements": 2}
EXTRACTION_VERSION = "sc100-pdf-extraction-v1"
CHECKOUT = Path(__file__).resolve().parents[2]

QUESTION_HEADER = re.compile(r"^[ \t]*Question +(\d+) +Other +([^\n]+)$", re.M)
ANSWER_HEADING = re.compile(r"^[ \t]*Correct answers?[ \t]*$", re.M | re.I)
EXPLANATION_HEADING = re.compile(r"^[ \t]*Explanation[ \t]*$", re.M | re.I)
FOOTER = re.compile(r"^[ \t]*https://github\.com/\S+[ \t]+[^\n]+\n(?:[ \t\n]*Page \d+ of \d+[ \t\n]*)$", re.M)
OPTION_LINE = re.compile(r"^([A-Z])\.\s+(.+)")
CHOICE_ANSWER = re.compile(r"^[A-Z](?:\s*[,/&+]\s*[A-Z])*\s+—\s+")
SOURCE_TEXT_COLOR = 0x172033
SOURCE_ANSWER_COLOR = 0x14532D
SOURCE_EXPLANATION_COLOR = 0x0C4A6E
SOURCE_SCENARIO_COLOR = 0x4C1D95


class ExtractionError(Exception):
    """Failure safe to print without including private source content or paths."""


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ExtractionError(message)


def normalized(text: str) -> str:
    """Comparison only: raw source strings and stable option IDs are always retained."""
    return " ".join(re.findall(r"[\w]+", unicodedata.normalize("NFKC", text).casefold()))


def option_identity_text(text: str) -> str:
    """Normalize visual wraps and case, but preserve all option punctuation."""
    return " ".join(unicodedata.normalize("NFKC", text).casefold().split())


def comparable_ink(text: str) -> str:
    """Layout engines can insert spaces around glyphs; all other glyphs must agree."""
    return "".join(unicodedata.normalize("NFKC", text).split())


def split_pairs(lines: list[str], valid_option_text: set[str]) -> tuple[list[tuple[str, str]], list[str]]:
    """Join visual wrap continuations until a known answer option sits at the end."""
    items = []
    pending = []
    for line in lines:
        pending.append(line)
        joined = " ".join(pending)
        if " — " not in joined:
            continue
        label, value = joined.split(" — ", 1)
        if option_identity_text(value) in valid_option_text:
            items.append((label, value))
            pending = []
    return items, pending


def block_spans(page: Any, text_flags: int) -> list[list[tuple[float, int, str]]]:
    blocks = []
    for block in page.get_text("dict", flags=text_flags)["blocks"]:
        spans = [
            (span["bbox"][0], span["color"], span["text"])
            for line in block.get("lines", [])
            for span in line["spans"]
        ]
        if spans:
            blocks.append(spans)
    return blocks


def choice_mapping(prompt_blocks: list[tuple[float, str]], answers: list[str], question_id: int) -> tuple:
    options = {}
    for _, value in prompt_blocks:
        match = OPTION_LINE.match(value)
        if match:
            option_id, label = match.groups()
            require(option_id not in options, f"Duplicate option identity on Q{question_id}.")
            options[option_id] = label
    answer_lines = []
    for line in answers:
        if CHOICE_ANSWER.match(line):
            answer_lines.append(line)
        else:
            require(bool(answer_lines), f"Answer continuation without an option identity on Q{question_id}.")
            answer_lines[-1] += " " + line

    mapping = []
    seen = set()
    for line in answer_lines:
        option_id, value = line.split(" — ", 1)
        require(option_id in options and option_id not in seen
                and option_identity_text(options[option_id]) == option_identity_text(value),
                f"Answer option identity or rendered label mismatch on Q{question_id}.")
        seen.add(option_id)
        mapping.append({"option_id": option_id, "source_value": value})
    require(bool(mapping), f"No choice answer mapping on Q{question_id}.")
    return (
        [{"id": key, "text": value} for key, value in options.items()],
        [],
        mapping,
        "SINGLE_CHOICE" if len(mapping) == 1 else "MULTIPLE_CHOICE",
    )


def dropdown_mapping(prompt_blocks: list[tuple[float, str]], answers: list[str], question_id: int) -> tuple:
    runs: list[list[str]] = []
    labels = []
    previous = ""
    for x, content in prompt_blocks:
        if 42 < x < 54:
            if previous:
                runs.append([])
                labels.append(previous)
                previous = ""
            if runs:
                runs[-1].append(content)
        else:
            previous = content
    options = [
        {"id": f"T{i}:O{j}", "text": option}
        for i, run in enumerate(runs, start=1)
        for j, option in enumerate(run, start=1)
    ]
    targets = [{"id": f"T{i}", "source_label": label} for i, label in enumerate(labels, start=1)]
    pairs, tail = split_pairs(answers, {option_identity_text(option["text"]) for option in options})
    require(not tail and len(pairs) == len(runs) and bool(pairs),
            f"Dropdown target count or answer continuation mismatch on Q{question_id}.")
    mapping = []
    for i, ((label, value), target, choices) in enumerate(zip(pairs, labels, runs), start=1):
        key = normalized(label)
        found = [index for index, choice in enumerate(choices, start=1) if option_identity_text(choice) == option_identity_text(value)]
        require(len(found) == 1 and (normalized(target) == key or normalized(target).endswith(" " + key)),
                f"Dropdown target-specific identity mismatch on Q{question_id}.")
        mapping.append({
            "target_id": f"T{i}", "option_id": f"T{i}:O{found[0]}",
            "source_label": label, "source_value": value,
        })
    return options, targets, mapping, "DROPDOWN"


def drag_mapping(prompt_blocks: list[tuple[float, str]], answers: list[str], question_id: int) -> tuple:
    start = [i for i, (_, text) in enumerate(prompt_blocks) if text.strip() == "Match each item"]
    end = [i for i, (_, text) in enumerate(prompt_blocks) if text.strip().startswith("Available choices:")]
    require(len(start) == len(end) == 1 and start[0] < end[0],
            f"Drag/drop target or option list boundaries not unique on Q{question_id}.")
    labels = [value for _, value in prompt_blocks[start[0] + 1:end[0]]]
    choices = [value.strip() for value in prompt_blocks[end[0]][1].split(":", 1)[1].split("|")]
    options = [{"id": f"O{i}", "text": value} for i, value in enumerate(choices, start=1)]
    targets = [{"id": f"T{i}", "source_label": value} for i, value in enumerate(labels, start=1)]
    pairs, tail = split_pairs(answers, {option_identity_text(choice) for choice in choices})
    require(not tail and len(pairs) == len(labels) and bool(pairs),
            f"Matching/ordering row count mismatch on Q{question_id}.")
    mapping = []
    for i, ((label, value), target) in enumerate(zip(pairs, labels), start=1):
        found = [index for index, choice in enumerate(choices, start=1) if option_identity_text(choice) == option_identity_text(value)]
        require(len(found) == 1 and normalized(target) == normalized(label),
                f"Matching or ordering option identity mismatch on Q{question_id}.")
        mapping.append({
            "target_id": f"T{i}", "option_id": f"O{found[0]}",
            "source_label": label, "source_value": value,
        })
    kind = "ORDERING" if all(re.fullmatch(r"Step \d+", label) for label in labels) else "MATCHING"
    return options, targets, mapping, kind


def statement_mapping(
    prompt_spans: list[list[tuple[float, int, str]]], answers: list[str], question_id: int,
) -> tuple:
    headings = [i for i, spans in enumerate(prompt_spans) if spans[0][2] == "Statement"]
    require(len(headings) == 1, f"Statement table boundary not unique on Q{question_id}.")
    tail_spans = prompt_spans[headings[0] + 1:]
    # The statement body and the Yes/No options have separate positions, even when the
    # body wraps. Preserve the raw visual spans and join only within one text block.
    labels = [
        label for block in tail_spans
        if (label := " ".join(text for x, color, text in block if x < 100 and color == SOURCE_TEXT_COLOR))
    ]
    options = [{"id": text.upper(), "text": text} for text in ("Yes", "No")]
    targets = [{"id": f"T{i}", "source_label": label} for i, label in enumerate(labels, start=1)]
    pairs, tail = split_pairs(answers, {"yes", "no"})
    require(not tail and len(pairs) == len(labels) and bool(pairs),
            f"Statement target count mismatch on Q{question_id}.")
    mapping = []
    for i, ((label, value), target) in enumerate(zip(pairs, labels), start=1):
        require(normalized(target) == normalized(label),
                f"Statement answer identity differs from the rendered row on Q{question_id}.")
        mapping.append({
            "target_id": f"T{i}", "option_id": value.upper(),
            "source_label": label, "source_value": value,
        })
    return options, targets, mapping, "STATEMENT"


def display_projection(
    source_type: str,
    prompt_blocks: list[tuple[float, str]],
    targets: list[dict],
    mapping: list[dict],
) -> tuple[str | None, list[dict]]:
    """Only expose a separated stem when the source block boundary is identifiable."""
    display_targets = targets
    first_option = None
    stem = []
    if source_type == "Multiple Choice":
        first_option = next((i for i, (_, text) in enumerate(prompt_blocks) if OPTION_LINE.match(text)), None)
    elif source_type == "Drag Drop":
        first_option = next((i for i, (_, text) in enumerate(prompt_blocks) if text.strip() == "Match each item"), None)
    elif source_type == "Statements":
        first_option = next((i for i, (_, text) in enumerate(prompt_blocks) if re.match(r"^Statement\s+Optio", text)), None)
    else:
        first_option = next(
            (i for i, (x, text) in enumerate(prompt_blocks)
             if 42 < x < 54 and text and i > 0 and prompt_blocks[i - 1][1] == targets[0]["source_label"]),
            None,
        )
        labels = []
        for target, answer in zip(targets, mapping):
            source_label = target["source_label"]
            match = re.search(r"(?<!\S)" + re.escape(answer["source_label"]) + r"[:?.]?\s*$", source_label, re.I)
            if match is None:
                return None, targets
            labels.append({"id": target["id"], "source_label": match[0].strip()})
        display_targets = labels
        if first_option is not None:
            original_target_block = prompt_blocks[first_option - 1][1]
            # Find the left boundary of the *rendered* label without rewriting it.
            prefix = original_target_block[:len(original_target_block.rstrip()) - len(labels[0]["source_label"])].rstrip()
            stem = [text for _, text in prompt_blocks[:first_option - 1]]
            if prefix:
                stem.append(prefix)
            return "\n\n".join(stem).strip() or None, display_targets

    if first_option is not None:
        stem = [text for _, text in prompt_blocks[:first_option]]
    return "\n\n".join(stem).strip() or None, display_targets


def asset_references(page: Any, question_id: int, source_page: int) -> list[dict]:
    references = []
    for ordinal, image in enumerate(page.get_image_info(xrefs=True), start=1):
        dimensions = (image["width"], image["height"])
        require(all(isinstance(value, int) and value > 0 for value in dimensions),
                f"Invalid image dimensions on Q{question_id}.")
        references.append({
            "sourceQuestionId": question_id,
            "sourcePage": source_page,
            "placement": ordinal,
            "pdfXref": image["xref"],
            "bounds": list(image["bbox"]),
            "originalDimensions": {"width": dimensions[0], "height": dimensions[1]},
        })
    return references


def extract_row(page: Any, layout: str, source_page: int, text_flags: int) -> dict:
    headers = list(QUESTION_HEADER.finditer(layout))
    require(len(headers) == 1, f"Question header missing or duplicated on source page {source_page}.")
    heading = headers[0]
    question_id = int(heading[1])
    source_type = heading[2].strip()
    require(question_id in QUESTION_IDS and source_type in SOURCE_COUNTS,
            f"Unexpected source identity or interaction at source page {source_page}.")

    spans = block_spans(page, text_flags)
    starts = [i for i, block in enumerate(spans) if any(text == f"Question {question_id}" for _, _, text in block)]
    answers = [
        i for i, block in enumerate(spans)
        if any(color == SOURCE_ANSWER_COLOR and text in ("Correct answer", "Correct answers")
               for _, color, text in block)
    ]
    explanations = [
        i for i, block in enumerate(spans)
        if any(color == SOURCE_EXPLANATION_COLOR and text == "Explanation" for _, color, text in block)
    ]
    require(len(starts) == len(answers) == len(explanations) == 1
            and starts[0] < answers[0] < explanations[0], f"Non-unique source block boundaries on Q{question_id}.")
    prompt_spans = spans[starts[0] + 1:answers[0]]
    require(bool(prompt_spans), f"No prompt spans on Q{question_id}.")
    answer_lines = [
        text for block in spans[answers[0] + 1:explanations[0]] for _, color, text in block
        if color == SOURCE_ANSWER_COLOR
    ]
    explanation_lines = [
        text for block in spans[explanations[0]:] for _, color, text in block
        if color == SOURCE_EXPLANATION_COLOR and text != "Explanation"
    ]

    answer_heading = list(ANSWER_HEADING.finditer(layout, heading.end()))
    explanation_heading = list(EXPLANATION_HEADING.finditer(layout, heading.end()))
    require(len(answer_heading) == len(explanation_heading) == 1
            and heading.end() < answer_heading[0].start() < explanation_heading[0].start(),
            f"Layout extractor could not bound source sections on Q{question_id}.")
    source_answer_layout = layout[answer_heading[0].end():explanation_heading[0].start()].strip("\n")
    require(bool(answer_lines) and bool(source_answer_layout.strip())
            and comparable_ink(source_answer_layout) == comparable_ink(" ".join(answer_lines)),
            f"Independent PDF extractors disagree on the answer block on Q{question_id}.")

    footer = FOOTER.search(layout, explanation_heading[0].end())
    require(footer is not None, f"Layout extractor could not bound the explanation on Q{question_id}.")
    question_layout = layout[heading.end():answer_heading[0].start()].strip("\n")
    explanation_layout = layout[explanation_heading[0].end():footer.start()].strip("\n")
    require(bool(explanation_lines) and bool(explanation_layout.strip()) and bool(question_layout.strip()),
            f"No source prompt or explanation on Q{question_id}.")

    prompt_blocks = [
        (block[0][0], " ".join(text for _, color, text in block if color == SOURCE_TEXT_COLOR))
        for block in prompt_spans if block[0][1] == SOURCE_TEXT_COLOR
    ]
    if source_type == "Multiple Choice":
        options, targets, mapping, subtype = choice_mapping(prompt_blocks, answer_lines, question_id)
        phase0_label = source_type
    elif source_type == "Dropdown":
        options, targets, mapping, subtype = dropdown_mapping(prompt_blocks, answer_lines, question_id)
        phase0_label = source_type
        if re.search(r"^[ \t]*HOTSPOT\b", question_layout, re.M | re.I):
            subtype = phase0_label = "DROPDOWN_HOTSPOT"
        elif question_id == 360:
            phase0_label = "DIAGRAM_DEPENDENT_DROPDOWN"
    elif source_type == "Drag Drop":
        options, targets, mapping, subtype = drag_mapping(prompt_blocks, answer_lines, question_id)
        phase0_label = subtype
    else:
        options, targets, mapping, subtype = statement_mapping(prompt_spans, answer_lines, question_id)
        phase0_label = "STATEMENT_INTERACTION"

    # The two extractors have different line wrapping. The Q253 check independently
    # reconstructs the answers from the layout text and compares every mapped stable
    # target/choice pair without embedding any of that question's answers in code.
    if question_id == 253:
        layout_pairs, unconsumed = split_pairs(source_answer_layout.splitlines(), {"yes", "no"})
        require(len(targets) == len(mapping) == len(layout_pairs) == 3 and not unconsumed
                and [(normalized(label), normalized(value)) for label, value in layout_pairs]
                == [(normalized(item["source_label"]), normalized(item["source_value"])) for item in mapping]
                and [item["target_id"] for item in mapping] == [target["id"] for target in targets],
                "Q253 independent wrapped-statement identity check failed.")

    display_prompt, display_targets = display_projection(source_type, prompt_blocks, targets, mapping)
    scenario_lines = [
        text for block in prompt_spans for _, color, text in block
        if color == SOURCE_SCENARIO_COLOR
    ]

    # Verify derived display views against the independent source layout; leave
    # the raw area untouched when the logical sections are recorded separately.
    layout_text = " ".join(question_layout.split())
    require(display_prompt is not None and " ".join(display_prompt.split()) in layout_text,
            f"Display stem does not match the raw source layout on Q{question_id}.")
    require(not scenario_lines or " ".join(" ".join(scenario_lines).split()) in layout_text,
            f"Scenario source spans do not match the raw source layout on Q{question_id}.")

    issues = {
        6: "SOURCE_CONTENT_INCONSISTENCY_REVIEW",
        44: "SOURCE_PLACEHOLDER_NO_RECOVERABLE_EXHIBIT",
        113: "SOURCE_PLACEHOLDER_NO_RECOVERABLE_EXHIBIT",
        360: "SOURCE_INTERACTION_REVIEW_REQUIRED",
    }
    return {
        "SourceQuestionId": question_id,
        "SourcePage": source_page,
        "QuestionType": source_type,
        "RawQuestionAreaLayout": question_layout,
        "PromptText": display_prompt,
        "SourceScenarioLines": scenario_lines,
        "DisplayTargets": display_targets,
        "RawAnswerBlock": answer_lines,
        "RawAnswerBlockLayout": source_answer_layout,
        "RawExplanationLayout": explanation_layout,
        "SourceAssetReferences": asset_references(page, question_id, source_page),
        "ParsedAnswerDefinition": mapping,
        "AnswerOptionIds": [option["id"] for option in options],
        "Options": options,
        "Targets": targets,
        "AnswerBlockPresent": True,
        "AnswerStructureParsed": True,
        "ExplanationPresent": True,
        "MappingValidated": True,
        "ValidationStatus": "VALIDATED",
        "AnswerMappingStatus": "SOURCE_MAPPING_VALIDATED",
        "StructuralValidation": "PASS",
        "SemanticSourceMappingReview": "NOT_RECORDED",
        "PublishedMappingVerified": False,
        "ReviewReason": "Source answer maps uniquely to rendered source options/targets; separate publication and semantic explanation review not performed",
        "ReviewNotes": [],
        "SourceInteractionType": source_type,
        "RenderedInteractionType": phase0_label,
        "NormalizedInteractionType": subtype,
        "RequiresDiagram": None,
        "InteractionValidated": True,
        "EligibleForFinalBlock": False,
        "ProductionEligibility": False,
        "ReviewStatus": issues.get(question_id, "PENDING_OWNER_OR_CONTENT_APPROVAL"),
    }


def checked_output(requested: Path, source: Path) -> Path:
    require(requested.is_absolute(), "The output path must be absolute and outside the repository.")
    require(not requested.is_symlink(), "The output path must not be a symbolic link.")
    result = requested.resolve()
    require(result != source, "The output cannot replace the input PDF.")
    require(not result.is_relative_to(CHECKOUT), "Private extraction cannot write inside the repository.")
    for parent in result.parents:
        git_marker = parent / ".git"
        require(not (git_marker.is_file() or (git_marker / "HEAD").is_file()),
                "Private extraction cannot write inside a Git working tree.")
    require(result.parent.is_dir() and (not result.exists() or result.is_file()),
            "The private output parent must exist and the output must be a writable file location.")
    return result


def extract_snapshot(pdf_bytes: bytes) -> dict:
    require(hashlib.sha256(pdf_bytes).hexdigest() == PDF_SHA256,
            "Source PDF checksum mismatch; extraction refused.")
    try:
        import fitz  # type: ignore[import-not-found]  # PyMuPDF is a private-lane dependency.
    except ImportError as error:
        raise ExtractionError("PyMuPDF is required for private source extraction.") from error
    try:
        layout = subprocess.run(
            ["pdftotext", "-layout", "-enc", "UTF-8", "-", "-"],
            input=pdf_bytes,
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=60,
        ).stdout.decode("utf-8")
    except (OSError, UnicodeError, subprocess.SubprocessError) as error:
        raise ExtractionError("Poppler failed to extract the pinned PDF layout.") from error

    layout_pages = layout.split("\f")
    require(len(layout_pages) == PAGE_COUNT + 1 and layout_pages[-1] == "",
            "Layout extractor returned an unexpected page inventory.")
    require(not QUESTION_HEADER.search(layout_pages[0]), "Unexpected question header on cover page.")
    with fitz.open(stream=pdf_bytes, filetype="pdf") as document:
        require(len(document) == PAGE_COUNT, "Pinned source page inventory mismatch.")
        rows = [
            extract_row(document[index], layout_pages[index], index + 1, fitz.TEXTFLAGS_TEXT)
            for index in range(1, PAGE_COUNT)
        ]

    ids = [row["SourceQuestionId"] for row in rows]
    require(len(ids) == len(set(ids)) == len(QUESTION_IDS) and set(ids) == QUESTION_IDS
            and ids == sorted(ids), "Source question identity inventory changed or was reordered.")
    require(Counter(row["QuestionType"] for row in rows) == SOURCE_COUNTS, "Source interaction inventory changed.")
    by_id = {row["SourceQuestionId"]: row for row in rows}
    require({row["SourceQuestionId"] for row in rows if row["NormalizedInteractionType"] == "DROPDOWN_HOTSPOT"}
            == {104, 225}, "Dropdown HOTSPOT classification contradicted source.")
    require(Counter(row["NormalizedInteractionType"] for row in rows if row["QuestionType"] == "Drag Drop")
            == {"MATCHING": 6, "ORDERING": 6}, "Drag/drop semantic classification contradicted source.")
    require(sum(bool(row["SourceScenarioLines"]) for row in rows) == 42,
            "Scenario source range count contradicted the pinned source.")
    require(sum(len(row["SourceAssetReferences"]) for row in rows) == 27,
            "Source asset placement count contradicted the pinned source.")
    require(all(by_id[question_id]["NormalizedInteractionType"] == "MATCHING" for question_id in (64, 145)),
            "Reference matching classification contradicted source.")
    return {"pdf_sha256": PDF_SHA256, "pages": PAGE_COUNT, "extraction_version": EXTRACTION_VERSION, "rows": rows}


def write_private(path: Path, snapshot: dict) -> None:
    payload = json.dumps(snapshot, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False) + "\n"
    temporary = None
    try:
        descriptor, name = tempfile.mkstemp(prefix=".extract-", suffix=".tmp", dir=path.parent)
        temporary = Path(name)
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as file:
            file.write(payload)
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--pdf", type=Path, required=True, help="absolute path to the privately supplied PDF")
    parser.add_argument("--output", type=Path, required=True, help="absolute private JSON path outside any Git checkout")
    args = parser.parse_args()
    try:
        require(args.pdf.is_absolute(), "The source PDF path must be absolute.")
        source = args.pdf.resolve()
        output = checked_output(args.output, source)
        try:
            pdf_bytes = source.read_bytes()
        except OSError as error:
            raise ExtractionError("Cannot read the private source PDF.") from error
        # Both extraction engines get the same in-memory bytes whose digest is checked
        # before parsing. No re-read of a mutable file can change the checked snapshot.
        snapshot = extract_snapshot(pdf_bytes)
        try:
            write_private(output, snapshot)
        except (OSError, ValueError) as error:
            raise ExtractionError("Cannot write a private extraction snapshot.") from error
    except ExtractionError as error:
        print(f"Private source extraction failed: {error}", file=sys.stderr)
        return 1
    print("Pinned PDF checksum: PASS")
    print(f"Pages: {PAGE_COUNT}")
    print(f"Source records: {len(snapshot['rows'])}")
    print(f"Source mappings structurally validated: {len(snapshot['rows'])}")
    print("Q253 wrapped-statement identity: PASS")
    print("Published mappings compared: 0; semantic review not recorded by this extraction command.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
