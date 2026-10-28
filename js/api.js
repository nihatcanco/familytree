// Thin client for the local family-tree API (see server.py). Deliberately
// the only place in the app that knows about fetch()/JSON payload shapes,
// so UI code never talks to the network or the database directly.

const API_BASE = '/api';

export async function getMe() {
    const res = await fetch(`${API_BASE}/me`);
    if (res.status === 401) return null;
    if (!res.ok) {
        throw new Error(`Could not check the session (${res.status}: ${res.statusText})`);
    }
    return res.json();
}

export async function login(username, password) {
    const res = await fetch(`${API_BASE}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
    });
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Login failed (${res.status})`);
    }
    return res.json();
}

export async function logout() {
    await fetch(`${API_BASE}/logout`, { method: 'POST' });
}

export async function changeMyPassword(currentPassword, password) {
    const res = await fetch(`${API_BASE}/me`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, password })
    });
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Could not change the password (${res.status})`);
    }
    return res.json();
}

export async function listUsers() {
    const res = await fetch(`${API_BASE}/users`);
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Could not load users (${res.status})`);
    }
    return res.json();
}

export async function createUser(fields) {
    const res = await fetch(`${API_BASE}/users`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields)
    });
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Could not add the user (${res.status})`);
    }
    return res.json();
}

export async function updateUser(id, fields) {
    const res = await fetch(`${API_BASE}/users/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields)
    });
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Could not update the user (${res.status})`);
    }
    return res.json();
}

export async function deleteUser(id) {
    const res = await fetch(`${API_BASE}/users/${id}`, { method: 'DELETE' });
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Could not delete the user (${res.status})`);
    }
    return res.json();
}

export async function getTree() {
    const res = await fetch(`${API_BASE}/tree`);
    if (!res.ok) {
        throw new Error(`Could not load the family tree (${res.status}: ${res.statusText})`);
    }
    return res.json();
}

export async function updatePerson(id, fields) {
    const res = await fetch(`${API_BASE}/people/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields)
    });
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Save failed (${res.status})`);
    }
    return res.json();
}

export async function createPerson(fields) {
    const res = await fetch(`${API_BASE}/people`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields)
    });
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Could not add the person (${res.status})`);
    }
    return res.json();
}

export async function deletePerson(id) {
    const res = await fetch(`${API_BASE}/people/${id}`, { method: 'DELETE' });
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Could not delete the person (${res.status})`);
    }
    return res.json();
}

export async function createRoot(fields) {
    const res = await fetch(`${API_BASE}/roots`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields || {})
    });
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Could not add the root (${res.status})`);
    }
    return res.json();
}

export async function updateRoot(id, fields) {
    const res = await fetch(`${API_BASE}/roots/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields)
    });
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Could not save the root (${res.status})`);
    }
    return res.json();
}

export async function deleteRoot(id) {
    const res = await fetch(`${API_BASE}/roots/${id}`, { method: 'DELETE' });
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Could not delete the root (${res.status})`);
    }
    return res.json();
}
