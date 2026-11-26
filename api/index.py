import os
import re
import ssl
import json
import time
import secrets
import logging
import threading
import html

from datetime import timedelta
from concurrent.futures import ThreadPoolExecutor, as_completed
from email.message import EmailMessage
from email.utils import formataddr, make_msgid
from html.parser import HTMLParser

import smtplib

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

# ==================================================
# FLASK APP
# ==================================================

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

app = Flask(
    __name__,
    template_folder=os.path.join(BASE_DIR, "templates"),
    static_folder=os.path.join(BASE_DIR, "static"),
)

SESSION_SECRET = os.environ.get("SESSION_SECRET", "")
LOGIN_PASSWORD = os.environ.get("LOGIN_PASSWORD", "")

CONFIG_READY = (
    len(SESSION_SECRET) >= 32
    and bool(LOGIN_PASSWORD)
)

app.secret_key = (
    SESSION_SECRET
    if len(SESSION_SECRET) >= 32
    else secrets.token_hex(32)
)

app.config.update(
    SESSION_COOKIE_SECURE=True,
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    PERMANENT_SESSION_LIFETIME=timedelta(hours=1),
    MAX_CONTENT_LENGTH=1024 * 1024,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# ==================================================
# SMTP SETTINGS
# ==================================================

SMTP_HOST = "smtp.gmail.com"
SMTP_PORT = 465
SMTP_TIMEOUT = 20

MAX_RECIPIENTS = 25
MAX_PARALLEL_SENDS = 4
SEND_DELAY_SECONDS = 0.75

_pacing_lock = threading.Lock()
_last_send_started = 0.0

EMAIL_RE = re.compile(
    r"^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@"
    r"[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$"
)

# ==================================================
# CONFIGURATION HELPERS
# ==================================================

def get_config_error():
    if len(SESSION_SECRET) < 32:
        return "SESSION_SECRET must be at least 32 characters."

    if not LOGIN_PASSWORD:
        return "LOGIN_PASSWORD is not configured."

    return None


def is_logged_in():
    return session.get("authenticated") is True


def csrf_valid():
    expected = session.get("csrf_token", "")
    received = request.headers.get("X-CSRF-Token", "")

    if not expected or not received:
        return False

    return secrets.compare_digest(expected, received)


def make_event(event, **data):
    payload = {"event": event}
    payload.update(data)

    return json.dumps(
        payload,
        ensure_ascii=False
    ) + "\n"


# ==================================================
# EMAIL VALIDATION
# ==================================================

def valid_email(value):
    if not isinstance(value, str):
        return False

    value = value.strip()

    if len(value) > 254:
        return False

    return bool(EMAIL_RE.fullmatch(value))


def parse_recipients(raw):
    if not isinstance(raw, str):
        raise ValueError("Recipients must be text.")

    values = re.split(r"[\n,;]+", raw)

    recipients = []
    seen = set()

    for value in values:
        email = value.strip().lower()

        if not email:
            continue

        if not valid_email(email):
            raise ValueError("Invalid email address: " + email)

        if email not in seen:
            seen.add(email)
            recipients.append(email)

    if not recipients:
        raise ValueError("Please enter at least one recipient.")

    if len(recipients) > MAX_RECIPIENTS:
        raise ValueError(
            f"Maximum {MAX_RECIPIENTS} unique recipients are allowed."
        )

    return recipients


# ==================================================
# PROCESS-LOCAL SENDING PACING
# ==================================================

def pace_send_start():
    global _last_send_started

    with _pacing_lock:
        now = time.monotonic()

        wait_time = SEND_DELAY_SECONDS - (
            now - _last_send_started
        )

        if wait_time > 0:
            time.sleep(wait_time)

        _last_send_started = time.monotonic()


# ==================================================
# PERSONALIZATION
# ==================================================

def personalize(value, recipient, ref_code):
    if not isinstance(value, str):
        return ""

    local_name = recipient.split("@", 1)[0]

    name = re.sub(
        r"[._-]+",
        " ",
        local_name
    ).strip().title()

    replacements = {
        "{{hi}}": "Hi",
        "{{hello}}": "Hello",
        "{{thanks}}": "Thank you",
        "{{name}}": name,
        "{{email}}": recipient,
        "{{ref_code}}": ref_code,
    }

    for key, replacement in replacements.items():
        value = value.replace(key, replacement)

    return value


class HTMLTextExtractor(HTMLParser):

    def __init__(self):
        super().__init__()
        self.parts = []

    def handle_data(self, data):
        if data:
            self.parts.append(data)

    def get_text(self):
        return " ".join(self.parts)


def html_to_text(value):
    parser = HTMLTextExtractor()

    try:
        parser.feed(value)
        return html.unescape(parser.get_text())

    except Exception:
        return html.unescape(
            re.sub(r"<[^>]*>", " ", value)
        )


# ==================================================
# BUILD EMAIL MESSAGE
# ==================================================

def build_message(
    sender_name,
    gmail,
    recipient,
    subject,
    body,
    is_html,
):
    # One reference code per email, shared by subject and body.
    ref_code = secrets.token_hex(4).upper()

    final_subject = personalize(
        subject,
        recipient,
        ref_code,
    )

    final_body = personalize(
        body,
        recipient,
        ref_code,
    )

    message = EmailMessage()

    message["Subject"] = final_subject
    message["From"] = formataddr((sender_name, gmail))
    message["To"] = recipient
    message["Message-ID"] = make_msgid()

    if is_html:
        plain_body = html_to_text(final_body)

        message.set_content(plain_body)

        message.add_alternative(
            final_body,
            subtype="html",
        )

    else:
        message.set_content(final_body)

    return message


# ==================================================
# SEND ONE EMAIL
# ==================================================

def send_one_email(
    recipient,
    sender_name,
    gmail,
    app_password,
    subject,
    body,
    is_html,
):
    try:
        pace_send_start()

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
                app_password,
            )

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
        logger.warning("Gmail SMTP authentication failed.")

        return {
            "email": recipient,
            "status": "failed",
            "error": "Gmail authentication failed. Check your App Password.",
        }

    except smtplib.SMTPRecipientsRefused:
        return {
            "email": recipient,
            "status": "failed",
            "error": "Recipient was refused by the SMTP server.",
        }

    except smtplib.SMTPException as exc:
        logger.warning(
            "SMTP error: %s",
            type(exc).__name__,
        )

        return {
            "email": recipient,
            "status": "failed",
            "error": "SMTP error: " + type(exc).__name__,
        }

    except (TimeoutError, OSError):
        logger.warning("SMTP connection or timeout error.")

        return {
            "email": recipient,
            "status": "failed",
            "error": (
                "Connection or timeout error. "
                "Delivery may be uncertain; check before retrying."
            ),
        }

    except Exception:
        logger.exception("Unexpected sending error.")

        return {
            "email": recipient,
            "status": "failed",
            "error": "Unexpected sending error.",
        }


# ==================================================
# LOGIN ROUTE
# ==================================================

@app.route("/login", methods=["GET", "POST"])
def login():

    error = get_config_error()

    if error:
        return error, 503

    if is_logged_in():
        return redirect(url_for("dashboard"))

    if request.method == "POST":

        password = request.form.get("password", "")

        if secrets.compare_digest(
            password,
            LOGIN_PASSWORD
        ):
            session.clear()

            session.permanent = True
            session["authenticated"] = True
            session["csrf_token"] = secrets.token_urlsafe(32)

            return redirect(url_for("dashboard"))

        return render_template(
            "login.html",
            error="Incorrect password. Please try again.",
        ), 401

    return render_template(
        "login.html",
        error=None,
    )


# ==================================================
# HOME ROUTE
# ==================================================

@app.route("/", methods=["GET"])
def home():

    error = get_config_error()

    if error:
        return error, 503

    if is_logged_in():
        return redirect(url_for("dashboard"))

    return redirect(url_for("login"))


# ==================================================
# DASHBOARD ROUTE
# ==================================================

@app.route("/dashboard", methods=["GET"])
def dashboard():

    error = get_config_error()

    if error:
        return error, 503

    if not is_logged_in():
        return redirect(url_for("login"))

    if not session.get("csrf_token"):
        session["csrf_token"] = secrets.token_urlsafe(32)

    return render_template(
        "index.html",
        csrf_token=session["csrf_token"],
    )


# ==================================================
# LOGOUT ROUTE - GET AND POST FIX
# ==================================================

@app.route("/logout", methods=["GET", "POST"])
def logout():

    # Direct browser visit to /logout uses GET.
    # Redirect safely instead of showing 405.
    if request.method == "GET":

        if is_logged_in():
            return redirect(url_for("dashboard"))

        return redirect(url_for("login"))

    # Actual logout action uses POST.
    if not is_logged_in():
        return redirect(url_for("login"))

    if not csrf_valid():
        return jsonify({
            "ok": False,
            "error": "Invalid security token. Reload the dashboard.",
        }), 403

    session.clear()

    response = jsonify({
        "ok": True,
        "message": "Logged out successfully.",
    })

    response.delete_cookie(
        app.config.get("SESSION_COOKIE_NAME", "session"),
        path="/",
        secure=True,
        httponly=True,
        samesite="Lax",
    )

    return response


# ==================================================
# HEALTH CHECK
# ==================================================

@app.route("/health", methods=["GET"])
def health():

    return jsonify({
        "ok": True,
        "service": "Gmail SMTP Email Service",
        "configuration_ready": CONFIG_READY,
    })


# ==================================================
# SEND BATCH ROUTE
# ==================================================

@app.route("/send-batch", methods=["POST"])
def send_batch():

    if not CONFIG_READY:
        return jsonify({
            "error": "Server environment variables are not configured."
        }), 503

    if not is_logged_in():
        return jsonify({
            "error": "Session expired. Please log in again."
        }), 401

    if not csrf_valid():
        return jsonify({
            "error": "Security token expired. Reload the dashboard."
        }), 403

    data = request.get_json(silent=True)

    if not isinstance(data, dict):
        return jsonify({
            "error": "Invalid JSON request."
        }), 400

    sender_name = data.get("sender_name", "")
    gmail = data.get("gmail", "")
    app_password = data.get("app_password", "")
    subject = data.get("subject", "")
    body = data.get("body", "")
    is_html = data.get("is_html", False)
    consent = data.get("consent", False)

    string_fields = (
        sender_name,
        gmail,
        app_password,
        subject,
        body,
    )

    if not all(isinstance(value, str) for value in string_fields):
        return jsonify({
            "error": "Invalid field format."
        }), 400

    if not isinstance(is_html, bool):
        return jsonify({
            "error": "Invalid HTML setting."
        }), 400

    if consent is not True:
        return jsonify({
            "error": "Recipient consent confirmation is required."
        }), 400

    sender_name = sender_name.strip()
    gmail = gmail.strip().lower()
    subject = subject.strip()

    if not sender_name:
        return jsonify({
            "error": "Sender name is required."
        }), 400

    if len(sender_name) > 100:
        return jsonify({
            "error": "Sender name is too long."
        }), 400

    if not valid_email(gmail):
        return jsonify({
            "error": "Enter a valid Gmail address."
        }), 400

    if not app_password.strip():
        return jsonify({
            "error": "Gmail App Password is required."
        }), 400

    if not subject:
        return jsonify({
            "error": "Email subject is required."
        }), 400

    if len(subject) > 200:
        return jsonify({
            "error": "Email subject is too long."
        }), 400

    if not body.strip():
        return jsonify({
            "error": "Email message is required."
        }), 400

    if len(body) > 100000:
        return jsonify({
            "error": "Email message is too long."
        }), 400

    try:
        recipients = parse_recipients(
            data.get("recipients", "")
        )

    except ValueError as exc:
        return jsonify({
            "error": str(exc)
        }), 400

    logger.info(
        "Batch accepted. Recipient count: %d",
        len(recipients),
    )

    def generate():

        sent_count = 0
        failed_count = 0

        yield make_event(
            "start",
            total=len(recipients),
        )

        try:

            with ThreadPoolExecutor(
                max_workers=MAX_PARALLEL_SENDS
            ) as executor:

                future_map = {}

                for recipient in recipients:

                    future = executor.submit(
                        send_one_email,
                        recipient,
                        sender_name,
                        gmail,
                        app_password,
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
                        logger.exception("Email worker failed.")

                        result = {
                            "email": recipient,
                            "status": "failed",
                            "error": "Worker failed unexpectedly.",
                        }

                    if result["status"] == "sent":
                        sent_count += 1
                    else:
                        failed_count += 1

                    yield make_event(
                        "progress",
                        email=result["email"],
                        status=result["status"],
                        error=result["error"],
                        sent=sent_count,
                        failed=failed_count,
                        total=len(recipients),
                    )

            yield make_event(
                "complete",
                sent=sent_count,
                failed=failed_count,
                total=len(recipients),
                message=(
                    f"Completed. SMTP accepted: {sent_count}, "
                    f"Failed: {failed_count}."
                ),
            )

        except Exception:
            logger.exception("Batch processing failed.")

            yield make_event(
                "error",
                error="Batch processing failed. Check Vercel Function Logs.",
            )

    return Response(
        stream_with_context(generate()),
        mimetype="application/x-ndjson",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Content-Type-Options": "nosniff",
        },
    )


# ==================================================
# VERCEL ENTRY POINT
# ==================================================

handler = app
