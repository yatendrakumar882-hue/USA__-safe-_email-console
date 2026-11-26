
import os
import re
import ssl
import json
import time
import html
import secrets
import logging
import smtplib
import threading
import itertools

from pathlib import Path
from datetime import timedelta
from email.message import EmailMessage
from email.utils import formataddr
from concurrent.futures import ThreadPoolExecutor, as_completed

from flask import (
    Flask,
    request,
    render_template,
    redirect,
    url_for,
    session,
    jsonify,
    Response,
    stream_with_context,
)

from werkzeug.middleware.proxy_fix import ProxyFix


# ============================================================
# PATHS AND FLASK CONFIGURATION
# ============================================================

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

app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SECURE=True,
    SESSION_COOKIE_SAMESITE="Lax",
    PERMANENT_SESSION_LIFETIME=timedelta(hours=1),
    MAX_CONTENT_LENGTH=512 * 1024,
)


# ============================================================
# ENVIRONMENT VARIABLES
# ============================================================

SESSION_SECRET = os.environ.get("SESSION_SECRET", "").strip()
LOGIN_PASSWORD = os.environ.get("LOGIN_PASSWORD", "")

if len(SESSION_SECRET) < 32:
    raise RuntimeError(
        "SESSION_SECRET must be configured in Vercel "
        "and must contain at least 32 characters."
    )

if not LOGIN_PASSWORD:
    raise RuntimeError(
        "LOGIN_PASSWORD is missing from Vercel Environment Variables."
    )

app.secret_key = SESSION_SECRET


# ============================================================
# SMTP SETTINGS
# ============================================================

SMTP_HOST = "smtp.gmail.com"
SMTP_PORT = 465
SMTP_TIMEOUT = 25

MAX_RECIPIENTS = 25
MAX_PARALLEL_SENDS = 4

# Minimum global interval between SMTP connection starts.
SEND_DELAY_SECONDS = 0.60

SMTP_SSL_CONTEXT = ssl.create_default_context()

# Global pacing applies only within this Python process.
_send_lock = threading.Lock()
_next_send_time = 0.0


# ============================================================
# LOGGING
# Never log passwords, email bodies, or SMTP credentials.
# ============================================================

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("secure_mail_console")


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

    if len(value) > 254:
        return False

    if not EMAIL_RE.fullmatch(value):
        return False

    if ".." in value:
        return False

    return True


def clean_header(value, max_length=200):
    """
    Prevent newline/header injection in email headers.
    """
    value = str(value or "")
    value = value.replace("\r", " ").replace("\n", " ")
    return value.strip()[:max_length]


# ============================================================
# LOGIN AND SESSION HELPERS
# ============================================================

def logged_in():
    return session.get("authenticated") is True


def get_csrf_token():
    token = session.get("csrf_token")

    if not token:
        token = secrets.token_urlsafe(32)
        session["csrf_token"] = token

    return token


def check_csrf():
    supplied = request.headers.get("X-CSRF-Token", "")

    if not supplied:
        supplied = request.form.get("csrf_token", "")

    expected = session.get("csrf_token", "")

    if not supplied or not expected:
        return False

    return secrets.compare_digest(
        str(supplied),
        str(expected),
    )


def login_required_response():
    return jsonify({
        "ok": False,
        "error": "Your session has expired. Please log in again."
    }), 401


# ============================================================
# ROUTES: HOME AND LOGIN
# ============================================================

@app.route("/", methods=["GET"])
def home():
    if logged_in():
        return redirect(url_for("dashboard"))

    return redirect(url_for("login"))


@app.route("/login", methods=["GET", "POST"])
def login():

    if logged_in() and request.method == "GET":
        return redirect(url_for("dashboard"))

    error = None

    if request.method == "POST":

        password = request.form.get("password", "")

        if secrets.compare_digest(
            str(password),
            str(LOGIN_PASSWORD),
        ):
            session.clear()
            session.permanent = True
            session["authenticated"] = True
            session["csrf_token"] = secrets.token_urlsafe(32)

            return redirect(url_for("dashboard"))

        error = "Incorrect password. Please try again."

    return render_template(
        "login.html",
        error=error,
    )


# ============================================================
# ROUTE: DASHBOARD
# ============================================================

@app.route("/dashboard", methods=["GET"])
def dashboard():

    if not logged_in():
        return redirect(url_for("login"))

    return render_template(
        "index.html",
        csrf_token=get_csrf_token(),
    )


# ============================================================
# ROUTE: LOGOUT
# Frontend uses POST after double-click.
# GET remains compatible with old browser bookmarks.
# ============================================================

@app.route("/logout", methods=["GET", "POST"])
def logout():

    if request.method == "GET":

        if logged_in():
            return redirect(url_for("dashboard"))

        return redirect(url_for("login"))

    if not logged_in():
        return jsonify({
            "ok": False,
            "error": "Not logged in."
        }), 401

    if not check_csrf():
        return jsonify({
            "ok": False,
            "error": "Invalid security token."
        }), 403

    session.clear()

    response = jsonify({"ok": True})
    response.headers["Cache-Control"] = "no-store"

    return response


# ============================================================
# ROUTE: HEALTH CHECK
# ============================================================

@app.route("/health", methods=["GET"])
def health():

    return jsonify({
        "ok": True,
        "service": "Secure Mail Console",
        "smtp_host": SMTP_HOST,
        "max_recipients": MAX_RECIPIENTS,
        "max_parallel_sends": MAX_PARALLEL_SENDS,
    })


# ============================================================
# RECIPIENT PARSER
# ============================================================

def parse_recipients(value):

    if isinstance(value, str):
        raw_values = re.split(r"[\n,;]+", value)

    elif isinstance(value, list):
        raw_values = value

    else:
        return []

    results = []
    seen = set()

    for item in raw_values:

        if not isinstance(item, str):
            continue

        email = item.strip().lower()

        if not email:
            continue

        if email not in seen:
            seen.add(email)
            results.append(email)

    return results


# ============================================================
# PERSONALIZATION
# ============================================================

def get_first_name(email_address):

    local_part = email_address.split("@", 1)[0]

    local_part = re.sub(
        r"[^A-Za-z0-9._-]+",
        " ",
        local_part,
    )

    local_part = re.sub(
        r"[._-]+",
        " ",
        local_part,
    )

    parts = local_part.split()

    if parts:
        return parts[0].capitalize()

    return "Friend"


def personalize(value, recipient, ref_code):

    name = get_first_name(recipient)

    replacements = {
        "{{hi}}": "Hi",
        "{{hello}}": "Hello",
        "{{thanks}}": "Thank you",
        "{{name}}": name,
        "{{email}}": recipient,
        "{{ref_code}}": ref_code,
    }

    result = str(value or "")

    for placeholder, replacement in replacements.items():
        result = result.replace(
            placeholder,
            replacement,
        )

    return result


# ============================================================
# HTML TO PLAIN TEXT
# ============================================================

def html_to_text(value):

    value = re.sub(
        r"(?i)<\s*br\s*/?\s*>",
        "\n",
        value,
    )

    value = re.sub(
        r"(?i)</\s*(p|div|li|h[1-6])\s*>",
        "\n",
        value,
    )

    value = re.sub(
        r"<[^>]+>",
        "",
        value,
    )

    value = html.unescape(value)

    return value.strip()


# ============================================================
# GLOBAL SMTP PACING
# ============================================================

def wait_for_send_slot():

    global _next_send_time

    with _send_lock:

        now = time.monotonic()

        scheduled_time = max(
            now,
            _next_send_time,
        )

        _next_send_time = (
            scheduled_time + SEND_DELAY_SECONDS
        )

        wait_time = scheduled_time - now

    if wait_time > 0:
        time.sleep(wait_time)


# ============================================================
# EMAIL MESSAGE BUILDER
# ============================================================

def build_message(
    sender_name,
    gmail,
    recipient,
    subject,
    body,
    is_html,
    ref_code,
):

    personalized_subject = personalize(
        subject,
        recipient,
        ref_code,
    )

    personalized_body = personalize(
        body,
        recipient,
        ref_code,
    )

    msg = EmailMessage()

    msg["Subject"] = clean_header(
        personalized_subject,
        200,
    )

    msg["From"] = formataddr((
        clean_header(sender_name, 100),
        gmail,
    ))

    msg["To"] = recipient

    msg["X-Entity-Ref-ID"] = ref_code

    if is_html:

        plain_body = html_to_text(
            personalized_body
        )

        msg.set_content(
            plain_body or "Please view this message in an HTML-compatible email client."
        )

        msg.add_alternative(
            personalized_body,
            subtype="html",
        )

    else:

        msg.set_content(
            personalized_body
        )

    return msg


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

    ref_code = secrets.token_hex(6).upper()

    try:

        msg = build_message(
            sender_name=sender_name,
            gmail=gmail,
            recipient=recipient,
            subject=subject,
            body=body,
            is_html=is_html,
            ref_code=ref_code,
        )

        # Pace SMTP connection starts across this process.
        wait_for_send_slot()

        with smtplib.SMTP_SSL(
            SMTP_HOST,
            SMTP_PORT,
            timeout=SMTP_TIMEOUT,
            context=SMTP_SSL_CONTEXT,
        ) as server:

            server.login(
                gmail,
                app_password,
            )

            server.send_message(
                msg,
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
            "error": "Gmail authentication failed. Check Gmail and App Password.",
        }

    except smtplib.SMTPRecipientsRefused:

        return {
            "email": recipient,
            "status": "failed",
            "error": "Gmail refused this recipient.",
        }

    except smtplib.SMTPException as exc:

        logger.warning(
            "SMTP error while sending to a recipient: %s",
            type(exc).__name__,
        )

        return {
            "email": recipient,
            "status": "failed",
            "error": "SMTP error: " + type(exc).__name__,
        }

    except (TimeoutError, OSError):

        logger.warning(
            "Network error while sending to a recipient."
        )

        return {
            "email": recipient,
            "status": "failed",
            "error": "SMTP connection or network error.",
        }

    except Exception as exc:

        logger.exception(
            "Unexpected email sending error: %s",
            type(exc).__name__,
        )

        return {
            "email": recipient,
            "status": "failed",
            "error": "Unexpected sending error.",
        }


# ============================================================
# NDJSON EVENT RESPONSE
# ============================================================

def json_event(data):

    return json.dumps(
        data,
        ensure_ascii=False,
    ) + "\n"


# ============================================================
# ROUTE: SEND BATCH
# ============================================================

@app.route("/send-batch", methods=["POST"])
def send_batch():

    # Login protection
    if not logged_in():
        return login_required_response()

    # CSRF protection
    if not check_csrf():
        return jsonify({
            "ok": False,
            "error": "Security verification failed. Refresh the page and try again.",
        }), 403

    # JSON body
    data = request.get_json(silent=True)

    if not isinstance(data, dict):
        return jsonify({
            "ok": False,
            "error": "Invalid JSON request.",
        }), 400

    # Form fields
    sender_name = clean_header(
        data.get("sender_name", ""),
        100,
    )

    gmail = str(
        data.get("gmail", "")
    ).strip().lower()

    app_password = re.sub(
        r"\s+",
        "",
        str(data.get("app_password", "")),
    )

    subject = clean_header(
        data.get("subject", ""),
        200,
    )

    body = data.get("body", "")

    is_html = data.get("is_html") is True

    consent = data.get("consent") is True

    recipients = parse_recipients(
        data.get("recipients", [])
    )

    # Required field checks
    if not sender_name:
        return jsonify({
            "ok": False,
            "error": "Sender Name is required.",
        }), 400

    if not valid_email(gmail):
        return jsonify({
            "ok": False,
            "error": "Enter a valid Gmail address.",
        }), 400

    if not app_password:
        return jsonify({
            "ok": False,
            "error": "Gmail App Password is required.",
        }), 400

    if len(app_password) < 8 or len(app_password) > 100:
        return jsonify({
            "ok": False,
            "error": "Gmail App Password format is invalid.",
        }), 400

    if not subject:
        return jsonify({
            "ok": False,
            "error": "Email subject is required.",
        }), 400

    if not isinstance(body, str) or not body.strip():
        return jsonify({
            "ok": False,
            "error": "Email message body is required.",
        }), 400

    if len(body) > 100000:
        return jsonify({
            "ok": False,
            "error": "Email message is too large.",
        }), 400

    if not consent:
        return jsonify({
            "ok": False,
            "error": "Please confirm recipient consent.",
        }), 400

    if not recipients:
        return jsonify({
            "ok": False,
            "error": "Enter at least one recipient.",
        }), 400

    if len(recipients) > MAX_RECIPIENTS:
        return jsonify({
            "ok": False,
            "error": "Maximum 25 unique recipients are allowed per batch.",
        }), 400

    invalid_recipients = [
        email for email in recipients
        if not valid_email(email)
    ]

    if invalid_recipients:
        return jsonify({
            "ok": False,
            "error": "Invalid recipient email address: "
                     + ", ".join(invalid_recipients[:5]),
        }), 400

    # Copy validated data for the streaming generator.
    total_recipients = len(recipients)

    def generate():

        sent_count = 0
        failed_count = 0

        yield json_event({
            "event": "start",
            "total": total_recipients,
        })

        try:

            with ThreadPoolExecutor(
                max_workers=MAX_PARALLEL_SENDS
            ) as executor:

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

                        recipient = futures[future]

                        result = {
                            "email": recipient,
                            "status": "failed",
                            "error": "Worker failed unexpectedly.",
                        }

                    if result["status"] == "sent":
                        sent_count += 1
                    else:
                        failed_count += 1

                    yield json_event({
                        "event": "progress",
                        "email": result["email"],
                        "status": result["status"],
                        "error": result["error"],
                        "sent": sent_count,
                        "failed": failed_count,
                        "total": total_recipients,
                    })

            yield json_event({
                "event": "complete",
                "sent": sent_count,
                "failed": failed_count,
                "total": total_recipients,
                "message": (
                    "Sending completed. "
                    + str(sent_count)
                    + " messages accepted by Gmail; "
                    + str(failed_count)
                    + " failed."
                ),
            })

        except Exception as exc:

            logger.exception(
                "Batch processing error: %s",
                type(exc).__name__,
            )

            yield json_event({
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


# ============================================================
# VERCEL SERVERLESS HANDLER
# ============================================================

handler = app
