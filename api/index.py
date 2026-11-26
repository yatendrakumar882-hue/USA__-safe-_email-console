
import os
import re
import ssl
import time
import hmac
import html
import json
import secrets
import logging
import threading
import smtplib

from datetime import timedelta
from functools import wraps
from email.message import EmailMessage
from email.utils import formataddr, make_msgid, formatdate
from concurrent.futures import ThreadPoolExecutor, as_completed

from flask import (
    Flask, request, jsonify, redirect, url_for,
    render_template, session, Response, stream_with_context
)

# ---------------- CONFIG ----------------

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

SMTP_HOST = "smtp.gmail.com"
SMTP_PORT = 465
SMTP_TIMEOUT = 25

MAX_RECIPIENTS = 25
MAX_PARALLEL_SENDS = 3
SEND_DELAY_SECONDS = 0.8

SESSION_SECRET = os.environ.get("SESSION_SECRET", "")
LOGIN_PASSWORD = os.environ.get("LOGIN_PASSWORD", "")

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(
    __name__,
    template_folder=os.path.join(BASE_DIR, "templates"),
    static_folder=os.path.join(BASE_DIR, "static"),
)

app.secret_key = SESSION_SECRET or secrets.token_hex(32)

app.config.update(
    SESSION_COOKIE_SECURE=True,
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    PERMANENT_SESSION_LIFETIME=timedelta(hours=1),
    MAX_CONTENT_LENGTH=1024 * 1024,
)

EMAIL_RE = re.compile(
    r"^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@"
    r"[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$"
)

_pacing_lock = threading.Lock()
_last_send_started = 0.0


# ---------------- CONFIG CHECK ----------------

def configuration_ready():
    return (
        bool(SESSION_SECRET)
        and len(SESSION_SECRET) >= 32
        and bool(LOGIN_PASSWORD)
    )


def require_configuration():
    if not SESSION_SECRET or len(SESSION_SECRET) < 32:
        return "Set SESSION_SECRET to a random value of at least 32 characters."
    if not LOGIN_PASSWORD:
        return "Set LOGIN_PASSWORD in Vercel Environment Variables."
    return None


# ---------------- SECURITY ----------------

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


def login_required(fn):
    @wraps(fn)
    def wrapper(*args, **kwargs):
        if not configuration_ready():
            return (
                "Server login is not configured. Set SESSION_SECRET "
                "and LOGIN_PASSWORD in Vercel.",
                503,
            )

        if not session.get("authenticated"):
            return redirect(url_for("login"))

        return fn(*args, **kwargs)
    return wrapper


def csrf_valid():
    token = request.headers.get("X-CSRF-Token", "")
    expected = session.get("csrf_token", "")
    return bool(token and expected and hmac.compare_digest(token, expected))


# ---------------- EMAIL HELPERS ----------------

def valid_email(value):
    return (
        isinstance(value, str)
        and len(value.strip()) <= 254
        and EMAIL_RE.fullmatch(value.strip()) is not None
    )


def normalize_recipients(items):
    if not isinstance(items, list):
        raise ValueError("Recipients must be a list.")

    if len(items) > MAX_RECIPIENTS:
        raise ValueError(f"Maximum {MAX_RECIPIENTS} recipients per batch.")

    valid = []
    invalid = 0
    seen = set()

    for item in items:
        address = item.get("email", "") if isinstance(item, dict) else item

        if not valid_email(address):
            invalid += 1
            continue

        address = address.strip()
        key = address.lower()

        if key not in seen:
            seen.add(key)
            valid.append(address)

    return valid, invalid


def personalize(value, recipient):
    if not isinstance(value, str):
        return ""

    local = recipient.split("@", 1)[0]
    name = re.sub(r"[._+-]+", " ", local)
    name = " ".join(word.capitalize() for word in name.split())

    replacements = {
        "{{hi}}": "Hi",
        "{{hello}}": "Hello",
        "{{thanks}}": "Thank you",
        "{{name}}": name,
        "{{email}}": recipient,
        "{{ref_code}}": "",
    }

    for key, replacement in replacements.items():
        value = value.replace(key, replacement)

    return value


def html_to_text(value):
    value = re.sub(
        r"(?is)<(script|style).*?>.*?</\1>",
        "",
        value,
    )
    value = re.sub(
        r"(?i)<br\s*/?>|</p>|</div>|</li>",
        "\n",
        value,
    )
    value = re.sub(r"<[^>]+>", "", value)
    return html.unescape(value).strip()


def make_message(sender_name, gmail, recipient, subject, body, is_html):
    message = EmailMessage()

    sender_name = " ".join(
        str(sender_name or "").replace("\r", " ").replace("\n", " ").split()
    )
    subject = str(subject).replace("\r", " ").replace("\n", " ")

    message["Subject"] = personalize(subject, recipient)
    message["From"] = formataddr((sender_name, gmail))
    message["To"] = recipient
    message["Date"] = formatdate(localtime=True)
    message["Message-ID"] = make_msgid()

    personalized_body = personalize(body, recipient)

    if is_html:
        plain = html_to_text(personalized_body)
        if not plain:
            plain = "Please view this message in an HTML-compatible email client."

        message.set_content(plain)
        message.add_alternative(personalized_body, subtype="html")
    else:
        message.set_content(personalized_body)

    return message


def wait_for_send_slot():
    global _last_send_started

    with _pacing_lock:
        now = time.monotonic()
        delay = SEND_DELAY_SECONDS - (now - _last_send_started)

        if delay > 0:
            time.sleep(delay)

        _last_send_started = time.monotonic()


def send_one(gmail, app_password, sender_name, recipient, subject, body, is_html):
    wait_for_send_slot()

    message = make_message(
        sender_name, gmail, recipient, subject, body, is_html
    )

    try:
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
                return False, "Recipient server refused the message."

        # This means SMTP accepted the message, not confirmed Inbox placement.
        return True, None

    except smtplib.SMTPAuthenticationError:
        return False, "Gmail authentication failed. Check Gmail and App Password."

    except smtplib.SMTPRecipientsRefused:
        return False, "Recipient address was refused by the mail server."

    except smtplib.SMTPSenderRefused:
        return False, "Gmail refused the sender address."

    except smtplib.SMTPDataError:
        return False, "The mail server rejected the message."

    except (TimeoutError, OSError):
        return False, "SMTP connection timed out or could not be established."

    except Exception:
        logger.exception("Unexpected SMTP sending error")
        return False, "Unexpected SMTP error. Check server logs."


# ---------------- LOGIN ----------------

@app.route("/login", methods=["GET", "POST"])
def login():
    if not configuration_ready():
        return (
            "Login configuration missing. Set SESSION_SECRET "
            "(minimum 32 characters) and LOGIN_PASSWORD in Vercel.",
            503,
        )

    if request.method == "GET":
        if session.get("authenticated"):
            return redirect(url_for("index"))
        return render_template("login.html")

    password = request.form.get("password", "")

    if password and hmac.compare_digest(password, LOGIN_PASSWORD):
        session.clear()
        session["authenticated"] = True
        session["csrf_token"] = secrets.token_urlsafe(32)
        session.permanent = True
        return redirect(url_for("index"))

    return render_template(
        "login.html",
        error="Incorrect password. Please try again.",
    )


@app.route("/logout", methods=["POST"])
@login_required
def logout():
    if not csrf_valid():
        return jsonify({"success": False, "error": "Invalid security token."}), 403

    session.clear()
    response = jsonify({"success": True})
    response.delete_cookie("session", path="/")
    return response


# ---------------- DASHBOARD ----------------

@app.route("/", methods=["GET"])
@login_required
def index():
    return render_template(
        "index.html",
        csrf_token=session.get("csrf_token", ""),
    )


@app.route("/health", methods=["GET"])
def health():
    return jsonify({
        "status": "ok",
        "configuration_ready": configuration_ready(),
        "smtp_host": SMTP_HOST,
        "smtp_port": SMTP_PORT,
    })


@app.route("/favicon.ico", methods=["GET"])
def favicon():
    return "", 204


@app.route("/sw.js", methods=["GET"])
def service_worker():
    return "", 204


# ---------------- SEND BATCH ----------------

@app.route("/send-batch", methods=["POST"])
@login_required
def send_batch():
    if not csrf_valid():
        return jsonify({
            "success": False,
            "error": "Security token expired. Refresh the page and try again.",
        }), 403

    data = request.get_json(silent=True)

    if not isinstance(data, dict):
        return jsonify({"success": False, "error": "Invalid JSON request."}), 400

    if data.get("consent_confirmed") is not True:
        return jsonify({
            "success": False,
            "error": "Confirm that every recipient agreed to receive your email.",
        }), 400

    gmail = data.get("gmail", "")
    app_password = data.get("app_password", "")
    sender_name = data.get("sender_name", "")
    subject = data.get("subject", "")
    body = data.get("body", "")
    is_html = data.get("is_html", False)

    if not valid_email(gmail):
        return jsonify({"success": False, "error": "Enter a valid Gmail address."}), 400

    gmail = gmail.strip()

    if not gmail.lower().endswith("@gmail.com"):
        return jsonify({
            "success": False,
            "error": "This SMTP setup requires a Gmail address.",
        }), 400

    if not isinstance(app_password, str) or not app_password.strip():
        return jsonify({"success": False, "error": "Enter your Gmail App Password."}), 400

    app_password = app_password.replace(" ", "").strip()

    if not isinstance(subject, str) or not subject.strip():
        return jsonify({"success": False, "error": "Enter an email subject."}), 400

    if not isinstance(body, str) or not body.strip():
        return jsonify({"success": False, "error": "Enter an email message."}), 400

    if len(subject) > 500 or len(body) > 100000:
        return jsonify({"success": False, "error": "Subject or message is too long."}), 400

    if not isinstance(sender_name, str):
        sender_name = ""

    if not isinstance(is_html, bool):
        is_html = False

    try:
        recipients, invalid_skipped = normalize_recipients(
            data.get("recipients", [])
        )
    except ValueError as error:
        return jsonify({"success": False, "error": str(error)}), 400

    if not recipients:
        return jsonify({
            "success": False,
            "error": "No valid recipient addresses found.",
        }), 400

    total = len(recipients)

    @stream_with_context
    def generate():
        sent = 0
        failed = 0

        def emit(payload):
            return json.dumps(payload, ensure_ascii=False) + "\n"

        yield emit({
            "type": "start",
            "total": total,
            "sent": 0,
            "failed": 0,
            "remaining": total,
            "invalid_skipped": invalid_skipped,
        })

        with ThreadPoolExecutor(max_workers=MAX_PARALLEL_SENDS) as executor:
            jobs = {
                executor.submit(
                    send_one,
                    gmail,
                    app_password,
                    sender_name,
                    recipient,
                    subject,
                    body,
                    is_html,
                ): recipient
                for recipient in recipients
            }

            for future in as_completed(jobs):
                recipient = jobs[future]

                try:
                    ok, error = future.result()
                except Exception:
                    logger.exception("Worker failed unexpectedly")
                    ok, error = False, "Unexpected worker error."

                if ok:
                    sent += 1
                    result = "sent"
                else:
                    failed += 1
                    result = "failed"

                yield emit({
                    "type": "progress",
                    "recipient": recipient,
                    "result": result,
                    "error": error,
                    "total": total,
                    "sent": sent,
                    "failed": failed,
                    "remaining": total - sent - failed,
                })

        yield emit({
            "type": "complete",
            "success": failed == 0,
            "message": (
                "SMTP processing finished. 'Sent' means the SMTP server "
                "accepted the message; it does not confirm Inbox placement."
            ),
            "total": total,
            "sent": sent,
            "failed": failed,
            "remaining": 0,
            "invalid_skipped": invalid_skipped,
        })

    return Response(
        generate(),
        mimetype="application/x-ndjson",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
        },
    )


# Vercel Python entry point
handler = app
