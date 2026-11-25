
import os
import re
import ssl
import json
import time
import html
import logging
import smtplib
import secrets

from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from email.utils import formataddr, formatdate, make_msgid

from flask import (
    Flask, render_template, request, redirect,
    url_for, session, jsonify, Response, stream_with_context
)

# =====================================================
# APP AND PATHS
# =====================================================

BASE_DIR = Path(__file__).resolve().parent.parent

app = Flask(
    __name__,
    template_folder=str(BASE_DIR / "templates"),
    static_folder=str(BASE_DIR / "static"),
    static_url_path="/static",
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# =====================================================
# ENVIRONMENT VARIABLES
# =====================================================

LOGIN_PASSWORD = os.environ.get("LOGIN_PASSWORD", "")
SESSION_SECRET = os.environ.get("SESSION_SECRET", "")

AUTH_VERSION = "secure-login-v2"

CONFIG_ERRORS = []

if not LOGIN_PASSWORD:
    CONFIG_ERRORS.append("LOGIN_PASSWORD is missing.")

if len(SESSION_SECRET) < 32:
    CONFIG_ERRORS.append(
        "SESSION_SECRET must contain at least 32 characters."
    )

app.secret_key = SESSION_SECRET or "CONFIGURATION_REQUIRED"

app.config.update(
    SESSION_COOKIE_NAME="secure_mail_session_v2",
    SESSION_COOKIE_SECURE=True,
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    PERMANENT_SESSION_LIFETIME=1800,
    SESSION_REFRESH_EACH_REQUEST=False,
    MAX_CONTENT_LENGTH=1500000,
)

# =====================================================
# SMTP SETTINGS
# =====================================================

SMTP_HOST = "smtp.gmail.com"
SMTP_PORT = 465
SMTP_TIMEOUT = 25

MAX_RECIPIENTS = 25
MAX_PARALLEL_SENDS = 4
SEND_DELAY_SECONDS = 1.5

EMAIL_RE = re.compile(
    r"^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@"
    r"[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$"
)

# =====================================================
# HELPERS
# =====================================================

def configuration_error():
    if CONFIG_ERRORS:
        return "Server configuration incomplete: " + " ".join(CONFIG_ERRORS)
    return None


def is_logged_in():
    return (
        session.get("authenticated") is True
        and session.get("auth_version") == AUTH_VERSION
    )


def json_error(message, status=400):
    return jsonify({
        "success": False,
        "message": message,
    }), status


def ndjson(event):
    return json.dumps(event, ensure_ascii=False) + "\n"


def clean_header(value, limit=998):
    return (
        str(value or "")
        .replace("\r", " ")
        .replace("\n", " ")
        .strip()[:limit]
    )


def valid_email(value):
    if not isinstance(value, str):
        return False
    value = value.strip()
    return len(value) <= 254 and bool(EMAIL_RE.fullmatch(value))


# =====================================================
# CENTRAL LOGIN PROTECTION
# =====================================================

@app.before_request
def require_login():
    # Login page and static assets remain public.
    if request.endpoint in ("login", "static"):
        return None

    # Health check only reports status; it does not expose secrets.
    if request.endpoint == "health":
        return None

    if configuration_error():
        return (
            "Server configuration incomplete. Check LOGIN_PASSWORD "
            "and SESSION_SECRET in Vercel Environment Variables.",
            503,
        )

    if not is_logged_in():
        session.clear()

        if request.path.startswith("/send-batch"):
            return json_error(
                "Please sign in before sending emails.",
                401,
            )

        return redirect(url_for("login"))

    return None


# =====================================================
# LOGIN
# =====================================================

@app.route("/login", methods=["GET", "POST"])
def login():
    if configuration_error():
        return (
            "Login setup incomplete. Configure LOGIN_PASSWORD and "
            "SESSION_SECRET (minimum 32 characters) in Vercel.",
            503,
        )

    if is_logged_in():
        return redirect(url_for("home"))

    if request.method == "GET":
        return render_template("login.html", error=None)

    password = request.form.get("password", "")

    if not secrets.compare_digest(
        str(password),
        str(LOGIN_PASSWORD),
    ):
        return render_template(
            "login.html",
            error="Incorrect password. Please try again.",
        ), 401

    # Remove any previous session contents.
    session.clear()

    # New authenticated session.
    session["authenticated"] = True
    session["auth_version"] = AUTH_VERSION

    # Session cookie expires when the browser session ends.
    session.permanent = False

    return redirect(url_for("home"))


# =====================================================
# LOGOUT
# =====================================================

@app.route("/logout", methods=["GET", "POST"])
def logout():
    session.clear()
    response = redirect(url_for("login"))

    response.delete_cookie(
        app.config["SESSION_COOKIE_NAME"],
        path="/",
    )

    return response


# =====================================================
# HOME
# =====================================================

@app.route("/")
def home():
    return render_template("index.html")


# =====================================================
# RECIPIENT HANDLING
# =====================================================

def normalize_recipient(item):
    if isinstance(item, str):
        return {
            "email": item.strip().lower(),
            "name": "",
            "hi": "",
            "hello": "",
            "thanks": "",
            "ref_code": "",
        }

    if not isinstance(item, dict):
        return None

    def safe_value(value, limit=200):
        return (
            str(value or "")
            .replace("\r", " ")
            .replace("\n", " ")
            .strip()[:limit]
        )

    return {
        "email": str(item.get("email", "")).strip().lower(),
        "name": safe_value(item.get("name")),
        "hi": safe_value(item.get("hi"), 100),
        "hello": safe_value(item.get("hello"), 100),
        "thanks": safe_value(item.get("thanks"), 100),
        "ref_code": safe_value(item.get("ref_code")),
    }


def clean_recipients(items):
    if isinstance(items, str):
        items = re.split(r"[\s,;]+", items)

    if not isinstance(items, list):
        return []

    result = []
    seen = set()

    for item in items:
        recipient = normalize_recipient(item)

        if not recipient:
            continue

        address = recipient["email"]

        if not valid_email(address) or address in seen:
            continue

        seen.add(address)
        result.append(recipient)

    return result


# =====================================================
# PERSONALIZATION
# =====================================================

def personalize(value, recipient, html_mode=False):
    replacements = {
        "{{hi}}": recipient.get("hi", ""),
        "{{hello}}": recipient.get("hello", ""),
        "{{thanks}}": recipient.get("thanks", ""),
        "{{name}}": recipient.get("name", ""),
        "{{email}}": recipient.get("email", ""),
        "{{ref_code}}": recipient.get("ref_code", ""),
    }

    result = str(value or "")

    for key, replacement in replacements.items():
        replacement = str(replacement or "")

        if html_mode:
            replacement = html.escape(replacement)

        result = result.replace(key, replacement)

    return result


# =====================================================
# HTML TO TEXT
# =====================================================

def html_to_text(value):
    text = str(value or "")

    text = re.sub(
        r"<\s*br\s*/?\s*>",
        "\n",
        text,
        flags=re.I,
    )

    text = re.sub(
        r"</\s*(p|div|tr|h[1-6])\s*>",
        "\n\n",
        text,
        flags=re.I,
    )

    text = re.sub(r"<[^>]+>", "", text)

    return html.unescape(text).strip()


# =====================================================
# BUILD MESSAGE
# =====================================================

def build_message(
    gmail,
    sender_name,
    recipient,
    subject,
    body,
    is_html,
):
    if is_html:
        message = MIMEMultipart("alternative")

        message.attach(
            MIMEText(html_to_text(body), "plain", "utf-8")
        )

        message.attach(
            MIMEText(body, "html", "utf-8")
        )
    else:
        message = MIMEText(body, "plain", "utf-8")

    message["Subject"] = clean_header(subject)
    message["From"] = formataddr(
        (clean_header(sender_name, 200), gmail)
    )
    message["To"] = recipient
    message["Date"] = formatdate(localtime=True)
    message["Message-ID"] = make_msgid()

    return message


# =====================================================
# SEND ONE EMAIL
# =====================================================

def send_one_email(
    gmail,
    app_password,
    sender_name,
    subject,
    body,
    is_html,
    recipient_data,
):
    recipient = recipient_data["email"]

    try:
        final_subject = personalize(subject, recipient_data)

        final_body = personalize(
            body,
            recipient_data,
            html_mode=is_html,
        )

        message = build_message(
            gmail,
            sender_name,
            recipient,
            final_subject,
            final_body,
            is_html,
        )

        password = re.sub(r"\s+", "", str(app_password))

        if SEND_DELAY_SECONDS:
            time.sleep(SEND_DELAY_SECONDS)

        context = ssl.create_default_context()

        with smtplib.SMTP_SSL(
            SMTP_HOST,
            SMTP_PORT,
            timeout=SMTP_TIMEOUT,
            context=context,
        ) as server:
            server.ehlo()
            server.login(gmail, password)

            refused = server.sendmail(
                gmail,
                [recipient],
                message.as_string(),
            )

            if refused:
                return {
                    "result": "failed",
                    "error": "Recipient refused by SMTP server.",
                }

        return {
            "result": "sent",
            "error": None,
        }

    except smtplib.SMTPAuthenticationError:
        logger.exception("Gmail authentication failed")
        return {
            "result": "failed",
            "error": "Gmail authentication failed. Check App Password.",
        }

    except smtplib.SMTPRecipientsRefused:
        return {
            "result": "failed",
            "error": "Recipient refused by Gmail SMTP.",
        }

    except smtplib.SMTPDataError as exc:
        logger.exception("SMTP message rejected")
        return {
            "result": "failed",
            "error": f"SMTP rejected message. Code: {exc.smtp_code}",
        }

    except (smtplib.SMTPException, OSError, TimeoutError):
        logger.exception("SMTP sending error for %s", recipient)
        return {
            "result": "failed",
            "error": "SMTP connection or sending failed.",
        }

    except Exception:
        logger.exception("Unexpected email error for %s", recipient)
        return {
            "result": "failed",
            "error": "Unexpected sending error.",
        }


# =====================================================
# SEND BATCH
# =====================================================

@app.route("/send-batch", methods=["POST"])
def send_batch():
    if not is_logged_in():
        return json_error("Please log in again.", 401)

    data = request.get_json(silent=True)

    if not isinstance(data, dict):
        return json_error("Invalid request data.")

    sender_name = clean_header(data.get("sender_name", ""), 200)
    gmail = clean_header(data.get("gmail", ""), 254).lower()
    app_password = str(data.get("app_password", "")).strip()
    subject = clean_header(data.get("subject", ""))
    body = str(data.get("body", ""))
    is_html = data.get("is_html") is True

    if data.get("consent_confirmed") is not True:
        return json_error("Please confirm recipient consent.")

    if not sender_name:
        return json_error("Enter sender name.")

    if not valid_email(gmail) or not gmail.endswith("@gmail.com"):
        return json_error("Enter a valid Gmail address.")

    if not app_password:
        return json_error("Enter Gmail App Password.")

    if not subject or not body.strip():
        return json_error("Subject and message are required.")

    recipients = clean_recipients(data.get("recipients", []))

    if not recipients:
        return json_error("No valid recipient addresses found.")

    if len(recipients) > MAX_RECIPIENTS:
        return json_error(
            f"Maximum {MAX_RECIPIENTS} recipients per batch."
        )

    def generate():
        total = len(recipients)
        sent = 0
        failed = 0

        yield ndjson({
            "type": "start",
            "total": total,
            "sent": 0,
            "failed": 0,
            "remaining": total,
        })

        with ThreadPoolExecutor(
            max_workers=MAX_PARALLEL_SENDS
        ) as executor:

            futures = {
                executor.submit(
                    send_one_email,
                    gmail,
                    app_password,
                    sender_name,
                    subject,
                    body,
                    is_html,
                    recipient,
                ): recipient["email"]
                for recipient in recipients
            }

            for future in as_completed(futures):
                address = futures[future]

                try:
                    result = future.result()
                except Exception:
                    logger.exception("Worker failed for %s", address)
                    result = {
                        "result": "failed",
                        "error": "Worker error.",
                    }

                if result["result"] == "sent":
                    sent += 1
                else:
                    failed += 1

                yield ndjson({
                    "type": "progress",
                    "email": address,
                    "result": result["result"],
                    "error": result.get("error"),
                    "total": total,
                    "sent": sent,
                    "failed": failed,
                    "remaining": total - sent - failed,
                })

        yield ndjson({
            "type": "complete",
            "success": failed == 0,
            "total": total,
            "sent": sent,
            "failed": failed,
            "remaining": 0,
            "message": "Sending process completed.",
            "delivery_note": (
                "SMTP acceptance does not guarantee Inbox placement."
            ),
        })

    response = Response(
        stream_with_context(generate()),
        content_type="application/x-ndjson; charset=utf-8",
    )

    response.headers["Cache-Control"] = "no-cache, no-store, no-transform"
    response.headers["X-Accel-Buffering"] = "no"

    return response


# =====================================================
# HEALTH CHECK
# =====================================================

@app.route("/health")
def health():
    return jsonify({
        "status": "ok",
        "configuration_ok": not CONFIG_ERRORS,
        "configuration_errors": CONFIG_ERRORS,
    })


# =====================================================
# ERROR HANDLERS
# =====================================================

@app.errorhandler(413)
def too_large(error):
    return json_error("Request is too large.", 413)


@app.errorhandler(500)
def internal_error(error):
    logger.exception("Internal server error")
    return jsonify({
        "success": False,
        "message": "Internal server error. Check Vercel Runtime Logs.",
    }), 500


# =====================================================
# VERCEL HANDLER
# =====================================================

handler = app


if __name__ == "__main__":
    app.run(
        host="0.0.0.0",
        port=5000,
        debug=False,
    )
