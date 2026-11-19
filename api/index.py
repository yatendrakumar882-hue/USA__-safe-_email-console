
import os
import re
import ssl
import time
import json
import html
import hmac
import smtplib
import logging
import threading

from pathlib import Path
from datetime import timedelta
from concurrent.futures import ThreadPoolExecutor, as_completed
from email.message import EmailMessage
from email.utils import formataddr, make_msgid, formatdate

from flask import (
    Flask,
    request,
    render_template,
    redirect,
    url_for,
    jsonify,
    session,
    Response,
    stream_with_context,
)

from jinja2 import TemplateNotFound


# =========================================================
# APPLICATION
# =========================================================

BASE_DIR = Path(__file__).resolve().parent.parent

app = Flask(
    __name__,
    template_folder=str(BASE_DIR / "templates"),
    static_folder=str(BASE_DIR / "static"),
    static_url_path="/static",
)

# Vercel Python runtime entry point
handler = app

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


# =========================================================
# SECURITY CONFIGURATION
# =========================================================

SESSION_SECRET = os.environ.get("SESSION_SECRET", "").strip()
LOGIN_PASSWORD = os.environ.get("LOGIN_PASSWORD", "").strip()

# A dedicated stable secret is required.
# Do not use LOGIN_PASSWORD as the session signing key.
SESSION_KEY = (
    SESSION_SECRET
    if len(SESSION_SECRET) >= 32
    else None
)

if not SESSION_KEY:
    logger.error(
        "SESSION_SECRET is missing or shorter than 32 characters."
    )

if not LOGIN_PASSWORD:
    logger.error("LOGIN_PASSWORD is not configured.")

app.secret_key = SESSION_KEY or "unconfigured-session-key"

app.config.update(
    SESSION_COOKIE_SECURE=True,
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    PERMANENT_SESSION_LIFETIME=timedelta(hours=1),
    MAX_CONTENT_LENGTH=1_000_000,
)


# =========================================================
# SMTP CONFIGURATION
# =========================================================

SMTP_HOST = "smtp.gmail.com"
SMTP_PORT = 465
SMTP_TIMEOUT = 20

MAX_RECIPIENTS = 25
MAX_PARALLEL_SENDS = 2
SEND_DELAY_SECONDS = 0.1

# Keep the existing sending pace.
_pacing_lock = threading.Lock()
_last_send_started = 0.0


# =========================================================
# EMAIL VALIDATION
# =========================================================

EMAIL_RE = re.compile(
    r"^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+"
    r"@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$"
)


def clean(value, limit=250):
    """Remove header line breaks and limit input length."""
    value = str(value or "")
    value = value.replace("\r", " ").replace("\n", " ")
    return value.strip()[:limit]


def valid_email(value):
    if not isinstance(value, str):
        return False

    value = value.strip()

    return (
        len(value) <= 254
        and bool(EMAIL_RE.fullmatch(value))
    )


def logged_in():
    return session.get("authenticated") is True


def error(message, status=400):
    return jsonify({
        "success": False,
        "message": message,
    }), status


def event_line(data):
    return json.dumps(
        data,
        ensure_ascii=False
    ) + "\n"


# =========================================================
# HTML TO PLAIN TEXT
# =========================================================

def html_to_text(value):
    value = str(value or "")

    value = re.sub(
        r"(?i)<\s*br\s*/?\s*>",
        "\n",
        value
    )

    value = re.sub(
        r"(?i)</\s*(p|div|li|h[1-6]|tr)\s*>",
        "\n",
        value
    )

    value = re.sub(
        r"(?i)<\s*li\b[^>]*>",
        "- ",
        value
    )

    value = re.sub(r"<[^>]*>", " ", value)
    value = html.unescape(value)
    value = re.sub(r"[ \t]+", " ", value)
    value = re.sub(r" *\n *", "\n", value)
    value = re.sub(r"\n{3,}", "\n\n", value)

    return value.strip()


# =========================================================
# RECIPIENT NORMALIZATION
# =========================================================

def normalize_recipient(item):

    if isinstance(item, str):
        item = {"email": item}

    if not isinstance(item, dict):
        return None

    address = str(
        item.get("email", "")
    ).strip().lower()

    if not valid_email(address):
        return None

    recipient = {"email": address}

    for key in (
        "name",
        "hi",
        "hello",
        "thanks",
        "ref_code",
    ):
        recipient[key] = clean(
            item.get(key, ""),
            150
        )

    return recipient


# =========================================================
# PERSONALIZATION
# =========================================================

def personalize(value, recipient):

    result = str(value or "")

    replacements = {
        "{{hi}}": recipient.get("hi") or "Hi",
        "{{hello}}": recipient.get("hello") or "Hello",
        "{{thanks}}": recipient.get("thanks") or "Thank you",
        "{{name}}": recipient.get("name") or "there",
        "{{email}}": recipient.get("email", ""),
        "{{ref_code}}": recipient.get("ref_code") or "",
    }

    for placeholder, replacement in replacements.items():
        result = result.replace(
            placeholder,
            replacement
        )

    return result


# =========================================================
# SEND PACING
# =========================================================

def wait_for_send_slot():

    global _last_send_started

    with _pacing_lock:

        now = time.monotonic()

        remaining = SEND_DELAY_SECONDS - (
            now - _last_send_started
        )

        if remaining > 0:
            time.sleep(remaining)

        _last_send_started = time.monotonic()


# =========================================================
# BUILD MESSAGE
# =========================================================

def build_message(
    gmail,
    sender_name,
    subject,
    body,
    is_html,
    recipient,
):

    message = EmailMessage()

    message["Subject"] = clean(
        personalize(subject, recipient),
        250
    )

    message["From"] = formataddr((
        clean(sender_name, 150),
        gmail
    ))

    message["To"] = recipient["email"]
    message["Date"] = formatdate(localtime=True)
    message["Message-ID"] = make_msgid()

    content = personalize(body, recipient)

    if is_html:

        plain_content = html_to_text(content)

        message.set_content(
            plain_content or
            "Please view this message in an HTML-capable email client."
        )

        message.add_alternative(
            content,
            subtype="html"
        )

    else:
        message.set_content(content)

    return message


# =========================================================
# SMTP SEND ONE
# =========================================================

def send_one(
    gmail,
    app_password,
    sender_name,
    subject,
    body,
    is_html,
    recipient,
):

    message = build_message(
        gmail=gmail,
        sender_name=sender_name,
        subject=subject,
        body=body,
        is_html=is_html,
        recipient=recipient,
    )

    wait_for_send_slot()

    password = re.sub(
        r"\s+",
        "",
        app_password
    )

    context = ssl.create_default_context()

    with smtplib.SMTP_SSL(
        SMTP_HOST,
        SMTP_PORT,
        context=context,
        timeout=SMTP_TIMEOUT,
    ) as smtp:

        smtp.ehlo()
        smtp.login(gmail, password)

        refused = smtp.send_message(
            message,
            from_addr=gmail,
            to_addrs=[recipient["email"]],
        )

        if refused:
            raise smtplib.SMTPRecipientsRefused(refused)


# =========================================================
# LOGIN
# =========================================================

@app.route("/login", methods=["GET", "POST"])
def login():

    if logged_in():
        return redirect(url_for("home"))

    if request.method == "GET":
        return render_template(
            "login.html",
            error=None
        )

    if not LOGIN_PASSWORD:
        return render_template(
            "login.html",
            error="LOGIN_PASSWORD is not configured in Vercel."
        ), 503

    if not SESSION_KEY:
        return render_template(
            "login.html",
            error="Set a valid SESSION_SECRET in Vercel."
        ), 503

    submitted = str(
        request.form.get("password", "")
    )

    if not hmac.compare_digest(
        submitted,
        LOGIN_PASSWORD
    ):

        return render_template(
            "login.html",
            error="Incorrect password."
        ), 401

    session.clear()
    session.permanent = True
    session["authenticated"] = True

    return redirect(url_for("home"))


# =========================================================
# LOGOUT
# =========================================================

@app.route("/logout", methods=["GET", "POST"])
def logout():

    session.clear()

    return redirect(url_for("login"))


# =========================================================
# HOME
# =========================================================

@app.route("/")
def home():

    if not logged_in():
        return redirect(url_for("login"))

    try:
        return render_template("index.html")

    except TemplateNotFound:

        logger.exception("index.html template not found")

        return (
            "Missing file: templates/index.html",
            500
        )


# =========================================================
# HEALTH CHECK
# =========================================================

@app.route("/health")
def health():

    return jsonify({
        "status": "ok",
        "smtp_host": SMTP_HOST,
        "smtp_port": SMTP_PORT,
        "smtp_ssl": True,
        "max_recipients": MAX_RECIPIENTS,
        "max_parallel_sends": MAX_PARALLEL_SENDS,
        "send_delay_seconds": SEND_DELAY_SECONDS,
        "login_password_configured": bool(LOGIN_PASSWORD),
        "session_secret_configured": bool(SESSION_KEY),
    })


# =========================================================
# FAVICON AND SERVICE WORKER
# =========================================================

@app.route("/favicon.ico")
def favicon():
    return Response("", status=204)


@app.route("/sw.js")
def service_worker():
    return Response(
        "",
        mimetype="application/javascript"
    )


# =========================================================
# SMTP ERROR DESCRIPTION
# =========================================================

def smtp_error_text(exc):

    code = getattr(exc, "smtp_code", None)
    detail = getattr(exc, "smtp_error", None)

    if isinstance(detail, bytes):
        detail = detail.decode(
            "utf-8",
            errors="replace"
        )

    if detail is None:
        detail = str(exc)

    detail = str(detail)[:200]

    if code is not None:
        return f"SMTP error {code}: {detail}"

    return detail


# =========================================================
# SEND BATCH
# =========================================================

@app.route("/send-batch", methods=["POST"])
def send_batch():

    if not logged_in():

        return jsonify({
            "success": False,
            "message": "Please log in again.",
            "login_required": True,
        }), 401

    data = request.get_json(silent=True)

    if not isinstance(data, dict):
        return error("Invalid JSON request.")

    sender_name = clean(
        data.get("sender_name", ""),
        150
    )

    gmail = clean(
        data.get("gmail", ""),
        254
    ).lower()

    app_password = str(
        data.get("app_password", "")
    ).strip()

    subject = clean(
        data.get("subject", ""),
        250
    )

    body = str(
        data.get("body", "")
    )

    is_html = data.get("is_html") is True

    incoming = data.get("recipients", [])

    if not sender_name:
        return error("Sender name is required.")

    if (
        not valid_email(gmail)
        or not gmail.endswith("@gmail.com")
    ):
        return error("Enter a valid Gmail sender address.")

    if not app_password:
        return error("Gmail App Password is required.")

    if not subject:
        return error("Email subject is required.")

    if not body.strip():
        return error("Email body is required.")

    if len(body) > 100_000:
        return error("Email body is too large.")

    if not isinstance(incoming, list):
        return error("Recipients must be a list.")

    if data.get("consent_confirmed") is not True:
        return error(
            "Confirm that all recipients agreed to receive these emails."
        )

    # Validate and deduplicate recipients.
    recipients = []
    seen = set()
    invalid = 0
    duplicate = 0

    for item in incoming:

        recipient = normalize_recipient(item)

        if recipient is None:
            invalid += 1
            continue

        address = recipient["email"]

        if address in seen:
            duplicate += 1
            continue

        seen.add(address)
        recipients.append(recipient)

    if not recipients:
        return error("No valid recipients found.")

    if len(recipients) > MAX_RECIPIENTS:
        return error(
            f"Maximum {MAX_RECIPIENTS} unique recipients per batch."
        )

    # -----------------------------------------------------
    # STREAMING PROGRESS
    # -----------------------------------------------------

    def generate():

        total = len(recipients)

        sent = 0
        failed = 0

        yield event_line({
            "type": "start",
            "total": total,
            "sent": 0,
            "failed": 0,
            "remaining": total,
            "invalid_skipped": invalid,
            "duplicate_skipped": duplicate,
        })

        with ThreadPoolExecutor(
            max_workers=min(
                MAX_PARALLEL_SENDS,
                total
            )
        ) as executor:

            futures = {
                executor.submit(
                    send_one,
                    gmail,
                    app_password,
                    sender_name,
                    subject,
                    body,
                    is_html,
                    recipient,
                ): recipient
                for recipient in recipients
            }

            for future in as_completed(futures):

                recipient = futures[future]

                try:

                    future.result()

                    sent += 1

                    result = {
                        "result": "sent",
                    }

                except smtplib.SMTPAuthenticationError:

                    failed += 1

                    result = {
                        "result": "failed",
                        "error": (
                            "Gmail authentication failed. "
                            "Check your App Password."
                        ),
                    }

                except smtplib.SMTPRecipientsRefused as exc:

                    failed += 1

                    result = {
                        "result": "failed",
                        "error": smtp_error_text(exc),
                    }

                except smtplib.SMTPResponseException as exc:

                    failed += 1

                    result = {
                        "result": "failed",
                        "error": smtp_error_text(exc),
                    }

                except (
                    smtplib.SMTPException,
                    TimeoutError,
                    OSError,
                ) as exc:

                    failed += 1

                    result = {
                        "result": "failed",
                        "error": (
                            f"SMTP/network error: {str(exc)[:200]}"
                        ),
                    }

                except Exception as exc:

                    failed += 1

                    logger.exception(
                        "Unexpected sending error"
                    )

                    result = {
                        "result": "failed",
                        "error": (
                            f"Unexpected error: {type(exc).__name__}"
                        ),
                    }

                progress = {
                    "type": "progress",
                    "recipient": recipient["email"],
                    "total": total,
                    "sent": sent,
                    "failed": failed,
                    "remaining": total - sent - failed,
                }

                progress.update(result)

                yield event_line(progress)

        yield event_line({
            "type": "complete",
            "success": failed == 0,
            "message": (
                "Sending attempts completed. "
                "SMTP acceptance does not confirm Inbox delivery."
            ),
            "total": total,
            "sent": sent,
            "failed": failed,
            "remaining": 0,
        })

    response = Response(
        stream_with_context(generate()),
        content_type="application/x-ndjson; charset=utf-8",
    )

    response.headers["Cache-Control"] = (
        "no-store, no-cache, no-transform"
    )

    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Accel-Buffering"] = "no"

    return response


# =========================================================
# ERROR HANDLERS
# =========================================================

@app.errorhandler(413)
def request_too_large(exc):
    return error("Request is too large.", 413)


@app.errorhandler(404)
def not_found(exc):

    return jsonify({
        "success": False,
        "message": "Page not found.",
    }), 404


@app.errorhandler(500)
def internal_error(exc):

    logger.exception("Application internal server error")

    return jsonify({
        "success": False,
        "message": (
            "Internal server error. "
            "Check Vercel Runtime Logs."
        ),
    }), 500


# =========================================================
# LOCAL DEVELOPMENT
# =========================================================

if __name__ == "__main__":

    app.run(
        host="0.0.0.0",
        port=5000,
        debug=False,
    )
