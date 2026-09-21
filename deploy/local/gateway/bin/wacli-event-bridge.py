#!/usr/bin/env python3
"""Keep wacli sync alive; on inbound text wake 私人AI via OpenMausBot loopback webhook (no auto WA ack).

Singleton: only one bridge process may hold event-bridge.lock.
Dedup: each MsgID is claimed once via O_EXCL before wake, so dual instances cannot double-wake.
"""
from __future__ import annotations

import fcntl
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

HOME = Path.home()
STATE_PATH = HOME / ".config/wacli/bridge-state.json"
LOCK_PATH = HOME / ".config/wacli/event-bridge.lock"
WEBHOOK_ENV_PATH = HOME / ".config/wacli/openmaus-webhook.env"
WHITELIST_PATH = HOME / ".config/wacli/wake-whitelist.json"
SPOOL_DIR = HOME / ".config/wacli/inbox-spool"
CLAIM_DIR = SPOOL_DIR / "claimed"
STORE = os.environ.get("WACLI_STORE_DIR", str(HOME / ".config/wacli"))
WACLI = str(HOME / "bin/wacli")
POLL_SEC = 1.0
# On restart, still wake recent inbound that arrived while bridge was down.
STARTUP_GRACE_SEC = 30 * 60
DEFAULT_GRACE_IF_NO_LAST = 15 * 60

_lock_fd = None
_whitelist_mtime: float | None = None
_whitelist_enabled = True
_whitelist_jids: set[str] = set()
_whitelist_titles: dict[str, str] = {}
_whitelist_ok = False


def normalize_jid(jid: object) -> str:
    return str(jid or "").strip().lower()


def sanitize_thread_title(value: str) -> str:
    cleaned = "".join(ch if ch >= " " else " " for ch in value).strip()
    return cleaned[:80]


def http_header_value(value: str) -> str:
    """urllib headers are latin-1; keep UTF-8 titles (e.g. WA: 清浩) as bytes."""
    try:
        value.encode("latin-1")
        return value
    except UnicodeEncodeError:
        return value.encode("utf-8").decode("latin-1")


def _title_for_whitelist_item(item: object, jid: str) -> str:
    if isinstance(item, dict):
        explicit = str(item.get("thread") or "").strip()
        if explicit:
            return sanitize_thread_title(explicit)
        name = str(item.get("name") or "").strip()
        if name:
            return sanitize_thread_title(f"WA: {name}")
    local = jid.split("@", 1)[0] or "chat"
    return sanitize_thread_title(f"WA: {local}")


def _parse_whitelist(raw: dict[str, object]) -> tuple[bool, set[str], dict[str, str]]:
    enabled = raw.get("enabled", True)
    if enabled is False:
        return False, set(), {}
    jids: set[str] = set()
    titles: dict[str, str] = {}
    for item in raw.get("chats") or []:
        if isinstance(item, str):
            jid = normalize_jid(item)
        elif isinstance(item, dict):
            jid = normalize_jid(item.get("jid") or item.get("JID") or item.get("Chat"))
        else:
            continue
        if jid:
            jids.add(jid)
            titles[jid] = _title_for_whitelist_item(item, jid)
    return True, jids, titles


def load_whitelist(force: bool = False) -> tuple[bool, set[str], bool]:
    """Return (enabled, allowed_jids, loaded_ok). Reloads when the file mtime changes.

    Fail-closed: missing/unreadable/empty file with enabled=true wakes nobody.
    enabled=false disables the filter and wakes every otherwise-valid inbound.
    """
    global _whitelist_mtime, _whitelist_enabled, _whitelist_jids, _whitelist_titles, _whitelist_ok
    try:
        mtime = WHITELIST_PATH.stat().st_mtime
    except FileNotFoundError:
        if force or _whitelist_ok:
            sys.stderr.write(f"whitelist missing {WHITELIST_PATH}; fail-closed\n")
        _whitelist_mtime = None
        _whitelist_enabled = True
        _whitelist_jids = set()
        _whitelist_titles = {}
        _whitelist_ok = False
        return True, set(), False
    if not force and _whitelist_ok and mtime == _whitelist_mtime:
        return _whitelist_enabled, _whitelist_jids, True
    try:
        raw = json.loads(WHITELIST_PATH.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            raise ValueError("whitelist root must be an object")
        enabled, jids, titles = _parse_whitelist(raw)
    except Exception as e:
        sys.stderr.write(f"whitelist load err: {e}; fail-closed\n")
        _whitelist_mtime = mtime
        _whitelist_enabled = True
        _whitelist_jids = set()
        _whitelist_titles = {}
        _whitelist_ok = False
        return True, set(), False
    _whitelist_mtime = mtime
    _whitelist_enabled = enabled
    _whitelist_jids = jids
    _whitelist_titles = titles
    _whitelist_ok = True
    sys.stderr.write(
        f"whitelist loaded enabled={enabled} chats={len(jids)} path={WHITELIST_PATH}\n"
    )
    return enabled, jids, True


def thread_title_for(msg: dict[str, object]) -> str:
    load_whitelist()
    chat = normalize_jid(msg.get("ChatJID") or msg.get("Chat") or "")
    mapped = _whitelist_titles.get(chat, "")
    if mapped:
        return mapped
    name = str(msg.get("ChatName") or "").strip()
    if name:
        return sanitize_thread_title(f"WA: {name}")
    local = chat.split("@", 1)[0] or "chat"
    return sanitize_thread_title(f"WA: {local}")


def thread_key_for(msg: dict[str, object]) -> str:
    chat = normalize_jid(msg.get("ChatJID") or msg.get("Chat") or "")
    return f"wa:{chat}"[:200] if chat else "wa:unknown"


def is_whitelisted_chat(msg: dict) -> bool:
    """Listed chats wake 私人AI. Groups: any member. DMs: only the listed JID."""
    enabled, jids, _ok = load_whitelist()
    if not enabled:
        return True
    chat = normalize_jid(msg.get("ChatJID") or msg.get("Chat") or "")
    return bool(chat) and chat in jids


def acquire_singleton() -> None:
    """Exit if another event-bridge already holds the lock."""
    global _lock_fd
    LOCK_PATH.parent.mkdir(parents=True, exist_ok=True)
    _lock_fd = open(LOCK_PATH, "a+", encoding="utf-8")
    try:
        fcntl.flock(_lock_fd.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        sys.stderr.write("another event-bridge holds lock; exiting\n")
        sys.exit(0)
    _lock_fd.seek(0)
    _lock_fd.truncate()
    _lock_fd.write(str(os.getpid()))
    _lock_fd.flush()
    os.chmod(LOCK_PATH, 0o600)


def claim_msgid(mid: str) -> bool:
    """Atomically claim MsgID for wake. False if already claimed (or empty id)."""
    if not mid:
        return False
    CLAIM_DIR.mkdir(parents=True, exist_ok=True)
    # sanitize filename
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


def load_state() -> dict:
    if STATE_PATH.exists():
        try:
            return json.loads(STATE_PATH.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def save_state(state: dict) -> None:
    STATE_PATH.write_text(json.dumps(state), encoding="utf-8")
    os.chmod(STATE_PATH, 0o600)


def env_for_wacli() -> dict:
    e = os.environ.copy()
    e["WACLI_STORE_DIR"] = STORE
    e["PATH"] = f"{HOME / 'bin'}:" + e.get("PATH", "")
    return e


def ensure_sync(proc: subprocess.Popen | None) -> subprocess.Popen:
    if proc is not None and proc.poll() is None:
        return proc
    cmd = [
        WACLI,
        "sync",
        "--follow",
        "--max-messages",
        "100000",
        "--max-db-size",
        "1GB",
        "--stale-threshold",
        "2m",
        "--max-reconnect",
        "0",
        "--events",
    ]
    sys.stderr.write(f"starting sync: {' '.join(cmd)}\n")
    return subprocess.Popen(
        cmd,
        stdout=subprocess.DEVNULL,
        stderr=open(HOME / "logs/wacli-sync.err", "a", encoding="utf-8"),
        env=env_for_wacli(),
    )


def list_messages(limit: int = 30) -> list[dict]:
    out = subprocess.check_output(
        [WACLI, "--read-only", "--json", "messages", "list", "--limit", str(limit)],
        env=env_for_wacli(),
        text=True,
    )
    data = json.loads(out)
    return data.get("data", {}).get("messages", []) or []


def load_omb_webhook() -> dict:
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


def unclaim_msgid(mid: str) -> None:
    if not mid:
        return
    safe = mid.replace("/", "_").replace("..", "_")[:200]
    try:
        (CLAIM_DIR / safe).unlink()
    except FileNotFoundError:
        pass


def parse_msg_ts(ts: object) -> float | None:
    """Parse wacli Timestamp (ISO-8601, usually ...Z) to unix epoch seconds."""
    if ts is None:
        return None
    if isinstance(ts, (int, float)):
        v = float(ts)
        return v / 1000.0 if v > 1e12 else v
    s = str(ts).strip()
    if not s:
        return None
    try:
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        return datetime.fromisoformat(s).timestamp()
    except Exception:
        return None


def is_reaction_only(msg: dict) -> bool:
    text = (msg.get("Text") or "").strip()
    display = (msg.get("DisplayText") or "").strip()
    if text:
        return False
    if display.lower().startswith("reacted "):
        return True
    return False


def inbound_text(msg: dict) -> str:
    text = (msg.get("Text") or msg.get("DisplayText") or "").strip()
    if text and text != "(message)":
        return text
    return (msg.get("MediaCaption") or "").strip()


def quoted_parts(msg: dict) -> tuple[str, str, str]:
    """WhatsApp reply-quote: (QuotedText, QuotedMsgID, QuotedSenderJID).

    wacli list/show puts the quoted body in DisplayText as '> …\\n' plus Text.
    quoted_msg_id / quoted_sender_jid are present when it is a reply.
    """
    qid = str(msg.get("quoted_msg_id") or msg.get("QuotedMsgID") or "").strip()
    qsender = str(msg.get("quoted_sender_jid") or msg.get("QuotedSenderJID") or "").strip()
    display = (msg.get("DisplayText") or "").strip()
    text = (msg.get("Text") or "").strip()
    quoted = str(msg.get("QuotedText") or "").strip()
    if not quoted and display.startswith(">") and text and display != text and display.endswith(text):
        body = display[: len(display) - len(text)].strip()
        if body.startswith(">"):
            body = body[1:].lstrip()
        quoted = body
    return quoted, qid, qsender


def is_group_chat(msg: dict) -> bool:
    chat = normalize_jid(msg.get("ChatJID") or msg.get("Chat") or "")
    return chat.endswith("@g.us")


def has_media(msg: dict) -> bool:
    return bool(
        str(msg.get("MediaType") or "").strip()
        or str(msg.get("LocalPath") or "").strip()
        or str(msg.get("Filename") or "").strip()
        or str(msg.get("MimeType") or "").strip()
    )


def is_image_media(msg: dict) -> bool:
    media_type = str(msg.get("MediaType") or "").strip().lower()
    mime = str(msg.get("MimeType") or "").strip().lower().split(";", 1)[0]
    path = str(msg.get("LocalPath") or "").strip().lower()
    if media_type in {"image", "photo", "sticker"}:
        return True
    if mime.startswith("image/"):
        return True
    return Path(path).suffix.lower() in {".jpg", ".jpeg", ".png", ".gif", ".webp"}


def ensure_local_media(msg: dict) -> str:
    """Return a local file path for inbound media, downloading if needed."""
    local = str(msg.get("LocalPath") or "").strip()
    if local:
        try:
            if Path(local).is_file() and Path(local).stat().st_size > 0:
                return local
        except OSError:
            pass
    if not has_media(msg):
        return ""
    chat = str(msg.get("ChatJID") or msg.get("Chat") or "").strip()
    mid = str(msg.get("MsgID") or msg.get("ID") or "").strip()
    if not chat or not mid:
        return local
    try:
        out = subprocess.check_output(
            [WACLI, "--json", "media", "download", "--chat", chat, "--id", mid],
            env=env_for_wacli(),
            text=True,
            timeout=60,
        )
    except Exception as exc:
        sys.stderr.write(f"media download fail id={mid}: {exc}\n")
        return local
    try:
        data = json.loads(out)
    except json.JSONDecodeError:
        return local
    payload = data.get("data", data) if isinstance(data, dict) else {}
    if isinstance(payload, dict):
        for key in ("LocalPath", "path", "output", "file"):
            cand = str(payload.get(key) or "").strip()
            if cand:
                try:
                    if Path(cand).is_file():
                        return cand
                except OSError:
                    pass
    return local


def is_wakeable_inbound(msg: dict) -> bool:
    if msg.get("FromMe"):
        return False
    if is_reaction_only(msg):
        return False
    text = inbound_text(msg)
    if text and text != "(message)":
        return True
    # Image/file with no caption: wake listed DMs. Groups stay skipped here
    # (casual photos) unless they also asked / @ mentioned in text.
    if has_media(msg) and not is_group_chat(msg):
        return True
    return False


def wake_local(msg: dict) -> bool:
    """Wake 私人AI via OpenMausBot loopback webhook. No auto WA ack."""
    chat = msg.get("ChatJID") or msg.get("Chat") or ""
    chat_name = msg.get("ChatName") or ""
    mid = msg.get("MsgID") or msg.get("ID") or ""
    sender = msg.get("SenderJID") or ""
    sender_name = msg.get("SenderName") or ""
    ts = msg.get("Timestamp") or ""
    text = inbound_text(msg)
    local_path = ensure_local_media(msg)
    image_paths = [local_path] if local_path and is_image_media({**msg, "LocalPath": local_path}) else []
    if local_path and not image_paths:
        # still image by extension even if MediaType blank
        if Path(local_path).suffix.lower() in {".jpg", ".jpeg", ".png", ".gif", ".webp"}:
            image_paths = [local_path]
    quoted_text, quoted_id, quoted_sender = quoted_parts(msg)

    if not claim_msgid(mid):
        sys.stderr.write(f"skip duplicate wake id={mid}\n")
        return False

    payload = {
        "Chat": chat,
        "ChatName": chat_name,
        "ID": mid,
        "SenderJID": sender,
        "SenderName": sender_name,
        "Timestamp": ts,
        "FromMe": False,
        "Text": text,
        "QuotedText": quoted_text,
        "QuotedMsgID": quoted_id,
        "QuotedSenderJID": quoted_sender,
        "MediaType": msg.get("MediaType") or "",
        "MediaCaption": msg.get("MediaCaption") or "",
        "MimeType": msg.get("MimeType") or "",
        "Filename": msg.get("Filename") or "",
        "LocalPath": local_path,
        "HasImage": bool(image_paths),
        "Images": image_paths,
        "WakeVia": "omb-webhook",
    }

    SPOOL_DIR.mkdir(parents=True, exist_ok=True)
    spool_path = SPOOL_DIR / f"{int(time.time()*1000)}_{mid or 'msg'}.json"
    spool_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    os.chmod(spool_path, 0o600)
    payload["Spool"] = str(spool_path)

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
                "Idempotency-Key": str(mid)[:200],
                "User-Agent": "wacli-poll-bridge/2.0-omb-webhook",
                "X-Webhook-Event": "whatsapp.inbound",
                "X-Omb-Thread-Title": http_header_value(thread_title_for(msg)),
                "X-Omb-Thread-Key": thread_key_for(msg),
            },
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read()[:300]
            sys.stderr.write(
                f"omb wake ok id={mid} status={resp.status} body={raw!r}\n"
            )
            return True
    except urllib.error.HTTPError as e:
        unclaim_msgid(mid)
        sys.stderr.write(f"omb wake http {e.code} id={mid}: {e.read()[:300]!r}\n")
    except Exception as e:
        unclaim_msgid(mid)
        sys.stderr.write(f"omb wake err id={mid}: {e}\n")
    return False


def startup_cutoff(state: dict) -> float:
    """Unix time: wake inbound text newer than this on startup (missed while down)."""
    now = time.time()
    floor = now - STARTUP_GRACE_SEC
    last = state.get("last_successful_wake_or_poll")
    if last is None:
        last = state.get("last_wake_at")
    if last is None:
        return now - DEFAULT_GRACE_IF_NO_LAST
    try:
        last_f = float(last)
    except (TypeError, ValueError):
        return now - DEFAULT_GRACE_IF_NO_LAST
    return max(floor, last_f)


def seed_seen_with_backlog_wake(state: dict, seen: set) -> None:
    """Seed seen, but wake recent inbound text that may have arrived while down."""
    cutoff = startup_cutoff(state)
    backlog: list[dict] = []
    woken = 0
    for m in list_messages(80):
        mid = m.get("MsgID")
        if not mid:
            continue
        ts = parse_msg_ts(m.get("Timestamp"))
        recent = ts is not None and ts >= cutoff
        if recent and is_wakeable_inbound(m) and mid not in seen:
            if not is_whitelisted_chat(m):
                chat = m.get("ChatJID") or m.get("Chat") or ""
                sys.stderr.write(f"skip not-whitelisted chat={chat} id={mid}\n")
                seen.add(mid)
                continue
            backlog.append(m)
        else:
            seen.add(mid)

    backlog.sort(key=lambda m: parse_msg_ts(m.get("Timestamp")) or 0.0)
    for m in backlog:
        mid = m.get("MsgID")
        if not mid or mid in seen:
            continue
        ok = wake_local(m)
        if ok:
            seen.add(mid)
            woken += 1
            state["last_wake_at"] = time.time()
            state["last_forwarded"] = mid

    now = time.time()
    state["seen_ids"] = list(seen)[-500:]
    state["last_successful_wake_or_poll"] = now
    save_state(state)
    sys.stderr.write(
        f"seeded seen={len(seen)} backlog_wake={woken} "
        f"cutoff={datetime.fromtimestamp(cutoff, tz=timezone.utc).isoformat()} "
        f"wake=omb-webhook\n"
    )


def main() -> None:
    HOME.joinpath("logs").mkdir(parents=True, exist_ok=True)
    acquire_singleton()
    load_whitelist(force=True)
    state = load_state()
    seen = set(state.get("seen_ids", []))
    try:
        seed_seen_with_backlog_wake(state, seen)
    except Exception as e:
        sys.stderr.write(f"seed failed: {e}\n")

    sync_proc = None
    while True:
        try:
            sync_proc = ensure_sync(sync_proc)
            for m in list_messages(20):
                mid = m.get("MsgID")
                if not mid or mid in seen:
                    continue
                if not is_wakeable_inbound(m):
                    seen.add(mid)
                    continue
                if not is_whitelisted_chat(m):
                    chat = m.get("ChatJID") or m.get("Chat") or ""
                    sys.stderr.write(f"skip not-whitelisted chat={chat} id={mid}\n")
                    seen.add(mid)
                    continue
                if wake_local(m):
                    seen.add(mid)
                    state["last_wake_at"] = time.time()
                    state["last_forwarded"] = mid
            state["seen_ids"] = list(seen)[-500:]
            state["last_successful_wake_or_poll"] = time.time()
            save_state(state)
        except Exception as e:
            sys.stderr.write(f"loop err: {e}\n")
        time.sleep(POLL_SEC)


if __name__ == "__main__":
    main()
