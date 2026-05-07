#!/usr/bin/env python3
import json
import mimetypes
import os
import sys
from pathlib import Path
from urllib import error, request


def require_env(name):
    value = os.environ.get(name)
    if not value:
        raise SystemExit(f"Missing required environment variable: {name}")
    return value


def storage_request(method, endpoint, service_key, body=None, content_type="application/json"):
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = request.Request(
        endpoint,
        data=data,
        method=method,
        headers={
            "Authorization": f"Bearer {service_key}",
            "apikey": service_key,
            "Content-Type": content_type,
        },
    )
    with request.urlopen(req, timeout=60) as response:
        content = response.read().decode("utf-8", "replace")
        return response.status, content


def read_http_error(exc):
    return exc.read().decode("utf-8", "replace")


def storage_error_payload(body):
    try:
        return json.loads(body)
    except json.JSONDecodeError:
        return {}


def is_missing_bucket(exc, body):
    if exc.code == 404:
        return True
    payload = storage_error_payload(body)
    status_code = str(payload.get("statusCode") or payload.get("status") or "")
    message = " ".join(str(payload.get(key) or "") for key in ("error", "message")).lower()
    return status_code == "404" and "bucket" in message and "not found" in message


def ensure_bucket(supabase_url, service_key, bucket):
    if os.environ.get("SUPABASE_ENSURE_BUCKET", "true").lower() in {"0", "false", "no"}:
        return

    base = supabase_url.rstrip("/")
    bucket_endpoint = f"{base}/storage/v1/bucket/{bucket}"
    try:
        storage_request("GET", bucket_endpoint, service_key)
        return
    except error.HTTPError as exc:
        body = read_http_error(exc)
        if not is_missing_bucket(exc, body):
            raise SystemExit(f"Bucket check failed for {bucket}: HTTP {exc.code} {body}") from exc

    create_endpoint = f"{base}/storage/v1/bucket"
    try:
        storage_request("POST", create_endpoint, service_key, {
            "id": bucket,
            "name": bucket,
            "public": False,
        })
    except error.HTTPError as exc:
        body = read_http_error(exc)
        if exc.code == 409 or "already" in body.lower():
            return
        raise SystemExit(f"Bucket create failed for {bucket}: HTTP {exc.code} {body}") from exc


def upload(path, supabase_url, service_key, bucket, prefix):
    file_path = Path(path)
    object_name = f"{prefix.rstrip('/')}/{file_path.name}" if prefix else file_path.name
    endpoint = f"{supabase_url.rstrip('/')}/storage/v1/object/{bucket}/{object_name}"
    content_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
    req = request.Request(
        endpoint,
        data=file_path.read_bytes(),
        method="POST",
        headers={
            "Authorization": f"Bearer {service_key}",
            "apikey": service_key,
            "Content-Type": content_type,
            "x-upsert": "true",
        },
    )
    try:
        with request.urlopen(req, timeout=180) as response:
            return {"file": str(file_path), "object": object_name, "status": response.status}
    except error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")
        raise SystemExit(f"Upload failed for {file_path}: HTTP {exc.code} {body}") from exc


def main():
    if len(sys.argv) < 2:
        raise SystemExit("Usage: upload-to-supabase-storage.py <file> [<file> ...]")

    supabase_url = require_env("SUPABASE_URL")
    service_key = require_env("SUPABASE_SERVICE_ROLE_KEY")
    bucket = require_env("SUPABASE_BACKUP_BUCKET")
    prefix = os.environ.get("SUPABASE_BACKUP_PREFIX", "postgres")

    ensure_bucket(supabase_url, service_key, bucket)
    results = [upload(path, supabase_url, service_key, bucket, prefix) for path in sys.argv[1:]]
    print(json.dumps({"uploaded": results}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
