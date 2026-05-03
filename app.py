import os
import re
import secrets
import logging
from datetime import datetime, timedelta
from functools import wraps

from flask import Flask, request, jsonify, session
from flask_cors import CORS
from werkzeug.security import generate_password_hash, check_password_hash

from models import db, Admin, Opportunity, PasswordResetToken

# ---------------------------------------------------------------------------
# App setup
# ---------------------------------------------------------------------------

app = Flask(__name__)

# Secret key — override via SECRET_KEY env var in production
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "dev-secret-change-in-production")

# SQLite database stored next to app.py
BASE_DIR = os.path.abspath(os.path.dirname(__file__))
app.config["SQLALCHEMY_DATABASE_URI"] = "sqlite:///" + os.path.join(BASE_DIR, "portal.db")
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False

# Session cookie settings
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
# Set to True when serving over HTTPS in production
app.config["SESSION_COOKIE_SECURE"] = False

# CORS — allow the frontend origin (adjust if hosted elsewhere)
CORS(
    app,
    supports_credentials=True,
    origins=["http://localhost:3000", "http://127.0.0.1:3000",
             "http://localhost:5500", "http://127.0.0.1:5500",
             "null"],   # "null" covers file:// origins during local dev
)

db.init_app(app)

# Logging — reset links are printed here instead of emailed
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

VALID_CATEGORIES = {
    "Technology", "Business", "Design", "Marketing", "Data Science", "Other"
}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def is_valid_email(email: str) -> bool:
    return bool(re.match(r"^[^\s@]+@[^\s@]+\.[^\s@]+$", email))


def login_required(f):
    """Decorator that returns 401 if no admin is logged in."""
    @wraps(f)
    def decorated(*args, **kwargs):
        if "admin_id" not in session:
            return jsonify({"error": "Authentication required"}), 401
        return f(*args, **kwargs)
    return decorated


def get_current_admin():
    return Admin.query.get(session["admin_id"])


# ---------------------------------------------------------------------------
# Database initialisation
# ---------------------------------------------------------------------------

with app.app_context():
    db.create_all()


# ---------------------------------------------------------------------------
# Auth routes
# ---------------------------------------------------------------------------

@app.route("/api/signup", methods=["POST"])
def signup():
    data = request.get_json(silent=True) or {}

    full_name = (data.get("full_name") or "").strip()
    email = (data.get("email") or "").strip().lower()
    password = data.get("password") or ""
    confirm_password = data.get("confirm_password") or ""

    errors = {}

    if not full_name:
        errors["full_name"] = "Full name is required."
    if not email:
        errors["email"] = "Email is required."
    elif not is_valid_email(email):
        errors["email"] = "Please enter a valid email address."
    if not password:
        errors["password"] = "Password is required."
    elif len(password) < 8:
        errors["password"] = "Password must be at least 8 characters."
    if not confirm_password:
        errors["confirm_password"] = "Please confirm your password."
    elif password and password != confirm_password:
        errors["confirm_password"] = "Passwords do not match."

    if errors:
        return jsonify({"errors": errors}), 400

    if Admin.query.filter_by(email=email).first():
        return jsonify({"errors": {"email": "An account with this email already exists."}}), 400

    admin = Admin(
        full_name=full_name,
        email=email,
        password_hash=generate_password_hash(password),
    )
    db.session.add(admin)
    db.session.commit()

    return jsonify({"message": "Account created successfully. Please log in."}), 201


@app.route("/api/login", methods=["POST"])
def login():
    data = request.get_json(silent=True) or {}

    email = (data.get("email") or "").strip().lower()
    password = data.get("password") or ""
    remember_me = bool(data.get("remember_me", False))

    # Generic error for any auth failure (prevents user enumeration)
    auth_error = jsonify({"error": "Invalid email or password"}), 401

    if not email or not password:
        return auth_error

    admin = Admin.query.filter_by(email=email).first()
    if not admin or not check_password_hash(admin.password_hash, password):
        return auth_error

    session.clear()
    session["admin_id"] = admin.id

    if remember_me:
        session.permanent = True
        app.permanent_session_lifetime = timedelta(days=30)
    else:
        session.permanent = False

    return jsonify({"message": "Login successful.", "admin": admin.to_dict()}), 200


@app.route("/api/logout", methods=["POST"])
def logout():
    session.clear()
    return jsonify({"message": "Logged out successfully."}), 200


@app.route("/api/forgot-password", methods=["POST"])
def forgot_password():
    data = request.get_json(silent=True) or {}
    email = (data.get("email") or "").strip().lower()

    # Always return the same message regardless of whether the email exists
    success_response = jsonify(
        {"message": "If that email is registered, a reset link has been sent."}
    ), 200

    if not email or not is_valid_email(email):
        return success_response

    admin = Admin.query.filter_by(email=email).first()
    if admin:
        # Invalidate any existing unused tokens for this admin
        PasswordResetToken.query.filter_by(admin_id=admin.id, used=False).update({"used": True})
        db.session.flush()

        token = secrets.token_urlsafe(48)
        expires_at = datetime.utcnow() + timedelta(hours=1)

        reset_token = PasswordResetToken(
            admin_id=admin.id,
            token=token,
            expires_at=expires_at,
        )
        db.session.add(reset_token)
        db.session.commit()

        # Log the reset link instead of sending an email
        reset_link = f"/reset-password?token={token}"
        logger.info("Password reset link for %s: %s", email, reset_link)

    return success_response


@app.route("/api/reset-password", methods=["POST"])
def reset_password():
    data = request.get_json(silent=True) or {}
    token_value = (data.get("token") or "").strip()
    new_password = data.get("password") or ""
    confirm_password = data.get("confirm_password") or ""

    if not token_value:
        return jsonify({"error": "Reset token is required."}), 400

    reset_token = PasswordResetToken.query.filter_by(token=token_value, used=False).first()

    if not reset_token:
        return jsonify({"error": "Invalid or already used reset link."}), 400

    if datetime.utcnow() > reset_token.expires_at:
        return jsonify({"error": "This reset link has expired. Please request a new one."}), 400

    errors = {}
    if not new_password:
        errors["password"] = "Password is required."
    elif len(new_password) < 8:
        errors["password"] = "Password must be at least 8 characters."
    if not confirm_password:
        errors["confirm_password"] = "Please confirm your password."
    elif new_password and new_password != confirm_password:
        errors["confirm_password"] = "Passwords do not match."

    if errors:
        return jsonify({"errors": errors}), 400

    admin = Admin.query.get(reset_token.admin_id)
    admin.password_hash = generate_password_hash(new_password)
    reset_token.used = True
    db.session.commit()

    return jsonify({"message": "Password updated successfully. Please log in."}), 200


# ---------------------------------------------------------------------------
# Opportunity routes (all protected)
# ---------------------------------------------------------------------------

def validate_opportunity_data(data: dict) -> dict:
    """Return a dict of field errors, or empty dict if valid."""
    errors = {}

    if not (data.get("name") or "").strip():
        errors["name"] = "Opportunity name is required."
    if not (data.get("duration") or "").strip():
        errors["duration"] = "Duration is required."
    if not (data.get("start_date") or "").strip():
        errors["start_date"] = "Start date is required."
    if not (data.get("description") or "").strip():
        errors["description"] = "Description is required."
    if not (data.get("skills") or "").strip():
        errors["skills"] = "At least one skill is required."
    if not (data.get("category") or "").strip():
        errors["category"] = "Category is required."
    elif data["category"] not in VALID_CATEGORIES:
        errors["category"] = f"Category must be one of: {', '.join(sorted(VALID_CATEGORIES))}."
    if not (data.get("future_opportunities") or "").strip():
        errors["future_opportunities"] = "Future opportunities field is required."

    max_applicants = data.get("max_applicants")
    if max_applicants not in (None, "", 0):
        try:
            val = int(max_applicants)
            if val < 1:
                errors["max_applicants"] = "Max applicants must be a positive number."
        except (ValueError, TypeError):
            errors["max_applicants"] = "Max applicants must be a valid number."

    return errors


@app.route("/api/opportunities", methods=["GET"])
@login_required
def list_opportunities():
    admin = get_current_admin()
    opportunities = (
        Opportunity.query
        .filter_by(admin_id=admin.id)
        .order_by(Opportunity.created_at.desc())
        .all()
    )
    return jsonify([opp.to_dict() for opp in opportunities]), 200


@app.route("/api/opportunities", methods=["POST"])
@login_required
def create_opportunity():
    data = request.get_json(silent=True) or {}
    errors = validate_opportunity_data(data)
    if errors:
        return jsonify({"errors": errors}), 400

    admin = get_current_admin()

    max_applicants_raw = data.get("max_applicants")
    max_applicants = None
    if max_applicants_raw not in (None, ""):
        max_applicants = int(max_applicants_raw)

    opp = Opportunity(
        admin_id=admin.id,
        name=data["name"].strip(),
        category=data["category"].strip(),
        duration=data["duration"].strip(),
        start_date=data["start_date"].strip(),
        description=data["description"].strip(),
        skills=data["skills"].strip(),
        future_opportunities=data["future_opportunities"].strip(),
        max_applicants=max_applicants,
    )
    db.session.add(opp)
    db.session.commit()

    return jsonify(opp.to_dict()), 201


@app.route("/api/opportunities/<int:opp_id>", methods=["GET"])
@login_required
def get_opportunity(opp_id):
    admin = get_current_admin()
    opp = Opportunity.query.filter_by(id=opp_id, admin_id=admin.id).first()
    if not opp:
        return jsonify({"error": "Opportunity not found."}), 404
    return jsonify(opp.to_dict()), 200


@app.route("/api/opportunities/<int:opp_id>", methods=["PUT"])
@login_required
def update_opportunity(opp_id):
    admin = get_current_admin()
    opp = Opportunity.query.filter_by(id=opp_id, admin_id=admin.id).first()
    if not opp:
        return jsonify({"error": "Opportunity not found."}), 404

    data = request.get_json(silent=True) or {}
    errors = validate_opportunity_data(data)
    if errors:
        return jsonify({"errors": errors}), 400

    max_applicants_raw = data.get("max_applicants")
    max_applicants = None
    if max_applicants_raw not in (None, ""):
        max_applicants = int(max_applicants_raw)

    opp.name = data["name"].strip()
    opp.category = data["category"].strip()
    opp.duration = data["duration"].strip()
    opp.start_date = data["start_date"].strip()
    opp.description = data["description"].strip()
    opp.skills = data["skills"].strip()
    opp.future_opportunities = data["future_opportunities"].strip()
    opp.max_applicants = max_applicants

    db.session.commit()
    return jsonify(opp.to_dict()), 200


@app.route("/api/opportunities/<int:opp_id>", methods=["DELETE"])
@login_required
def delete_opportunity(opp_id):
    admin = get_current_admin()
    opp = Opportunity.query.filter_by(id=opp_id, admin_id=admin.id).first()
    if not opp:
        return jsonify({"error": "Opportunity not found."}), 404

    db.session.delete(opp)
    db.session.commit()
    return jsonify({"message": "Opportunity deleted successfully."}), 200


# ---------------------------------------------------------------------------
# Session check (useful for frontend to verify login state on page load)
# ---------------------------------------------------------------------------

@app.route("/api/me", methods=["GET"])
@login_required
def me():
    return jsonify(get_current_admin().to_dict()), 200


# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    # use_reloader=False prevents Flask from watching site-packages
    # (which causes infinite restarts when large libraries like transformers are installed)
    app.run(debug=True, port=5000, use_reloader=False)
