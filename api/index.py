
import os
import re
import ssl
import hmac
import json
import time
import html
import secrets
import logging
import smtplib
import threading

from datetime import timedelta
from email.message import EmailMessage
from email.utils import formataddr, formatdate
from concurrent.futures import ThreadPoolExecutor, as_completed
from html.parser import HTMLParser

from flask import (
    Flask, request, jsonify, redirect, url_for,
    session, Response, stream_with_context, render_template
)


# ============================================================
# APP CONFIGURATION
# ============================================================

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

app = Flask(
    __name__,
    template_folder=os.path.join(BASE_DIR, "templates"),
    static_folder=os.path.join(BASE_DIR, "static"),
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

SESSION_SECRET = os.environ.get("SESSION_SECRET", "")
LOGIN_PASSWORD = os.environ.get("LOGIN_PASSWORD", "")

CONFIG_ERROR = None
if len(SESSION_SECRET) < 32:
    CONFIG_ERROR = "SESSION_SECRET must be at least 32 characters."
elif not LOGIN_PASSWORD:
    CONFIG_ERROR = "LOGIN_PASSWORD is missing."

app.secret_key = (
    SESSION_SECRET if len(SESSION_SECRET) >= 32
    else secrets.token_hex(32)
)

app.config.update(
    SESSION_COOKIE_SECURE=True,
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    PERMANENT_SESSION_LIFETIME=timedelta(hours=1),
    MAX_CONTENT_LENGTH=1024 * 1024,
)


# ============================================================
# GMAIL SMTP SETTINGS
# ============================================================

SMTP_HOST = "smtp.gmail.com"
SMTP_PORT = 465
SMTP_TIMEOUT = 20

MAX_RECIPIENTS = 25

# User-requested sending configuration
MAX_PARALLEL_SENDS = 4
SEND_DELAY_SECONDS = 0.75

# This lock is process-local, not shared across Vercel instances.
_pacing_lock = threading.Lock()
_last_send_started = 0.0


# ============================================================
# HELPERS
# ============================================================

EMAIL_RE = re.compile(
    r"^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+"
    r"@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$"
)


def valid_email(value):
    if not isinstance(value, str):
        return False

    value = value.strip()

    if len(value) < 6 or len(value) > 254:
        return False

    if not EMAIL_RE.fullmatch(value):
        return False

    if ".." in value:
        return False

    return True


def normalize_recipients(raw):
    if not isinstance(raw, list):
        raise ValueError("Recipients must be a list.")

    recipients = []
    seen = set()
    invalid = 0

    for item in raw:
        address = item.get("email", "") if isinstance(item, dict) else item

        if not isinstance(address, str):
            invalid += 1
            continue

        address = address.strip()

        if not valid_email(address):
            invalid += 1
            continue

        key = address.casefold()

        if key not in seen:
            seen.add(key)
            recipients.append(address)

    if len(recipients) > MAX_RECIPIENTS:
        raise ValueError(
            f"Maximum {MAX_RECIPIENTS} unique recipients are allowed per batch."
        )

    return recipients, invalid


def is_authenticated():
    return session.get("authenticated") is True


def config_ready():
    return CONFIG_ERROR is None


def csrf_token():
    token = session.get("csrf_token")

    if not token:
        token = secrets.token_urlsafe(32)
        session["csrf_token"] = token

    return token


def csrf_valid():
    expected = session.get("csrf_token", "")
    supplied = request.headers.get("X-CSRF-Token", "")

    return bool(
        expected and supplied and
        hmac.compare_digest(expected, supplied)
    )


def require_auth():
    if not config_ready():
        return jsonify({
            "ok": False,
            "error": "Server configuration is incomplete. Check Vercel environment variables."
        }), 503

    if not is_authenticated():
        return jsonify({
            "ok": False,
            "error": "Session expired. Please log in again."
        }), 401

    return None


# ============================================================
# PERSONALIZATION
# ============================================================

def recipient_name(address):
    local = address.split("@", 1)[0]
    local = re.sub(r"[._\-0-9]+", " ", local).strip()

    return local.split()[0].capitalize() if local else "there"


def personalize(value, recipient):
    name = recipient_name(recipient)

    replacements = {
        "{{hi}}": f"Hi {name}",
        "{{hello}}": f"Hello {name}",
        "{{thanks}}": "Thank you",
        "{{name}}": name,
        "{{email}}": recipient,
        "{{ref_code}}": secrets.token_hex(4).upper(),
    }

    for key, replacement in replacements.items():
        value = value.replace(key, replacement)

    return value


# ============================================================
# HTML TO TEXT
# ============================================================

class TextExtractor(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []

    def handle_data(self, data):
        self.parts.append(data)

    def get_text(self):
        return " ".join(self.parts)


def html_to_text(value):
    parser = TextExtractor()

    try:
        parser.feed(value)
        return html.unescape(parser.get_text()).strip()
    except Exception:
        return value


# ============================================================
# CONTROLLED SENDING PACE
# ============================================================

def wait_for_send_slot():
    global _last_send_started

    with _pacing_lock:
        now = time.monotonic()
        delay = SEND_DELAY_SECONDS - (now - _last_send_started)

        if delay > 0:
            time.sleep(delay)

        _last_send_started = time.monotonic()


# ============================================================
# BUILD MESSAGE
# ============================================================

def build_message(sender_name, gmail, recipient, subject, body, is_html):
    message = EmailMessage()

    final_subject = personalize(subject, recipient)
    final_body = personalize(body, recipient)

    message["Subject"] = final_subject
    message["From"] = formataddr((sender_name, gmail))
    message["To"] = recipient
    message["Date"] = formatdate(localtime=True)

    if is_html:
        plain = html_to_text(final_body)

        message.set_content(
            plain or "Please view this message in an HTML-compatible email client."
        )

        message.add_alternative(final_body, subtype="html")
    else:
        message.set_content(final_body)

    return message


# ============================================================
# SEND ONE EMAIL
# ============================================================

def send_one_email(
    sender_name,
    gmail,
    app_password,
    recipient,
    subject,
    body,
    is_html,
):
    try:
        wait_for_send_slot()

        message = build_message(
            sender_name,
            gmail,
            recipient,
            subject,
            body,
            is_html,
        )

        context = ssl.create_default_context()

        with smtplib.SMTP_SSL(
            SMTP_HOST,
            SMTP_PORT,
            timeout=SMTP_TIMEOUT,
            context=context,
        ) as server:

            server.login(gmail, app_password)

            refused = server.send_message(
                message,
                from_addr=gmail,
                to_addrs=[recipient],
            )

            if refused:
                return False, "SMTP server refused the recipient."

        return True, None

    except smtplib.SMTPAuthenticationError:
        return False, "Gmail authentication failed. Check the Gmail App Password."

    except smtplib.SMTPRecipientsRefused:
        return False, "Gmail refused this recipient."

    except smtplib.SMTPSenderRefused:
        return False, "Gmail refused the sender address."

    except smtplib.SMTPDataError:
        return False, "Gmail rejected the message data."

    except smtplib.SMTPConnectError:
        return False, "Could not connect to Gmail SMTP."

    except (TimeoutError, OSError):
        return False, "Network or SMTP timeout. Delivery status may be uncertain."

    except smtplib.SMTPException:
        return False, "An SMTP error occurred."

    except Exception:
        logger.exception("Unexpected sending error")
        return False, "Unexpected sending error."


# ============================================================
# LOGIN
# ============================================================

@app.route("/login", methods=["GET", "POST"])
def login():
    if not config_ready():
        return (
            "Server configuration error. Set SESSION_SECRET and LOGIN_PASSWORD in Vercel.",
            503,
        )

    if is_authenticated():
        return redirect(url_for("dashboard"))

    error = None

    if request.method == "POST":
        password = request.form.get("password", "")

        if password and hmac.compare_digest(password, LOGIN_PASSWORD):
            session.clear()
            session["authenticated"] = True
            session["csrf_token"] = secrets.token_urlsafe(32)
            session.permanent = True
            return redirect(url_for("dashboard"))

        error = "Incorrect password. Please try again."

    return render_template("login.html", error=error)


# ============================================================
# DASHBOARD
# ============================================================

@app.route("/", methods=["GET"])
def dashboard():
    if not config_ready():
        return (
            "Server configuration error. Set SESSION_SECRET and LOGIN_PASSWORD in Vercel.",
            503,
        )

    if not is_authenticated():
        return redirect(url_for("login"))

    return render_template(
        "index.html",
        csrf_token=csrf_token(),
    )


# ============================================================
# LOGOUT
# ============================================================

@app.route("/logout", methods=["POST"])
def logout():
    error = require_auth()

    if error:
        return error

    if not csrf_valid():
        return jsonify({
            "ok": False,
            "error": "Security token expired. Refresh the page and try again."
        }), 403

    session.clear()

    response = jsonify({"ok": True, "message": "Logged out."})
    response.delete_cookie(
        app.config.get("SESSION_COOKIE_NAME", "session"),
        path="/",
        secure=True,
        httponly=True,
        samesite="Lax",
    )
    return response


# ============================================================
# HEALTH CHECK
# ============================================================

@app.route("/health", methods=["GET"])
def health():
    if not config_ready():
        return jsonify({"ok": False, "status": "configuration_error"}), 503

    return jsonify({"ok": True, "status": "running"})


# ============================================================
# SEND BATCH
# ============================================================

@app.route("/send-batch", methods=["POST"])
def send_batch():
    error = require_auth()

    if error:
        return error

    if not csrf_valid():
        return jsonify({
            "ok": False,
            "error": "Security token expired. Refresh the dashboard."
        }), 403

    data = request.get_json(silent=True)

    if not isinstance(data, dict):
        return jsonify({"ok": False, "error": "Invalid JSON request."}), 400

    sender_name = data.get("sender_name", "")
    gmail = data.get("gmail", "")
    app_password = data.get("app_password", "")
    subject = data.get("subject", "")
    body = data.get("body", "")
    is_html = data.get("is_html", False)
    consent_confirmed = data.get("consent_confirmed", False)

    if not all(isinstance(x, str) for x in (
        sender_name, gmail, app_password, subject, body
    )):
        return jsonify({"ok": False, "error": "Invalid field type."}), 400

    sender_name = sender_name.strip()[:100]
    gmail = gmail.strip()
    app_password = app_password.replace(" ", "").strip()
    subject = subject.strip()

    if not valid_email(gmail):
        return jsonify({"ok": False, "error": "Enter a valid Gmail address."}), 400

    if gmail.rsplit("@", 1)[-1].lower() not in ("gmail.com", "googlemail.com"):
        return jsonify({"ok": False, "error": "Use a Gmail sender address."}), 400

    if not app_password:
        return jsonify({"ok": False, "error": "Gmail App Password is required."}), 400

    if not subject or not body.strip():
        return jsonify({"ok": False, "error": "Subject and message are required."}), 400

    if len(subject) > 500 or len(body) > 100000:
        return jsonify({"ok": False, "error": "Subject or message is too long."}), 400

    if not isinstance(is_html, bool):
        return jsonify({"ok": False, "error": "Invalid HTML mode."}), 400

    if consent_confirmed is not True:
        return jsonify({
            "ok": False,
            "error": "Confirm that recipients have agreed to receive these emails."
        }), 400

    try:
        recipients, invalid_skipped = normalize_recipients(
            data.get("recipients", [])
        )
    except ValueError as exc:
        return jsonify({"ok": False, "error": str(exc)}), 400

    if not recipients:
        return jsonify({"ok": False, "error": "No valid recipients provided."}), 400

    if not sender_name:
        sender_name = gmail.split("@", 1)[0]

    logger.info(
        "Starting batch: %d valid recipients; %d invalid skipped.",
        len(recipients),
        invalid_skipped,
    )

    # ========================================================
    # STREAMING RESPONSE
    # ========================================================

    @stream_with_context
    def generate():
        total = len(recipients)
        sent = 0
        failed = 0

        yield json.dumps({
            "type": "start",
            "total": total,
            "sent": 0,
            "failed": 0,
            "remaining": total,
            "invalid_skipped": invalid_skipped,
        }) + "\n"

        try:
            with ThreadPoolExecutor(
                max_workers=MAX_PARALLEL_SENDS
            ) as executor:

                future_map = {
                    executor.submit(
                        send_one_email,
                        sender_name,
                        gmail,
                        app_password,
                        recipient,
                        subject,
                        body,
                        is_html,
                    ): recipient
                    for recipient in recipients
                }

                for future in as_completed(future_map):
                    recipient = future_map[future]

                    try:
                        success, error_message = future.result()
                    except Exception:
                        logger.exception("Worker error")
                        success, error_message = False, "Worker failed."

                    if success:
                        sent += 1
                        status = "sent"
                        error_message = None
                    else:
                        failed += 1
                        status = "failed"

                    yield json.dumps({
                        "type": "progress",
                        "recipient": recipient,
                        "result": status,
                        "error": error_message,
                        "total": total,
                        "sent": sent,
                        "failed": failed,
                        "remaining": total - sent - failed,
                    }) + "\n"

            yield json.dumps({
                "type": "complete",
                "success": failed == 0,
                "message": "Batch completed." if failed == 0 else "Batch completed with failures.",
                "total": total,
                "sent": sent,
                "failed": failed,
                "remaining": total - sent - failed,
            }) + "\n"

        except Exception:
            logger.exception("Batch processing failed")

            yield json.dumps({
                "type": "complete",
                "success": False,
                "message": "Batch stopped due to a server error.",
                "total": total,
                "sent": sent,
                "failed": failed,
                "remaining": total - sent - failed,
            }) + "\n"

    response = Response(
        generate(),
        mimetype="application/x-ndjson",
    )

    response.headers["Cache-Control"] = "no-cache, no-store"
    response.headers["X-Accel-Buffering"] = "no"
    response.headers["X-Content-Type-Options"] = "nosniff"

    return response


# ============================================================
# SECURITY HEADERS
# ============================================================

@app.after_request
def security_headers(response):
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Cache-Control"] = "no-store"
    response.headers["Permissions-Policy"] = (
        "camera=(), microphone=(), geolocation=()"
    )
    return response


# ============================================================
# VERCEL
# ============================================================

handler = app
