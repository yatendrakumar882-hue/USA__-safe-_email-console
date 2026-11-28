
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
from concurrent.futures import ThreadPoolExecutor, as_completed

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


# =========================================================
# PROJECT PATHS
# =========================================================

BASE_DIR = os.path.dirname(
    os.path.dirname(os.path.abspath(__file__))
)

TEMPLATE_DIR = os.path.join(BASE_DIR, "templates")
STATIC_DIR = os.path.join(BASE_DIR, "static")


# =========================================================
# FLASK APP
# =========================================================

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

app.secret_key = (
    os.environ.get("SESSION_SECRET")
    or secrets.token_hex(32)
)

app.config.update(
    SESSION_COOKIE_SECURE=True,
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    PERMANENT_SESSION_LIFETIME=timedelta(hours=1),
    MAX_CONTENT_LENGTH=2 * 1024 * 1024,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


# =========================================================
# SENDING SETTINGS
# =========================================================

SMTP_HOST = "smtp.gmail.com"
SMTP_PORT = 465
SMTP_TIMEOUT = 20

MAX_RECIPIENTS = 25

# Four emails are processed in each batch.
BATCH_SIZE = 4

# Pause after each completed batch.
BATCH_DELAY_SECONDS = 2.0

MAX_SUBJECT_LENGTH = 200
MAX_MESSAGE_LENGTH = 30000


# =========================================================
# ENVIRONMENT
# =========================================================

def get_login_password():
    return os.environ.get("LOGIN_PASSWORD", "")


def missing_environment_variables():
    missing = []

    if not os.environ.get("SESSION_SECRET"):
        missing.append("SESSION_SECRET")

    if not get_login_password():
        missing.append("LOGIN_PASSWORD")

    return missing


# =========================================================
# SESSION / SECURITY
# =========================================================

def is_logged_in():
    return session.get("authenticated") is True


def get_csrf_token():
    token = session.get("csrf_token")

    if not token:
        token = secrets.token_urlsafe(32)
        session["csrf_token"] = token

    return token


def verify_csrf():
    expected = session.get("csrf_token", "")

    supplied = (
        request.headers.get("X-CSRF-Token")
        or request.form.get("csrf_token", "")
    )

    if not expected or not supplied:
        return False

    return hmac.compare_digest(
        str(expected),
        str(supplied)
    )


def login_required():
    if not is_logged_in():
        return redirect(url_for("login"))

    return None


# =========================================================
# VALIDATION
# =========================================================

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

    return bool(EMAIL_RE.fullmatch(value))


def clean_text(value, maximum):
    if not isinstance(value, str):
        return ""

    return value.strip()[:maximum]


def parse_recipients(raw):
    if not isinstance(raw, list):
        return None, "Recipients must be a list."

    recipients = []
    seen = set()

    for item in raw:
        if not isinstance(item, str):
            continue

        address = item.strip().lower()

        if not address or address in seen:
            continue

        seen.add(address)

        if not valid_email(address):
            return None, "Invalid email address: " + address

        recipients.append(address)

    if not recipients:
        return None, "Please add at least one recipient."

    if len(recipients) > MAX_RECIPIENTS:
        return None, "Maximum 25 unique recipients per batch."

    return recipients, None


# =========================================================
# PERSONALIZATION
# =========================================================

def personalize(value, recipient):
    local_part = recipient.split("@", 1)[0]

    name = re.sub(
        r"[._-]+",
        " ",
        local_part
    ).strip()

    name = name.title() if name else "there"

    replacements = {
        "{{hi}}": "Hi",
        "{{hello}}": "Hello",
        "{{thanks}}": "Thank you",
        "{{name}}": name,
        "{{email}}": recipient,
        "{{ref_code}}": secrets.token_hex(4).upper(),
    }

    for key, replacement in replacements.items():
        value = value.replace(key, replacement)

    return value


# =========================================================
# HTML TO TEXT
# =========================================================

def html_to_text(value):
    value = re.sub(
        r"(?i)<br\s*/?>|</p>|</div>",
        "\n",
        value
    )

    value = re.sub(
        r"<[^>]+>",
        "",
        value
    )

    return html.unescape(value)


# =========================================================
# BUILD EMAIL
# =========================================================

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
    message["From"] = formataddr(
        (sender_name, sender_email)
    )
    message["To"] = recipient
    message["Date"] = formatdate(localtime=True)
    message["Message-ID"] = make_msgid()

    if is_html:
        plain_body = html_to_text(final_body)

        if not plain_body.strip():
            plain_body = (
                "Please view this email in an HTML-capable email client."
            )

        message.set_content(plain_body)

        message.add_alternative(
            final_body,
            subtype="html"
        )
    else:
        message.set_content(final_body)

    return message


# =========================================================
# SEND ONE EMAIL
# =========================================================

def send_one_email(
    sender_name,
    sender_email,
    app_password,
    recipient,
    subject,
    body,
    is_html
):
    message = build_message(
        sender_name,
        sender_email,
        recipient,
        subject,
        body,
        is_html
    )

    context = ssl.create_default_context()

    with smtplib.SMTP_SSL(
        SMTP_HOST,
        SMTP_PORT,
        timeout=SMTP_TIMEOUT,
        context=context
    ) as server:

        server.login(
            sender_email,
            app_password
        )

        refused = server.send_message(message)

        if refused:
            raise smtplib.SMTPRecipientsRefused(refused)

    return True


# =========================================================
# PROCESS ONE RECIPIENT SAFELY
# =========================================================

def process_recipient(batch, recipient):
    try:
        send_one_email(
            sender_name=batch["sender_name"],
            sender_email=batch["sender_email"],
            app_password=batch["app_password"],
            recipient=recipient,
            subject=batch["subject"],
            body=batch["body"],
            is_html=batch["is_html"]
        )

        return {
            "email": recipient,
            "status": "sent",
            "error": None
        }

    except smtplib.SMTPAuthenticationError:
        return {
            "email": recipient,
            "status": "failed",
            "error": "Gmail authentication failed. Check the App Password."
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
        logger.exception("SMTP error for recipient.")
        return {
            "email": recipient,
            "status": "failed",
            "error": "SMTP connection or submission failed."
        }

    except Exception:
        logger.exception("Unexpected recipient error.")
        return {
            "email": recipient,
            "status": "failed",
            "error": "Unexpected sending error. Check Vercel logs."
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

    config_error = None

    if missing:
        config_error = (
            "Missing environment variables: "
            + ", ".join(missing)
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

    submitted_password = request.form.get(
        "password",
        ""
    )

    expected_password = get_login_password()

    if not hmac.compare_digest(
        submitted_password,
        expected_password
    ):
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
    response = login_required()

    if response:
        return response

    return render_template(
        "index.html",
        csrf_token=get_csrf_token()
    )


# =========================================================
# LOGOUT
# =========================================================

@app.route("/logout", methods=["GET", "POST"])
def logout():

    if request.method == "POST":

        if not is_logged_in():
            return jsonify({
                "ok": False,
                "error": "Not logged in."
            }), 401

        if not verify_csrf():
            return jsonify({
                "ok": False,
                "error": "Security token expired. Refresh the page."
            }), 403

    session.clear()

    if request.method == "POST":
        return jsonify({
            "ok": True,
            "message": "Logged out successfully."
        })

    return redirect(url_for("login"))


# =========================================================
# HEALTH CHECK
# =========================================================

@app.route("/health")
def health():
    return jsonify({
        "ok": True,
        "service": "Secure Mail Console",
        "templates_directory_exists": os.path.isdir(TEMPLATE_DIR),
        "login_template_exists": os.path.isfile(
            os.path.join(TEMPLATE_DIR, "login.html")
        ),
        "dashboard_template_exists": os.path.isfile(
            os.path.join(TEMPLATE_DIR, "index.html")
        ),
        "static_directory_exists": os.path.isdir(STATIC_DIR),
        "batch_size": BATCH_SIZE
    })


# =========================================================
# SEND BATCH API
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

    sender_name = clean_text(
        data.get("sender_name"),
        80
    )

    sender_email = clean_text(
        data.get("gmail"),
        254
    ).lower()

    app_password = data.get("app_password", "")

    subject = clean_text(
        data.get("subject"),
        MAX_SUBJECT_LENGTH
    )

    body = data.get("body", "")
    is_html = data.get("is_html") is True

    if not sender_name:
        return jsonify({
            "ok": False,
            "error": "Sender name is required."
        }), 400

    if not valid_email(sender_email):
        return jsonify({
            "ok": False,
            "error": "Enter a valid Gmail address."
        }), 400

    if not isinstance(app_password, str):
        return jsonify({
            "ok": False,
            "error": "Invalid Gmail App Password."
        }), 400

    app_password = re.sub(
        r"\s+",
        "",
        app_password
    )

    if not 12 <= len(app_password) <= 64:
        return jsonify({
            "ok": False,
            "error": "Check your Gmail App Password."
        }), 400

    if not subject:
        return jsonify({
            "ok": False,
            "error": "Email subject is required."
        }), 400

    if not isinstance(body, str) or not body.strip():
        return jsonify({
            "ok": False,
            "error": "Message body is required."
        }), 400

    if len(body) > MAX_MESSAGE_LENGTH:
        return jsonify({
            "ok": False,
            "error": "Message body is too long."
        }), 400

    recipients, recipient_error = parse_recipients(
        data.get("recipients")
    )

    if recipient_error:
        return jsonify({
            "ok": False,
            "error": recipient_error
        }), 400

    # Freeze this request's details.
    # Browser form edits cannot change this running batch.

    batch = {
        "sender_name": sender_name,
        "sender_email": sender_email,
        "app_password": app_password,
        "subject": subject,
        "body": body,
        "is_html": is_html,
        "recipients": tuple(recipients),
    }

    # -----------------------------------------------------
    # STREAMING: 4 RECIPIENTS PER BATCH
    # -----------------------------------------------------

    @stream_with_context
    def generate():

        total = len(batch["recipients"])

        sent = 0
        failed = 0
        batch_number = 0

        try:

            total_batches = (
                total + BATCH_SIZE - 1
            ) // BATCH_SIZE

            yield json.dumps({
                "event": "start",
                "total": total,
                "batch_size": BATCH_SIZE,
                "total_batches": total_batches
            }) + "\n"

            recipients = batch["recipients"]

            for start in range(0, total, BATCH_SIZE):

                batch_number += 1

                current_group = recipients[
                    start:start + BATCH_SIZE
                ]

                # Start up to four independent SMTP tasks.
                # Wait for this group before starting the next group.

                with ThreadPoolExecutor(
                    max_workers=BATCH_SIZE
                ) as executor:

                    futures = {
                        executor.submit(
                            process_recipient,
                            batch,
                            recipient
                        ): recipient
                        for recipient in current_group
                    }

                    for future in as_completed(futures):

                        try:
                            result = future.result()

                        except Exception:
                            logger.exception(
                                "Unexpected worker failure."
                            )

                            result = {
                                "email": futures[future],
                                "status": "failed",
                                "error": "Worker failed unexpectedly."
                            }

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
                            "total": total,
                            "batch_number": batch_number,
                            "total_batches": total_batches
                        }) + "\n"

                # Pause between groups, not between workers.
                if start + BATCH_SIZE < total:
                    time.sleep(BATCH_DELAY_SECONDS)

            yield json.dumps({
                "event": "complete",
                "sent": sent,
                "failed": failed,
                "total": total,
                "total_batches": total_batches,
                "message": "All batches processed."
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

    return (
        "Internal Server Error. Check Vercel Runtime Logs.",
        500
    )


# =========================================================
# VERCEL HANDLER
# =========================================================

handler = app
