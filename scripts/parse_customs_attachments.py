#!/usr/bin/env python3
"""Extract product customs values from downloaded JianDaoYun attachments.

The Thai customs declaration layout is read as text with pypdf.  A product
line is accepted only when the same item block contains all of these:

* a customs HS code;
* a quantity whose unit is C62;
* a description containing "Heating Element", "Heating Tube", or "Heating Coil";
* the Thai-baht customs value printed immediately after the HS code.

Every PDF found in the purchase record's related-material field is treated as
an independent declaration source.  Lines are never removed merely because
another PDF contains the same model, quantity and customs value; the audit
report records such fingerprints for review without changing the totals.
"""

from __future__ import annotations

import hashlib
import json
import re
import sys
from collections import defaultdict
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Any, Iterable

from pypdf import PdfReader


ROOT = Path(__file__).resolve().parents[1]
ATTACHMENT_DIR = ROOT / "data" / "attachments"
PARSED_DIR = ROOT / "data" / "parsed"
MANIFEST_PATH = ATTACHMENT_DIR / "manifest.json"
PURCHASES_PATH = ROOT / "data" / "raw" / "purchases.json"
MANUAL_CUSTOMS_LINES_PATH = ROOT / "config" / "manual-customs-lines.json"

PURCHASE_MONTH = "_widget_1638440938270"
PURCHASE_DATE = "_widget_1517542638204"
PURCHASE_ITEM = "_widget_1727337817607"
PURCHASE_AMOUNT = "_widget_1727337817617"
PURCHASE_RELATED_DOCUMENTS = "_widget_1727337817611"

HS_RE = re.compile(r"^\d{4}\.\d{2}\.\d{2}$")
QTY_RE = re.compile(r"^([\d,]+(?:\.\d+)?)\s*C\s*62$", re.I)
MONEY_RE = re.compile(r"^[\d,]+(?:\.\d+)?$")
PRODUCT_RE = re.compile(r"heating\s*(?:element|tube|coil)", re.I)
USD_RE = re.compile(r"\bUSD\s*([\d,]+(?:\.\d+)?)", re.I)


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(
        json.dumps(value, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    tmp.replace(path)


def decimal_value(raw: str) -> Decimal:
    return Decimal(raw.replace(",", "").strip())


def decimal_text(value: Decimal) -> str:
    return format(value, "f")


def clean_lines(text: str) -> list[str]:
    # U+001F is frequently emitted by the Thai embedded fonts as a broken
    # character. It is irrelevant to the English model/value fields.
    text = text.replace("\x1f", "")
    return [re.sub(r"\s+", " ", line).strip() for line in text.splitlines()]


def canonical_model(description: str) -> str:
    value = description.strip()

    # Prefer the text after the final Heating Element marker.  This handles
    # strings such as "PIPE(Heating Element/AF140/180)" and
    # "HEATING TUBE(HEATING ELEMENT/FS037B/120V1450W)".
    markers = list(re.finditer(r"heating\s*element\s*[/\-:]?\s*", value, re.I))
    if markers:
        value = value[markers[-1].end() :]
    else:
        marker = re.search(r"heating\s*(?:tube|coil)\s*[/\-:]?\s*", value, re.I)
        if marker:
            value = value[marker.end() :]

    value = value.strip(" ()[]{}:/;-_")
    value = re.sub(r"\s+", " ", value)
    value = re.sub(r"\s*/\s*", "/", value)
    value = re.sub(r"\s*-\s*", "-", value)
    upper = value.upper()

    # User-confirmed cost-family equivalence.
    if re.search(r"\bAF\s*1(?:40|80)(?:\s*/\s*AF?\s*1(?:40|80))?\b", upper):
        return "AF140/AF180"
    return upper


def cost_family(model: str) -> str:
    """Reduce voltage/power wording to the outbound model's base family."""
    compact = re.sub(r"[\s/_-]+", "", model.upper())
    if model == "AF140/AF180":
        return model
    # MC2000 declarations put the voltage/power before the model name
    # ("120V/1400W MC2000"), while outbound rows put the model first.
    if re.search(r"\bMC\s*2000\b", model, re.I):
        return "MC2000"
    known_prefixes = (
        "AF-U816A",
        "AFT06015",
        "AFT08003B",
        "AFT08015",
        "AFT11015A",
        "DC601",
        "DCT400",
        "DS16",
        "DT10L",
        "DT200",
        "DZ100",
        "FN100",
        "FS037B",
        "FS307A",
        "GR100",
        "MO100 UPPER",
        "MO100 LOWER",
        "MC2000",
        "TT1627R",
    )
    for prefix in known_prefixes:
        if compact.startswith(re.sub(r"[\s/_-]+", "", prefix)):
            return prefix
    return model


def product_description(lines: list[str], qty_index: int, end_index: int) -> tuple[int, str] | None:
    for index in range(qty_index + 1, min(end_index, qty_index + 18)):
        if PRODUCT_RE.search(lines[index]):
            return index, lines[index]
    return None


def extract_product_lines(text: str) -> list[dict[str, Any]]:
    lines = clean_lines(text)
    hs_indexes = [index for index, line in enumerate(lines) if HS_RE.fullmatch(line)]
    extracted: list[dict[str, Any]] = []

    for hs_position, hs_index in enumerate(hs_indexes):
        end_index = hs_indexes[hs_position + 1] if hs_position + 1 < len(hs_indexes) else len(lines)
        block = lines[hs_index:end_index]

        thb_value: Decimal | None = None
        for line in block[1:6]:
            if MONEY_RE.fullmatch(line):
                try:
                    thb_value = decimal_value(line)
                    break
                except InvalidOperation:
                    pass
        if thb_value is None:
            continue

        qty_index: int | None = None
        qty_value: Decimal | None = None
        for index in range(hs_index + 1, end_index):
            match = QTY_RE.fullmatch(lines[index])
            if match:
                qty_index = index
                qty_value = decimal_value(match.group(1))
                break
        if qty_index is None or qty_value is None:
            continue

        description_match = product_description(lines, qty_index, end_index)
        if not description_match:
            continue
        description_index, description = description_match
        model = canonical_model(description)
        if not model:
            continue

        usd_value: Decimal | None = None
        for line in lines[description_index : min(end_index, description_index + 10)]:
            match = USD_RE.search(line)
            if match:
                usd_value = decimal_value(match.group(1))
                break

        fingerprint_text = "|".join(
            [model, decimal_text(qty_value), decimal_text(thb_value)]
        )
        fingerprint = hashlib.sha256(fingerprint_text.encode("utf-8")).hexdigest()
        extracted.append(
            {
                "hs_code": lines[hs_index],
                "model": model,
                "cost_family": cost_family(model),
                "description": description,
                "quantity_c62": float(qty_value),
                "value_thb": float(thb_value),
                "value_usd_reference": float(usd_value) if usd_value is not None else None,
                "fingerprint": fingerprint,
                "fingerprint_text": fingerprint_text,
            }
        )

    return extracted


def classify_pdf(name: str, text: str, product_lines: list[dict[str, Any]]) -> str:
    upper_name = name.upper()
    has_c62 = bool(re.search(r"\bC\s*62\b", text, re.I))
    if product_lines:
        return "product_customs_declaration"
    if has_c62:
        return "non_product_customs_declaration"
    if len(text.strip()) < 30 and re.search(r"IMPORT|进口|0409|HF-MP", name, re.I):
        return "customs_scan_without_text"
    if upper_name.startswith("RE-") or "RECEIPT" in upper_name:
        return "tax_receipt"
    if "INVOICE" in upper_name:
        return "invoice"
    return "other"


def main() -> int:
    if not MANIFEST_PATH.exists() or not PURCHASES_PATH.exists():
        print("Run Sync-JianDaoYun.ps1 before parsing attachments.", file=sys.stderr)
        return 2

    manifest = []
    for saved_entry in read_json(MANIFEST_PATH):
        related_keys = []
        for source_key in saved_entry.get("source_keys") or []:
            parts = str(source_key).split("|", 2)
            if len(parts) >= 2 and parts[1] == PURCHASE_RELATED_DOCUMENTS:
                related_keys.append(source_key)
        if not related_keys:
            continue
        entry = {**saved_entry}
        entry["source_keys"] = related_keys
        entry["source_record_ids"] = sorted(
            {str(source_key).split("|", 2)[0] for source_key in related_keys}
        )
        manifest.append(entry)
    purchase_payload = read_json(PURCHASES_PATH)
    purchase_records = purchase_payload.get("data", purchase_payload)
    purchases = {record.get("_id"): record for record in purchase_records}
    manual_documents = {}
    if MANUAL_CUSTOMS_LINES_PATH.exists():
        manual_payload = read_json(MANUAL_CUSTOMS_LINES_PATH)
        manual_documents = {
            document["sha256"]: document
            for document in manual_payload.get("documents", [])
            if document.get("sha256")
        }

    inventory: list[dict[str, Any]] = []
    all_occurrences: list[dict[str, Any]] = []

    for entry in manifest:
        attachment_path = ATTACHMENT_DIR / entry["path"]
        names = entry.get("original_names") or [entry["path"]]
        source_ids = entry.get("source_record_ids") or []
        suffix = attachment_path.suffix.lower()
        inventory_entry: dict[str, Any] = {
            "sha256": entry.get("sha256"),
            "path": entry.get("path"),
            "original_names": names,
            "source_record_ids": source_ids,
            "file_type": suffix.lstrip("."),
            "classification": "image_or_other",
            "page_count": None,
            "text_characters": 0,
            "extracted_line_count": 0,
            "error": None,
        }

        if suffix != ".pdf":
            inventory.append(inventory_entry)
            continue

        try:
            reader = PdfReader(str(attachment_path))
            page_texts = [(page.extract_text() or "") for page in reader.pages]
            text = "\n".join(page_texts)
            product_lines = extract_product_lines(text)
            extraction_method = "text"
            manual_document = manual_documents.get(entry.get("sha256"))
            if manual_document and (
                not product_lines or manual_document.get("replace_auto", False)
            ):
                if manual_document.get("replace_auto", False):
                    product_lines = []
                    extraction_method = "manual_verified_override"
                else:
                    extraction_method = "manual_scan_transcription"
                for saved_line in manual_document.get("lines", []):
                    model = str(saved_line["model"]).strip()
                    quantity = Decimal(str(saved_line["quantity_c62"]))
                    value_thb = Decimal(str(saved_line["value_thb"]))
                    fingerprint_text = "|".join(
                        [model, decimal_text(quantity), decimal_text(value_thb)]
                    )
                    product_lines.append(
                        {
                            "hs_code": saved_line.get("hs_code"),
                            "model": model,
                            "cost_family": cost_family(model),
                            "description": saved_line.get("description"),
                            "quantity_c62": float(quantity),
                            "value_thb": float(value_thb),
                            "value_usd_reference": saved_line.get("value_usd_reference"),
                            "fingerprint": hashlib.sha256(
                                fingerprint_text.encode("utf-8")
                            ).hexdigest(),
                            "fingerprint_text": fingerprint_text,
                        }
                    )
            inventory_entry.update(
                {
                    "classification": classify_pdf(names[0], text, product_lines),
                    "page_count": len(reader.pages),
                    "text_characters": len(text),
                    "extracted_line_count": len(product_lines),
                    "extraction_method": extraction_method,
                }
            )

            for line in product_lines:
                purchase_meta = []
                for source_id in source_ids:
                    record = purchases.get(source_id, {})
                    purchase_meta.append(
                        {
                            "record_id": source_id,
                            "month": record.get(PURCHASE_MONTH),
                            "date": record.get(PURCHASE_DATE),
                            "item": record.get(PURCHASE_ITEM),
                            "purchase_amount_thb": record.get(PURCHASE_AMOUNT),
                        }
                    )
                all_occurrences.append(
                    {
                        **line,
                        "source_pdf_sha256": entry.get("sha256"),
                        "source_pdf_path": entry.get("path"),
                        "source_original_names": names,
                        "source_purchases": purchase_meta,
                    }
                )
        except Exception as exc:  # keep the rest of the batch usable
            inventory_entry["classification"] = "pdf_read_error"
            inventory_entry["error"] = f"{type(exc).__name__}: {exc}"
        inventory.append(inventory_entry)

    # Each paid Import tax purchase record contributes its single PDF from the
    # "related documents" field. Keep every extracted product line from that
    # PDF; identical-looking rows inside one declaration may be real rows.
    unique_lines: list[dict[str, Any]] = []
    for index, occurrence in enumerate(all_occurrences):
        record_ids = sorted(
            purchase["record_id"]
            for purchase in occurrence["source_purchases"]
            if purchase.get("record_id")
        )
        key_text = f"{occurrence['source_pdf_sha256']}|{index}|{occurrence['fingerprint']}"
        key = hashlib.sha256(key_text.encode("utf-8")).hexdigest()
        unique_lines.append(
            {
                **occurrence,
                "dedupe_key": key,
                "dedupe_record_ids": record_ids,
                "duplicate_occurrence_count": 1,
                "all_sources": [
                    {
                        "pdf_sha256": occurrence["source_pdf_sha256"],
                        "pdf_path": occurrence["source_pdf_path"],
                        "original_names": occurrence["source_original_names"],
                        "purchases": occurrence["source_purchases"],
                    }
                ],
            }
        )
    unique_lines.sort(key=lambda item: (item["model"], item["fingerprint"]))

    summary_values: dict[str, dict[str, Decimal | int]] = defaultdict(
        lambda: {"quantity_c62": Decimal("0"), "value_thb": Decimal("0"), "line_count": 0}
    )
    for line in unique_lines:
        bucket = summary_values[line["cost_family"]]
        bucket["quantity_c62"] += Decimal(str(line["quantity_c62"]))
        bucket["value_thb"] += Decimal(str(line["value_thb"]))
        bucket["line_count"] += 1

    model_summary = []
    for family, values in sorted(summary_values.items()):
        quantity = values["quantity_c62"]
        value = values["value_thb"]
        model_summary.append(
            {
                "cost_family": family,
                "quantity_c62": float(quantity),
                "value_thb": float(value),
                "weighted_unit_cost_thb": float(value / quantity) if quantity else None,
                "unique_line_count": values["line_count"],
            }
        )

    fingerprints_to_record_ids: dict[str, set[str]] = defaultdict(set)
    fingerprints_to_text: dict[str, str] = {}
    for line in unique_lines:
        fingerprints_to_record_ids[line["fingerprint"]].update(line["dedupe_record_ids"])
        fingerprints_to_text[line["fingerprint"]] = line["fingerprint_text"]

    cross_record_duplicates = []
    for fingerprint, record_ids in fingerprints_to_record_ids.items():
        if len(record_ids) > 1:
            cross_record_duplicates.append(
                {
                    "fingerprint": fingerprint,
                    "fingerprint_text": fingerprints_to_text[fingerprint],
                    "record_ids": sorted(record_ids),
                }
            )

    totals = {
        "manifest_files": len(manifest),
        "pdf_files": sum(1 for item in inventory if item["file_type"] == "pdf"),
        "pdf_read_errors": sum(1 for item in inventory if item["classification"] == "pdf_read_error"),
        "product_customs_pdfs": sum(
            1 for item in inventory if item["classification"] == "product_customs_declaration"
        ),
        "raw_product_line_occurrences": len(all_occurrences),
        "unique_product_lines": len(unique_lines),
        "duplicate_product_line_occurrences": len(all_occurrences) - len(unique_lines),
        "cross_record_duplicate_fingerprints": len(cross_record_duplicates),
        "total_quantity_c62": float(sum(Decimal(str(x["quantity_c62"])) for x in unique_lines)),
        "total_value_thb": float(sum(Decimal(str(x["value_thb"])) for x in unique_lines)),
    }

    write_json(PARSED_DIR / "pdf-inventory.json", {"totals": totals, "files": inventory})
    write_json(PARSED_DIR / "customs-lines.json", {"totals": totals, "lines": unique_lines})
    write_json(
        PARSED_DIR / "customs-summary.json",
        {
            "totals": totals,
            "models": model_summary,
            "cross_record_duplicates": cross_record_duplicates,
        },
    )

    print(json.dumps(totals, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
