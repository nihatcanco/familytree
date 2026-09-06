// Pure helpers with no shared state or app-specific DOM knowledge.

// Escape HTML to prevent XSS and rendering issues.
export function escapeHTML(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// The looser escaper used when building an SVG export string (attribute
// values are always double-quoted there, so `'` needs no escaping).
export function svgEsc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Folds Turkish-specific letters to their closest ASCII equivalent so typing
// plain "i"/"s"/"g"/"u"/"o"/"c" also matches "ı"/"ş"/"ğ"/"ü"/"ö"/"ç".
export function foldTurkish(str) {
    return str
        .toLocaleLowerCase('tr-TR')
        .replace(/ı/g, 'i')
        .replace(/ş/g, 's')
        .replace(/ğ/g, 'g')
        .replace(/ü/g, 'u')
        .replace(/ö/g, 'o')
        .replace(/ç/g, 'c');
}

// Up to two initials for the photo-less avatar: first letter of the first
// given name + first letter of the surname (falling back to the name's
// second letter, then '?').
export function initialsOf(name, surname) {
    const a = (name || '').trim().split(/\s+/)[0] || '';
    const b = (surname || '').trim().split(/\s+/)[0] || '';
    const s = (a.charAt(0) + (b.charAt(0) || a.charAt(1) || '')).toLocaleUpperCase('tr');
    return s || '?';
}

// The ♂ / ♀ glyph and Turkish label for a gender, or null when unknown.
export function genderGlyph(gender) {
    if (gender === 'Male') return { sym: '♂', label: 'Erkek' };
    if (gender === 'Female') return { sym: '♀', label: 'Kadın' };
    return null;
}

// Greedy word-wrap to a character budget, hard-breaking any single word
// that's longer than the line.
export function wrapToLines(text, maxChars) {
    const out = [];
    let cur = '';
    for (const word of String(text).split(/\s+/).filter(Boolean)) {
        let w = word;
        while (w.length > maxChars) {
            if (cur) { out.push(cur); cur = ''; }
            out.push(w.slice(0, maxChars));
            w = w.slice(maxChars);
        }
        if (!cur) cur = w;
        else if ((cur + ' ' + w).length <= maxChars) cur += ' ' + w;
        else { out.push(cur); cur = w; }
    }
    if (cur) out.push(cur);
    return out;
}

// Kick off a client-side file download from a Blob.
export function triggerDownload(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 20000);
}

// 20 birbirinden tamamen farklı ve zıt renk. Renk çemberi 18° adımlarla
// taranır, sonra 7 adımlık kaydırmayla sıralanır; böylece ardışık
// jenerasyonlar ~126° uzak (asla benzemez). Modulo (%) ile 20'den derin
// ağaçlarda başa sararak sınırsız derinlik destekler. Bu tonlar, çizgi
// renklerinden (tree-model.js) daha parlak/açık tutulur ki jenerasyon
// dolgusu ile bağlantı çizgisi karışmasın.
export const generationColors = [
    { hex: '#e04429', rgba: 'rgba(224, 68, 41, 0.3)' },    // 1: Kırmızı-Turuncu
    { hex: '#29e057', rgba: 'rgba(41, 224, 87, 0.3)' },    // 2: Yeşil
    { hex: '#6929e0', rgba: 'rgba(105, 41, 224, 0.3)' },   // 3: Menekşe
    { hex: '#e07b29', rgba: 'rgba(224, 123, 41, 0.3)' },   // 4: Turuncu
    { hex: '#29e08e', rgba: 'rgba(41, 224, 142, 0.3)' },   // 5: Zümrüt
    { hex: '#a029e0', rgba: 'rgba(160, 41, 224, 0.3)' },   // 6: Mor
    { hex: '#e0b329', rgba: 'rgba(224, 179, 41, 0.3)' },   // 7: Kehribar
    { hex: '#29e0c5', rgba: 'rgba(41, 224, 197, 0.3)' },   // 8: Turkuaz
    { hex: '#d729e0', rgba: 'rgba(215, 41, 224, 0.3)' },   // 9: Macenta
    { hex: '#d7e029', rgba: 'rgba(215, 224, 41, 0.3)' },   // 10: Limon Sarısı
    { hex: '#29c5e0', rgba: 'rgba(41, 197, 224, 0.3)' },   // 11: Camgöbeği
    { hex: '#e029b3', rgba: 'rgba(224, 41, 179, 0.3)' },   // 12: Pembe
    { hex: '#a0e029', rgba: 'rgba(160, 224, 41, 0.3)' },   // 13: Limon Yeşili
    { hex: '#298ee0', rgba: 'rgba(41, 142, 224, 0.3)' },   // 14: Mavi
    { hex: '#e0297b', rgba: 'rgba(224, 41, 123, 0.3)' },   // 15: Gül Rengi
    { hex: '#69e029', rgba: 'rgba(105, 224, 41, 0.3)' },   // 16: Ç. Yeşil
    { hex: '#2957e0', rgba: 'rgba(41, 87, 224, 0.3)' },    // 17: Çivit Mavisi
    { hex: '#e02944', rgba: 'rgba(224, 41, 68, 0.3)' },    // 18: Kırmızı
    { hex: '#32e029', rgba: 'rgba(50, 224, 41, 0.3)' },    // 19: Çim Yeşili
    { hex: '#3229e0', rgba: 'rgba(50, 41, 224, 0.3)' }     // 20: Lacivert
];

// Colour object for a 1-based generation number, wrapping (and safe for
// non-positive input).
export function generationColor(gen) {
    const len = generationColors.length;
    return generationColors[(((gen | 0) - 1) % len + len) % len];
}
