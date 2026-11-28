
import os
import re
import json
import time
import hmac
import secrets
import smtplib
import ssl
import html
import logging

from datetime import timedelta
from email.message import EmailMessage
from email.utils import formataddr, formatdate, make_msgid

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
# APPLICATION CONFIGURATION
# =========================================================

app = Flask(__name__)

app.wsgi_app = ProxyFix(
    app.wsgi_app,
    x_for=1,
    x_proto=1,
    x_host=1
)

# SESSION_SECRET must be configured in Vercel.
# The fallback prevents startup failure, but is not suitable
# for reliable sessions across serverless instances.
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
# SMTP SETTINGS
# =========================================================

SMTP_HOST = "smtp.gmail.com"
SMTP_PORT = 465
SMTP_TIMEOUT = 20

MAX_RECIPIENTS = 25
SEND_DELAY_SECONDS = 1.0

MAX_MESSAGE_LENGTH = 30000
MAX_SUBJECT_LENGTH = 200


# =========================================================
# ENVIRONMENT CONFIGURATION
# =========================================================

def get_login_password():
    return os.environ.get("LOGIN_PASSWORD", "")


def get_missing_configuration():
    missing = []

    if not os.environ.get("SESSION_SECRET"):
        missing.append("SESSION_SECRET")

    if not get_login_password():
        missing.append("LOGIN_PASSWORD")

    return missing


# =========================================================
# LOGIN AND SESSION HELPERS
# =========================================================

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


def require_login():
    if not is_logged_in():
        return redirect(url_for("login"))

    return None


# =========================================================
# INPUT HELPERS
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

        email_address = item.strip().lower()

        if not email_address:
            continue

        if email_address in seen:
            continue

        seen.add(email_address)

        if not valid_email(email_address):
            return None, (
                "Invalid email address: " + email_address
            )

        recipients.append(email_address)

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

    for placeholder, replacement in replacements.items():
        value = value.replace(
            placeholder,
            replacement
        )

    return value


# =========================================================
# HTML TO PLAIN TEXT
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
# BUILD EMAIL MESSAGE
# =========================================================

def build_message(
    sender_name,
    sender_email,
    recipient,
    subject,
    body,
    is_html
):
    personalized_subject = personalize(
        subject,
        recipient
    )

    personalized_body = personalize(
        body,
        recipient
    )

    message = EmailMessage()

    message["Subject"] = personalized_subject

    message["From"] = formataddr(
        (sender_name, sender_email)
    )

    message["To"] = recipient
    message["Date"] = formatdate(localtime=True)
    message["Message-ID"] = make_msgid()

    if is_html:
        plain_body = html_to_text(
            personalized_body
        )

        if not plain_body.strip():
            plain_body = (
                "Please view this email in an HTML-capable email client."
            )

        message.set_content(plain_body)

        message.add_alternative(
            personalized_body,
            subtype="html"
        )

    else:
        message.set_content(
            personalized_body
        )

    return message


# =========================================================
# SEND ONE EMAIL THROUGH GMAIL SMTP
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
        sender_name=sender_name,
        sender_email=sender_email,
        recipient=recipient,
        subject=subject,
        body=body,
        is_html=is_html
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

        refused = server.send_message(
            message
        )

        if refused:
            raise smtplib.SMTPRecipientsRefused(
                refused
            )

    return True


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
    missing = get_missing_configuration()

    config_error = None

    if missing:
        config_error = (
            "Missing Vercel environment variables: "
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
            error=(
                "Server configuration is incomplete. "
                "Please configure Vercel environment variables."
            ),
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
    login_response = require_login()

    if login_response:
        return login_response

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
        "service": "Secure Mail Console"
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

    # -----------------------------------------------------
    # CONSENT
    # -----------------------------------------------------

    if data.get("consent") is not True:
        return jsonify({
            "ok": False,
            "error": "Recipient permission confirmation is required."
        }), 400

    # -----------------------------------------------------
    # SENDER DETAILS
    # -----------------------------------------------------

    sender_name = clean_text(
        data.get("sender_name"),
        80
    )

    sender_email = clean_text(
        data.get("gmail"),
        254
    ).lower()

    app_password = data.get(
        "app_password",
        ""
    )

    subject = clean_text(
        data.get("subject"),
        MAX_SUBJECT_LENGTH
    )

    body = data.get("body", "")

    is_html = data.get("is_html") is True

    # -----------------------------------------------------
    # VALIDATE SENDER
    # -----------------------------------------------------

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

    # Gmail App Passwords may be displayed with spaces.
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

    # -----------------------------------------------------
    # VALIDATE RECIPIENTS
    # -----------------------------------------------------

    recipients, recipient_error = parse_recipients(
        data.get("recipients")
    )

    if recipient_error:
        return jsonify({
            "ok": False,
            "error": recipient_error
        }), 400

    # -----------------------------------------------------
    # INDEPENDENT BATCH SNAPSHOT
    #
    # Editing the browser form after submission will not
    # change these values for the running batch.
    # -----------------------------------------------------

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
    # STREAMING RESPONSE
    # -----------------------------------------------------

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

            for index, recipient in enumerate(
                batch["recipients"]
            ):

                error_message = None
                status = "failed"

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

                    sent += 1
                    status = "sent"

                except smtplib.SMTPAuthenticationError:

                    failed += 1

                    error_message = (
                        "Gmail authentication failed. "
                        "Check Gmail address and App Password."
                    )

                except smtplib.SMTPRecipientsRefused:

                    failed += 1

                    error_message = (
                        "Gmail rejected this recipient address."
                    )

                except smtplib.SMTPResponseException as exc:

                    failed += 1

                    error_message = (
                        "SMTP rejected the message. SMTP code: "
                        + str(exc.smtp_code)
                    )

                except (smtplib.SMTPException, OSError, ssl.SSLError):

                    failed += 1

                    logger.exception(
                        "SMTP error while sending to one recipient."
                    )

                    error_message = (
                        "SMTP connection or submission failed. "
                        "Check Gmail settings and try again later."
                    )

                except Exception:

                    failed += 1

                    logger.exception(
                        "Unexpected recipient processing error."
                    )

                    error_message = (
                        "Unexpected sending error. Check server logs."
                    )

                # Send progress event to dashboard.

                yield json.dumps({
                    "event": "progress",
                    "email": recipient,
                    "status": status,
                    "error": error_message,
                    "sent": sent,
                    "failed": failed,
                    "total": total
                }) + "\n"

                # Conservative pause between messages.

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
            # Release the reference after the stream ends.
            batch["app_password"] = ""

    return Response(
        generate(),
        mimetype="application/x-ndjson",
        headers={
            "Cache-Control": "no-cache, no-store",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive"
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
    logger.exception("Application error")

    return (
        "Internal Server Error. Check Vercel Runtime Logs.",
        500
    )


# =========================================================
# VERCEL SERVERLESS HANDLER
# =========================================================

handler = app
