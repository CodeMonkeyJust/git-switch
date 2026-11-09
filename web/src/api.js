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
  state: (dir) => request(`/api/state${dir ? `?dir=${encodeURIComponent(dir)}` : ''}`),
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
};

export function hasToken() {
  return token.length > 0;
}
