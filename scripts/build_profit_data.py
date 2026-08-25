#!/usr/bin/env python3
"""Build the dashboard's monthly revenue/cost dataset."""

from __future__ import annotations

import json
from collections import defaultdict
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo


ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
PARSED = ROOT / "data" / "parsed"
OUTPUT = ROOT / "data" / "dashboard.json"
RULES_PATH = ROOT / "config" / "business-rules.json"
SYNC_STATE_PATH = ROOT / "data" / "sync-state.json"

OUTBOUND_TYPE = "_widget_1754033341345"
OUTBOUND_DATE = "_widget_1754033341379"
OUTBOUND_CUSTOMER = "_widget_1779951185798"
OUTBOUND_LINES = "_widget_1754033341348"
OUTBOUND_CONFIRMED = "_widget_1754033341376"
OUTBOUND_MODEL = "_widget_1754098906806"
OUTBOUND_QTY = "_widget_1754093502137"

PRICE_CUSTOMER = "_widget_1754287205008"
PRICE_DATE = "_widget_1754287205001"
PRICE_MODEL = "_widget_1754287205002"
PRICE_STATUS = "_widget_1760759318707"
PRICE_THB = "_widget_1760758549589"

PURCHASE_MONTH = "_widget_1638440938270"
PURCHASE_DATE = "_widget_1517542638204"
PURCHASE_ITEM = "_widget_1727337817607"
PURCHASE_AMOUNT = "_widget_1727337817617"
PURCHASE_STATUS = "_widget_1517558654967"
PURCHASE_CATEGORY = "_widget_1747289765281"
PURCHASE_DOCUMENTS = "_widget_1727337817611"

APP_ID = "66f51542fac826ea0ef4117a"
OUTBOUND_FORM_ID = "688c6cbc2a83f7d454d4a0e0"
PRICE_FORM_ID = "68904c6547d58a844e075bb2"
PURCHASE_FORM_ID = "66f515525c7e0dee4c1ac771"

BANGKOK = ZoneInfo("Asia/Bangkok")


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write_json_atomic(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    temp.replace(path)


def records(path: Path) -> list[dict[str, Any]]:
    payload = read_json(path)
    return payload.get("data", payload)


def dec(value: Any) -> Decimal:
    if value in (None, ""):
        return Decimal("0")
    return Decimal(str(value))


def local_month(iso_value: str) -> str:
    if not iso_value:
        return "unknown"
    parsed = datetime.fromisoformat(iso_value.replace("Z", "+00:00"))
    return parsed.astimezone(BANGKOK).strftime("%Y%m")


def money(value: Decimal | None) -> float | None:
    return round(float(value), 2) if value is not None else None


def main() -> int:
    rules = read_json(RULES_PATH)
    outbound_records = records(RAW / "outbound.json")
    price_records = records(RAW / "prices.json")
    purchase_records = records(RAW / "purchases.json")
    customs = read_json(PARSED / "customs-summary.json")
    customs_lines_payload = read_json(PARSED / "customs-lines.json")

    # Weighted customs unit cost by product family.
    cost_index = {
        item["cost_family"]: Decimal(str(item["weighted_unit_cost_thb"]))
        for item in customs["models"]
        if item.get("weighted_unit_cost_thb") is not None
    }
    # User-confirmed fixed THB unit costs take precedence over PDF-weighted costs.
    for family, value in rules.get("cost_overrides_thb", {}).items():
        cost_index[family] = dec(value)
    usd_cost_buckets: dict[str, dict[str, Decimal]] = defaultdict(
        lambda: {"quantity": Decimal("0"), "value": Decimal("0")}
    )
    for line in customs_lines_payload.get("lines", []):
        family = line.get("cost_family")
        quantity = dec(line.get("quantity_c62"))
        usd_value = line.get("value_usd_reference")
        if family and quantity > 0 and usd_value not in (None, ""):
            usd_cost_buckets[family]["quantity"] += quantity
            usd_cost_buckets[family]["value"] += dec(usd_value)
    cost_usd_index = {
        family: bucket["value"] / bucket["quantity"]
        for family, bucket in usd_cost_buckets.items()
        if bucket["quantity"] > 0
    }

    # Active price rows are indexed by the full customer name and model.
    active_prices: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for item in price_records:
        if item.get(PRICE_STATUS) != rules["active_price_status"]:
            continue
        key = (str(item.get(PRICE_CUSTOMER, "")).strip(), str(item.get(PRICE_MODEL, "")).strip())
        if item.get(PRICE_THB) not in (None, ""):
            active_prices[key].append(
                {
                    "record_id": item.get("_id"),
                    "date": item.get(PRICE_DATE),
                    "customer": item.get(PRICE_CUSTOMER),
                    "model": item.get(PRICE_MODEL),
                    "status": item.get(PRICE_STATUS),
                    "unit_price_thb": money(dec(item[PRICE_THB])),
                }
            )

    monthly: dict[str, dict[str, Any]] = defaultdict(
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
    sales_details: list[dict[str, Any]] = []
    price_issues: dict[tuple[str, str, str], dict[str, Any]] = {}
    cost_issues: dict[tuple[str, str], dict[str, Any]] = {}

    customer_aliases = rules["customer_aliases"]
    price_aliases = rules["price_model_aliases"]
    overrides = rules["price_overrides_thb"]
    cost_families = rules["outbound_cost_families"]

    for record in outbound_records:
        if record.get(OUTBOUND_TYPE) != rules["outbound_type"]:
            continue
        if record.get(OUTBOUND_CONFIRMED) != rules["outbound_confirmed"]:
            continue
        month = local_month(str(record.get(OUTBOUND_DATE, "")))
        customer_short = str(record.get(OUTBOUND_CUSTOMER, "")).strip()
        customer_full = customer_aliases.get(customer_short, customer_short)

        for line in record.get(OUTBOUND_LINES) or []:
            model = str(line.get(OUTBOUND_MODEL, "")).strip()
            quantity = dec(line.get(OUTBOUND_QTY))
            if not model or quantity <= 0:
                continue

            monthly[month]["outbound_quantity"] += quantity
            override_key = f"{customer_short}|{model}"
            price_source = "active_price"
            price_source_records: list[dict[str, Any]] = []
            unit_price: Decimal | None = None

            if override_key in overrides:
                unit_price = dec(overrides[override_key])
                price_source = "confirmed_override"
                price_source_records = [
                    {
                        "rule_key": override_key,
                        "unit_price_thb": money(unit_price),
                        "note": "用户确认的人工价格规则",
                    }
                ]
            else:
                price_model = price_aliases.get(model, model)
                candidates = active_prices.get((customer_full, price_model), [])
                distinct = sorted({dec(candidate["unit_price_thb"]) for candidate in candidates})
                if len(distinct) == 1:
                    unit_price = distinct[0]
                    price_source_records = candidates
                    if price_model != model:
                        price_source = f"model_alias:{price_model}"
                else:
                    issue_key = (customer_short, model, "missing" if not distinct else "ambiguous")
                    price_issues[issue_key] = {
                        "customer": customer_short,
                        "model": model,
                        "reason": issue_key[2],
                        "candidate_prices_thb": [money(value) for value in distinct],
                    }

            revenue = quantity * unit_price if unit_price is not None else None
            if revenue is not None:
                monthly[month]["revenue_thb"] += revenue
            else:
                monthly[month]["unpriced_revenue_quantity"] += quantity

            family = cost_families.get(model)
            unit_cost = cost_index.get(family) if family else None
            unit_cost_usd = cost_usd_index.get(family) if family else None
            product_cost = quantity * unit_cost if unit_cost is not None else None
            product_cost_usd = quantity * unit_cost_usd if unit_cost_usd is not None else None
            if product_cost is not None:
                monthly[month]["known_product_cost_thb"] += product_cost
                if product_cost_usd is not None:
                    monthly[month]["known_product_cost_usd_reference"] += product_cost_usd
                monthly[month]["costed_quantity"] += quantity
            else:
                monthly[month]["uncosted_quantity"] += quantity
                issue_key = (model, family or "")
                saved = cost_issues.setdefault(
                    issue_key,
                    {
                        "model": model,
                        "configured_cost_family": family,
                        "quantity": Decimal("0"),
                    },
                )
                saved["quantity"] += quantity

            sales_details.append(
                {
                    "record_id": record.get("_id"),
                    "source_app_id": APP_ID,
                    "source_form": "产品出库表",
                    "source_form_id": OUTBOUND_FORM_ID,
                    "source_line_id": line.get("_id"),
                    "source_date": record.get(OUTBOUND_DATE),
                    "source_type": record.get(OUTBOUND_TYPE),
                    "source_confirmed": record.get(OUTBOUND_CONFIRMED),
                    "month": month,
                    "customer": customer_short,
                    "model": model,
                    "quantity": float(quantity),
                    "unit_price_thb": money(unit_price),
                    "price_source": price_source if unit_price is not None else None,
                    "price_source_form": "销售单价表",
                    "price_source_form_id": PRICE_FORM_ID,
                    "price_source_records": price_source_records,
                    "revenue_thb": money(revenue),
                    "cost_family": family,
                    # Preserve calculation precision in JSON; the browser
                    # formats monetary values to two decimals for display.
                    "weighted_unit_cost_thb": float(unit_cost) if unit_cost is not None else None,
                    "product_cost_thb": float(product_cost) if product_cost is not None else None,
                    "weighted_unit_cost_usd_reference": float(unit_cost_usd) if unit_cost_usd is not None else None,
                    "product_cost_usd_reference": float(product_cost_usd) if product_cost_usd is not None else None,
                }
            )

    exclusions = [value.lower() for value in rules["shared_cost_excluded_item_contains"]]
    purchase_details: list[dict[str, Any]] = []
    for record in purchase_records:
        # Payment status is the accounting gate. In-progress rows can already
        # be paid, while rejected rows must never enter shared costs.
        if record.get("flowState") == 2:
            continue
        if not str(record.get(PURCHASE_STATUS, "")).startswith("PAYMENT SUCCESS/"):
            continue
        month = str(record.get(PURCHASE_MONTH, "")).strip() or "unknown"
        item = str(record.get(PURCHASE_ITEM, "")).strip()
        amount = dec(record.get(PURCHASE_AMOUNT))
        excluded = any(fragment in item.lower() for fragment in exclusions)
        if excluded:
            monthly[month]["excluded_import_tax_payment_thb"] += amount
        else:
            monthly[month]["shared_cost_thb"] += amount
        purchase_details.append(
            {
                "record_id": record.get("_id"),
                "source_app_id": APP_ID,
                "source_form": "申购费用表",
                "source_form_id": PURCHASE_FORM_ID,
                "source_date": record.get(PURCHASE_DATE),
                "month": month,
                "item": item,
                "amount_thb": money(amount),
                "category": record.get(PURCHASE_CATEGORY),
                "payment_status": record.get(PURCHASE_STATUS),
                "flow_state": record.get("flowState"),
                "attachment_names": [
                    attachment.get("name")
                    for attachment in (record.get(PURCHASE_DOCUMENTS) or [])
                    if attachment.get("name")
                ],
                "excluded_from_shared_cost": excluded,
            }
        )

    customs_details: list[dict[str, Any]] = []
    for line in customs_lines_payload.get("lines", []):
        files: dict[str, dict[str, Any]] = {}
        purchases_by_id: dict[str, dict[str, Any]] = {}
        for source in line.get("all_sources", []):
            path = source.get("pdf_path")
            if path:
                files[path] = {
                    "path": path,
                    "original_names": source.get("original_names") or [],
                    "sha256": source.get("pdf_sha256"),
                }
            for purchase in source.get("purchases", []):
                record_id = purchase.get("record_id")
                if record_id:
                    purchases_by_id[record_id] = purchase
        quantity = dec(line.get("quantity_c62"))
        value = dec(line.get("value_thb"))
        customs_details.append(
            {
                "fingerprint": line.get("fingerprint"),
                "cost_family": line.get("cost_family"),
                "customs_model": line.get("model"),
                "description": line.get("description"),
                "quantity_c62": float(quantity),
                "value_thb": money(value),
                "line_unit_cost_thb": money(value / quantity) if quantity else None,
                "value_usd_reference": line.get("value_usd_reference"),
                "source_form": "申购费用表 · Import tax附件",
                "source_form_id": PURCHASE_FORM_ID,
                "source_purchases": list(purchases_by_id.values()),
                "source_files": list(files.values()),
            }
        )

    monthly_rows = []
    for month in sorted(monthly):
        item = monthly[month]
        provisional_profit = (
            item["revenue_thb"] - item["known_product_cost_thb"] - item["shared_cost_thb"]
        )
        complete = item["unpriced_revenue_quantity"] == 0 and item["uncosted_quantity"] == 0
        monthly_rows.append(
            {
                "month": month,
                "revenue_thb": money(item["revenue_thb"]),
                "known_product_cost_thb": money(item["known_product_cost_thb"]),
                "known_product_cost_usd_reference": money(item["known_product_cost_usd_reference"]),
                "shared_cost_thb": money(item["shared_cost_thb"]),
                "excluded_import_tax_payment_thb": money(item["excluded_import_tax_payment_thb"]),
                "profit_thb": money(provisional_profit) if complete else None,
                "profit_before_missing_cost_thb": money(provisional_profit),
                "outbound_quantity": float(item["outbound_quantity"]),
                "costed_quantity": float(item["costed_quantity"]),
                "unpriced_revenue_quantity": float(item["unpriced_revenue_quantity"]),
                "uncosted_quantity": float(item["uncosted_quantity"]),
                "complete": complete,
            }
        )

    model_rollup: dict[tuple[str, str], dict[str, Any]] = {}
    for row in sales_details:
        key = (row["customer"], row["model"])
        saved = model_rollup.setdefault(
            key,
            {
                "customer": row["customer"],
                "model": row["model"],
                "quantity": Decimal("0"),
                "revenue_thb": Decimal("0"),
                "product_cost_thb": Decimal("0"),
                "product_cost_usd_reference": Decimal("0"),
                "has_price": True,
                "has_cost": True,
                "unit_price_thb": row["unit_price_thb"],
                "weighted_unit_cost_thb": row["weighted_unit_cost_thb"],
                "weighted_unit_cost_usd_reference": row["weighted_unit_cost_usd_reference"],
                "cost_family": row["cost_family"],
            },
        )
        saved["quantity"] += dec(row["quantity"])
        if row["revenue_thb"] is None:
            saved["has_price"] = False
        else:
            saved["revenue_thb"] += dec(row["revenue_thb"])
        if row["product_cost_thb"] is None:
            saved["has_cost"] = False
        else:
            saved["product_cost_thb"] += dec(row["product_cost_thb"])
        if row["product_cost_usd_reference"] is not None:
            saved["product_cost_usd_reference"] += dec(row["product_cost_usd_reference"])

    model_rows = []
    for saved in sorted(model_rollup.values(), key=lambda x: (x["customer"], x["model"])):
        model_rows.append(
            {
                **{key: value for key, value in saved.items() if not isinstance(value, Decimal)},
                "quantity": float(saved["quantity"]),
                "revenue_thb": money(saved["revenue_thb"]) if saved["has_price"] else None,
                "product_cost_thb": money(saved["product_cost_thb"]) if saved["has_cost"] else None,
                "product_cost_usd_reference": money(saved["product_cost_usd_reference"]) if saved["has_cost"] else None,
            }
        )

    for issue in cost_issues.values():
        issue["quantity"] = float(issue["quantity"])

    sync_state = read_json(SYNC_STATE_PATH) if SYNC_STATE_PATH.exists() else None
    output = {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "currency": "THB",
        "sync_state": sync_state,
        "rules_note": {
            "revenue": "confirmed sales outbound quantity × Thai price including VAT 7%",
            "product_cost": "sales outbound quantity × weighted customs THB value per C62",
            "shared_cost": "paid and non-rejected purchase records by month, excluding Import tax records",
            "usd": "display reference only; never used in calculations",
        },
        "customs_totals": {
            **customs["totals"],
            "total_value_usd_reference": money(
                sum((bucket["value"] for bucket in usd_cost_buckets.values()), Decimal("0"))
            ),
        },
        "monthly": monthly_rows,
        "models": model_rows,
        "issues": {
            "prices": list(price_issues.values()),
            "costs": list(cost_issues.values()),
            "cross_record_customs_fingerprints": customs.get("cross_record_duplicates", []),
        },
        "details": {
            "sales": sales_details,
            "purchases": purchase_details,
            "customs": customs_details,
        },
    }
    write_json_atomic(OUTPUT, output)
    print(
        json.dumps(
            {
                "months": len(monthly_rows),
                "sales_lines": len(sales_details),
                "unresolved_price_models": len(price_issues),
                "unresolved_cost_models": len(cost_issues),
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
