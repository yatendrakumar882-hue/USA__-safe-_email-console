
import os
import re
import ssl
import time
import html
import json
import secrets
import logging
import smtplib
import threading

from pathlib import Path
from datetime import timedelta
from email.message import EmailMessage
from email.utils import formataddr
from concurrent.futures import ThreadPoolExecutor, as_completed

from flask import (
    Flask, request, render_template, redirect,
    url_for, session, jsonify, Response,
    stream_with_context
)
from werkzeug.middleware.proxy_fix import ProxyFix


# ------------------------------------------------------------
# APP CONFIGURATION
# ------------------------------------------------------------

BASE_DIR = Path(__file__).resolve().parent.parent

app = Flask(
    __name__,
    template_folder=str(BASE_DIR / "templates"),
    static_folder=str(BASE_DIR / "static"),
    static_url_path="/static",
)

app.wsgi_app = ProxyFix(
    app.wsgi_app,
    x_for=1,
    x_proto=1,
    x_host=1,
)

SESSION_SECRET = os.environ.get("SESSION_SECRET", "")
LOGIN_PASSWORD = os.environ.get("LOGIN_PASSWORD", "")

if len(SESSION_SECRET) < 32:
    raise RuntimeError("Set SESSION_SECRET to a random value of at least 32 characters.")

if not LOGIN_PASSWORD:
    raise RuntimeError("Set LOGIN_PASSWORD in Vercel Environment Variables.")

app.secret_key = SESSION_SECRET

app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SECURE=True,
    SESSION_COOKIE_SAMESITE="Lax",
    PERMANENT_SESSION_LIFETIME=timedelta(hours=1),
    MAX_CONTENT_LENGTH=512 * 1024,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("mail_console")


# ------------------------------------------------------------
# SMTP AND SENDING SETTINGS
# ------------------------------------------------------------

SMTP_HOST = "smtp.gmail.com"
SMTP_PORT = 465
SMTP_TIMEOUT = 25

MAX_RECIPIENTS = 25
MAX_PARALLEL_SENDS = 4

# Minimum interval between SMTP connection starts in this instance.
SEND_DELAY_SECONDS = 0.60

_ssl_context = ssl.create_default_context()
_pacing_lock = threading.Lock()
_next_send_time = 0.0


# ------------------------------------------------------------
# VALIDATION
# ------------------------------------------------------------

EMAIL_RE = re.compile(
    r"^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+"
    r"@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$"
)


def valid_email(value):
    if not isinstance(value, str):
        return False

    value = value.strip()

    return (
        len(value) <= 254
        and ".." not in value
        and EMAIL_RE.fullmatch(value) is not None
    )


def clean_header(value, limit=200):
    value = str(value or "")
    value = value.replace("\r", " ").replace("\n", " ")
    return value.strip()[:limit]


def parse_recipients(value):
    if isinstance(value, str):
        items = re.split(r"[\n,;]+", value)
    elif isinstance(value, list):
        items = value
    else:
        return []

    result = []
    seen = set()

    for item in items:
        if not isinstance(item, str):
            continue

        address = item.strip().lower()

        if address and address not in seen:
            seen.add(address)
            result.append(address)

    return result


# ------------------------------------------------------------
# LOGIN AND CSRF
# ------------------------------------------------------------

def logged_in():
    return session.get("authenticated") is True


def csrf_token():
    token = session.get("csrf_token")

    if not token:
        token = secrets.token_urlsafe(32)
        session["csrf_token"] = token

    return token


def check_csrf():
    supplied = request.headers.get("X-CSRF-Token", "")
    expected = session.get("csrf_token", "")

    return bool(
        supplied
        and expected
        and secrets.compare_digest(str(supplied), str(expected))
    )


def unauthorized():
    return jsonify({
        "ok": False,
        "error": "Your session expired. Please log in again."
    }), 401


# ------------------------------------------------------------
# BASIC ROUTES
# ------------------------------------------------------------

@app.route("/", methods=["GET"])
def home():
    return redirect(url_for("dashboard" if logged_in() else "login"))


@app.route("/login", methods=["GET", "POST"])
def login():
    if logged_in() and request.method == "GET":
        return redirect(url_for("dashboard"))

    error = None

    if request.method == "POST":
        password = request.form.get("password", "")

        if secrets.compare_digest(str(password), LOGIN_PASSWORD):
            session.clear()
            session.permanent = True
            session["authenticated"] = True
            session["csrf_token"] = secrets.token_urlsafe(32)
            return redirect(url_for("dashboard"))

        error = "Incorrect password. Please try again."

    return render_template("login.html", error=error)


@app.route("/dashboard", methods=["GET"])
def dashboard():
    if not logged_in():
        return redirect(url_for("login"))

    return render_template(
        "index.html",
        csrf_token=csrf_token()
    )


@app.route("/logout", methods=["GET", "POST"])
def logout():
    if request.method == "GET":
        if logged_in():
            return redirect(url_for("dashboard"))
        return redirect(url_for("login"))

    if not logged_in():
        return unauthorized()

    if not check_csrf():
        return jsonify({
            "ok": False,
            "error": "Invalid security token."
        }), 403

    session.clear()

    response = jsonify({"ok": True})
    response.headers["Cache-Control"] = "no-store"
    return response


@app.route("/health", methods=["GET"])
def health():
    return jsonify({
        "ok": True,
        "service": "Secure Mail Console",
        "smtp": SMTP_HOST,
        "max_recipients": MAX_RECIPIENTS,
        "parallel_workers": MAX_PARALLEL_SENDS,
    })


# ------------------------------------------------------------
# PERSONALIZATION
# ------------------------------------------------------------

def first_name_from_email(address):
    local = address.split("@", 1)[0]
    local = re.sub(r"[._-]+", " ", local)
    local = re.sub(r"[^A-Za-z0-9 ]", "", local)
    parts = local.split()

    return parts[0].capitalize() if parts else "Friend"


def personalize(value, recipient, ref_code):
    name = first_name_from_email(recipient)

    replacements = {
        "{{hi}}": "Hi",
        "{{hello}}": "Hello",
        "{{thanks}}": "Thank you",
        "{{name}}": name,
        "{{email}}": recipient,
        "{{ref_code}}": ref_code,
    }

    result = str(value or "")

    for key, replacement in replacements.items():
        result = result.replace(key, replacement)

    return result


def html_to_text(value):
    value = re.sub(r"(?i)<\s*br\s*/?\s*>", "\n", value)
    value = re.sub(
        r"(?i)</\s*(p|div|li|h[1-6])\s*>",
        "\n",
        value,
    )
    value = re.sub(r"<[^>]+>", "", value)
    return html.unescape(value).strip()


# ------------------------------------------------------------
# MESSAGE CREATION
# ------------------------------------------------------------

def build_message(
    sender_name,
    gmail,
    recipient,
    subject,
    body,
    is_html,
    ref_code,
):
    final_subject = personalize(subject, recipient, ref_code)
    final_body = personalize(body, recipient, ref_code)

    message = EmailMessage()
    message["Subject"] = clean_header(final_subject, 200)
    message["From"] = formataddr((
        clean_header(sender_name, 100),
        gmail,
    ))
    message["To"] = recipient

    if is_html:
        plain = html_to_text(final_body)

        message.set_content(
            plain or "Please view this message in an HTML-compatible email client."
        )
        message.add_alternative(final_body, subtype="html")
    else:
        message.set_content(final_body)

    return message


# ------------------------------------------------------------
# PROCESS-LOCAL PACING
# ------------------------------------------------------------

def wait_for_send_slot():
    global _next_send_time

    with _pacing_lock:
        now = time.monotonic()
        scheduled = max(now, _next_send_time)
        _next_send_time = scheduled + SEND_DELAY_SECONDS
        delay = scheduled - now

    if delay > 0:
        time.sleep(delay)


# ------------------------------------------------------------
# SEND ONE MESSAGE
# ------------------------------------------------------------

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
        ref_code = secrets.token_hex(6).upper()

        message = build_message(
            sender_name,
            gmail,
            recipient,
            subject,
            body,
            is_html,
            ref_code,
        )

        wait_for_send_slot()

        with smtplib.SMTP_SSL(
            SMTP_HOST,
            SMTP_PORT,
            timeout=SMTP_TIMEOUT,
            context=_ssl_context,
        ) as server:
            server.login(gmail, app_password)
            server.send_message(
                message,
                from_addr=gmail,
                to_addrs=[recipient],
            )

        return {
            "email": recipient,
            "status": "sent",
            "error": None,
        }

    except smtplib.SMTPAuthenticationError:
        return {
            "email": recipient,
            "status": "failed",
            "error": "Gmail authentication failed. Check your App Password.",
        }

    except smtplib.SMTPRecipientsRefused:
        return {
            "email": recipient,
            "status": "failed",
            "error": "Gmail refused this recipient.",
        }

    except smtplib.SMTPException as exc:
        logger.warning("SMTP error: %s", type(exc).__name__)
        return {
            "email": recipient,
            "status": "failed",
            "error": "SMTP error: " + type(exc).__name__,
        }

    except (TimeoutError, OSError):
        logger.warning("SMTP network or timeout error.")
        return {
            "email": recipient,
            "status": "failed",
            "error": "SMTP connection or network error.",
        }

    except Exception as exc:
        logger.exception("Unexpected send error: %s", type(exc).__name__)
        return {
            "email": recipient,
            "status": "failed",
            "error": "Unexpected sending error.",
        }


# ------------------------------------------------------------
# STREAMING EVENTS
# ------------------------------------------------------------

def event_line(data):
    return json.dumps(data, ensure_ascii=False) + "\n"


# ------------------------------------------------------------
# SEND BATCH API
# ------------------------------------------------------------

@app.route("/send-batch", methods=["POST"])
def send_batch():
    if not logged_in():
        return unauthorized()

    if not check_csrf():
        return jsonify({
            "ok": False,
            "error": "Security token invalid. Refresh the page."
        }), 403

    data = request.get_json(silent=True)

    if not isinstance(data, dict):
        return jsonify({
            "ok": False,
            "error": "Invalid JSON request."
        }), 400

    sender_name = clean_header(data.get("sender_name", ""), 100)
    gmail = str(data.get("gmail", "")).strip().lower()
    app_password = re.sub(r"\s+", "", str(data.get("app_password", "")))
    subject = clean_header(data.get("subject", ""), 200)
    body = data.get("body", "")
    is_html = data.get("is_html") is True
    consent = data.get("consent") is True

    recipients = parse_recipients(data.get("recipients", []))

    if not sender_name:
        return jsonify({"ok": False, "error": "Sender Name is required."}), 400

    if not valid_email(gmail):
        return jsonify({"ok": False, "error": "Enter a valid Gmail address."}), 400

    if not app_password or len(app_password) < 8 or len(app_password) > 100:
        return jsonify({"ok": False, "error": "Gmail App Password is missing or invalid."}), 400

    if not subject:
        return jsonify({"ok": False, "error": "Email subject is required."}), 400

    if not isinstance(body, str) or not body.strip():
        return jsonify({"ok": False, "error": "Email message body is required."}), 400

    if len(body) > 100000:
        return jsonify({"ok": False, "error": "Message is too large."}), 400

    if not consent:
        return jsonify({"ok": False, "error": "Please confirm recipient consent."}), 400

    if not recipients:
        return jsonify({"ok": False, "error": "Enter at least one recipient."}), 400

    if len(recipients) > MAX_RECIPIENTS:
        return jsonify({
            "ok": False,
            "error": "Maximum 25 unique recipients are allowed per batch."
        }), 400

    invalid = [address for address in recipients if not valid_email(address)]

    if invalid:
        return jsonify({
            "ok": False,
            "error": "Invalid recipient address: " + ", ".join(invalid[:5])
        }), 400

    total = len(recipients)

    def generate():
        sent_count = 0
        failed_count = 0

        yield event_line({
            "event": "start",
            "total": total,
        })

        try:
            with ThreadPoolExecutor(max_workers=MAX_PARALLEL_SENDS) as executor:
                futures = {
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

                for future in as_completed(futures):
                    try:
                        result = future.result()
                    except Exception:
                        result = {
                            "email": futures[future],
                            "status": "failed",
                            "error": "Worker failed unexpectedly.",
                        }

                    if result["status"] == "sent":
                        sent_count += 1
                    else:
                        failed_count += 1

                    yield event_line({
                        "event": "progress",
                        "email": result["email"],
                        "status": result["status"],
                        "error": result["error"],
                        "sent": sent_count,
                        "failed": failed_count,
                        "total": total,
                    })

            yield event_line({
                "event": "complete",
                "sent": sent_count,
                "failed": failed_count,
                "total": total,
                "message": (
                    f"Completed: {sent_count} accepted by Gmail, "
                    f"{failed_count} failed."
                ),
            })

        except Exception as exc:
            logger.exception("Batch error: %s", type(exc).__name__)
            yield event_line({
                "event": "error",
                "error": "Batch processing failed. Check Vercel Function Logs.",
            })

    response = Response(
        stream_with_context(generate()),
        content_type="application/x-ndjson; charset=utf-8",
    )

    response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Accel-Buffering"] = "no"

    return response


# Vercel Python entry point
handler = app
