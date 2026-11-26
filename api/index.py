
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
from email.utils import formataddr
from concurrent.futures import ThreadPoolExecutor, as_completed

from flask import (
    Flask,
    request,
    jsonify,
    render_template,
    redirect,
    url_for,
    session,
    Response,
    stream_with_context,
)

from werkzeug.security import safe_join


# ============================================================
# CONFIGURATION
# ============================================================

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

app = Flask(
    __name__,
    template_folder=os.path.join(BASE_DIR, "templates"),
    static_folder=os.path.join(BASE_DIR, "static"),
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


# Required Vercel environment variables
SESSION_SECRET = os.environ.get("SESSION_SECRET", "")
LOGIN_PASSWORD = os.environ.get("LOGIN_PASSWORD", "")

CONFIG_ERROR = None

if len(SESSION_SECRET) < 32:
    CONFIG_ERROR = "SESSION_SECRET must contain at least 32 characters."

if not LOGIN_PASSWORD:
    CONFIG_ERROR = "LOGIN_PASSWORD is missing."

# Never use an insecure fixed secret as a fallback.
# If the environment variable is missing, protected routes return 503.
app.secret_key = SESSION_SECRET if len(SESSION_SECRET) >= 32 else secrets.token_hex(32)

app.config.update(
    SESSION_COOKIE_SECURE=True,
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    PERMANENT_SESSION_LIFETIME=timedelta(hours=1),
    MAX_CONTENT_LENGTH=1024 * 1024,
)


# Gmail SMTP settings
SMTP_HOST = "smtp.gmail.com"
SMTP_PORT = 465
SMTP_TIMEOUT = 20

MAX_RECIPIENTS = 25

# Controlled sending settings
MAX_PARALLEL_SENDS = 3
SEND_DELAY_SECONDS = 1.0

# Process-local pacing. On Vercel, separate instances do not share this lock.
_pacing_lock = threading.Lock()
_last_send_started = 0.0


# ============================================================
# EMAIL VALIDATION
# ============================================================

EMAIL_RE = re.compile(
    r"^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+"
    r"@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$"
)


def valid_email(value):
    if not isinstance(value, str):
        return False

    value = value.strip()

    if len(value) > 254 or len(value) < 6:
        return False

    if not EMAIL_RE.fullmatch(value):
        return False

    if ".." in value:
        return False

    return True


def normalize_recipients(raw_recipients):
    """
    Accepts:
      ["a@example.com", ...]
      [{"email": "a@example.com"}, ...]
    Returns valid unique addresses and invalid count.
    """

    if not isinstance(raw_recipients, list):
        raise ValueError("Recipients must be a list.")

    unique = []
    seen = set()
    invalid_count = 0

    for item in raw_recipients:

        if isinstance(item, dict):
            address = item.get("email", "")
        else:
            address = item

        if not isinstance(address, str):
            invalid_count += 1
            continue

        address = address.strip()

        if not valid_email(address):
            invalid_count += 1
            continue

        key = address.lower()

        if key not in seen:
            seen.add(key)
            unique.append(address)

    if len(unique) > MAX_RECIPIENTS:
        raise ValueError(
            f"Maximum {MAX_RECIPIENTS} unique recipients are allowed per batch."
        )

    return unique, invalid_count


# ============================================================
# PERSONALIZATION
# ============================================================

def get_first_name(email_address):
    local = email_address.split("@", 1)[0]

    local = re.sub(r"[._\-0-9]+", " ", local)
    local = local.strip()

    if not local:
        return "there"

    return local.split()[0].capitalize()


def personalize(value, recipient):
    if not isinstance(value, str):
        return ""

    name = get_first_name(recipient)

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

from html.parser import HTMLParser


class HTMLTextExtractor(HTMLParser):

    def __init__(self):
        super().__init__()
        self.parts = []

    def handle_data(self, data):
        self.parts.append(data)

    def get_text(self):
        return " ".join(self.parts)


def html_to_text(value):
    parser = HTMLTextExtractor()

    try:
        parser.feed(value)
        return html.unescape(parser.get_text())
    except Exception:
        return value


# ============================================================
# CSRF PROTECTION
# ============================================================

def create_csrf_token():
    token = session.get("csrf_token")

    if not token:
        token = secrets.token_urlsafe(32)
        session["csrf_token"] = token

    return token


def csrf_valid():
    expected = session.get("csrf_token", "")
    supplied = request.headers.get("X-CSRF-Token", "")

    if not expected or not supplied:
        return False

    return hmac.compare_digest(expected, supplied)


def configuration_ready():
    return CONFIG_ERROR is None


def authenticated():
    return session.get("authenticated") is True


def protected_error():
    if not configuration_ready():
        return jsonify({
            "ok": False,
            "error": "Server configuration is incomplete. Check Vercel environment variables."
        }), 503

    if not authenticated():
        return jsonify({
            "ok": False,
            "error": "Your session has expired. Please log in again."
        }), 401

    return None


# ============================================================
# SENDING PACING
# ============================================================

def wait_for_send_slot():
    """
    Spaces out the start of SMTP connections within this
    running Python process.

    This is not a global rate limiter across Vercel instances.
    """

    global _last_send_started

    with _pacing_lock:

        now = time.monotonic()

        wait_time = (
            SEND_DELAY_SECONDS - (now - _last_send_started)
        )

        if wait_time > 0:
            time.sleep(wait_time)

        _last_send_started = time.monotonic()


# ============================================================
# BUILD EMAIL
# ============================================================

def build_message(
    sender_name,
    gmail,
    recipient,
    subject,
    body,
    is_html,
):
    personalized_subject = personalize(subject, recipient)
    personalized_body = personalize(body, recipient)

    message = EmailMessage()

    message["Subject"] = personalized_subject

    message["From"] = formataddr(
        (sender_name, gmail)
    )

    message["To"] = recipient

    message["Date"] = time.strftime(
        "%a, %d %b %Y %H:%M:%S %z"
    )

    if is_html:
        plain_body = html_to_text(personalized_body)

        message.set_content(plain_body or "Please view this message in an HTML-compatible email client.")

        message.add_alternative(
            personalized_body,
            subtype="html"
        )

    else:
        message.set_content(personalized_body)

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
            sender_name=sender_name,
            gmail=gmail,
            recipient=recipient,
            subject=subject,
            body=body,
            is_html=is_html,
        )

        context = ssl.create_default_context()

        with smtplib.SMTP_SSL(
            SMTP_HOST,
            SMTP_PORT,
            timeout=SMTP_TIMEOUT,
            context=context,
        ) as server:

            server.login(
                gmail,
                app_password
            )

            refused = server.send_message(
                message,
                from_addr=gmail,
                to_addrs=[recipient],
            )

            if refused:
                return {
                    "success": False,
                    "error": "Recipient was refused by the SMTP server."
                }

        return {
            "success": True,
            "error": None
        }

    except smtplib.SMTPAuthenticationError:
        return {
            "success": False,
            "error": "Gmail authentication failed. Check Gmail address and App Password."
        }

    except smtplib.SMTPRecipientsRefused:
        return {
            "success": False,
            "error": "Gmail SMTP refused this recipient."
        }

    except smtplib.SMTPSenderRefused:
        return {
            "success": False,
            "error": "Gmail SMTP refused the sender address."
        }

    except smtplib.SMTPDataError:
        return {
            "success": False,
            "error": "Gmail SMTP rejected the message data."
        }

    except smtplib.SMTPConnectError:
        return {
            "success": False,
            "error": "Could not connect to Gmail SMTP."
        }

    except (TimeoutError, OSError):
        return {
            "success": False,
            "error": "Network or SMTP timeout. Delivery status may be uncertain."
        }

    except smtplib.SMTPException:
        return {
            "success": False,
            "error": "SMTP error occurred while sending."
        }

    except Exception:
        logger.exception("Unexpected email sending error")

        return {
            "success": False,
            "error": "Unexpected sending error."
        }


# ============================================================
# LOGIN
# ============================================================

@app.route("/login", methods=["GET", "POST"])
def login():

    if not configuration_ready():
        return (
            "Server configuration error. Please configure SESSION_SECRET "
            "and LOGIN_PASSWORD in Vercel.",
            503,
        )

    if authenticated():
        return redirect(url_for("dashboard"))

    error = None

    if request.method == "POST":

        password = request.form.get("password", "")

        if not password:
            error = "Please enter your password."

        elif hmac.compare_digest(password, LOGIN_PASSWORD):

            session.clear()

            session["authenticated"] = True
            session["csrf_token"] = secrets.token_urlsafe(32)
            session.permanent = True

            return redirect(url_for("dashboard"))

        else:
            error = "Incorrect password. Please try again."

    return render_template(
        "login.html",
        error=error,
        csrf_token=create_csrf_token(),
    )


# ============================================================
# LOGOUT
# ============================================================

@app.route("/logout", methods=["POST"])
def logout():

    error = protected_error()

    if error:
        return error

    if not csrf_valid():
        return jsonify({
            "ok": False,
            "error": "Security token expired. Refresh the page and try again."
        }), 403

    session.clear()

    response = jsonify({
        "ok": True,
        "message": "Logged out successfully."
    })

    response.delete_cookie(
        app.config.get("SESSION_COOKIE_NAME", "session"),
        path="/",
        secure=True,
        httponly=True,
        samesite="Lax",
    )

    return response


# ============================================================
# DASHBOARD
# ============================================================

@app.route("/", methods=["GET"])
def dashboard():

    if not configuration_ready():
        return (
            "Server configuration error. Configure SESSION_SECRET "
            "and LOGIN_PASSWORD in Vercel.",
            503,
        )

    if not authenticated():
        return redirect(url_for("login"))

    return render_template(
        "index.html",
        csrf_token=create_csrf_token(),
    )


# ============================================================
# HEALTH CHECK
# ============================================================

@app.route("/health", methods=["GET"])
def health():

    if not configuration_ready():
        return jsonify({
            "ok": False,
            "status": "configuration_error",
        }), 503

    return jsonify({
        "ok": True,
        "status": "running",
    })


# ============================================================
# SEND BATCH
# ============================================================

@app.route("/send-batch", methods=["POST"])
def send_batch():

    error = protected_error()

    if error:
        return error

    if not csrf_valid():
        return jsonify({
            "ok": False,
            "error": "Security token expired. Refresh the dashboard and try again."
        }), 403

    data = request.get_json(silent=True)

    if not isinstance(data, dict):
        return jsonify({
            "ok": False,
            "error": "Invalid JSON request."
        }), 400

    sender_name = data.get("sender_name", "")
    gmail = data.get("gmail", "")
    app_password = data.get("app_password", "")
    subject = data.get("subject", "")
    body = data.get("body", "")
    is_html = data.get("is_html", False)
    consent_confirmed = data.get("consent_confirmed", False)

    if not isinstance(sender_name, str):
        return jsonify({"ok": False, "error": "Invalid sender name."}), 400

    if not isinstance(gmail, str):
        return jsonify({"ok": False, "error": "Invalid Gmail address."}), 400

    if not isinstance(app_password, str):
        return jsonify({"ok": False, "error": "Invalid App Password."}), 400

    if not isinstance(subject, str) or not isinstance(body, str):
        return jsonify({"ok": False, "error": "Subject and message must be text."}), 400

    sender_name = sender_name.strip()
    gmail = gmail.strip()
    app_password = app_password.replace(" ", "").strip()
    subject = subject.strip()

    if not gmail or not valid_email(gmail):
        return jsonify({
            "ok": False,
            "error": "Enter a valid Gmail address."
        }), 400

    if gmail.lower().split("@")[-1] not in ("gmail.com", "googlemail.com"):
        return jsonify({
            "ok": False,
            "error": "Please use a Gmail or Google Mail sender address."
        }), 400

    if not app_password:
        return jsonify({
            "ok": False,
            "error": "Gmail App Password is required."
        }), 400

    if not subject:
        return jsonify({
            "ok": False,
            "error": "Email subject is required."
        }), 400

    if not body.strip():
        return jsonify({
            "ok": False,
            "error": "Email message cannot be empty."
        }), 400

    if len(subject) > 500 or len(body) > 100000:
        return jsonify({
            "ok": False,
            "error": "Subject or message is too long."
        }), 400

    if not isinstance(is_html, bool):
        return jsonify({
            "ok": False,
            "error": "Invalid HTML mode."
        }), 400

    if consent_confirmed is not True:
        return jsonify({
            "ok": False,
            "error": "Recipient consent confirmation is required."
        }), 400

    try:
        recipients, invalid_skipped = normalize_recipients(
            data.get("recipients", [])
        )

    except ValueError as exc:
        return jsonify({
            "ok": False,
            "error": str(exc)
        }), 400

    if not recipients:
        return jsonify({
            "ok": False,
            "error": "No valid recipient addresses were provided."
        }), 400

    if not sender_name:
        sender_name = gmail.split("@")[0][:100]

    # Do not log the App Password or email message content.
    logger.info(
        "Starting batch: %s valid recipients; %s invalid skipped.",
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
            "sent": sent,
            "failed": failed,
            "remaining": total,
            "invalid_skipped": invalid_skipped,
        }) + "\n"

        try:

            with ThreadPoolExecutor(
                max_workers=MAX_PARALLEL_SENDS
            ) as executor:

                future_map = {}

                for recipient in recipients:

                    future = executor.submit(
                        send_one_email,
                        sender_name,
                        gmail,
                        app_password,
                        recipient,
                        subject,
                        body,
                        is_html,
                    )

                    future_map[future] = recipient

                for future in as_completed(future_map):

                    recipient = future_map[future]

                    try:
                        result = future.result()

                    except Exception:
                        logger.exception(
                            "Unexpected worker failure"
                        )

                        result = {
                            "success": False,
                            "error": "Email worker failed."
                        }

                    if result["success"]:
                        sent += 1
                        status = "sent"
                        error_message = None

                    else:
                        failed += 1
                        status = "failed"
                        error_message = result.get("error")

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
                "message": (
                    "Batch completed."
                    if failed == 0
                    else "Batch completed with some failures."
                ),
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
                "message": "Batch processing stopped because of a server error.",
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
def add_security_headers(response):

    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Cache-Control"] = "no-store"

    response.headers["Permissions-Policy"] = (
        "camera=(), microphone=(), geolocation=()"
    )

    return response


# ============================================================
# VERCEL HANDLER
# ============================================================

handler = app
