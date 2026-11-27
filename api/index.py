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
    Flask,
    render_template,
    request,
    redirect,
    url_for,
    session,
    jsonify,
    Response,
    stream_with_context
)

from werkzeug.middleware.proxy_fix import ProxyFix


# ==================================================
# CORRECT PROJECT PATHS
# ==================================================

BASE_DIR = os.path.dirname(
    os.path.dirname(
        os.path.abspath(__file__)
    )
)

TEMPLATE_DIR = os.path.join(
    BASE_DIR,
    "templates"
)

STATIC_DIR = os.path.join(
    BASE_DIR,
    "static"
)


# ==================================================
# FLASK APPLICATION
# ==================================================

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


# ==================================================
# ENVIRONMENT VARIABLES
# ==================================================

SESSION_SECRET = os.environ.get(
    "SESSION_SECRET",
    ""
)

LOGIN_PASSWORD = os.environ.get(
    "LOGIN_PASSWORD",
    ""
)

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
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SECURE=True,
    SESSION_COOKIE_SAMESITE="Lax",
    PERMANENT_SESSION_LIFETIME=timedelta(hours=1),
    MAX_CONTENT_LENGTH=512 * 1024
)


# ==================================================
# GMAIL SMTP SETTINGS
# ==================================================

SMTP_HOST = "smtp.gmail.com"
SMTP_PORT = 465
SMTP_TIMEOUT = 25

MAX_RECIPIENTS = 25
MAX_WORKERS = 2
MIN_SEND_INTERVAL = 0.6


# ==================================================
# EMAIL VALIDATION
# ==================================================

EMAIL_RE = re.compile(
    r"^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+"
    r"@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$"
)

pace_lock = threading.Lock()
last_send_time = 0.0


def configuration_error():

    if len(SESSION_SECRET) < 32:
        return (
            "SESSION_SECRET is missing or too short. "
            "Set a random secret of at least 32 characters."
        )

    if not LOGIN_PASSWORD:
        return (
            "LOGIN_PASSWORD is missing. "
            "Set it in Vercel Environment Variables."
        )

    return None


def valid_email(address):

    address = (address or "").strip()

    return (
        len(address) <= 254
        and bool(EMAIL_RE.fullmatch(address))
    )


def clean_header(value, limit=180):

    value = str(value or "")

    value = value.replace("\r", " ")
    value = value.replace("\n", " ")

    return value.strip()[:limit]


# ==================================================
# LOGIN SESSION
# ==================================================

def logged_in():

    return session.get("authenticated") is True


# ==================================================
# CSRF SECURITY
# ==================================================

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


# ==================================================
# PERSONALIZATION
# ==================================================

def personalize(text, recipient, sender_name):

    local = recipient.split("@", 1)[0]

    name = re.split(
        r"[._+-]",
        local
    )[0] or "there"

    replacements = {
        "{{hi}}": "Hi",
        "{{hello}}": "Hello",
        "{{thanks}}": "Thank you",
        "{{name}}": name,
        "{{email}}": recipient,
        "{{ref_code}}": secrets.token_hex(4).upper(),
        "{{sender_name}}": sender_name
    }

    for key, value in replacements.items():

        text = text.replace(key, value)

    return text


# ==================================================
# CONTROLLED SENDING PACE
# ==================================================

def pace_send():

    global last_send_time

    with pace_lock:

        current_time = time.monotonic()

        wait_time = (
            MIN_SEND_INTERVAL
            - (current_time - last_send_time)
        )

        if wait_time > 0:

            time.sleep(wait_time)

        last_send_time = time.monotonic()


# ==================================================
# SEND ONE EMAIL
# ==================================================

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
        personalize(
            subject,
            recipient,
            sender_name
        ),
        200
    )

    message["From"] = formataddr(
        (
            clean_header(sender_name, 80),
            gmail
        )
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

        plain_text = "\n\n".join(
            parser.parts
        )

        if not plain_text:

            plain_text = (
                "Please view this message "
                "in an HTML-capable email client."
            )

        message.set_content(plain_text)

        message.add_alternative(
            personalized_body,
            subtype="html"
        )

    else:

        message.set_content(
            personalized_body
        )

    context = ssl.create_default_context()

    with smtplib.SMTP_SSL(
        SMTP_HOST,
        SMTP_PORT,
        context=context,
        timeout=SMTP_TIMEOUT
    ) as server:

        server.login(
            gmail,
            app_password
        )

        server.send_message(
            message,
            from_addr=gmail,
            to_addrs=[recipient]
        )


# ==================================================
# SECURITY HEADERS
# ==================================================

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


# ==================================================
# HOME ROUTE
# ==================================================

@app.get("/")
def home():

    if logged_in():

        return redirect(
            url_for("dashboard")
        )

    return redirect(
        url_for("login")
    )


# ==================================================
# LOGIN ROUTE
# ==================================================

@app.route(
    "/login",
    methods=["GET", "POST"]
)
def login():

    error = configuration_error()

    if request.method == "POST":

        if error:

            return render_template(
                "login.html",
                error=error
            ), 503

        password = request.form.get(
            "password",
            ""
        )

        if hmac.compare_digest(
            password,
            LOGIN_PASSWORD
        ):

            session.clear()

            session["authenticated"] = True

            session.permanent = True

            csrf_token()

            return redirect(
                url_for("dashboard")
            )

        error = "Incorrect password. Please try again."

        return render_template(
            "login.html",
            error=error
        ), 401

    return render_template(
        "login.html",
        error=error
    )


# ==================================================
# DASHBOARD ROUTE
# ==================================================

@app.get("/dashboard")
def dashboard():

    if not logged_in():

        return redirect(
            url_for("login")
        )

    error = configuration_error()

    if error:

        return render_template(
            "login.html",
            error=error
        ), 503

    return render_template(
        "index.html",
        csrf_token=csrf_token()
    )


# ==================================================
# LOGOUT ROUTE
# ==================================================

@app.post("/logout")
def logout():

    if not logged_in():

        return jsonify({
            "ok": False,
            "error": "Please log in again."
        }), 401

    if not csrf_ok():

        return jsonify({
            "ok": False,
            "error": "Security token expired."
        }), 403

    session.clear()

    return jsonify({
        "ok": True
    })


# ==================================================
# HEALTH CHECK
# ==================================================

@app.get("/health")
def health():

    return jsonify({
        "ok": True,
        "configuration_ready": CONFIG_READY,
        "templates_directory_exists": os.path.isdir(
            TEMPLATE_DIR
        ),
        "static_directory_exists": os.path.isdir(
            STATIC_DIR
        ),
        "login_template_exists": os.path.isfile(
            os.path.join(TEMPLATE_DIR, "login.html")
        ),
        "dashboard_template_exists": os.path.isfile(
            os.path.join(TEMPLATE_DIR, "index.html")
        )
    })


# ==================================================
# SEND BATCH ROUTE
# ==================================================

@app.post("/send-batch")
def send_batch():

    if not logged_in():

        return jsonify({
            "ok": False,
            "error": "Please log in again."
        }), 401

    error = configuration_error()

    if error:

        return jsonify({
            "ok": False,
            "error": error
        }), 503

    if not csrf_ok():

        return jsonify({
            "ok": False,
            "error": "Security token expired. Refresh the page."
        }), 403

    data = request.get_json(
        silent=True
    ) or {}

    gmail = (
        data.get("gmail") or ""
    ).strip().lower()

    app_password = (
        data.get("app_password") or ""
    ).replace(" ", "").strip()

    sender_name = clean_header(
        data.get("sender_name") or "Email Team",
        80
    )

    subject = clean_header(
        data.get("subject") or "",
        200
    )

    body = data.get("body") or ""

    is_html = bool(
        data.get("is_html")
    )

    recipients_raw = (
        data.get("recipients") or []
    )

    consent = (
        data.get("consent") is True
    )

    if not consent:

        return jsonify({
            "ok": False,
            "error": "Recipient permission confirmation is required."
        }), 400

    if not valid_email(gmail) or not app_password:

        return jsonify({
            "ok": False,
            "error": "Enter valid Gmail credentials."
        }), 400

    if not subject or not body.strip():

        return jsonify({
            "ok": False,
            "error": "Subject and message are required."
        }), 400

    if len(body) > 30000:

        return jsonify({
            "ok": False,
            "error": "Message exceeds the 30,000 character limit."
        }), 400

    if (
        not isinstance(recipients_raw, list)
        or not recipients_raw
    ):

        return jsonify({
            "ok": False,
            "error": "Add recipient email addresses."
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

    # ----------------------------------------------
    # STREAM EVENTS
    # ----------------------------------------------

    def make_event(payload):

        return (
            json.dumps(
                payload,
                ensure_ascii=False
            )
            + "\n"
        )

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

            futures = {}

            for recipient in recipients:

                future = executor.submit(
                    send_one,
                    recipient,
                    gmail,
                    app_password,
                    sender_name,
                    subject,
                    body,
                    is_html
                )

                futures[future] = recipient

            for future in as_completed(futures):

                recipient = futures[future]

                try:

                    future.result()

                    sent += 1

                    status = "sent"

                    error_message = ""

                except Exception as exc:

                    failed += 1

                    status = "failed"

                    error_message = str(exc)[:220]

                yield make_event({
                    "event": "progress",
                    "email": recipient,
                    "status": status,
                    "error": error_message,
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
        stream_with_context(
            generate_events()
        ),
        mimetype="application/x-ndjson",
        headers={
            "X-Accel-Buffering": "no"
        }
    )


# ==================================================
# VERCEL HANDLER
# ==================================================

handler = app
