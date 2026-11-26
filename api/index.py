import os
import re
import ssl
import json
import time
import secrets
import logging
import threading
import smtplib
import html

from datetime import timedelta
from concurrent.futures import ThreadPoolExecutor, as_completed
from email.message import EmailMessage
from email.utils import formataddr, make_msgid
from html.parser import HTMLParser

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

# =====================================================
# FLASK CONFIGURATION
# =====================================================

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

# =====================================================
# GMAIL SMTP SETTINGS
# =====================================================

SMTP_HOST = "smtp.gmail.com"
SMTP_PORT = 465
SMTP_TIMEOUT = 25

MAX_RECIPIENTS = 25
MAX_PARALLEL_SENDS = 4
SEND_DELAY_SECONDS = 0.75

_pacing_lock = threading.Lock()
_last_send_started = 0.0

EMAIL_RE = re.compile(
    r"^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@"
    r"[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$"
)

# =====================================================
# HELPERS
# =====================================================

def config_error():
    if len(SESSION_SECRET) < 32:
        return "SESSION_SECRET must be at least 32 characters."

    if not LOGIN_PASSWORD:
        return "LOGIN_PASSWORD is missing."

    return None


def logged_in():
    return session.get("authenticated") is True


def check_csrf():
    expected = session.get("csrf_token", "")
    received = request.headers.get("X-CSRF-Token", "")

    if not expected or not received:
        return False

    return secrets.compare_digest(expected, received)


def event_line(event, **kwargs):
    data = {"event": event}
    data.update(kwargs)

    return json.dumps(data, ensure_ascii=False) + "\n"


def valid_email(address):
    if not isinstance(address, str):
        return False

    address = address.strip()

    if len(address) > 254:
        return False

    return bool(EMAIL_RE.fullmatch(address))


def parse_recipients(raw):
    if isinstance(raw, list):
        values = raw
    elif isinstance(raw, str):
        values = re.split(r"[\n,;]+", raw)
    else:
        raise ValueError("Recipients must be a list or text.")

    recipients = []
    seen = set()

    for value in values:
        if not isinstance(value, str):
            raise ValueError("Invalid recipient format.")

        address = value.strip().lower()

        if not address:
            continue

        if not valid_email(address):
            raise ValueError("Invalid email address: " + address)

        if address not in seen:
            seen.add(address)
            recipients.append(address)

    if not recipients:
        raise ValueError("Please enter at least one recipient.")

    if len(recipients) > MAX_RECIPIENTS:
        raise ValueError(
            f"Maximum {MAX_RECIPIENTS} recipients are allowed."
        )

    return recipients


def pace_sending():
    """
    Process-local pacing only.
    Multiple Vercel instances do not share this lock.
    """
    global _last_send_started

    with _pacing_lock:
        now = time.monotonic()
        wait = SEND_DELAY_SECONDS - (now - _last_send_started)

        if wait > 0:
            time.sleep(wait)

        _last_send_started = time.monotonic()


# =====================================================
# PERSONALIZATION
# =====================================================

def personalize(value, recipient, ref_code):
    local_name = recipient.split("@")[0]

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


class HTMLExtractor(HTMLParser):

    def __init__(self):
        super().__init__()
        self.parts = []

    def handle_data(self, data):
        self.parts.append(data)

    def get_text(self):
        return " ".join(self.parts)


def html_to_text(value):
    parser = HTMLExtractor()

    try:
        parser.feed(value)
        return html.unescape(parser.get_text())
    except Exception:
        return html.unescape(re.sub(r"<[^>]+>", " ", value))


# =====================================================
# BUILD EMAIL
# =====================================================

def build_message(
    sender_name,
    gmail,
    recipient,
    subject,
    body,
    is_html,
):
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
        message.set_content(html_to_text(final_body))

        message.add_alternative(
            final_body,
            subtype="html",
        )
    else:
        message.set_content(final_body)

    return message


# =====================================================
# SEND ONE EMAIL
# =====================================================

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
        pace_sending()

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
                return {
                    "email": recipient,
                    "status": "failed",
                    "error": "Recipient refused by SMTP server.",
                }

        return {
            "email": recipient,
            "status": "sent",
            "error": None,
        }

    except smtplib.SMTPAuthenticationError:
        return {
            "email": recipient,
            "status": "failed",
            "error": "Gmail login failed. Check Gmail address and App Password.",
        }

    except smtplib.SMTPRecipientsRefused:
        return {
            "email": recipient,
            "status": "failed",
            "error": "Gmail refused this recipient.",
        }

    except smtplib.SMTPConnectError:
        return {
            "email": recipient,
            "status": "failed",
            "error": "Could not connect to Gmail SMTP.",
        }

    except smtplib.SMTPServerDisconnected:
        return {
            "email": recipient,
            "status": "failed",
            "error": "Gmail disconnected the SMTP connection.",
        }

    except smtplib.SMTPException as exc:
        logger.warning("SMTP error: %s", type(exc).__name__)

        return {
            "email": recipient,
            "status": "failed",
            "error": "SMTP error: " + type(exc).__name__,
        }

    except (TimeoutError, OSError):
        logger.warning("SMTP connection timeout or network error.")

        return {
            "email": recipient,
            "status": "failed",
            "error": "Connection timeout. Check delivery before retrying.",
        }

    except Exception:
        logger.exception("Unexpected email error.")

        return {
            "email": recipient,
            "status": "failed",
            "error": "Unexpected sending error.",
        }


# =====================================================
# HOME
# =====================================================

@app.route("/", methods=["GET"])
def home():

    if not CONFIG_READY:
        return config_error(), 503

    if logged_in():
        return redirect(url_for("dashboard"))

    return redirect(url_for("login"))


# =====================================================
# LOGIN
# =====================================================

@app.route("/login", methods=["GET", "POST"])
def login():

    if not CONFIG_READY:
        return config_error(), 503

    if logged_in():
        return redirect(url_for("dashboard"))

    if request.method == "POST":

        password = request.form.get("password", "")

        if secrets.compare_digest(password, LOGIN_PASSWORD):
            session.clear()
            session.permanent = True
            session["authenticated"] = True
            session["csrf_token"] = secrets.token_urlsafe(32)

            return redirect(url_for("dashboard"))

        return render_template(
            "login.html",
            error="Incorrect password.",
        ), 401

    return render_template(
        "login.html",
        error=None,
    )


# =====================================================
# DASHBOARD
# =====================================================

@app.route("/dashboard", methods=["GET"])
def dashboard():

    if not CONFIG_READY:
        return config_error(), 503

    if not logged_in():
        return redirect(url_for("login"))

    if not session.get("csrf_token"):
        session["csrf_token"] = secrets.token_urlsafe(32)

    return render_template(
        "index.html",
        csrf_token=session["csrf_token"],
    )


# =====================================================
# LOGOUT
# =====================================================

@app.route("/logout", methods=["GET", "POST"])
def logout():

    if request.method == "GET":
        if logged_in():
            return redirect(url_for("dashboard"))

        return redirect(url_for("login"))

    if not logged_in():
        return redirect(url_for("login"))

    if not check_csrf():
        return jsonify({
            "ok": False,
            "error": "Invalid security token.",
        }), 403

    session.clear()

    response = jsonify({"ok": True})

    response.delete_cookie(
        "session",
        path="/",
        secure=True,
        httponly=True,
        samesite="Lax",
    )

    return response


# =====================================================
# HEALTH
# =====================================================

@app.route("/health", methods=["GET"])
def health():

    return jsonify({
        "ok": True,
        "configuration_ready": CONFIG_READY,
        "smtp_host": SMTP_HOST,
        "smtp_port": SMTP_PORT,
    })


# =====================================================
# SEND BATCH
# =====================================================

@app.route("/send-batch", methods=["POST"])
def send_batch():

    if not CONFIG_READY:
        return jsonify({
            "error": config_error(),
        }), 503

    if not logged_in():
        return jsonify({
            "error": "Session expired. Please log in again.",
        }), 401

    if not check_csrf():
        return jsonify({
            "error": "Security token invalid. Reload dashboard.",
        }), 403

    data = request.get_json(silent=True)

    if not isinstance(data, dict):
        return jsonify({
            "error": "Invalid JSON request.",
        }), 400

    # Accept both the original dashboard names and common aliases.
    sender_name = data.get("sender_name", data.get("from_name", ""))
    gmail = data.get("gmail", data.get("email", ""))
    app_password = data.get(
        "app_password",
        data.get("gmail_app_password", ""),
    )
    subject = data.get("subject", "")
    body = data.get("body", data.get("message", ""))
    is_html = data.get("is_html", False)
    consent = data.get("consent", False)

    if not all(
        isinstance(value, str)
        for value in (
            sender_name,
            gmail,
            app_password,
            subject,
            body,
        )
    ):
        return jsonify({
            "error": "Invalid field format.",
        }), 400

    if not isinstance(is_html, bool):
        return jsonify({
            "error": "is_html must be true or false.",
        }), 400

    if consent is not True:
        return jsonify({
            "error": "Recipient consent confirmation is required.",
        }), 400

    sender_name = sender_name.strip()
    gmail = gmail.strip().lower()

    # Google App Passwords are sometimes displayed with spaces.
    app_password = re.sub(r"\s+", "", app_password)

    subject = subject.strip()

    if not sender_name:
        return jsonify({"error": "Sender name is required."}), 400

    if len(sender_name) > 100:
        return jsonify({"error": "Sender name is too long."}), 400

    if not valid_email(gmail):
        return jsonify({"error": "Invalid Gmail address."}), 400

    if not app_password:
        return jsonify({"error": "Gmail App Password is required."}), 400

    if not subject:
        return jsonify({"error": "Email subject is required."}), 400

    if len(subject) > 200:
        return jsonify({"error": "Subject is too long."}), 400

    if not body.strip():
        return jsonify({"error": "Email message is required."}), 400

    if len(body) > 100000:
        return jsonify({"error": "Email body is too long."}), 400

    try:
        recipients = parse_recipients(
            data.get("recipients", [])
        )
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    logger.info(
        "Email batch received. Recipient count: %s",
        len(recipients),
    )

    def generate():

        sent_count = 0
        failed_count = 0

        yield event_line(
            "start",
            total=len(recipients),
        )

        try:
            with ThreadPoolExecutor(
                max_workers=MAX_PARALLEL_SENDS
            ) as executor:

                futures = {}

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

                    futures[future] = recipient

                for future in as_completed(futures):

                    recipient = futures[future]

                    try:
                        result = future.result()

                    except Exception:
                        logger.exception("Worker exception.")

                        result = {
                            "email": recipient,
                            "status": "failed",
                            "error": "Worker error.",
                        }

                    if result["status"] == "sent":
                        sent_count += 1
                    else:
                        failed_count += 1

                    yield event_line(
                        "progress",
                        email=result["email"],
                        status=result["status"],
                        error=result["error"],
                        sent=sent_count,
                        failed=failed_count,
                        total=len(recipients),
                    )

            yield event_line(
                "complete",
                sent=sent_count,
                failed=failed_count,
                total=len(recipients),
                message=(
                    f"Finished. SMTP accepted: {sent_count}. "
                    f"Failed: {failed_count}."
                ),
            )

        except Exception:
            logger.exception("Batch sending failed.")

            yield event_line(
                "error",
                error="Batch failed. Check Vercel Function Logs.",
            )

    return Response(
        stream_with_context(generate()),
        status=200,
        mimetype="application/x-ndjson",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Content-Type-Options": "nosniff",
        },
    )


# =====================================================
# VERCEL HANDLER
# =====================================================

handler = app
