#!/usr/bin/env python3
import csv
import hashlib
import importlib.util
import json
from datetime import datetime, timezone
from pathlib import Path


DATASET_NAME = "2025-2026志愿者时长库3月公示"
ROOT = Path(__file__).resolve().parents[1]
BASELINE_PATH = ROOT / "import-output" / "march-public-detail-import.json"
OUTPUT_DIR = ROOT / "import-output" / "march-activity-summary"


def load_reconcile_module():
    module_path = ROOT / "tools" / "reconcile-march-public-data.py"
    spec = importlib.util.spec_from_file_location("march_reconcile", module_path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def one_decimal(value):
    if value is None or value == "":
        return ""
    return f"{float(value):.1f}"


def write_csv(path, rows, fields):
    with path.open("w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def canonical_line(record, fields):
    values = []
    for field in fields:
        value = record.get(field)
        if field in ("source_total_hours", "hours"):
            values.append(one_decimal(value))
        elif value is None:
            values.append("")
        else:
            values.append(str(value).strip())
    return "\t".join(values)


def canonical_hash(records, fields):
    lines = sorted(canonical_line(row, fields) for row in records)
    payload = "\n".join(lines).encode("utf-8")
    return {
        "md5": hashlib.md5(payload).hexdigest(),
        "sha256": hashlib.sha256(payload).hexdigest(),
    }


def activity_source_key(row):
    payload = f"{row['activity_name']}\t{row['activity_period']}\t{row['activity_date']}".encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def sanitize_record(record, helpers):
    row = dict(record)
    row["college"] = helpers.normalize_college(row.get("college"))
    row["activity_name"] = helpers.public_activity_name(row.get("activity_name"))
    row["activity_period"] = helpers.public_activity_period(row.get("activity_period"))
    return row


def main():
    if not BASELINE_PATH.exists():
        raise SystemExit(f"baseline not found: {BASELINE_PATH}")

    helpers = load_reconcile_module()
    payload = json.loads(BASELINE_PATH.read_text(encoding="utf-8"))
    raw_records = payload["records"]
    records = [sanitize_record(row, helpers) for row in raw_records]
    activity_summary = helpers.summarize_activities(records)
    for item in activity_summary:
        if item["activity_name"] == "累计时长记录" and item["activity_period"] == "累计记录":
            item["is_summary_activity"] = True
    fields = helpers.CANONICAL_FIELDS

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    source_total_by_student = {}
    for row in records:
        key = (row["student_id"], row["student_name"], row["source_file"], row["source_sheet"], row["source_row"])
        source_total_by_student[key] = float(row["source_total_hours"])

    expected_hash = canonical_hash(records, fields)
    source_total_hours = round(sum(source_total_by_student.values()), 1)
    output_total_hours = round(sum(float(row["hours"]) for row in records), 1)
    legacy_rows_after_public_mapping = sum(
        1
        for row in records
        if helpers.is_legacy_placeholder(row["activity_name"]) or helpers.is_legacy_placeholder(row["activity_period"])
    )

    meta = {
        "dataset_name": DATASET_NAME,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "baseline_path": str(BASELINE_PATH),
        "record_count": len(records),
        "student_source_rows": len(source_total_by_student),
        "source_total_hours": source_total_hours,
        "output_total_hours": output_total_hours,
        "total_hours_match": source_total_hours == output_total_hours,
        "activity_groups": len(activity_summary),
        "canonical_fields": fields,
        "canonical_md5": expected_hash["md5"],
        "canonical_sha256": expected_hash["sha256"],
        "public_placeholder_policy": "legacy source placeholders are stored as 累计时长记录 / 累计记录; per-record hours remain in volunteer_logs",
        "legacy_rows_after_public_mapping": legacy_rows_after_public_mapping,
    }

    expected_payload = {"meta": meta, "records": records}
    activities_payload = {
        "meta": meta,
        "activities": [
            {
                "name": row["activity_name"],
                "start_time": row["start_time"],
                "end_time": row["end_time"],
                "location": row["activity_period"],
                "org_name": row["org_name"],
                "description": row["import_description"],
                "source_key": activity_source_key(row),
                "source_tuple": {
                    "activity_name": row["activity_name"],
                    "activity_period": row["activity_period"],
                    "activity_date": row["activity_date"],
                },
                "summary": row,
            }
            for row in activity_summary
        ],
    }

    report = {
        "meta": meta,
        "checks": {
            "excel_baseline_records": len(records),
            "excel_baseline_total_hours": output_total_hours,
            "excel_source_total_hours": source_total_hours,
            "activity_group_count": len(activity_summary),
            "same_activity_can_have_different_hours": True,
            "activity_table_hours_policy": "activities rows contain activity metadata only; student-specific hours stay on volunteer_logs.hours",
            "expected_database_hash": expected_hash,
        },
        "database_verification_sql": str(OUTPUT_DIR / "verify-database-against-baseline.sql"),
    }

    (OUTPUT_DIR / "expected-records-db-public.json").write_text(
        json.dumps(expected_payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    (OUTPUT_DIR / "activity-summary.json").write_text(
        json.dumps({"meta": meta, "activities": activity_summary}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    (OUTPUT_DIR / "activities-for-import.json").write_text(
        json.dumps(activities_payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    (OUTPUT_DIR / "reconciliation-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    write_csv(OUTPUT_DIR / "expected-records-db-public.csv", records, fields)
    write_csv(
        OUTPUT_DIR / "activity-summary.csv",
        activity_summary,
        [
            "activity_name",
            "activity_period",
            "activity_date",
            "record_count",
            "student_count",
            "total_hours",
            "min_hours",
            "max_hours",
            "avg_hours",
            "college_count",
            "top_colleges",
            "source_file_count",
            "source_files",
            "is_summary_activity",
            "org_name",
            "import_description",
        ],
    )

    verify_sql = f"""WITH latest_batch AS (
  SELECT id, filename, note, created_at, record_count
  FROM import_batches
  WHERE note = '{DATASET_NAME}'
  ORDER BY created_at DESC
  LIMIT 1
), canon AS (
  SELECT
    coalesce(student_id,'') || E'\\t' ||
    coalesce(student_name,'') || E'\\t' ||
    coalesce(college,'') || E'\\t' ||
    coalesce(grade,'') || E'\\t' ||
    coalesce(phone,'') || E'\\t' ||
    coalesce(source_file,'') || E'\\t' ||
    coalesce(source_sheet,'') || E'\\t' ||
    coalesce(source_row::text,'') || E'\\t' ||
    coalesce(to_char(source_total_hours,'FM999999990.0'),'') || E'\\t' ||
    coalesce(activity_name,'') || E'\\t' ||
    coalesce(activity_period,'') || E'\\t' ||
    coalesce(to_char(activity_date,'YYYY-MM-DD'),'') || E'\\t' ||
    coalesce(to_char(hours,'FM999999990.0'),'') || E'\\t' ||
    coalesce(import_detail_status,'') AS line,
    hours
  FROM volunteer_logs
  WHERE import_batch_id = (SELECT id FROM latest_batch)
)
SELECT
  (SELECT id FROM latest_batch) AS batch_id,
  (SELECT record_count FROM latest_batch) AS batch_record_count,
  count(*)::int AS record_count,
  coalesce(sum(hours), 0)::numeric(12,1)::text AS total_hours,
  md5(string_agg(line, E'\\n' ORDER BY line COLLATE "C")) AS canonical_md5,
  md5(string_agg(line, E'\\n' ORDER BY line COLLATE "C")) = '{expected_hash["md5"]}' AS matches_excel_baseline
FROM canon;
"""
    (OUTPUT_DIR / "verify-database-against-baseline.sql").write_text(verify_sql, encoding="utf-8")

    print(json.dumps({
        "output_dir": str(OUTPUT_DIR),
        "meta": meta,
        "files": {
            "expected_records": str(OUTPUT_DIR / "expected-records-db-public.json"),
            "activity_summary": str(OUTPUT_DIR / "activity-summary.json"),
            "activities_for_import": str(OUTPUT_DIR / "activities-for-import.json"),
            "reconciliation_report": str(OUTPUT_DIR / "reconciliation-report.json"),
            "verify_sql": str(OUTPUT_DIR / "verify-database-against-baseline.sql"),
        },
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
