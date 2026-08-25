#!/usr/bin/env python3
"""Independently verify source coverage and dashboard calculations."""

from __future__ import annotations

import json
from collections import Counter, defaultdict
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

from pypdf import PdfReader

from parse_customs_attachments import PRODUCT_RE, canonical_model, clean_lines


ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
PARSED = ROOT / "data" / "parsed"
REPORT = ROOT / "data" / "audit-report.json"
BANGKOK = ZoneInfo("Asia/Bangkok")
TOLERANCE = Decimal("0.011")

OUTBOUND_TYPE = "_widget_1754033341345"
OUTBOUND_DATE = "_widget_1754033341379"
OUTBOUND_CUSTOMER = "_widget_1779951185798"
OUTBOUND_LINES = "_widget_1754033341348"
OUTBOUND_CONFIRMED = "_widget_1754033341376"
OUTBOUND_MODEL = "_widget_1754098906806"
OUTBOUND_QTY = "_widget_1754093502137"

PRICE_CUSTOMER = "_widget_1754287205008"
PRICE_MODEL = "_widget_1754287205002"
PRICE_STATUS = "_widget_1760759318707"
PRICE_THB = "_widget_1760758549589"

PURCHASE_MONTH = "_widget_1638440938270"
PURCHASE_ITEM = "_widget_1727337817607"
PURCHASE_AMOUNT = "_widget_1727337817617"
PURCHASE_DOCUMENTS = "_widget_1727337817611"
PURCHASE_STATUS = "_widget_1517558654967"


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write_json(path: Path, value: Any) -> None:
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    temp.replace(path)


def records(path: Path) -> list[dict[str, Any]]:
    payload = read_json(path)
    return payload.get("data", payload)


def dec(value: Any) -> Decimal:
    if value in (None, ""):
        return Decimal("0")
    return Decimal(str(value))


def month_of(iso_value: str) -> str:
    parsed = datetime.fromisoformat(iso_value.replace("Z", "+00:00"))
    return parsed.astimezone(BANGKOK).strftime("%Y%m")


def close_enough(left: Any, right: Any) -> bool:
    return abs(dec(left) - dec(right)) <= TOLERANCE


def main() -> int:
    rules = read_json(ROOT / "config" / "business-rules.json")
    outbound = records(RAW / "outbound.json")
    prices = records(RAW / "prices.json")
    purchases = records(RAW / "purchases.json")
    customs_lines = read_json(PARSED / "customs-lines.json").get("lines", [])
    customs_summary = read_json(PARSED / "customs-summary.json")
    pdf_inventory = read_json(PARSED / "pdf-inventory.json")
    dashboard = read_json(ROOT / "data" / "dashboard.json")
    manifest = read_json(ROOT / "data" / "attachments" / "manifest.json")

    errors: list[dict[str, Any]] = []
    warnings: list[dict[str, Any]] = []
    infos: list[dict[str, Any]] = []

    def issue(bucket: list[dict[str, Any]], code: str, message: str, **details: Any) -> None:
        bucket.append({"code": code, "message": message, **details})

    # Source identity and selection checks.
    for name, rows in (("outbound", outbound), ("prices", prices), ("purchases", purchases)):
        ids = [row.get("_id") for row in rows]
        if len(ids) != len(set(ids)):
            issue(errors, f"duplicate_{name}_record_id", f"{name} contains duplicate record IDs")

    rejected = [row.get("_id") for row in purchases if row.get("flowState") == 2]
    nonpaid = [
        row.get("_id")
        for row in purchases
        if not str(row.get(PURCHASE_STATUS, "")).startswith("PAYMENT SUCCESS/")
    ]
    if rejected:
        issue(errors, "rejected_purchase_in_raw", "Rejected purchases entered the calculation source", ids=rejected)
    if nonpaid:
        issue(errors, "nonpaid_purchase_in_raw", "Non-paid purchases entered the calculation source", ids=nonpaid)

    # Independent customs weighted-cost calculation.
    customs_buckets: dict[str, dict[str, Decimal]] = defaultdict(
        lambda: {"quantity": Decimal("0"), "thb": Decimal("0"), "usd": Decimal("0")}
    )
    manifest_shas = {entry.get("sha256") for entry in manifest}
    purchase_ids = {row.get("_id") for row in purchases}
    for line in customs_lines:
        family = line.get("cost_family")
        customs_buckets[family]["quantity"] += dec(line.get("quantity_c62"))
        customs_buckets[family]["thb"] += dec(line.get("value_thb"))
        customs_buckets[family]["usd"] += dec(line.get("value_usd_reference"))
        if line.get("source_pdf_sha256") not in manifest_shas:
            issue(errors, "orphan_customs_pdf", "Customs line points to a PDF outside the manifest", fingerprint=line.get("fingerprint"))
        for source in line.get("all_sources", []):
            for purchase in source.get("purchases", []):
                if purchase.get("record_id") not in purchase_ids:
                    issue(errors, "orphan_customs_purchase", "Customs line points to a purchase outside the paid source", record_id=purchase.get("record_id"))

    summary_index = {item.get("cost_family"): item for item in customs_summary.get("models", [])}
    for family, bucket in customs_buckets.items():
        saved = summary_index.get(family)
        if not saved:
            issue(errors, "missing_customs_summary_family", "Customs family is missing from the summary", family=family)
            continue
        expected_unit = bucket["thb"] / bucket["quantity"] if bucket["quantity"] else Decimal("0")
        if not close_enough(saved.get("quantity_c62"), bucket["quantity"]):
            issue(errors, "customs_quantity_mismatch", "Customs family quantity does not reconcile", family=family)
        if not close_enough(saved.get("value_thb"), bucket["thb"]):
            issue(errors, "customs_value_mismatch", "Customs family THB value does not reconcile", family=family)
        if abs(dec(saved.get("weighted_unit_cost_thb")) - expected_unit) > Decimal("0.000001"):
            issue(errors, "customs_unit_cost_mismatch", "Weighted customs unit cost is incorrect", family=family)

    cost_index = {
        family: bucket["thb"] / bucket["quantity"]
        for family, bucket in customs_buckets.items()
        if bucket["quantity"]
    }
    cost_usd_index = {
        family: bucket["usd"] / bucket["quantity"]
        for family, bucket in customs_buckets.items()
        if bucket["quantity"] and bucket["usd"]
    }
    for family, value in rules.get("cost_overrides_thb", {}).items():
        cost_index[family] = dec(value)

    # Active-price index and stale-override detection.
    active_prices: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for row in prices:
        if row.get(PRICE_STATUS) == rules["active_price_status"] and row.get(PRICE_THB) not in (None, ""):
            active_prices[(str(row.get(PRICE_CUSTOMER, "")).strip(), str(row.get(PRICE_MODEL, "")).strip())].append(row)

    aliases = rules["customer_aliases"]
    model_aliases = rules["price_model_aliases"]
    price_overrides = rules["price_overrides_thb"]
    for key, value in price_overrides.items():
        customer, model = key.split("|", 1)
        source_customer = aliases.get(customer, customer)
        source_model = model_aliases.get(model, model)
        distinct = sorted({dec(row.get(PRICE_THB)) for row in active_prices.get((source_customer, source_model), [])})
        if len(distinct) == 1 and distinct[0] != dec(value):
            issue(
                errors,
                "stale_price_override",
                "Manual price override conflicts with the single active price-table value",
                key=key,
                override=float(dec(value)),
                active_price=float(distinct[0]),
            )

    sales_expected: dict[tuple[str, str], dict[str, Any]] = {}
    price_conflicts: dict[str, list[float]] = {}
    for record in outbound:
        if record.get(OUTBOUND_TYPE) != rules["outbound_type"] or record.get(OUTBOUND_CONFIRMED) != rules["outbound_confirmed"]:
            issue(errors, "unexpected_outbound_record", "Unselected outbound record entered raw calculation data", record_id=record.get("_id"))
            continue
        customer = str(record.get(OUTBOUND_CUSTOMER, "")).strip()
        full_customer = aliases.get(customer, customer)
        for line in record.get(OUTBOUND_LINES) or []:
            model = str(line.get(OUTBOUND_MODEL, "")).strip()
            quantity = dec(line.get(OUTBOUND_QTY))
            if not model or quantity <= 0:
                continue
            key = (record.get("_id"), line.get("_id"))
            if key in sales_expected:
                issue(errors, "duplicate_outbound_line_id", "Outbound subtable line is duplicated", record_id=key[0], line_id=key[1])
            override_key = f"{customer}|{model}"
            unit_price: Decimal | None = None
            if override_key in price_overrides:
                unit_price = dec(price_overrides[override_key])
            else:
                source_model = model_aliases.get(model, model)
                candidates = active_prices.get((full_customer, source_model), [])
                distinct = sorted({dec(row.get(PRICE_THB)) for row in candidates})
                if len(distinct) == 1:
                    unit_price = distinct[0]
                else:
                    price_conflicts[override_key] = [float(value) for value in distinct]
            family = rules["outbound_cost_families"].get(model)
            unit_cost = cost_index.get(family) if family else None
            unit_cost_usd = cost_usd_index.get(family) if family else None
            sales_expected[key] = {
                "record_id": key[0],
                "line_id": key[1],
                "month": month_of(str(record.get(OUTBOUND_DATE, ""))),
                "customer": customer,
                "model": model,
                "quantity": quantity,
                "unit_price": unit_price,
                "revenue": quantity * unit_price if unit_price is not None else None,
                "family": family,
                "unit_cost": unit_cost,
                "cost": quantity * unit_cost if unit_cost is not None else None,
                "cost_usd": quantity * unit_cost_usd if unit_cost_usd is not None else None,
            }

    if price_conflicts:
        issue(errors, "unresolved_price_sources", "Some outbound models do not resolve to one sales price", models=price_conflicts)

    sales_actual = {
        (row.get("record_id"), row.get("source_line_id")): row
        for row in dashboard.get("details", {}).get("sales", [])
    }
    if len(sales_actual) != len(sales_expected):
        issue(errors, "sales_line_count_mismatch", "Dashboard sales detail count differs from valid outbound lines", expected=len(sales_expected), actual=len(sales_actual))
    for key, expected in sales_expected.items():
        actual = sales_actual.get(key)
        if not actual:
            issue(errors, "missing_sales_detail", "Valid outbound line is missing from the dashboard", record_id=key[0], line_id=key[1])
            continue
        comparisons = {
            "quantity": (actual.get("quantity"), expected["quantity"]),
            "unit_price": (actual.get("unit_price_thb"), expected["unit_price"]),
            "revenue": (actual.get("revenue_thb"), expected["revenue"]),
            "unit_cost": (actual.get("weighted_unit_cost_thb"), expected["unit_cost"]),
            "product_cost": (actual.get("product_cost_thb"), expected["cost"]),
        }
        for field, (left, right) in comparisons.items():
            if (left is None) != (right is None) or (left is not None and not close_enough(left, right)):
                issue(errors, "sales_calculation_mismatch", "Sales detail calculation does not reconcile", record_id=key[0], line_id=key[1], field=field, expected=float(right) if right is not None else None, actual=left)

    # Independent monthly rollup.
    expected_monthly: dict[str, dict[str, Decimal]] = defaultdict(
        lambda: {
            "revenue_thb": Decimal("0"),
            "known_product_cost_thb": Decimal("0"),
            "known_product_cost_usd_reference": Decimal("0"),
            "shared_cost_thb": Decimal("0"),
            "excluded_import_tax_payment_thb": Decimal("0"),
            "outbound_quantity": Decimal("0"),
            "costed_quantity": Decimal("0"),
            "unpriced_revenue_quantity": Decimal("0"),
            "uncosted_quantity": Decimal("0"),
        }
    )
    for row in sales_expected.values():
        bucket = expected_monthly[row["month"]]
        bucket["outbound_quantity"] += row["quantity"]
        if row["revenue"] is None:
            bucket["unpriced_revenue_quantity"] += row["quantity"]
        else:
            bucket["revenue_thb"] += row["revenue"]
        if row["cost"] is None:
            bucket["uncosted_quantity"] += row["quantity"]
        else:
            bucket["known_product_cost_thb"] += row["cost"]
            bucket["costed_quantity"] += row["quantity"]
            if row["cost_usd"] is not None:
                bucket["known_product_cost_usd_reference"] += row["cost_usd"]

    excluded_fragments = [value.lower() for value in rules["shared_cost_excluded_item_contains"]]
    for row in purchases:
        month = str(row.get(PURCHASE_MONTH, "")).strip() or "unknown"
        item = str(row.get(PURCHASE_ITEM, "")).strip()
        amount = dec(row.get(PURCHASE_AMOUNT))
        if any(fragment in item.lower() for fragment in excluded_fragments):
            expected_monthly[month]["excluded_import_tax_payment_thb"] += amount
        else:
            expected_monthly[month]["shared_cost_thb"] += amount

    actual_monthly = {row.get("month"): row for row in dashboard.get("monthly", [])}
    if set(actual_monthly) != set(expected_monthly):
        issue(errors, "monthly_scope_mismatch", "Dashboard month set differs from independent source rollup", expected=sorted(expected_monthly), actual=sorted(actual_monthly))
    for month, expected in expected_monthly.items():
        actual = actual_monthly.get(month)
        if not actual:
            continue
        for field, value in expected.items():
            if not close_enough(actual.get(field), value):
                issue(errors, "monthly_value_mismatch", "Monthly value does not reconcile", month=month, field=field, expected=float(value), actual=actual.get(field))
        provisional = expected["revenue_thb"] - expected["known_product_cost_thb"] - expected["shared_cost_thb"]
        complete = expected["unpriced_revenue_quantity"] == 0 and expected["uncosted_quantity"] == 0
        if not close_enough(actual.get("profit_before_missing_cost_thb"), provisional):
            issue(errors, "monthly_profit_mismatch", "Monthly provisional profit is incorrect", month=month)
        if bool(actual.get("complete")) != complete:
            issue(errors, "monthly_completeness_mismatch", "Monthly completeness flag is incorrect", month=month)

    # Attachment and classification coverage.
    source_keys = [key for entry in manifest for key in entry.get("source_keys", [])]
    if len(source_keys) != len(set(source_keys)):
        issue(errors, "duplicate_attachment_source_key", "Attachment source key is duplicated")
    pdf_count = sum(1 for entry in manifest if Path(str(entry.get("path", ""))).suffix.lower() == ".pdf")
    inventory_product_count = sum(
        1 for entry in pdf_inventory.get("files", [])
        if entry.get("classification") == "product_customs_declaration"
    )
    if dashboard.get("customs_totals", {}).get("manifest_files") != len(manifest):
        issue(errors, "manifest_count_mismatch", "Dashboard manifest count is stale")
    if dashboard.get("customs_totals", {}).get("pdf_files") != pdf_count:
        issue(errors, "pdf_count_mismatch", "Dashboard PDF count is stale")
    if dashboard.get("customs_totals", {}).get("product_customs_pdfs") != inventory_product_count:
        issue(errors, "product_pdf_count_mismatch", "Dashboard product-PDF count is stale")

    # Verify that every product description visible in each PDF is represented
    # once in the parsed model set. This catches cross-page text-order shifts.
    lines_by_pdf: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for line in customs_lines:
        lines_by_pdf[str(line.get("source_pdf_sha256"))].append(line)
    for entry in pdf_inventory.get("files", []):
        if entry.get("classification") != "product_customs_declaration":
            continue
        pdf_path = ROOT / "data" / "attachments" / str(entry.get("path"))
        reader = PdfReader(str(pdf_path))
        text = "\n".join((page.extract_text() or "") for page in reader.pages)
        candidate_models = [
            canonical_model(line)
            for line in clean_lines(text)
            if PRODUCT_RE.search(line)
        ]
        parsed_models = [
            str(line.get("model"))
            for line in lines_by_pdf.get(str(entry.get("sha256")), [])
        ]
        # Scanned PDFs have no searchable product descriptions and are covered
        # by the explicit manual-transcription configuration.
        if candidate_models and Counter(candidate_models) != Counter(parsed_models):
            issue(
                errors,
                "pdf_product_model_coverage_mismatch",
                "Parsed PDF models differ from the product descriptions in the source PDF",
                file=(entry.get("original_names") or [entry.get("path")])[0],
                source_models=dict(Counter(candidate_models)),
                parsed_models=dict(Counter(parsed_models)),
            )

    unresolved_costs = sorted(
        {row["model"] for row in sales_expected.values() if row["cost"] is None}
    )
    if unresolved_costs:
        issue(warnings, "unresolved_cost_models", "Outbound models remain without confirmed customs cost", models=unresolved_costs)

    duplicate_customs = customs_summary.get("cross_record_duplicates", [])
    if duplicate_customs:
        issue(
            infos,
            "cross_record_equal_customs_lines_kept",
            "Equal-looking lines in different PDFs are retained as separate declarations",
            count=len(duplicate_customs),
        )

    report = {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "status": "pass" if not errors else "fail",
        "metrics": {
            "outbound_records": len(outbound),
            "valid_outbound_lines": len(sales_expected),
            "price_records": len(prices),
            "paid_nonrejected_purchase_records": len(purchases),
            "attachment_files": len(manifest),
            "pdf_files": pdf_count,
            "product_customs_pdfs": inventory_product_count,
            "customs_product_lines": len(customs_lines),
            "dashboard_months": len(actual_monthly),
        },
        "errors": errors,
        "warnings": warnings,
        "info": infos,
    }
    write_json(REPORT, report)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
