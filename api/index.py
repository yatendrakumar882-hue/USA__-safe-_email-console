
import os
import re
import hmac
import json
import time
import html
import ssl
import secrets
import logging
import smtplib

from datetime import timedelta
from email.message import EmailMessage
from email.utils import formataddr, formatdate, make_msgid

from flask import (
    Flask, render_template, request, redirect,
    url_for, session, jsonify, Response, stream_with_context
)
from werkzeug.middleware.proxy_fix import ProxyFix


# =========================================================
# PATHS AND APPLICATION
# =========================================================

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEMPLATE_DIR = os.path.join(BASE_DIR, "templates")
STATIC_DIR = os.path.join(BASE_DIR, "static")

app = Flask(
    __name__,
    template_folder=TEMPLATE_DIR,
    static_folder=STATIC_DIR,
    static_url_path="/static"
)

app.wsgi_app = ProxyFix(
    app.wsgi_app,
    x_for=1,
    x_proto=1,
    x_host=1
)

SESSION_SECRET = os.environ.get("SESSION_SECRET")

app.secret_key = SESSION_SECRET or secrets.token_urlsafe(48)

app.config.update(
    SESSION_COOKIE_SECURE=True,
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    PERMANENT_SESSION_LIFETIME=timedelta(hours=1),
    MAX_CONTENT_LENGTH=2 * 1024 * 1024
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


# =========================================================
# SMTP SETTINGS
# =========================================================

SMTP_HOST = "smtp.gmail.com"
SMTP_PORT = 465
SMTP_TIMEOUT = 20

MAX_RECIPIENTS = 25
SEND_DELAY_SECONDS = 0.2

MAX_SUBJECT_LENGTH = 200
MAX_MESSAGE_LENGTH = 30000


# =========================================================
# ENVIRONMENT
# =========================================================

def missing_environment_variables():
    missing = []

    if not os.environ.get("SESSION_SECRET"):
        missing.append("SESSION_SECRET")

    if not os.environ.get("LOGIN_PASSWORD"):
        missing.append("LOGIN_PASSWORD")

    return missing


def is_logged_in():
    return session.get("authenticated") is True


def csrf_token():
    token = session.get("csrf_token")

    if not token:
        token = secrets.token_urlsafe(32)
        session["csrf_token"] = token

    return token


def verify_csrf():
    expected = session.get("csrf_token", "")
    supplied = request.headers.get("X-CSRF-Token", "")

    if not expected or not supplied:
        return False

    return hmac.compare_digest(str(expected), str(supplied))


# =========================================================
# VALIDATION
# =========================================================

EMAIL_RE = re.compile(
    r"^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+"
    r"@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$"
)


def valid_email(value):
    return (
        isinstance(value, str)
        and len(value) <= 254
        and bool(EMAIL_RE.fullmatch(value.strip()))
    )


def clean_text(value, maximum):
    if not isinstance(value, str):
        return ""
    return value.strip()[:maximum]


def parse_recipients(raw):
    if not isinstance(raw, list):
        return None, "Recipients must be a list."

    result = []
    seen = set()

    for item in raw:
        if not isinstance(item, str):
            continue

        address = item.strip().lower()

        if not address or address in seen:
            continue

        if not valid_email(address):
            return None, "Invalid email address: " + address

        seen.add(address)
        result.append(address)

    if not result:
        return None, "Please add at least one recipient."

    if len(result) > MAX_RECIPIENTS:
        return None, "Maximum 25 recipients per batch."

    return result, None


# =========================================================
# PERSONALIZATION
# =========================================================

def personalize(value, recipient):
    local_part = recipient.split("@", 1)[0]
    name = re.sub(r"[._-]+", " ", local_part).strip().title()

    replacements = {
        "{{hi}}": "Hi",
        "{{hello}}": "Hello",
        "{{thanks}}": "Thank you",
        "{{name}}": name or "there",
        "{{email}}": recipient,
        "{{ref_code}}": secrets.token_hex(4).upper()
    }

    for key, replacement in replacements.items():
        value = value.replace(key, replacement)

    return value


# =========================================================
# MESSAGE FORMATTING
# =========================================================

def html_to_text(value):
    value = re.sub(
        r"(?i)<br\s*/?>|</p>|</div>",
        "\n",
        value
    )
    value = re.sub(r"<[^>]+>", "", value)
    return html.unescape(value)


def build_message(
    sender_name,
    sender_email,
    recipient,
    subject,
    body,
    is_html
):
    final_subject = personalize(subject, recipient)
    final_body = personalize(body, recipient)

    message = EmailMessage()

    message["Subject"] = final_subject
    message["From"] = formataddr((sender_name, sender_email))
    message["To"] = recipient
    message["Date"] = formatdate(localtime=True)
    message["Message-ID"] = make_msgid()

    if is_html:
        plain = html_to_text(final_body)

        if not plain.strip():
            plain = "Please view this email in an HTML-capable email client."

        message.set_content(plain)
        message.add_alternative(final_body, subtype="html")
    else:
        message.set_content(final_body)

    return message


# =========================================================
# SEND ONE EMAIL
# =========================================================

def send_one_email(batch, recipient):
    message = build_message(
        batch["sender_name"],
        batch["sender_email"],
        recipient,
        batch["subject"],
        batch["body"],
        batch["is_html"]
    )

    context = ssl.create_default_context()

    with smtplib.SMTP_SSL(
        SMTP_HOST,
        SMTP_PORT,
        timeout=SMTP_TIMEOUT,
        context=context
    ) as server:

        server.login(
            batch["sender_email"],
            batch["app_password"]
        )

        refused = server.send_message(message)

        if refused:
            raise smtplib.SMTPRecipientsRefused(refused)


def send_result(batch, recipient):
    try:
        send_one_email(batch, recipient)

        return {
            "email": recipient,
            "status": "sent",
            "error": None
        }

    except smtplib.SMTPAuthenticationError:
        return {
            "email": recipient,
            "status": "failed",
            "error": "Gmail authentication failed. Check App Password."
        }

    except smtplib.SMTPRecipientsRefused:
        return {
            "email": recipient,
            "status": "failed",
            "error": "Gmail rejected this recipient."
        }

    except smtplib.SMTPResponseException as exc:
        return {
            "email": recipient,
            "status": "failed",
            "error": "SMTP rejected the message. Code: " + str(exc.smtp_code)
        }

    except (smtplib.SMTPException, OSError, ssl.SSLError):
        logger.exception("SMTP error")
        return {
            "email": recipient,
            "status": "failed",
            "error": "SMTP connection or submission failed."
        }

    except Exception:
        logger.exception("Unexpected email error")
        return {
            "email": recipient,
            "status": "failed",
            "error": "Unexpected sending error."
        }


# =========================================================
# HOME
# =========================================================

@app.route("/")
def home():
    if is_logged_in():
        return redirect(url_for("dashboard"))
    return redirect(url_for("login"))


# =========================================================
# LOGIN
# =========================================================

@app.route("/login", methods=["GET", "POST"])
def login():
    missing = missing_environment_variables()

    config_error = (
        "Missing environment variables: " + ", ".join(missing)
        if missing else None
    )

    if request.method == "GET":
        return render_template(
            "login.html",
            error=None,
            config_error=config_error
        )

    if missing:
        return render_template(
            "login.html",
            error="Server configuration is incomplete.",
            config_error=config_error
        ), 503

    submitted = request.form.get("password", "")
    expected = os.environ.get("LOGIN_PASSWORD", "")

    if not hmac.compare_digest(submitted, expected):
        return render_template(
            "login.html",
            error="Incorrect password.",
            config_error=None
        ), 401

    session.clear()
    session.permanent = True
    session["authenticated"] = True
    session["csrf_token"] = secrets.token_urlsafe(32)

    return redirect(url_for("dashboard"))


# =========================================================
# DASHBOARD
# =========================================================

@app.route("/dashboard")
def dashboard():
    if not is_logged_in():
        return redirect(url_for("login"))

    return render_template(
        "index.html",
        csrf_token=csrf_token()
    )


# =========================================================
# LOGOUT
# =========================================================

@app.route("/logout", methods=["GET", "POST"])
def logout():
    if request.method == "POST":
        if not is_logged_in():
            return jsonify({"ok": False, "error": "Not logged in."}), 401

        if not verify_csrf():
            return jsonify({
                "ok": False,
                "error": "Security token expired. Refresh the page."
            }), 403

    session.clear()

    if request.method == "POST":
        return jsonify({"ok": True})

    return redirect(url_for("login"))


# =========================================================
# HEALTH CHECK
# =========================================================

@app.route("/health")
def health():
    return jsonify({
        "ok": True,
        "service": "Secure Mail Console",
        "login_template_exists": os.path.isfile(
            os.path.join(TEMPLATE_DIR, "login.html")
        ),
        "dashboard_template_exists": os.path.isfile(
            os.path.join(TEMPLATE_DIR, "index.html")
        ),
        "static_directory_exists": os.path.isdir(STATIC_DIR)
    })


# =========================================================
# SEND BATCH
# =========================================================

@app.route("/send-batch", methods=["POST"])
def send_batch():

    if not is_logged_in():
        return jsonify({
            "ok": False,
            "error": "Please log in again."
        }), 401

    if not verify_csrf():
        return jsonify({
            "ok": False,
            "error": "Security token expired. Refresh the dashboard."
        }), 403

    data = request.get_json(silent=True)

    if not isinstance(data, dict):
        return jsonify({
            "ok": False,
            "error": "Invalid JSON request."
        }), 400

    if data.get("consent") is not True:
        return jsonify({
            "ok": False,
            "error": "Recipient permission confirmation is required."
        }), 400

    sender_name = clean_text(data.get("sender_name"), 80)
    sender_email = clean_text(data.get("gmail"), 254).lower()
    app_password = data.get("app_password", "")
    subject = clean_text(data.get("subject"), MAX_SUBJECT_LENGTH)
    body = data.get("body", "")
    is_html = data.get("is_html") is True

    if not sender_name:
        return jsonify({"ok": False, "error": "Sender name is required."}), 400

    if not valid_email(sender_email):
        return jsonify({"ok": False, "error": "Invalid Gmail address."}), 400

    if not isinstance(app_password, str):
        return jsonify({"ok": False, "error": "Invalid App Password."}), 400

    app_password = re.sub(r"\s+", "", app_password)

    if not 12 <= len(app_password) <= 64:
        return jsonify({"ok": False, "error": "Check Gmail App Password."}), 400

    if not subject:
        return jsonify({"ok": False, "error": "Subject is required."}), 400

    if not isinstance(body, str) or not body.strip():
        return jsonify({"ok": False, "error": "Message body is required."}), 400

    if len(body) > MAX_MESSAGE_LENGTH:
        return jsonify({"ok": False, "error": "Message is too long."}), 400

    recipients, error = parse_recipients(data.get("recipients"))

    if error:
        return jsonify({"ok": False, "error": error}), 400

    # Independent snapshot for this batch.
    batch = {
        "sender_name": sender_name,
        "sender_email": sender_email,
        "app_password": app_password,
        "subject": subject,
        "body": body,
        "is_html": is_html,
        "recipients": tuple(recipients)
    }

    @stream_with_context
    def generate():
        total = len(batch["recipients"])
        sent = 0
        failed = 0

        try:
            yield json.dumps({
                "event": "start",
                "total": total
            }) + "\n"

            for index, recipient in enumerate(batch["recipients"]):
                result = send_result(batch, recipient)

                if result["status"] == "sent":
                    sent += 1
                else:
                    failed += 1

                yield json.dumps({
                    "event": "progress",
                    "email": result["email"],
                    "status": result["status"],
                    "error": result["error"],
                    "sent": sent,
                    "failed": failed,
                    "total": total
                }) + "\n"

                if index < total - 1:
                    time.sleep(SEND_DELAY_SECONDS)

            yield json.dumps({
                "event": "complete",
                "sent": sent,
                "failed": failed,
                "total": total,
                "message": "Batch processing finished."
            }) + "\n"

        finally:
            batch["app_password"] = ""

    return Response(
        generate(),
        mimetype="application/x-ndjson",
        headers={
            "Cache-Control": "no-cache, no-store",
            "X-Accel-Buffering": "no"
        }
    )


# =========================================================
# ERROR HANDLERS
# =========================================================

@app.errorhandler(413)
def request_too_large(error):
    return jsonify({
        "ok": False,
        "error": "Request is too large."
    }), 413


@app.errorhandler(404)
def not_found(error):
    return "Page not found.", 404


@app.errorhandler(500)
def internal_error(error):
    logger.exception("Flask application error")
    return "Internal Server Error. Check Vercel Runtime Logs.", 500


# =========================================================
# VERCEL ENTRY POINT
# =========================================================

handler = app
