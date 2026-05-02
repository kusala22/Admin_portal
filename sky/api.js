/**
 * api.js — Backend connector for the Qatar Foundation Admin Portal
 *
 * Include this file AFTER admin.js in admin.html:
 *   <script src="api.js"></script>
 *
 * It overrides the form submit handlers defined in admin.js so that
 * every action talks to the Flask backend instead of running locally.
 * The original admin.js is NOT modified.
 */

const API_BASE = "http://127.0.0.1:5000/api";

// ---------------------------------------------------------------------------
// Generic fetch wrapper
// ---------------------------------------------------------------------------
async function apiFetch(path, options = {}) {
    const res = await fetch(API_BASE + path, {
        headers: { "Content-Type": "application/json" },
        credentials: "include",   // send/receive session cookies
        ...options,
    });
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data: json };
}

// ---------------------------------------------------------------------------
// Helpers (reuse functions already defined in admin.js)
// ---------------------------------------------------------------------------
function apiShowFieldErrors(errors) {
    Object.entries(errors).forEach(([field, msg]) => {
        // Try to find an error element by convention: <field>Err
        const errEl = document.getElementById(field + "Err") ||
                      document.getElementById("signup" + capitalise(field) + "Err") ||
                      document.getElementById("login" + capitalise(field) + "Err");
        if (errEl) showError(errEl.id, msg);
    });
}
function capitalise(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// ---------------------------------------------------------------------------
// Override: Sign Up
// ---------------------------------------------------------------------------
document.getElementById("signupForm").addEventListener("submit", async function (e) {
    e.preventDefault();
    e.stopImmediatePropagation();   // prevent admin.js handler from also firing

    clearAllErrors("signupForm");

    const full_name        = document.getElementById("signupName").value.trim();
    const email            = document.getElementById("signupEmail").value.trim();
    const password         = document.getElementById("signupPassword").value;
    const confirm_password = document.getElementById("signupConfirmPassword").value;
    const captchaInput     = document.getElementById("signupCaptchaInput").value.trim();

    // Client-side captcha check (captchas object lives in admin.js)
    if (!captchaInput) { showError("signupCaptchaErr", "Please enter the captcha code"); return; }
    if (captchaInput !== captchas.signup) {
        showError("signupCaptchaErr", "Captcha does not match.");
        generateCaptcha("signup");
        return;
    }

    const { ok, data } = await apiFetch("/signup", {
        method: "POST",
        body: JSON.stringify({ full_name, email, password, confirm_password }),
    });

    if (!ok) {
        if (data.errors) apiShowFieldErrors(data.errors);
        else showToast(data.error || "Sign up failed. Please try again.");
        shakeForm("signupForm");
        return;
    }

    showToast("Account created successfully!");
    generateCaptcha("signup");
    this.reset();
    checkStrength("");
    setTimeout(() => showPage("loginPage"), 1500);
}, true);   // capture phase so it runs before the admin.js bubbling handler

// ---------------------------------------------------------------------------
// Override: Login
// ---------------------------------------------------------------------------
document.getElementById("loginForm").addEventListener("submit", async function (e) {
    e.preventDefault();
    e.stopImmediatePropagation();

    clearAllErrors("loginForm");

    const email       = document.getElementById("loginEmail").value.trim();
    const password    = document.getElementById("loginPassword").value;
    const remember_me = document.getElementById("rememberMe")?.checked || false;
    const captchaInput = document.getElementById("loginCaptchaInput").value.trim();

    if (!email || !isValidEmail(email)) {
        showError("loginEmailErr");
        document.getElementById("loginEmail").classList.add("error");
        shakeForm("loginForm");
        return;
    }
    if (!password) {
        showError("loginPasswordErr", "Please enter your password");
        document.getElementById("loginPassword").classList.add("error");
        shakeForm("loginForm");
        return;
    }
    if (!captchaInput) { showError("loginCaptchaErr", "Please enter the captcha code"); return; }
    if (captchaInput !== captchas.login) {
        showError("loginCaptchaErr", "Captcha does not match. Please try again.");
        generateCaptcha("login");
        return;
    }

    const { ok, data } = await apiFetch("/login", {
        method: "POST",
        body: JSON.stringify({ email, password, remember_me }),
    });

    if (!ok) {
        showError("loginPasswordErr", data.error || "Invalid email or password");
        shakeForm("loginForm");
        generateCaptcha("login");
        return;
    }

    showToast("Login successful! Redirecting...");
    generateCaptcha("login");

    // Use the real full_name from the backend response
    const adminName = data.admin?.full_name || email;
    setTimeout(() => {
        showDashboard(email);
        // Update displayed name with the real full name
        document.getElementById("dashName").textContent = adminName;
        document.getElementById("dashAvatar").textContent =
            adminName.substring(0, 2).toUpperCase();
        loadOpportunities();
    }, 1200);
}, true);

// ---------------------------------------------------------------------------
// Override: Logout
// ---------------------------------------------------------------------------
const logoutBtn = document.getElementById("logoutBtn");
if (logoutBtn) {
    logoutBtn.addEventListener("click", async function (e) {
        e.preventDefault();
        e.stopImmediatePropagation();
        await apiFetch("/logout", { method: "POST" });
        handleLogout();
    }, true);
}

// ---------------------------------------------------------------------------
// Override: Forgot Password
// ---------------------------------------------------------------------------
document.getElementById("forgotForm").addEventListener("submit", async function (e) {
    e.preventDefault();
    e.stopImmediatePropagation();

    clearAllErrors("forgotForm");

    const email        = document.getElementById("forgotEmail").value.trim();
    const captchaInput = document.getElementById("forgotCaptchaInput").value.trim();

    if (!email || !isValidEmail(email)) {
        showError("forgotEmailErr");
        document.getElementById("forgotEmail").classList.add("error");
        shakeForm("forgotForm");
        return;
    }
    if (!captchaInput) { showError("forgotCaptchaErr", "Please enter the captcha code"); return; }
    if (captchaInput !== captchas.forgot) {
        showError("forgotCaptchaErr", "Captcha does not match.");
        generateCaptcha("forgot");
        return;
    }

    // Fire and forget — always show the same message
    apiFetch("/forgot-password", {
        method: "POST",
        body: JSON.stringify({ email }),
    });

    showToast("If that email is registered, a reset link has been sent.");
    generateCaptcha("forgot");
    this.reset();
}, true);

// ---------------------------------------------------------------------------
// Opportunity Management
// ---------------------------------------------------------------------------

let currentEditId = null;   // tracks which opportunity is being edited

async function loadOpportunities() {
    const { ok, data } = await apiFetch("/opportunities");
    if (!ok) return;

    const grid = document.querySelector(".opportunities-grid");
    if (!grid) return;

    grid.innerHTML = "";   // clear hardcoded demo cards

    if (data.length === 0) {
        grid.innerHTML = `
            <div class="empty-state" style="grid-column:1/-1;text-align:center;padding:40px;color:var(--text-secondary)">
                <p>No opportunities yet. Click <strong>Add Opportunity</strong> to create one.</p>
            </div>`;
        return;
    }

    data.forEach(opp => grid.appendChild(buildOpportunityCard(opp)));
}

function buildOpportunityCard(opp) {
    const card = document.createElement("div");
    card.className = "opportunity-card";
    card.dataset.id = opp.id;

    const skills = Array.isArray(opp.skills) ? opp.skills : [];
    const applicantsLabel = opp.max_applicants ? `${opp.max_applicants} applicants` : "Open";

    card.innerHTML = `
        <div class="opportunity-card-header">
            <h5>${escapeHtml(opp.name)}</h5>
            <span class="opp-category-badge">${escapeHtml(opp.category)}</span>
            <div class="opportunity-meta">
                <span>
                    <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                    ${escapeHtml(opp.duration)}
                </span>
                <span>
                    <svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
                    ${escapeHtml(opp.start_date)}
                </span>
            </div>
        </div>
        <p class="opportunity-description">${escapeHtml(opp.description)}</p>
        <div class="opportunity-skills">
            <div class="opportunity-skills-label">Skills You'll Gain</div>
            <div class="skills-tags">
                ${skills.map(s => `<span class="skill-tag">${escapeHtml(s)}</span>`).join("")}
            </div>
        </div>
        <div class="opportunity-footer">
            <span class="applicants-count">${escapeHtml(applicantsLabel)}</span>
            <div class="opp-actions">
                <button class="view-course-btn opp-view-btn" style="width:auto;padding:8px 14px;">View</button>
                <button class="view-course-btn opp-edit-btn" style="width:auto;padding:8px 14px;background:var(--warning,#f59e0b)">Edit</button>
                <button class="view-course-btn opp-delete-btn" style="width:auto;padding:8px 14px;background:var(--danger,#ef4444)">Delete</button>
            </div>
        </div>`;

    // View details
    card.querySelector(".opp-view-btn").addEventListener("click", () => {
        openOpportunityDetails(opp.name, {
            duration: opp.duration,
            startDate: opp.start_date,
            description: opp.description,
            skills: skills,
            applicants: opp.max_applicants || 0,
            futureOpportunities: opp.future_opportunities,
            prerequisites: "",
        });
    });

    // Edit
    card.querySelector(".opp-edit-btn").addEventListener("click", () => openEditModal(opp));

    // Delete
    card.querySelector(".opp-delete-btn").addEventListener("click", () => confirmDeleteOpportunity(opp.id, opp.name));

    return card;
}

// ---------------------------------------------------------------------------
// Override: Create Opportunity form
// ---------------------------------------------------------------------------
document.getElementById("opportunityForm").addEventListener("submit", async function (e) {
    e.preventDefault();
    e.stopImmediatePropagation();

    const name                = document.getElementById("oppName").value.trim();
    const duration            = document.getElementById("oppDuration").value.trim();
    const start_date          = document.getElementById("oppStartDate").value;
    const description         = document.getElementById("oppDescription").value.trim();
    const skills              = document.getElementById("oppSkills").value.trim();
    const category            = document.getElementById("oppCategory").value;
    const future_opportunities = document.getElementById("oppFuture").value.trim();
    const max_applicants      = document.getElementById("oppMaxApplicants").value.trim() || null;

    if (!name || !duration || !start_date || !description || !skills || !category || !future_opportunities) {
        showToast("Please fill all required fields");
        return;
    }

    const isEdit = currentEditId !== null;
    const path   = isEdit ? `/opportunities/${currentEditId}` : "/opportunities";
    const method = isEdit ? "PUT" : "POST";

    const { ok, data } = await apiFetch(path, {
        method,
        body: JSON.stringify({ name, duration, start_date, description, skills, category, future_opportunities, max_applicants }),
    });

    if (!ok) {
        const msg = data.errors ? Object.values(data.errors).join(" ") : (data.error || "Failed to save opportunity.");
        showToast(msg);
        return;
    }

    showToast(isEdit ? "Opportunity updated!" : "Opportunity created successfully!");
    closeOpportunityModal();
    this.reset();
    currentEditId = null;
    loadOpportunities();
}, true);

// ---------------------------------------------------------------------------
// Edit modal helper
// ---------------------------------------------------------------------------
function openEditModal(opp) {
    currentEditId = opp.id;

    document.getElementById("oppName").value         = opp.name;
    document.getElementById("oppDuration").value     = opp.duration;
    document.getElementById("oppStartDate").value    = opp.start_date;
    document.getElementById("oppDescription").value  = opp.description;
    document.getElementById("oppSkills").value       = Array.isArray(opp.skills) ? opp.skills.join(", ") : opp.skills;
    document.getElementById("oppCategory").value     = opp.category;
    document.getElementById("oppFuture").value       = opp.future_opportunities;
    document.getElementById("oppMaxApplicants").value = opp.max_applicants || "";

    // Update modal title if the element exists
    const modalTitle = document.querySelector("#opportunityModal h3, #opportunityModal .modal-title");
    if (modalTitle) modalTitle.textContent = "Edit Opportunity";

    openOpportunityModal();
}

// Reset edit state when modal is closed
const origCloseOpportunityModal = window.closeOpportunityModal;
window.closeOpportunityModal = function () {
    currentEditId = null;
    const modalTitle = document.querySelector("#opportunityModal h3, #opportunityModal .modal-title");
    if (modalTitle) modalTitle.textContent = "Add New Opportunity";
    if (origCloseOpportunityModal) origCloseOpportunityModal();
};

// ---------------------------------------------------------------------------
// Delete with confirmation
// ---------------------------------------------------------------------------
async function confirmDeleteOpportunity(id, name) {
    if (!confirm(`Delete "${name}"? This cannot be undone.`)) return;

    const { ok, data } = await apiFetch(`/opportunities/${id}`, { method: "DELETE" });
    if (!ok) {
        showToast(data.error || "Failed to delete opportunity.");
        return;
    }
    showToast("Opportunity deleted.");
    loadOpportunities();
}

// ---------------------------------------------------------------------------
// On page load: check if already logged in (e.g. after a page refresh)
// ---------------------------------------------------------------------------
(async function checkSession() {
    const { ok, data } = await apiFetch("/me");
    if (ok && data.email) {
        showDashboard(data.email);
        document.getElementById("dashName").textContent = data.full_name;
        document.getElementById("dashAvatar").textContent =
            data.full_name.substring(0, 2).toUpperCase();
        loadOpportunities();
    }
})();
