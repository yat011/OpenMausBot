#!/usr/bin/env python3
"""Signal inbound: wake 私人AI via OpenMausBot loopback webhook (no auto ack).

Listens on the signal-cli JSON-RPC UNIX socket. DMs require a trusted
sender (CEO / 太太) and a listed chat. Whitelisted groups forward any
member so they can @ or speak to 私人AI. Each Signal chat reuses one
OpenMausBot thread via X-Omb-Thread-Key / X-Omb-Thread-Title.
Does not POST to Grok :1340. Does not call api2.cursor.sh.
"""
from __future__ import annotations

import fcntl
import json
import os
import re
import socket
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path("/home/box/signal")
LOG_PATH = ROOT / "logs" / "bridge.log"
SPOOL_DIR = ROOT / "inbox-spool"
CLAIM_DIR = SPOOL_DIR / "claimed"
LOCK_PATH = ROOT / "logs" / "bridge.lock"
WEBHOOK_ENV_PATH = ROOT / "config" / "openmaus-webhook.env"
WHITELIST_PATH = ROOT / "config" / "wake-whitelist.json"
DEFAULT_SOCKET = str(ROOT / "signal.sock")
ATTACH_DIR = ROOT / "attachments"
_SAFE_ATTACH_ID = re.compile(r"^[A-Za-z0-9._-]{1,80}$")
_IMAGE_EXT = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
}

ACCOUNT = "+85295030073"
TRUSTED_DEFAULT = "+447999003749"
TRUSTED_PHONES = frozenset({"+447999003749", "+447763781105"})
UUID_TO_PHONE = {
    "6ac6665b-1959-4008-8b1f-3f19573cd847": "+447999003749",
    "1c3eba2e-867f-4323-967c-38e665708ef2": "+447999003749",
    "1ba6de0e-309a-490d-9edb-32716c42f528": "+447763781105",
    "bed01050-3805-4cff-85cf-066975d89a8d": "+447763781105",
}
ACK_TEXT = "收到"
DEDUP_SEC = 8.0
WAKE_RETRIES = 4

_last_post: dict[str, float] = {}
_lock_fd: object | None = None
_whitelist_mtime: float | None = None
_whitelist_enabled = True
_whitelist_ok = False
_whitelist_dms: dict[str, str] = {}
_whitelist_groups: dict[str, str] = {}


def log(msg: str) -> None:
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    line = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()) + " " + msg
    with LOG_PATH.open("a", encoding="utf-8") as f:
        f.write(line + "\n")
    print(line, flush=True)


def sanitize_thread_title(value: str) -> str:
    cleaned = "".join(ch if ch >= " " else " " for ch in value).strip()
    return cleaned[:80]


def http_header_value(value: str) -> str:
    """urllib headers are latin-1; keep UTF-8 titles (e.g. SG: 自由谷) as bytes."""
    try:
        value.encode("latin-1")
        return value
    except UnicodeEncodeError:
        return value.encode("utf-8").decode("latin-1")


def acquire_singleton() -> None:
    global _lock_fd
    LOCK_PATH.parent.mkdir(parents=True, exist_ok=True)
    lock_file = open(LOCK_PATH, "a+", encoding="utf-8")
    try:
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        log("another signal bridge holds lock; exiting")
        lock_file.close()
        sys.exit(0)
    lock_file.seek(0)
    lock_file.truncate()
    lock_file.write(str(os.getpid()))
    lock_file.flush()
    os.chmod(LOCK_PATH, 0o600)
    _lock_fd = lock_file


def claim_msgid(mid: str) -> bool:
    if not mid:
        return False
    CLAIM_DIR.mkdir(parents=True, exist_ok=True)
    safe = mid.replace("/", "_").replace("..", "_")[:200]
    path = CLAIM_DIR / safe
    try:
        fd = os.open(str(path), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        try:
            os.write(fd, f"{os.getpid()} {time.time()}\n".encode())
        finally:
            os.close(fd)
        return True
    except FileExistsError:
        return False


def unclaim_msgid(mid: str) -> None:
    if not mid:
        return
    safe = mid.replace("/", "_").replace("..", "_")[:200]
    try:
        (CLAIM_DIR / safe).unlink()
    except FileNotFoundError:
        pass


def _parse_whitelist(raw: dict[str, object]) -> tuple[bool, dict[str, str], dict[str, str]]:
    enabled = raw.get("enabled", True)
    if enabled is False:
        return False, {}, {}
    dms: dict[str, str] = {}
    groups: dict[str, str] = {}
    for item in raw.get("chats") or []:
        if not isinstance(item, dict):
            continue
        kind = str(item.get("kind") or "").strip().lower()
        explicit = str(item.get("thread") or "").strip()
        name = str(item.get("name") or "").strip()
        if kind == "dm":
            phone = str(item.get("phone") or "").strip()
            if not phone:
                continue
            title = sanitize_thread_title(explicit or (f"SG: {name}" if name else f"SG: {phone}"))
            dms[phone] = title
        elif kind == "group":
            gid = str(item.get("group_id") or item.get("groupId") or "").strip()
            if not gid:
                continue
            title = sanitize_thread_title(explicit or (f"SG: {name}" if name else "SG: group"))
            groups[gid] = title
    return True, dms, groups


def load_whitelist(force: bool = False) -> tuple[bool, dict[str, str], dict[str, str], bool]:
    """Return (enabled, dms, groups, loaded_ok). Reloads when the file mtime changes."""
    global _whitelist_mtime, _whitelist_enabled, _whitelist_ok
    global _whitelist_dms, _whitelist_groups
    try:
        mtime = WHITELIST_PATH.stat().st_mtime
    except FileNotFoundError:
        if force or _whitelist_ok:
            log(f"whitelist missing {WHITELIST_PATH}; fail-closed")
        _whitelist_mtime = None
        _whitelist_enabled = True
        _whitelist_dms = {}
        _whitelist_groups = {}
        _whitelist_ok = False
        return True, {}, {}, False
    if not force and _whitelist_ok and mtime == _whitelist_mtime:
        return _whitelist_enabled, _whitelist_dms, _whitelist_groups, True
    try:
        raw = json.loads(WHITELIST_PATH.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            raise ValueError("whitelist root must be an object")
        enabled, dms, groups = _parse_whitelist(raw)
    except Exception as exc:
        log(f"whitelist load err: {exc}; fail-closed")
        _whitelist_mtime = mtime
        _whitelist_enabled = True
        _whitelist_dms = {}
        _whitelist_groups = {}
        _whitelist_ok = False
        return True, {}, {}, False
    _whitelist_mtime = mtime
    _whitelist_enabled = enabled
    _whitelist_dms = dms
    _whitelist_groups = groups
    _whitelist_ok = True
    log(f"whitelist loaded enabled={enabled} dms={len(dms)} groups={len(groups)}")
    return enabled, dms, groups, True


def sender_phone(inbound: dict[str, object]) -> str | None:
    sender = str(inbound.get("sender") or "")
    sender_uuid = str(inbound.get("sender_uuid") or "")
    uid = sender_uuid.lower() if sender_uuid else ""
    if sender.lower().startswith("uuid:"):
        uid = sender[5:].lower()
    elif sender and "@" not in sender and not sender.startswith("+") and len(sender) == 36:
        uid = sender.lower()
    if sender.startswith("+"):
        return sender
    return UUID_TO_PHONE.get(uid)


def is_trusted(inbound: dict[str, object]) -> bool:
    sender = str(inbound.get("sender") or "")
    phone = sender_phone(inbound)
    sender_uuid = str(inbound.get("sender_uuid") or "").lower()
    return (
        (phone in TRUSTED_PHONES)
        or (sender_uuid in UUID_TO_PHONE)
        or (sender in TRUSTED_PHONES)
    )


def is_whitelisted_chat(inbound: dict[str, object]) -> bool:
    enabled, dms, groups, _ok = load_whitelist()
    if not enabled:
        return True
    gid = str(inbound.get("group_id") or "").strip()
    if gid:
        return gid in groups
    phone = sender_phone(inbound) or ""
    return phone in dms


def should_wake(inbound: dict[str, object]) -> tuple[bool, str]:
    """DMs: trusted sender + listed chat. Groups: listed chat, any member."""
    gid = str(inbound.get("group_id") or "").strip()
    if gid:
        if not is_whitelisted_chat(inbound):
            return False, "dropping unknown chat (not in wake-whitelist)"
        return True, ""
    if not is_trusted(inbound):
        return False, "dropping untrusted sender (DM)"
    if not is_whitelisted_chat(inbound):
        return False, "dropping unknown chat (not in wake-whitelist)"
    return True, ""


def thread_title_for(inbound: dict[str, object]) -> str:
    load_whitelist()
    gid = str(inbound.get("group_id") or "").strip()
    if gid:
        mapped = _whitelist_groups.get(gid, "")
        if mapped:
            return mapped
        return sanitize_thread_title(f"SG: {gid[:12]}")
    phone = sender_phone(inbound) or str(inbound.get("sender") or "chat")
    mapped = _whitelist_dms.get(phone, "")
    if mapped:
        return mapped
    return sanitize_thread_title(f"SG: {phone}")


def thread_key_for(inbound: dict[str, object]) -> str:
    gid = str(inbound.get("group_id") or "").strip()
    if gid:
        return f"sg:group:{gid}"[:200]
    phone = sender_phone(inbound) or str(inbound.get("sender") or "unknown")
    return f"sg:dm:{phone}"[:200]


def _is_image_type(content_type: str) -> bool:
    return content_type.lower().split(";", 1)[0].strip().startswith("image/")


def resolve_attachment_path(att: dict[str, object]) -> Path | None:
    """Map a signal-cli attachment object to the on-disk file, if present."""
    aid = str(att.get("id") or "").strip()
    filename = Path(str(att.get("filename") or "").strip()).name
    ctype = str(att.get("contentType") or "").lower().split(";", 1)[0].strip()
    candidates: list[Path] = []
    if aid and _SAFE_ATTACH_ID.match(aid):
        candidates.append(ATTACH_DIR / aid)
        ext = _IMAGE_EXT.get(ctype, "")
        if ext:
            candidates.append(ATTACH_DIR / f"{aid}{ext}")
        else:
            suffix = Path(filename).suffix.lower() if filename else ""
            if suffix in {".jpg", ".jpeg", ".png", ".gif", ".webp"}:
                candidates.append(ATTACH_DIR / f"{aid}{suffix if suffix != '.jpeg' else '.jpg'}")
    if filename and ".." not in filename:
        candidates.append(ATTACH_DIR / filename)
    seen: set[str] = set()
    for path in candidates:
        key = str(path)
        if key in seen:
            continue
        seen.add(key)
        try:
            if path.is_file() and path.stat().st_size > 0:
                return path
        except OSError:
            continue
    if aid and _SAFE_ATTACH_ID.match(aid):
        try:
            matches = [p for p in ATTACH_DIR.glob(f"{aid}.*") if p.is_file() and p.stat().st_size > 0]
        except OSError:
            matches = []
        if len(matches) == 1:
            return matches[0]
    return None


def summarize_attachments(raw: object) -> list[dict[str, object]]:
    if not isinstance(raw, list):
        return []
    out: list[dict[str, object]] = []
    for item in raw[:8]:
        if not isinstance(item, dict):
            continue
        ctype = str(item.get("contentType") or "")
        filename = str(item.get("filename") or "")
        path = resolve_attachment_path(item)
        out.append(
            {
                "id": str(item.get("id") or ""),
                "contentType": ctype,
                "filename": filename,
                "path": str(path) if path else "",
                "is_image": _is_image_type(ctype) or (bool(path) and path.suffix.lower() in {".jpg", ".jpeg", ".png", ".gif", ".webp"}),
            }
        )
    return out


def extract_inbound(obj: dict[str, object]) -> dict[str, object] | None:
    params: object = obj.get("params") if isinstance(obj, dict) else None
    if params is None and isinstance(obj, dict) and "envelope" in obj:
        params = obj
    if not isinstance(params, dict):
        return None
    envelope = params.get("envelope") or params.get("result") or params
    if not isinstance(envelope, dict):
        return None
    data = envelope.get("dataMessage")
    if not isinstance(data, dict):
        sync = envelope.get("syncMessage") or {}
        data = sync.get("sentMessage") if isinstance(sync, dict) else None
    if not isinstance(data, dict):
        edit = envelope.get("editMessage") or {}
        data = edit.get("dataMessage") if isinstance(edit, dict) else None
    if not isinstance(data, dict):
        return None
    text = data.get("message")
    if text is None:
        text = ""
    sender = (
        envelope.get("sourceNumber")
        or envelope.get("source")
        or (envelope.get("sourceUuid") and f"uuid:{envelope.get('sourceUuid')}")
    )
    group_info = data.get("groupInfo") if isinstance(data.get("groupInfo"), dict) else {}
    group_id = (
        (group_info.get("groupId") if isinstance(group_info, dict) else None)
        or (group_info.get("id") if isinstance(group_info, dict) else None)
        or data.get("groupId")
    )
    mentions = data.get("mentions") if isinstance(data.get("mentions"), list) else []
    attachments = summarize_attachments(data.get("attachments"))
    images = [a["path"] for a in attachments if a.get("is_image") and a.get("path")]
    return {
        "source": "signal-cli",
        "account": ACCOUNT,
        "sender": sender,
        "sender_uuid": envelope.get("sourceUuid"),
        "timestamp": envelope.get("timestamp") or data.get("timestamp"),
        "message": text,
        "group_id": group_id,
        "mentions": mentions,
        "attachments": attachments,
        "images": images,
        "has_image": bool(images),
    }


def should_handle(dedupe_key: str) -> bool:
    now = time.time()
    prev = _last_post.get(dedupe_key, 0)
    if now - prev < DEDUP_SEC:
        log(f"dedupe skip {dedupe_key!r}")
        return False
    _last_post[dedupe_key] = now
    return True


def load_omb_webhook() -> dict[str, str]:
    env: dict[str, str] = {}
    for raw in WEBHOOK_ENV_PATH.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        env[key.strip()] = value.strip().strip('"').strip("'")
    url = env.get("OMB_WEBHOOK_URL")
    secret = env.get("OMB_WEBHOOK_SECRET")
    if not url or not secret:
        raise RuntimeError("openmaus-webhook.env missing OMB_WEBHOOK_URL or OMB_WEBHOOK_SECRET")
    return {"url": url, "secret": secret}


def write_spool(inbound: dict[str, object], mid: str) -> Path:
    SPOOL_DIR.mkdir(parents=True, exist_ok=True)
    sender = str(inbound.get("sender") or "unknown").replace("/", "_")
    spool_path = SPOOL_DIR / f"{mid}_{sender}.json"
    payload = {
        **inbound,
        "BridgeAcked": False,
        "WakeVia": "omb-webhook",
    }
    spool_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    os.chmod(spool_path, 0o600)
    return spool_path


def wake_local(inbound: dict[str, object], spool_path: Path) -> bool:
    """Wake 私人AI via OpenMausBot loopback webhook. No auto Signal ack."""
    sender = str(inbound.get("sender") or "")
    phone = sender_phone(inbound) or ""
    text = str(inbound.get("message") or "").strip()
    ts = inbound.get("timestamp") or ""
    mid = str(ts)
    gid = str(inbound.get("group_id") or "")
    chat = gid if gid else phone or sender
    kind = "group" if gid else "dm"

    if not claim_msgid(mid):
        log(f"skip duplicate wake id={mid}")
        return False

    images = [p for p in (inbound.get("images") or []) if isinstance(p, str) and p]
    payload: dict[str, object] = {
        "Chat": chat,
        "ChatName": thread_title_for(inbound),
        "Kind": kind,
        "GroupId": gid,
        "ID": mid,
        "Sender": sender,
        "SenderPhone": phone,
        "SenderUuid": inbound.get("sender_uuid") or "",
        "Timestamp": ts,
        "Text": text,
        "Mentions": inbound.get("mentions") or [],
        "HasImage": bool(inbound.get("has_image") or images),
        "Images": images,
        "Attachments": inbound.get("attachments") or [],
        "Spool": str(spool_path),
        "WakeVia": "omb-webhook",
        "Account": ACCOUNT,
    }

    last_err = ""
    for attempt in range(1, WAKE_RETRIES + 1):
        try:
            hook = load_omb_webhook()
            body = json.dumps(payload, ensure_ascii=False).encode()
            req = urllib.request.Request(
                hook["url"],
                data=body,
                method="POST",
                headers={
                    "Authorization": f"Bearer {hook['secret']}",
                    "Content-Type": "application/json",
                    "Idempotency-Key": mid[:200],
                    "User-Agent": "signal-local-gateway-bridge/2.0-omb-webhook",
                    "X-Webhook-Event": "signal.inbound",
                    "X-Omb-Thread-Title": http_header_value(thread_title_for(inbound)),
                    "X-Omb-Thread-Key": thread_key_for(inbound),
                },
            )
            with urllib.request.urlopen(req, timeout=30) as resp:
                raw = resp.read()[:300]
                log(f"omb wake ok id={mid} status={resp.status} body={raw!r}")
                return True
        except urllib.error.HTTPError as exc:
            err_body = exc.read()[:300]
            last_err = f"http {exc.code}: {err_body!r}"
            log(f"omb wake {last_err} id={mid} attempt={attempt}")
            if exc.code != 429 or attempt == WAKE_RETRIES:
                break
            time.sleep(min(2 ** attempt, 16))
        except Exception as exc:
            last_err = str(exc)
            log(f"omb wake err id={mid} attempt={attempt}: {exc}")
            break
    unclaim_msgid(mid)
    log(f"omb wake failed id={mid} last={last_err}")
    return False


def connect_socket(path: str) -> socket.socket:
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.connect(path)
    sock.settimeout(60)
    return sock


def main() -> int:
    sock_path = os.environ.get("SIGNAL_SOCKET", DEFAULT_SOCKET)
    trusted = os.environ.get("TRUSTED_SENDER", TRUSTED_DEFAULT)
    acquire_singleton()
    load_whitelist(force=True)

    try:
        hook = load_omb_webhook()
        has_url = bool(hook.get("url"))
        log(
            f"bridge start socket={sock_path} trusted={trusted} "
            f"wake=omb-webhook has_url={has_url} account={ACCOUNT}"
        )
    except Exception as exc:
        log(f"bridge start WARNING webhook env unreadable: {exc}")

    backoff = 1
    while True:
        try:
            sock = connect_socket(sock_path)
            backoff = 1
            log("connected to signal-cli socket")
            buf = b""
            while True:
                try:
                    chunk = sock.recv(65536)
                except socket.timeout:
                    continue
                if not chunk:
                    raise ConnectionError("socket closed")
                buf += chunk
                while b"\n" in buf:
                    line, buf = buf.split(b"\n", 1)
                    if not line.strip():
                        continue
                    try:
                        obj = json.loads(line.decode("utf-8"))
                    except json.JSONDecodeError:
                        log(f"bad json: {line[:200]!r}")
                        continue
                    if not isinstance(obj, dict):
                        continue
                    method = obj.get("method")
                    if method and method != "receive":
                        continue
                    inbound = extract_inbound(obj)
                    if not inbound:
                        continue
                    sender = str(inbound.get("sender") or "")
                    gid = str(inbound.get("group_id") or "").strip()
                    trusted_ok = is_trusted(inbound)
                    log(
                        f"inbound from {sender!r} trusted={trusted_ok} "
                        f"group={gid or '-'} "
                        f"chars={len(str(inbound.get('message') or ''))} "
                        f"images={len(inbound.get('images') or [])}"
                    )
                    ok, drop_reason = should_wake(inbound)
                    if not ok:
                        log(drop_reason)
                        continue
                    msg = str(inbound.get("message") or "")
                    if msg.startswith("[bridge self-test]"):
                        continue
                    if msg == ACK_TEXT:
                        continue
                    dedupe = f"{sender}:{inbound.get('timestamp')}:{msg}"
                    if not should_handle(dedupe):
                        continue
                    spool_path = write_spool(inbound, str(inbound.get("timestamp") or int(time.time() * 1000)))
                    log(f"spooled {spool_path}")
                    wake_local(inbound, spool_path)
        except Exception as exc:
            log(f"reconnect after error: {exc}")
            time.sleep(backoff)
            backoff = min(backoff * 2, 30)
    return 0


if __name__ == "__main__":
    sys.exit(main())
