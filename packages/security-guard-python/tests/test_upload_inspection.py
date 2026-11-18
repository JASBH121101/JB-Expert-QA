from __future__ import annotations

import hashlib
import io
import tempfile
import unittest
from pathlib import Path

from jb_security_guard.uploads import UploadInspectionError, UploadInspectionService


PNG = b"\x89PNG\r\n\x1a\n" + b"safe-png-fixture"


class _QuarantineWriter(io.BytesIO):
    def __init__(self, storage, upload_id):
        super().__init__()
        self.storage = storage
        self.upload_id = upload_id

    def close(self):
        if not self.closed:
            self.storage.quarantine[self.upload_id] = self.getvalue()
        super().close()


class MemoryStorage:
    def __init__(self, promotion_result=True):
        self.quarantine = {}
        self.approved = {}
        self.approved_attestations = {}
        self.promotion_result = promotion_result
        self.deleted = []

    def create_quarantine_stream(self, upload_id):
        return _QuarantineWriter(self, upload_id)

    def open_quarantine_stream(self, upload_id):
        return io.BytesIO(self.quarantine[upload_id])

    def promote(self, upload_id, expected_sha256, expected_size, attestation):
        data = self.quarantine[upload_id]
        if hashlib.sha256(data).hexdigest() != expected_sha256 or len(data) != expected_size:
            return False
        if self.promotion_result is not True:
            return False
        if (
            attestation.get("uploadId") != upload_id
            or attestation.get("sha256") != expected_sha256
            or attestation.get("size") != expected_size
            or attestation.get("verdict") != "clean"
        ):
            return False
        self.approved[upload_id] = data
        self.approved_attestations[upload_id] = dict(attestation)
        del self.quarantine[upload_id]
        return True

    def delete(self, upload_id):
        self.deleted.append(upload_id)
        self.quarantine.pop(upload_id, None)
        self.approved.pop(upload_id, None)
        self.approved_attestations.pop(upload_id, None)


class Scanner:
    def __init__(self, verdict="clean", alter_digest=False, raise_error=False):
        self.verdict = verdict
        self.alter_digest = alter_digest
        self.raise_error = raise_error

    def scan(self, stream, metadata):
        if self.raise_error:
            raise RuntimeError("scanner private detail")
        data = stream.read()
        digest = hashlib.sha256(data).hexdigest()
        return {
            "verdict": self.verdict,
            "sha256": ("0" * 64) if self.alter_digest else digest,
            "size": len(data),
            "engine": "test-scanner",
            "version": "1.0",
        }


class UploadInspectionTests(unittest.TestCase):
    def inspect_fixture(self, data=PNG, filename="photo.png", mime="image/png", **kwargs):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "upload.bin"
            path.write_bytes(data)
            storage = kwargs.pop("storage", MemoryStorage())
            scanner = kwargs.pop("scanner", Scanner())
            service = UploadInspectionService(storage, scanner, **kwargs)
            result = service.inspect(path, filename, mime)
            return result, storage

    def test_clean_upload_is_scanned_and_promoted_privately(self):
        result, storage = self.inspect_fixture()
        self.assertEqual(result["status"], "approved")
        attestation = result["attestation"]
        self.assertEqual(attestation["schema"], "jb.security.upload-inspection.attestation/v1")
        self.assertEqual(attestation["uploadId"], result["uploadId"])
        self.assertEqual(attestation["verdict"], "clean")
        self.assertEqual(attestation["sha256"], result["sha256"])
        self.assertEqual(attestation["size"], result["size"])
        self.assertEqual(attestation["mimeType"], result["mimeType"])
        self.assertEqual(attestation["engine"], "test-scanner")
        self.assertEqual(attestation["version"], "1.0")
        self.assertIs(type(attestation["scannedAtMs"]), int)
        self.assertGreaterEqual(attestation["scannedAtMs"], 0)
        self.assertRegex(result["scannedAt"], r"^\d{4}-\d{2}-\d{2}T.*Z$")
        self.assertEqual(storage.approved[result["uploadId"]], PNG)
        self.assertEqual(storage.approved_attestations[result["uploadId"]], attestation)
        self.assertEqual(storage.quarantine, {})

    def test_extension_and_declared_mime_mismatches_are_rejected(self):
        for filename, mime, reason in (
            ("photo.pdf", "image/png", "EXTENSION_MISMATCH"),
            ("photo.png", "image/jpeg", "MIME_MISMATCH"),
        ):
            with self.subTest(filename=filename, mime=mime):
                with tempfile.TemporaryDirectory() as directory:
                    path = Path(directory) / "upload"
                    path.write_bytes(PNG)
                    storage = MemoryStorage()
                    service = UploadInspectionService(storage, Scanner())
                    with self.assertRaises(UploadInspectionError) as caught:
                        service.inspect(path, filename, mime)
                    self.assertEqual(caught.exception.reason, reason)
                    self.assertEqual(storage.quarantine, {})

    def test_oversized_and_unsupported_files_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "upload"
            path.write_bytes(PNG)
            storage = MemoryStorage()
            service = UploadInspectionService(storage, Scanner(), max_bytes=8)
            with self.assertRaises(UploadInspectionError) as caught:
                service.inspect(path, "photo.png", "image/png")
            self.assertEqual(caught.exception.reason, "UPLOAD_TOO_LARGE")
            self.assertEqual(storage.quarantine, {})

            path.write_bytes(b"not a supported file")
            service = UploadInspectionService(storage, Scanner())
            with self.assertRaises(UploadInspectionError) as caught:
                service.inspect(path, "photo.png", "image/png")
            self.assertEqual(caught.exception.reason, "UNSUPPORTED_TYPE")
            self.assertEqual(storage.quarantine, {})

    def test_malicious_unknown_scanner_failure_and_digest_mismatch_never_promote(self):
        for scanner, reason, retain in (
            (Scanner(verdict="malicious"), "MALWARE_DETECTED", True),
            (Scanner(verdict="unknown"), "SCAN_NOT_CLEAN", True),
            (Scanner(raise_error=True), "SCANNER_UNAVAILABLE", True),
            (Scanner(alter_digest=True), "SCAN_INTEGRITY_MISMATCH", True),
        ):
            with self.subTest(reason=reason), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "upload"
                path.write_bytes(PNG)
                storage = MemoryStorage()
                service = UploadInspectionService(storage, scanner)
                with self.assertRaises(UploadInspectionError) as caught:
                    service.inspect(path, "photo.png", "image/png")
                self.assertEqual(caught.exception.reason, reason)
                self.assertEqual(storage.approved, {})
                self.assertEqual(bool(storage.quarantine), retain)
                if reason == "MALWARE_DETECTED":
                    self.assertEqual(storage.deleted, [])

    def test_promotion_failure_never_returns_approved(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "upload"
            path.write_bytes(PNG)
            storage = MemoryStorage(promotion_result=False)
            service = UploadInspectionService(storage, Scanner())
            with self.assertRaises(UploadInspectionError) as caught:
                service.inspect(path, "photo.png", "image/png")
            self.assertEqual(caught.exception.reason, "PROMOTION_FAILED")
            self.assertEqual(storage.approved, {})
            self.assertTrue(storage.quarantine)

    def test_uncertain_promotion_exception_retains_quarantine(self):
        class UncertainStorage(MemoryStorage):
            def promote(self, upload_id, expected_sha256, expected_size, attestation):
                raise RuntimeError("promotion response lost")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "upload"
            path.write_bytes(PNG)
            storage = UncertainStorage()
            service = UploadInspectionService(storage, Scanner())
            with self.assertRaises(UploadInspectionError) as caught:
                service.inspect(path, "photo.png", "image/png")
            self.assertEqual(caught.exception.reason, "PROMOTION_FAILED")
            self.assertTrue(storage.quarantine)
            self.assertEqual(storage.approved, {})

    def test_invalid_scanner_contract_is_retained_for_review(self):
        class InvalidScanner:
            def scan(self, stream, metadata):
                stream.read()
                return {"verdict": "clean"}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "upload"
            path.write_bytes(PNG)
            storage = MemoryStorage()
            service = UploadInspectionService(storage, InvalidScanner())
            with self.assertRaises(UploadInspectionError) as caught:
                service.inspect(path, "photo.png", "image/png")
            self.assertEqual(caught.exception.reason, "INVALID_SCAN_RESULT")
            self.assertTrue(storage.quarantine)
            self.assertEqual(storage.approved, {})

    def test_windows_style_client_filename_is_reduced_to_extension_only(self):
        result, storage = self.inspect_fixture(filename=r"C:\fake\photo.png")
        self.assertEqual(result["status"], "approved")
        self.assertEqual(storage.approved[result["uploadId"]], PNG)

    def test_invalid_mime_type_is_rejected_without_storage_access(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "upload"
            path.write_bytes(PNG)
            storage = MemoryStorage()
            service = UploadInspectionService(storage, Scanner())
            with self.assertRaises(UploadInspectionError) as caught:
                service.inspect(path, "photo.png", declared_mime_type=object())
            self.assertEqual(caught.exception.reason, "INVALID_INPUT")
            self.assertEqual(storage.quarantine, {})

    def test_telemetry_is_sanitized_and_cannot_change_decision(self):
        events = []
        def broken_sink(event):
            events.append(event)
            raise RuntimeError("telemetry down")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "upload"
            path.write_bytes(PNG)
            service = UploadInspectionService(MemoryStorage(), Scanner(), on_event=broken_sink)
            result = service.inspect(path, "private-customer-name.png", "image/png")
            self.assertEqual(result["status"], "approved")
        self.assertEqual(events, [{"event": "upload-approved"}])


    def test_real_jpeg_binary_signature_is_recognized(self):
        jpeg = b"\xff\xd8\xff\xe0" + b"synthetic-jpeg-fixture"
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "upload"
            path.write_bytes(jpeg)
            storage = MemoryStorage()
            service = UploadInspectionService(storage, Scanner())
            result = service.inspect(path, "photo.jpg", "image/jpeg")
            self.assertEqual(result["mimeType"], "image/jpeg")
            self.assertEqual(storage.approved[result["uploadId"]], jpeg)

    def test_textual_escape_bytes_are_not_accepted_as_png(self):
        literal_png = b"\\x89PNG\\r\\n\\x1a\\n" + b"safe-png-fixture"
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "upload"
            path.write_bytes(literal_png)
            storage = MemoryStorage()
            service = UploadInspectionService(storage, Scanner())
            with self.assertRaises(UploadInspectionError) as caught:
                service.inspect(path, "photo.png", "image/png")
            self.assertEqual(caught.exception.reason, "UNSUPPORTED_TYPE")
            self.assertEqual(storage.approved, {})
            self.assertEqual(storage.quarantine, {})


if __name__ == "__main__":
    unittest.main()
