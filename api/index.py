
import os
import re
import ssl
import time
import hmac
import html
import logging
import secrets
import smtplib
import threading

from datetime import timedelta
from email.message import EmailMessage
from email.utils import formataddr, make_msgid
from concurrent.futures import ThreadPoolExecutor, as_completed

from flask import (
    Flask,
    request,
    jsonify,
    redirect,
    url_for,
    render_template,
    session,
    Response,
    stream_with_context,
)

# --------------------------------------------------
# CONFIGURATION
# --------------------------------------------------

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

SMTP_HOST = "smtp.gmail.com"
SMTP_PORT = 465
SMTP_TIMEOUT = 25

MAX_RECIPIENTS = 25

# Slightly faster sending configuration
MAX_PARALLEL_SENDS = 5
SEND_DELAY_SECONDS = 1.5

SESSION_SECRET = os.environ.get("SESSION_SECRET", "")
LOGIN_PASSWORD = os.environ.get("LOGIN_PASSWORD", "")

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(
    __name__,
    template_folder=os.path.join(BASE_DIR, "templates"),
    static_folder=os.path.join(BASE_DIR, "static"),
)

# Fallback key only prevents Flask from failing during import.
# Authentication routes remain unavailable until SESSION_SECRET is configured.
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

# Process-local pacing. This does not coordinate multiple Vercel instances.
_pacing_lock = threading.Lock()
_last_send_started = 0.0


# --------------------------------------------------
# CONFIGURATION CHECK
# --------------------------------------------------

def configuration_ready():
    return (
        bool(SESSION_SECRET)
        and len(SESSION_SECRET) >= 32
        and bool(LOGIN_PASSWORD)
    )


def configuration_error():
    if not SESSION_SECRET:
        return "SESSION_SECRET environment variable is missing."

    if len(SESSION_SECRET) < 32:
        return "SESSION_SECRET must contain at least 32 characters."

    if not LOGIN_PASSWORD:
        return "LOGIN_PASSWORD environment variable is missing."

    return None


# --------------------------------------------------
# SECURITY HEADERS
# --------------------------------------------------

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


# --------------------------------------------------
# HELPERS
# --------------------------------------------------

def is_valid_email(email):
    if not isinstance(email, str):
        return False

    email = email.strip()

    if len(email) > 254:
        return False

    if not EMAIL_RE.fullmatch(email):
        return False

    return True


def normalize_recipients(raw_recipients):
    """
    Accepts:
      ["person@example.com", ...]
      [{"email": "person@example.com"}, ...]
    """

    if not isinstance(raw_recipients, list):
        raise ValueError("Recipients must be a list.")

    if len(raw_recipients) > MAX_RECIPIENTS:
        raise ValueError(
            f"Maximum {MAX_RECIPIENTS} recipients are allowed per batch."
        )

    valid = []
    invalid_count = 0
    seen = set()

    for item in raw_recipients:
        if isinstance(item, dict):
            email = item.get("email", "")
        else:
            email = item

        if not isinstance(email, str):
            invalid_count += 1
            continue

        email = email.strip()

        if not is_valid_email(email):
            invalid_count += 1
            continue

        key = email.lower()

        if key in seen:
            continue

        seen.add(key)
        valid.append(email)

    return valid, invalid_count


def personalize(value, recipient):
    """
    Supported placeholders:
    {{hi}}, {{hello}}, {{thanks}},
    {{name}}, {{email}}, {{ref_code}}
    """

    if not isinstance(value, str):
        return ""

    email = recipient.strip()
    local_part = email.split("@", 1)[0]

    # Make a readable name from the email local part.
    name = re.sub(r"[._+-]+", " ", local_part)
    name = " ".join(part.capitalize() for part in name.split())

    replacements = {
        "{{hi}}": "Hi",
        "{{hello}}": "Hello",
        "{{thanks}}": "Thank you",
        "{{name}}": name,
        "{{email}}": email,
        "{{ref_code}}": "",
    }

    for placeholder, replacement in replacements.items():
        value = value.replace(placeholder, replacement)

    return value


def html_to_text(value):
    if not isinstance(value, str):
        return ""

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
    value = html.unescape(value)

    return value.strip()


def wait_for_send_slot():
    """
    Spaces email start times within this Python process.
    Multiple Vercel instances may have independent pacing.
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


def clean_error(error):
    """
    Avoid returning credentials or internal exception details.
    """

    message = str(error)

    message = message.replace("\r", " ").replace("\n", " ")
    message = re.sub(r"\s+", " ", message)

    if len(message) > 250:
        message = message[:250]

    return message or "Email could not be sent."


def make_message(
    sender_name,
    gmail,
    recipient,
    subject,
    body,
    is_html,
):
    message = EmailMessage()

    safe_sender_name = " ".join(
        str(sender_name or "").replace("\r", " ").replace("\n", " ").split()
    )

    safe_subject = str(subject or "").replace("\r", " ").replace("\n", " ")

    personalized_subject = personalize(safe_subject, recipient)
    personalized_body = personalize(body, recipient)

    message["Subject"] = personalized_subject
    message["From"] = formataddr((safe_sender_name, gmail))
    message["To"] = recipient
    message["Reply-To"] = gmail
    message["Date"] = time.strftime(
        "%a, %d %b %Y %H:%M:%S %z"
    )
    message["Message-ID"] = make_msgid()

    if is_html:
        plain_text = html_to_text(personalized_body)

        if not plain_text:
            plain_text = "Please view this email in an HTML-compatible email client."

        message.set_content(plain_text)
        message.add_alternative(
            personalized_body,
            subtype="html",
        )
    else:
        message.set_content(personalized_body)

    return message


# --------------------------------------------------
# SMTP SENDING
# --------------------------------------------------

def send_one_email(
    sender_name,
    gmail,
    app_password,
    recipient,
    subject,
    body,
    is_html,
):
    wait_for_send_slot()

    message = make_message(
        sender_name=sender_name,
        gmail=gmail,
        recipient=recipient,
        subject=subject,
        body=body,
        is_html=is_html,
    )

    context = ssl.create_default_context()

    try:
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
                return {
                    "success": False,
                    "error": "Recipient server refused the message.",
                }

        return {
            "success": True,
            "error": None,
        }

    except smtplib.SMTPAuthenticationError:
        return {
            "success": False,
            "error": (
                "Gmail authentication failed. Check the Gmail address "
                "and App Password."
            ),
        }

    except smtplib.SMTPRecipientsRefused:
        return {
            "success": False,
            "error": "Recipient address was refused by the mail server.",
        }

    except smtplib.SMTPSenderRefused:
        return {
            "success": False,
            "error": "Gmail refused the sender address.",
        }

    except smtplib.SMTPDataError:
        return {
            "success": False,
            "error": "The mail server rejected the message content.",
        }

    except (TimeoutError, OSError):
        return {
            "success": False,
            "error": (
                "SMTP connection timed out or could not be established."
            ),
        }

    except Exception as error:
        logger.exception("Email sending failed")
        return {
            "success": False,
            "error": clean_error(error),
        }


# --------------------------------------------------
# LOGIN REQUIRED DECORATOR
# --------------------------------------------------

def login_required(function):
    from functools import wraps

    @wraps(function)
    def wrapper(*args, **kwargs):

        if not configuration_ready():
            return (
                "Server authentication is not configured. "
                "Please set SESSION_SECRET and LOGIN_PASSWORD.",
                503,
            )

        if not session.get("authenticated"):
            return redirect(url_for("login"))

        return function(*args, **kwargs)

    return wrapper


# --------------------------------------------------
# LOGIN
# --------------------------------------------------

@app.route("/login", methods=["GET", "POST"])
def login():

    if not configuration_ready():
        return (
            "Login is unavailable. Configure SESSION_SECRET "
            "and LOGIN_PASSWORD in Vercel Environment Variables.",
            503,
        )

    if request.method == "GET":
        if session.get("authenticated"):
            return redirect(url_for("index"))

        return render_template("login.html")

    password = request.form.get("password", "")

    if not password:
        return render_template(
            "login.html",
            error="Please enter your password.",
        )

    if hmac.compare_digest(password, LOGIN_PASSWORD):
        session.clear()
        session["authenticated"] = True
        session.permanent = True

        return redirect(url_for("index"))

    return render_template(
        "login.html",
        error="Incorrect password. Please try again.",
    )


# --------------------------------------------------
# LOGOUT
# --------------------------------------------------

@app.route("/logout", methods=["POST"])
@login_required
def logout():
    session.clear()

    response = jsonify({
        "success": True,
        "message": "Logged out successfully.",
    })

    response.delete_cookie(
        app.config.get("SESSION_COOKIE_NAME", "session"),
        path="/",
    )

    return response


# --------------------------------------------------
# DASHBOARD
# --------------------------------------------------

@app.route("/", methods=["GET"])
@login_required
def index():
    return render_template("index.html")


# --------------------------------------------------
# HEALTH CHECK
# --------------------------------------------------

@app.route("/health", methods=["GET"])
def health():
    return jsonify({
        "status": "ok",
        "smtp_host": SMTP_HOST,
        "smtp_port": SMTP_PORT,
        "configuration_ready": configuration_ready(),
    })


@app.route("/favicon.ico", methods=["GET"])
def favicon():
    return "", 204


@app.route("/sw.js", methods=["GET"])
def service_worker():
    return "", 204


# --------------------------------------------------
# SEND BATCH
# --------------------------------------------------

@app.route("/send-batch", methods=["POST"])
@login_required
def send_batch():

    data = request.get_json(silent=True)

    if not isinstance(data, dict):
        return jsonify({
            "success": False,
            "error": "Invalid JSON request.",
        }), 400

    sender_name = data.get("sender_name", "")
    gmail = data.get("gmail", "")
    app_password = data.get("app_password", "")
    subject = data.get("subject", "")
    body = data.get("body", "")
    is_html = data.get("is_html", False)
    recipients_input = data.get("recipients", [])
    consent_confirmed = data.get("consent_confirmed", False)

    # Validate consent.
    if consent_confirmed is not True:
        return jsonify({
            "success": False,
            "error": "Please confirm that recipients have consented to receive your email.",
        }), 400

    # Validate sender information.
    if not isinstance(gmail, str):
        return jsonify({
            "success": False,
            "error": "Invalid Gmail address.",
        }), 400

    gmail = gmail.strip()

    if not is_valid_email(gmail):
        return jsonify({
            "success": False,
            "error": "Please enter a valid Gmail address.",
        }), 400

    if not gmail.lower().endswith("@gmail.com"):
        return jsonify({
            "success": False,
            "error": "This SMTP configuration requires a Gmail account.",
        }), 400

    if not isinstance(app_password, str) or not app_password.strip():
        return jsonify({
            "success": False,
            "error": "Please enter your Gmail App Password.",
        }), 400

    # Gmail App Passwords are commonly displayed with spaces.
    app_password = app_password.replace(" ", "").strip()

    if not isinstance(subject, str) or not subject.strip():
        return jsonify({
            "success": False,
            "error": "Please enter an email subject.",
        }), 400

    if not isinstance(body, str) or not body.strip():
        return jsonify({
            "success": False,
            "error": "Please enter an email message.",
        }), 400

    if len(subject) > 500:
        return jsonify({
            "success": False,
            "error": "Subject is too long.",
        }), 400

    if len(body) > 100000:
        return jsonify({
            "success": False,
            "error": "Email body is too long.",
        }), 400

    if not isinstance(is_html, bool):
        is_html = False

    if not isinstance(sender_name, str):
        sender_name = ""

    sender_name = sender_name.strip()[:100]

    # Normalize recipients.
    try:
        recipients, invalid_skipped = normalize_recipients(
            recipients_input
        )
    except ValueError as error:
        return jsonify({
            "success": False,
            "error": str(error),
        }), 400

    if not recipients:
        return jsonify({
            "success": False,
            "error": "No valid recipient email addresses were provided.",
        }), 400

    total = len(recipients)

    # --------------------------------------------------
    # STREAMING RESPONSE
    # --------------------------------------------------

    @stream_with_context
    def generate():

        sent = 0
        failed = 0
        remaining = total

        def event(payload):
            import json
            return json.dumps(payload, ensure_ascii=False) + "\n"

        yield event({
            "type": "start",
            "total": total,
            "sent": sent,
            "failed": failed,
            "remaining": remaining,
            "invalid_skipped": invalid_skipped,
        })

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

                except Exception as error:
                    logger.exception("Unexpected worker error")

                    result = {
                        "success": False,
                        "error": clean_error(error),
                    }

                if result.get("success"):
                    sent += 1
                    status = "sent"
                    error_message = None
                else:
                    failed += 1
                    status = "failed"
                    error_message = result.get("error", "Sending failed.")

                remaining = total - sent - failed

                yield event({
                    "type": "progress",
                    "recipient": recipient,
                    "result": status,
                    "error": error_message,
                    "total": total,
                    "sent": sent,
                    "failed": failed,
                    "remaining": remaining,
                })

        yield event({
            "type": "complete",
            "success": failed == 0,
            "message": (
                "Batch processing completed. SMTP acceptance does not "
                "confirm Inbox placement."
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


# --------------------------------------------------
# VERCEL HANDLER
# --------------------------------------------------

handler = app
