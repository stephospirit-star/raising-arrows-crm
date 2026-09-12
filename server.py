#!/usr/bin/env python3
"""
Raising Arrows CRM — a small self-contained pipeline tool.

No external dependencies: runs with the Python 3 that ships with macOS.
Start it with:  python3 server.py
Then open:      http://localhost:8420
"""

import hashlib
import json
import os
import secrets
import sqlite3
import socket
import threading
from datetime import date, datetime, timedelta
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
# On a host with a persistent disk (e.g. Render), CRM_DATA_DIR points at the
# mounted volume so the database survives restarts/redeploys. Locally it
# just falls back to living next to the code, as before.
DATA_DIR = os.environ.get("CRM_DATA_DIR", BASE_DIR)
DB_PATH = os.path.join(DATA_DIR, "raising_arrows.db")
PORT = int(os.environ.get("PORT", "8420"))
# Render (and most PaaS hosts) terminate HTTPS in front of the app and set
# this env var — use it to mark the session cookie Secure in that case.
IS_HOSTED = bool(os.environ.get("RENDER"))

STAGES = [
    {"key": "new_inquiry", "label": "New Inquiry"},
    {"key": "follow_up", "label": "Follow Up"},
    {"key": "awaiting_payment", "label": "Awaiting Payment"},
    {"key": "closed_payment_plan", "label": "Closed – Payment Plan"},
    {"key": "closed_paid_full", "label": "Closed – Paid in Full"},
    {"key": "closed_personalized", "label": "Closed – Personalized Coaching"},
    {"key": "closed_lost", "label": "Closed Lost"},
]
STAGE_KEYS = {s["key"] for s in STAGES}

DEFAULT_SETTINGS = {
    "price_per_child": "50000",
    "follow_up_window_days": "2",
    "payment_due_window_days": "2",
    "installments_total_default": "3",
    "installment_gap_days": "30",
}

# Stages where she must manually enter what was actually received —
# a payment plan or personalized-coaching contact sitting at ₦0 paid
# gets flagged red on the board until she records it.
FLAG_IF_UNPAID_STAGES = {"closed_payment_plan", "closed_personalized"}

SESSION_MAX_AGE_DAYS = 30

# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------

_db_lock = threading.Lock()


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def session_cookie_header(token):
    secure = "; Secure" if IS_HOSTED else ""
    return f"session={token}; Path=/; Max-Age={SESSION_MAX_AGE_DAYS*86400}; HttpOnly; SameSite=Lax{secure}"


def clear_cookie_header():
    secure = "; Secure" if IS_HOSTED else ""
    return f"session=; Path=/; Max-Age=0{secure}"


def init_db():
    os.makedirs(DATA_DIR, exist_ok=True)
    conn = get_db()
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT
        );

        CREATE TABLE IF NOT EXISTS sessions (
            token TEXT PRIMARY KEY,
            created_at TEXT,
            expires_at TEXT
        );

        CREATE TABLE IF NOT EXISTS contacts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            email TEXT,
            phone TEXT,
            stage TEXT NOT NULL DEFAULT 'new_inquiry',
            hot INTEGER NOT NULL DEFAULT 0,
            program_type TEXT NOT NULL DEFAULT 'regular',
            price_per_child REAL,
            amount_total REAL NOT NULL DEFAULT 0,
            amount_paid REAL NOT NULL DEFAULT 0,
            personalized_months INTEGER,
            installments_total INTEGER NOT NULL DEFAULT 3,
            installments_paid INTEGER NOT NULL DEFAULT 0,
            follow_up_due TEXT,
            next_payment_due TEXT,
            notes TEXT,
            closed_lost_reason TEXT,
            created_at TEXT,
            updated_at TEXT
        );

        CREATE TABLE IF NOT EXISTS children (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
            name TEXT,
            sort_order INTEGER DEFAULT 0
        );
        """
    )
    for k, v in DEFAULT_SETTINGS.items():
        conn.execute(
            "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", (k, v)
        )
    conn.commit()
    conn.close()


def get_settings(conn):
    rows = conn.execute("SELECT key, value FROM settings").fetchall()
    return {r["key"]: r["value"] for r in rows}


# ---------------------------------------------------------------------------
# Auth helpers
# ---------------------------------------------------------------------------


def hash_password(password, salt=None):
    if salt is None:
        salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), 200_000)
    return salt, digest.hex()


def verify_password(password, salt, expected_hash):
    _, digest = hash_password(password, salt)
    return secrets.compare_digest(digest, expected_hash)


def is_configured(conn):
    s = get_settings(conn)
    return bool(s.get("auth_email") and s.get("auth_salt") and s.get("auth_hash"))


def create_session(conn):
    token = secrets.token_hex(32)
    now = datetime.utcnow()
    expires = now + timedelta(days=SESSION_MAX_AGE_DAYS)
    conn.execute(
        "INSERT INTO sessions (token, created_at, expires_at) VALUES (?, ?, ?)",
        (token, now.isoformat(), expires.isoformat()),
    )
    conn.commit()
    return token


def session_valid(conn, token):
    if not token:
        return False
    row = conn.execute(
        "SELECT expires_at FROM sessions WHERE token = ?", (token,)
    ).fetchone()
    if not row:
        return False
    return datetime.fromisoformat(row["expires_at"]) > datetime.utcnow()


# ---------------------------------------------------------------------------
# Serialization helpers
# ---------------------------------------------------------------------------


def contact_to_dict(conn, row):
    children = conn.execute(
        "SELECT id, name FROM children WHERE contact_id = ? ORDER BY sort_order, id",
        (row["id"],),
    ).fetchall()
    d = dict(row)
    d["children"] = [{"id": c["id"], "name": c["name"]} for c in children]
    d["num_children"] = len(d["children"])
    d["payment_not_recorded"] = (
        d["stage"] in FLAG_IF_UNPAID_STAGES and (d["amount_paid"] or 0) <= 0
    )
    return d


def today_str():
    return date.today().isoformat()


def parse_date(s):
    if not s:
        return None
    try:
        return date.fromisoformat(s)
    except ValueError:
        return None


# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------


class Handler(BaseHTTPRequestHandler):
    server_version = "RaisingArrowsCRM/1.0"

    def log_message(self, fmt, *args):
        pass  # keep the terminal quiet

    # -- low level helpers ---------------------------------------------

    def _send_json(self, obj, status=200, set_cookie=None):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        if set_cookie:
            self.send_header("Set-Cookie", set_cookie)
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        length = int(self.headers.get("Content-Length", 0) or 0)
        if length == 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode())
        except Exception:
            return {}

    def _get_cookie_token(self):
        cookie_header = self.headers.get("Cookie")
        if not cookie_header:
            return None
        c = SimpleCookie()
        c.load(cookie_header)
        if "session" in c:
            return c["session"].value
        return None

    def _require_auth(self, conn):
        token = self._get_cookie_token()
        if not session_valid(conn, token):
            self._send_json({"error": "unauthorized"}, 401)
            return False
        return True

    def _static_file(self, path):
        if path == "/" or path == "":
            path = "/index.html"
        safe_path = os.path.normpath(path).lstrip("/")
        full_path = os.path.join(STATIC_DIR, safe_path)
        if not full_path.startswith(STATIC_DIR):
            self.send_error(403)
            return
        if not os.path.isfile(full_path):
            full_path = os.path.join(STATIC_DIR, "index.html")
        ext = os.path.splitext(full_path)[1]
        content_type = {
            ".html": "text/html",
            ".js": "application/javascript",
            ".css": "text/css",
            ".png": "image/png",
            ".svg": "image/svg+xml",
        }.get(ext, "application/octet-stream")
        with open(full_path, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # -- routing ----------------------------------------------------------

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        with _db_lock:
            conn = get_db()
            try:
                if path == "/api/setup-status":
                    configured = is_configured(conn)
                    email = get_settings(conn).get("auth_email") if configured else None
                    self._send_json({"configured": configured, "email": email})
                elif path == "/api/me":
                    if not self._require_auth(conn):
                        return
                    email = get_settings(conn).get("auth_email")
                    self._send_json({"email": email})
                elif path == "/api/stages":
                    self._send_json({"stages": STAGES})
                elif path == "/api/settings":
                    if not self._require_auth(conn):
                        return
                    s = get_settings(conn)
                    s.pop("auth_salt", None)
                    s.pop("auth_hash", None)
                    self._send_json(s)
                elif path == "/api/contacts":
                    if not self._require_auth(conn):
                        return
                    rows = conn.execute(
                        "SELECT * FROM contacts ORDER BY created_at DESC"
                    ).fetchall()
                    self._send_json([contact_to_dict(conn, r) for r in rows])
                elif path.startswith("/api/contacts/"):
                    if not self._require_auth(conn):
                        return
                    cid = int(path.split("/")[-1])
                    row = conn.execute(
                        "SELECT * FROM contacts WHERE id = ?", (cid,)
                    ).fetchone()
                    if not row:
                        self._send_json({"error": "not found"}, 404)
                        return
                    self._send_json(contact_to_dict(conn, row))
                elif path == "/api/dashboard":
                    if not self._require_auth(conn):
                        return
                    self._handle_dashboard(conn)
                else:
                    self._static_file(path)
            finally:
                conn.close()

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        body = self._read_json()
        with _db_lock:
            conn = get_db()
            try:
                if path == "/api/admin/one-time-reset":
                    self._handle_one_time_reset(conn, body)
                elif path == "/api/setup":
                    self._handle_setup(conn, body)
                elif path == "/api/login":
                    self._handle_login(conn, body)
                elif path == "/api/logout":
                    self._handle_logout(conn)
                elif path == "/api/contacts":
                    if not self._require_auth(conn):
                        return
                    self._handle_create_contact(conn, body)
                elif path.endswith("/children") and path.startswith("/api/contacts/"):
                    if not self._require_auth(conn):
                        return
                    cid = int(path.split("/")[3])
                    self._handle_add_child(conn, cid, body)
                elif path.endswith("/payment") and path.startswith("/api/contacts/"):
                    if not self._require_auth(conn):
                        return
                    cid = int(path.split("/")[3])
                    self._handle_record_payment(conn, cid, body)
                else:
                    self._send_json({"error": "not found"}, 404)
            finally:
                conn.close()

    def do_PUT(self):
        parsed = urlparse(self.path)
        path = parsed.path
        body = self._read_json()
        with _db_lock:
            conn = get_db()
            try:
                if path.startswith("/api/contacts/") and "/" not in path[len("/api/contacts/"):]:
                    if not self._require_auth(conn):
                        return
                    cid = int(path.split("/")[-1])
                    self._handle_update_contact(conn, cid, body)
                elif path == "/api/settings":
                    if not self._require_auth(conn):
                        return
                    self._handle_update_settings(conn, body)
                else:
                    self._send_json({"error": "not found"}, 404)
            finally:
                conn.close()

    def do_DELETE(self):
        parsed = urlparse(self.path)
        path = parsed.path
        with _db_lock:
            conn = get_db()
            try:
                parts = path.split("/")
                if len(parts) == 4 and path.startswith("/api/contacts/"):
                    if not self._require_auth(conn):
                        return
                    cid = int(parts[3])
                    conn.execute("DELETE FROM contacts WHERE id = ?", (cid,))
                    conn.commit()
                    self._send_json({"ok": True})
                elif len(parts) == 6 and parts[4] == "children":
                    if not self._require_auth(conn):
                        return
                    child_id = int(parts[5])
                    conn.execute("DELETE FROM children WHERE id = ?", (child_id,))
                    conn.commit()
                    self._send_json({"ok": True})
                else:
                    self._send_json({"error": "not found"}, 404)
            finally:
                conn.close()

    # -- handlers -----------------------------------------------------------

    def _handle_one_time_reset(self, conn, body):
        # TEMPORARY: wipes all data so first-time setup can run again with a
        # fresh login. Remove this endpoint once used.
        expected = "90a5c19355f660236bc1530e1a2965bfc46dbd9b858df3b2"
        if body.get("token") != expected:
            self._send_json({"error": "forbidden"}, 403)
            return
        conn.executescript(
            "DELETE FROM contacts; DELETE FROM children; "
            "DELETE FROM sessions; DELETE FROM settings;"
        )
        for k, v in DEFAULT_SETTINGS.items():
            conn.execute("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", (k, v))
        conn.commit()
        self._send_json({"ok": True})

    def _handle_setup(self, conn, body):
        if is_configured(conn):
            self._send_json({"error": "already configured"}, 400)
            return
        email = (body.get("email") or "").strip().lower()
        password = body.get("password") or ""
        if not email or len(password) < 4:
            self._send_json({"error": "email and a password (4+ chars) are required"}, 400)
            return
        salt, digest = hash_password(password)
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('auth_email', ?)",
            (email,),
        )
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('auth_salt', ?)",
            (salt,),
        )
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES ('auth_hash', ?)",
            (digest,),
        )
        conn.commit()
        token = create_session(conn)
        self._send_json(
            {"ok": True, "email": email},
            set_cookie=session_cookie_header(token),
        )

    def _handle_login(self, conn, body):
        s = get_settings(conn)
        email = (body.get("email") or "").strip().lower()
        password = body.get("password") or ""
        if (
            not s.get("auth_email")
            or email != s.get("auth_email")
            or not verify_password(password, s.get("auth_salt", ""), s.get("auth_hash", ""))
        ):
            self._send_json({"error": "invalid email or password"}, 401)
            return
        token = create_session(conn)
        self._send_json(
            {"ok": True, "email": email},
            set_cookie=session_cookie_header(token),
        )

    def _handle_logout(self, conn):
        token = self._get_cookie_token()
        if token:
            conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
            conn.commit()
        self._send_json({"ok": True}, set_cookie=clear_cookie_header())

    def _handle_create_contact(self, conn, body):
        name = (body.get("name") or "").strip()
        if not name:
            self._send_json({"error": "name is required"}, 400)
            return
        stage = body.get("stage") or "new_inquiry"
        if stage not in STAGE_KEYS:
            stage = "new_inquiry"
        settings = get_settings(conn)
        now = datetime.utcnow().isoformat()
        program_type = body.get("program_type", "regular")
        num_children = len(
            [
                c
                for c in (body.get("children") or [])
                if (c.get("name") if isinstance(c, dict) else c)
            ]
        )
        if program_type == "regular":
            # 3-month program is a fixed ₦/child rate — always the settings
            # price times however many children are on the card.
            price_per_child = float(settings["price_per_child"])
            amount_total = num_children * price_per_child
        else:
            # Personalized coaching is the only plan priced by hand.
            price_per_child = None
            amount_total = float(body.get("amount_total") or 0)
        # "Closed – Paid in Full" means paid in full, by definition.
        amount_paid = amount_total if stage == "closed_paid_full" else float(body.get("amount_paid") or 0)
        cur = conn.execute(
            """INSERT INTO contacts
               (name, email, phone, stage, hot, program_type, price_per_child,
                amount_total, amount_paid, personalized_months, installments_total,
                installments_paid, follow_up_due, next_payment_due, notes,
                closed_lost_reason, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                name,
                body.get("email", ""),
                body.get("phone", ""),
                stage,
                1 if body.get("hot") else 0,
                program_type,
                price_per_child,
                amount_total,
                amount_paid,
                body.get("personalized_months"),
                int(body.get("installments_total") or settings["installments_total_default"]),
                int(body.get("installments_paid") or 0),
                body.get("follow_up_due"),
                body.get("next_payment_due"),
                body.get("notes", ""),
                body.get("closed_lost_reason", ""),
                now,
                now,
            ),
        )
        contact_id = cur.lastrowid
        for i, child in enumerate(body.get("children") or []):
            child_name = child.get("name") if isinstance(child, dict) else child
            if child_name:
                conn.execute(
                    "INSERT INTO children (contact_id, name, sort_order) VALUES (?, ?, ?)",
                    (contact_id, child_name, i),
                )
        conn.commit()
        row = conn.execute("SELECT * FROM contacts WHERE id = ?", (contact_id,)).fetchone()
        self._send_json(contact_to_dict(conn, row), 201)

    def _handle_update_contact(self, conn, cid, body):
        row = conn.execute("SELECT * FROM contacts WHERE id = ?", (cid,)).fetchone()
        if not row:
            self._send_json({"error": "not found"}, 404)
            return
        settings = get_settings(conn)
        fields = [
            "name", "email", "phone", "stage", "program_type", "price_per_child",
            "amount_total", "amount_paid", "personalized_months", "installments_total",
            "installments_paid", "follow_up_due", "next_payment_due", "notes",
            "closed_lost_reason",
        ]
        updates = {}
        for f in fields:
            if f in body:
                updates[f] = body[f]
        if "hot" in body:
            updates["hot"] = 1 if body["hot"] else 0
        if "stage" in updates and updates["stage"] not in STAGE_KEYS:
            self._send_json({"error": "invalid stage"}, 400)
            return

        final_program_type = updates.get("program_type", row["program_type"])
        final_stage = updates.get("stage", row["stage"])

        if "children" in body:
            final_num_children = len(
                [
                    c
                    for c in (body["children"] or [])
                    if (c.get("name") if isinstance(c, dict) else c)
                ]
            )
        else:
            final_num_children = conn.execute(
                "SELECT COUNT(*) AS n FROM children WHERE contact_id = ?", (cid,)
            ).fetchone()["n"]

        if final_program_type == "regular":
            # 3-month program is always ₦/child × number of children —
            # not hand-entered, so it can't drift from the child list.
            price_per_child = float(settings["price_per_child"])
            updates["price_per_child"] = price_per_child
            updates["amount_total"] = final_num_children * price_per_child
        elif "amount_total" in body:
            updates["amount_total"] = float(body["amount_total"] or 0)

        final_amount_total = updates.get("amount_total", row["amount_total"])
        if final_stage == "closed_paid_full":
            # Paid in Full means paid in full, by definition.
            updates["amount_paid"] = final_amount_total
        elif "amount_paid" in body:
            updates["amount_paid"] = float(body["amount_paid"] or 0)

        if updates:
            updates["updated_at"] = datetime.utcnow().isoformat()
            set_clause = ", ".join(f"{k} = ?" for k in updates)
            conn.execute(
                f"UPDATE contacts SET {set_clause} WHERE id = ?",
                (*updates.values(), cid),
            )
        # full replace of children list if provided
        if "children" in body:
            conn.execute("DELETE FROM children WHERE contact_id = ?", (cid,))
            for i, child in enumerate(body["children"] or []):
                child_name = child.get("name") if isinstance(child, dict) else child
                if child_name:
                    conn.execute(
                        "INSERT INTO children (contact_id, name, sort_order) VALUES (?, ?, ?)",
                        (cid, child_name, i),
                    )
        conn.commit()
        row = conn.execute("SELECT * FROM contacts WHERE id = ?", (cid,)).fetchone()
        self._send_json(contact_to_dict(conn, row))

    def _handle_add_child(self, conn, cid, body):
        name = (body.get("name") or "").strip()
        if not name:
            self._send_json({"error": "name is required"}, 400)
            return
        row = conn.execute(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM children WHERE contact_id = ?",
            (cid,),
        ).fetchone()
        conn.execute(
            "INSERT INTO children (contact_id, name, sort_order) VALUES (?, ?, ?)",
            (cid, name, row["n"]),
        )
        conn.commit()
        crow = conn.execute("SELECT * FROM contacts WHERE id = ?", (cid,)).fetchone()
        self._send_json(contact_to_dict(conn, crow), 201)

    def _handle_record_payment(self, conn, cid, body):
        row = conn.execute("SELECT * FROM contacts WHERE id = ?", (cid,)).fetchone()
        if not row:
            self._send_json({"error": "not found"}, 404)
            return
        settings = get_settings(conn)
        amount = float(body.get("amount") or 0)
        new_paid = row["amount_paid"] + amount
        new_installments_paid = row["installments_paid"] + (
            1 if body.get("advance_installment", True) else 0
        )
        next_due = row["next_payment_due"]
        if body.get("advance_installment", True):
            gap = int(settings.get("installment_gap_days", 30))
            base = parse_date(next_due) or date.today()
            if new_installments_paid < row["installments_total"]:
                next_due = (base + timedelta(days=gap)).isoformat()
            else:
                next_due = None
        conn.execute(
            """UPDATE contacts SET amount_paid = ?, installments_paid = ?,
               next_payment_due = ?, updated_at = ? WHERE id = ?""",
            (new_paid, new_installments_paid, next_due, datetime.utcnow().isoformat(), cid),
        )
        conn.commit()
        row = conn.execute("SELECT * FROM contacts WHERE id = ?", (cid,)).fetchone()
        self._send_json(contact_to_dict(conn, row))

    def _handle_update_settings(self, conn, body):
        allowed = set(DEFAULT_SETTINGS.keys())
        for k, v in body.items():
            if k in allowed:
                conn.execute(
                    "INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)",
                    (k, str(v)),
                )
        conn.commit()
        s = get_settings(conn)
        s.pop("auth_salt", None)
        s.pop("auth_hash", None)
        self._send_json(s)

    def _handle_dashboard(self, conn):
        settings = get_settings(conn)
        rows = conn.execute("SELECT * FROM contacts").fetchall()
        contacts = [contact_to_dict(conn, r) for r in rows]

        stage_counts = {s["key"]: 0 for s in STAGES}
        total_received = 0.0
        total_outstanding = 0.0
        for c in contacts:
            stage_counts[c["stage"]] = stage_counts.get(c["stage"], 0) + 1
            total_received += c["amount_paid"] or 0
            if c["stage"] not in ("closed_lost", "closed_paid_full"):
                outstanding = (c["amount_total"] or 0) - (c["amount_paid"] or 0)
                if outstanding > 0:
                    total_outstanding += outstanding

        follow_up_window = int(settings.get("follow_up_window_days", 2))
        payment_window = int(settings.get("payment_due_window_days", 2))
        today = date.today()

        follow_ups_due = []
        for c in contacts:
            d = parse_date(c.get("follow_up_due"))
            if d and c["stage"] != "closed_lost" and d <= today + timedelta(days=follow_up_window):
                follow_ups_due.append(
                    {
                        "id": c["id"],
                        "name": c["name"],
                        "stage": c["stage"],
                        "phone": c["phone"],
                        "follow_up_due": c["follow_up_due"],
                        "overdue": d < today,
                    }
                )
        follow_ups_due.sort(key=lambda x: x["follow_up_due"])

        payments_due = []
        for c in contacts:
            d = parse_date(c.get("next_payment_due"))
            if (
                d
                and c["stage"] == "closed_payment_plan"
                and c["installments_paid"] < c["installments_total"]
                and d <= today + timedelta(days=payment_window)
            ):
                payments_due.append(
                    {
                        "id": c["id"],
                        "name": c["name"],
                        "phone": c["phone"],
                        "next_payment_due": c["next_payment_due"],
                        "amount_remaining": (c["amount_total"] or 0) - (c["amount_paid"] or 0),
                        "overdue": d < today,
                    }
                )
        payments_due.sort(key=lambda x: x["next_payment_due"])

        unrecorded_payments = [
            {"id": c["id"], "name": c["name"], "phone": c["phone"], "stage": c["stage"]}
            for c in contacts
            if c["payment_not_recorded"]
        ]

        self._send_json(
            {
                "stage_counts": stage_counts,
                "total_received": total_received,
                "total_outstanding": total_outstanding,
                "total_contacts": len(contacts),
                "follow_ups_due": follow_ups_due,
                "payments_due": payments_due,
                "unrecorded_payments": unrecorded_payments,
            }
        )


def local_ip():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"


def main():
    init_db()
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print("=" * 60)
    print("  Raising Arrows CRM is running")
    if IS_HOSTED:
        print(f"  Listening on port {PORT}")
    else:
        print(f"  On this Mac:      http://localhost:{PORT}")
        print(f"  On your network:  http://{local_ip()}:{PORT}")
        print("  (share the network link with your assistant if they")
        print("   need to log in from another computer on the same wifi)")
    print("  Press Control+C to stop the server.")
    print("=" * 60)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down. Bye!")


if __name__ == "__main__":
    main()
