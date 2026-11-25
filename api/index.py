
import os
import re
import ssl
import json
import time
import html
import secrets
import smtplib
import logging

from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
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

# --------------------------------------------------
# APPLICATION
# --------------------------------------------------

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

BASE_DIR = Path(__file__).resolve().parent.parent

app = Flask(
    __name__,
    template_folder=str(BASE_DIR / "templates"),
    static_folder=str(BASE_DIR / "static"),
    static_url_path="/static",
)

# Vercel Python entry point
handler = app

# --------------------------------------------------
# ENVIRONMENT CONFIGURATION
# --------------------------------------------------

SESSION_SECRET = os.environ.get("SESSION_SECRET", "")
LOGIN_PASSWORD = os.environ.get("LOGIN_PASSWORD", "")

CONFIG_ERRORS = []

if len(SESSION_SECRET) < 32:
    CONFIG_ERRORS.append(
        "SESSION_SECRET must contain at least 32 characters."
    )

if not LOGIN_PASSWORD:
    CONFIG_ERRORS.append("LOGIN_PASSWORD is missing.")

# Fallback permits the app to start and show a configuration error.
# Set a permanent SESSION_SECRET in Vercel before production use.
app.secret_key = (
    SESSION_SECRET
    if len(SESSION_SECRET) >= 32
    else secrets.token_urlsafe(48)
)

app.config.update(
    SESSION_COOKIE_SECURE=True,
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    PERMANENT_SESSION_LIFETIME=3600,
    MAX_CONTENT_LENGTH=1_500_000,
)

# --------------------------------------------------
# SMTP SETTINGS
# --------------------------------------------------

SMTP_HOST = "smtp.gmail.com"
SMTP_PORT = 465
SMTP_TIMEOUT = 25

MAX_RECIPIENTS = 25

# Conservative concurrency. Gmail can throttle parallel connections.
MAX_PARALLEL_SENDS = 2

# Delay before each worker sends a message.
SEND_DELAY_SECONDS = 1.8

EMAIL_RE = re.compile(
    r"^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@"
    r"[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$"
)

# --------------------------------------------------
# HELPERS
# --------------------------------------------------

def valid_email(value):
    if not isinstance(value, str):
        return False

    value = value.strip()

    return (
        len(value) <= 254
        and bool(EMAIL_RE.fullmatch(value))
    )


def clean_header(value, limit=998):
    value = str(value or "")
    value = value.replace("\r", " ").replace("\n", " ")
    return value.strip()[:limit]


def is_logged_in():
    return session.get("authenticated") is True


def json_error(message, status=400):
    return jsonify({
        "success": False,
        "message": message,
    }), status


def config_error_response():
    if CONFIG_ERRORS:
        return jsonify({
            "success": False,
            "message": "Server configuration error.",
            "details": CONFIG_ERRORS,
        }), 503

    return None


def ndjson(event):
    return json.dumps(
        event,
        ensure_ascii=False,
        separators=(",", ":"),
    ) + "\n"


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
    cleaned = []
    seen = set()

    for item in items:
        recipient = normalize_recipient(item)

        if not recipient:
            continue

        address = recipient["email"]

        if not valid_email(address):
            continue

        if address in seen:
            continue

        seen.add(address)
        cleaned.append(recipient)

    return cleaned


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

    for placeholder, replacement in replacements.items():
        replacement = str(replacement or "")

        if html_mode:
            replacement = html.escape(replacement)

        result = result.replace(placeholder, replacement)

    return result


def html_to_text(value):
    text = str(value or "")

    text = re.sub(
        r"<\s*br\s*/?\s*>",
        "\n",
        text,
        flags=re.IGNORECASE,
    )

    text = re.sub(
        r"</\s*(p|div|tr|h[1-6])\s*>",
        "\n\n",
        text,
        flags=re.IGNORECASE,
    )

    text = re.sub(r"<[^>]+>", "", text)

    return html.unescape(text).strip()


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

        plain_body = html_to_text(body)

        message.attach(
            MIMEText(plain_body, "plain", "utf-8")
        )

        message.attach(
            MIMEText(body, "html", "utf-8")
        )
    else:
        message = MIMEText(
            body,
            "plain",
            "utf-8",
        )

    message["Subject"] = subject
    message["From"] = formataddr((sender_name, gmail))
    message["To"] = recipient
    message["Date"] = formatdate(localtime=True)
    message["Message-ID"] = make_msgid()

    return message


# --------------------------------------------------
# SEND ONE MESSAGE
# --------------------------------------------------

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
        personalized_subject = personalize(
            subject,
            recipient_data,
        )

        personalized_body = personalize(
            body,
            recipient_data,
            html_mode=is_html,
        )

        message = build_message(
            gmail=gmail,
            sender_name=sender_name,
            recipient=recipient,
            subject=clean_header(personalized_subject),
            body=personalized_body,
            is_html=is_html,
        )

        if SEND_DELAY_SECONDS > 0:
            time.sleep(SEND_DELAY_SECONDS)

        password = re.sub(
            r"\s+",
            "",
            str(app_password),
        )

        context = ssl.create_default_context()

        with smtplib.SMTP_SSL(
            SMTP_HOST,
            SMTP_PORT,
            context=context,
            timeout=SMTP_TIMEOUT,
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
                    "error": "Gmail SMTP refused this recipient.",
                }

        return {
            "result": "sent",
            "error": None,
        }

    except smtplib.SMTPAuthenticationError:
        logger.exception("Gmail authentication failed")

        return {
            "result": "failed",
            "error": "Gmail authentication failed. Check your App Password.",
        }

    except smtplib.SMTPRecipientsRefused:
        logger.exception("Recipient refused: %s", recipient)

        return {
            "result": "failed",
            "error": "Recipient address was refused.",
        }

    except smtplib.SMTPDataError as exc:
        logger.exception("SMTP data error")

        return {
            "result": "failed",
            "error": f"SMTP rejected the message. Code: {exc.smtp_code}",
        }

    except (smtplib.SMTPException, OSError, TimeoutError):
        logger.exception("SMTP connection error for %s", recipient)

        return {
            "result": "failed",
            "error": "SMTP connection or sending error.",
        }

    except Exception:
        logger.exception("Unexpected sending error")

        return {
            "result": "failed",
            "error": "Unexpected sending error.",
        }


# --------------------------------------------------
# LOGIN
# --------------------------------------------------

@app.route("/login", methods=["GET", "POST"])
def login():
    error = config_error_response()

    if error:
        return error

    if is_logged_in():
        return redirect(url_for("home"))

    if request.method == "GET":
        return render_template(
            "login.html",
            error=None,
        )

    password = request.form.get("password", "")

    if not secrets.compare_digest(
        str(password),
        str(LOGIN_PASSWORD),
    ):
        return render_template(
            "login.html",
            error="Incorrect password.",
        ), 401

    session.clear()
    session.permanent = True
    session["authenticated"] = True

    return redirect(url_for("home"))


@app.route("/logout", methods=["GET", "POST"])
def logout():
    session.clear()
    return redirect(url_for("login"))


# --------------------------------------------------
# MAIN PAGE
# --------------------------------------------------

@app.route("/")
def home():
    error = config_error_response()

    if error:
        return error

    if not is_logged_in():
        return redirect(url_for("login"))

    return render_template("index.html")


# --------------------------------------------------
# BATCH SENDING
# --------------------------------------------------

@app.route("/send-batch", methods=["POST"])
def send_batch():
    error = config_error_response()

    if error:
        return error

    if not is_logged_in():
        return json_error(
            "Your login session expired. Please log in again.",
            401,
        )

    data = request.get_json(silent=True)

    if not isinstance(data, dict):
        return json_error("Invalid request data.")

    sender_name = clean_header(
        data.get("sender_name", ""),
        200,
    )

    gmail = clean_header(
        data.get("gmail", ""),
        254,
    ).lower()

    app_password = str(
        data.get("app_password", "")
    ).strip()

    subject = clean_header(
        data.get("subject", ""),
    )

    body = str(data.get("body", ""))

    is_html = data.get("is_html") is True

    recipient_input = data.get("recipients", [])

    consent_confirmed = (
        data.get("consent_confirmed") is True
    )

    if not sender_name:
        return json_error("Enter Sender Name.")

    if (
        not valid_email(gmail)
        or not gmail.endswith("@gmail.com")
    ):
        return json_error("Enter a valid Gmail address.")

    if not app_password:
        return json_error("Enter Gmail App Password.")

    if not subject:
        return json_error("Enter Email Subject.")

    if not body.strip():
        return json_error("Enter Message Body.")

    if len(subject) > 998:
        return json_error("Email subject is too long.")

    if len(body) > 100_000:
        return json_error("Message body is too large.")

    if not consent_confirmed:
        return json_error(
            "Confirm that recipients agreed to receive your email."
        )

    if not isinstance(recipient_input, list):
        return json_error("Recipient list is invalid.")

    recipients = clean_recipients(recipient_input)

    if not recipients:
        return json_error("No valid recipients found.")

    if len(recipients) > MAX_RECIPIENTS:
        return json_error(
            f"Maximum {MAX_RECIPIENTS} recipients per batch."
        )

    # Validate all supplied entries, not just the filtered entries.
    invalid_count = 0

    for item in recipient_input:
        normalized = normalize_recipient(item)

        if not normalized or not valid_email(normalized["email"]):
            invalid_count += 1

    if invalid_count:
        return json_error(
            f"{invalid_count} invalid recipient address(es). Correct them and try again."
        )

    @stream_with_context
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

        # Display each recipient before sending starts.
        for recipient in recipients:
            yield ndjson({
                "type": "recipient",
                "email": recipient["email"],
                "status": "queued",
            })

        with ThreadPoolExecutor(
            max_workers=MAX_PARALLEL_SENDS
        ) as executor:

            futures = {}

            for recipient in recipients:
                future = executor.submit(
                    send_one_email,
                    gmail,
                    app_password,
                    sender_name,
                    subject,
                    body,
                    is_html,
                    recipient,
                )

                futures[future] = recipient["email"]

            for future in as_completed(futures):
                email_address = futures[future]

                try:
                    result = future.result()

                except Exception:
                    logger.exception(
                        "Worker failed for %s",
                        email_address,
                    )

                    result = {
                        "result": "failed",
                        "error": "Unexpected worker error.",
                    }

                if result["result"] == "sent":
                    sent += 1
                else:
                    failed += 1

                yield ndjson({
                    "type": "progress",
                    "email": email_address,
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
            "remaining": total - sent - failed,
        })

    response = Response(
        generate(),
        content_type="application/x-ndjson; charset=utf-8",
    )

    response.headers["Cache-Control"] = (
        "no-cache, no-store, no-transform"
    )

    response.headers["X-Accel-Buffering"] = "no"
    response.headers["X-Content-Type-Options"] = "nosniff"

    return response


# --------------------------------------------------
# HEALTH CHECK
# --------------------------------------------------

@app.route("/health")
def health():
    return jsonify({
        "status": "ok",
        "configuration_ok": not CONFIG_ERRORS,
        "configuration_errors": CONFIG_ERRORS,
        "smtp_host": SMTP_HOST,
        "smtp_port": SMTP_PORT,
        "max_recipients": MAX_RECIPIENTS,
        "parallel_sends": MAX_PARALLEL_SENDS,
    })


# --------------------------------------------------
# ERROR HANDLERS
# --------------------------------------------------

@app.errorhandler(413)
def request_too_large(error):
    return json_error(
        "Request is too large.",
        413,
    )


@app.errorhandler(404)
def page_not_found(error):
    return jsonify({
        "success": False,
        "message": "Page not found.",
    }), 404


@app.errorhandler(500)
def internal_server_error(error):
    logger.exception(
        "Internal server error: %s",
        error,
    )

    return jsonify({
        "success": False,
        "message": "Internal server error. Check Vercel Runtime Logs.",
    }), 500


if __name__ == "__main__":
    app.run(
        host="0.0.0.0",
        port=5000,
        debug=False,
    )
