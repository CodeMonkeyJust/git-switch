/** API client. The token travels in the URL fragment and is sent as a header. */

const token = (() => {
  const hash = window.location.hash.replace(/^#/, '');
  const params = new URLSearchParams(hash);
  return params.get('token') ?? '';
})();

export class ApiError extends Error {
  status;
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function request(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      'x-gs-token': token,
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers ?? {}),
    },
  });

  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      if (body?.error) message = body.error;
    } catch {
      /* keep the status text */
    }
    throw new ApiError(message, res.status);
  }
  return res.json();
}

export const api = {
  state: (dir, lang) => {
    const params = new URLSearchParams();
    if (dir) params.set('dir', dir);
    if (lang) params.set('lang', lang);
    const query = params.toString();
    return request(`/api/state${query ? `?${query}` : ''}`);
  },
  plan: (profilesText) =>
    request('/api/plan', {
      method: 'POST',
      body: JSON.stringify(profilesText ? { profilesText } : {}),
    }),
  apply: (force = false) =>
    request('/api/apply', {
      method: 'POST',
      body: JSON.stringify({ force }),
    }),
  doctor: (online = false) => request(`/api/doctor${online ? '?online=1' : ''}`),
  browse: (dir) => request(`/api/fs${dir ? `?dir=${encodeURIComponent(dir)}` : ''}`),
  addRule: (dir, identity) =>
    request('/api/rules', {
      method: 'POST',
      body: JSON.stringify({ add: true, dir, identity }),
    }),
  removeRule: (dir) =>
    request('/api/rules', {
      method: 'POST',
      body: JSON.stringify({ remove: dir }),
    }),
  addIdentity: (fields) =>
    request('/api/identities', {
      method: 'POST',
      body: JSON.stringify({ add: true, ...fields }),
    }),
  updateIdentity: (fields) =>
    request('/api/identities', {
      method: 'POST',
      body: JSON.stringify({ update: true, ...fields }),
    }),
  removeIdentity: (name, force = false) =>
    request(`/api/identities?remove=${encodeURIComponent(name)}${force ? '&force=1' : ''}`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  // keys
  keys: () => request('/api/keys'),
  copyKey: (name) =>
    request('/api/keys', { method: 'POST', body: JSON.stringify({ action: 'copy', name }) }),
  generateKey: (name, comment) =>
    request('/api/keys', { method: 'POST', body: JSON.stringify({ action: 'generate', name, comment }) }),
  restoreKeys: (snapshot, passphrase) =>
    request('/api/keys', {
      method: 'POST',
      body: JSON.stringify({ action: 'restore', snapshot, passphrase }),
    }),
  renameKey: (name, newName) =>
    request('/api/keys', {
      method: 'POST',
      body: JSON.stringify({ action: 'rename', name, newName }),
    }),

  // global identity (~/.gitconfig, outside the managed block)
  setGlobalIdentity: ({ name, email }) =>
    request('/api/global-identity', {
      method: 'POST',
      body: JSON.stringify({ name, email }),
    }),

  // snapshots
  exportSnapshot: ({ path, withKeys, passphrase }) =>
    request('/api/snapshot/export', {
      method: 'POST',
      body: JSON.stringify({ path, withKeys, passphrase }),
    }),
  importSnapshot: ({ path, remaps, passphrase }) =>
    request('/api/snapshot/import', {
      method: 'POST',
      body: JSON.stringify({ path, remaps, passphrase }),
    }),

  // setup
  scanInit: (root, offline) =>
    request('/api/init/scan', { method: 'POST', body: JSON.stringify({ root, offline }) }),
  applyInit: (root, offline, force) =>
    request('/api/init/apply', { method: 'POST', body: JSON.stringify({ root, offline, force }) }),

  // repair a profile that failed validation
  repair: (apply) => request('/api/repair', { method: 'POST', body: JSON.stringify({ apply }) }),
};

export function hasToken() {
  return token.length > 0;
}
