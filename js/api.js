// Thin client for the local family-tree API (see server.py). Deliberately
// the only place in the app that knows about fetch()/JSON payload shapes,
// so UI code never talks to the network or the database directly.

const API_BASE = '/api';

export async function getTree() {
    const res = await fetch(`${API_BASE}/tree`);
    if (!res.ok) {
        throw new Error(`Aile ağacı yüklenemedi (${res.status}: ${res.statusText})`);
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
        throw new Error(body.error || `Kaydetme başarısız (${res.status})`);
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
        throw new Error(body.error || `Kişi eklenemedi (${res.status})`);
    }
    return res.json();
}

export async function deletePerson(id) {
    const res = await fetch(`${API_BASE}/people/${id}`, { method: 'DELETE' });
    if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Kişi silinemedi (${res.status})`);
    }
    return res.json();
}
