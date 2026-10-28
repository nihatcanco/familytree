// Guided overlay tutorial. A small, dependency-free product tour: a dimmed
// backdrop with a spotlight cut-out over each highlighted control and a
// caption card with Back / Next navigation.
//
// startTour() is called from app.js right after a fresh login (see
// onAuthenticated), and also from the "?" button in the top bar so anyone
// can replay it. Steps whose target element is missing or hidden for the
// current role (add buttons for viewers, the admin panel for non-admins)
// are skipped automatically.

import { iconMarkup } from './icons.js';

const STEPS = [
    {
        target: null,
        icon: 'user',
        title: 'Welcome to the Family Tree',
        body: 'Drag with the mouse to move around the tree, and hold Ctrl (⌘) while scrolling to zoom. Click a person\'s card to open their details in the right panel: focus on that person, edit or delete. This short tour shows the remaining tools.',
    },
    {
        target: '#search-input',
        icon: 'zoom-in',
        title: 'Search',
        body: 'Search for people by name. Use the arrows below to step through the results, and X to clear the search.',
    },
    {
        target: '#btn-relationship',
        icon: 'route',
        title: 'Relationship Path',
        body: 'Press this button and pick two people in the tree; the chain of relations between them is drawn highlighted.',
    },
    {
        target: '#btn-add-person',
        icon: 'user-plus',
        title: 'Adding People and Roots',
        body: 'Add a new person, or define a "root" (the start of a family line). Only visible to editor and admin accounts.',
    },
    {
        target: '#generation-legend',
        icon: 'diamond',
        title: 'Generation Colors',
        body: 'Each generation has its own color. The list summarizes the generations currently shown in the tree.',
    },
    {
        target: '#minimap-wrapper',
        icon: 'maximize',
        title: 'Minimap and Zoom',
        body: 'Shows where you are in the overall view; click to jump there. The buttons above zoom in and out and download the displayed tree as SVG.',
    },
    {
        target: '#btn-admin-panel',
        icon: 'shield',
        title: 'User Management',
        body: 'Add and remove login accounts, change roles, and link each account to its person in the tree. Admin only.',
    },
    {
        target: '#btn-change-password',
        icon: 'key-round',
        title: 'Change Password',
        body: 'Change your own password here (your current password is required).',
    },
    {
        target: '#btn-theme-toggle',
        icon: 'moon',
        title: 'Theme',
        body: 'Switches between light and dark mode. Your choice is remembered in this browser.',
    },
    {
        target: '#btn-logout',
        icon: 'log-out',
        title: 'Log Out',
        body: 'Ends your session. This tour is shown again on your next login — you can also open it any time with the (?) button at the top right.',
    },
];

const CSS = `
#ft-tour-root { position: fixed; inset: 0; z-index: 9999; font-family: var(--font-sans, system-ui, sans-serif); }
#ft-tour-root * { box-sizing: border-box; }
#ft-tour-backdrop { position: absolute; inset: 0; background: rgba(15, 23, 42, 0.55); }
#ft-tour-hole {
    position: absolute; border-radius: 10px; pointer-events: none;
    box-shadow: 0 0 0 9999px rgba(15, 23, 42, 0.55), 0 0 0 3px rgba(59, 130, 246, 0.9);
    transition: top .2s ease, left .2s ease, width .2s ease, height .2s ease;
}
#ft-tour-hole.ft-hidden { display: none; }
#ft-tour-card {
    position: absolute; width: 320px; max-width: calc(100vw - 24px);
    background: #fff; color: #1e293b; border: 1px solid #e2e8f0; border-radius: 12px;
    box-shadow: 0 20px 25px -5px rgba(0,0,0,.25), 0 8px 10px -6px rgba(0,0,0,.25);
    padding: 16px; transition: top .2s ease, left .2s ease;
}
#ft-tour-card.ft-center { top: 50% !important; left: 50% !important; transform: translate(-50%, -50%); }
.ft-tour-step { font-size: 11px; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: #94a3b8; }
.ft-tour-title { font-size: 15px; font-weight: 600; margin: 4px 0 6px; display: flex; align-items: center; gap: 6px; }
.ft-tour-title svg { width: 16px; height: 16px; color: #3b82f6; flex: none; }
.ft-tour-body { font-size: 13px; line-height: 1.5; color: #475569; }
.ft-tour-actions { display: flex; align-items: center; gap: 8px; margin-top: 14px; }
.ft-tour-actions .ft-spacer { flex: 1; }
.ft-tour-btn {
    font: inherit; font-size: 13px; font-weight: 600; padding: 6px 12px; border-radius: 8px;
    border: 1px solid transparent; cursor: pointer; transition: background-color .15s, color .15s;
}
.ft-tour-btn-ghost { background: transparent; color: #64748b; }
.ft-tour-btn-ghost:hover { background: #f1f5f9; color: #1e293b; }
.ft-tour-btn-secondary { background: #f1f5f9; color: #334155; }
.ft-tour-btn-secondary:hover { background: #e2e8f0; }
.ft-tour-btn-primary { background: #2563eb; color: #fff; }
.ft-tour-btn-primary:hover { background: #1d4ed8; }
.ft-tour-close {
    position: absolute; top: 8px; right: 8px; width: 26px; height: 26px; display: flex;
    align-items: center; justify-content: center; border: 0; background: transparent;
    color: #94a3b8; border-radius: 6px; cursor: pointer;
}
.ft-tour-close:hover { background: #f1f5f9; color: #1e293b; }
.ft-tour-close svg { width: 15px; height: 15px; }

html.dark #ft-tour-card { background: #1e293b; color: #e2e8f0; border-color: #334155; }
html.dark .ft-tour-body { color: #b6c1d0; }
html.dark .ft-tour-btn-ghost { color: #94a3b8; }
html.dark .ft-tour-btn-ghost:hover { background: #334155; color: #f1f5f9; }
html.dark .ft-tour-btn-secondary { background: #334155; color: #e2e8f0; }
html.dark .ft-tour-btn-secondary:hover { background: #475569; }
html.dark .ft-tour-close:hover { background: #334155; color: #f1f5f9; }
`;

const MARGIN = 12;      // gap between spotlight and card / viewport edge
const PAD = 8;          // spotlight padding around the target

function injectStyle() {
    if (document.getElementById('ft-tour-style')) return;
    const style = document.createElement('style');
    style.id = 'ft-tour-style';
    style.textContent = CSS;
    document.head.appendChild(style);
}

function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return false;
    return getComputedStyle(el).visibility !== 'hidden';
}

export function startTour() {
    injectStyle();

    // Never stack two tours.
    const existing = document.getElementById('ft-tour-root');
    if (existing) existing.remove();

    const steps = STEPS.filter(s => !s.target || isVisible(document.querySelector(s.target)));
    if (steps.length === 0) return;

    const root = document.createElement('div');
    root.id = 'ft-tour-root';
    root.innerHTML = `
        <div id="ft-tour-backdrop"></div>
        <div id="ft-tour-hole"></div>
        <div id="ft-tour-card" role="dialog" aria-modal="true" aria-labelledby="ft-tour-title">
            <button class="ft-tour-close" aria-label="Close">${iconMarkup('x')}</button>
            <div class="ft-tour-step"></div>
            <div class="ft-tour-title" id="ft-tour-title"></div>
            <div class="ft-tour-body"></div>
            <div class="ft-tour-actions">
                <button class="ft-tour-btn ft-tour-btn-ghost" data-act="skip">Skip tour</button>
                <span class="ft-spacer"></span>
                <button class="ft-tour-btn ft-tour-btn-secondary" data-act="back">Back</button>
                <button class="ft-tour-btn ft-tour-btn-primary" data-act="next">Next</button>
            </div>
        </div>`;
    document.body.appendChild(root);

    const hole = root.querySelector('#ft-tour-hole');
    const card = root.querySelector('#ft-tour-card');
    const elStep = root.querySelector('.ft-tour-step');
    const elTitle = root.querySelector('.ft-tour-title');
    const elBody = root.querySelector('.ft-tour-body');
    const btnBack = root.querySelector('[data-act="back"]');
    const btnNext = root.querySelector('[data-act="next"]');

    let i = 0;

    function done() {
        window.removeEventListener('resize', reposition, true);
        window.removeEventListener('scroll', reposition, true);
        document.removeEventListener('keydown', onKey, true);
        root.remove();
    }

    function placeCard(rect) {
        card.classList.remove('ft-center');
        card.style.transform = '';
        const cw = card.offsetWidth;
        const ch = card.offsetHeight;
        const vw = window.innerWidth;
        const vh = window.innerHeight;

        let top, left;
        const below = vh - rect.bottom;
        const above = rect.top;

        if (below >= ch + MARGIN || below >= above) {
            top = Math.min(rect.bottom + MARGIN, vh - ch - MARGIN);
        } else {
            top = Math.max(rect.top - ch - MARGIN, MARGIN);
        }
        left = rect.left + rect.width / 2 - cw / 2;
        left = Math.max(MARGIN, Math.min(left, vw - cw - MARGIN));
        card.style.top = `${Math.max(MARGIN, top)}px`;
        card.style.left = `${left}px`;
    }

    function reposition() {
        const step = steps[i];
        const target = step.target && document.querySelector(step.target);
        if (target && isVisible(target)) {
            const r = target.getBoundingClientRect();
            hole.classList.remove('ft-hidden');
            hole.style.top = `${r.top - PAD}px`;
            hole.style.left = `${r.left - PAD}px`;
            hole.style.width = `${r.width + PAD * 2}px`;
            hole.style.height = `${r.height + PAD * 2}px`;
            placeCard(r);
        } else {
            hole.classList.add('ft-hidden');
            card.classList.add('ft-center');
        }
    }

    function render() {
        const step = steps[i];
        elStep.textContent = `${i + 1} / ${steps.length}`;
        elTitle.innerHTML = `${iconMarkup(step.icon || 'help-circle')}<span>${step.title}</span>`;
        elBody.textContent = step.body;
        btnBack.style.visibility = i === 0 ? 'hidden' : 'visible';
        btnNext.textContent = i === steps.length - 1 ? 'Finish' : 'Next';

        const target = step.target && document.querySelector(step.target);
        if (target && target.scrollIntoView) {
            target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
        requestAnimationFrame(reposition);
    }

    function go(delta) {
        const n = i + delta;
        if (n < 0) return;
        if (n >= steps.length) { done(); return; }
        i = n;
        render();
    }

    function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); done(); }
        else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); go(1); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
    }

    root.querySelector('.ft-tour-close').addEventListener('click', done);
    root.querySelector('[data-act="skip"]').addEventListener('click', done);
    btnBack.addEventListener('click', () => go(-1));
    btnNext.addEventListener('click', () => go(1));
    root.querySelector('#ft-tour-backdrop').addEventListener('click', done);
    window.addEventListener('resize', reposition, true);
    window.addEventListener('scroll', reposition, true);
    document.addEventListener('keydown', onKey, true);

    render();
}
