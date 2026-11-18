from __future__ import annotations

import hashlib
import os
import secrets
from datetime import datetime, timezone
from pathlib import Path
from typing import BinaryIO, Callable, Protocol, Any

from .core_v1 import validate_upload_inspection_attestation_v1


DEFAULT_MAX_BYTES = 5 * 1024 * 1024
MAX_BYTES = 100 * 1024 * 1024
CHUNK_SIZE = 64 * 1024
MAX_SIGNATURE_BYTES = 8192
MAX_SCANNER_READ_BYTES = 1024 * 1024

_TYPES: dict[str, tuple[str, ...]] = {
    "image/jpeg": ("jpg", "jpeg"),
    "image/png": ("png",),
    "image/gif": ("gif",),
    "image/webp": ("webp",),
    "application/pdf": ("pdf",),
}


class UploadInspectionError(RuntimeError):
    def __init__(
        self,
        reason: str,
        message: str = "Upload could not be safely approved",
        attestation: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.reason = reason
        if attestation is not None:
            self.attestation = dict(attestation)


class UploadQuarantineStorage(Protocol):
    """Host adapter. Quarantine and approved namespaces must both be private."""

    def create_quarantine_stream(self, upload_id: str) -> BinaryIO: ...
    def open_quarantine_stream(self, upload_id: str) -> BinaryIO: ...
    def promote(self, upload_id: str, expected_sha256: str, expected_size: int, attestation: dict[str, Any]) -> bool: ...
    def delete(self, upload_id: str) -> None: ...


class UploadMalwareScanner(Protocol):
    """Host adapter backed by a real, versioned scanner with its own hard deadline."""

    def scan(self, stream: UploadInspectionReadOnlyStream, metadata: dict[str, Any]) -> dict[str, Any]: ...


def _extension(filename: str) -> str | None:
    if not isinstance(filename, str) or not filename or len(filename) > 255:
        raise UploadInspectionError("INVALID_INPUT")
    leaf = filename.replace("\\", "/").rsplit("/", 1)[-1]
    if leaf in ("", ".", ".."):
        raise UploadInspectionError("INVALID_INPUT")
    suffix = Path(leaf).suffix.lower()
    return suffix[1:] if suffix else None


def _normalize_mime(value: str | None) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or len(value) > 128:
        raise UploadInspectionError("INVALID_INPUT")
    if value.strip() == "":
        return None
    return value.split(";", 1)[0].strip().lower()


def _detect_type(prefix: bytes) -> str | None:
    if prefix.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if prefix.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if prefix.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif"
    if len(prefix) >= 12 and prefix[:4] == b"RIFF" and prefix[8:12] == b"WEBP":
        return "image/webp"
    if prefix.startswith(b"%PDF-"):
        return "application/pdf"
    return None


def _write_all(stream: BinaryIO, chunk: bytes) -> None:
    view = memoryview(chunk)
    offset = 0
    while offset < len(view):
        written = stream.write(view[offset:])
        if not isinstance(written, int) or written <= 0:
            raise UploadInspectionError("QUARANTINE_WRITE_FAILED")
        offset += written


class UploadInspectionReadOnlyStream:
    """Unbuffered, sequential scanner reader with independent byte accounting.

    This is intentionally not an io.RawIOBase: a scanner cannot wrap it in
    io.BufferedReader and make a small read appear to consume prefetched bytes.
    """

    def __init__(self, source: BinaryIO, expected_size: int, expected_sha256: str) -> None:
        self._source = source
        self._expected_size = expected_size
        self._expected_sha256 = expected_sha256
        self._digest = hashlib.sha256()
        self._consumed = 0
        self._eof = False
        self._closed = False

    @property
    def closed(self) -> bool:
        return self._closed

    def close(self) -> None:
        # Close only the scanner-facing capability. The service owns the
        # underlying quarantine resource and closes it separately.
        self._closed = True

    def read(self, size: int = CHUNK_SIZE) -> bytes:
        if self._closed:
            raise UploadInspectionError("SCAN_INCOMPLETE")
        if type(size) is not int or size < 1 or size > MAX_SCANNER_READ_BYTES:
            raise UploadInspectionError("INVALID_SCAN_RESULT")
        if self._eof:
            return b""

        remaining = self._expected_size - self._consumed
        if remaining < 0:
            raise UploadInspectionError("SCAN_CONTENT_MISMATCH")

        chunk = self._source.read(min(size, remaining + 1))
        if chunk is None:
            raise UploadInspectionError("SCAN_INCOMPLETE")
        if not isinstance(chunk, bytes):
            raise UploadInspectionError("SCAN_CONTENT_MISMATCH")
        if len(chunk) > remaining:
            raise UploadInspectionError("SCAN_CONTENT_MISMATCH")
        if chunk == b"":
            self._eof = True
            return b""

        self._digest.update(chunk)
        self._consumed += len(chunk)
        return chunk

    def verify_complete(self) -> str:
        if self._closed:
            return "incomplete"
        if self._consumed != self._expected_size:
            return "incomplete"

        # Probe the underlying source after the scanner returns. The reader
        # itself never exposes this resource or a buffered/readinto interface.
        extra = self._source.read(1)
        if extra is None:
            return "incomplete"
        if not isinstance(extra, bytes) or extra != b"":
            return "content_mismatch"
        self._eof = True

        if self._digest.hexdigest() != self._expected_sha256:
            return "content_mismatch"
        return "complete"


class UploadInspectionService:
    """Fail-closed quarantine -> scan -> digest verification -> private promotion flow.

    This orchestrator does not bundle antivirus or storage implementations. The
    host must inject private storage and a real scanner. Image decoding/re-encoding,
    authorization-aware serving and HTTP response headers remain host duties.
    """

    def __init__(
        self,
        storage: UploadQuarantineStorage,
        scanner: UploadMalwareScanner,
        max_bytes: int = DEFAULT_MAX_BYTES,
        on_event: Callable[[dict[str, str]], None] | None = None,
    ) -> None:
        if type(max_bytes) is not int or not 1 <= max_bytes <= MAX_BYTES:
            raise ValueError("max_bytes must be an integer between 1 and 104857600")
        if not callable(getattr(storage, "create_quarantine_stream", None)) or not callable(
            getattr(storage, "open_quarantine_stream", None)
        ) or not callable(getattr(storage, "promote", None)) or not callable(
            getattr(storage, "delete", None)
        ):
            raise TypeError("storage does not implement the quarantine contract")
        if not callable(getattr(scanner, "scan", None)):
            raise TypeError("scanner.scan must be callable")
        if on_event is not None and not callable(on_event):
            raise TypeError("on_event must be callable")
        self._storage = storage
        self._scanner = scanner
        self._max_bytes = max_bytes
        self._on_event = on_event or (lambda event: None)

    def _emit(self, event: str, reason: str | None = None) -> None:
        payload = {"event": event}
        if reason is not None:
            payload["reason"] = reason
        try:
            self._on_event(payload)
        except Exception:
            # Telemetry must not change an approval decision.
            pass

    def inspect(
        self,
        source_path: str | os.PathLike[str],
        client_filename: str,
        declared_mime_type: str | None = None,
    ) -> dict[str, Any]:
        extension = _extension(client_filename)
        declared_type = _normalize_mime(declared_mime_type)
        path = os.fspath(source_path)
        if not os.path.isfile(path) or not os.access(path, os.R_OK):
            raise UploadInspectionError("INVALID_INPUT")

        upload_id = secrets.token_hex(16)
        quarantine_attempted = False
        retain_quarantine = False
        promoted = False
        source: BinaryIO | None = None
        writer: BinaryIO | None = None

        try:
            source = open(path, "rb")
            quarantine_attempted = True
            writer = self._storage.create_quarantine_stream(upload_id)
            if not hasattr(writer, "write") or not hasattr(writer, "close"):
                raise UploadInspectionError("QUARANTINE_WRITE_FAILED")

            digest = hashlib.sha256()
            size = 0
            prefix = bytearray()
            while True:
                chunk = source.read(CHUNK_SIZE)
                if chunk == b"":
                    break
                if not isinstance(chunk, bytes):
                    raise UploadInspectionError("INGEST_FAILED")
                if size + len(chunk) > self._max_bytes:
                    raise UploadInspectionError("UPLOAD_TOO_LARGE")
                size += len(chunk)
                digest.update(chunk)
                if len(prefix) < MAX_SIGNATURE_BYTES:
                    prefix.extend(chunk[: MAX_SIGNATURE_BYTES - len(prefix)])
                _write_all(writer, chunk)

            writer.close()
            writer = None
            source.close()
            source = None

            if size == 0:
                raise UploadInspectionError("UNSUPPORTED_TYPE")
            detected_type = _detect_type(bytes(prefix))
            if detected_type is None:
                raise UploadInspectionError("UNSUPPORTED_TYPE")
            if extension is not None and extension not in _TYPES[detected_type]:
                raise UploadInspectionError("EXTENSION_MISMATCH")
            if declared_type is not None and declared_type not in (
                "application/octet-stream",
                "binary/octet-stream",
                detected_type,
            ):
                raise UploadInspectionError("MIME_MISMATCH")

            sha256 = digest.hexdigest()
            metadata = {
                "uploadId": upload_id,
                "size": size,
                "sha256": sha256,
                "detectedMimeType": detected_type,
                "mimeType": detected_type,
            }
            scan_stream = self._storage.open_quarantine_stream(upload_id)
            verified_scan_stream = UploadInspectionReadOnlyStream(scan_stream, size, sha256)
            try:
                scan_result = self._scanner.scan(verified_scan_stream, metadata)
                scan_disposition = verified_scan_stream.verify_complete()
                if scan_disposition != "complete":
                    retain_quarantine = True
                    raise UploadInspectionError(
                        "SCAN_CONTENT_MISMATCH"
                        if scan_disposition == "content_mismatch"
                        else "SCAN_INCOMPLETE"
                    )
            except UploadInspectionError:
                retain_quarantine = True
                raise
            except Exception as exc:
                retain_quarantine = True
                raise UploadInspectionError("SCANNER_UNAVAILABLE") from exc
            finally:
                verified_scan_stream.close()
                scan_stream.close()

            if not isinstance(scan_result, dict) or set(scan_result) != {
                "verdict", "sha256", "size", "engine", "version"
            }:
                retain_quarantine = True
                raise UploadInspectionError("INVALID_SCAN_RESULT")
            if scan_result["verdict"] not in ("clean", "malicious", "unknown"):
                retain_quarantine = True
                raise UploadInspectionError("INVALID_SCAN_RESULT")
            if (
                not isinstance(scan_result["sha256"], str)
                or scan_result["sha256"] != sha256
                or type(scan_result["size"]) is not int
                or scan_result["size"] != size
                or not isinstance(scan_result["engine"], str)
                or not scan_result["engine"].strip()
                or len(scan_result["engine"]) > 128
                or not isinstance(scan_result["version"], str)
                or not scan_result["version"].strip()
                or len(scan_result["version"]) > 64
            ):
                retain_quarantine = True
                raise UploadInspectionError("SCAN_INTEGRITY_MISMATCH")
            scanned_at_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
            try:
                attestation = validate_upload_inspection_attestation_v1({
                    "schema": "jb.security.upload-inspection.attestation/v1",
                    "uploadId": upload_id,
                    "verdict": scan_result["verdict"],
                    "sha256": sha256,
                    "size": size,
                    "mimeType": detected_type,
                    "engine": scan_result["engine"],
                    "version": scan_result["version"],
                    "scannedAtMs": scanned_at_ms,
                })
            except (TypeError, ValueError) as exc:
                raise UploadInspectionError("INVALID_SCAN_RESULT") from exc

            if scan_result["verdict"] == "malicious":
                raise UploadInspectionError("MALWARE_DETECTED", attestation=attestation)
            if scan_result["verdict"] != "clean":
                retain_quarantine = True
                raise UploadInspectionError("SCAN_NOT_CLEAN", attestation=attestation)

            retain_quarantine = True
            try:
                promotion_result = self._storage.promote(upload_id, sha256, size, attestation)
            except Exception as exc:
                raise UploadInspectionError("PROMOTION_FAILED", attestation=attestation) from exc
            if promotion_result is not True:
                raise UploadInspectionError("PROMOTION_FAILED", attestation=attestation)
            promoted = True
            retain_quarantine = False
            self._emit("upload-approved")
            return {
                "status": "approved",
                "uploadId": upload_id,
                "sha256": sha256,
                "size": size,
                "mimeType": detected_type,
                "scanner": {"engine": scan_result["engine"], "version": scan_result["version"]},
                "scannedAt": datetime.fromtimestamp(scanned_at_ms / 1000, timezone.utc).isoformat().replace("+00:00", "Z"),
                "attestation": attestation,
            }
        except UploadInspectionError as exc:
            self._emit("upload-rejected", exc.reason)
            if writer is not None:
                try:
                    writer.close()
                except Exception:
                    pass
                writer = None
            if source is not None:
                try:
                    source.close()
                except Exception:
                    pass
                source = None
            if quarantine_attempted and not promoted and not retain_quarantine:
                try:
                    self._storage.delete(upload_id)
                except Exception as cleanup_error:
                    raise UploadInspectionError("QUARANTINE_CLEANUP_FAILED") from cleanup_error
            raise
        except Exception as exc:
            self._emit("upload-rejected", "INSPECTION_FAILED")
            if writer is not None:
                try:
                    writer.close()
                except Exception:
                    pass
                writer = None
            if source is not None:
                try:
                    source.close()
                except Exception:
                    pass
                source = None
            if quarantine_attempted and not promoted and not retain_quarantine:
                try:
                    self._storage.delete(upload_id)
                except Exception as cleanup_error:
                    raise UploadInspectionError("QUARANTINE_CLEANUP_FAILED") from cleanup_error
            raise UploadInspectionError("INSPECTION_FAILED") from exc
        finally:
            if writer is not None:
                try:
                    writer.close()
                except Exception:
                    pass
            if source is not None:
                try:
                    source.close()
                except Exception:
                    pass
