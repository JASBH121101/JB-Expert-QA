from __future__ import annotations

import hashlib
import hmac
import re
import uuid
from collections.abc import Mapping
from typing import Any

_IDENTIFIER = re.compile(r"^[A-Za-z0-9:_-]{1,96}$")
_KEY_ID = re.compile(r"^[A-Za-z0-9:_-]{1,64}$")
_SHA256_HEX = re.compile(r"^[a-f0-9]{64}$")
_IDENTITY_TYPES = {"ip", "account", "account_ip", "session", "anonymous"}


def _exact_keys(value: Any, expected: set[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise TypeError(f"{label} must be a plain object")
    if set(value) != expected:
        extra = set(value) - expected
        missing = expected - set(value)
        if extra:
            raise TypeError(f"{label} contains unsupported field: {sorted(extra)[0]}")
        raise TypeError(f"{label} is missing field: {sorted(missing)[0]}")
    return value


def _identifier(value: Any, label: str) -> str:
    if not isinstance(value, str) or _IDENTIFIER.fullmatch(value) is None:
        raise ValueError(f"{label} must be a 1-96 character safe identifier")
    return value


def _key_id(value: Any, label: str) -> str:
    if not isinstance(value, str) or _KEY_ID.fullmatch(value) is None:
        raise ValueError(f"{label} must be a 1-64 character safe key identifier")
    return value


def _canonical_identity(value: Any) -> str:
    if not isinstance(value, str) or not value or "\x00" in value:
        raise ValueError("canonicalIdentity must be non-empty and contain no NUL")
    encoded = value.encode("utf-8", errors="strict")
    if len(value) > 512 or len(encoded) > 2048:
        raise ValueError("canonicalIdentity exceeds the Core v1 length limit")
    return value


def derive_identity_key(
    *,
    secret: bytes | bytearray | memoryview,
    key_id: str,
    tenant_id: str,
    application_id: str,
    identity_type: str,
    canonical_identity: str,
) -> str:
    secret_bytes = bytes(secret)
    if not 32 <= len(secret_bytes) <= 4096:
        raise ValueError("secret must contain 32-4096 bytes")
    _key_id(key_id, "keyId")
    _identifier(tenant_id, "tenantId")
    _identifier(application_id, "applicationId")
    if identity_type not in _IDENTITY_TYPES:
        raise ValueError("identityType is unsupported")
    identity = _canonical_identity(canonical_identity)
    message = (
        "jb.security-guard.identity.v1\0"
        + tenant_id + "\0"
        + application_id + "\0"
        + identity_type + "\0"
        + identity
    ).encode("utf-8", errors="strict")
    return hmac.new(secret_bytes, message, hashlib.sha256).hexdigest()


def normalize_rate_limit_check(value: Any) -> dict[str, Any]:
    item = _exact_keys(value, {
        "schema", "requestId", "tenantId", "applicationId", "policyId", "scope", "identity"
    }, "request")
    if item["schema"] != "jb.security.rate-limit.check/v1":
        raise ValueError("request.schema is unsupported")
    try:
        request_id = str(uuid.UUID(item["requestId"]))
    except (ValueError, TypeError, AttributeError) as exc:
        raise ValueError("requestId must be a UUID") from exc
    tenant_id = _identifier(item["tenantId"], "tenantId")
    application_id = _identifier(item["applicationId"], "applicationId")
    policy_id = _identifier(item["policyId"], "policyId")
    scope = _identifier(item["scope"], "scope")
    identity = _exact_keys(item["identity"], {"type", "key", "keyId"}, "identity")
    if not isinstance(identity["type"], str) or identity["type"] not in _IDENTITY_TYPES:
        raise ValueError("identity.type is unsupported")
    if not isinstance(identity["key"], str) or _SHA256_HEX.fullmatch(identity["key"]) is None:
        raise ValueError("identity.key must be a lowercase HMAC-SHA-256 digest")
    key_id = _key_id(identity["keyId"], "identity.keyId")
    return {
        "schema": item["schema"],
        "requestId": request_id,
        "tenantId": tenant_id,
        "applicationId": application_id,
        "policyId": policy_id,
        "scope": scope,
        "identity": {"type": identity["type"], "key": identity["key"], "keyId": key_id},
    }


def normalize_rate_limit_decision(value: Any) -> dict[str, Any]:
    item = _exact_keys(value, {
        "schema", "requestId", "tenantId", "applicationId", "policyId", "scope",
        "allowed", "exceeded", "enforced", "unavailable", "status", "retryAfterSeconds"
    }, "decision")
    if item["schema"] != "jb.security.rate-limit.decision/v1":
        raise ValueError("decision.schema is unsupported")
    try:
        request_id = str(uuid.UUID(item["requestId"]))
    except (ValueError, TypeError, AttributeError) as exc:
        raise ValueError("decision.requestId must be a UUID") from exc
    for field in ("tenantId", "applicationId", "policyId", "scope"):
        _identifier(item[field], field)
    for field in ("allowed", "exceeded", "enforced", "unavailable"):
        if type(item[field]) is not bool:
            raise ValueError(f"decision.{field} must be boolean")
    status = item["status"]
    if status not in (None, 429, 503) or type(status) not in (int, type(None)):
        raise ValueError("decision.status must be null, 429, or 503")
    retry = item["retryAfterSeconds"]
    if retry is not None and (type(retry) is not int or not 1 <= retry <= 60):
        raise ValueError("decision.retryAfterSeconds must be null or an integer from 1 to 60")
    allowed = item["allowed"]
    exceeded = item["exceeded"]
    enforced = item["enforced"]
    unavailable = item["unavailable"]
    if allowed and (status is not None or retry is not None or enforced):
        raise ValueError("allowed decisions cannot be enforced or carry a blocking response")
    if allowed and unavailable and exceeded:
        raise ValueError("fail-open unavailable decisions cannot be quota-exceeded")
    if not allowed and status not in (429, 503):
        raise ValueError("denied decisions require 429 or 503")
    if status == 429 and (not exceeded or not enforced or unavailable):
        raise ValueError("429 requires exceeded=true, enforced=true and unavailable=false")
    if status == 503 and (exceeded or not enforced or not unavailable):
        raise ValueError("503 requires exceeded=false, enforced=true and unavailable=true")
    if status is None and retry is not None:
        raise ValueError("Retry-After requires a response status")
    return {**item, "requestId": request_id}


def normalize_rate_limit_policy(value: Any) -> dict[str, Any]:
    item = _exact_keys(value, {
        "schema", "id", "tenantId", "applicationId", "version",
        "enabled", "mode", "failureMode", "limits"
    }, "policy")
    if item["schema"] != "jb.security.policy.rate-limit/v1":
        raise ValueError("policy.schema is unsupported")
    for field in ("id", "tenantId", "applicationId"):
        _identifier(item[field], f"policy.{field}")
    if type(item["version"]) is not int or item["version"] < 1:
        raise ValueError("policy.version must be a positive integer")
    if type(item["enabled"]) is not bool:
        raise ValueError("policy.enabled must be boolean")
    if item["mode"] not in ("monitor", "enforce"):
        raise ValueError("policy.mode is unsupported")
    if item["failureMode"] not in ("open", "closed"):
        raise ValueError("policy.failureMode is unsupported")
    limits = item["limits"]
    if not isinstance(limits, list) or not 1 <= len(limits) <= 64:
        raise ValueError("policy.limits must contain 1-64 entries")
    seen: set[str] = set()
    normalized: list[dict[str, Any]] = []
    for index, raw in enumerate(limits):
        limit = _exact_keys(raw, {"id", "identityType", "scope", "windowSeconds", "maxRequests"}, f"policy.limits[{index}]")
        _identifier(limit["id"], f"policy.limits[{index}].id")
        _identifier(limit["scope"], f"policy.limits[{index}].scope")
        if limit["id"] in seen:
            raise ValueError("policy limit IDs must be unique")
        seen.add(limit["id"])
        if not isinstance(limit["identityType"], str) or limit["identityType"] not in _IDENTITY_TYPES:
            raise ValueError(f"policy.limits[{index}].identityType is unsupported")
        if type(limit["windowSeconds"]) is not int or not 1 <= limit["windowSeconds"] <= 86400:
            raise ValueError(f"policy.limits[{index}].windowSeconds is out of bounds")
        if type(limit["maxRequests"]) is not int or not 1 <= limit["maxRequests"] <= 1_000_000:
            raise ValueError(f"policy.limits[{index}].maxRequests is out of bounds")
        normalized.append({
            "id": limit["id"],
            "identityType": limit["identityType"],
            "scope": limit["scope"],
            "windowSeconds": limit["windowSeconds"],
            "maxRequests": limit["maxRequests"],
        })
    return {**item, "limits": normalized}


def create_rate_limit_counter_key(value: Any) -> str:
    item = _exact_keys(value, {
        "tenantId", "applicationId", "policyId", "scope",
        "identityType", "keyId", "identityKey"
    }, "counterKey")
    values = [
        "jbsg-counter-v1",
        _identifier(item["tenantId"], "counterKey.tenantId"),
        _identifier(item["applicationId"], "counterKey.applicationId"),
        _identifier(item["policyId"], "counterKey.policyId"),
        _identifier(item["scope"], "counterKey.scope"),
    ]
    if not isinstance(item["identityType"], str) or item["identityType"] not in _IDENTITY_TYPES:
        raise ValueError("counterKey.identityType is unsupported")
    values.append(item["identityType"])
    values.append(_key_id(item["keyId"], "counterKey.keyId"))
    digest = item["identityKey"]
    if not isinstance(digest, str) or _SHA256_HEX.fullmatch(digest) is None:
        raise ValueError("counterKey.identityKey must be a lowercase HMAC-SHA-256 digest")
    values.append(digest)
    return "".join(f"{len(part.encode('utf-8'))}:{part}" for part in values)


_UPLOAD_ATTESTATION_ID = re.compile(
    r"^(?:[a-f0-9]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$"
)
_UPLOAD_MIME_TYPES = {
    "image/jpeg", "image/png", "image/gif", "image/webp", "application/pdf"
}
_UPLOAD_SCANNER_LABEL = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._+-]*$")


def validate_upload_inspection_attestation_v1(value: Any) -> dict[str, Any]:
    """Validate a scanner attestation bound to one exact quarantined object.

    A clean scanner verdict is evidence only; it never authorizes promotion.
    """
    item = _exact_keys(value, {
        "schema", "uploadId", "verdict", "sha256", "size", "mimeType",
        "engine", "version", "scannedAtMs"
    }, "uploadInspectionAttestation")
    if item["schema"] != "jb.security.upload-inspection.attestation/v1":
        raise ValueError("uploadInspectionAttestation.schema is unsupported")
    if not isinstance(item["uploadId"], str) or _UPLOAD_ATTESTATION_ID.fullmatch(item["uploadId"]) is None:
        raise ValueError("uploadInspectionAttestation.uploadId is invalid")
    if item["verdict"] not in ("clean", "malicious", "unknown"):
        raise ValueError("uploadInspectionAttestation.verdict is unsupported")
    if not isinstance(item["sha256"], str) or _SHA256_HEX.fullmatch(item["sha256"]) is None:
        raise ValueError("uploadInspectionAttestation.sha256 must be a lowercase SHA-256 digest")
    if type(item["size"]) is not int or not 1 <= item["size"] <= 104857600:
        raise ValueError("uploadInspectionAttestation.size is out of bounds")
    if item["mimeType"] not in _UPLOAD_MIME_TYPES:
        raise ValueError("uploadInspectionAttestation.mimeType is unsupported")
    for field, maximum in (("engine", 128), ("version", 64)):
        label = item[field]
        if not isinstance(label, str) or len(label) > maximum or _UPLOAD_SCANNER_LABEL.fullmatch(label) is None:
            raise ValueError(f"uploadInspectionAttestation.{field} is invalid")
    if type(item["scannedAtMs"]) is not int or item["scannedAtMs"] < 0:
        raise ValueError("uploadInspectionAttestation.scannedAtMs must be a non-negative integer")
    return dict(item)
