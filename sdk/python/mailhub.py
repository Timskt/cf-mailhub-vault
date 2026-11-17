"""MailHub API 2.5.0 client for Python 3.10+. Standard library only.

Requests make exactly one attempt. Only wait_for_verification polls, using a
fixed since timestamp and a deadline of at most 180 seconds.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import math
import queue
import re
import threading
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from types import MappingProxyType
from typing import Any, Callable, Generic, Mapping, Protocol, TypeVar
from urllib.error import HTTPError, URLError
from urllib.parse import quote, unquote, urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

__all__ = [
    "MailHubClient", "MailHubError", "ApiResponse", "TransportResponse",
    "verify_webhook", "WEBHOOK_EVENTS",
]

T = TypeVar("T")
MAX_RESPONSE_BYTES = 8 * 1024 * 1024
MAX_SAFE_INTEGER = 2**53 - 1
WEBHOOK_EVENTS = (
    "mail.received", "code.extracted", "token.renew_failed", "storage.sync_interrupted",
)
_NO_BODY = object()


class MailHubError(Exception):
    """HTTP, protocol, validation or transport error. status=0 means no HTTP status."""

    def __init__(
        self, code: str, message: str, *, status: int = 0, request_id: str = "",
        retry_after: float | None = None, retryable: bool = False,
        details: Mapping[str, Any] | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.status = status
        self.request_id = request_id
        self.retry_after = retry_after
        self.retryable = retryable is True
        self.details = MappingProxyType(dict(details or {}))


@dataclass(frozen=True)
class ApiResponse(Generic[T]):
    data: T
    status: int
    request_id: str
    retry_after: float | None
    idempotency_replayed: bool
    idempotency_key_expires_at: str | None


@dataclass(frozen=True)
class TransportResponse:
    status: int
    headers: Mapping[str, str]
    body: bytes


class Clock(Protocol):
    """Injectable polling clock. Request I/O deadlines always use real time."""

    def monotonic(self) -> float: ...
    def time(self) -> float: ...
    def sleep(self, seconds: float, cancel_event: threading.Event | None = None) -> None: ...


def _invalid(message: str) -> Any:
    raise MailHubError("INVALID_ARGUMENT", message)


def _finite(value: Any, name: str, minimum: float, maximum: float = MAX_SAFE_INTEGER) -> float:
    if (
        isinstance(value, bool) or not isinstance(value, (float, int))
        or not math.isfinite(value) or not minimum <= value <= maximum
    ):
        _invalid(f"{name} is outside its supported range")
    return float(value)


def _id(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= MAX_SAFE_INTEGER:
        _invalid("account/vault ID must be a positive safe integer")
    return value


def _iso(value: Any) -> str:
    if (
        not isinstance(value, str) or len(value) > 40
        or not re.match(r"^\d{4}-\d\d-\d\dT", value, flags=re.ASCII)
        or not re.search(r"(?:Z|[+-]\d\d:\d\d)$", value, flags=re.ASCII)
    ):
        _invalid("since must be an ISO 8601 timestamp with timezone")
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        _invalid("since must be an ISO 8601 timestamp with timezone")
    return value


def _target(value: Any) -> None:
    if not isinstance(value, dict) or sum(k in value for k in ("email", "vault_id", "platform")) != 1:
        _invalid("Provide exactly one of email, vault_id or platform")
    if "vault_id" in value:
        _id(value["vault_id"])
    if "email" in value and (
        not isinstance(value["email"], str) or len(value["email"]) > 254
        or not re.fullmatch(r"[^\s@<>\"']+@[^\s@<>\"']+\.[^\s@<>\"']+", value["email"])
    ):
        _invalid("email is invalid")
    if "platform" in value and (
        not isinstance(value["platform"], str) or not value["platform"].strip()
        or len(value["platform"]) > 100
    ):
        _invalid("platform is invalid")
    if "source" in value and ("email" not in value or value["source"] not in ("outlook", "cf_domain", "mailtm", "mailgw")):
        _invalid("source requires an email target and must be outlook, cf_domain, mailtm or mailgw")


def _verification_input(value: Any) -> None:
    _target(value)
    if "match" in value and value["match"] not in ("mailbox", "platform"):
        _invalid("match must be mailbox or platform")
    if value.get("match") == "platform" and "email" in value:
        _invalid("match=platform requires vault_id or platform")
    if "since" in value:
        _iso(value["since"])
    for key, maximum in (("sender", 254), ("q", 200)):
        if key in value and (not isinstance(value[key], str) or len(value[key]) > maximum):
            _invalid(f"{key} is invalid")


def _headers(headers: Mapping[str, str]) -> dict[str, str]:
    # HTTPMessage.items() includes duplicate header fields. Never accept ambiguous
    # signatures or delivery IDs even when they have different capitalization.
    result: dict[str, str] = {}
    for key, value in headers.items():
        if not isinstance(key, str) or not isinstance(value, str):
            raise MailHubError("INVALID_RESPONSE", "Invalid HTTP headers")
        key = key.lower()
        result[key] = result[key] + ", " + value if key in result else value
    return result


def _retry_after(header: str | None, body: Any, now: float) -> float | None:
    values: list[float] = []
    if isinstance(body, (float, int)) and not isinstance(body, bool) and math.isfinite(body) and body >= 0:
        values.append(float(body))
    if header:
        try:
            if re.fullmatch(r"\d+(?:\.\d+)?", header.strip(), flags=re.ASCII):
                values.append(float(header.strip()))
            else:
                date = parsedate_to_datetime(header)
                if date.tzinfo is not None:
                    values.append(max(0, date.timestamp() - now))
        except (ValueError, OverflowError, TypeError):
            pass
    valid = [v for v in values if math.isfinite(v)]
    return max(valid) if valid else None


def _cancelled(cancel_event: threading.Event | None) -> None:
    if cancel_event is not None and cancel_event.is_set():
        raise MailHubError("ABORTED", "Request cancelled; a submitted mutation may still complete")


class _SystemClock:
    monotonic = staticmethod(time.monotonic)
    time = staticmethod(time.time)

    @staticmethod
    def sleep(seconds: float, cancel_event: threading.Event | None = None) -> None:
        if cancel_event is None:
            time.sleep(seconds)
        elif cancel_event.wait(seconds):
            _cancelled(cancel_event)


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _urllib_transport(
    request: Request, timeout: float, remember: Callable[[int, Mapping[str, str]], None],
) -> TransportResponse:
    # A private opener avoids process-global authentication/retry handlers. Standard
    # TLS verification and standard proxy environment variables remain supported.
    opener = build_opener(_NoRedirect())
    try:
        response = opener.open(request, timeout=timeout)
    except HTTPError as error:
        response = error  # HTTP failures still have a useful body and request ID.
    with response:
        remember(response.status, response.headers)
        body = response.read(MAX_RESPONSE_BYTES + 1)
        if len(body) > MAX_RESPONSE_BYTES:
            raise MailHubError("RESPONSE_TOO_LARGE", "JSON response exceeds 8 MiB")
        return TransportResponse(response.status, _headers(response.headers), body)


class MailHubClient:
    """Synchronous API-key client. Redirects and automatic write retries are disabled.

    A maximum of eight transport workers may be alive per client. A caller timeout
    or cancellation stops waiting immediately; a blocking OS/transport operation
    can finish later. A timed-out write can still succeed on the server.
    """

    def __init__(
        self, base_url: str, api_key: str, *, timeout_seconds: float = 30,
        transport: Callable[[Request, float], TransportResponse] | None = None,
        clock: Clock | None = None,
    ) -> None:
        if not isinstance(base_url, str) or re.search(r"[\x00-\x20\x7f\\]", base_url):
            _invalid("base_url must be an HTTPS origin")
        try:
            url = urlsplit(base_url)
            port = url.port
        except ValueError:
            _invalid("base_url must be an HTTPS origin")
        if (
            url.scheme not in ("http", "https") or not url.hostname
            or url.username is not None or url.password is not None
            or url.path not in ("", "/") or "?" in base_url or "#" in base_url
            or url.scheme == "http" and url.hostname not in ("localhost", "127.0.0.1", "::1")
            or port is not None and port < 1
        ):
            _invalid("base_url must be an HTTPS origin (HTTP is allowed only on loopback)")
        if not isinstance(api_key, str) or not re.fullmatch(r"[!-~]+", api_key) or "," in api_key:
            _invalid("api_key must be a nonempty header-safe ASCII string")
        self.__base = f"{url.scheme}://{url.netloc}"
        self.__api_key = api_key
        self.__timeout = _finite(timeout_seconds, "timeout_seconds", 0.001, 180)
        self.__transport = transport
        self.__clock = clock if clock is not None else _SystemClock()
        self.__slots = threading.BoundedSemaphore(8)

    def request(
        self, method: str, path: str, *, body: Any = _NO_BODY,
        query: Mapping[str, str | int | float | bool | None] | None = None,
        idempotency_key: str | None = None, timeout_seconds: float | None = None,
        cancel_event: threading.Event | None = None,
    ) -> ApiResponse[Any]:
        if method not in ("GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"):
            _invalid("Unsupported HTTP method")
        if (
            not isinstance(path, str) or not path.startswith("/api/")
            or re.search(r"[?#\\\x00-\x20\x7f]", path)
            or re.search(r"%(?![0-9a-fA-F]{2})", path)
        ):
            _invalid("path must be a local /api/ path; use query for query parameters")
        try:
            decoded = [unquote(part, errors="strict") for part in path.split("/")]
        except UnicodeDecodeError:
            _invalid("Invalid encoded path")
        if any(part in (".", "..") for part in decoded):
            _invalid("Dot path segments are not supported")
        if not path.isascii():
            _invalid("Encode non-ASCII path segments with urllib.parse.quote")
        url = self.__base + path
        if query:
            values = {k: str(v).lower() if isinstance(v, bool) else v for k, v in query.items() if v is not None}
            if values:
                url += "?" + urlencode(values)
        headers = {"Authorization": f"Bearer {self.__api_key}", "Accept": "application/json", "Cache-Control": "no-store"}
        if idempotency_key is not None:
            if not isinstance(idempotency_key, str) or not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}", idempotency_key):
                _invalid("Invalid Idempotency-Key")
            if method in ("GET", "HEAD"):
                _invalid("Idempotency-Key is supported only for mutations")
            headers["Idempotency-Key"] = idempotency_key
        encoded = None
        if body is not _NO_BODY:
            if method in ("GET", "HEAD"):
                _invalid("GET/HEAD requests cannot have a JSON body")
            try:
                encoded = json.dumps(body, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
            except (ValueError, TypeError, UnicodeError):
                _invalid("Request body must be JSON serializable")
            headers["Content-Type"] = "application/json"
        timeout = _finite(self.__timeout if timeout_seconds is None else timeout_seconds, "timeout_seconds", 0.001, 180)
        _cancelled(cancel_event)
        request = Request(url, data=encoded, headers=headers, method=method)
        deadline = time.monotonic() + timeout
        if not self.__slots.acquire(blocking=False):
            raise MailHubError("TRANSPORT_BUSY", "Eight transport operations are still active; no request was submitted")
        result: queue.Queue[ApiResponse[Any] | MailHubError] = queue.Queue(maxsize=1)
        lock = threading.Lock()
        metadata: dict[str, Any] = {"status": 0, "request_id": "", "retry_after": None}

        def remember(status: int, incoming: Mapping[str, str]) -> None:
            response_headers = _headers(incoming)
            with lock:
                metadata.update(
                    status=status, request_id=response_headers.get("x-request-id", ""),
                    retry_after=_retry_after(response_headers.get("retry-after"), None, self.__clock.time()),
                )

        def error(code: str, message: str) -> MailHubError:
            with lock:
                return MailHubError(code, message, **metadata)

        def run() -> None:
            try:
                _cancelled(cancel_event)
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise error("TIMEOUT", "Request deadline exceeded before transport started")
                response = (
                    self.__transport(request, remaining) if self.__transport is not None
                    else _urllib_transport(request, remaining, remember)
                )
                if (
                    not isinstance(response, TransportResponse) or isinstance(response.status, bool)
                    or not isinstance(response.status, int) or not 100 <= response.status <= 599
                    or not isinstance(response.body, bytes)
                ):
                    raise error("INVALID_RESPONSE", "Invalid transport response")
                remember(response.status, response.headers)
                if len(response.body) > MAX_RESPONSE_BYTES:
                    raise error("RESPONSE_TOO_LARGE", "JSON response exceeds 8 MiB")
                result.put(self.__decode(response, method))
            except MailHubError as failure:
                if failure.status == 0:
                    with lock:
                        failure.status = metadata["status"]
                        failure.request_id = failure.request_id or metadata["request_id"]
                        if failure.retry_after is None:
                            failure.retry_after = metadata["retry_after"]
                result.put(failure)
            except Exception as failure:
                timed_out = isinstance(failure, TimeoutError) or isinstance(failure, URLError) and isinstance(failure.reason, TimeoutError)
                code = "TIMEOUT" if timed_out or time.monotonic() >= deadline else "NETWORK_ERROR"
                # Do not expose URLs, credentials or body text from transport exceptions.
                result.put(error(code, "Transport failed; a submitted mutation may still complete"))
            finally:
                self.__slots.release()

        worker = threading.Thread(target=run, name="mailhub-request", daemon=True)
        try:
            worker.start()
        except RuntimeError:
            self.__slots.release()
            raise error("TRANSPORT_BUSY", "Cannot start transport; no request was submitted") from None
        while True:
            if cancel_event is not None and cancel_event.is_set():
                raise error("ABORTED", "Request cancelled; a submitted mutation may still complete")
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise error("TIMEOUT", "Request deadline exceeded; a submitted mutation may still complete")
            try:
                value = result.get(timeout=min(remaining, 0.01))
            except queue.Empty:
                continue
            if cancel_event is not None and cancel_event.is_set():
                raise error("ABORTED", "Request cancelled; a submitted mutation may still complete")
            if time.monotonic() >= deadline:
                raise error("TIMEOUT", "Request deadline exceeded; a submitted mutation may still complete")
            if isinstance(value, MailHubError):
                raise value from None
            return value

    def __decode(self, response: TransportResponse, method: str) -> ApiResponse[Any]:
        headers = _headers(response.headers)
        request_id = headers.get("x-request-id", "")
        ok = 200 <= response.status < 300
        try:
            payload = (
                {"success": True} if not response.body and ok and (method == "HEAD" or response.status in (204, 205))
                else json.loads(response.body.decode("utf-8-sig"))
            )
        except (ValueError, UnicodeError):
            raise MailHubError(
                "INVALID_RESPONSE" if ok else f"HTTP_{response.status}", "The server returned a non-JSON response",
                status=response.status, request_id=request_id,
                retry_after=_retry_after(headers.get("retry-after"), None, self.__clock.time()),
            ) from None
        record = payload if isinstance(payload, dict) else {}
        if not request_id and isinstance(record.get("request_id"), str):
            request_id = record["request_id"]
        delay = _retry_after(headers.get("retry-after"), record.get("retry_after"), self.__clock.time())
        if not ok or record.get("success") is False:
            raise MailHubError(
                record["error"] if isinstance(record.get("error"), str) else f"HTTP_{response.status}",
                record["message"] if isinstance(record.get("message"), str) else "MailHub request failed",
                status=response.status, request_id=request_id, retry_after=delay,
                retryable=record.get("retryable") is True, details=record,
            )
        if record.get("success") is not True:
            raise MailHubError("INVALID_RESPONSE", "Expected a success JSON envelope", status=response.status, request_id=request_id)
        return ApiResponse(
            record.get("data"), response.status, request_id, delay,
            headers.get("idempotency-replayed") == "true", headers.get("idempotency-key-expires-at"),
        )

    def inspect_mailbox(self, target: dict[str, Any], **options: Any) -> ApiResponse[dict[str, Any]]:
        _target(target)
        return self.request("POST", "/api/automation/mailbox", body=target, **options)

    def lookup_verification(self, target: dict[str, Any], **options: Any) -> ApiResponse[dict[str, Any]]:
        _verification_input(target)
        return self.request("POST", "/api/automation/verification", body=target, **options)

    def register(self, registration: dict[str, Any], **options: Any) -> ApiResponse[dict[str, Any]]:
        return self.request("POST", "/api/external/register", body=registration, **options)

    def send_mail(self, account_id: int, mail: dict[str, Any], **options: Any) -> ApiResponse[dict[str, Any]]:
        return self.request("POST", f"/api/outlook/accounts/{_id(account_id)}/send", body=mail, **options)

    def reply(self, account_id: int, message_id: str, mail: dict[str, Any], **options: Any) -> ApiResponse[dict[str, Any]]:
        if (
            not isinstance(message_id, str) or not message_id or len(message_id) > 2048
            or message_id in (".", "..") or re.search(r"[\x00-\x1f\x7f]", message_id)
        ):
            _invalid("message_id must be a nonempty opaque message ID")
        try:
            encoded_id = quote(message_id, safe="")
        except UnicodeError:
            _invalid("message_id must be valid UTF-8")
        return self.request("POST", f"/api/outlook/accounts/{_id(account_id)}/messages/{encoded_id}/reply", body=mail, **options)

    def wait_for_verification(
        self, target: dict[str, Any], *, timeout_seconds: float = 180,
        interval_seconds: float = 10, cancel_event: threading.Event | None = None,
    ) -> dict[str, Any]:
        _verification_input(target)
        _cancelled(cancel_event)
        seconds = min(180, _finite(timeout_seconds, "timeout_seconds", 0))
        interval = _finite(interval_seconds, "interval_seconds", 1, 180)
        started = self.__clock.monotonic()
        deadline = started + seconds
        since = target.get("since") or datetime.fromtimestamp(self.__clock.time(), timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        query = dict(target, since=since)
        attempts, request_id, last_error = 0, "", None

        def result() -> dict[str, Any]:
            metadata = dict(since=since, attempts=attempts, elapsed_seconds=max(0, self.__clock.monotonic() - started), request_id=request_id)
            if last_error is not None:
                metadata["last_error"] = last_error
            return metadata

        while self.__clock.monotonic() < deadline:
            _cancelled(cancel_event)
            remaining = deadline - self.__clock.monotonic()
            if remaining < 0.001:
                break
            delay = interval
            try:
                attempts += 1
                response = self.lookup_verification(query, timeout_seconds=min(self.__timeout, remaining), cancel_event=cancel_event)
                request_id, data = response.request_id, response.data
                if (
                    not isinstance(data, dict) or data.get("outcome") not in ("found", "empty")
                    or not isinstance(data.get("code"), str) or not isinstance(data.get("link"), str)
                    or data["outcome"] == "found" and not data["code"] and not data["link"]
                ):
                    raise MailHubError("INVALID_RESPONSE", "Invalid verification result", status=response.status, request_id=request_id)
                if self.__clock.monotonic() >= deadline:
                    break
                last_error = None
                if data["outcome"] == "found":
                    return dict(result(), outcome="found", data=data)
                poll_after = data.get("poll_after_seconds")
                if isinstance(poll_after, (float, int)) and not isinstance(poll_after, bool) and math.isfinite(poll_after) and poll_after >= 0:
                    delay = max(delay, poll_after)
                delay = max(delay, response.retry_after or 0)
            except MailHubError as error:
                last_error, request_id = error, error.request_id
                if error.code == "TIMEOUT":
                    break
                if not (error.status == 429 or error.retryable and (error.status in (408, 425) or error.status >= 500)):
                    raise
                delay = max(delay, error.retry_after or 0)
            _cancelled(cancel_event)
            if delay >= deadline - self.__clock.monotonic():
                break
            self.__clock.sleep(delay, cancel_event)
        _cancelled(cancel_event)
        return dict(result(), outcome="timeout", data=None)


def verify_webhook(
    raw_body: bytes, headers: Mapping[str, str], *, secret: str, subscription_id: int,
    now_seconds: float | None = None, tolerance_seconds: float = 300,
) -> dict[str, Any]:
    """Authenticate raw bytes. The receiver must persistently deduplicate delivery/hash."""
    if not isinstance(secret, str) or not secret:
        _invalid("Invalid webhook receiver configuration")
    _id(subscription_id)
    tolerance = _finite(tolerance_seconds, "tolerance_seconds", 0, 300)
    now = _finite(time.time() if now_seconds is None else now_seconds, "now_seconds", 0)

    def fail(code: str) -> Any:
        raise MailHubError(code, "Webhook authentication failed")

    if not isinstance(raw_body, bytes) or len(raw_body) > 65536:
        fail("INVALID_BODY")
    incoming = _headers(headers)
    timestamp = incoming.get("x-mailhub-timestamp", "")
    signature = incoming.get("x-mailhub-signature", "")
    if not re.fullmatch(r"[0-9]{1,12}", timestamp) or abs(now - int(timestamp)) > tolerance:
        fail("STALE_TIMESTAMP")
    if not re.fullmatch(r"sha256=[a-f0-9]{64}", signature):
        fail("INVALID_SIGNATURE")
    try:
        expected = hmac.new(secret.encode("utf-8"), timestamp.encode("ascii") + b"." + raw_body, hashlib.sha256).hexdigest()
    except UnicodeError:
        _invalid("secret must be valid UTF-8")
    if not hmac.compare_digest(signature[7:], expected):
        fail("INVALID_SIGNATURE")
    try:
        payload = json.loads(raw_body.decode("utf-8"))
        if (
            not isinstance(payload, dict) or not isinstance(payload.get("id"), str) or not payload["id"]
            or payload.get("event") not in WEBHOOK_EVENTS or not isinstance(payload.get("data"), dict)
            or not isinstance(payload.get("created_at"), str)
        ):
            fail("INVALID_EVENT")
        datetime.fromisoformat(payload["created_at"].replace("Z", "+00:00"))
        delivery_bytes = json.dumps([payload["id"], subscription_id], ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    except (ValueError, TypeError, UnicodeError):
        fail("INVALID_EVENT")
    if incoming.get("x-mailhub-event") != payload["event"]:
        fail("EVENT_MISMATCH")
    delivery = incoming.get("x-mailhub-delivery", "")
    if not re.fullmatch(r"[a-f0-9]{64}", delivery) or not hmac.compare_digest(delivery, hashlib.sha256(delivery_bytes).hexdigest()):
        fail("DELIVERY_MISMATCH")
    return {"delivery": delivery, "payload": payload, "hash": hashlib.sha256(raw_body).hexdigest()}
