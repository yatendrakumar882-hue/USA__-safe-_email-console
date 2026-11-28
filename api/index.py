
import os
import re
import ssl
import json
import time
import hmac
import html
import secrets
import smtplib
import threading
import logging

from datetime import datetime, timezone, timedelta
from concurrent.futures import ThreadPoolExecutor, as_completed
from email.message import EmailMessage
from email.utils import formataddr, make_msgid
from email.parser import Parser
from html.parser import HTMLParser

from flask import (
    Flask,
    render_template,
    request,
    redirect,
    url_for,
    session,
    jsonify,
    Response,
    stream_with_context,
)

from werkzeug.middleware.proxy_fix import ProxyFix


# ==================================================
# PROJECT PATHS
# ==================================================

BASE_DIR = os.path.dirname(
    os.path.dirname(os.path.abspath(__file__))
)

TEMPLATE_DIR = os.path.join(BASE_DIR, "templates")
STATIC_DIR = os.path.join(BASE_DIR, "static")


# ==================================================
# ENVIRONMENT VARIABLES
# ==================================================

SESSION_SECRET = os.environ.get("SESSION_SECRET", "")
LOGIN_PASSWORD = os.environ.get("LOGIN_PASSWORD", "")

CONFIG_READY = (
    len(SESSION_SECRET) >= 32
    and bool(LOGIN_PASSWORD)
)


# ==================================================
# FLASK APPLICATION
# ==================================================

app = Flask(
    __name__,
    template_folder=TEMPLATE_DIR,
    static_folder=STATIC_DIR,
    static_url_path="/static",
)

app.wsgi_app = ProxyFix(
    app.wsgi_app,
    x_for=1,
    x_proto=1,
    x_host=1,
)

app.secret_key = (
    SESSION_SECRET
    if len(SESSION_SECRET) >= 32
    else secrets.token_hex(32)
)

app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SECURE=True,
    SESSION_COOKIE_SAMESITE="Lax",
    PERMANENT_SESSION_LIFETIME=timedelta(hours=1),
    MAX_CONTENT_LENGTH=512 * 1024,
)


# ==================================================
# LOGGING
# ==================================================

logging.basicConfig(level=logging.INFO)

logger = logging.getLogger(__name__)


# ==================================================
# GMAIL SMTP SETTINGS
# ==================================================

SMTP_HOST = "smtp.gmail.com"
SMTP_PORT = 465
SMTP_TIMEOUT = 25

MAX_RECIPIENTS = 25

# ORIGINAL SENDING SPEED - UNCHANGED
MAX_WORKERS = 3
MIN_SEND_INTERVAL = 0.6


# ==================================================
# EMAIL VALIDATION
# ==================================================

EMAIL_RE = re.compile(
    r"^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+"
    r"@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$"
)


def valid_email(address):
    if not isinstance(address, str):
        return False

    address = address.strip()

    return (
        len(address) <= 254
        and bool(EMAIL_RE.fullmatch(address))
    )


def clean_header(value, limit=180):
    value = str(value or "")

    value = value.replace("\r", " ")
    value = value.replace("\n", " ")

    return value.strip()[:limit]


def configuration_error():

    if len(SESSION_SECRET) < 32:
        return (
            "SESSION_SECRET is missing or too short. "
            "Set a random secret of at least 32 characters."
        )

    if not LOGIN_PASSWORD:
        return (
            "LOGIN_PASSWORD is missing. "
            "Set it in Vercel Environment Variables."
        )

    return None


# ==================================================
# LOGIN SESSION
# ==================================================

def logged_in():
    return session.get("authenticated") is True


# ==================================================
# CSRF SECURITY
# ==================================================

def csrf_token():

    if "csrf_token" not in session:
        session["csrf_token"] = secrets.token_urlsafe(32)

    return session["csrf_token"]


def csrf_ok():

    supplied = (
        request.headers.get("X-CSRF-Token")
        or request.form.get("csrf_token", "")
    )

    if not supplied and request.is_json:
        data = request.get_json(silent=True) or {}
        supplied = data.get("csrf_token", "")

    expected = session.get("csrf_token", "")

    return bool(
        supplied
        and expected
        and hmac.compare_digest(
            str(supplied),
            str(expected)
        )
    )


# ==================================================
# PERSONALIZATION
# ==================================================

def personalize(text, recipient, sender_name):

    text = str(text or "")

    local = recipient.split("@", 1)[0]

    name = re.split(
        r"[._+-]",
        local
    )[0] or "there"

    replacements = {
        "{{hi}}": "Hi",
        "{{hello}}": "Hello",
        "{{thanks}}": "Thank you",
        "{{name}}": name,
        "{{email}}": recipient,
        "{{ref_code}}": secrets.token_hex(4).upper(),
        "{{sender_name}}": sender_name,
    }

    for key, value in replacements.items():
        text = text.replace(key, value)

    return text


# ==================================================
# CONTROLLED SENDING PACE
# SAME ORIGINAL SPEED
# ==================================================

pace_lock = threading.Lock()

last_send_time = 0.0


def pace_send():

    global last_send_time

    with pace_lock:

        current_time = time.monotonic()

        wait_time = (
            MIN_SEND_INTERVAL
            - (current_time - last_send_time)
        )

        if wait_time > 0:
            time.sleep(wait_time)

        last_send_time = time.monotonic()


# ==================================================
# HTML TO PLAIN TEXT
# ==================================================

class TextExtractor(HTMLParser):

    def __init__(self):
        super().__init__()
        self.parts = []

    def handle_data(self, data):

        value = data.strip()

        if value:
            self.parts.append(value)


def html_to_plain_text(value):

    parser = TextExtractor()

    try:
        parser.feed(value)
        parser.close()

        return "\n\n".join(parser.parts)

    except Exception:
        return html.unescape(
            re.sub(r"<[^>]+>", "", value)
        ).strip()


# ==================================================
# BUILD EMAIL MESSAGE
# ==================================================

def build_message(
    recipient,
    gmail,
    sender_name,
    subject,
    body,
    is_html,
):

    personalized_subject = personalize(
        subject,
        recipient,
        sender_name,
    )

    personalized_body = personalize(
        body,
        recipient,
        sender_name,
    )

    message = EmailMessage()

    message["Subject"] = clean_header(
        personalized_subject,
        200,
    )

    if sender_name:
        message["From"] = formataddr(
            (
                clean_header(sender_name, 80),
                gmail,
            )
        )
    else:
        message["From"] = gmail

    message["To"] = recipient

    message["Date"] = datetime.now(
        timezone.utc
    ).strftime("%a, %d %b %Y %H:%M:%S +0000")

    message["Message-ID"] = make_msgid()

    if is_html:

        plain_text = html_to_plain_text(
            personalized_body
        )

        if not plain_text:
            plain_text = (
                "Please view this message "
                "in an HTML-capable email client."
            )

        message.set_content(plain_text)

        message.add_alternative(
            personalized_body,
            subtype="html",
        )

    else:

        message.set_content(
            personalized_body
        )

    return message


# ==================================================
# SEND ONE EMAIL
# ==================================================

def send_one(
    recipient,
    gmail,
    app_password,
    sender_name,
    subject,
    body,
    is_html,
):

    # Keep original sending interval.
    pace_send()

    message = build_message(
        recipient=recipient,
        gmail=gmail,
        sender_name=sender_name,
        subject=subject,
        body=body,
        is_html=is_html,
    )

    context = ssl.create_default_context()

    try:

        with smtplib.SMTP_SSL(
            SMTP_HOST,
            SMTP_PORT,
            context=context,
            timeout=SMTP_TIMEOUT,
        ) as server:

            server.login(
                gmail,
                app_password,
            )

            refused = server.send_message(
                message,
                from_addr=gmail,
                to_addrs=[recipient],
            )

            if refused:
                return {
                    "status": "failed",
                    "error": "Recipient refused by SMTP server.",
                }

        return {
            "status": "sent",
            "error": "",
        }

    except smtplib.SMTPAuthenticationError:

        return {
            "status": "failed",
            "error": (
                "Gmail authentication failed. "
                "Check Gmail address and App Password."
            ),
        }

    except smtplib.SMTPRecipientsRefused:

        return {
            "status": "failed",
            "error": "Recipient address refused by SMTP server.",
        }

    except smtplib.SMTPDataError as exc:

        return {
            "status": "failed",
            "error": (
                "SMTP rejected the message. "
                f"Server code: {exc.smtp_code}"
            ),
        }

    except smtplib.SMTPResponseException as exc:

        return {
            "status": "failed",
            "error": (
                f"SMTP response {exc.smtp_code}: "
                f"{str(exc.smtp_error)[:180]}"
            ),
        }

    except (TimeoutError, OSError) as exc:

        return {
            "status": "uncertain",
            "error": (
                "Connection error or timeout. "
                "Delivery may be uncertain; check before retrying."
            ),
        }

    except smtplib.SMTPException as exc:

        return {
            "status": "failed",
            "error": "SMTP error: " + str(exc)[:200],
        }

    except Exception:

        logger.exception(
            "Unexpected email sending error"
        )

        return {
            "status": "failed",
            "error": "Unexpected sending error. Check server logs.",
        }


# ==================================================
# SECURITY HEADERS
# ==================================================

@app.after_request
def security_headers(response):

    response.headers["X-Content-Type-Options"] = "nosniff"

    response.headers["X-Frame-Options"] = "DENY"

    response.headers["Referrer-Policy"] = (
        "strict-origin-when-cross-origin"
    )

    response.headers["Cache-Control"] = "no-store"

    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        "style-src 'self' 'unsafe-inline'; "
        "script-src 'self' 'unsafe-inline'; "
        "img-src 'self' data:; "
        "base-uri 'self'; "
        "frame-ancestors 'none'; "
        "form-action 'self'"
    )

    return response


# ==================================================
# HOME ROUTE
# ==================================================

@app.get("/")
def home():

    if logged_in():
        return redirect(
            url_for("dashboard")
        )

    return redirect(
        url_for("login")
    )


# ==================================================
# LOGIN ROUTE
# ==================================================

@app.route(
    "/login",
    methods=["GET", "POST"]
)
def login():

    error = configuration_error()

    if request.method == "POST":

        if error:
            return render_template(
                "login.html",
                error=error,
            ), 503

        password = request.form.get(
            "password",
            "",
        )

        if hmac.compare_digest(
            password,
            LOGIN_PASSWORD,
        ):

            session.clear()

            session["authenticated"] = True

            session.permanent = True

            csrf_token()

            return redirect(
                url_for("dashboard")
            )

        error = "Incorrect password. Please try again."

        return render_template(
            "login.html",
            error=error,
        ), 401

    return render_template(
        "login.html",
        error=error,
    )


# ==================================================
# DASHBOARD ROUTE
# ==================================================

@app.get("/dashboard")
def dashboard():

    if not logged_in():
        return redirect(
            url_for("login")
        )

    error = configuration_error()

    if error:
        return render_template(
            "login.html",
            error=error,
        ), 503

    return render_template(
        "index.html",
        csrf_token=csrf_token(),
    )


# ==================================================
# LOGOUT ROUTE
# ==================================================

@app.post("/logout")
def logout():

    if not logged_in():
        return jsonify({
            "ok": False,
            "error": "Please log in again.",
        }), 401

    if not csrf_ok():
        return jsonify({
            "ok": False,
            "error": "Security token expired.",
        }), 403

    session.clear()

    return jsonify({
        "ok": True,
    })


# ==================================================
# HEALTH CHECK
# ==================================================

@app.get("/health")
def health():

    return jsonify({
        "ok": True,
        "configuration_ready": CONFIG_READY,
        "templates_directory_exists": os.path.isdir(
            TEMPLATE_DIR
        ),
        "static_directory_exists": os.path.isdir(
            STATIC_DIR
        ),
        "login_template_exists": os.path.isfile(
            os.path.join(TEMPLATE_DIR, "login.html")
        ),
        "dashboard_template_exists": os.path.isfile(
            os.path.join(TEMPLATE_DIR, "index.html")
        ),
        "smtp_host": SMTP_HOST,
        "smtp_port": SMTP_PORT,
        "max_workers": MAX_WORKERS,
        "minimum_send_interval": MIN_SEND_INTERVAL,
    })


# ==================================================
# SEND BATCH ROUTE
# ==================================================

@app.post("/send-batch")
def send_batch():

    if not logged_in():
        return jsonify({
            "ok": False,
            "error": "Please log in again.",
        }), 401

    error = configuration_error()

    if error:
        return jsonify({
            "ok": False,
            "error": error,
        }), 503

    if not csrf_ok():
        return jsonify({
            "ok": False,
            "error": "Security token expired. Refresh the page.",
        }), 403

    data = request.get_json(
        silent=True
    ) or {}

    if not isinstance(data, dict):
        return jsonify({
            "ok": False,
            "error": "Invalid request data.",
        }), 400

    gmail = str(
        data.get("gmail") or ""
    ).strip().lower()

    app_password = str(
        data.get("app_password") or ""
    ).replace(" ", "").strip()

    sender_name = clean_header(
        data.get("sender_name") or "Email Team",
        80,
    )

    subject = clean_header(
        data.get("subject") or "",
        200,
    )

    body = data.get("body") or ""

    is_html = data.get("is_html") is True

    recipients_raw = data.get("recipients") or []

    consent = data.get("consent") is True

    # ----------------------------------------------
    # CONSENT
    # ----------------------------------------------

    if not consent:
        return jsonify({
            "ok": False,
            "error": (
                "Recipient permission confirmation is required."
            ),
        }), 400

    # ----------------------------------------------
    # GMAIL CREDENTIALS
    # ----------------------------------------------

    if not valid_email(gmail) or not app_password:
        return jsonify({
            "ok": False,
            "error": "Enter valid Gmail credentials.",
        }), 400

    if len(app_password) > 200:
        return jsonify({
            "ok": False,
            "error": "Invalid App Password.",
        }), 400

    # ----------------------------------------------
    # SUBJECT AND BODY
    # ----------------------------------------------

    if not subject or not isinstance(body, str) or not body.strip():
        return jsonify({
            "ok": False,
            "error": "Subject and message are required.",
        }), 400

    if len(body) > 30000:
        return jsonify({
            "ok": False,
            "error": (
                "Message exceeds the 30,000 character limit."
            ),
        }), 400

    # ----------------------------------------------
    # RECIPIENT VALIDATION
    # ----------------------------------------------

    if (
        not isinstance(recipients_raw, list)
        or not recipients_raw
    ):
        return jsonify({
            "ok": False,
            "error": "Add recipient email addresses.",
        }), 400

    if len(recipients_raw) > MAX_RECIPIENTS:
        return jsonify({
            "ok": False,
            "error": (
                f"Maximum {MAX_RECIPIENTS} recipients per batch."
            ),
        }), 400

    recipients = []
    seen = set()

    for item in recipients_raw:

        if not isinstance(item, str):
            return jsonify({
                "ok": False,
                "error": "Invalid recipient entry.",
            }), 400

        address = item.strip().lower()

        if not valid_email(address):
            return jsonify({
                "ok": False,
                "error": (
                    f"Invalid email address: {address[:100]}"
                ),
            }), 400

        if address not in seen:
            recipients.append(address)
            seen.add(address)

    if not recipients:
        return jsonify({
            "ok": False,
            "error": "No valid recipients found.",
        }), 400

    # ----------------------------------------------
    # IMMUTABLE BATCH SNAPSHOT
    # ----------------------------------------------

    batch = {
        "gmail": gmail,
        "app_password": app_password,
        "sender_name": sender_name,
        "subject": subject,
        "body": body,
        "is_html": is_html,
        "recipients": list(recipients),
    }

    # ----------------------------------------------
    # NDJSON EVENT HELPER
    # ----------------------------------------------

    def make_event(payload):

        return (
            json.dumps(
                payload,
                ensure_ascii=False,
            )
            + "\n"
        )

    # ----------------------------------------------
    # STREAMING SENDER
    # ----------------------------------------------

    def generate_events():

        total = len(batch["recipients"])

        sent = 0
        failed = 0
        uncertain = 0

        try:

            yield make_event({
                "event": "start",
                "total": total,
            })

            with ThreadPoolExecutor(
                max_workers=MAX_WORKERS
            ) as executor:

                futures = {}

                for recipient in batch["recipients"]:

                    future = executor.submit(
                        send_one,
                        recipient,
                        batch["gmail"],
                        batch["app_password"],
                        batch["sender_name"],
                        batch["subject"],
                        batch["body"],
                        batch["is_html"],
                    )

                    futures[future] = recipient

                for future in as_completed(futures):

                    recipient = futures[future]

                    try:

                        result = future.result()

                        status = result["status"]
                        error_message = result["error"]

                    except Exception as exc:

                        logger.exception(
                            "Email future failed"
                        )

                        status = "failed"
                        error_message = str(exc)[:220]

                    if status == "sent":
                        sent += 1

                    elif status == "uncertain":
                        uncertain += 1

                    else:
                        failed += 1

                    yield make_event({
                        "event": "progress",
                        "email": recipient,
                        "status": status,
                        "error": error_message,
                        "sent": sent,
                        "failed": failed,
                        "uncertain": uncertain,
                        "total": total,
                    })

            yield make_event({
                "event": "complete",
                "sent": sent,
                "failed": failed,
                "uncertain": uncertain,
                "total": total,
                "message": (
                    "SMTP processing finished. "
                    "SMTP acceptance does not confirm Inbox delivery."
                ),
            })

        except GeneratorExit:

            logger.info(
                "Client disconnected during batch sending."
            )

        except Exception:

            logger.exception(
                "Batch sending error"
            )

            yield make_event({
                "event": "error",
                "error": "Batch stopped because of a server error.",
            })

        finally:

            # Clear the password from the local batch snapshot.
            batch["app_password"] = ""

    return Response(
        stream_with_context(
            generate_events()
        ),
        mimetype="application/x-ndjson",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
        },
    )


# ==================================================
# VERCEL HANDLER
# ==================================================

handler = app
