
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

# =========================================================
# CONFIGURATION
# =========================================================

app = Flask(__name__)

SESSION_SECRET = os.environ.get("SESSION_SECRET", "").strip()
LOGIN_PASSWORD = os.environ.get("LOGIN_PASSWORD", "")

# A random fallback prevents startup failure, but login remains
# disabled unless a stable SESSION_SECRET is configured.
app.secret_key = SESSION_SECRET or secrets.token_hex(32)

app.config.update(
    SESSION_COOKIE_SECURE=True,
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    PERMANENT_SESSION_LIFETIME=timedelta(hours=1),
)

SMTP_HOST = "smtp.gmail.com"
SMTP_PORT = 465
SMTP_TIMEOUT = 20

MAX_RECIPIENTS = 25
MAX_PARALLEL_SENDS = 9
SEND_DELAY_SECONDS = 0.8

EMAIL_RE = re.compile(
    r"^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@"
    r"[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$"
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Process-local pacing. Separate serverless instances have separate locks.
_send_lock = threading.Lock()
_next_send_time = 0.0


# =========================================================
# BASIC HELPERS
# =========================================================

def json_error(message, status=400):
    return jsonify({
        "ok": False,
        "message": message
    }), status


def ndjson_event(data):
    return json.dumps(data, ensure_ascii=False) + "\n"


def valid_email(email):
    if not isinstance(email, str):
        return False

    email = email.strip()

    if len(email) > 254:
        return False

    return bool(EMAIL_RE.fullmatch(email))


def normalize_recipients(value):
    if not isinstance(value, list):
        raise ValueError("Recipients must be provided as a list.")

    result = []
    seen = set()

    for item in value:
        if not isinstance(item, str):
            continue

        email = item.strip().lower()

        if not email:
            continue

        if not valid_email(email):
            raise ValueError("Invalid email address: " + email)

        if email not in seen:
            seen.add(email)
            result.append(email)

    if not result:
        raise ValueError("Enter at least one valid recipient.")

    if len(result) > MAX_RECIPIENTS:
        raise ValueError(
            f"Maximum {MAX_RECIPIENTS} unique recipients are allowed."
        )

    return result


def wait_for_send_slot():
    global _next_send_time

    with _send_lock:
        now = time.monotonic()
        wait_time = max(0.0, _next_send_time - now)

        if wait_time:
            time.sleep(wait_time)

        _next_send_time = time.monotonic() + SEND_DELAY_SECONDS


def personalize(value, recipient, is_html=False):
    local_name = recipient.split("@", 1)[0]
    name = re.sub(r"[._-]+", " ", local_name).strip().title()

    replacements = {
        "{{hi}}": "Hi",
        "{{hello}}": "Hello",
        "{{thanks}}": "Thank you",
        "{{name}}": name,
        "{{email}}": recipient,
        "{{ref_code}}": secrets.token_hex(4).upper(),
    }

    result = str(value)

    for key, replacement in replacements.items():
        if is_html:
            replacement = html.escape(replacement)

        result = result.replace(key, replacement)

    return result


def html_to_text(value):
    from html.parser import HTMLParser

    class TextExtractor(HTMLParser):
        def __init__(self):
            super().__init__()
            self.parts = []

        def handle_data(self, data):
            self.parts.append(data)

        def handle_starttag(self, tag, attrs):
            if tag in ("br", "p", "div", "li", "tr"):
                self.parts.append("\n")

    parser = TextExtractor()
    parser.feed(value)

    return "\n".join(
        line.strip()
        for line in "".join(parser.parts).splitlines()
        if line.strip()
    )


# =========================================================
# LOGIN CONFIGURATION CHECK
# =========================================================

def login_configuration_ok():
    return (
        bool(LOGIN_PASSWORD)
        and len(SESSION_SECRET) >= 32
    )


# =========================================================
# LOGIN PROTECTION
# =========================================================

@app.before_request
def require_login():
    allowed_endpoints = {
        "login",
        "logout",
        "health",
        "static",
    }

    if request.endpoint in allowed_endpoints:
        return None

    if not login_configuration_ok():
        if request.path == "/send-batch":
            return json_error(
                "Server login configuration is missing. "
                "Check LOGIN_PASSWORD and SESSION_SECRET.",
                503
            )

        return (
            "Server login configuration is incomplete. "
            "Set LOGIN_PASSWORD and SESSION_SECRET in Vercel.",
            503
        )

    if session.get("authenticated") is True:
        return None

    if request.path == "/send-batch":
        return json_error("Please log in first.", 401)

    return redirect(url_for("login"))


# =========================================================
# LOGIN ROUTE
# =========================================================

@app.route("/login", methods=["GET", "POST"])
def login():

    if not login_configuration_ok():
        return (
            "Login is not configured. Please set LOGIN_PASSWORD "
            "and SESSION_SECRET in Vercel Production Environment Variables.",
            503
        )

    if session.get("authenticated") is True:
        return redirect(url_for("index"))

    error = None

    if request.method == "POST":
        password = request.form.get("password", "")

        if not password:
            error = "Please enter your password."

        elif secrets.compare_digest(password, LOGIN_PASSWORD):
            session.clear()
            session.permanent = True
            session["authenticated"] = True
            session["login_time"] = int(time.time())

            return redirect(url_for("index"))

        else:
            error = "Incorrect password. Please try again."

    return render_template("login.html", error=error)


# =========================================================
# LOGOUT ROUTE
# =========================================================

@app.route("/logout", methods=["GET", "POST"])
def logout():
    session.clear()
    return redirect(url_for("login"))


# =========================================================
# HOME ROUTE
# =========================================================

@app.route("/", methods=["GET"])
def index():
    return render_template("index.html")


# =========================================================
# HEALTH CHECK
# =========================================================

@app.route("/health", methods=["GET"])
def health():
    return jsonify({
        "ok": True,
        "service": "Secure Mail Console",
        "login_configured": login_configuration_ok(),
    })


# =========================================================
# EMAIL MESSAGE BUILDER
# =========================================================

def build_message(
    sender_name,
    gmail,
    recipient,
    subject,
    body,
    is_html,
):
    if "\r" in subject or "\n" in subject:
        raise ValueError("Subject contains invalid characters.")

    if "\r" in sender_name or "\n" in sender_name:
        raise ValueError("Sender name contains invalid characters.")

    personalized_subject = personalize(subject, recipient)

    if not personalized_subject.strip():
        raise ValueError("Email subject cannot be empty.")

    message = EmailMessage()

    message["Subject"] = personalized_subject
    message["From"] = formataddr((sender_name, gmail))
    message["To"] = recipient

    if is_html:
        personalized_html = personalize(
            body,
            recipient,
            is_html=True
        )

        plain_text = html_to_text(personalized_html)

        message.set_content(
            plain_text or "Please view this email in an HTML-compatible email client."
        )

        message.add_alternative(
            personalized_html,
            subtype="html"
        )

    else:
        personalized_body = personalize(body, recipient)
        message.set_content(personalized_body)

    return message


# =========================================================
# SEND ONE EMAIL
# =========================================================

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

            server.login(gmail, app_password)

            refused = server.send_message(
                message,
                from_addr=gmail,
                to_addrs=[recipient],
            )

        if refused:
            return {
                "email": recipient,
                "result": "failed",
                "error": "Gmail refused this recipient."
            }

        return {
            "email": recipient,
            "result": "sent",
            "error": ""
        }

    except smtplib.SMTPAuthenticationError:
        return {
            "email": recipient,
            "result": "failed",
            "error": "Gmail authentication failed. Check Gmail and App Password."
        }

    except smtplib.SMTPRecipientsRefused:
        return {
            "email": recipient,
            "result": "failed",
            "error": "Gmail refused the recipient address."
        }

    except smtplib.SMTPException as exc:
        logger.warning(
            "SMTP error for recipient %s: %s",
            recipient,
            type(exc).__name__,
        )

        return {
            "email": recipient,
            "result": "failed",
            "error": "SMTP error: " + type(exc).__name__
        }

    except (OSError, TimeoutError):
        logger.warning(
            "Connection error while sending to %s",
            recipient,
        )

        return {
            "email": recipient,
            "result": "failed",
            "error": (
                "Connection failed or timed out. "
                "Check delivery status before retrying."
            )
        }

    except Exception as exc:
        logger.exception(
            "Unexpected email error for %s",
            recipient,
        )

        return {
            "email": recipient,
            "result": "failed",
            "error": "Unexpected error: " + type(exc).__name__
        }


# =========================================================
# SEND BATCH API
# =========================================================

@app.route("/send-batch", methods=["POST"])
def send_batch():

    if not session.get("authenticated"):
        return json_error("Please log in first.", 401)

    data = request.get_json(silent=True)

    if not isinstance(data, dict):
        return json_error("Invalid JSON request.")

    sender_name = data.get("sender_name", "")
    gmail = data.get("gmail", "")
    app_password = data.get("app_password", "")
    subject = data.get("subject", "")
    body = data.get("body", "")
    is_html = data.get("is_html", False)
    consent_confirmed = data.get("consent_confirmed", False)

    if not isinstance(sender_name, str):
        return json_error("Invalid sender name.")

    if not isinstance(gmail, str):
        return json_error("Invalid Gmail address.")

    if not isinstance(app_password, str):
        return json_error("Invalid App Password.")

    if not isinstance(subject, str):
        return json_error("Invalid subject.")

    if not isinstance(body, str):
        return json_error("Invalid message body.")

    sender_name = sender_name.strip()
    gmail = gmail.strip().lower()
    app_password = app_password.replace(" ", "").strip()
    subject = subject.strip()

    if not sender_name:
        return json_error("Enter sender name.")

    if not valid_email(gmail) or not gmail.endswith("@gmail.com"):
        return json_error("Enter a valid Gmail address.")

    if not app_password:
        return json_error("Enter Gmail App Password.")

    if not subject:
        return json_error("Enter email subject.")

    if not body.strip():
        return json_error("Enter message body.")

    if len(subject) > 250:
        return json_error("Subject is too long.")

    if len(body) > 100000:
        return json_error("Message body is too large.")

    if not isinstance(is_html, bool):
        return json_error("Invalid HTML mode.")

    if consent_confirmed is not True:
        return json_error(
            "Confirm that recipients agreed to receive this email."
        )

    try:
        recipients = normalize_recipients(
            data.get("recipients")
        )
    except ValueError as exc:
        return json_error(str(exc))

    total = len(recipients)

    # Values needed by the streaming generator.
    send_args = {
        "sender_name": sender_name,
        "gmail": gmail,
        "app_password": app_password,
        "subject": subject,
        "body": body,
        "is_html": is_html,
    }

    @stream_with_context
    def generate():

        sent = 0
        failed = 0

        yield ndjson_event({
            "type": "start",
            "total": total,
            "sent": 0,
            "failed": 0,
            "remaining": total,
        })

        try:
            with ThreadPoolExecutor(
                max_workers=MAX_PARALLEL_SENDS
            ) as executor:

                futures = {
                    executor.submit(
                        send_one_email,
                        send_args["sender_name"],
                        send_args["gmail"],
                        send_args["app_password"],
                        recipient,
                        send_args["subject"],
                        send_args["body"],
                        send_args["is_html"],
                    ): recipient
                    for recipient in recipients
                }

                for future in as_completed(futures):

                    recipient = futures[future]

                    try:
                        result = future.result()

                    except Exception as exc:
                        logger.exception(
                            "Worker failed for %s",
                            recipient,
                        )

                        result = {
                            "email": recipient,
                            "result": "failed",
                            "error": "Worker error: " + type(exc).__name__
                        }

                    if result["result"] == "sent":
                        sent += 1
                    else:
                        failed += 1

                    yield ndjson_event({
                        "type": "progress",
                        "email": result["email"],
                        "result": result["result"],
                        "error": result.get("error", ""),
                        "total": total,
                        "sent": sent,
                        "failed": failed,
                        "remaining": total - sent - failed,
                    })

        except Exception:
            logger.exception("Batch processing error")

        yield ndjson_event({
            "type": "complete",
            "total": total,
            "sent": sent,
            "failed": failed,
            "remaining": total - sent - failed,
        })

    return Response(
        generate(),
        mimetype="application/x-ndjson",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
        },
    )


# =========================================================
# ERROR HANDLERS
# =========================================================

@app.errorhandler(404)
def not_found(error):
    if request.path.startswith("/send-batch"):
        return json_error("Endpoint not found.", 404)

    return "Page not found.", 404


@app.errorhandler(405)
def method_not_allowed(error):
    if request.path.startswith("/send-batch"):
        return json_error("Method not allowed.", 405)

    return "Method not allowed.", 405


@app.errorhandler(500)
def internal_server_error(error):
    logger.exception("Internal server error")
    if request.path.startswith("/send-batch"):
        return json_error("Internal server error.", 500)

    return "Internal server error.", 500


# =========================================================
# VERCEL HANDLER
# =========================================================

handler = app


if __name__ == "__main__":
    app.run(
        host="0.0.0.0",
        port=int(os.environ.get("PORT", 5000)),
        debug=False,
    )
