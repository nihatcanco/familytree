// Data layer: turns flat person rows (as returned by GET /api/tree) into a
// nested hierarchy, and turns that hierarchy into an absolute-position tidy
// tree layout. No DOM access anywhere in this file — see the inline script
// in index.html for rendering/UI concerns.

export const CARD_WIDTH = 220;
const INLINE_SPOUSE_GAP = 40;   // gap between a person and an inline childless spouse
const COLUMN_GAP = 60;          // gap between a person's column and a spouse-with-children column
// Deliberately much bigger than COLUMN_GAP: a married couple's columns
// should read as one unit, but different children of the same parent
// each head their own branch — often carrying entirely different
// in-law surnames a few generations down — and a small gap makes that
// split look like incidental whitespace rather than an intentional
// "these are separate family lines" boundary.
const SIBLING_GAP = 160;        // gap between different children (family units) of the same parent
const ROOT_GAP = 240;           // gap between independent top-level root trees
export const ROW_GAP = 70;      // vertical gap between generation rows

// Per-independent-root-tree line style (a root is a person with no recorded
// parents; two roots only linked via a marriage further down still each get
// their own style so the connecting cross-tree line is easy to trace).
//
// There are usually far more root trees than colors, so color alone repeats
// and two unrelated families end up looking identical. Each root instead
// gets a (color, stroke-pattern) pair. Within one cycle of 50 roots the
// colors are strongly separated hues (the color wheel walked in golden-angle
// ~137.5° jumps with the tone rotated through 5 lightness/saturation bands,
// so no two consecutive roots look alike); each new cycle both rotates the
// color order (so root 51 is not just "root 1 with dashes") and switches to
// the next, visually louder dash pattern. 50 colors x 5 patterns = 250
// obviously distinct family line styles before anything repeats. These are
// held darker/less saturated than the generation fills in index.html so a
// line never reads as a generation swatch.
const treeLineColors = [
    '#334155', // 1: Arduvaz — near-black, calm (the dominant main tree)
    '#ab602b', // 2
    '#1c926f', // 3
    '#c639c6', // 4
    '#85af1d', // 5
    '#2e548a', // 6
    '#ab2b3b', // 7
    '#1c922f', // 8
    '#7a39c6', // 9
    '#af8b1d', // 10
    '#2e868a', // 11
    '#ab2b80', // 12
    '#48921c', // 13
    '#3945c6', // 14
    '#af3b1d', // 15
    '#2e8a5c', // 16
    '#912bab', // 17
    '#88921c', // 18
    '#3991c6', // 19
    '#af1d4d', // 20
    '#318a2e', // 21
    '#4b2bab', // 22
    '#925c1c', // 23
    '#39c6af', // 24
    '#af1d9d', // 25
    '#638a2e', // 26
    '#2b50ab', // 27
    '#921c1c', // 28
    '#39c663', // 29
    '#731daf', // 30
    '#8a7f2e', // 31
    '#2b95ab', // 32
    '#921c5b', // 33
    '#5cc639', // 34
    '#231daf', // 35
    '#8a4d2e', // 36
    '#2bab7c', // 37
    '#881c92', // 38
    '#a8c639', // 39
    '#1d65af', // 40
    '#8a2e41', // 41
    '#2bab36', // 42
    '#491c92', // 43
    '#c69839', // 44
    '#1dafaa', // 45
    '#8a2e72', // 46
    '#65ab2b', // 47
    '#1c2f92', // 48
    '#c64c39', // 49
    '#1daf5b'  // 50
];

// SVG stroke-dasharray values. '' == solid. Kept coarse and far apart so
// the pattern is readable even on short connector segments.
const treeLineDashes = [
    '',              // solid
    '14 8',          // long dash
    '2 7',           // dotted
    '18 7 2 7',      // dash-dot
    '7 7'            // even dash
];

// Style for the i-th independent root tree.
export function treeLineStyle(i) {
    const n = treeLineColors.length;
    const cycle = Math.floor(i / n);
    // 7 is coprime with 50, so rotating by 7*cycle still visits every color
    // once per cycle while making consecutive cycles look different.
    const color = treeLineColors[(i + cycle * 7) % n];
    const dash = treeLineDashes[cycle % treeLineDashes.length];
    return { color, dash };
}

// Utility: Parse ID lists safely (accepts an array, a JSON-array string, or
// a single bare id, since data can arrive from either the API's arrays or
// legacy flat exports).
function parseIds(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    try { return JSON.parse(value); }
    catch (e) { return [value]; }
}

// A root (a diamond family-origin marker) is a standalone hierarchy node, not
// a person. Its DB id `r` becomes hierarchy/DOM node id `-r` so it never
// collides with a (positive) person id while staying Number()-safe for the
// connector code and `[data-id="-1"]` selectors.
export const rootNodeId = (dbId) => -Math.abs(Number(dbId));
export const isRootNodeId = (id) => Number(id) < 0;
export const rootDbId = (id) => Math.abs(Number(id));

// Transform flat person rows (+ standalone root rows) into the hierarchical
// format the layout and rendering code expects.
export function buildHierarchy(flatData, rootsData = []) {
    const nodeMap = new Map();

    // First pass: create node objects and map them
    flatData.forEach(row => {
        const node = {
            id: row.id,
            name: row.name,
            photoUrl: row.photoUrl,
            attributes: {},
            _parentIds: [],
            _spouseIds: [],
            _visited: false,
            _addedAsChild: false,
            _generation: null,
            // The hierarchy id of the family root this person is a founding
            // member of (negative), or null. Acts as an extra "parent" for
            // generation counting and connector drawing, but is kept out of
            // _parentIds so the edit form's parent pickers ignore it.
            _rootParentId: (row.rootId === null || row.rootId === undefined)
                ? null
                : rootNodeId(row.rootId)
        };

        node._parentIds = parseIds(row.parentIds);
        node._spouseIds = parseIds(row.spouseIds);

        if (row.surname) node.attributes.surname = row.surname;
        if (row.birthplace) node.attributes.birthplace = row.birthplace;
        if (row.birthdate) node.attributes.birthdate = row.birthdate;
        if (row.dateofdeath) node.attributes.dateofdeath = row.dateofdeath;
        if (row.gender === 1) node.attributes.gender = 'Male';
        if (row.gender === 2) node.attributes.gender = 'Female';
        if (row.note) node.attributes.note = row.note;

        nodeMap.set(Number(row.id), node);
    });

    // Second pass: one standalone node per family root. It carries an editable
    // title and a fixed generation (its own row); its founding members hang
    // under it as children.
    rootsData.forEach(r => {
        const id = rootNodeId(r.id);
        nodeMap.set(id, {
            id,
            _isRoot: true,
            title: r.title || 'ROOT',
            name: r.title || 'ROOT',
            photoUrl: null,
            attributes: {},
            _parentIds: [],
            _spouseIds: [],
            _rootParentId: null,
            _visited: false,
            _addedAsChild: false,
            _generation: Math.max(1, Number(r.generation) || 1)
        });
    });

    // Hızlı erişim için çocuk haritası oluşturma (O(1) lookup). Parent edges
    // are real parent/child links plus each founding member -> their root.
    const childMap = new Map();
    const addChild = (parentId, childNode) => {
        const pNum = Number(parentId);
        if (!childMap.has(pNum)) childMap.set(pNum, []);
        childMap.get(pNum).push(childNode);
    };
    nodeMap.forEach(n => {
        n._parentIds.forEach(pid => addChild(pid, n));
        if (n._rootParentId != null && nodeMap.has(n._rootParentId)) addChild(n._rootParentId, n);
    });

    // Kan Bağı Jenerasyon Hesabı (Kahn topolojik sıralaması, sadece ebeveyn/
    // çocuk kenarları — evlilik bağları KATILMAZ). Bu yoğun akraba evliliği
    // olan bir soyağacında şart: biri evlilik yoluyla uzak bir kuzeninin
    // ailesine bağlıysa (örn. birinin eşi aslında ta yukarıdan bir kuzen),
    // eski kod bu evlilik kenarını da "aynı jenerasyon" kısıtı olarak BFS'e
    // katıyordu — BFS hangi yoldan önce ulaşırsa onu kabul ettiğinden, bir
    // kişinin jenerasyonu kendi doğrudan ebeveyninden değil, çok daha uzak
    // (ve genelde daha derin) bir akraba zincirinden sızabiliyordu. Sonuç:
    // doğrudan baba-oğul çiftleri ekranda 2+ satır arayla, sanki dede-torun
    // gibi görünüyordu. Çözüm: her kişinin jenerasyonunu SADECE kendi kan
    // bağı zincirindeki en uzun yoldan hesapla (iki ebeveyni varsa ikisinin
    // de en az bir fazlası); evlilik hizalaması ayrı bir adımda, sadece
    // kaydı ebeveyni OLMAYAN kişiler için uygulanır (aşağıdaki "Eş
    // Jenerasyon Sabitleme").
    const remainingParents = new Map();
    const queue = [];
    nodeMap.forEach(node => {
        let count = node._parentIds.filter(pid => nodeMap.has(Number(pid))).length;
        // A founding member's root counts as a parent, so the member's
        // generation is counted down from the root's fixed generation.
        if (node._rootParentId != null && nodeMap.has(node._rootParentId)) count++;
        remainingParents.set(node.id, count);
        if (count === 0) {
            // Root nodes keep their configured generation; a parentless person
            // with no root seeds the walk at generation 1.
            if (!node._isRoot) node._generation = 1;
            queue.push(node);
        }
    });
    while (queue.length > 0) {
        const current = queue.shift();
        const children = childMap.get(Number(current.id)) || [];
        children.forEach(child => {
            const desired = current._generation + 1;
            if (child._generation === null || desired > child._generation) {
                child._generation = desired;
            }
            const left = remainingParents.get(child.id) - 1;
            remainingParents.set(child.id, left);
            if (left === 0) queue.push(child);
        });
    }
    // Savunma amaçlı: veri hatası yüzünden bir kısır döngü varsa (biri
    // kendi atası gibi görünüyorsa) yukarıdaki kuyruk hiç boşalmayabilir;
    // kalan atanmamış düğümleri 1 olarak işaretleyip devam et.
    nodeMap.forEach(node => {
        if (node._generation === null) node._generation = 1;
    });

    // Eş Jenerasyon Hizalama + Tutarlılık Düzeltmesi (birleşik relaxation)
    // İki kural, tek bir sabit noktaya (fixpoint) ulaşana kadar birlikte
    // uygulanır:
    //   (a) Her çocuğun jenerasyonu, kaydı ebeveyninden en az 1 fazla olmalı.
    //       Bu KOŞULSUZ uygulanır — kan bağı (a) kuralı, (b)'den her zaman
    //       önceliklidir: iki ebeveyn-çocuk çifti asla aynı ya da ters sırada
    //       görünmemeli.
    //   (b) Kaydı ebeveyni OLMAYAN biri (saf "dışarıdan gelin/damat", kendi
    //       soyu bilinmiyor), eşinin jenerasyonuna çekilir. Kaydı ebeveyni
    //       OLAN biri asla bu şekilde çekilmez — aksi halde eşinin çok daha
    //       derin bir soydan gelmesi (örn. uzak kuzen evliliği), bu kişinin
    //       KENDİ ebeveyniyle arasında satır boşluğu açar (Hayrettin-Can
    //       vakası). Sonuç: nadir "kuşak atlayan" evliliklerde eşler farklı
    //       satırda görünebilir — bu, gerçek bir kuşak farkını yansıtır,
    //       hata değildir.
    let changed = true;
    let iterations = 0;
    const maxIterations = nodeMap.size + 5;
    while (changed && iterations < maxIterations) {
        changed = false;
        iterations++;
        nodeMap.forEach(node => {
            if (node._isRoot) return; // a root's generation is fixed by the user
            const anchorIds = node._rootParentId != null
                ? [...node._parentIds, node._rootParentId]
                : node._parentIds;
            anchorIds.forEach(pid => {
                const parent = nodeMap.get(Number(pid));
                if (parent) {
                    const desired = parent._generation + 1;
                    if (node._generation < desired) {
                        node._generation = desired;
                        changed = true;
                    }
                }
            });
            const hasOwnParents = node._parentIds.some(pid => nodeMap.has(Number(pid)));
            // A founding member is anchored to its root; a person whose own
            // ancestry is recorded is anchored to it. Neither is dragged onto
            // a spouse's (possibly much deeper) row.
            const hasAnchor = hasOwnParents || (node._rootParentId != null && nodeMap.has(node._rootParentId));
            if (!hasAnchor) {
                node._spouseIds.forEach(sid => {
                    const spouse = nodeMap.get(Number(sid));
                    if (spouse && spouse._generation !== node._generation) {
                        node._generation = spouse._generation;
                        changed = true;
                    }
                });
            }
        });
    }

    const roots = [];
    // Every standalone root node is an independent top-level tree, kept in the
    // order the server returned them.
    rootsData.forEach(r => {
        const node = nodeMap.get(rootNodeId(r.id));
        if (node) roots.push(node);
    });
    nodeMap.forEach(node => {
        if (node._isRoot) return; // already added above
        // A founding member hangs under its diamond, not at top level.
        if (node._rootParentId != null && nodeMap.has(node._rootParentId)) return;
        // Nodes with no parents, or whose parents don't exist in the dataset, are roots
        const hasExistingParent = node._parentIds.some(pid => nodeMap.has(Number(pid)));
        if (!hasExistingParent) {
            // Prevent nodes that are just spouses of someone with parents from becoming independent roots
            const hasSpouseWithParent = node._spouseIds.some(spouseId => {
                const spouse = nodeMap.get(Number(spouseId));
                return spouse && spouse._parentIds.some(pid => nodeMap.has(Number(pid)));
            });

            if (!hasSpouseWithParent) {
                roots.push(node);
            }
        }
    });

    function buildNode(nodeId, asSpouse = false) {
        const node = nodeMap.get(Number(nodeId));
        if (!node) return null;

        // If already visited, return null to prevent duplication and cycles
        if (node._visited) return null;
        node._visited = true;

        const result = {
            id: node.id,
            _parentIds: node._parentIds,
            _spouseIds: node._spouseIds,
            _generation: node._generation,
            // Kept separate from _parentIds (edit-form parent pickers read that);
            // the renderer folds it into data-parent-ids so the diamond->member
            // connector draws.
            _rootParentId: node._rootParentId,
            _isRoot: !!node._isRoot,
            title: node.title,
            name: node.name,
            photoUrl: node.photoUrl,
            attributes: { ...node.attributes },
            children: [],
            spouses: []
        };

        // 1. Claim direct children first so they fall under the correct parent
        const children = childMap.get(Number(node.id)) || [];
        children.forEach(potentialChild => {
            if (!potentialChild._addedAsChild) {
                potentialChild._addedAsChild = true;
                const childNode = buildNode(potentialChild.id, false);
                if (childNode) result.children.push(childNode);
            }
        });

        // 2. Attach spouses
        if (!asSpouse) {
            node._spouseIds.forEach(spouseId => {
                const spouseNode = buildNode(spouseId, true);
                if (spouseNode) result.spouses.push(spouseNode);
            });
        }
        return result;
    }

    return roots.map(root => buildNode(root.id, false)).filter(Boolean);
}

// --- Tidy-tree layout ---
// Cards are fixed-width (200px) and only vary in height, so the X layout is
// a pure function of the hierarchy (buildHierarchy's output) with no DOM
// measurement needed. The X algorithm is a Reingold-Tilford/Walker-style
// "tidy tree": a parent centers over the midpoint of its immediate children
// (not the full width of its entire subtree), and sibling subtrees are
// packed as tightly as contour comparison allows *at every generation*, not
// just their own row.

// Merge a contour (Map<generation, {min,max}>), shifted by shiftX, into an
// accumulator contour in place.
function mergeContourInto(acc, contour, shiftX) {
    contour.forEach((range, gen) => {
        const min = range.min + shiftX;
        const max = range.max + shiftX;
        const prior = acc.get(gen);
        if (prior) {
            acc.set(gen, { min: Math.min(prior.min, min), max: Math.max(prior.max, max) });
        } else {
            acc.set(gen, { min, max });
        }
    });
}

// Pack a left-to-right sequence of items (each { width, contour }) as
// tightly as contour comparison allows: for each item, find the minimal
// rightward shift so its own contour doesn't overlap everything already
// placed, checked at every generation they share (not just the top row).
function packSiblingsContour(items, desiredGap) {
    const offsets = [];
    const combined = new Map();
    items.forEach((item, i) => {
        let shift = 0;
        if (i > 0) {
            item.contour.forEach((range, gen) => {
                const prior = combined.get(gen);
                if (prior) {
                    const needed = prior.max + desiredGap - range.min;
                    if (needed > shift) shift = needed;
                }
            });
        }
        offsets.push(shift);
        mergeContourInto(combined, item.contour, shift);
    });
    let width = 0;
    combined.forEach(range => { if (range.max > width) width = range.max; });
    return { offsets, contour: combined, width };
}

// Like packSiblingsContour, but packs each item by its FULL bounding box
// (leftmost to rightmost point across every generation it has), never
// letting one item's deeper generations slide in next to another item's
// shallower ones — right for genuinely distinct branches (different
// children of the same parent, or independent root trees).
function packSiblingsBoundingBox(items, desiredGap) {
    const offsets = [];
    const combined = new Map();
    let rightEdge = null;
    items.forEach((item, i) => {
        let itemMin = Infinity;
        let itemMax = -Infinity;
        item.contour.forEach(range => {
            if (range.min < itemMin) itemMin = range.min;
            if (range.max > itemMax) itemMax = range.max;
        });
        const shift = i === 0 ? 0 : (rightEdge + desiredGap - itemMin);
        offsets.push(shift);
        rightEdge = itemMax + shift;
        mergeContourInto(combined, item.contour, shift);
    });
    let width = 0;
    combined.forEach(range => { if (range.max > width) width = range.max; });
    return { offsets, contour: combined, width };
}

// Runs the full X layout over the (possibly pruned) hierarchy. Returns the
// total width needed (in local pixels, pre-zoom) plus fresh lookup maps
// keyed by person id: personLayoutX, personRenderGeneration,
// personRootColor, and spouseAnchorId (inline-childless-spouse id -> the id
// of the main person they're attached to, so a marriage line renders flat
// even when someone has more than one spouse).
export function computeTreeLayout(roots) {
    const personLayoutX = new Map();
    const personRenderGeneration = new Map();
    const personRootColor = new Map();
    const personRootDash = new Map();
    const spouseAnchorId = new Map();

    // One column = one person's own card (+ any inline childless spouses
    // widening it) plus their own children, laid out as family units below.
    // Returns local coordinates (relative to this column's own frame, origin 0).
    function layoutColumn(person) {
        const childUnits = (person.children || []).map(child => layoutFamilyUnit(child));
        const packed = childUnits.length
            ? packSiblingsBoundingBox(childUnits.map(u => ({ width: u.width, contour: u.contour })), SIBLING_GAP)
            : null;

        const inlineSpouses = (person.spouses || []).filter(s => !s.children || s.children.length === 0);
        // The combined row is NOT symmetric around the person's own card: it
        // starts at the person's card and extends rightward through each
        // inline spouse, so its right edge is CARD_WIDTH further per spouse.
        const rowRightExtent = CARD_WIDTH + inlineSpouses.length * (CARD_WIDTH + INLINE_SPOUSE_GAP);
        // Children should hang centered under the whole marriage (this
        // person's card plus any inline spouses), not just this person's own
        // card. This is the offset from ownX to the row's true center.
        const rowCenterOffset = rowRightExtent / 2 - CARD_WIDTH / 2;

        let ownX;
        const contour = new Map();
        if (packed) {
            const firstAnchor = packed.offsets[0] + childUnits[0].anchorX;
            const lastAnchor = packed.offsets[packed.offsets.length - 1] + childUnits[childUnits.length - 1].anchorX;
            const midpoint = (firstAnchor + lastAnchor) / 2;
            const desiredOwnX = midpoint - rowCenterOffset;
            // Don't let the person's own card (or, if shifted left for the
            // centering above, the row) poke past the left edge of the frame.
            const frameShift = Math.max(0, CARD_WIDTH / 2 - desiredOwnX);
            ownX = desiredOwnX + frameShift;
            mergeContourInto(contour, packed.contour, frameShift);
            childUnits.forEach((u, i) => { u.finalOffset = packed.offsets[i] + frameShift; });
        } else {
            ownX = CARD_WIDTH / 2;
        }
        // Safe to set directly (not merge): a child's generation is always
        // strictly greater than its parent's, so this key is never already present.
        contour.set(person._generation, { min: ownX - CARD_WIDTH / 2, max: ownX - CARD_WIDTH / 2 + rowRightExtent });

        const spouseX = new Map();
        let cursor = ownX + CARD_WIDTH / 2;
        inlineSpouses.forEach(spouse => {
            cursor += INLINE_SPOUSE_GAP;
            spouseX.set(spouse.id, cursor + CARD_WIDTH / 2);
            cursor += CARD_WIDTH;
            spouseAnchorId.set(spouse.id, person.id);
        });

        let width = ownX - CARD_WIDTH / 2 + rowRightExtent;
        contour.forEach(r => { if (r.max > width) width = r.max; });

        // rowCenterOffset: distance from ownX (this person's own card center)
        // to the visual center of the whole marriage row (own card + any
        // inline childless spouses extending rightward). A parent centers
        // over this point, not over ownX, so the descent line lands in the
        // middle of the couple rather than above the left partner.
        return { person, ownX, rowCenterOffset, spouseX, childUnits, width, contour };
    }

    // A family unit is one entry in a parent's children[] list: the child's
    // own column plus any of THEIR spouses-with-children, side by side.
    function layoutFamilyUnit(person) {
        const spousesWithChildren = (person.spouses || []).filter(s => s.children && s.children.length > 0);
        const columns = [layoutColumn(person), ...spousesWithChildren.map(s => layoutColumn(s))];
        const packed = columns.length > 1
            ? packSiblingsContour(columns.map(c => ({ width: c.width, contour: c.contour })), COLUMN_GAP)
            : { offsets: [0], contour: columns[0].contour, width: columns[0].width };

        columns.forEach((c, i) => { c.finalOffset = packed.offsets[i]; });

        // Anchor over the visual center of the outermost couples, not their
        // bare card centers: a childless spouse attached inline to the first
        // or last column shifts that column's true center sideways.
        const firstCol = columns[0];
        const lastCol = columns[columns.length - 1];
        const firstX = packed.offsets[0] + firstCol.ownX + (firstCol.rowCenterOffset || 0);
        const lastX = packed.offsets[packed.offsets.length - 1] + lastCol.ownX + (lastCol.rowCenterOffset || 0);
        const anchorX = (firstX + lastX) / 2;

        return { person, columns, anchorX, width: packed.width, contour: packed.contour };
    }

    // Top-down pass: convert the local offsets computed above into absolute
    // page-space X, writing into the lookup maps above.
    function recordColumn(col, originX, rootStyle) {
        personLayoutX.set(col.person.id, originX + col.ownX);
        personRenderGeneration.set(col.person.id, col.person._generation);
        personRootColor.set(col.person.id, rootStyle.color);
        personRootDash.set(col.person.id, rootStyle.dash);
        col.spouseX.forEach((x, spouseId) => {
            personLayoutX.set(spouseId, originX + x);
            // An inline childless spouse has no subtree of their own to keep
            // consistent, so render them on their anchor partner's row.
            personRenderGeneration.set(spouseId, col.person._generation);
            personRootColor.set(spouseId, rootStyle.color);
            personRootDash.set(spouseId, rootStyle.dash);
        });
        col.childUnits.forEach(unit => {
            assignAbsolutePositions(unit, originX + unit.finalOffset, rootStyle);
        });
    }

    function assignAbsolutePositions(familyUnit, originX, rootStyle) {
        familyUnit.columns.forEach(col => {
            recordColumn(col, originX + col.finalOffset, rootStyle);
        });
    }

    if (roots.length === 0) {
        return { totalWidth: 0, personLayoutX, personRenderGeneration, personRootColor, personRootDash, spouseAnchorId };
    }

    const rootUnits = roots.map(r => layoutFamilyUnit(r));
    const packed = rootUnits.length > 1
        ? packSiblingsBoundingBox(rootUnits.map(u => ({ width: u.width, contour: u.contour })), ROOT_GAP)
        : { offsets: [0] };

    rootUnits.forEach((unit, i) => {
        assignAbsolutePositions(unit, packed.offsets[i], treeLineStyle(i));
    });

    let totalWidth = 0;
    rootUnits.forEach((unit, i) => {
        const right = packed.offsets[i] + unit.width;
        if (right > totalWidth) totalWidth = right;
    });

    return { totalWidth, personLayoutX, personRenderGeneration, personRootColor, personRootDash, spouseAnchorId };
}

// Flatten the hierarchy into every rendered person once (each person
// appears exactly once in buildHierarchy's output, as either a child or a
// spouse entry somewhere).
export function collectAllPersons(roots) {
    const result = [];
    function visit(person, isSpouse) {
        result.push({ person, isSpouse });
        (person.children || []).forEach(child => visit(child, false));
        (person.spouses || []).forEach(spouse => visit(spouse, true));
    }
    roots.forEach(r => visit(r, false));
    return result;
}

// For focus mode: keep only people in visibleIds, promoting any visible
// descendant to its own top-level entry when its real ancestor isn't
// visible (rather than dropping it, since there's no DOM nesting to hang
// it from anymore).
export function pruneForFocus(persons, visibleIds) {
    const out = [];
    persons.forEach(person => {
        const childResults = pruneForFocus(person.children || [], visibleIds);
        const spouseResults = (person.spouses || [])
            .filter(s => visibleIds.has(s.id))
            .map(s => ({ ...s, children: pruneForFocus(s.children || [], visibleIds) }));
        if (visibleIds.has(person.id)) {
            out.push({ ...person, children: childResults, spouses: spouseResults });
        } else {
            out.push(...childResults);
            spouseResults.forEach(s => { if (s.children.length) out.push(s); });
        }
    });
    return out;
}

// Depth-first search for a node by id across the full hierarchy (a person
// can appear as a child entry or a spouse entry of another node).
export function findPersonNode(nodes, id) {
    for (const node of (nodes || [])) {
        if (Number(node.id) === Number(id)) return node;
        const childHit = findPersonNode(node.children, id);
        if (childHit) return childHit;
        const spouseHit = findPersonNode(node.spouses, id);
        if (spouseHit) return spouseHit;
    }
    return null;
}
