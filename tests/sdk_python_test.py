"""Offline SDK parity tests. Run: python3 -m unittest discover -s tests -p sdk_python_test.py"""
import hashlib
import hmac
import json
import sys
import threading
import time
import unittest
from email.message import Message
from email.utils import formatdate
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "sdk" / "python"))
from mailhub import MailHubClient, MailHubError, TransportResponse, verify_webhook


EMPTY = dict(email="user@example.test", source="cf_domain", has_mail=False, code="", link="", message="empty", outcome="empty", poll_after_seconds=10)
FOUND = dict(EMPTY, outcome="found", has_mail=True, code="123456")


def response(body, status=200, headers=None):
    return TransportResponse(status, headers or {}, json.dumps(body).encode())


class Clock:
    def __init__(self):
        self.value = 0.0
        self.waits = []

    def monotonic(self):
        return self.value

    def time(self):
        return 1794700800 + self.value  # 2026-11-15 UTC

    def sleep(self, seconds, cancel_event=None):
        if cancel_event and cancel_event.is_set():
            raise MailHubError("ABORTED", "Cancelled")
        self.waits.append(seconds)
        self.value += seconds


class SDKTests(unittest.TestCase):
    def sdk(self, transport, clock=None):
        return MailHubClient("https://mailhub.example.test", "fictional-sdk-key", transport=transport, clock=clock)

    def test_methods_headers_opaque_ids_and_accepted_metadata(self):
        calls = []
        def transport(request, timeout):
            calls.append(request)
            return response({"success": True, "data": {"accepted": True}}, 202, {"X-Request-ID": "req-test", "Idempotency-Replayed": "true"})
        sdk = self.sdk(transport)
        sdk.inspect_mailbox({"vault_id": 1})
        sdk.lookup_verification({"email": "user@example.test"})
        sdk.register({"platform_name": "Example"}, idempotency_key="register-1")
        sdk.send_mail(3, {"to": ["to@example.test"], "subject": "Test", "body": "Approved"}, idempotency_key="send-1")
        reply = sdk.reply(3, "opaque/id?+#%", {"body": "Reply"}, idempotency_key="reply-1")
        expected = ["/api/automation/mailbox", "/api/automation/verification", "/api/external/register", "/api/outlook/accounts/3/send", "/api/outlook/accounts/3/messages/opaque%2Fid%3F%2B%23%25/reply"]
        for request, path, key in zip(calls, expected, [None, None, "register-1", "send-1", "reply-1"]):
            self.assertEqual(request.full_url, "https://mailhub.example.test" + path)
            self.assertEqual(request.get_method(), "POST")
            headers = {k.lower(): v for k, v in request.header_items()}
            self.assertEqual(headers["authorization"], "Bearer fictional-sdk-key")
            self.assertEqual(headers.get("idempotency-key"), key)
        self.assertEqual(reply.status, 202)
        self.assertEqual(reply.request_id, "req-test")
        self.assertTrue(reply.idempotency_replayed)

    def test_provider_sources(self):
        calls = []
        def transport(request, timeout):
            calls.append(json.loads(request.data))
            return response({"success": True, "data": EMPTY})
        sdk = self.sdk(transport)
        for source in ("mailtm", "mailgw"):
            sdk.lookup_verification({"email": "owned@provider.test", "source": source})
            self.assertEqual(calls[-1]["source"], source)
        with self.assertRaises(Exception):
            sdk.lookup_verification({"email": "owned@provider.test", "source": "unknown"})
        self.assertEqual(len(calls), 2)

    def test_errors_and_writes_never_retry(self):
        calls = []
        def transport(request, timeout):
            calls.append(request)
            return response({"error": "SEND_RATE_LIMITED", "message": "Wait", "retry_after": 30, "retryable": True, "draft_id": "draft", "delivery_unknown": True}, 429, {"Retry-After": "45", "X-Request-ID": "req-limited"})
        with self.assertRaises(MailHubError) as caught:
            self.sdk(transport).send_mail(1, {"to": ["to@example.test"], "subject": "Test", "body": "Test"}, idempotency_key="write-once")
        error = caught.exception
        self.assertEqual((error.code, error.status, error.request_id, error.retry_after), ("SEND_RATE_LIMITED", 429, "req-limited", 45))
        self.assertEqual(error.details["draft_id"], "draft")
        self.assertTrue(error.details["delivery_unknown"])
        self.assertEqual(len(calls), 1)

    def test_fixed_since_empty_and_retry_window(self):
        clock, calls = Clock(), []
        def transport(request, timeout):
            calls.append(json.loads(request.data))
            self.assertNotIn("idempotency-key", dict((k.lower(), v) for k, v in request.header_items()))
            if len(calls) == 1:
                return response({"success": True, "data": EMPTY})
            if len(calls) == 2:
                return response({"error": "RATE_LIMITED", "message": "Wait", "retry_after": 12}, 429, {"Retry-After": "20"})
            return response({"success": True, "data": FOUND}, headers={"X-Request-ID": "found-req"})
        result = self.sdk(transport, clock).wait_for_verification({"email": "user@example.test", "q": "Login"})
        self.assertEqual(result["outcome"], "found")
        self.assertEqual(result["data"]["code"], "123456")
        self.assertEqual(result["elapsed_seconds"], 30)
        self.assertEqual(result["request_id"], "found-req")
        self.assertEqual(clock.waits, [10, 20])
        self.assertTrue(all(c["since"] == "2026-11-15T00:00:00.000Z" and c["q"] == "Login" for c in calls))

    def test_deadline_caps_and_nonretryable_error(self):
        clock, calls = Clock(), []
        def transport(request, timeout):
            calls.append(request)
            return response({"success": True, "data": EMPTY})
        result = self.sdk(transport, clock).wait_for_verification({"vault_id": 1}, timeout_seconds=999)
        self.assertEqual(result["outcome"], "timeout")
        self.assertEqual(len(calls), 18)
        self.assertLessEqual(result["elapsed_seconds"], 180)
        clock = Clock()
        limited = self.sdk(lambda req, timeout: response({"error": "RATE_LIMITED", "message": "Wait"}, 429, {"Retry-After": "3600", "X-Request-ID": "rate-req"}), clock)
        timed = limited.wait_for_verification({"vault_id": 1})
        self.assertEqual(timed["outcome"], "timeout")
        self.assertEqual(timed["attempts"], 1)
        self.assertEqual(timed["last_error"].retry_after, 3600)
        with self.assertRaises(MailHubError) as caught:
            self.sdk(lambda req, timeout: response({"error": "FORBIDDEN", "message": "No"}, 403)).wait_for_verification({"vault_id": 1})
        self.assertEqual(caught.exception.code, "FORBIDDEN")

    def test_timeout_and_cancel_bound_unresponsive_transport(self):
        release = threading.Event()
        def hanging(request, timeout):
            release.wait(2)
            return response({"success": True, "data": FOUND})
        try:
            sdk = self.sdk(hanging)
            started = time.monotonic()
            self.assertEqual(sdk.wait_for_verification({"vault_id": 1}, timeout_seconds=0.03)["outcome"], "timeout")
            self.assertLess(time.monotonic() - started, 0.5)
            cancel = threading.Event()
            timer = threading.Timer(0.03, cancel.set)
            timer.start()
            with self.assertRaises(MailHubError) as caught:
                sdk.wait_for_verification({"vault_id": 1}, cancel_event=cancel)
            timer.join()
            self.assertEqual(caught.exception.code, "ABORTED")
        finally:
            release.set()

    def test_local_validation_and_invalid_response(self):
        for url in ["https://u:p@host.test", "https://host.test/?key=x", "https://host.test/#x", "file:///x", "http://public.example.com", "https://host.test/api"]:
            with self.assertRaises((ValueError, MailHubError)):
                MailHubClient(url, "key")
        calls = []
        sdk = self.sdk(lambda req, timeout: calls.append(req))
        for target in [{}, {"email": "a@example.test", "vault_id": 1}, {"vault_id": 1, "source": "outlook"}, {"vault_id": True}]:
            with self.assertRaises((ValueError, MailHubError)):
                sdk.lookup_verification(target)
        with self.assertRaises((ValueError, MailHubError)):
            sdk.request("POST", "https://other.test/api/anything", body={})
        with self.assertRaises((ValueError, MailHubError)):
            sdk.reply(1, "..", {"body": "Reply"})
        self.assertEqual(calls, [])
        with self.assertRaises(MailHubError) as caught:
            self.sdk(lambda req, timeout: TransportResponse(200, {"X-Request-ID": "invalid"}, b"not-json")).lookup_verification({"vault_id": 1})
        self.assertEqual((caught.exception.code, caught.exception.request_id), ("INVALID_RESPONSE", "invalid"))

    def test_webhook_bytes_time_signature_and_delivery(self):
        secret, timestamp, subscription = "fictional-Webhook-UTF8-密钥", "1800000000", 5
        raw = json.dumps({"id": "event-中文", "event": "code.extracted", "created_at": "2026-11-15T00:00:00Z", "data": {"code": "123456"}}, ensure_ascii=False, separators=(",", ":")).encode()
        signature = hmac.new(secret.encode(), timestamp.encode() + b"." + raw, hashlib.sha256).hexdigest()
        delivery = hashlib.sha256(json.dumps(["event-中文", subscription], ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
        headers = {"X-MailHub-Timestamp": timestamp, "X-MailHub-Signature": "sha256=" + signature, "X-MailHub-Event": "code.extracted", "X-MailHub-Delivery": delivery}
        kwargs = dict(secret=secret, subscription_id=subscription, now_seconds=int(timestamp))
        verified = verify_webhook(raw, headers, **kwargs)
        self.assertEqual(verified["delivery"], delivery)
        self.assertEqual(verified["payload"]["data"]["code"], "123456")
        for offset in [-301, 301]:
            with self.assertRaises(MailHubError):
                verify_webhook(raw, headers, **dict(kwargs, now_seconds=int(timestamp) + offset))
        for data, changed in [(b" " + raw, headers), (raw, dict(headers, **{"X-MailHub-Delivery": "a" * 64})), (raw, dict(headers, **{"X-MailHub-Event": "mail.received"}))]:
            with self.assertRaises(MailHubError):
                verify_webhook(data, changed, **kwargs)
        with self.assertRaises(MailHubError):
            verify_webhook(raw, headers, **dict(kwargs, subscription_id=6))
        duplicate = Message()
        for name, value in headers.items():
            duplicate[name] = value
        duplicate["x-mailhub-signature"] = headers["X-MailHub-Signature"]
        with self.assertRaises(MailHubError):
            verify_webhook(raw, duplicate, **kwargs)

    def test_http_date_errors_and_transport_redaction(self):
        clock = Clock()
        sdk = self.sdk(lambda req, timeout: response({"error": "RATE_LIMITED", "retry_after": 10}, 429, {"Retry-After": formatdate(clock.time() + 25, usegmt=True)}), clock)
        with self.assertRaises(MailHubError) as caught:
            sdk.lookup_verification({"vault_id": 1})
        self.assertEqual(caught.exception.retry_after, 25)
        calls = []

        def broken(request, timeout):
            calls.append(request)
            raise OSError("Transport leaked fictional-sdk-key")

        with self.assertRaises(MailHubError) as caught:
            self.sdk(broken).register({"platform_name": "Example"})
        self.assertEqual(caught.exception.code, "NETWORK_ERROR")
        self.assertNotIn("fictional-sdk-key", str(caught.exception))
        self.assertEqual(len(calls), 1)
        with self.assertRaises(MailHubError) as caught:
            self.sdk(lambda req, timeout: response({"success": False, "error": "DENIED"})).lookup_verification({"vault_id": 1})
        self.assertEqual(caught.exception.code, "DENIED")

    def test_poll_snapshots_input_link_only_retryable_outage_and_zero_budget(self):
        clock, calls = Clock(), []
        target = {"email": "user@example.test", "since": "2026-11-14T00:00:00Z"}

        def transport(request, timeout):
            calls.append(json.loads(request.data))
            target["email"], target["since"] = "changed@example.test", "2026-11-15T00:00:00Z"
            if len(calls) == 1:
                return response({"error": "UPSTREAM_ERROR", "retryable": True, "retry_after": 15}, 503)
            return response({"success": True, "data": dict(EMPTY, outcome="found", link="https://verify.example.test/confirm")})

        result = self.sdk(transport, clock).wait_for_verification(target)
        self.assertEqual(result["outcome"], "found")
        self.assertNotIn("last_error", result)
        self.assertEqual(result["elapsed_seconds"], 15)
        self.assertEqual(calls, [{"email": "user@example.test", "since": "2026-11-14T00:00:00Z"}] * 2)
        sdk = self.sdk(lambda req, timeout: self.fail("Request must not run"))
        self.assertEqual(sdk.wait_for_verification({"vault_id": 1}, timeout_seconds=0)["attempts"], 0)
        cancelled = threading.Event()
        cancelled.set()
        with self.assertRaises(MailHubError) as caught:
            sdk.wait_for_verification({"vault_id": 1}, cancel_event=cancelled)
        self.assertEqual(caught.exception.code, "ABORTED")
        with self.assertRaises(MailHubError) as caught:
            self.sdk(lambda req, timeout: response({"success": True, "data": dict(EMPTY, outcome="found")})).wait_for_verification({"vault_id": 1})
        self.assertEqual(caught.exception.code, "INVALID_RESPONSE")

    def test_response_limit_and_success_only_envelopes(self):
        with self.assertRaises(MailHubError) as caught:
            self.sdk(lambda req, timeout: TransportResponse(200, {"X-Request-ID": "large"}, b" " * (8 * 1024 * 1024 + 1))).lookup_verification({"vault_id": 1})
        self.assertEqual((caught.exception.code, caught.exception.request_id), ("RESPONSE_TOO_LARGE", "large"))
        result = self.sdk(lambda req, timeout: response({"success": True})).request("DELETE", "/api/example/1")
        self.assertIsNone(result.data)
        result = self.sdk(lambda req, timeout: TransportResponse(204, {}, b"")).request("DELETE", "/api/example/1")
        self.assertEqual(result.status, 204)

    def test_unresponsive_transport_workers_are_bounded(self):
        release, started = threading.Event(), []

        def hung(request, timeout):
            started.append(request)
            release.wait(5)
            return response({"success": True, "data": {}})

        sdk = self.sdk(hung)
        try:
            for _ in range(8):
                with self.assertRaises(MailHubError) as caught:
                    sdk.inspect_mailbox({"vault_id": 1}, timeout_seconds=0.02)
                self.assertEqual(caught.exception.code, "TIMEOUT")
            with self.assertRaises(MailHubError) as caught:
                sdk.inspect_mailbox({"vault_id": 1})
            self.assertEqual(caught.exception.code, "TRANSPORT_BUSY")
            self.assertEqual(len(started), 8)
        finally:
            release.set()

    def test_standard_urllib_wire_headers_redirects_unknown_writes_and_body_timeout(self):
        calls, release = [], threading.Event()

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("Content-Length", "0")))
                calls.append((self.path, body, self.headers))
                if self.path == "/api/external/register":
                    self.send_response(307)
                    self.send_header("X-Request-ID", "redirect-req")
                    self.send_header("Location", "/api/redirect-target")
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                if self.path.endswith("/send"):
                    content = json.dumps({"error": "IDEMPOTENCY_UNKNOWN", "delivery_unknown": True}).encode()
                    self.send_response(409)
                else:
                    content = json.dumps({"success": True, "data": FOUND}).encode()
                    self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("X-Request-ID", "native-req")
                self.send_header("Content-Length", str(len(content)))
                self.end_headers()
                if self.path == "/api/hung":
                    self.wfile.flush()
                    release.wait(5)
                    return
                self.wfile.write(content)

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        worker = threading.Thread(target=lambda: server.serve_forever(poll_interval=0.01), daemon=True)
        worker.start()
        try:
            sdk = MailHubClient(f"http://127.0.0.1:{server.server_port}", "fictional-local-key")
            payload = {"platform": "测试", "since": "2026-11-15T00:00:00Z"}
            sdk.lookup_verification(payload, idempotency_key="explicit-replay")
            sdk.lookup_verification(payload, idempotency_key="explicit-replay")
            self.assertEqual(calls[0][1], calls[1][1])
            self.assertEqual(calls[0][2]["Authorization"], "Bearer fictional-local-key")
            self.assertEqual(calls[0][2]["Idempotency-Key"], "explicit-replay")
            with self.assertRaises(MailHubError) as caught:
                sdk.register({"platform_name": "Example"})
            self.assertEqual((caught.exception.status, caught.exception.request_id), (307, "redirect-req"))
            with self.assertRaises(MailHubError) as caught:
                sdk.send_mail(1, {"to": ["to@example.test"], "subject": "Test", "body": "Test"}, idempotency_key="unknown-send")
            self.assertEqual(caught.exception.code, "IDEMPOTENCY_UNKNOWN")
            self.assertTrue(caught.exception.details["delivery_unknown"])
            with self.assertRaises(MailHubError) as caught:
                sdk.request("POST", "/api/hung", body={}, timeout_seconds=0.1)
            self.assertEqual((caught.exception.code, caught.exception.request_id), ("TIMEOUT", "native-req"))
            self.assertEqual(len(calls), 5)
            self.assertFalse(any(path == "/api/redirect-target" for path, _, _ in calls))
        finally:
            release.set()
            server.shutdown()
            server.server_close()
            worker.join(timeout=1)


if __name__ == "__main__":
    unittest.main()
