// Turns a hierarchy person/root node into the HTML for its on-canvas card,
// and (for the image export) into a standalone SVG fragment. No shared app
// state — everything comes from the passed-in node or, for the SVG export,
// the already-rendered DOM card.

import { escapeHTML, svgEsc, initialsOf, genderGlyph, wrapToLines } from './util.js';

const HIDDEN_ATTR_KEYS = ['surname', 'gender', 'birthplace', 'birthdate', 'dateofdeath', 'note'];

// HTML for a person's card (or a family-root diamond).
export function generateCardHTML(person, isSpouse = false) {
    if (!person) return '';

    // A family root renders as a diamond showing only its editable title.
    if (person._isRoot) {
        const rootGenAttr = person._generation ? `data-generation="${person._generation}"` : '';
        const rootTitle = person.title || 'ROOT';
        const rootDetails = { isRoot: true, id: person.id, title: rootTitle, generation: person._generation };
        return `<div data-id="${person.id}" data-root="1" ${rootGenAttr} data-details="${escapeHTML(JSON.stringify(rootDetails))}"
            class="tree-node-card root-node absolute z-10 cursor-pointer text-center">
            <div class="root-diamond"></div>
            <span class="root-title">${escapeHTML(rootTitle)}</span>
        </div>`;
    }

    const cardClass = isSpouse ? 'spouse-card' : 'direct-relative-card';
    const personIdAttr = person.id ? `data-id="${person.id}"` : '';
    // Fold the (negative) root-parent id into data-parent-ids so the
    // diamond -> founding-member connector draws; the edit form still
    // reads the real _parentIds only.
    const allParentIds = [...(person._parentIds || [])];
    if (person._rootParentId != null) allParentIds.push(person._rootParentId);
    const parentIdsAttr = allParentIds.length > 0 ? `data-parent-ids="${allParentIds.join(',')}"` : '';
    const spouseIdsAttr = (person._spouseIds && person._spouseIds.length > 0) ? `data-spouse-ids="${person._spouseIds.join(',')}"` : '';
    const genAttr = person._generation ? `data-generation="${person._generation}"` : '';

    const personDetails = { name: person.name, id: person.id, photoUrl: person.photoUrl, attributes: person.attributes };
    const detailsAttr = `data-details="${escapeHTML(JSON.stringify(personDetails))}"`;

    const name = person.name || "UNKNOWN";
    const surname = (person.attributes && person.attributes.surname) ? person.attributes.surname : '';

    const gender = (person.attributes && person.attributes.gender) ? person.attributes.gender : '';
    let portraitHtml;
    if (person.photoUrl) {
        portraitHtml = `<img src="${escapeHTML(person.photoUrl)}" alt="${escapeHTML(name)}" class="w-16 h-16 rounded-full object-cover mx-auto mb-2 border-2 border-slate-100 shadow-sm shrink-0">`;
    } else {
        portraitHtml = `<div class="w-16 h-16 rounded-full mx-auto mb-2 flex items-center justify-center border-2 border-slate-100 shadow-sm shrink-0 text-xl font-bold tracking-tight bg-slate-100 text-slate-400">${escapeHTML(initialsOf(name, surname))}</div>`;
    }

    let html = `<div ${personIdAttr} ${parentIdsAttr} ${spouseIdsAttr} ${genAttr} ${detailsAttr} class="tree-node-card ${cardClass} bg-white border border-slate-300 rounded-xl p-4 shadow-sm w-[220px] min-h-[10em] text-center absolute z-10 cursor-pointer min-w-0 h-fit overflow-hidden">
        <span class="absolute top-1 right-2 text-[9px] font-mono text-slate-300 opacity-70 select-none pointer-events-none">#${escapeHTML(String(person.id))}</span>`;
    if (person._generation) {
        html += `<span class="absolute top-1 left-2 text-[9px] font-mono text-slate-300 opacity-70 select-none pointer-events-none">${person._generation}. Nesil</span>`;
    }
    html += `<div class="card-header">
        ${portraitHtml}
        <h3 class="font-bold text-slate-900 text-lg leading-tight hover:opacity-80 transition-opacity">${escapeHTML(name)}</h3>`;
    if (surname) {
        html += `<div class="font-semibold text-slate-700 text-sm mt-0.5">${escapeHTML(surname)}</div>`;
    }
    html += `</div>`;

    const cardAttrs = person.attributes || {};
    const bp = cardAttrs.birthplace;
    const bd = cardAttrs.birthdate;
    const dd = cardAttrs.dateofdeath;
    const note = cardAttrs.note;
    const displayAttributes = Object.keys(cardAttrs).filter(k => !HIDDEN_ATTR_KEYS.includes(k));

    const cardGlyph = genderGlyph(gender);
    if (cardGlyph || bp || bd || dd || note || displayAttributes.length > 0) {
        html += `<div class="mt-2.5 flex flex-col gap-1.5 text-[13px] text-slate-500 leading-snug">`;
        if (cardGlyph) {
            html += `<div class="flex items-start gap-1.5 text-left" title="${cardGlyph.label}">
                        <span class="w-3 mt-0.5 shrink-0 text-center leading-none text-slate-400">${cardGlyph.sym}</span>
                    </div>`;
        }
        if (bp) {
            html += `<div class="flex items-start gap-1.5 text-left" title="${escapeHTML(bp)}">
                        <i data-lucide="map-pin" class="w-3 h-3 mt-0.5 shrink-0 text-slate-400"></i>
                        <span class="min-w-0 break-words">${escapeHTML(bp)}</span>
                    </div>`;
        }
        if (bd || dd) {
            const dateLines = [];
            if (bd) dateLines.push(`D: ${escapeHTML(bd)}`);
            if (dd) dateLines.push(`Ö: ${escapeHTML(dd)}`);
            html += `<div class="flex items-start gap-1.5 text-left">
                        <i data-lucide="calendar" class="w-3 h-3 mt-0.5 shrink-0 text-slate-400"></i>
                        <span class="min-w-0 break-words">${dateLines.join('<br>')}</span>
                    </div>`;
        }
        for (const key of displayAttributes) {
            const value = person.attributes[key];
            html += `<div class="text-left break-words" title="${escapeHTML(key)}: ${escapeHTML(value)}">
                        <span class="font-semibold text-slate-700 capitalize">${escapeHTML(key)}:</span> ${escapeHTML(value)}
                    </div>`;
        }
        if (note) {
            html += `<div class="mt-0.5 text-left bg-amber-50 border border-amber-100 rounded-md px-2 py-1.5 whitespace-normal break-words">
                        <span class="font-semibold text-slate-800 capitalize">note:</span> ${escapeHTML(note)}
                    </div>`;
        }
        html += `</div>`;
    }

    html += `</div>`;
    return html;
}

// One rendered DOM card as an SVG fragment, positioned at its real layout
// coordinates. Uses a nested <svg> so overflowing text is clipped to the
// card box, and picks up the live border colour so an active highlight is
// reflected in the export.
export function cardToSvgFragment(card) {
    const x0 = card.offsetLeft, y0 = card.offsetTop;
    const w = card.offsetWidth, h = card.offsetHeight;

    let details = {};
    try { details = JSON.parse(card.getAttribute('data-details') || '{}'); } catch (e) {}

    // Family root: a diamond with its title centred.
    if (card.getAttribute('data-root')) {
        const cx = w / 2, cy = h / 2, r = 66;
        const cs2 = getComputedStyle(card.querySelector('.root-diamond') || card);
        const fill = cs2.backgroundColor && cs2.backgroundColor !== 'rgba(0, 0, 0, 0)' ? cs2.backgroundColor : '#475569';
        let s = `<svg x="${x0}" y="${y0}" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`;
        s += `<polygon points="${cx},${cy - r} ${cx + r},${cy} ${cx},${cy + r} ${cx - r},${cy}" `
           + `fill="${svgEsc(fill)}" stroke="#334155" stroke-width="2"/>`;
        s += `<text x="${cx}" y="${cy + 4}" text-anchor="middle" font-size="12" font-weight="700" `
           + `fill="#ffffff" letter-spacing="0.5">${svgEsc((details.title || 'ROOT').toUpperCase())}</text>`;
        s += `</svg>`;
        return s;
    }
    const attrs = details.attributes || {};
    const name = details.name || 'UNKNOWN';
    const surname = attrs.surname || '';
    const gender = attrs.gender || '';
    const id = details.id != null ? details.id : '';

    const cs = getComputedStyle(card);
    const stroke = cs.borderTopColor || '#cbd5e1';
    const strokeW = parseFloat(cs.borderTopWidth) || 2;
    const radius = parseFloat(cs.borderTopLeftRadius) || 12;

    let s = `<svg x="${x0}" y="${y0}" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">`;
    s += `<rect x="${strokeW / 2}" y="${strokeW / 2}" width="${w - strokeW}" height="${h - strokeW}" `
       + `rx="${radius}" fill="#ffffff" stroke="${svgEsc(stroke)}" stroke-width="${strokeW}"/>`;

    const cx = w / 2, pcy = 16 + 32; // p-4 padding + 32px portrait radius
    s += `<circle cx="${cx}" cy="${pcy}" r="32" fill="#f1f5f9" stroke="#e2e8f0" stroke-width="2"/>`;
    s += `<text x="${cx}" y="${pcy + 7}" text-anchor="middle" font-size="20" font-weight="700" fill="#94a3b8">${svgEsc(initialsOf(name, surname))}</text>`;

    s += `<text x="${w - 8}" y="14" text-anchor="end" font-size="9" `
       + `font-family="ui-monospace, SFMono-Regular, Menlo, monospace" fill="#cbd5e1">#${svgEsc(id)}</text>`;

    let ty = pcy + 32 + 22;
    s += `<text x="${cx}" y="${ty}" text-anchor="middle" font-size="18" font-weight="700" fill="#0f172a">${svgEsc(name)}</text>`;
    if (surname) {
        ty += 20;
        s += `<text x="${cx}" y="${ty}" text-anchor="middle" font-size="15" font-weight="600" fill="#334155">${svgEsc(surname)}</text>`;
    }
    ty += 14;

    const pad = 16;
    const svgGlyph = genderGlyph(gender);
    if (svgGlyph) {
        s += `<text x="${pad}" y="${ty + 11}" font-size="11" fill="#94a3b8">${svgGlyph.sym}</text>`;
        ty += 17;
    }
    for (const key of Object.keys(attrs).filter(k => k !== 'surname' && k !== 'gender')) {
        const label = key.charAt(0).toLocaleUpperCase('tr') + key.slice(1);
        const isNote = key === 'note';
        const lines = wrapToLines(`${label}: ${attrs[key]}`, 30);
        const lh = 13;
        const boxH = lines.length * lh + 7;
        if (isNote) {
            s += `<rect x="${pad - 6}" y="${ty}" width="${w - 2 * (pad - 6)}" height="${boxH}" `
               + `rx="5" fill="#fffbeb" stroke="#fef3c7"/>`;
        }
        lines.forEach((ln, i) => {
            s += `<text x="${pad}" y="${ty + 11 + i * lh}" font-size="11" fill="#475569">${svgEsc(ln)}</text>`;
        });
        ty += boxH + 4;
    }

    s += `</svg>`;
    return s;
}
