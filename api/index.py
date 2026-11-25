
import os
import re
import ssl
import json
import time
import html
import logging
import secrets
import smtplib
import threading
from datetime import timedelta
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from email.utils import formataddr, make_msgid
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

# --------------------------------------------------
# APP CONFIGURATION
# --------------------------------------------------

app = Flask(__name__)

LOGIN_PASSWORD = os.environ.get("LOGIN_PASSWORD", "")
SESSION_SECRET = os.environ.get("SESSION_SECRET", "")

# Fail closed if environment variables are missing.
CONFIG_OK = (
    bool(LOGIN_PASSWORD)
    and len(SESSION_SECRET) >= 32
)

# Do not use a random production secret: sessions must remain
# valid across Vercel serverless invocations.
app.secret_key = SESSION_SECRET or "MISCONFIGURED_SESSION_SECRET"

app.config.update(
    SESSION_COOKIE_SECURE=True,
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    PERMANENT_SESSION_LIFETIME=timedelta(hours=1),
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# --------------------------------------------------
# EMAIL SETTINGS
# --------------------------------------------------

SMTP_HOST = "smtp.gmail.com"
SMTP_PORT = 465
SMTP_TIMEOUT = 20

MAX_RECIPIENTS = 25
MAX_PARALLEL_SENDS = 9
SEND_DELAY_SECONDS = 0.8

EMAIL_RE = re.compile(
    r"^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+"
    r"@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$"
)

# --------------------------------------------------
# SECURITY
# --------------------------------------------------

@app.before_request
def protect_routes():
    # Do not allow the application to run without its secrets.
    if not CONFIG_OK:
        return (
            "Server configuration error. Set LOGIN_PASSWORD and "
            "SESSION_SECRET in Vercel Environment Variables.",
            503,
        )

    allowed_endpoints = {
        "login",
        "health",
        "static",
    }

    if request.endpoint in allowed_endpoints:
        return None

    if not session.get("authenticated"):
        return redirect(url_for("login"))

    return None


@app.after_request
def security_headers(response):
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Cache-Control"] = "no-store"
    return response


# --------------------------------------------------
# LOGIN
# --------------------------------------------------

@app.route("/login", methods=["GET", "POST"])
def login():
    if not CONFIG_OK:
        return (
            "Server configuration error. Check LOGIN_PASSWORD "
            "and SESSION_SECRET in Vercel.",
            503,
        )

    if session.get("authenticated"):
        return redirect(url_for("index"))

    error = None

    if request.method == "POST":
        password = request.form.get("password", "")

        if secrets.compare_digest(password, LOGIN_PASSWORD):
            session.clear()
            session.permanent = True
            session["authenticated"] = True
            session["login_time"] = int(time.time())

            return redirect(url_for("index"))

        error = "Incorrect password. Please try again."

    return render_template("login.html", error=error)


@app.route("/logout", methods=["GET", "POST"])
def logout():
    session.clear()
    return redirect(url_for("login"))


# --------------------------------------------------
# DASHBOARD
# --------------------------------------------------

@app.route("/", methods=["GET"])
def index():
    if not session.get("authenticated"):
        return redirect(url_for("login"))

    return render_template("index.html")


@app.route("/health", methods=["GET"])
def health():
    return jsonify({
        "ok": True,
        "configured": CONFIG_OK,
        "authenticated": bool(session.get("authenticated")),
    })


# --------------------------------------------------
# RECIPIENT VALIDATION
# --------------------------------------------------

def normalize_recipients(raw):
    if not isinstance(raw, str):
        return [], ["Recipients must be text."]

    parts = re.split(r"[\s,;]+", raw.strip())

    valid = []
    invalid = []
    seen = set()

    for item in parts:
        email = item.strip()

        if not email:
            continue

        key = email.lower()

        if key in seen:
            continue

        seen.add(key)

        if len(email) > 254 or not EMAIL_RE.fullmatch(email):
            invalid.append(email)
        else:
            valid.append(email)

    return valid, invalid


# --------------------------------------------------
# PERSONALIZATION
# --------------------------------------------------

def personalize(value, recipient):
    local_part = recipient.split("@", 1)[0]
    display_name = re.sub(r"[._+-]+", " ", local_part).strip()
    display_name = display_name.title() or "there"

    replacements = {
        "{{hi}}": "Hi",
        "{{hello}}": "Hello",
        "{{thanks}}": "Thank you",
        "{{name}}": display_name,
        "{{email}}": recipient,
        "{{ref_code}}": secrets.token_hex(4).upper(),
    }

    for key, replacement in replacements.items():
        value = value.replace(key, replacement)

    return value


def html_to_text(value):
    value = re.sub(
        r"(?i)<\s*(br|/p|/div|/li|/tr)\s*/?\s*>",
        "\n",
        value,
    )
    value = re.sub(r"<[^>]*>", "", value)
    return html.unescape(value).strip()


# --------------------------------------------------
# EMAIL MESSAGE
# --------------------------------------------------

def build_message(
    sender_name,
    gmail,
    recipient,
    subject,
    body,
    is_html,
):
    final_subject = personalize(subject, recipient)
    final_body = personalize(body, recipient)

    if is_html:
        plain_body = html_to_text(final_body)

        message = MIMEMultipart("alternative")
        message.attach(MIMEText(plain_body, "plain", "utf-8"))
        message.attach(MIMEText(final_body, "html", "utf-8"))
    else:
        message = MIMEText(final_body, "plain", "utf-8")

    message["Subject"] = final_subject
    message["From"] = formataddr((sender_name, gmail))
    message["To"] = recipient
    message["Message-ID"] = make_msgid()

    return message


# --------------------------------------------------
# SEND ONE EMAIL
# --------------------------------------------------

def send_one_email(
    recipient,
    sender_name,
    gmail,
    app_password,
    subject,
    body,
    is_html,
):
    server = None

    try:
        message = build_message(
            sender_name,
            gmail,
            recipient,
            subject,
            body,
            is_html,
        )

        context = ssl.create_default_context()

        server = smtplib.SMTP_SSL(
            SMTP_HOST,
            SMTP_PORT,
            timeout=SMTP_TIMEOUT,
            context=context,
        )

        server.login(gmail, app_password)
        server.sendmail(gmail, [recipient], message.as_string())

        return {
            "email": recipient,
            "result": "sent",
            "error": "",
        }

    except smtplib.SMTPRecipientsRefused:
        return {
            "email": recipient,
            "result": "failed",
            "error": "Recipient address was refused by the SMTP server.",
        }

    except smtplib.SMTPAuthenticationError:
        return {
            "email": recipient,
            "result": "failed",
            "error": "Gmail authentication failed. Check your App Password.",
        }

    except smtplib.SMTPException as exc:
        logger.warning("SMTP error for recipient: %s", type(exc).__name__)
        return {
            "email": recipient,
            "result": "failed",
            "error": "SMTP error: " + str(exc)[:250],
        }

    except (OSError, TimeoutError):
        return {
            "email": recipient,
            "result": "failed",
            "error": "Connection or timeout error.",
        }

    except Exception:
        logger.exception("Unexpected email sending error")
        return {
            "email": recipient,
            "result": "failed",
            "error": "Unexpected sending error.",
        }

    finally:
        if server is not None:
            try:
                server.quit()
            except Exception:
                pass


# --------------------------------------------------
# SEND BATCH
# --------------------------------------------------

@app.route("/send-batch", methods=["POST"])
def send_batch():
    if not session.get("authenticated"):
        return jsonify({
            "ok": False,
            "error": "Please sign in first.",
        }), 401

    data = request.get_json(silent=True)

    if not isinstance(data, dict):
        return jsonify({
            "ok": False,
            "error": "Invalid JSON request.",
        }), 400

    sender_name = str(data.get("sender_name", "")).strip()
    gmail = str(data.get("gmail", "")).strip()
    app_password = str(data.get("app_password", "")).strip()
    subject = str(data.get("subject", "")).strip()
    body = str(data.get("body", ""))
    is_html = bool(data.get("is_html", False))
    raw_recipients = data.get("recipients", "")
    consent_confirmed = data.get("consent_confirmed") is True

    if not sender_name or not gmail or not app_password:
        return jsonify({
            "ok": False,
            "error": "Sender name, Gmail and App Password are required.",
        }), 400

    if not EMAIL_RE.fullmatch(gmail):
        return jsonify({
            "ok": False,
            "error": "Enter a valid Gmail address.",
        }), 400

    if not subject or not body.strip():
        return jsonify({
            "ok": False,
            "error": "Subject and message body are required.",
        }), 400

    if not consent_confirmed:
        return jsonify({
            "ok": False,
            "error": "Confirm that recipients gave permission.",
        }), 400

    recipients, invalid = normalize_recipients(raw_recipients)

    if invalid:
        return jsonify({
            "ok": False,
            "error": "Invalid email addresses: " + ", ".join(invalid[:10]),
        }), 400

    if not recipients:
        return jsonify({
            "ok": False,
            "error": "Add at least one valid recipient.",
        }), 400

    if len(recipients) > MAX_RECIPIENTS:
        return jsonify({
            "ok": False,
            "error": f"Maximum {MAX_RECIPIENTS} unique recipients per batch.",
        }), 400

    total = len(recipients)

    def generate_events():
        sent = 0
        failed = 0

        def event(payload):
            return json.dumps(payload, ensure_ascii=False) + "\n"

        yield event({
            "type": "start",
            "total": total,
            "sent": 0,
            "failed": 0,
            "remaining": total,
        })

        executor = ThreadPoolExecutor(
            max_workers=MAX_PARALLEL_SENDS
        )

        futures = {}

        try:
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

                # This delay is per submission, not a global
                # rate limit across Vercel serverless instances.
                time.sleep(SEND_DELAY_SECONDS)

            for future in as_completed(futures):
                try:
                    result = future.result()
                except Exception:
                    result = {
                        "email": futures[future],
                        "result": "failed",
                        "error": "Worker failed unexpectedly.",
                    }

                if result["result"] == "sent":
                    sent += 1
                else:
                    failed += 1

                yield event({
                    "type": "progress",
                    "email": result["email"],
                    "result": result["result"],
                    "error": result["error"],
                    "total": total,
                    "sent": sent,
                    "failed": failed,
                    "remaining": total - sent - failed,
                })

        finally:
            executor.shutdown(wait=True)

        yield event({
            "type": "complete",
            "total": total,
            "sent": sent,
            "failed": failed,
            "remaining": total - sent - failed,
        })

    return Response(
        stream_with_context(generate_events()),
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
