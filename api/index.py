import os
import re
import ssl
import json
import time
import hmac
import secrets
import smtplib
import threading

from datetime import timedelta
from concurrent.futures import ThreadPoolExecutor, as_completed
from email.message import EmailMessage
from email.utils import formataddr, make_msgid

from flask import (
    Flask, render_template, request, redirect,
    url_for, session, jsonify, Response, stream_with_context
)
from werkzeug.middleware.proxy_fix import ProxyFix


app = Flask(__name__)
app.wsgi_app = ProxyFix(
    app.wsgi_app,
    x_for=1,
    x_proto=1,
    x_host=1
)

SESSION_SECRET = os.environ.get("SESSION_SECRET", "")
LOGIN_PASSWORD = os.environ.get("LOGIN_PASSWORD", "")

if len(SESSION_SECRET) < 32:
    raise RuntimeError(
        "SESSION_SECRET must be at least 32 characters."
    )

if not LOGIN_PASSWORD:
    raise RuntimeError(
        "LOGIN_PASSWORD environment variable is required."
    )

app.secret_key = SESSION_SECRET

app.config.update(
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SECURE=True,
    SESSION_COOKIE_SAMESITE="Lax",
    PERMANENT_SESSION_LIFETIME=timedelta(hours=1),
    MAX_CONTENT_LENGTH=512 * 1024
)


# Gmail SMTP settings
SMTP_HOST = "smtp.gmail.com"
SMTP_PORT = 465
SMTP_TIMEOUT = 25

# Sending limits
MAX_RECIPIENTS = 25
MAX_WORKERS = 2
MIN_SEND_INTERVAL = 1.0

EMAIL_RE = re.compile(
    r"^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$"
)

pace_lock = threading.Lock()
last_send = 0.0


def logged_in():
    return session.get("authenticated") is True


def csrf_token():
    if "csrf_token" not in session:
        session["csrf_token"] = secrets.token_urlsafe(32)

    return session["csrf_token"]


def csrf_ok():
    supplied = (
        request.headers.get("X-CSRF-Token")
        or request.form.get("csrf_token", "")
    )

    expected = session.get("csrf_token", "")

    return bool(
        supplied
        and expected
        and hmac.compare_digest(supplied, expected)
    )


def valid_email(address):
    address = (address or "").strip()

    return (
        len(address) <= 254
        and bool(EMAIL_RE.fullmatch(address))
    )


def clean_header(value, limit=180):
    value = (value or "")
    value = value.replace("\r", " ").replace("\n", " ")
    return value.strip()[:limit]


def personalize(text, recipient, sender):
    local = recipient.split("@", 1)[0]
    name = re.split(r"[._+-]", local)[0] or "there"

    replacements = {
        "{{hi}}": "Hi",
        "{{hello}}": "Hello",
        "{{thanks}}": "Thank you",
        "{{name}}": name,
        "{{email}}": recipient,
        "{{ref_code}}": secrets.token_hex(4).upper(),
        "{{sender_name}}": sender
    }

    for key, value in replacements.items():
        text = text.replace(key, value)

    return text


def pace_send():
    global last_send

    with pace_lock:
        now = time.monotonic()
        delay = MIN_SEND_INTERVAL - (now - last_send)

        if delay > 0:
            time.sleep(delay)

        last_send = time.monotonic()


def send_one(
    recipient,
    gmail,
    app_password,
    sender_name,
    subject,
    body,
    is_html
):
    pace_send()

    message = EmailMessage()

    message["Subject"] = clean_header(
        personalize(subject, recipient, sender_name),
        200
    )

    message["From"] = formataddr(
        (clean_header(sender_name, 80), gmail)
    )

    message["To"] = recipient
    message["Message-ID"] = make_msgid()

    personalized_body = personalize(
        body,
        recipient,
        sender_name
    )

    if is_html:
        from html.parser import HTMLParser

        class TextExtractor(HTMLParser):
            def __init__(self):
                super().__init__()
                self.parts = []

            def handle_data(self, data):
                if data.strip():
                    self.parts.append(data.strip())

        parser = TextExtractor()
        parser.feed(personalized_body)

        plain_text = "\n\n".join(parser.parts)

        if not plain_text:
            plain_text = (
                "Please view this message in an HTML email client."
            )

        message.set_content(plain_text)
        message.add_alternative(
            personalized_body,
            subtype="html"
        )

    else:
        message.set_content(personalized_body)

    context = ssl.create_default_context()

    with smtplib.SMTP_SSL(
        SMTP_HOST,
        SMTP_PORT,
        context=context,
        timeout=SMTP_TIMEOUT
    ) as server:

        server.login(gmail, app_password)

        server.send_message(
            message,
            from_addr=gmail,
            to_addrs=[recipient]
        )


@app.after_request
def security_headers(response):
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = (
        "strict-origin-when-cross-origin"
    )
    response.headers["Cache-Control"] = "no-store"

    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        "style-src 'self' 'unsafe-inline'; "
        "script-src 'self' 'unsafe-inline'; "
        "img-src 'self' data:; "
        "base-uri 'self'; "
        "frame-ancestors 'none'; "
        "form-action 'self'"
    )

    return response


@app.get("/")
def home():
    if logged_in():
        return redirect(url_for("dashboard"))

    return redirect(url_for("login"))


@app.route("/login", methods=["GET", "POST"])
def login():
    error = None

    if request.method == "POST":
        password = request.form.get("password", "")

        if hmac.compare_digest(password, LOGIN_PASSWORD):
            session.clear()
            session["authenticated"] = True
            session.permanent = True
            csrf_token()

            return redirect(url_for("dashboard"))

        error = "Incorrect password. Please try again."

    return render_template(
        "login.html",
        error=error
    )


@app.get("/dashboard")
def dashboard():
    if not logged_in():
        return redirect(url_for("login"))

    return render_template(
        "index.html",
        csrf_token=csrf_token()
    )


@app.post("/logout")
def logout():
    if not logged_in():
        return redirect(url_for("login"))

    if not csrf_ok():
        return jsonify({
            "ok": False,
            "error": "Security token expired. Refresh and retry."
        }), 403

    session.clear()

    return jsonify({"ok": True})


@app.get("/health")
def health():
    return jsonify({
        "ok": True,
        "service": "USA Safe Email Console"
    })


@app.post("/send-batch")
def send_batch():

    if not logged_in():
        return jsonify({
            "ok": False,
            "error": "Please log in again."
        }), 401

    if not csrf_ok():
        return jsonify({
            "ok": False,
            "error": "Security token expired. Refresh the page."
        }), 403

    data = request.get_json(silent=True) or {}

    gmail = (data.get("gmail") or "").strip().lower()

    app_password = (
        (data.get("app_password") or "")
        .replace(" ", "")
        .strip()
    )

    sender_name = clean_header(
        data.get("sender_name") or "Email Team",
        80
    )

    subject = clean_header(
        data.get("subject") or "",
        200
    )

    body = data.get("body") or ""
    is_html = bool(data.get("is_html"))
    recipients_raw = data.get("recipients") or []

    consent = data.get("consent") is True

    if not consent:
        return jsonify({
            "ok": False,
            "error": "Confirm that recipients agreed to receive emails."
        }), 400

    if not valid_email(gmail) or not app_password:
        return jsonify({
            "ok": False,
            "error": "Enter a valid Gmail address and App Password."
        }), 400

    if not subject or not body.strip():
        return jsonify({
            "ok": False,
            "error": "Subject and message are required."
        }), 400

    if len(body) > 30000:
        return jsonify({
            "ok": False,
            "error": "Message is too long. Maximum 30,000 characters."
        }), 400

    if not isinstance(recipients_raw, list) or not recipients_raw:
        return jsonify({
            "ok": False,
            "error": "Add at least one recipient."
        }), 400

    if len(recipients_raw) > MAX_RECIPIENTS:
        return jsonify({
            "ok": False,
            "error": f"Maximum {MAX_RECIPIENTS} recipients per batch."
        }), 400

    recipients = []
    seen = set()

    for item in recipients_raw:
        address = str(item).strip().lower()

        if not valid_email(address):
            return jsonify({
                "ok": False,
                "error": f"Invalid email address: {address[:100]}"
            }), 400

        if address not in seen:
            recipients.append(address)
            seen.add(address)

    def make_event(payload):
        return json.dumps(
            payload,
            ensure_ascii=False
        ) + "\n"

    def generate_events():
        total = len(recipients)
        sent = 0
        failed = 0

        yield make_event({
            "event": "start",
            "total": total
        })

        with ThreadPoolExecutor(
            max_workers=MAX_WORKERS
        ) as executor:

            futures = {
                executor.submit(
                    send_one,
                    recipient,
                    gmail,
                    app_password,
                    sender_name,
                    subject,
                    body,
                    is_html
                ): recipient

                for recipient in recipients
            }

            for future in as_completed(futures):
                recipient = futures[future]

                try:
                    future.result()
                    sent += 1
                    status = "sent"
                    error = ""

                except Exception as exc:
                    failed += 1
                    status = "failed"
                    error = str(exc)[:220]

                yield make_event({
                    "event": "progress",
                    "email": recipient,
                    "status": status,
                    "error": error,
                    "sent": sent,
                    "failed": failed,
                    "total": total
                })

        yield make_event({
            "event": "complete",
            "sent": sent,
            "failed": failed,
            "total": total,
            "message": (
                "SMTP processing finished. "
                "Gmail acceptance does not confirm Inbox delivery."
            )
        })

    return Response(
        stream_with_context(generate_events()),
        mimetype="application/x-ndjson",
        headers={"X-Accel-Buffering": "no"}
    )


# Vercel Python handler
handler = app
