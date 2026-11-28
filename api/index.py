
import os
import re
import ssl
import json
import hmac
import html
import time
import secrets
import logging
import smtplib
import socket
import urllib.parse
import urllib.request

from datetime import datetime, timezone
from email.message import EmailMessage
from email.utils import formataddr, make_msgid

from flask import (
    Flask,
    render_template,
    request,
    jsonify,
    redirect,
    url_for,
    session,
    Response,
    stream_with_context,
)

from werkzeug.middleware.proxy_fix import ProxyFix


# ==================================================
# CONFIGURATION
# ==================================================

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

TEMPLATE_DIR = os.path.join(BASE_DIR, "templates")
STATIC_DIR = os.path.join(BASE_DIR, "static")

SESSION_SECRET = os.environ.get("SESSION_SECRET", "")
LOGIN_PASSWORD = os.environ.get("LOGIN_PASSWORD", "")
TURNSTILE_SECRET_KEY = os.environ.get("TURNSTILE_SECRET_KEY", "")

SMTP_HOST = "smtp.gmail.com"
SMTP_PORT = 465
SMTP_TIMEOUT = 20

MAX_RECIPIENTS = 25
SEND_DELAY_SECONDS = 0.1

MAX_SUBJECT_LENGTH = 250
MAX_BODY_LENGTH = 50000

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)


# ==================================================
# FLASK APP
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

app.secret_key = SESSION_SECRET or secrets.token_hex(32)

app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SECURE=True,
    SESSION_COOKIE_SAMESITE="Lax",
    PERMANENT_SESSION_LIFETIME=3600,
    MAX_CONTENT_LENGTH=2 * 1024 * 1024,
)


# ==================================================
# VALIDATION
# ==================================================

EMAIL_RE = re.compile(
    r"^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@"
    r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?"
    r"(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$"
)


def valid_email(value):
    if not isinstance(value, str):
        return False

    value = value.strip()

    return (
        len(value) <= 254
        and EMAIL_RE.fullmatch(value) is not None
    )


def is_logged_in():
    return session.get("logged_in") is True


def csrf_token():
    if "_csrf_token" not in session:
        session["_csrf_token"] = secrets.token_urlsafe(32)

    return session["_csrf_token"]


def csrf_valid():
    supplied = request.headers.get("X-CSRF-Token", "")

    if not supplied and request.is_json:
        data = request.get_json(silent=True) or {}
        supplied = data.get("csrf_token", "")

    expected = session.get("_csrf_token", "")

    return bool(
        supplied
        and expected
        and hmac.compare_digest(str(supplied), str(expected))
    )


def html_to_text(value):
    value = re.sub(
        r"(?is)<(script|style).*?>.*?</\1>",
        "",
        value or "",
    )

    value = re.sub(r"(?i)<br\s*/?>", "\n", value)
    value = re.sub(r"(?i)</p\s*>", "\n\n", value)
    value = re.sub(r"(?s)<[^>]+>", "", value)

    return html.unescape(value).strip()


def personalize(value, recipient):
    email = recipient.strip()
    username = email.split("@", 1)[0]

    first_name = re.split(r"[._-]", username)[0]
    first_name = (
        first_name[:1].upper() + first_name[1:]
        if first_name else ""
    )

    replacements = {
        "{{email}}": email,
        "{{name}}": first_name,
        "{{hi}}": "Hi",
        "{{hello}}": "Hello",
        "{{thanks}}": "Thank you",
        "{{ref_code}}": secrets.token_hex(4).upper(),
    }

    for key, replacement in replacements.items():
        value = value.replace(key, replacement)

    return value


# ==================================================
# CLOUDFLARE TURNSTILE
# ==================================================

def verify_turnstile(token, remote_ip=None):
    if not TURNSTILE_SECRET_KEY:
        return True

    if not token:
        return False

    data = {
        "secret": TURNSTILE_SECRET_KEY,
        "response": token,
    }

    if remote_ip:
        data["remoteip"] = remote_ip

    encoded = urllib.parse.urlencode(data).encode("utf-8")

    req = urllib.request.Request(
        "https://challenges.cloudflare.com/turnstile/v0/siteverify",
        data=encoded,
        headers={
            "Content-Type": "application/x-www-form-urlencoded"
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            result = json.loads(response.read().decode("utf-8"))

        return result.get("success") is True

    except Exception:
        logger.exception("Turnstile verification failed")
        return False


# ==================================================
# EMAIL MESSAGE
# ==================================================

def build_message(
    sender_name,
    gmail,
    recipient,
    subject,
    body,
    is_html=False,
):
    subject = personalize(subject, recipient)
    body = personalize(body, recipient)

    message = EmailMessage()

    message["From"] = (
        formataddr((sender_name, gmail))
        if sender_name
        else gmail
    )

    message["To"] = recipient
    message["Subject"] = subject
    message["Date"] = datetime.now(
        timezone.utc
    ).strftime("%a, %d %b %Y %H:%M:%S +0000")

    message["Message-ID"] = make_msgid()

    if is_html:
        plain_text = html_to_text(body)

        if not plain_text:
            plain_text = "Please view this email in an HTML-compatible email client."

        message.set_content(plain_text)
        message.add_alternative(body, subtype="html")
    else:
        message.set_content(body)

    return message


# ==================================================
# SMTP SENDING
# ==================================================

def send_one_email(
    gmail,
    app_password,
    sender_name,
    recipient,
    subject,
    body,
    is_html=False,
):
    message = build_message(
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

            refused = server.send_message(message)

            if refused:
                return {
                    "status": "failed",
                    "error": "Recipient refused by SMTP server.",
                }

        return {
            "status": "sent",
            "error": None,
        }

    except smtplib.SMTPAuthenticationError:
        return {
            "status": "failed",
            "error": "Gmail authentication failed. Check your Gmail App Password.",
        }

    except smtplib.SMTPRecipientsRefused:
        return {
            "status": "failed",
            "error": "Recipient address refused by SMTP server.",
        }

    except smtplib.SMTPDataError as exc:
        return {
            "status": "failed",
            "error": "SMTP rejected the message. Code: " + str(exc.smtp_code),
        }

    except (socket.timeout, TimeoutError):
        return {
            "status": "uncertain",
            "error": "SMTP timed out. Check the recipient mailbox before retrying.",
        }

    except smtplib.SMTPException as exc:
        return {
            "status": "failed",
            "error": "SMTP error: " + str(exc)[:250],
        }

    except Exception:
        logger.exception("Unexpected SMTP error")

        return {
            "status": "failed",
            "error": "Unexpected sending error. Check server logs.",
        }


# ==================================================
# HOME AND LOGIN
# ==================================================

@app.route("/", methods=["GET"])
def home():
    if is_logged_in():
        return redirect(url_for("dashboard"))

    return redirect(url_for("login"))


@app.route("/login", methods=["GET", "POST"])
def login():
    if not LOGIN_PASSWORD or not SESSION_SECRET:
        return (
            "Configuration error: LOGIN_PASSWORD and SESSION_SECRET "
            "must be configured in Vercel.",
            500,
        )

    if request.method == "POST":
        password = request.form.get("password", "")

        if hmac.compare_digest(password, LOGIN_PASSWORD):
            session.clear()
            session.permanent = True
            session["logged_in"] = True
            csrf_token()

            return redirect(url_for("dashboard"))

        return render_template(
            "login.html",
            error="Incorrect password",
        ), 401

    return render_template("login.html", error=None)


@app.route("/dashboard", methods=["GET"])
def dashboard():
    if not is_logged_in():
        return redirect(url_for("login"))

    return render_template(
        "index.html",
        csrf_token=csrf_token(),
    )


@app.route("/logout", methods=["GET", "POST"])
def logout():
    session.clear()
    return redirect(url_for("login"))


# ==================================================
# HEALTH CHECK
# ==================================================

@app.route("/health", methods=["GET"])
def health():
    return jsonify({
        "ok": True,
        "app": "running",
        "login_template_exists": os.path.isfile(
            os.path.join(TEMPLATE_DIR, "login.html")
        ),
        "dashboard_template_exists": os.path.isfile(
            os.path.join(TEMPLATE_DIR, "index.html")
        ),
        "static_directory_exists": os.path.isdir(STATIC_DIR),
        "login_password_configured": bool(LOGIN_PASSWORD),
        "session_secret_configured": bool(SESSION_SECRET),
        "turnstile_configured": bool(TURNSTILE_SECRET_KEY),
        "smtp_host": SMTP_HOST,
        "smtp_port": SMTP_PORT,
    })


# ==================================================
# SEND BATCH
# ==================================================

@app.route("/send-batch", methods=["POST"])
def send_batch():

    if not is_logged_in():
        return jsonify({
            "ok": False,
            "error": "Session expired. Please log in again.",
        }), 401

    if not csrf_valid():
        return jsonify({
            "ok": False,
            "error": "Security token expired. Refresh the page.",
        }), 403

    data = request.get_json(silent=True)

    if not isinstance(data, dict):
        return jsonify({
            "ok": False,
            "error": "Invalid request data.",
        }), 400

    if data.get("consent") is not True:
        return jsonify({
            "ok": False,
            "error": "Confirm that recipients have agreed to receive these emails.",
        }), 400

    sender_name = str(data.get("sender_name", "")).strip()
    gmail = str(data.get("gmail", "")).strip()
    app_password = str(data.get("app_password", "")).strip()
    subject = str(data.get("subject", "")).strip()
    body = str(data.get("body", "")).strip()

    is_html = data.get("is_html") is True

    recipients = data.get("recipients", [])

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

    if len(app_password) > 200:
        return jsonify({
            "ok": False,
            "error": "Invalid App Password.",
        }), 400

    if not subject:
        return jsonify({
            "ok": False,
            "error": "Subject is required.",
        }), 400

    if len(subject) > MAX_SUBJECT_LENGTH:
        return jsonify({
            "ok": False,
            "error": "Subject is too long.",
        }), 400

    if not body:
        return jsonify({
            "ok": False,
            "error": "Email body is required.",
        }), 400

    if len(body) > MAX_BODY_LENGTH:
        return jsonify({
            "ok": False,
            "error": "Email body is too long.",
        }), 400

    if not isinstance(recipients, list):
        return jsonify({
            "ok": False,
            "error": "Recipients must be a list.",
        }), 400

    cleaned_recipients = []
    seen = set()

    for item in recipients:
        if not isinstance(item, str):
            continue

        address = item.strip()

        if not valid_email(address):
            continue

        normalized = address.lower()

        if normalized not in seen:
            seen.add(normalized)
            cleaned_recipients.append(address)

    if not cleaned_recipients:
        return jsonify({
            "ok": False,
            "error": "No valid recipient addresses found.",
        }), 400

    if len(cleaned_recipients) > MAX_RECIPIENTS:
        return jsonify({
            "ok": False,
            "error": f"Maximum {MAX_RECIPIENTS} recipients per batch.",
        }), 400

    token = str(
        data.get("turnstile_token")
        or data.get("cf-turnstile-response")
        or ""
    )

    remote_ip = (
        request.headers.get("CF-Connecting-IP")
        or request.remote_addr
    )

    if not verify_turnstile(token, remote_ip):
        return jsonify({
            "ok": False,
            "error": "Cloudflare verification failed.",
        }), 403

    # Fixed snapshot: later dashboard edits do not change this batch.
    batch = {
        "sender_name": sender_name,
        "gmail": gmail,
        "app_password": app_password,
        "subject": subject,
        "body": body,
        "is_html": is_html,
        "recipients": list(cleaned_recipients),
    }

    total = len(batch["recipients"])

    def generate():
        sent = 0
        failed = 0
        uncertain = 0

        try:
            yield json.dumps({
                "event": "start",
                "total": total,
            }) + "\n"

            for index, recipient in enumerate(batch["recipients"]):

                result = send_one_email(
                    gmail=batch["gmail"],
                    app_password=batch["app_password"],
                    sender_name=batch["sender_name"],
                    recipient=recipient,
                    subject=batch["subject"],
                    body=batch["body"],
                    is_html=batch["is_html"],
                )

                status = result["status"]

                if status == "sent":
                    sent += 1
                elif status == "uncertain":
                    uncertain += 1
                else:
                    failed += 1

                yield json.dumps({
                    "event": "progress",
                    "email": recipient,
                    "status": status,
                    "error": result["error"],
                    "sent": sent,
                    "failed": failed,
                    "uncertain": uncertain,
                    "total": total,
                }) + "\n"

                if index < total - 1:
                    time.sleep(SEND_DELAY_SECONDS)

            yield json.dumps({
                "event": "complete",
                "sent": sent,
                "failed": failed,
                "uncertain": uncertain,
                "total": total,
                "message": (
                    "SMTP processing complete. Sent means accepted by SMTP, "
                    "not confirmed Inbox delivery."
                ),
            }) + "\n"

        except GeneratorExit:
            logger.info("Client disconnected during batch.")

        except Exception:
            logger.exception("Batch processing error.")

            yield json.dumps({
                "event": "error",
                "error": "Batch stopped because of a server error.",
            }) + "\n"

        finally:
            batch["app_password"] = ""

    return Response(
        stream_with_context(generate()),
        content_type="application/x-ndjson; charset=utf-8",
        headers={
            "Cache-Control": "no-cache, no-transform",
            "X-Accel-Buffering": "no",
        },
    )


# ==================================================
# VERCEL ENTRY POINT
# ==================================================

handler = app
