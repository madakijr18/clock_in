/**
 * api.js — Oasis TimeMark HTTP Client + UI Helpers
 *
 * Provides:
 *   api.get(path)
 *   api.post(path, body)
 *   api.patch(path, body)
 *   api.del(path)
 *
 *   showAlert(elementId, message, type)   — type: 'error' | 'success' | 'info' | 'warning'
 *   clearAlert(elementId)
 *   showToast(message, type, duration)    — type: 'success' | 'error' | 'info' | 'warning'
 *   setLoading(btn, isLoading, loadText)  — disables button and shows spinner
 */

// ─── Base URL ─────────────────────────────────────────────────────────────────
// Auto-detect: if the page is served from a known dev port use localhost,
// otherwise fall back to the same origin.  Production should set a
// real base URL.
const API_BASE_URL = (function () {
  const host = window.location.hostname;
  if (host === 'localhost' || host === '127.0.0.1' || host === '') {
    // Change this port if your server runs on a different port
    return 'http://localhost:3001/api';
  }
  return window.location.origin + '/api';
})();

// ─── Token helpers ────────────────────────────────────────────────────────────
function _getToken() {
  return localStorage.getItem('tm_token') || '';
}

function _buildHeaders(extra = {}) {
  const headers = { 'Content-Type': 'application/json', ...extra };
  const token = _getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

// ─── Core fetch wrapper ───────────────────────────────────────────────────────
async function _request(method, path, body = null) {
  const url = path.startsWith('http') ? path : `${API_BASE_URL}${path}`;
  const hadToken = Boolean(_getToken());
  const options = {
    method,
    headers: _buildHeaders(),
  };
  if (body !== null) {
    options.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(url, options);
  } catch (networkErr) {
    throw new Error('Network error — check your connection and try again.');
  }

  // Only an authenticated request with a 401 indicates an expired session.
  // Login failures should preserve the server's useful error message.
  if (response.status === 401 && hadToken) {
    localStorage.removeItem('tm_token');
    localStorage.removeItem('tm_user');
    showToast('Session expired. Please log in again.', 'error');
    setTimeout(() => { window.location.href = 'index.html'; }, 1500);
    throw new Error('Session expired');
  }

  // Try to parse JSON even on error responses (backend always returns JSON)
  let data;
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try {
      data = await response.json();
    } catch {
      data = {};
    }
  } else {
    data = {};
  }

  if (!response.ok) {
    const message = data?.error || data?.message || `Request failed (${response.status})`;
    const err = new Error(message);
    err.status = response.status;
    err.data = data;
    throw err;
  }

  return data;
}

// ─── Public API object ────────────────────────────────────────────────────────
const api = {
  get:   (path)         => _request('GET',    path),
  post:  (path, body)   => _request('POST',   path, body),
  patch: (path, body)   => _request('PATCH',  path, body),
  put:   (path, body)   => _request('PUT',    path, body),
  del:   (path)         => _request('DELETE', path),
};

// ─── Alert helper ─────────────────────────────────────────────────────────────
/**
 * Show an inline alert inside the given element id.
 * @param {string} elementId  — id of the container div
 * @param {string} message    — alert text
 * @param {'error'|'success'|'info'|'warning'} type
 */
function showAlert(elementId, message, type = 'error') {
  const el = document.getElementById(elementId);
  if (!el) return;
  const iconMap = { error: '❌', success: '✅', info: 'ℹ️', warning: '⚠️' };
  el.innerHTML = `
    <div class="alert alert-${type}" role="alert" style="display:flex;align-items:flex-start;gap:.5rem;">
      <span>${iconMap[type] || 'ℹ️'}</span>
      <span>${escapeHTML(message)}</span>
    </div>`;
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function clearAlert(elementId) {
  const el = document.getElementById(elementId);
  if (el) el.innerHTML = '';
}

// ─── Toast notification ───────────────────────────────────────────────────────
/**
 * Display a floating toast notification.
 * @param {string} message
 * @param {'success'|'error'|'info'|'warning'} type
 * @param {number} duration  milliseconds before auto-dismiss (default 3500)
 */
function showToast(message, type = 'info', duration = 3500) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    document.body.appendChild(container);
  }

  const iconMap   = { success: '✅', error: '❌', info: 'ℹ️', warning: '⚠️' };
  const colorMap  = { success: 'var(--success)', error: 'var(--danger)', info: 'var(--primary)', warning: 'var(--warning)' };

  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');
  toast.innerHTML = `
    <span style="margin-right:.5rem;">${iconMap[type] || 'ℹ️'}</span>
    <span style="flex:1;">${escapeHTML(message)}</span>
    <button onclick="this.parentElement.remove()" style="background:none;border:none;cursor:pointer;color:inherit;font-size:1rem;padding:0 0 0 .5rem;" aria-label="Dismiss">✕</button>`;
  toast.style.borderLeft = `3px solid ${colorMap[type] || colorMap.info}`;

  container.appendChild(toast);

  // Auto-remove
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(110%)';
    toast.style.transition = 'opacity 0.3s, transform 0.3s';
    setTimeout(() => toast.remove(), 350);
  }, duration);
}

// ─── Button loading state ─────────────────────────────────────────────────────
/**
 * Toggle a button's loading state.
 * @param {HTMLButtonElement} btn
 * @param {boolean} isLoading
 * @param {string} [loadText]  — text to show while loading (optional)
 */
function setLoading(btn, isLoading, loadText = 'Loading…') {
  if (!btn) return;
  if (isLoading) {
    btn.dataset.originalText = btn.innerHTML;
    btn.innerHTML = `<span class="spinner" aria-hidden="true"></span> ${escapeHTML(loadText)}`;
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
  } else {
    btn.innerHTML = btn.dataset.originalText || btn.innerHTML;
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
  }
}

// ─── Misc utility ─────────────────────────────────────────────────────────────
function escapeHTML(str) {
  if (typeof str !== 'string') return String(str ?? '');
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Format an ISO timestamp to HH:MM AM/PM
 */
function formatTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

/**
 * Format a date string (YYYY-MM-DD) to a human readable form
 */
function formatDate(dateStr) {
  if (!dateStr) return '—';
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric'
  });
}

/**
 * Calculate and return duration string between two ISO timestamps
 */
function calcDuration(clockIn, clockOut) {
  if (!clockIn || !clockOut) return null;
  const ms   = new Date(clockOut) - new Date(clockIn);
  if (ms < 0) return null;
  const hrs  = Math.floor(ms / 3600000);
  const mins = Math.floor((ms % 3600000) / 60000);
  return `${hrs}h ${mins}m`;
}
