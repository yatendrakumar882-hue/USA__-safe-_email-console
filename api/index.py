
import os
import re
import ssl
import time
import json
import smtplib
import secrets
import threading
import logging
import html
import uuid

from datetime import timedelta
from concurrent.futures import ThreadPoolExecutor, as_completed
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import formataddr, formatdate, make_msgid

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

# --------------------------------------------------
# CONFIGURATION
# --------------------------------------------------

app = Flask(__name__)

SESSION_SECRET = os.environ.get("SESSION_SECRET")
LOGIN_PASSWORD = os.environ.get("LOGIN_PASSWORD")

if not SESSION_SECRET:
    raise RuntimeError("SESSION_SECRET environment variable is required.")

if not LOGIN_PASSWORD:
    raise RuntimeError("LOGIN_PASSWORD environment variable is required.")

app.secret_key = SESSION_SECRET

app.config.update(
    SESSION_COOKIE_SECURE=True,
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    PERMANENT_SESSION_LIFETIME=timedelta(hours=1),
)

SMTP_HOST = "smtp.gmail.com"
SMTP_PORT = 465
SMTP_TIMEOUT = 25

MAX_RECIPIENTS = 25
MAX_PARALLEL_SENDS = 4

# Slightly slower sending pace
SEND_INTERVAL_SECONDS = 2.2

EMAIL_RE = re.compile(
    r"^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@"
    r"[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$"
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

send_lock = threading.Lock()
last_send_start = 0.0


# --------------------------------------------------
# HELPERS
# --------------------------------------------------

def json_event(data):
    return json.dumps(data, ensure_ascii=False) + "\n"


def valid_email(address):
    if not isinstance(address, str):
        return False

    address = address.strip()

    if len(address) > 254:
        return False

    return bool(EMAIL_RE.fullmatch(address))


def html_to_plain_text(value):
    value = re.sub(
        r"(?i)<br\s*/?>|</p>|</div>",
        "\n",
        value
    )

    value = re.sub(r"<[^>]+>", "", value)

    return html.unescape(value).strip()


def personalize_template(template, recipient):
    local_part = recipient.split("@", 1)[0]

    name = re.sub(r"[^A-Za-z0-9 ._-]", "", local_part)
    name = name.replace(".", " ").replace("_", " ").title()

    replacements = {
        "{{hi}}": "Hi",
        "{{hello}}": "Hello",
        "{{thanks}}": "Thank you",
        "{{name}}": name or "there",
        "{{email}}": recipient,
        "{{ref_code}}": uuid.uuid4().hex[:8].upper(),
    }

    result = template

    for key, value in replacements.items():
        result = result.replace(key, value)

    return result


def wait_for_send_slot():
    global last_send_start

    with send_lock:
        now = time.monotonic()
        wait_time = SEND_INTERVAL_SECONDS - (now - last_send_start)

        if wait_time > 0:
            time.sleep(wait_time)

        last_send_start = time.monotonic()


def build_message(
    sender_email,
    sender_name,
    recipient,
    subject,
    body,
    is_html
):
    personalized_body = personalize_template(body, recipient)
    personalized_subject = personalize_template(subject, recipient)

    if is_html:
        message = MIMEMultipart("alternative")

        plain_text = html_to_plain_text(personalized_body)

        message.attach(
            MIMEText(plain_text, "plain", "utf-8")
        )

        message.attach(
            MIMEText(personalized_body, "html", "utf-8")
        )

    else:
        message = MIMEText(
            personalized_body,
            "plain",
            "utf-8"
        )

    message["Subject"] = personalized_subject
    message["From"] = formataddr(
        (sender_name, sender_email)
    )
    message["To"] = recipient
    message["Date"] = formatdate(localtime=True)
    message["Message-ID"] = make_msgid()

    return message


# --------------------------------------------------
# SMTP SENDING
# --------------------------------------------------

def send_one_email(
    recipient,
    sender_email,
    sender_name,
    app_password,
    subject,
    body,
    is_html
):
    try:
        if not valid_email(recipient):
            return {
                "email": recipient,
                "success": False,
                "error": "Invalid email address"
            }

        wait_for_send_slot()

        message = build_message(
            sender_email,
            sender_name,
            recipient,
            subject,
            body,
            is_html
        )

        context = ssl.create_default_context()

        with smtplib.SMTP_SSL(
            SMTP_HOST,
            SMTP_PORT,
            context=context,
            timeout=SMTP_TIMEOUT
        ) as server:

            server.login(
                sender_email,
                app_password
            )

            server.sendmail(
                sender_email,
                [recipient],
                message.as_string()
            )

        logger.info("Accepted by SMTP server: %s", recipient)

        return {
            "email": recipient,
            "success": True,
            "error": None
        }

    except smtplib.SMTPAuthenticationError:
        logger.exception("SMTP authentication failed")
        return {
            "email": recipient,
            "success": False,
            "error": "Gmail authentication failed. Check App Password."
        }

    except smtplib.SMTPRecipientsRefused:
        logger.exception("Recipient refused")
        return {
            "email": recipient,
            "success": False,
            "error": "Recipient refused by SMTP server"
        }

    except (smtplib.SMTPException, OSError, TimeoutError):
        logger.exception("SMTP error for %s", recipient)
        return {
            "email": recipient,
            "success": False,
            "error": "SMTP connection or delivery error"
        }

    except Exception:
        logger.exception("Unexpected sending error")
        return {
            "email": recipient,
            "success": False,
            "error": "Unexpected sending error"
        }


# --------------------------------------------------
# LOGIN
# --------------------------------------------------

@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        password = request.form.get("password", "")

        if secrets.compare_digest(
            password,
            LOGIN_PASSWORD
        ):
            session.clear()
            session.permanent = True
            session["logged_in"] = True

            return redirect(url_for("index"))

        return render_template(
            "login.html",
            error="Incorrect password"
        )

    return render_template("login.html")


@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))


# --------------------------------------------------
# HOME
# --------------------------------------------------

@app.route("/")
def index():
    if not session.get("logged_in"):
        return redirect(url_for("login"))

    return render_template("index.html")


# --------------------------------------------------
# HEALTH CHECK
# --------------------------------------------------

@app.route("/health")
def health():
    return jsonify({
        "ok": True,
        "service": "Email Sender",
        "smtp_host": SMTP_HOST,
        "max_recipients": MAX_RECIPIENTS,
        "parallel_workers": MAX_PARALLEL_SENDS,
        "send_interval_seconds": SEND_INTERVAL_SECONDS
    })


@app.route("/favicon.ico")
def favicon():
    return "", 204


@app.route("/sw.js")
def service_worker():
    return "", 204


# --------------------------------------------------
# SEND BATCH
# --------------------------------------------------

@app.route("/send-batch", methods=["POST"])
def send_batch():

    if not session.get("logged_in"):
        return jsonify({
            "ok": False,
            "error": "Please login first"
        }), 401

    data = request.get_json(silent=True)

    if not isinstance(data, dict):
        return jsonify({
            "ok": False,
            "error": "Invalid request data"
        }), 400

    sender_email = data.get("gmail", "").strip()
    sender_name = data.get("sender_name", "Sender").strip()
    app_password = data.get("app_password", "").replace(" ", "")
    subject = data.get("subject", "").strip()
    body = data.get("body", "")
    is_html = bool(data.get("is_html", False))

    recipients_raw = data.get("recipients", "")

    if not isinstance(recipients_raw, str):
        return jsonify({
            "ok": False,
            "error": "Recipients must be text"
        }), 400

    recipients = list(dict.fromkeys(
        email.strip()
        for email in re.split(r"[,;\s]+", recipients_raw)
        if email.strip()
    ))

    if not sender_email or not valid_email(sender_email):
        return jsonify({
            "ok": False,
            "error": "Enter a valid Gmail address"
        }), 400

    if not app_password:
        return jsonify({
            "ok": False,
            "error": "Gmail App Password is required"
        }), 400

    if not subject:
        return jsonify({
            "ok": False,
            "error": "Subject is required"
        }), 400

    if not body:
        return jsonify({
            "ok": False,
            "error": "Email body is required"
        }), 400

    if not recipients:
        return jsonify({
            "ok": False,
            "error": "Add at least one recipient"
        }), 400

    if len(recipients) > MAX_RECIPIENTS:
        return jsonify({
            "ok": False,
            "error": f"Maximum {MAX_RECIPIENTS} recipients allowed"
        }), 400

    invalid = [
        email for email in recipients
        if not valid_email(email)
    ]

    if invalid:
        return jsonify({
            "ok": False,
            "error": "Invalid recipient email address",
            "invalid_emails": invalid
        }), 400

    # Require an explicit confirmation that recipients opted in.
    if data.get("consent_confirmed") is not True:
        return jsonify({
            "ok": False,
            "error": "Confirm that all recipients agreed to receive these emails."
        }), 400

    def generate():
        total = len(recipients)
        completed = 0
        successful = 0
        failed = 0

        yield json_event({
            "type": "start",
            "total": total
        })

        with ThreadPoolExecutor(
            max_workers=MAX_PARALLEL_SENDS
        ) as executor:

            futures = {
                executor.submit(
                    send_one_email,
                    recipient,
                    sender_email,
                    sender_name,
                    app_password,
                    subject,
                    body,
                    is_html
                ): recipient
                for recipient in recipients
            }

            for future in as_completed(futures):
                completed += 1

                try:
                    result = future.result()
                except Exception:
                    logger.exception("Worker failed")
                    result = {
                        "email": futures[future],
                        "success": False,
                        "error": "Worker failed"
                    }

                if result["success"]:
                    successful += 1
                else:
                    failed += 1

                yield json_event({
                    "type": "progress",
                    "completed": completed,
                    "total": total,
                    "success": successful,
                    "failed": failed,
                    "email": result["email"],
                    "status": (
                        "sent" if result["success"] else "failed"
                    ),
                    "error": result["error"]
                })

        yield json_event({
            "type": "complete",
            "total": total,
            "success": successful,
            "failed": failed
        })

    return Response(
        stream_with_context(generate()),
        mimetype="application/x-ndjson",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no"
        }
    )


# --------------------------------------------------
# VERCEL HANDLER
# --------------------------------------------------

handler = app
