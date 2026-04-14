/**
 * auth.js — Client-side auth for time.jjjp.ca
 * Mirrors the music app's pattern: token stored in localStorage, sent as X-API-Key.
 */

const AUTH_CONFIG = {
  authUrl:    'https://jjjp.ca/auth/app_token.php',
  apiUrl:     'https://jjjp.ca/timeline/api.php',
  app:        'timeline',
  storageKey: 'jjjp_timeline_token',
  userKey:    'jjjp_timeline_user',
};

const auth = {
  handleCallback() {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
    if (!token) return false;
    localStorage.setItem(AUTH_CONFIG.storageKey, token);
    params.delete('token');
    const clean = params.toString();
    const url = window.location.pathname + (clean ? '?' + clean : '') + window.location.hash;
    window.history.replaceState({}, '', url);
    return true;
  },

  login() {
    const redirect = window.location.origin + window.location.pathname;
    const url = AUTH_CONFIG.authUrl
      + '?app='      + encodeURIComponent(AUTH_CONFIG.app)
      + '&redirect=' + encodeURIComponent(redirect);
    const standalone = window.matchMedia('(display-mode: standalone)').matches
                    || window.navigator.standalone === true;
    if (standalone) { window.open(url, '_blank'); }
    else            { window.location.href = url; }
  },

  isAuthenticated() { return !!localStorage.getItem(AUTH_CONFIG.storageKey); },
  getToken()        { return localStorage.getItem(AUTH_CONFIG.storageKey) || ''; },

  async whoami() {
    const token = this.getToken();
    if (!token) return null;
    const cached = localStorage.getItem(AUTH_CONFIG.userKey);
    if (cached) {
      try {
        const p = JSON.parse(cached);
        if (p._ts && Date.now() - p._ts < 3600_000) return p;
      } catch {}
    }
    try {
      const res = await fetch(AUTH_CONFIG.apiUrl + '?action=whoami', {
        headers: { 'X-API-Key': token },
      });
      if (!res.ok) {
        if (res.status === 401) this.logout();
        return null;
      }
      const data = await res.json();
      data._ts = Date.now();
      localStorage.setItem(AUTH_CONFIG.userKey, JSON.stringify(data));
      return data;
    } catch (e) {
      console.error('whoami failed:', e);
      return null;
    }
  },

  async apiCall(action, opts = {}) {
    const token = this.getToken();
    if (!token) throw new Error('Not authenticated');
    const q = new URLSearchParams({ action, ...(opts.query || {}) });
    const res = await fetch(AUTH_CONFIG.apiUrl + '?' + q.toString(), {
      method:  opts.method || 'GET',
      headers: { 'X-API-Key': token, ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
      body:    opts.body,
    });
    if (!res.ok) {
      if (res.status === 401) this.logout();
      throw new Error(`API ${action} failed: ${res.status}`);
    }
    return res.json();
  },

  logout() {
    localStorage.removeItem(AUTH_CONFIG.storageKey);
    localStorage.removeItem(AUTH_CONFIG.userKey);
  },
};
