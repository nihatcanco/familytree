import { getTree, updatePerson, createPerson, deletePerson, createRoot, updateRoot, deleteRoot,
         getMe, login, logout, changeMyPassword, listUsers, createUser, updateUser, deleteUser } from './api.js';
import {
    CARD_WIDTH, ROW_GAP, rootNodeId, rootDbId,
    buildHierarchy, computeTreeLayout, collectAllPersons, pruneForFocus, findPersonNode
} from './tree-model.js';
import { createIcons } from './icons.js';
import {
    escapeHTML, foldTurkish, genderGlyph, initialsOf, wrapToLines, svgEsc,
    triggerDownload, generationColors
} from './util.js';
import { generateCardHTML, cardToSvgFragment } from './card-view.js';
import { startTour } from './tour.js';

    document.addEventListener('DOMContentLoaded', () => {

        // Setup global error handling so you don't have to check the console
        window.onerror = function(message, source, lineno, colno, error) {
            const errDiv = document.getElementById('error-overlay');
            const errTxt = document.getElementById('error-text');
            if(errDiv && errTxt) {
                errDiv.classList.remove('hidden');
                errTxt.textContent = `System Error: ${message}`;
            }
            return false;
        };

        // DOM Elements
        const errorOverlay = document.getElementById('error-overlay');
        const errorText = document.getElementById('error-text');
        const treeRoot = document.getElementById('tree-root');
        const treeTransform = document.getElementById('tree-transform');
        const scrollContainer = document.getElementById('scroll-container');
        
        const btnZoomIn = document.getElementById('btn-zoom-in');
        const btnZoomOut = document.getElementById('btn-zoom-out');
        const btnZoomReset = document.getElementById('btn-zoom-reset');
        const btnFocus = document.getElementById('btn-focus');

        const btnRelationship = document.getElementById('btn-relationship');
        const relationshipStatus = document.getElementById('relationship-status');
        const relationshipInstr = document.getElementById('relationship-instr');
        const relationshipChain = document.getElementById('relationship-chain');
        const btnRelationshipCancel = document.getElementById('btn-relationship-cancel');

        const searchInput = document.getElementById('search-input');
        const btnSearchClear = document.getElementById('btn-search-clear');
        const btnSearchPrev = document.getElementById('btn-search-prev');
        const btnSearchNext = document.getElementById('btn-search-next');

        const personDetailsPanel = document.getElementById('person-details-panel');
        const personDetailsContent = document.getElementById('person-details-content');
        const btnCloseDetails = document.getElementById('btn-close-details');
        const btnEditDetails = document.getElementById('btn-edit-details');
        const btnDeleteDetails = document.getElementById('btn-delete-details');
        const btnAddPerson = document.getElementById('btn-add-person');
        const btnExportPng = document.getElementById('btn-export-png');

        const generationLegend = document.getElementById('generation-legend');
        const legendList = document.getElementById('legend-list');

        const minimapWrapper = document.getElementById('minimap-wrapper');
        const minimapContainer = document.getElementById('minimap-container');
        const minimapCanvas = document.getElementById('minimap-canvas');
        const minimapViewport = document.getElementById('minimap-viewport');

        // Auth / admin panel elements
        const loginOverlay = document.getElementById('login-overlay');
        const loginForm = document.getElementById('login-form');
        const loginUsername = document.getElementById('login-username');
        const loginPassword = document.getElementById('login-password');
        const loginError = document.getElementById('login-error');
        const btnLoginSubmit = document.getElementById('btn-login-submit');

        const appTreeArea = document.getElementById('app-tree-area');
        const appSidebar = document.getElementById('app-sidebar');
        const btnSidebarToggle = document.getElementById('btn-sidebar-toggle');
        const sidebarBackdrop = document.getElementById('sidebar-backdrop');
        const currentUserBadge = document.getElementById('current-user-badge');
        const btnLogout = document.getElementById('btn-logout');
        const btnHelpTour = document.getElementById('btn-help-tour');

        const btnChangePassword = document.getElementById('btn-change-password');
        const changePasswordOverlay = document.getElementById('change-password-overlay');
        const changePasswordForm = document.getElementById('change-password-form');
        const changePasswordCurrent = document.getElementById('change-password-current');
        const changePasswordNew = document.getElementById('change-password-new');
        const changePasswordConfirm = document.getElementById('change-password-confirm');
        const changePasswordError = document.getElementById('change-password-error');
        const changePasswordSuccess = document.getElementById('change-password-success');
        const btnChangePasswordClose = document.getElementById('btn-change-password-close');
        const btnChangePasswordSubmit = document.getElementById('btn-change-password-submit');

        const btnAdminPanel = document.getElementById('btn-admin-panel');
        const adminPanelOverlay = document.getElementById('admin-panel-overlay');
        const btnAdminPanelClose = document.getElementById('btn-admin-panel-close');
        const adminUserList = document.getElementById('admin-user-list');
        const adminAddError = document.getElementById('admin-add-error');
        const adminNewUsername = document.getElementById('admin-new-username');
        const adminNewPassword = document.getElementById('admin-new-password');
        const adminNewRole = document.getElementById('admin-new-role');
        const adminNewPerson = document.getElementById('admin-new-person');
        const btnAdminAddUser = document.getElementById('btn-admin-add-user');

        // State
        let currentZoom = 1;
        let isFocusMode = false;
        // Focus modunda en son merkeze alınan kişinin id'si — focus'tan
        // çıkınca o kişiye geri kaydırmak için kullanılır (panel kapatılıp
        // .highlighted sınıfı silinse bile çalışır).
        let lastFocusSelfId = null;
        // "İki kişi arası bağ" feature: null | 'picking' (choosing the two
        // people) | 'showing' (the connecting path is rendered focus-style).
        let relationshipMode = null;
        let relPick1 = null;
        let relPick2 = null;
        let searchResults = [];
        let currentSearchIndex = -1;
        let originalRoots = []; // full (unfocused) hierarchy, rebuilt on every load/save

        // collectAllPersons() walks the whole hierarchy; several UI paths call
        // it repeatedly per interaction (option lists, labels, bloodline, the
        // relationship graph). Cache the flattened list and only rebuild it
        // when originalRoots is reassigned.
        let _allPersonsCacheKey = null;
        let _allPersonsCache = [];
        function allPersons() {
            if (_allPersonsCacheKey !== originalRoots) {
                _allPersonsCacheKey = originalRoots;
                _allPersonsCache = collectAllPersons(originalRoots);
            }
            return _allPersonsCache;
        }
        // The id of whichever person is currently shown in the details panel,
        // so the Edit/Save flow knows which tree node to update.
        let currentDetailsPersonId = null;
        // Set from /api/me right after login; gates the Edit/Delete/Add
        // buttons client-side (the server enforces this independently on
        // every write, so this is UX polish, not the security boundary).
        let currentUserRole = 'viewer';
        let currentUserId = null;
        let currentUserPersonId = null;
        function canEditTree() { return currentUserRole === 'admin' || currentUserRole === 'editor'; }

        // Tidy-tree layout output, keyed by person id. Recomputed by
        // computeTreeLayout() on every render (initial load + focus toggle).
        let personLayoutX = new Map();
        let personRenderGeneration = new Map();
        let personRootColor = new Map();
        // person id -> SVG stroke-dasharray for their family's lines ('' = solid).
        // Pairs with personRootColor so each root tree's connectors are unique
        // even once the 50-color palette wraps.
        let personRootDash = new Map();
        // Inline-childless-spouse id -> the id of the main person they're
        // attached to. When someone has more than one spouse (e.g. Abdülhakim
        // with Sıdıka and Nezihe), every marriage line in that row anchors to
        // the SAME person's own box center, so the whole row reads as one flat
        // line instead of stair-stepping to each spouse's own (differently
        // sized) card.
        let spouseAnchorId = new Map();

        // Initialize Lucide Icons on load
        createIcons();

        // --- Build/version stamp in the sidebar footer ---
        // /version.json is rewritten by Jenkins on every deploy (see the
        // "Stamp version" stage in the Jenkinsfile). The copy committed to the
        // repo has build "dev", which just shows "yerel geliştirme".
        (async () => {
            const el = document.getElementById('app-version');
            if (!el) return;
            try {
                const res = await fetch('version.json', { cache: 'no-store' });
                if (!res.ok) throw new Error(res.status);
                const v = await res.json();
                el.textContent = v.build === 'dev'
                    ? 'dev build'
                    : `build ${v.build}`/* + (v.commit ? ` · ${v.commit}` : '')*/;
                if (v.builtAt) {
                    const d = new Date(v.builtAt);
                    if (!isNaN(d)) el.title = `Derleme: ${d.toLocaleString('tr-TR')}`;
                }
            } catch {
                el.textContent = '';
            }
        })();

        // --- Responsive: tools drawer + person-details bottom sheet (phone / tablet) ---
        // Below the CSS breakpoint the right rail splits in two:
        //   * the TOOLS become a right-edge drawer that only opens on an
        //     explicit tap of the floating button (or the tour / a finished
        //     relationship pick) — never as a side effect of tapping a card;
        //   * the PERSON DETAILS panel becomes a bottom sheet that slides up
        //     over the canvas (showPersonPanel / hidePersonPanel below).
        // On wide screens the rail is a normal flex column and all of this is
        // inert — the transform/sheet classes have no rules outside the media
        // query and the backdrop stays display:none.
        const mqNarrow = window.matchMedia('(max-width: 900px)');
        const isNarrow = () => mqNarrow.matches;

        function openToolsDrawer() {
            appSidebar.classList.add('ft-drawer-open');
            if (sidebarBackdrop) sidebarBackdrop.classList.add('show');
            // The minimap / legend were off-screen with no usable size; redraw
            // once the slide-in transition has settled.
            setTimeout(() => drawMinimap(), 280);
        }
        function closeToolsDrawer() {
            appSidebar.classList.remove('ft-drawer-open');
            if (sidebarBackdrop) sidebarBackdrop.classList.remove('show');
        }
        function toggleToolsDrawer() {
            if (appSidebar.classList.contains('ft-drawer-open')) closeToolsDrawer();
            else openToolsDrawer();
        }
        if (btnSidebarToggle) btnSidebarToggle.addEventListener('click', toggleToolsDrawer);
        if (sidebarBackdrop) sidebarBackdrop.addEventListener('click', closeToolsDrawer);

        // Every view/edit/close path for the details panel goes through these
        // two, so the desktop panel and the mobile sheet stay in one code path.
        let _panelHideTimer = null;
        function showPersonPanel() {
            clearTimeout(_panelHideTimer);
            personDetailsPanel.classList.remove('hidden');
            personDetailsPanel.classList.add('flex');
            if (isNarrow()) {
                closeToolsDrawer();               // the sheet and the drawer never coexist
                document.body.classList.add('ft-sheet-open');
                void personDetailsPanel.offsetWidth; // flush the off-screen start state
                personDetailsPanel.classList.add('ft-sheet-open');
            }
        }
        function hidePersonPanel() {
            document.body.classList.remove('ft-sheet-open');
            personDetailsPanel.classList.remove('ft-sheet-open');
            if (isNarrow()) {
                // let the sheet slide back down before it's display:none'd
                _panelHideTimer = setTimeout(() => {
                    personDetailsPanel.classList.add('hidden');
                    personDetailsPanel.classList.remove('flex');
                }, 260);
            } else {
                personDetailsPanel.classList.add('hidden');
                personDetailsPanel.classList.remove('flex');
            }
        }

        mqNarrow.addEventListener('change', () => {
            if (!isNarrow()) {
                closeToolsDrawer();
                document.body.classList.remove('ft-sheet-open');
                personDetailsPanel.classList.remove('ft-sheet-open');
            }
            drawMinimap();
        });



        // Measures each currently-rendered card's natural height, groups by its
        // render generation, and places every card at the cumulative Y for that
        // generation. Safe to call repeatedly (e.g. on resize) without recomputing X.
        function remeasureY() {
            const cards = Array.from(document.querySelectorAll('.tree-node-card[data-id]'));
            if (cards.length === 0) {
                treeRoot.style.height = '0px';
                return;
            }

            const genRowHeight = {};
            const cardGen = new Map();
            cards.forEach(card => {
                const id = Number(card.getAttribute('data-id'));
                const gen = personRenderGeneration.get(id);
                if (gen === undefined) return;
                cardGen.set(card, gen);
                const h = card.offsetHeight;
                if (!genRowHeight[gen] || h > genRowHeight[gen]) genRowHeight[gen] = h;
            });

            const gens = Object.keys(genRowHeight).map(Number).sort((a, b) => a - b);
            const cumulativeY = {};
            let y = 0;
            gens.forEach(g => {
                cumulativeY[g] = y;
                y += genRowHeight[g] + ROW_GAP;
            });
            const totalHeight = y > 0 ? y - ROW_GAP : 0;

            cards.forEach(card => {
                const gen = cardGen.get(card);
                if (gen === undefined) return;
                card.style.top = cumulativeY[gen] + 'px';
            });

            treeRoot.style.height = totalHeight + 'px';
        }

        // Resolves once Tailwind has actually applied its utility-class CSS to
        // freshly-inserted cards. Tailwind's CDN build (<script src=
        // "cdn.tailwindcss.com">) injects utility-class rules asynchronously — a
        // MutationObserver reacts to this innerHTML swap — so cards can report
        // the wrong (unstyled) size/position if measured too soon. How long that
        // takes varies by browser and by how many new elements just landed (535
        // cards at once): one animation frame is enough in some browsers but not
        // reliably in others (confirmed: Safari needed more than the single rAF
        // this used to wait), so poll actual computed style instead of guessing
        // a fixed frame count — wait until a known utility class's effect
        // (w-[220px]) is actually visible on a real card, with a generous cap so
        // a genuine failure doesn't hang forever.
        function waitForCardStyles() {
            return new Promise(resolve => {
                let attempts = 0;
                function check() {
                    const card = treeRoot.querySelector('.tree-node-card');
                    attempts++;
                    const expectedWidth = CARD_WIDTH * currentZoom;
                    if (!card || Math.abs(card.getBoundingClientRect().width - expectedWidth) < 1 || attempts > 120) {
                        resolve();
                    } else {
                        requestAnimationFrame(check);
                    }
                }
                requestAnimationFrame(check);
            });
        }

        // Re-attached on every render since it needs to observe whatever cards
        // currently exist — a fresh set after each full re-render (initial load,
        // focus mode toggling).
        let activeResizeObserver = null;
        function attachResizeObserver() {
            if (activeResizeObserver) activeResizeObserver.disconnect();
            let resizeTimeout = null;
            activeResizeObserver = new ResizeObserver(() => {
                if (resizeTimeout) clearTimeout(resizeTimeout);
                resizeTimeout = setTimeout(() => {
                    remeasureY();
                    drawCrossTreeLinks();
                    drawMinimap();
                }, 50);
            });
            document.querySelectorAll('.tree-node-card').forEach(card => activeResizeObserver.observe(card));
        }

        // Full render pipeline: compute X layout, emit flat absolutely-positioned
        // cards, apply X, measure+apply Y, size the container, draw connectors.
        async function renderTreeFromHierarchy(roots) {
            const layout = computeTreeLayout(roots);
            const { totalWidth } = layout;
            personLayoutX = layout.personLayoutX;
            personRenderGeneration = layout.personRenderGeneration;
            personRootColor = layout.personRootColor;
            personRootDash = layout.personRootDash;
            spouseAnchorId = layout.spouseAnchorId;

            const persons = collectAllPersons(roots);
            const peopleCountEl = document.getElementById('people-count');
            if (peopleCountEl) peopleCountEl.textContent = `${persons.filter(({ person }) => !person._isRoot).length} kişi`;
            let html = '';
            persons.forEach(({ person, isSpouse }) => { html += generateCardHTML(person, isSpouse); });
            treeRoot.innerHTML = html;
            createIcons();

            document.querySelectorAll('.tree-node-card[data-id]').forEach(card => {
                const id = Number(card.getAttribute('data-id'));
                const x = personLayoutX.get(id);
                if (x !== undefined) card.style.left = (x - CARD_WIDTH / 2) + 'px';
            });

            treeRoot.style.width = totalWidth + 'px';

            // Wait for Tailwind to finish styling the new cards (see
            // waitForCardStyles's comment) before measuring heights — otherwise
            // row heights, Y positions, and every connector line get computed
            // against temporarily-unstyled (wrong) card sizes and never get
            // corrected.
            await waitForCardStyles();

            remeasureY();
            drawCrossTreeLinks();
            attachResizeObserver();
            refreshSearchAfterRender();
        }

        // --- Cross Tree Linking Logic ---
        // Every connector (parent-child descent + spouse marriage line) is
        // rendered as strictly orthogonal straight segments: a vertical drop, a
        // horizontal run, a vertical drop. No arcs and no "wire hop" bumps at
        // crossings. Segments from DIFFERENT families that would otherwise run
        // collinear on top of each other do get pulled a few pixels apart (see
        // separateCollinearOverlaps) so two distinct edges don't read as one;
        // shared sibling buses within one family stay stacked as a single bus.
        function queueCrossLink(pending, x1, y1, x2, y2, type, color = '#94a3b8', sharedMidY = null, isGlowing = false, dash = '') {
            pending.push({ x1, y1, x2, y2, type, color, sharedMidY, isGlowing, dash });
        }

        function pointsForLineDef(line) {
            const { x1, y1, x2, y2, type, sharedMidY } = line;
            if (type === 'parent-child') {
                const midY = sharedMidY !== null && sharedMidY !== undefined ? sharedMidY : (y1 + y2) / 2;
                return [[x1, y1], [x1, midY], [x2, midY], [x2, y2]];
            }
            const midX = (x1 + x2) / 2;
            return [[x1, y1], [midX, y1], [midX, y2], [x2, y2]];
        }

        function segmentsFromPoints(points) {
            const segs = [];
            for (let i = 0; i < points.length - 1; i++) {
                const [px1, py1] = points[i];
                const [px2, py2] = points[i + 1];
                if (px1 === px2 && py1 === py2) continue;
                segs.push({ x1: px1, y1: py1, x2: px2, y2: py2, orientation: py1 === py2 ? 'h' : 'v' });
            }
            return segs;
        }

        const COLLINEAR_AXIS_EPS = 2;      // coords this close count as the same gridline
        const COLLINEAR_MIN_OVERLAP = 8;   // shorter shared runs aren't worth splitting
        const COLLINEAR_SEP = 5;           // perpendicular gap between the separated parallel lines

        // Pull apart segments from DIFFERENT families that run collinear and
        // overlap — two verticals sharing an X, or two horizontals sharing a Y —
        // since drawn on top of each other they read as a single stroke and hide
        // that two distinct edges are there. Staggering is by distinct FAMILY
        // colour, never by distinct line: all the sibling connectors hanging off
        // one parent share a colour and are meant to sit on one flat "bus", so
        // they stay stacked. Only genuinely different families get pried a few
        // pixels off each other. Mutates lineSegs in place, translating a whole
        // segment perpendicular and dragging its elbow neighbours' shared
        // endpoints along, so every path stays connected and strictly orthogonal.
        function separateCollinearOverlaps(lines, lineSegs) {
            const shiftSeg = (segs, si, dx, dy) => {
                segs[si].x1 += dx; segs[si].y1 += dy;
                segs[si].x2 += dx; segs[si].y2 += dy;
                if (si > 0) { segs[si - 1].x2 += dx; segs[si - 1].y2 += dy; }
                if (si < segs.length - 1) { segs[si + 1].x1 += dx; segs[si + 1].y1 += dy; }
            };

            ['h', 'v'].forEach(orientation => {
                const items = [];
                for (let li = 0; li < lineSegs.length; li++) {
                    for (let si = 0; si < lineSegs[li].length; si++) {
                        const s = lineSegs[li][si];
                        if (s.orientation !== orientation) continue;
                        const axis = orientation === 'h' ? s.y1 : s.x1;
                        const lo = orientation === 'h' ? Math.min(s.x1, s.x2) : Math.min(s.y1, s.y2);
                        const hi = orientation === 'h' ? Math.max(s.x1, s.x2) : Math.max(s.y1, s.y2);
                        if (hi - lo < COLLINEAR_MIN_OVERLAP) continue;
                        items.push({ li, si, axis, lo, hi });
                    }
                }
                items.sort((a, b) => a.axis - b.axis || a.lo - b.lo);

                let bucketStart = 0;
                const flushBucket = (end) => {
                    const bucket = items.slice(bucketStart, end);
                    bucketStart = end;
                    if (bucket.length < 2) return;
                    let cluster = [bucket[0]];
                    let clusterMax = bucket[0].hi;
                    const flushCluster = () => {
                        const byLine = new Map();
                        cluster.forEach(it => {
                            if (!byLine.has(it.li)) byLine.set(it.li, []);
                            byLine.get(it.li).push(it);
                        });
                        if (byLine.size < 2) return;
                        const lineIds = [...byLine.keys()].sort((a, b) => a - b);
                        const colorIndex = new Map();
                        lineIds.forEach(id => {
                            const c = lines[id].color;
                            if (!colorIndex.has(c)) colorIndex.set(c, colorIndex.size);
                        });
                        if (colorIndex.size < 2) return; // one family: leave the trunk stacked
                        lineIds.forEach(id => {
                            const k = colorIndex.get(lines[id].color);
                            if (k === 0) return; // anchor the first family, stagger the rest
                            const step = Math.ceil(k / 2) * COLLINEAR_SEP * (k % 2 === 1 ? 1 : -1);
                            byLine.get(id).forEach(it => {
                                if (orientation === 'h') shiftSeg(lineSegs[id], it.si, 0, step);
                                else shiftSeg(lineSegs[id], it.si, step, 0);
                            });
                        });
                    };
                    for (let i = 1; i < bucket.length; i++) {
                        if (bucket[i].lo <= clusterMax - COLLINEAR_MIN_OVERLAP) {
                            cluster.push(bucket[i]);
                            clusterMax = Math.max(clusterMax, bucket[i].hi);
                        } else {
                            flushCluster();
                            cluster = [bucket[i]];
                            clusterMax = bucket[i].hi;
                        }
                    }
                    flushCluster();
                };
                for (let i = 1; i < items.length; i++) {
                    if (items[i].axis - items[bucketStart].axis > COLLINEAR_AXIS_EPS) flushBucket(i);
                }
                flushBucket(items.length);
            });
        }

        function renderQueuedLinks(svg, lines) {
            const lineSegs = lines.map(line => segmentsFromPoints(pointsForLineDef(line)));
            separateCollinearOverlaps(lines, lineSegs);
            // Snap every endpoint to whole pixels. Card-header-centre math
            // yields half-pixel Y values, and a 2px stroke on a *.5 coordinate
            // straddles two rows of pixels — it renders as a soft, ~1px-tall
            // blur. Where such a blurry horizontal meets a crisp vertical the
            // eye reads the fuzz as a little diagonal kink in the line. Rounding
            // is uniform, so shared segment endpoints stay coincident (lines
            // remain connected and strictly orthogonal).
            lineSegs.forEach(segs => segs.forEach(seg => {
                seg.x1 = Math.round(seg.x1); seg.y1 = Math.round(seg.y1);
                seg.x2 = Math.round(seg.x2); seg.y2 = Math.round(seg.y2);
            }));
            lines.forEach((line, li) => {
                const segs = lineSegs[li];
                let d = '';
                segs.forEach((seg, si) => {
                    if (si === 0) d += `M ${seg.x1},${seg.y1} `;
                    d += `L ${seg.x2},${seg.y2} `;
                });

                const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                path.setAttribute('d', d.trim());
                path.setAttribute('stroke', line.color);
                path.setAttribute('fill', 'none');
                // Per-family dash pattern (see treeLineStyle). Dropped on a
                // highlighted bloodline — that path reads best as one solid glow.
                // Dashed families are drawn a touch heavier with round caps so
                // the pattern (and especially the dots) stays obvious.
                if (line.dash && !line.isGlowing) {
                    path.setAttribute('stroke-width', '2.5');
                    path.setAttribute('stroke-dasharray', line.dash);
                    path.setAttribute('stroke-linecap', 'round');
                } else {
                    path.setAttribute('stroke-width', '2');
                }
                if (line.isGlowing) path.classList.add('svg-glow-line');
                svg.appendChild(path);

                // Small dot in the line's own colour where each connector meets
                // a person card, so it's clear which line belongs to whom. The
                // card-touching points are the very first and very last point of
                // the (already separated + pixel-snapped) segment chain.
                if (segs.length) {
                    const ends = [
                        { x: segs[0].x1, y: segs[0].y1 },
                        { x: segs[segs.length - 1].x2, y: segs[segs.length - 1].y2 },
                    ];
                    ends.forEach(({ x, y }) => {
                        const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                        dot.setAttribute('cx', x);
                        dot.setAttribute('cy', y);
                        dot.setAttribute('r', line.isGlowing ? '3.5' : '3');
                        dot.setAttribute('fill', line.color);
                        svg.appendChild(dot);
                    });
                }
            });
        }

        // Draws every connector line (parent-child descent + spouse marriage
        // lines) as an SVG path from the currently-rendered cards' real positions.
        // Since cards are absolutely positioned (no DOM nesting), every edge needs
        // an explicit line — there's no "already adjacent in the DOM" case to skip.
        function drawCrossTreeLinks() {
            const svg = document.getElementById('cross-tree-links');
            if (!svg || !treeTransform) return;

            svg.innerHTML = '';

            const treeRect = treeTransform.getBoundingClientRect();
            if (currentZoom <= 0 || treeRect.width === 0) return;

            const nodeElements = {};
            document.querySelectorAll('.tree-node-card[data-id]').forEach(card => {
                nodeElements[card.getAttribute('data-id')] = card;
            });

            // Batch read bounding boxes to prevent layout thrashing and keep performance high
            const nodeRects = {};
            const nodeHeaderRects = {};
            Object.values(nodeElements).forEach(card => {
                const id = card.getAttribute('data-id');
                nodeRects[id] = card.getBoundingClientRect();
                const header = card.querySelector('.card-header');
                nodeHeaderRects[id] = header ? header.getBoundingClientRect() : nodeRects[id];
            });

            // The lowest point occupied by any card in each generation's row.
            // Rows are top-aligned but not height-uniform (remeasureY sizes each
            // row to its tallest card, e.g. one sibling with a long Note), so a
            // parent-child trunk must clear the whole row's bottom — not just the
            // specific parent card's own (possibly much shorter) bottom — or the
            // horizontal bar can land inside a taller sibling card in the same row.
            const genRowBottom = {};
            Object.values(nodeElements).forEach(card => {
                const id = Number(card.getAttribute('data-id'));
                const gen = personRenderGeneration.get(id);
                if (gen === undefined) return;
                const rect = nodeRects[card.getAttribute('data-id')];
                if (!rect || rect.width === 0 || rect.height === 0) return;
                const bottom = (rect.bottom - treeRect.top) / currentZoom;
                if (genRowBottom[gen] === undefined || bottom > genRowBottom[gen]) genRowBottom[gen] = bottom;
            });

            const drawnSpouseLines = new Set();
            const pendingLines = [];

            const getCenter = (rect) => ({
                x: (rect.left - treeRect.left) / currentZoom + rect.width / 2 / currentZoom,
                y: (rect.top - treeRect.top) / currentZoom + rect.height / 2 / currentZoom
            });
            // Left / right edge x of a card in local (pre-zoom) space, so a
            // marriage line can attach to the near side-center of each card
            // instead of running out of the card's hidden middle.
            const getEdgeX = (rect) => ({
                left: (rect.left - treeRect.left) / currentZoom,
                right: (rect.right - treeRect.left) / currentZoom
            });
            // The x where a spouse line should touch each card: the two facing
            // edges (left card's right edge, right card's left edge).
            const marriageEndpoints = (rectA, rectB) => {
                const cAx = getCenter(rectA).x;
                const cBx = getCenter(rectB).x;
                const eA = getEdgeX(rectA);
                const eB = getEdgeX(rectB);
                return cAx <= cBx
                    ? { ax: eA.right, bx: eB.left }
                    : { ax: eA.left, bx: eB.right };
            };
            // Vertical center of a card's fixed-height header (portrait + name
            // + ID) rather than the whole card — the card's overall height
            // varies with how much attribute/Note text it has below the
            // header, so anchoring a horizontal line to the full-card center
            // would pull it down into that variable text for a card with a
            // long Note while a short sibling's line stays near the top.
            const getHeaderCenterY = (id) => {
                const rect = nodeHeaderRects[id];
                return (rect.top - treeRect.top) / currentZoom + rect.height / 2 / currentZoom;
            };
            const isGlowCard = (c) => c.classList.contains('highlighted') || c.classList.contains('highlighted-gen') || c.classList.contains('highlighted-spouse');
            // When one of this pair is recorded as an inline spouse of the
            // other (see spouseAnchorId), anchor the marriage line to the
            // anchor's own header center for both endpoints, so someone with
            // multiple spouses (e.g. Abdülhakim with Sıdıka and Nezihe) gets
            // one flat line across the whole row instead of stair-stepping
            // to each spouse's own, differently-sized card. Falls back to
            // null (caller uses each side's own center) for the rarer case
            // of two peer "spouse-with-children" columns with no anchor.
            const getMarriageLineY = (aId, bId) => {
                if (spouseAnchorId.get(Number(bId)) === Number(aId)) return getHeaderCenterY(aId);
                if (spouseAnchorId.get(Number(aId)) === Number(bId)) return getHeaderCenterY(bId);
                return null;
            };

            // Someone with 2+ inline spouses (e.g. Abdülhakim with Sıdıka and
            // Nezihe) is laid out as one flat row of cards. Drawing
            // "anchor -> every spouse" would make the line to the farther
            // spouse retrace the exact same path as the line to the nearer
            // one (both start at the anchor, same Y), so the nearer spouse's
            // own card ends up sitting on top of the farther spouse's line.
            // Instead chain only adjacent cards in on-screen left-to-right
            // order — anchor -> nearest spouse -> next spouse -> ... — so
            // every drawn segment touches a card only at its own endpoints,
            // and mark every pair within the group as handled so the normal
            // per-card loop below doesn't also draw the redundant direct ones.
            const anchorGroups = new Map();
            spouseAnchorId.forEach((anchorId, spouseId) => {
                if (!anchorGroups.has(anchorId)) anchorGroups.set(anchorId, []);
                anchorGroups.get(anchorId).push(spouseId);
            });
            anchorGroups.forEach((spouseIds, anchorId) => {
                if (spouseIds.length < 2) return;
                const anchorKey = String(anchorId);
                const anchorRect = nodeRects[anchorKey];
                if (!anchorRect || anchorRect.width === 0) return;

                const members = [{ id: anchorKey, x: getCenter(anchorRect).x, rect: anchorRect }];
                spouseIds.forEach(sId => {
                    const sKey = String(sId);
                    const sRect = nodeRects[sKey];
                    if (!sRect || sRect.width === 0) return;
                    members.push({ id: sKey, x: getCenter(sRect).x, rect: sRect });
                });
                members.sort((a, b) => a.x - b.x);

                for (let i = 0; i < members.length; i++) {
                    for (let j = i + 1; j < members.length; j++) {
                        drawnSpouseLines.add([members[i].id, members[j].id].sort().join('-'));
                    }
                }

                const anchorHeaderY = getHeaderCenterY(anchorKey);
                const lineColor = personRootColor.get(Number(anchorId)) || '#94a3b8';
                const lineDash = personRootDash.get(Number(anchorId)) || '';
                for (let i = 0; i < members.length - 1; i++) {
                    const a = members[i], b = members[i + 1];
                    const aCard = nodeElements[a.id], bCard = nodeElements[b.id];
                    const isGlowing = isGlowCard(aCard) && isGlowCard(bCard);
                    const { ax, bx } = marriageEndpoints(a.rect, b.rect);
                    queueCrossLink(pendingLines, ax, anchorHeaderY, bx, anchorHeaderY, 'spouse', lineColor, null, isGlowing, lineDash);
                }
            });

            Object.values(nodeElements).forEach(card => {
                const id = card.getAttribute('data-id');
                const cardRect = nodeRects[id];
                if (!cardRect || cardRect.width === 0 || cardRect.height === 0) return;

                const center = getCenter(cardRect);

                // Spouse (marriage) line — one per unique pair.
                const spouseIds = card.getAttribute('data-spouse-ids');
                if (spouseIds) {
                    spouseIds.split(',').forEach(sId => {
                        if (!sId) return;
                        const lineKey = [id, sId].sort().join('-');
                        if (drawnSpouseLines.has(lineKey)) return;

                        const spouseCard = nodeElements[sId];
                        if (!spouseCard) return;
                        drawnSpouseLines.add(lineKey);

                        const sRect = nodeRects[sId];
                        if (!sRect || sRect.width === 0 || sRect.height === 0) return;

                        const sharedY = getMarriageLineY(id, sId);
                        const myLineY = sharedY !== null ? sharedY : getHeaderCenterY(id);
                        const spouseLineY = sharedY !== null ? sharedY : getHeaderCenterY(sId);

                        const lineColor = personRootColor.get(Number(id)) || '#94a3b8';
                        const lineDash = personRootDash.get(Number(id)) || '';
                        const isGlowing = isGlowCard(card) && isGlowCard(spouseCard);
                        // Attach to the facing side-center of each card, not the
                        // (card-covered) centers.
                        const { ax, bx } = marriageEndpoints(cardRect, sRect);
                        queueCrossLink(pendingLines, ax, myLineY, bx, spouseLineY, 'spouse', lineColor, null, isGlowing, lineDash);
                    });
                }

                // Parent-child descent line(s). When a child has exactly two
                // recorded parents and they're each other's spouse, treat the
                // couple as a single attachment point (their marriage line's
                // midpoint) instead of branching separately from each parent —
                // so the connector looks like one clean trunk fanning out to
                // however many children share it, the same as it would for an
                // only child, instead of a busier crossed pattern from two
                // independent parent branches landing on the same children.
                const parentIds = card.getAttribute('data-parent-ids');
                if (parentIds) {
                    const parentCards = parentIds.split(',').filter(Boolean)
                        .map(pId => nodeElements[pId]).filter(Boolean);

                    let attachPoints = [];
                    if (parentCards.length === 2) {
                        const [pA, pB] = parentCards;
                        const aId = pA.getAttribute('data-id');
                        const bId = pB.getAttribute('data-id');
                        const aSpouseIds = (pA.getAttribute('data-spouse-ids') || '').split(',');
                        const rA = nodeRects[aId];
                        const rB = nodeRects[bId];
                        if (aSpouseIds.includes(bId) && rA && rB && rA.width > 0 && rB.width > 0) {
                            const cA = getCenter(rA);
                            const cB = getCenter(rB);
                            const marriageY = getMarriageLineY(aId, bId);
                            attachPoints.push({
                                x: (cA.x + cB.x) / 2,
                                // Where the drawn line actually starts: the
                                // marriage line's own Y (same anchor-consistent
                                // height the spouse line itself uses — see
                                // getMarriageLineY — so this stays correct even
                                // when the anchor has more than one spouse), not
                                // below the cards — otherwise the couple's X
                                // (which falls in the gap between their two
                                // cards) has nothing drawn between the marriage
                                // line and the trunk, leaving them visually
                                // disconnected even though they share an X.
                                startY: marriageY !== null ? marriageY : (getHeaderCenterY(aId) + getHeaderCenterY(bId)) / 2,
                                // Where the row "ends" for the purpose of
                                // centering the shared horizontal junction bar
                                // below — the whole generation row's bottom (see
                                // genRowBottom above), not just this couple's own
                                // cards, so the bar sits below every card in the
                                // row instead of only these two.
                                rowBottomY: genRowBottom[personRenderGeneration.get(Number(aId))] ??
                                    (Math.max(rA.bottom, rB.bottom) - treeRect.top) / currentZoom,
                                color: personRootColor.get(Number(aId)) || personRootColor.get(Number(bId)) || '#94a3b8',
                                dash: personRootDash.get(Number(aId)) ?? personRootDash.get(Number(bId)) ?? '',
                                glowing: isGlowCard(pA) && isGlowCard(pB),
                            });
                        }
                    }
                    if (attachPoints.length === 0) {
                        parentCards.forEach(pCard => {
                            const pId = pCard.getAttribute('data-id');
                            const pRect = nodeRects[pId];
                            if (!pRect || pRect.width === 0 || pRect.height === 0) return;
                            const bottomY = (pRect.bottom - treeRect.top) / currentZoom;
                            attachPoints.push({
                                x: getCenter(pRect).x,
                                startY: bottomY,
                                rowBottomY: genRowBottom[personRenderGeneration.get(Number(pId))] ?? bottomY,
                                color: personRootColor.get(Number(pId)) || '#94a3b8',
                                dash: personRootDash.get(Number(pId)) ?? '',
                                glowing: isGlowCard(pCard),
                            });
                        });
                    }

                    if (attachPoints.length > 0) {
                        const maxRowBottomY = Math.max(...attachPoints.map(a => a.rowBottomY));
                        const myTopY = (cardRect.top - treeRect.top) / currentZoom;
                        // The shared horizontal junction bar always sits a small
                        // fixed gap ABOVE the child's top edge, so every descent
                        // connector drops straight down onto the top line of the
                        // child card from above — never approaching from the side
                        // or from below, even when the generation rows are packed
                        // close together (midpoint would land inside the card).
                        const CHILD_BAR_GAP = 16;
                        const sharedMidY = Math.min((maxRowBottomY + myTopY) / 2, myTopY - CHILD_BAR_GAP);

                        const lineColor = attachPoints[0].color;
                        const lineDash = attachPoints[0].dash || '';
                        const anyParentGlowing = attachPoints.some(a => a.glowing);
                        const childIsGlowing = card.classList.contains('highlighted') || card.classList.contains('highlighted-gen');
                        const isGlowingPath = anyParentGlowing && childIsGlowing;

                        attachPoints.forEach(a => {
                            queueCrossLink(pendingLines, a.x, a.startY, center.x, myTopY, 'parent-child', lineColor, sharedMidY, isGlowingPath && a.glowing, lineDash);
                        });
                    }
                }
            });

            renderQueuedLinks(svg, pendingLines);
        }

        // Fetch Data and Render Tree Logic
        async function loadAndRenderTree() {
            try {
                const { people, roots: rootRows } = await getTree();
                const roots = buildHierarchy(people, rootRows);
                originalRoots = roots;

                // Build Tree
                await renderTreeFromHierarchy(roots);
                errorOverlay.classList.add('hidden');

                // Show generation legend
                generationLegend.classList.remove('hidden');
                generationLegend.classList.add('flex');

                if (minimapWrapper) {
                    minimapWrapper.classList.remove('hidden');
                    minimapWrapper.classList.add('flex');
                }

                // Dynamically populate Color Legend based on actual generations in the tree
                let maxGen = 1;
                document.querySelectorAll('.tree-node-card[data-generation]').forEach(card => {
                    const gen = parseInt(card.getAttribute('data-generation')) || 1;
                    if (gen > maxGen) maxGen = gen;
                });
                
                legendList.innerHTML = '';
                for (let i = 1; i <= maxGen; i++) {
                    const color = generationColors[(i - 1) % generationColors.length];
                    legendList.innerHTML += `
                        <div class="flex items-center gap-2 p-1.5 -mx-1.5 rounded-md cursor-pointer hover:bg-slate-100 transition-colors legend-item" data-gen="${i}" title="Bu jenerasyondaki herkesi vurgula">
                            <div class="w-3 h-3 rounded-full flex-shrink-0 border border-slate-200 shadow-sm" style="background-color: ${color.hex}"></div>
                            <span class="truncate">${i}. Nesil</span>
                        </div>`;
                }

                // Call update on initial render to calculate base physical bounds
                updateZoomStyle();

                // Delay scrolling until the browser has finished painting the initial layout.
                // This ensures getBoundingClientRect() returns the final, correct positions.
                setTimeout(() => {
                    // On a phone/tablet, fitting the whole 500+ person tree on
                    // screen makes it an illegible sliver. Instead open a touch
                    // zoomed out (for context) but still centered on the first
                    // card at a readable size — double-tap / pinch does the rest.
                    if (isNarrow()) {
                        currentZoom = 0.6;
                        updateZoomStyle();
                    }

                    // If the logged-in user is linked to a person, land on their
                    // own card (centered, and selected) instead of the tree root.
                    const ownCard = currentUserPersonId != null ? findPersonCardEl(currentUserPersonId) : null;
                    if (ownCard) {
                        scrollCardToCenter(ownCard);
                        ownCard.click();
                        return;
                    }

                    // Land on the first real person (not the root diamond), and
                    // on a phone put them in the upper third so the descendants
                    // below are what fills the screen.
                    const targetCard = document.querySelector('.tree-node-card:not(.root-node)')
                        || document.querySelector('.tree-node-card');

                    if (targetCard) {
                        const cardRect = targetCard.getBoundingClientRect();
                        const treeRect = treeTransform.getBoundingClientRect();
                        const containerRect = scrollContainer.getBoundingClientRect();

                        const cardCenterX = (cardRect.left - treeRect.left) + (cardRect.width / 2);
                        const cardCenterY = (cardRect.top - treeRect.top) + (cardRect.height / 2);

                        scrollContainer.scrollLeft = cardCenterX - (containerRect.width / 2);
                        scrollContainer.scrollTop = cardCenterY - (containerRect.height * (isNarrow() ? 0.28 : 0.5));
                    } else {
                        // Fallback to centering the whole tree if no card is found
                        scrollContainer.scrollLeft = (scrollContainer.scrollWidth - scrollContainer.clientWidth) / 2;
                        scrollContainer.scrollTop = 0;
                    }
                }, 100);

                // Slight delay to ensure layout is physically finished before rendering minimap
                setTimeout(drawMinimap, 100);

            } catch (err) {
                errorText.textContent = err.message;
                errorOverlay.classList.remove('hidden');
                
                // Show error state in the tree area
                treeRoot.innerHTML = `
                    <div class="text-slate-400 flex flex-col items-center mt-20">
                        <i data-lucide="alert-circle" class="w-12 h-12 mb-4 opacity-20"></i>
                        <p>No valid tree data to display.</p>
                    </div>
                `;
                createIcons();
            }
        }

        // Zoom Functions
        function updateZoomStyle(newScrollLeft = null, newScrollTop = null) {
            // Calculate and explicitly set the wrapper's physical dimensions.
            // IMPORTANT: Read offsetWidth/Height BEFORE setting style.transform to avoid synchronous reflows!
            const unscaledWidth = treeTransform.offsetWidth;
            const unscaledHeight = treeTransform.offsetHeight;
            
            treeTransform.style.transform = `scale(${currentZoom})`;
            
            const wrapper = document.getElementById('scale-wrapper');
            if (wrapper) {
                wrapper.style.width = `${unscaledWidth * currentZoom}px`;
                wrapper.style.height = `${unscaledHeight * currentZoom}px`;
            }

            if (newScrollLeft !== null && newScrollTop !== null) {
                scrollContainer.scrollLeft = newScrollLeft;
                scrollContainer.scrollTop = newScrollTop;
            }
            
            updateMinimapViewport();
        }

        function applyZoomFromCenter(newZoom) {
            const oldZoom = currentZoom;
            if (newZoom === oldZoom) return;
            
            currentZoom = newZoom;
            
            // Calculate center of the viewport
            const centerX = scrollContainer.clientWidth / 2;
            const centerY = scrollContainer.clientHeight / 2;
            
            // Calculate new scroll position to keep the center stationary
            const zoomRatio = currentZoom / oldZoom;
            const newScrollLeft = (scrollContainer.scrollLeft + centerX) * zoomRatio - centerX;
            const newScrollTop = (scrollContainer.scrollTop + centerY) * zoomRatio - centerY;
            
            updateZoomStyle(newScrollLeft, newScrollTop);
        }

        btnZoomIn.addEventListener('click', () => {
            applyZoomFromCenter(Math.min(currentZoom + 0.2, 2));
        });

        btnZoomOut.addEventListener('click', () => {
            applyZoomFromCenter(Math.max(currentZoom - 0.2, 0.05));
        });

        btnZoomReset.addEventListener('click', () => {
            if (isFocusMode) {
                fitTreeToScreen();
            } else {
                applyZoomFromCenter(1);
            }
        });

        function fitTreeToScreen() {
            const treeW = treeTransform.offsetWidth;
            const treeH = treeTransform.offsetHeight;
            
            if (treeW === 0 || treeH === 0) return;

            const viewW = scrollContainer.clientWidth;
            const viewH = scrollContainer.clientHeight;
            
            const padding = 80; // 40px each side
            let newZoom = Math.min((viewW - padding) / treeW, (viewH - padding) / treeH);
            currentZoom = Math.max(0.05, Math.min(newZoom, 1.2)); // Cap scale to not over-blow small trees
            
            updateZoomStyle();
            scrollContainer.scrollLeft = (scrollContainer.scrollWidth - scrollContainer.clientWidth) / 2;
            scrollContainer.scrollTop = (scrollContainer.scrollHeight - scrollContainer.clientHeight) / 2;
        }

        // Snapshot current .highlighted/.highlighted-gen/.highlighted-spouse cards
        // (by id) so the state can be re-applied after a re-render replaces the DOM.
        function captureHighlightState() {
            const state = new Map();
            document.querySelectorAll('.tree-node-card.highlighted, .tree-node-card.highlighted-gen, .tree-node-card.highlighted-spouse').forEach(card => {
                const id = Number(card.getAttribute('data-id'));
                const cls = card.classList.contains('highlighted') ? 'highlighted'
                    : card.classList.contains('highlighted-gen') ? 'highlighted-gen'
                    : 'highlighted-spouse';
                state.set(id, {
                    cls,
                    color: card.style.getPropertyValue('--highlight-color'),
                    shadow: card.style.getPropertyValue('--highlight-shadow'),
                });
            });
            return state;
        }

        function applyHighlightState(state) {
            document.querySelectorAll('.tree-node-card[data-id]').forEach(card => {
                const info = state.get(Number(card.getAttribute('data-id')));
                if (!info) return;
                card.classList.add(info.cls);
                if (info.color) card.style.setProperty('--highlight-color', info.color);
                if (info.shadow) card.style.setProperty('--highlight-shadow', info.shadow);
            });
        }

        // Computes a person's full bloodline (self + ancestors + descendants +
        // spouses of self/descendants) straight from the data model rather
        // than from whatever the DOM currently has rendered. Entering focus
        // mode needs this instead of captureHighlightState(): the DOM can
        // already be a previously pruned/limited focus view (e.g. the user
        // selected someone else while already focused, then toggled focus off
        // and back on) — walking that DOM would only "see" ancestors/
        // descendants that happened to survive the earlier prune, silently
        // dropping the rest of the newly-selected person's family from the
        // freshly entered view. Mirrors the ancestor/descendant/spouse walk in
        // the card-click handler, id-based instead of element-based.
        function computeBloodline(startId) {
            startId = Number(startId);
            const byId = new Map();
            allPersons().forEach(({ person }) => byId.set(Number(person.id), person));

            const parentIdsOf = (person) => {
                const ids = [...(person._parentIds || [])].map(Number);
                if (person._rootParentId != null) ids.push(Number(person._rootParentId));
                return ids;
            };

            const childMap = new Map(); // parentId -> [childId, ...]
            byId.forEach((person, id) => {
                parentIdsOf(person).forEach(pid => {
                    if (!childMap.has(pid)) childMap.set(pid, []);
                    childMap.get(pid).push(id);
                });
            });

            const visited = new Set([startId]);
            const gen = new Set(); // ancestors + descendants -> 'highlighted-gen'
            const descendants = new Set();

            function walkAncestors(id) {
                const person = byId.get(id);
                if (!person) return;
                parentIdsOf(person).forEach(pid => {
                    if (!visited.has(pid)) {
                        visited.add(pid);
                        gen.add(pid);
                        walkAncestors(pid);
                    }
                });
            }
            function walkDescendants(id) {
                (childMap.get(id) || []).forEach(cid => {
                    if (!visited.has(cid)) {
                        visited.add(cid);
                        gen.add(cid);
                        descendants.add(cid);
                        walkDescendants(cid);
                    }
                });
            }
            walkAncestors(startId);
            walkDescendants(startId);

            // Spouses of self and of descendants only (mirrors the click
            // handler's highlightSpouses — a parent's *other* spouse would
            // wrongly read as part of the selected child's bloodline).
            const spouses = new Set();
            const addSpousesOf = (id) => {
                const person = byId.get(id);
                if (!person) return;
                (person._spouseIds || []).forEach(sidRaw => {
                    const sid = Number(sidRaw);
                    if (!visited.has(sid)) {
                        visited.add(sid);
                        spouses.add(sid);
                    }
                });
            };
            addSpousesOf(startId);
            descendants.forEach(addSpousesOf);

            return { self: startId, gen, spouses, all: visited };
        }

        async function toggleFocusMode(forceState) {
            if (typeof forceState === 'boolean') {
                if (isFocusMode === forceState) return;
                isFocusMode = forceState;
            } else {
                isFocusMode = !isFocusMode;
            }

            // Leaving focus also tears down an active "İki kişi arası bağ"
            // view (e.g. a search or "close details" click exits both).
            if (!isFocusMode && relationshipMode) resetRelationshipUI();

            if (btnFocus) {
                if (isFocusMode) {
                    btnFocus.classList.add('bg-blue-50', 'text-blue-600');
                    btnFocus.classList.remove('text-slate-600');
                } else {
                    btnFocus.classList.remove('bg-blue-50', 'text-blue-600');
                    btnFocus.classList.add('text-slate-600');
                }
            }

            if (isFocusMode) {
                // Whoever is plainly "highlighted" (as opposed to just
                // highlighted-gen/-spouse) is the selected person focus
                // centers on — read straight off the DOM since that's just
                // "who's currently selected", not the bloodline itself.
                const selfCard = document.querySelector('.tree-node-card.highlighted');
                const selfId = selfCard ? Number(selfCard.getAttribute('data-id')) : null;

                if (selfId === null) {
                    isFocusMode = false;
                    if (btnFocus) {
                        btnFocus.classList.remove('bg-blue-50', 'text-blue-600');
                        btnFocus.classList.add('text-red-500');
                        setTimeout(() => {
                            btnFocus.classList.remove('text-red-500');
                            btnFocus.classList.add('text-slate-600');
                        }, 500);
                    }
                    return;
                }

                // Bloodline recomputed from the full data model (see comment
                // on computeBloodline) — re-render pruned to exactly that, and
                // apply highlight classes fresh rather than reusing whatever
                // the (possibly stale/limited) DOM had before the re-render.
                lastFocusSelfId = selfId;

                const bloodline = computeBloodline(selfId);
                await renderTreeFromHierarchy(pruneForFocus(originalRoots, bloodline.all));

                document.querySelectorAll('.tree-node-card[data-id]').forEach(cardEl => {
                    const cid = Number(cardEl.getAttribute('data-id'));
                    const cls = cid === bloodline.self ? 'highlighted'
                        : bloodline.gen.has(cid) ? 'highlighted-gen'
                        : bloodline.spouses.has(cid) ? 'highlighted-spouse'
                        : null;
                    if (!cls) return;
                    const cardGen = parseInt(cardEl.getAttribute('data-generation')) || 1;
                    const len = generationColors.length;
                    const colorObj = generationColors[((cardGen - 1) % len + len) % len];
                    cardEl.classList.add(cls);
                    cardEl.style.setProperty('--highlight-color', colorObj.hex);
                    cardEl.style.setProperty('--highlight-shadow', `0 0 0 4px ${colorObj.rgba}`);
                });
            } else {
                // Snapshot which cards are currently highlighted (and how)
                // before re-rendering wipes the DOM — re-applied to the fresh
                // (full-tree) cards below.
                const highlightState = captureHighlightState();
                await renderTreeFromHierarchy(originalRoots);
                applyHighlightState(highlightState);
            }

            drawCrossTreeLinks();

            setTimeout(() => {
                if (isFocusMode) {
                    closeToolsDrawer(); // give the fitted bloodline the full screen
                    updateZoomStyle(); // re-eval physical dimensions for the wrapper
                    fitTreeToScreen();
                } else {
                    currentZoom = 1;
                    updateZoomStyle();
                    
                    // Focus'tan çıkarken seçili kişiye kaydır. Panel kapatılarak
                    // çıkıldıysa .highlighted sınıfı silinmiş olur; o durumda
                    // en son merkeze alınan kişinin kaydedilen id'sine düş.
                    const targetCard = document.querySelector('.tree-node-card.highlighted')
                        || (lastFocusSelfId != null
                            && document.querySelector(`.tree-node-card[data-id="${lastFocusSelfId}"]`));
                    if (targetCard) {
                        const cardRect = targetCard.getBoundingClientRect();
                        const treeRect = treeTransform.getBoundingClientRect();
                        const containerRect = scrollContainer.getBoundingClientRect();
                        
                        const cardCenterX = (cardRect.left - treeRect.left) + (cardRect.width / 2);
                        const cardCenterY = (cardRect.top - treeRect.top) + (cardRect.height / 2);
                        
                        scrollContainer.scrollLeft = cardCenterX - (containerRect.width / 2);
                        scrollContainer.scrollTop = cardCenterY - (containerRect.height / 2);
                    }
                }
                drawMinimap();
            }, 50);
        }

        if (btnFocus) {
            btnFocus.addEventListener('click', () => toggleFocusMode());
        }

        // Zoom the tree around the cursor, keeping whatever's under the pointer stationary.
        function applyWheelZoom(e, isZoomingIn, zoomDelta) {
            const oldZoom = currentZoom;
            currentZoom = isZoomingIn ? Math.min(currentZoom + zoomDelta, 2) : Math.max(currentZoom - zoomDelta, 0.05);

            if (currentZoom !== oldZoom) {
                const rect = scrollContainer.getBoundingClientRect();
                const mouseX = e.clientX - rect.left;
                const mouseY = e.clientY - rect.top;

                const zoomRatio = currentZoom / oldZoom;
                const newScrollLeft = (scrollContainer.scrollLeft + mouseX) * zoomRatio - mouseX;
                const newScrollTop = (scrollContainer.scrollTop + mouseY) * zoomRatio - mouseY;

                updateZoomStyle(newScrollLeft, newScrollTop);
            }
        }

        scrollContainer.addEventListener('wheel', (e) => {
            // Trackpad pinch gesture: browsers report this as a wheel event with
            // ctrlKey set to true, with small/fractional deltaY as the fingers move.
            // Someone actually holding Ctrl while turning a physical mouse wheel gets
            // the same ctrlKey flag, but with large "steppy" integer deltas — treat
            // only the former as zoom, and let the latter just scroll like normal.
            if (e.ctrlKey && (!Number.isInteger(e.deltaY) || Math.abs(e.deltaY) < 50)) {
                e.preventDefault();
                applyWheelZoom(e, e.deltaY < 0, Math.abs(e.deltaY) * 0.01);
                return;
            }

            // Cmd (⌘) + wheel: explicit zoom for physical mice on macOS, where the
            // large "steppy" integer deltas need a gentler multiplier to feel right.
            if (e.metaKey && e.deltaY !== 0) {
                e.preventDefault();
                const step = Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 50
                    ? 0.15
                    : Math.abs(e.deltaY) * 0.01;
                applyWheelZoom(e, e.deltaY < 0, step);
                return;
            }

            // No modifier: let the browser scroll/pan natively — both a trackpad's
            // two-finger scroll and a plain mouse wheel behave the same way here.
        }, { passive: false }); // Passive must be false to allow preventDefault()

        // Drag to scroll functionality
        let isDragging = false;
        let startX, startY, initialScrollLeft, initialScrollTop;

        scrollContainer.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return; // Only allow left click
            isDragging = true;
            scrollContainer.classList.add('cursor-grabbing');
            scrollContainer.classList.remove('cursor-grab');
            scrollContainer.style.userSelect = 'none'; // Prevent text selection while dragging
            
            startX = e.pageX - scrollContainer.offsetLeft;
            startY = e.pageY - scrollContainer.offsetTop;
            initialScrollLeft = scrollContainer.scrollLeft;
            initialScrollTop = scrollContainer.scrollTop;
        });

        const stopDragging = () => {
            isDragging = false;
            scrollContainer.classList.remove('cursor-grabbing');
            scrollContainer.classList.add('cursor-grab');
            scrollContainer.style.userSelect = '';
        };

        scrollContainer.addEventListener('mouseleave', stopDragging);
        scrollContainer.addEventListener('mouseup', stopDragging);

        scrollContainer.addEventListener('mousemove', (e) => {
            if (!isDragging) return;
            e.preventDefault(); // Prevent default browser drag behavior
            
            const x = e.pageX - scrollContainer.offsetLeft;
            const y = e.pageY - scrollContainer.offsetTop;
            const walkX = x - startX;
            const walkY = y - startY;
            
            // Adjust the scroll position
            scrollContainer.scrollLeft = initialScrollLeft - walkX;
            scrollContainer.scrollTop = initialScrollTop - walkY;
        });

        // --- Touch: one-finger drag pans natively (overflow:auto + touch-action);
        // add two-finger pinch-zoom, mirroring applyWheelZoom — zoom around the
        // pinch midpoint, keeping whatever's under the fingers stationary. ---
        let pinchStart = null;
        scrollContainer.addEventListener('touchstart', (e) => {
            if (e.touches.length === 2) {
                const [a, b] = e.touches;
                pinchStart = {
                    dist: Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY) || 1,
                    zoom: currentZoom,
                };
            }
        }, { passive: true });

        scrollContainer.addEventListener('touchmove', (e) => {
            if (!pinchStart || e.touches.length !== 2) return;
            e.preventDefault(); // this gesture is a zoom, not a scroll
            const [a, b] = e.touches;
            const dist = Math.hypot(b.clientX - a.clientX, b.clientY - a.clientY) || 1;
            const oldZoom = currentZoom;
            let newZoom = pinchStart.zoom * (dist / pinchStart.dist);
            newZoom = Math.max(0.05, Math.min(newZoom, 2));
            if (newZoom === oldZoom) return;

            currentZoom = newZoom;
            const rect = scrollContainer.getBoundingClientRect();
            const midX = (a.clientX + b.clientX) / 2 - rect.left;
            const midY = (a.clientY + b.clientY) / 2 - rect.top;
            const zoomRatio = currentZoom / oldZoom;
            updateZoomStyle(
                (scrollContainer.scrollLeft + midX) * zoomRatio - midX,
                (scrollContainer.scrollTop + midY) * zoomRatio - midY,
            );
        }, { passive: false });

        const endPinch = (e) => { if (e.touches.length < 2) pinchStart = null; };
        scrollContainer.addEventListener('touchcancel', endPinch);

        // Double-tap an empty part of the canvas to zoom toward that point; a
        // second double-tap fits the whole tree back on screen. Taps that land
        // on a card are left to the card's own select handler.
        let lastTapAt = 0, lastTapX = 0, lastTapY = 0;
        scrollContainer.addEventListener('touchend', (e) => {
            endPinch(e);
            if (pinchStart || e.touches.length) return;
            const t = e.changedTouches[0];
            if (!t || (e.target.closest && e.target.closest('.tree-node-card'))) { lastTapAt = 0; return; }

            const now = Date.now();
            const isDoubleTap = now - lastTapAt < 300
                && Math.hypot(t.clientX - lastTapX, t.clientY - lastTapY) < 32;
            if (!isDoubleTap) { lastTapAt = now; lastTapX = t.clientX; lastTapY = t.clientY; return; }
            lastTapAt = 0;

            if (currentZoom < 0.9) {
                const rect = scrollContainer.getBoundingClientRect();
                const px = t.clientX - rect.left;
                const py = t.clientY - rect.top;
                const oldZoom = currentZoom;
                currentZoom = 1;
                const zoomRatio = currentZoom / oldZoom;
                updateZoomStyle(
                    (scrollContainer.scrollLeft + px) * zoomRatio - px,
                    (scrollContainer.scrollTop + py) * zoomRatio - py,
                );
            } else {
                fitTreeToScreen();
            }
            drawMinimap();
        });

        // Minimap Drawing and Interaction
        function drawMinimap() {
            if (!minimapContainer || !minimapCanvas) return;
            const ctx = minimapCanvas.getContext('2d');
            
            minimapCanvas.width = minimapContainer.clientWidth;
            minimapCanvas.height = minimapContainer.clientHeight;
            
            const treeRect = treeTransform.getBoundingClientRect();
            const treeWidth = treeRect.width / currentZoom;
            const treeHeight = treeRect.height / currentZoom;
            
            if (treeWidth === 0 || treeHeight === 0) return;

            const padding = 10; 
            const scaleX = (minimapCanvas.width - padding * 2) / treeWidth;
            const scaleY = (minimapCanvas.height - padding * 2) / treeHeight;
            const minimapScale = Math.min(scaleX, scaleY);
            
            const offsetX = (minimapCanvas.width - treeWidth * minimapScale) / 2;
            const offsetY = (minimapCanvas.height - treeHeight * minimapScale) / 2;
            
            ctx.clearRect(0, 0, minimapCanvas.width, minimapCanvas.height);
            minimapContainer._metrics = { minimapScale, offsetX, offsetY, treeWidth, treeHeight };
            
            document.querySelectorAll('.tree-node-card').forEach(card => {
                const rect = card.getBoundingClientRect();
                const x = (rect.left - treeRect.left) / currentZoom;
                const y = (rect.top - treeRect.top) / currentZoom;
                const w = rect.width / currentZoom;
                const h = rect.height / currentZoom;
                
                if (card.classList.contains('highlighted') || card.classList.contains('highlighted-gen') || card.classList.contains('highlighted-spouse')) {
                    ctx.fillStyle = card.style.getPropertyValue('--highlight-color').trim() || '#3b82f6';
                } else {
                    // Darker slate on a light map; lighter slate on a dark one.
                    ctx.fillStyle = document.documentElement.classList.contains('dark') ? '#94a3b8' : '#475569';
                }
                ctx.fillRect(offsetX + x * minimapScale, offsetY + y * minimapScale, w * minimapScale, h * minimapScale);
            });
            
            updateMinimapViewport();
        }

        function updateMinimapViewport() {
            if (!minimapContainer || !minimapViewport || !minimapContainer._metrics) return;
            const metrics = minimapContainer._metrics;
            minimapViewport.style.display = 'block';
            
            const scrollRect = scrollContainer.getBoundingClientRect();
            const treeRect = treeTransform.getBoundingClientRect();
            
            const visibleLeftOnTree = scrollRect.left - treeRect.left;
            const visibleTopOnTree = scrollRect.top - treeRect.top;
            
            const unscaledScrollX = visibleLeftOnTree / currentZoom;
            const unscaledScrollY = visibleTopOnTree / currentZoom;
            const unscaledVisibleW = scrollRect.width / currentZoom;
            const unscaledVisibleH = scrollRect.height / currentZoom;
            
            let mapX = metrics.offsetX + unscaledScrollX * metrics.minimapScale;
            let mapY = metrics.offsetY + unscaledScrollY * metrics.minimapScale;
            let mapW = unscaledVisibleW * metrics.minimapScale;
            let mapH = unscaledVisibleH * metrics.minimapScale;
            
            minimapViewport.style.left = `${mapX}px`;
            minimapViewport.style.top = `${mapY}px`;
            minimapViewport.style.width = `${mapW}px`;
            minimapViewport.style.height = `${mapH}px`;
        }

        scrollContainer.addEventListener('scroll', updateMinimapViewport);
        window.addEventListener('resize', drawMinimap);

        // --- Person Details: view / edit / save ---

        // Renders the read-only "Kişi Detayları" panel content for one person
        // ({name, id, photoUrl, attributes}, same shape as a card's data-details).
        function showPersonDetailsView(details) {
            currentDetailsPersonId = Number(details.id);

            const name = details.name || "UNKNOWN";
            const surname = (details.attributes && details.attributes.surname) ? details.attributes.surname : '';
            const gender = (details.attributes && details.attributes.gender) ? details.attributes.gender : '';
            let detailsHTML = '';
            if (details.photoUrl) {
                detailsHTML += `<img src="${escapeHTML(details.photoUrl)}" alt="Portrait" class="w-16 h-16 rounded-full object-cover mx-auto mb-2 border-2 border-slate-100 shadow-sm shrink-0">`;
            } else {
                detailsHTML += `<div class="w-16 h-16 rounded-full bg-slate-50 mx-auto mb-2 flex items-center justify-center border-2 border-slate-100 shadow-sm shrink-0"><i data-lucide="user" class="w-8 h-8 text-slate-300"></i></div>`;
            }

            detailsHTML += `<div class="text-center font-bold text-slate-900 text-sm ${!surname ? 'mb-1' : ''}">${escapeHTML(name)}</div>`;
            if (surname) {
                detailsHTML += `<div class="text-center font-semibold text-slate-700 text-sm mb-1">${escapeHTML(surname)}</div>`;
            }
            detailsHTML += `<div class="text-center text-[10px] text-slate-400 font-mono mb-2">ID: ${escapeHTML(details.id)}</div>`;
            const detailsGlyph = genderGlyph(gender);
            if (detailsGlyph) {
                detailsHTML += `<div class="text-center text-[13px] text-slate-400 mb-2" title="${detailsGlyph.label}">${detailsGlyph.sym}</div>`;
            }

            personDetailsContent.innerHTML = detailsHTML;
            showPersonPanel();
            if (btnEditDetails) btnEditDetails.classList.toggle('hidden', !canEditTree());
            if (btnDeleteDetails) btnDeleteDetails.classList.toggle('hidden', !canEditTree());
            createIcons();
        }

        // Every person currently linked as a founding member of the given root
        // hierarchy node (id is negative), read back off the built hierarchy.
        function rootMemberPersons(rootId) {
            const seen = new Set();
            return allPersons()
                .map(({ person }) => person)
                .filter(p => {
                    if (Number(p._rootParentId) !== Number(rootId)) return false;
                    if (seen.has(Number(p.id))) return false;
                    seen.add(Number(p.id));
                    return true;
                });
        }

        // Read-only panel for a family root (the diamond).
        function showRootDetailsView(details) {
            currentDetailsPersonId = Number(details.id);
            const title = details.title || 'ROOT';
            const members = rootMemberPersons(details.id);

            let html = `
                <div class="flex flex-col items-center text-center pb-3 mb-2 border-b border-slate-100">
                    <div class="w-10 h-10 rotate-45 rounded-lg bg-slate-600 root-popup-diamond mb-3 mt-1"></div>
                    <div class="font-bold text-slate-900 text-sm leading-snug px-2">${escapeHTML(title)}</div>
                    <div class="inline-flex items-center gap-1.5 mt-1.5 text-[10px] font-semibold text-slate-500 bg-slate-100 rounded-full px-2.5 py-1">
                        <span>Aile kökü</span><span>·</span><span>${escapeHTML(details.generation)}. jenerasyon</span>
                    </div>
                </div>`;
            if (members.length) {
                html += `<div class="text-left text-xs text-slate-600 flex flex-col gap-1">
                    <div class="flex items-center justify-between px-0.5 mb-1">
                        <span class="font-semibold text-slate-400 text-[10px]">KİŞİLER</span>
                        <span class="font-mono text-slate-300 text-[10px]">${members.length}</span>
                    </div>`;
                members.forEach(p => {
                    const surname = (p.attributes && p.attributes.surname) || '';
                    const label = `${p.name || ''} ${surname}`.trim() || `#${p.id}`;
                    html += `<div class="flex items-center gap-2 bg-slate-50 hover:bg-slate-100 transition-colors px-2 py-1.5 rounded-md">
                        <div class="w-5 h-5 rounded-full bg-slate-200 text-slate-500 text-[9px] font-bold flex items-center justify-center shrink-0">${escapeHTML(initialsOf(p.name, surname))}</div>
                        <span class="truncate">${escapeHTML(label)}</span>
                    </div>`;
                });
                html += `</div>`;
            } else {
                html += `<div class="text-[11px] text-slate-400 text-center">Henüz kişi bağlanmadı.</div>`;
            }

            personDetailsContent.innerHTML = html;
            showPersonPanel();
            if (btnEditDetails) btnEditDetails.classList.toggle('hidden', !canEditTree());
            if (btnDeleteDetails) btnDeleteDetails.classList.toggle('hidden', !canEditTree());
            createIcons();
        }

        // Editable form for a family root.
        function showRootDetailsEdit(node) {
            const rootId = Number(node.id);
            const currentMemberIds = rootMemberPersons(rootId).map(p => Number(p.id));

            personDetailsContent.innerHTML = `
                <div class="flex flex-col gap-2">
                    <label class="flex flex-col gap-0.5">
                        <span class="text-[10px] font-semibold text-slate-500 uppercase">Başlık</span>
                        <input type="text" id="edit-field-root-title" value="${escapeHTML(node.title || 'ROOT')}" class="border border-slate-300 rounded-md px-2 py-1 text-xs outline-none focus:border-blue-400 bg-white">
                    </label>
                    <label class="flex flex-col gap-0.5">
                        <span class="text-[10px] font-semibold text-slate-500 uppercase">Jenerasyon</span>
                        <input type="number" min="1" step="1" id="edit-field-root-gen" value="${node._generation || 1}" class="border border-slate-300 rounded-md px-2 py-1 text-xs outline-none focus:border-blue-400 bg-white">
                    </label>
                    <label class="flex flex-col gap-0.5">
                        <span class="text-[10px] font-semibold text-slate-500 uppercase">Kişiler</span>
                        <select id="edit-field-root-members" multiple size="6" class="border border-slate-300 rounded-md px-2 py-1 text-xs outline-none focus:border-blue-400 bg-white">
                            ${buildPersonOptions(null, currentMemberIds)}
                        </select>
                        <span class="text-[9px] text-slate-400">Ailenin en üstteki kişi(ler)i. Alt kuşaklar buradan sayılır.</span>
                    </label>
                    <div id="edit-form-error" class="text-[11px] text-red-500 hidden"></div>
                    <div class="flex gap-2 mt-1">
                        <button id="btn-save-root" class="flex-1 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold py-1.5 rounded-md transition-colors cursor-pointer">Kaydet</button>
                        <button id="btn-cancel-root" class="flex-1 bg-slate-100 hover:bg-slate-200 text-slate-600 text-xs font-semibold py-1.5 rounded-md transition-colors cursor-pointer">İptal</button>
                    </div>
                </div>`;

            showPersonPanel();
            if (btnEditDetails) btnEditDetails.classList.add('hidden');
            if (btnDeleteDetails) btnDeleteDetails.classList.add('hidden');

            document.getElementById('edit-field-root-title').focus();
            document.getElementById('btn-cancel-root').addEventListener('click', () => {
                showRootDetailsView({ isRoot: true, id: node.id, title: node.title, generation: node._generation });
            });
            document.getElementById('btn-save-root').addEventListener('click', () => saveRootEdit(node));
        }

        async function saveRootEdit(node) {
            const errEl = document.getElementById('edit-form-error');
            const showFormError = (msg) => { errEl.textContent = msg; errEl.classList.remove('hidden'); };

            const title = document.getElementById('edit-field-root-title').value.trim() || 'ROOT';
            const genRaw = document.getElementById('edit-field-root-gen').value.trim();
            const generation = Number(genRaw);
            if (!Number.isInteger(generation) || generation < 1) {
                showFormError('Jenerasyon 1 veya daha büyük bir tam sayı olmalıdır.');
                return;
            }
            const memberIds = Array.from(document.getElementById('edit-field-root-members').selectedOptions)
                .map(opt => opt.value).filter(v => v !== '').map(Number);

            const saveBtn = document.getElementById('btn-save-root');
            saveBtn.disabled = true;
            saveBtn.textContent = 'Kaydediliyor...';
            try {
                await updateRoot(rootDbId(node.id), { title, generation, memberIds });

                const { people, roots: rootRows } = await getTree();
                originalRoots = buildHierarchy(people, rootRows);

                const highlightState = captureHighlightState();
                if (isFocusMode) {
                    await renderTreeFromHierarchy(pruneForFocus(originalRoots, new Set(highlightState.keys())));
                } else {
                    await renderTreeFromHierarchy(originalRoots);
                }
                applyHighlightState(highlightState);
                drawCrossTreeLinks();
                drawMinimap();

                const updated = findPersonNode(originalRoots, node.id);
                if (updated) showRootDetailsView({ isRoot: true, id: updated.id, title: updated.title, generation: updated._generation });
                else closeDetailsPanel();
            } catch (err) {
                showFormError('Kaydetme başarısız: ' + err.message);
                saveBtn.disabled = false;
                saveBtn.textContent = 'Kaydet';
            }
        }

        // findPersonNode is imported from tree-model.js (it used to be
        // re-declared identically here).

        // Builds <option> HTML for every person except excludeId, sorted by
        // name/surname, for the parent/spouse-picker selects in the edit
        // form. selectedId may be a single id (single-select fields) or an
        // array of ids (multi-select fields, e.g. spouses).
        function buildPersonOptions(excludeId, selectedId) {
            const options = allPersons()
                .map(({ person }) => person)
                .filter(p => !p._isRoot && Number(p.id) !== Number(excludeId));

            const seen = new Set();
            const unique = options.filter(p => {
                if (seen.has(Number(p.id))) return false;
                seen.add(Number(p.id));
                return true;
            });
            unique.sort((a, b) => {
                const labelA = `${a.name || ''} ${(a.attributes && a.attributes.surname) || ''}`.trim();
                const labelB = `${b.name || ''} ${(b.attributes && b.attributes.surname) || ''}`.trim();
                return labelA.localeCompare(labelB, 'tr');
            });

            const selectedIds = Array.isArray(selectedId)
                ? selectedId.filter(id => id != null).map(Number)
                : (selectedId != null ? [Number(selectedId)] : []);

            let html = `<option value="" ${selectedIds.length === 0 ? 'selected' : ''}>— Yok —</option>`;
            unique.forEach(p => {
                const label = `${p.name || ''} ${(p.attributes && p.attributes.surname) || ''}`.trim() || `#${p.id}`;
                const isSelected = selectedIds.includes(Number(p.id));
                html += `<option value="${p.id}" ${isSelected ? 'selected' : ''}>${escapeHTML(label)} (ID: ${p.id})</option>`;
            });
            return html;
        }

        // Swaps the details panel into an editable form for the given person node.
        function showPersonDetailsEdit(node) {
            const attrs = node.attributes || {};
            const genderVal = attrs.gender || '';
            const parentIds = (node._parentIds || []).map(Number);
            const spouseIds = (node._spouseIds || []).map(Number);

            personDetailsContent.innerHTML = `
                <div class="flex flex-col gap-2">
                    <label class="flex flex-col gap-0.5">
                        <span class="text-[10px] font-semibold text-slate-500 uppercase">Ad</span>
                        <input type="text" id="edit-field-name" value="${escapeHTML(node.name || '')}" class="border border-slate-300 rounded-md px-2 py-1 text-xs outline-none focus:border-blue-400 bg-white">
                    </label>
                    <label class="flex flex-col gap-0.5">
                        <span class="text-[10px] font-semibold text-slate-500 uppercase">Soyad</span>
                        <input type="text" id="edit-field-surname" value="${escapeHTML(attrs.surname || '')}" class="border border-slate-300 rounded-md px-2 py-1 text-xs outline-none focus:border-blue-400 bg-white">
                    </label>
                    <label class="flex flex-col gap-0.5">
                        <span class="text-[10px] font-semibold text-slate-500 uppercase">Cinsiyet</span>
                        <select id="edit-field-gender" class="border border-slate-300 rounded-md px-2 py-1 text-xs outline-none focus:border-blue-400 bg-white">
                            <option value="" ${genderVal === '' ? 'selected' : ''}>Bilinmiyor</option>
                            <option value="Male" ${genderVal === 'Male' ? 'selected' : ''}>Erkek</option>
                            <option value="Female" ${genderVal === 'Female' ? 'selected' : ''}>Kadın</option>
                        </select>
                    </label>
                    <label class="flex flex-col gap-0.5">
                        <span class="text-[10px] font-semibold text-slate-500 uppercase">Doğum Tarihi</span>
                        <input type="text" id="edit-field-birthdate" value="${escapeHTML(attrs.birthdate || '')}" placeholder="GG.AA.YYYY" class="border border-slate-300 rounded-md px-2 py-1 text-xs outline-none focus:border-blue-400 bg-white">
                    </label>
                    <label class="flex flex-col gap-0.5">
                        <span class="text-[10px] font-semibold text-slate-500 uppercase">Doğum Yeri</span>
                        <input type="text" id="edit-field-birthplace" value="${escapeHTML(attrs.birthplace || '')}" class="border border-slate-300 rounded-md px-2 py-1 text-xs outline-none focus:border-blue-400 bg-white">
                    </label>
                    <label class="flex flex-col gap-0.5">
                        <span class="text-[10px] font-semibold text-slate-500 uppercase">Ölüm Tarihi</span>
                        <input type="text" id="edit-field-dateofdeath" value="${escapeHTML(attrs.dateofdeath || '')}" placeholder="GG.AA.YYYY" class="border border-slate-300 rounded-md px-2 py-1 text-xs outline-none focus:border-blue-400 bg-white">
                    </label>
                    <label class="flex flex-col gap-0.5">
                        <span class="text-[10px] font-semibold text-slate-500 uppercase">Not</span>
                        <textarea id="edit-field-note" rows="3" class="border border-slate-300 rounded-md px-2 py-1 text-xs outline-none focus:border-blue-400 bg-white resize-none">${escapeHTML(attrs.note || '')}</textarea>
                    </label>
                    <label class="flex flex-col gap-0.5">
                        <span class="text-[10px] font-semibold text-slate-500 uppercase">Ebeveyn 1</span>
                        <select id="edit-field-parent1" class="border border-slate-300 rounded-md px-2 py-1 text-xs outline-none focus:border-blue-400 bg-white">
                            ${buildPersonOptions(node.id, parentIds[0])}
                        </select>
                    </label>
                    <label class="flex flex-col gap-0.5">
                        <span class="text-[10px] font-semibold text-slate-500 uppercase">Ebeveyn 2</span>
                        <select id="edit-field-parent2" class="border border-slate-300 rounded-md px-2 py-1 text-xs outline-none focus:border-blue-400 bg-white">
                            ${buildPersonOptions(node.id, parentIds[1])}
                        </select>
                    </label>
                    <label class="flex flex-col gap-0.5">
                        <span class="text-[10px] font-semibold text-slate-500 uppercase">Eş</span>
                        <select id="edit-field-spouse" multiple size="3" class="border border-slate-300 rounded-md px-2 py-1 text-xs outline-none focus:border-blue-400 bg-white">
                            ${buildPersonOptions(node.id, spouseIds)}
                        </select>
                    </label>
                    <div id="edit-form-error" class="text-[11px] text-red-500 hidden"></div>
                    <div class="flex gap-2 mt-1">
                        <button id="btn-save-details" class="flex-1 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold py-1.5 rounded-md transition-colors cursor-pointer">Kaydet</button>
                        <button id="btn-cancel-edit-details" class="flex-1 bg-slate-100 hover:bg-slate-200 text-slate-600 text-xs font-semibold py-1.5 rounded-md transition-colors cursor-pointer">İptal</button>
                    </div>
                </div>`;

            if (btnEditDetails) btnEditDetails.classList.add('hidden');
            if (btnDeleteDetails) btnDeleteDetails.classList.add('hidden');

            document.getElementById('edit-field-name').focus();
            document.getElementById('btn-cancel-edit-details').addEventListener('click', () => {
                showPersonDetailsView({ name: node.name, id: node.id, photoUrl: node.photoUrl, attributes: node.attributes });
            });
            document.getElementById('btn-save-details').addEventListener('click', () => saveDetailsEdit(node));
        }

        // Saves the edited fields through the /api/people/:id endpoint (see
        // js/api.js and server.py — the server writes the update straight to
        // its database, so there's no browser file-write API or download
        // involved), updates the in-memory hierarchy to match, then
        // re-renders the tree and returns the panel to view mode.
        async function saveDetailsEdit(node) {
            const errEl = document.getElementById('edit-form-error');
            const showFormError = (msg) => {
                errEl.textContent = msg;
                errEl.classList.remove('hidden');
            };

            const name = document.getElementById('edit-field-name').value.trim();
            if (!name) {
                showFormError('Ad boş olamaz.');
                return;
            }
            const surname = document.getElementById('edit-field-surname').value.trim();
            const genderStr = document.getElementById('edit-field-gender').value; // '', 'Male', 'Female'
            const birthdate = document.getElementById('edit-field-birthdate').value.trim();
            const birthplace = document.getElementById('edit-field-birthplace').value.trim();
            const dateofdeath = document.getElementById('edit-field-dateofdeath').value.trim();
            const note = document.getElementById('edit-field-note').value.trim();
            const genderNum = genderStr === 'Male' ? 1 : genderStr === 'Female' ? 2 : 0;

            const parent1Raw = document.getElementById('edit-field-parent1').value;
            const parent2Raw = document.getElementById('edit-field-parent2').value;
            const parent1Id = parent1Raw ? Number(parent1Raw) : null;
            const parent2Id = parent2Raw ? Number(parent2Raw) : null;
            if (parent1Id !== null && parent2Id !== null && parent1Id === parent2Id) {
                showFormError('Ebeveyn 1 ve Ebeveyn 2 aynı kişi olamaz.');
                return;
            }
            const parentIds = [parent1Id, parent2Id].filter(id => id !== null);

            const spouseSelect = document.getElementById('edit-field-spouse');
            const spouseIds = Array.from(spouseSelect.selectedOptions)
                .map(opt => opt.value)
                .filter(v => v !== '')
                .map(Number);

            const saveBtn = document.getElementById('btn-save-details');
            saveBtn.disabled = true;
            saveBtn.textContent = 'Kaydediliyor...';

            try {
                await updatePerson(node.id, {
                    name,
                    surname: surname || null,
                    gender: genderNum,
                    birthdate: birthdate || null,
                    birthplace: birthplace || null,
                    dateofdeath: dateofdeath || null,
                    note: note || null,
                    parentIds,
                    spouseIds,
                });

                // Parent changes can move this person to a different branch of
                // the tree, so rebuild the whole hierarchy from fresh server
                // data rather than patching the old node in place.
                const { people, roots: rootRows } = await getTree();
                originalRoots = buildHierarchy(people, rootRows);
                const updatedNode = findPersonNode(originalRoots, node.id);

                // Re-render, preserving whatever highlight/focus state was active.
                const highlightState = captureHighlightState();
                if (isFocusMode) {
                    const visibleIds = new Set(highlightState.keys());
                    await renderTreeFromHierarchy(pruneForFocus(originalRoots, visibleIds));
                } else {
                    await renderTreeFromHierarchy(originalRoots);
                }
                applyHighlightState(highlightState);
                drawCrossTreeLinks();
                drawMinimap();

                if (updatedNode) {
                    showPersonDetailsView({ name: updatedNode.name, id: updatedNode.id, photoUrl: updatedNode.photoUrl, attributes: updatedNode.attributes });
                }
            } catch (err) {
                showFormError('Kaydetme başarısız: ' + err.message);
                saveBtn.disabled = false;
                saveBtn.textContent = 'Kaydet';
            }
        }

        if (btnEditDetails) {
            btnEditDetails.addEventListener('click', () => {
                if (currentDetailsPersonId === null) return;
                const node = findPersonNode(originalRoots, currentDetailsPersonId);
                if (!node) return;
                if (node._isRoot) showRootDetailsEdit(node);
                else showPersonDetailsEdit(node);
            });
        }

        // Hides the details panel entirely and clears any active highlight
        // state, shared by the "cancel add" and "after delete" flows.
        function closeDetailsPanel() {
            document.querySelectorAll('.tree-node-card.highlighted, .tree-node-card.highlighted-gen, .tree-node-card.highlighted-spouse').forEach(el => {
                el.classList.remove('highlighted', 'highlighted-gen', 'highlighted-spouse');
                el.style.removeProperty('--highlight-color');
                el.style.removeProperty('--highlight-shadow');
            });
            document.querySelectorAll('.legend-item').forEach(el => {
                el.classList.remove('active-legend', 'bg-slate-100', 'font-semibold', 'text-slate-900');
            });
            currentDetailsPersonId = null;
            hidePersonPanel();
            drawMinimap();
            if (typeof drawCrossTreeLinks === 'function') requestAnimationFrame(drawCrossTreeLinks);
        }

        // Re-fetches the tree from the server and re-renders it, preserving
        // whatever highlight/focus state was active. Shared by the
        // create/delete flows below (saveDetailsEdit has its own inline copy
        // of this same sequence since it also needs to keep the panel open).
        async function refreshTree() {
            const { people, roots: rootRows } = await getTree();
            originalRoots = buildHierarchy(people, rootRows);
            const highlightState = captureHighlightState();
            if (isFocusMode) {
                const visibleIds = new Set(highlightState.keys());
                // Focus modunda açık olan / yeni eklenen kişiyi de görünür tut,
                // yoksa düzenleme sonrası soy hattından düşebilir.
                if (currentDetailsPersonId != null) visibleIds.add(Number(currentDetailsPersonId));
                await renderTreeFromHierarchy(pruneForFocus(originalRoots, visibleIds));
            } else {
                await renderTreeFromHierarchy(originalRoots);
            }
            applyHighlightState(highlightState);
            drawCrossTreeLinks();
            drawMinimap();
        }

        // Renders the details panel in "create a new person" mode: same
        // field set as the edit form (a single-select spouse picker here,
        // since a brand-new person can only be entering one marriage at
        // creation time — the edit form's multi-select handles anyone with
        // more than one recorded spouse).
        function showPersonCreateForm() {
            currentDetailsPersonId = null;

            personDetailsContent.innerHTML = `
                <div class="flex flex-col gap-2">
                    <label class="flex flex-col gap-0.5">
                        <span class="text-[10px] font-semibold text-slate-500 uppercase">Ad</span>
                        <input type="text" id="edit-field-name" value="" class="border border-slate-300 rounded-md px-2 py-1 text-xs outline-none focus:border-blue-400 bg-white">
                    </label>
                    <label class="flex flex-col gap-0.5">
                        <span class="text-[10px] font-semibold text-slate-500 uppercase">Soyad</span>
                        <input type="text" id="edit-field-surname" value="" class="border border-slate-300 rounded-md px-2 py-1 text-xs outline-none focus:border-blue-400 bg-white">
                    </label>
                    <label class="flex flex-col gap-0.5">
                        <span class="text-[10px] font-semibold text-slate-500 uppercase">Cinsiyet</span>
                        <select id="edit-field-gender" class="border border-slate-300 rounded-md px-2 py-1 text-xs outline-none focus:border-blue-400 bg-white">
                            <option value="" selected>Bilinmiyor</option>
                            <option value="Male">Erkek</option>
                            <option value="Female">Kadın</option>
                        </select>
                    </label>
                    <label class="flex flex-col gap-0.5">
                        <span class="text-[10px] font-semibold text-slate-500 uppercase">Doğum Tarihi</span>
                        <input type="text" id="edit-field-birthdate" value="" placeholder="GG.AA.YYYY" class="border border-slate-300 rounded-md px-2 py-1 text-xs outline-none focus:border-blue-400 bg-white">
                    </label>
                    <label class="flex flex-col gap-0.5">
                        <span class="text-[10px] font-semibold text-slate-500 uppercase">Doğum Yeri</span>
                        <input type="text" id="edit-field-birthplace" value="" class="border border-slate-300 rounded-md px-2 py-1 text-xs outline-none focus:border-blue-400 bg-white">
                    </label>
                    <label class="flex flex-col gap-0.5">
                        <span class="text-[10px] font-semibold text-slate-500 uppercase">Ölüm Tarihi</span>
                        <input type="text" id="edit-field-dateofdeath" value="" placeholder="GG.AA.YYYY" class="border border-slate-300 rounded-md px-2 py-1 text-xs outline-none focus:border-blue-400 bg-white">
                    </label>
                    <label class="flex flex-col gap-0.5">
                        <span class="text-[10px] font-semibold text-slate-500 uppercase">Not</span>
                        <textarea id="edit-field-note" rows="3" class="border border-slate-300 rounded-md px-2 py-1 text-xs outline-none focus:border-blue-400 bg-white resize-none"></textarea>
                    </label>
                    <label class="flex flex-col gap-0.5">
                        <span class="text-[10px] font-semibold text-slate-500 uppercase">Ebeveyn 1</span>
                        <select id="edit-field-parent1" class="border border-slate-300 rounded-md px-2 py-1 text-xs outline-none focus:border-blue-400 bg-white">
                            ${buildPersonOptions(-1, null)}
                        </select>
                    </label>
                    <label class="flex flex-col gap-0.5">
                        <span class="text-[10px] font-semibold text-slate-500 uppercase">Ebeveyn 2</span>
                        <select id="edit-field-parent2" class="border border-slate-300 rounded-md px-2 py-1 text-xs outline-none focus:border-blue-400 bg-white">
                            ${buildPersonOptions(-1, null)}
                        </select>
                    </label>
                    <label class="flex flex-col gap-0.5">
                        <span class="text-[10px] font-semibold text-slate-500 uppercase">Eş</span>
                        <select id="edit-field-spouse" class="border border-slate-300 rounded-md px-2 py-1 text-xs outline-none focus:border-blue-400 bg-white">
                            ${buildPersonOptions(-1, null)}
                        </select>
                    </label>
                    <div id="edit-form-error" class="text-[11px] text-red-500 hidden"></div>
                    <div class="flex gap-2 mt-1">
                        <button id="btn-save-details" class="flex-1 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold py-1.5 rounded-md transition-colors cursor-pointer">Ekle</button>
                        <button id="btn-cancel-edit-details" class="flex-1 bg-slate-100 hover:bg-slate-200 text-slate-600 text-xs font-semibold py-1.5 rounded-md transition-colors cursor-pointer">İptal</button>
                    </div>
                </div>`;

            if (btnEditDetails) btnEditDetails.classList.add('hidden');
            if (btnDeleteDetails) btnDeleteDetails.classList.add('hidden');

            showPersonPanel();

            document.getElementById('edit-field-name').focus();
            document.getElementById('btn-cancel-edit-details').addEventListener('click', () => {
                closeDetailsPanel();
            });
            document.getElementById('btn-save-details').addEventListener('click', () => createNewPerson());
        }

        // Reads the create form, posts the new person to the server, then
        // refreshes the tree and shows the freshly created person in view mode.
        async function createNewPerson() {
            const errEl = document.getElementById('edit-form-error');
            const showFormError = (msg) => {
                errEl.textContent = msg;
                errEl.classList.remove('hidden');
            };

            const name = document.getElementById('edit-field-name').value.trim();
            if (!name) {
                showFormError('Ad boş olamaz.');
                return;
            }
            const surname = document.getElementById('edit-field-surname').value.trim();
            const genderStr = document.getElementById('edit-field-gender').value;
            const birthdate = document.getElementById('edit-field-birthdate').value.trim();
            const birthplace = document.getElementById('edit-field-birthplace').value.trim();
            const dateofdeath = document.getElementById('edit-field-dateofdeath').value.trim();
            const note = document.getElementById('edit-field-note').value.trim();
            const genderNum = genderStr === 'Male' ? 1 : genderStr === 'Female' ? 2 : 0;

            const parent1Raw = document.getElementById('edit-field-parent1').value;
            const parent2Raw = document.getElementById('edit-field-parent2').value;
            const parent1Id = parent1Raw ? Number(parent1Raw) : null;
            const parent2Id = parent2Raw ? Number(parent2Raw) : null;
            if (parent1Id !== null && parent2Id !== null && parent1Id === parent2Id) {
                showFormError('Ebeveyn 1 ve Ebeveyn 2 aynı kişi olamaz.');
                return;
            }
            const parentIds = [parent1Id, parent2Id].filter(id => id !== null);

            const spouseRaw = document.getElementById('edit-field-spouse').value;
            const spouseIds = spouseRaw ? [Number(spouseRaw)] : [];

            const saveBtn = document.getElementById('btn-save-details');
            saveBtn.disabled = true;
            saveBtn.textContent = 'Ekleniyor...';

            try {
                const created = await createPerson({
                    name,
                    surname: surname || null,
                    gender: genderNum,
                    birthdate: birthdate || null,
                    birthplace: birthplace || null,
                    dateofdeath: dateofdeath || null,
                    note: note || null,
                    parentIds,
                    spouseIds,
                });

                await refreshTree();

                const newNode = findPersonNode(originalRoots, created.id);
                if (newNode) {
                    showPersonDetailsView({ name: newNode.name, id: newNode.id, photoUrl: newNode.photoUrl, attributes: newNode.attributes });
                } else {
                    closeDetailsPanel();
                }
            } catch (err) {
                showFormError('Ekleme başarısız: ' + err.message);
                saveBtn.disabled = false;
                saveBtn.textContent = 'Ekle';
            }
        }

        if (btnAddPerson) {
            btnAddPerson.addEventListener('click', () => {
                showPersonCreateForm();
            });
        }

        const btnAddRoot = document.getElementById('btn-add-root');
        if (btnAddRoot) {
            btnAddRoot.addEventListener('click', async () => {
                btnAddRoot.disabled = true;
                try {
                    const created = await createRoot({});
                    await refreshTree();
                    const node = findPersonNode(originalRoots, rootNodeId(created.id));
                    if (node) {
                        currentDetailsPersonId = Number(node.id);
                        showRootDetailsEdit(node);
                    }
                } catch (err) {
                    errorOverlay.classList.remove('hidden');
                    errorText.textContent = 'Kök eklenemedi: ' + err.message;
                } finally {
                    btnAddRoot.disabled = false;
                }
            });
        }

        // --- Image export of the currently displayed tree(s) ---
        // Exports whatever is currently rendered inside #tree-transform (the
        // full tree, or just the focused bloodline in focus mode — same as
        // what's on screen) as ONE self-contained SVG file.
        //
        // Vector SVG rather than PNG on purpose: the full tree can be 100k+ px
        // wide, well past the browser <canvas> ceiling (65535 px/side, ~268M px
        // total), so any single raster image of it has to be scaled down — which
        // is exactly what turned the card text to mush. An SVG has no size
        // ceiling and stays razor-sharp at every zoom level.
        //
        // The cards are redrawn from scratch as plain SVG shapes + <text> (not
        // an HTML <foreignObject> snapshot) so the file renders identically in
        // every viewer — browsers, Preview/Quick Look, Illustrator, Inkscape.
        // <foreignObject> would be simpler but Safari/Preview render it blank.


        async function exportTreeImage() {
            if (!treeTransform.querySelector('.tree-node-card')) return; // nothing rendered yet

            const originalBtnHTML = btnExportPng.innerHTML;
            btnExportPng.disabled = true;
            btnExportPng.innerHTML = '<i data-lucide="loader" class="w-5 h-5 animate-spin"></i><span>Hazırlanıyor…</span>';
            createIcons();

            // Snapshot view state, then normalize to scale 1 so the connector
            // coordinates (computed against currentZoom) match the card layout.
            const prevZoom = currentZoom;
            const prevScrollLeft = scrollContainer.scrollLeft;
            const prevScrollTop = scrollContainer.scrollTop;
            currentZoom = 1;
            updateZoomStyle();
            drawCrossTreeLinks();

            try {
                await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

                const cards = [...treeRoot.querySelectorAll('.tree-node-card[data-id]')];

                const p2 = n => String(n).padStart(2, '0');
                const now = new Date();
                const stamp = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`
                    + `-${p2(now.getHours())}-${p2(now.getMinutes())}-${p2(now.getSeconds())}`;
                const baseName = `soyagaci-${stamp}-${cards.length}kisi`;

                // Tight content bounding box — the tree canvas has large empty
                // margins (a lone gen-1 card way off-centre, etc.), and an image
                // viewer opening a 100k-px-wide file lands on that emptiness and
                // looks blank. Trim to what's actually drawn and shift it to the
                // origin. Connector lines run between cards so the card box
                // covers them; a small pad absorbs stroke width and marriage
                // lines that reach a hair past a card edge.
                let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
                for (const card of cards) {
                    const x = card.offsetLeft, y = card.offsetTop;
                    minX = Math.min(minX, x);
                    minY = Math.min(minY, y);
                    maxX = Math.max(maxX, x + card.offsetWidth);
                    maxY = Math.max(maxY, y + card.offsetHeight);
                }
                const pad = 48;
                const contentW = Math.max(1, Math.ceil(maxX - minX + pad * 2));
                const contentH = Math.max(1, Math.ceil(maxY - minY + pad * 2));
                const dx = pad - minX, dy = pad - minY;

                // Cap the file's *declared* pixel size so viewers that rasterise
                // SVG (Preview, Quick Look, Finder) fit the whole tree on screen
                // instead of showing a corner. The viewBox stays full-resolution,
                // so browsers / Illustrator / Inkscape still zoom in perfectly
                // sharp — vector has no real detail limit here.
                const MAX_DISPLAY = 8000;
                const dispScale = Math.min(1, MAX_DISPLAY / Math.max(contentW, contentH));
                const dispW = Math.max(1, Math.round(contentW * dispScale));
                const dispH = Math.max(1, Math.round(contentH * dispScale));

                // Connector layer: already SVG <path>s in tree-transform
                // coordinates, so copy the markup straight across.
                const connectorInner = document.getElementById('cross-tree-links').innerHTML;

                let cardsInner = '';
                for (const card of cards) cardsInner += cardToSvgFragment(card);

                const svg =
`<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${dispW}" height="${dispH}" viewBox="0 0 ${contentW} ${contentH}" font-family="ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif">
<style>.svg-glow-line{stroke-width:4}</style>
<rect x="0" y="0" width="${contentW}" height="${contentH}" fill="#f8fafc"/>
<g transform="translate(${dx} ${dy})">
<g fill="none" stroke-width="2" stroke-linecap="round">
${connectorInner}
</g>
${cardsInner}
</g>
</svg>`;

                triggerDownload(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }), `${baseName}.svg`);
            } catch (err) {
                errorText.textContent = 'Görüntü oluşturulamadı: ' + err.message;
                errorOverlay.classList.remove('hidden');
            } finally {
                currentZoom = prevZoom;
                updateZoomStyle();
                scrollContainer.scrollLeft = prevScrollLeft;
                scrollContainer.scrollTop = prevScrollTop;
                drawCrossTreeLinks();
                drawMinimap();
                btnExportPng.disabled = false;
                btnExportPng.innerHTML = originalBtnHTML;
                createIcons();
            }
        }

        if (btnExportPng) {
            btnExportPng.addEventListener('click', exportTreeImage);
        }

        if (btnDeleteDetails) {
            btnDeleteDetails.addEventListener('click', async () => {
                if (currentDetailsPersonId === null) return;
                const node = findPersonNode(originalRoots, currentDetailsPersonId);
                const isRoot = node && node._isRoot;
                const label = node
                    ? (isRoot ? (node.title || 'ROOT') : `${node.name || ''} ${(node.attributes && node.attributes.surname) || ''}`.trim())
                    : `#${currentDetailsPersonId}`;
                const message = isRoot
                    ? `"${label}" kökünü silmek istediğinize emin misiniz? Altındaki kişiler yeniden kendiliğinden kök olur.`
                    : `"${label}" kişisini silmek istediğinize emin misiniz? Bu işlem, bu kişiyi ebeveyn/eş olarak referans alan bağlantıları da kaldırır.`;
                if (!window.confirm(message)) {
                    return;
                }

                const idToDelete = currentDetailsPersonId;
                btnDeleteDetails.disabled = true;
                try {
                    if (isRoot) await deleteRoot(rootDbId(idToDelete));
                    else await deletePerson(idToDelete);
                    await refreshTree();
                    closeDetailsPanel();
                } catch (err) {
                    errorOverlay.classList.remove('hidden');
                    errorText.textContent = 'Silme başarısız: ' + err.message;
                } finally {
                    btnDeleteDetails.disabled = false;
                }
            });
        }

        // Node selection and bloodline highlighting logic
        treeRoot.addEventListener('click', (e) => {
            const card = e.target.closest('.tree-node-card');
            if (!card) return;

            // While picking the two people for "İki kişi arası bağ", a card
            // click records a pick instead of triggering the bloodline view.
            if (relationshipMode === 'picking') {
                handleRelationshipPick(card);
                return;
            }

            // Kişi "focus" (soy hattı) modunda tüm etkileşimler açık kalır:
            // kart tıklama detay panelini açar, vurguyu günceller, düzenleme/
            // ekleme/silme çalışır. Sadece salt-okunur "İki kişi arası bağ"
            // sonuç görünümü etkileşimleri kapatır.
            if (isFocusMode && relationshipMode === 'showing') return;

            const isAlreadyHighlighted = card.classList.contains('highlighted');
            
            // Clear previous highlights
            document.querySelectorAll('.tree-node-card.highlighted, .tree-node-card.highlighted-gen, .tree-node-card.highlighted-spouse').forEach(el => {
                el.classList.remove('highlighted', 'highlighted-gen', 'highlighted-spouse');
                el.style.removeProperty('--highlight-color');
                el.style.removeProperty('--highlight-shadow');
            });
            
            // Menüdeki (legend) aktif seçimi de temizle
            document.querySelectorAll('.legend-item').forEach(el => {
                el.classList.remove('active-legend', 'bg-slate-100', 'font-semibold', 'text-slate-900');
            });
            
            hidePersonPanel();

            // Highlight logic (toggles off if clicking the currently highlighted card)
            // Note: this only ever highlights/selects — it never re-renders the
            // tree, in focus mode or otherwise. Changing what focus mode shows
            // is solely the Focus toolbar button's job (see toggleFocusMode);
            // a card click just selects within whatever's currently on screen.
            if (!isAlreadyHighlighted) {
                card.classList.add('highlighted');

                // Keep search navigation in sync when the user picks a match
                // by clicking it directly on the canvas instead of using the
                // ileri/geri buttons — otherwise the next button press resumes
                // counting from wherever it was last left (typically back
                // near match #0, which sits at the top-left of the tree),
                // making navigation look like it's yanking the view around.
                const searchIdx = searchResults.indexOf(card);
                if (searchIdx !== -1) currentSearchIndex = searchIdx;

                const gen = parseInt(card.getAttribute('data-generation')) || 1;
                const len = generationColors.length;
                const colorIndex = ((gen - 1) % len + len) % len; // Safe modulo for negative numbers
                const colorObj = generationColors[colorIndex];
                card.style.setProperty('--highlight-color', colorObj.hex);
                card.style.setProperty('--highlight-shadow', `0 0 0 4px ${colorObj.rgba}`);

                const detailsStr = card.getAttribute('data-details');
                if (detailsStr) {
                    try {
                        const details = JSON.parse(detailsStr);
                        if (details.isRoot) showRootDetailsView(details);
                        else showPersonDetailsView(details);
                    } catch (err) {
                        console.error("Failed to parse person details", err);
                    }
                }

                // Pre-compute child map for O(1) descendant lookups
                const childMap = {};
                document.querySelectorAll('.tree-node-card[data-parent-ids]').forEach(el => {
                    const pids = el.getAttribute('data-parent-ids').split(',');
                    pids.forEach(pid => {
                        if (!childMap[pid]) childMap[pid] = [];
                        childMap[pid].push(el);
                    });
                });

                function applyHighlightGen(element) {
                    const gen = parseInt(element.getAttribute('data-generation')) || 1;
                    const len = generationColors.length;
                    const colorIndex = ((gen - 1) % len + len) % len;
                    const colorObj = generationColors[colorIndex];
                    
                    element.classList.add('highlighted-gen');
                    element.style.setProperty('--highlight-color', colorObj.hex);
                    element.style.setProperty('--highlight-shadow', `0 0 0 4px ${colorObj.rgba}`);
                }

                // Recursive function to highlight ancestors
                function highlightAncestors(currentCard) {
                    const parentIdsAttr = currentCard.getAttribute('data-parent-ids');
                    if (parentIdsAttr) {
                        parentIdsAttr.split(',').forEach(pid => {
                            document.querySelectorAll(`.tree-node-card[data-id="${pid}"]`).forEach(parentCard => {
                                if (!parentCard.classList.contains('highlighted-gen')) {
                                    applyHighlightGen(parentCard);
                                    highlightAncestors(parentCard);
                                }
                            });
                        });
                    }
                }
                
                // Recursive function to highlight descendants. Collects every
                // visited descendant card so spouse-highlighting can be limited
                // to the clicked card + its descendants (see below).
                const descendantCards = new Set();
                function highlightDescendants(currentCard) {
                    const currentId = currentCard.getAttribute('data-id');
                    if (!currentId || !childMap[currentId]) return;

                    childMap[currentId].forEach(childCard => {
                        if (!childCard.classList.contains('highlighted-gen')) {
                            applyHighlightGen(childCard);
                            descendantCards.add(childCard);
                            highlightDescendants(childCard);
                        }
                    });
                }
                
                function highlightSpouses(currentCard) {
                    const spouseIdsAttr = currentCard.getAttribute('data-spouse-ids');
                    if (spouseIdsAttr) {
                        spouseIdsAttr.split(',').forEach(sid => {
                            document.querySelectorAll(`.tree-node-card[data-id="${sid}"]`).forEach(spouseCard => {
                                if (!spouseCard.classList.contains('highlighted-gen') && !spouseCard.classList.contains('highlighted') && !spouseCard.classList.contains('highlighted-spouse')) {
                                    spouseCard.classList.add('highlighted-spouse');
                                    
                                    const gen = parseInt(spouseCard.getAttribute('data-generation')) || 1;
                                    const len = generationColors.length;
                                    const colorIndex = ((gen - 1) % len + len) % len;
                                    const colorObj = generationColors[colorIndex];
                                    spouseCard.style.setProperty('--highlight-color', colorObj.hex);
                                    spouseCard.style.setProperty('--highlight-shadow', `0 0 0 4px ${colorObj.rgba}`);
                                }
                            });
                        });
                    }
                }
                
                applyHighlightGen(card);
                highlightAncestors(card);
                highlightDescendants(card);
                
                // Highlight spouses for the clicked card and its descendants only.
                // Ancestors are deliberately skipped: a direct parent is already
                // highlighted via the ancestor walk, and highlighting a parent's
                // *other* spouse (e.g. a second marriage) would wrongly flag a
                // non-parent as part of the selected child's bloodline.
                highlightSpouses(card);
                descendantCards.forEach(hCard => {
                    highlightSpouses(hCard);
                });
                // Bloodline-path glow is drawn as part of the SVG connector lines
                // themselves (drawCrossTreeLinks below checks each edge's endpoints
                // for highlight classes) — no separate DOM-line-walking needed.
            }

            drawMinimap();
            if (typeof drawCrossTreeLinks === 'function') requestAnimationFrame(drawCrossTreeLinks);
        });

        // Close Person Details Panel
        btnCloseDetails.addEventListener('click', async () => {
            // Paneli kapatmak, açık olan her türlü focus görünümünden de çıkarır
            // (salt-okunur bağ görünümü veya düz kişi soy-hattı focus modu).
            // Önce focus'tan çık (tam ağacı yeniden render eder) ki aşağıdaki
            // vurgu temizliği son render'a uygulansın.
            if (isFocusMode) await toggleFocusMode(false);

            document.querySelectorAll('.tree-node-card.highlighted, .tree-node-card.highlighted-gen, .tree-node-card.highlighted-spouse').forEach(el => {
                el.classList.remove('highlighted', 'highlighted-gen', 'highlighted-spouse');
                el.style.removeProperty('--highlight-color');
                el.style.removeProperty('--highlight-shadow');
            });
            
            document.querySelectorAll('.legend-item').forEach(el => {
                el.classList.remove('active-legend', 'bg-slate-100', 'font-semibold', 'text-slate-900');
            });

            hidePersonPanel();

            drawMinimap();
            if (typeof drawCrossTreeLinks === 'function') requestAnimationFrame(drawCrossTreeLinks);
        });

        // Renk (Legend) listesinden jenerasyon seçilince tüm grubu vurgulama
        legendList.addEventListener('click', (e) => {
            if (isFocusMode && relationshipMode === 'showing') return;
            
            const item = e.target.closest('.legend-item');
            if (!item) return;
            
            const targetGen = item.getAttribute('data-gen');
            const isActive = item.classList.contains('active-legend');
            
            // Hem ağaçtaki hem de menüdeki mevcut vurguları temizle
            document.querySelectorAll('.tree-node-card.highlighted, .tree-node-card.highlighted-gen, .tree-node-card.highlighted-spouse').forEach(el => {
                el.classList.remove('highlighted', 'highlighted-gen', 'highlighted-spouse');
                el.style.removeProperty('--highlight-color');
                el.style.removeProperty('--highlight-shadow');
            });
            document.querySelectorAll('.legend-item').forEach(el => {
                el.classList.remove('active-legend', 'bg-slate-100', 'font-semibold', 'text-slate-900');
            });
            
            hidePersonPanel();

            // Eğer daha önceden aktif değilse, listeyi aktif yap ve ilgili jenerasyonu vurgula
            if (!isActive) {
                item.classList.add('active-legend', 'bg-slate-100', 'font-semibold', 'text-slate-900');
                
                document.querySelectorAll(`.tree-node-card[data-generation="${targetGen}"]`).forEach(card => {
                    const targetGenInt = parseInt(targetGen) || 1;
                    const len = generationColors.length;
                    const colorIndex = ((targetGenInt - 1) % len + len) % len;
                    const colorObj = generationColors[colorIndex];
                    card.classList.add('highlighted-gen');
                    card.style.setProperty('--highlight-color', colorObj.hex);
                    card.style.setProperty('--highlight-shadow', `0 0 0 4px ${colorObj.rgba}`);
                });
            }
            
            drawMinimap();
            if (typeof drawCrossTreeLinks === 'function') requestAnimationFrame(drawCrossTreeLinks);
        });

        // --- "İki kişi arası bağ" (relationship path between two people) ---
        // Pick two people from the tree (search + generation legend stay usable
        // for locating them), then render only the chain of relatives that
        // connects them, in the same focus-mode style as the bloodline view.

        function clearPickMarkers() {
            document.querySelectorAll('.tree-node-card.rel-pick').forEach(el => {
                el.classList.remove('rel-pick');
                el.style.removeProperty('--rel-pick-color');
                el.style.removeProperty('--rel-pick-shadow');
            });
        }

        function clearHighlightsAndPanel() {
            document.querySelectorAll('.tree-node-card.highlighted, .tree-node-card.highlighted-gen, .tree-node-card.highlighted-spouse').forEach(el => {
                el.classList.remove('highlighted', 'highlighted-gen', 'highlighted-spouse');
                el.style.removeProperty('--highlight-color');
                el.style.removeProperty('--highlight-shadow');
            });
            document.querySelectorAll('.legend-item').forEach(el => {
                el.classList.remove('active-legend', 'bg-slate-100', 'font-semibold', 'text-slate-900');
            });
            hidePersonPanel();
        }

        function setRelBtnActive(active) {
            btnRelationship.classList.toggle('bg-blue-50', active);
            btnRelationship.classList.toggle('text-blue-600', active);
            btnRelationship.classList.toggle('text-slate-600', !active);
        }

        // Resets only the relationship UI/state (button, status panel, picks).
        // Does NOT re-render the tree — callers that were showing a path handle
        // that (toggleFocusMode already re-renders the full tree on its way out).
        function resetRelationshipUI() {
            relationshipMode = null;
            relPick1 = null;
            relPick2 = null;
            setRelBtnActive(false);
            relationshipStatus.classList.add('hidden');
            relationshipStatus.classList.remove('flex');
            relationshipChain.classList.add('hidden');
            relationshipChain.classList.remove('flex');
            relationshipChain.innerHTML = '';
            clearPickMarkers();
        }

        function personLabel(id) {
            const n = findPersonNode(originalRoots, Number(id));
            if (!n) return `#${id}`;
            if (n._isRoot) return n.title || 'KÖK';
            return `${n.name || ''} ${(n.attributes && n.attributes.surname) || ''}`.trim() || `#${id}`;
        }

        // Undirected adjacency over parent/child, spouse and founding-member ->
        // root edges, keyed by numeric id (root nodes keep their negative id).
        function buildRelationshipGraph() {
            const adj = new Map();
            const link = (a, b) => {
                if (!adj.has(a)) adj.set(a, new Set());
                adj.get(a).add(b);
            };
            const seen = new Set();
            allPersons().forEach(({ person }) => {
                const id = Number(person.id);
                if (seen.has(id)) return;
                seen.add(id);
                if (!adj.has(id)) adj.set(id, new Set());
                (person._parentIds || []).forEach(pid => { link(id, Number(pid)); link(Number(pid), id); });
                (person._spouseIds || []).forEach(sid => { link(id, Number(sid)); link(Number(sid), id); });
                if (person._rootParentId != null) {
                    link(id, Number(person._rootParentId));
                    link(Number(person._rootParentId), id);
                }
            });
            return adj;
        }

        // Shortest chain of ids from aId to bId (inclusive), or null if the two
        // are in unconnected parts of the tree.
        function findRelationshipPath(aId, bId) {
            aId = Number(aId); bId = Number(bId);
            const adj = buildRelationshipGraph();
            if (!adj.has(aId) || !adj.has(bId)) return null;
            const prev = new Map([[aId, null]]);
            const queue = [aId];
            while (queue.length) {
                const cur = queue.shift();
                if (cur === bId) break;
                for (const nxt of (adj.get(cur) || [])) {
                    if (!prev.has(nxt)) { prev.set(nxt, cur); queue.push(nxt); }
                }
            }
            if (!prev.has(bId)) return null;
            const path = [];
            let n = bId;
            while (n !== null && n !== undefined) { path.unshift(n); n = prev.get(n); }
            return path;
        }

        function markPick(card, which) {
            card.classList.add('rel-pick');
            const color = which === 0 ? '#2563eb' : '#16a34a';
            const shadow = which === 0 ? 'rgba(37, 99, 235, 0.35)' : 'rgba(22, 163, 74, 0.35)';
            card.style.setProperty('--rel-pick-color', color);
            card.style.setProperty('--rel-pick-shadow', shadow);
        }

        function handleRelationshipPick(card) {
            const id = Number(card.getAttribute('data-id'));
            if (!id || id < 0) return; // roots / invalid cards can't be an endpoint

            if (relPick1 === null) {
                relPick1 = id;
                markPick(card, 0);
                relationshipInstr.textContent = `1. kişi: ${personLabel(id)}. Şimdi 2. kişiyi seçin.`;
                return;
            }
            if (id === relPick1) { // click the first pick again to undo it
                relPick1 = null;
                clearPickMarkers();
                relationshipInstr.textContent = 'Ağaçtan 1. kişiyi seçin.';
                return;
            }

            relPick2 = id;
            markPick(card, 1);

            const path = findRelationshipPath(relPick1, relPick2);
            if (!path) {
                relationshipInstr.textContent = `${personLabel(relPick1)} ile ${personLabel(relPick2)} arasında bir bağ bulunamadı.`;
                relPick2 = null;
                return;
            }
            showRelationshipView(path);
        }

        async function showRelationshipView(pathIds) {
            relationshipMode = 'showing';
            isFocusMode = true; // reuse focus-mode guards (clicks/legend off) + fit-to-screen zoom

            const ids = pathIds.map(Number);
            const pathSet = new Set(ids);
            const endpoints = new Set([ids[0], ids[ids.length - 1]]);

            // Beyond the connecting chain itself, also show each chain person's
            // spouses and children for context (they render un-highlighted, so
            // the actual path still stands out).
            const childrenOf = new Map();
            const persons = allPersons();
            persons.forEach(({ person }) => {
                (person._parentIds || []).forEach(par => {
                    const k = Number(par);
                    if (!childrenOf.has(k)) childrenOf.set(k, []);
                    childrenOf.get(k).push(Number(person.id));
                });
            });

            const visibleIds = new Set(ids);
            const contextIds = new Set();
            persons.forEach(({ person }) => {
                const pid = Number(person.id);
                if (!pathSet.has(pid)) return;
                (person._spouseIds || []).forEach(s => { visibleIds.add(Number(s)); contextIds.add(Number(s)); });
                (childrenOf.get(pid) || []).forEach(c => { visibleIds.add(c); contextIds.add(c); });
            });
            // A chain person is never merely "context".
            pathSet.forEach(id => contextIds.delete(id));

            clearHighlightsAndPanel();
            await renderTreeFromHierarchy(pruneForFocus(originalRoots, visibleIds));

            document.querySelectorAll('.tree-node-card[data-id]').forEach(cardEl => {
                const cid = Number(cardEl.getAttribute('data-id'));
                if (!pathSet.has(cid)) return; // context spouses/children stay un-highlighted
                const gen = parseInt(cardEl.getAttribute('data-generation')) || 1;
                const len = generationColors.length;
                const colorObj = generationColors[((gen - 1) % len + len) % len];
                cardEl.classList.add(endpoints.has(cid) ? 'highlighted' : 'highlighted-gen');
                cardEl.style.setProperty('--highlight-color', colorObj.hex);
                cardEl.style.setProperty('--highlight-shadow', `0 0 0 4px ${colorObj.rgba}`);
            });
            drawCrossTreeLinks();

            const people = ids.filter(x => x > 0);
            const ctxCount = [...contextIds].filter(x => x > 0).length;
            relationshipInstr.innerHTML = `Bağ gösteriliyor · <b>${people.length} kişilik zincir</b>, ${ids.length - 1} adım`
                + (ctxCount ? ` <span class="text-slate-400">(+${ctxCount} eş/çocuk)</span>` : '')
                + `. Kapatmak için butona ya da "Kapat"a basın.`;
            relationshipChain.innerHTML = ids
                .map((id, i) => {
                    const strong = i === 0 || i === ids.length - 1;
                    return `<span class="${strong ? 'font-semibold text-slate-800' : ''}">${escapeHTML(personLabel(id))}</span>`;
                })
                .join('<span class="text-slate-400 pl-1">↓</span>');
            relationshipChain.classList.remove('hidden');
            relationshipChain.classList.add('flex');

            if (isNarrow()) openToolsDrawer(); // surface the connecting-chain summary in the drawer
            setTimeout(() => {
                updateZoomStyle();
                fitTreeToScreen();
                drawMinimap();
            }, 50);
        }

        async function enterRelationshipPicking() {
            if (isFocusMode) await toggleFocusMode(false);
            clearPickMarkers();
            clearHighlightsAndPanel();
            closeToolsDrawer(); // picking happens by tapping cards on the canvas
            relationshipMode = 'picking';
            relPick1 = null;
            relPick2 = null;
            setRelBtnActive(true);
            relationshipStatus.classList.remove('hidden');
            relationshipStatus.classList.add('flex');
            relationshipChain.classList.add('hidden');
            relationshipChain.classList.remove('flex');
            relationshipInstr.textContent = 'Ağaçtan 1. kişiyi seçin. (Arama ve nesil seçimi de kullanılabilir.)';
        }

        async function exitRelationshipMode() {
            const wasShowing = relationshipMode === 'showing';
            resetRelationshipUI();
            clearHighlightsAndPanel();
            if (wasShowing) {
                isFocusMode = false;
                await renderTreeFromHierarchy(originalRoots);
                drawCrossTreeLinks();
                setTimeout(() => {
                    currentZoom = 1;
                    updateZoomStyle();
                    drawMinimap();
                }, 50);
            }
        }

        btnRelationship.addEventListener('click', async () => {
            if (relationshipMode) await exitRelationshipMode();
            else await enterRelationshipPicking();
        });
        btnRelationshipCancel.addEventListener('click', () => exitRelationshipMode());

        // Drag logic for Minimap
        let isMinimapDragging = false;
        function scrollToMinimapPos(e) {
            const metrics = minimapContainer._metrics;
            if (!metrics) return;
            
            const rect = minimapContainer.getBoundingClientRect();
            const clickX = e.clientX - rect.left;
            const clickY = e.clientY - rect.top;
            
            const targetUnscaledX = (clickX - metrics.offsetX) / metrics.minimapScale;
            const targetUnscaledY = (clickY - metrics.offsetY) / metrics.minimapScale;
            
            const scrollRect = scrollContainer.getBoundingClientRect();
            const unscaledVisibleW = scrollRect.width / currentZoom;
            const unscaledVisibleH = scrollRect.height / currentZoom;
            
            const treeRect = treeTransform.getBoundingClientRect();
            const currentVisibleLeftOnTree = (scrollRect.left - treeRect.left) / currentZoom;
            const currentVisibleTopOnTree = (scrollRect.top - treeRect.top) / currentZoom;
            
            const currentCenterX = currentVisibleLeftOnTree + (unscaledVisibleW / 2);
            const currentCenterY = currentVisibleTopOnTree + (unscaledVisibleH / 2);
            
            scrollContainer.scrollLeft += (targetUnscaledX - currentCenterX) * currentZoom;
            scrollContainer.scrollTop += (targetUnscaledY - currentCenterY) * currentZoom;
        }

        minimapContainer.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            isMinimapDragging = true;
            scrollToMinimapPos(e);
            e.preventDefault(); // prevent selection while dragging map
        });
        window.addEventListener('mouseup', () => { isMinimapDragging = false; });
        window.addEventListener('mousemove', (e) => {
            if (isMinimapDragging) {
                scrollToMinimapPos(e);
                e.preventDefault();
            }
        });

        // --- Search Logic ---
        // Scans the live DOM for cards matching the current search box value
        // and repopulates `searchResults` + the `.search-match` styling.
        // Pulled out of performSearch so a tree re-render (focus mode, "İki
        // kişi arası bağ", etc. all replace treeRoot's innerHTML wholesale)
        // can rebuild the list against the *new* card elements instead of
        // leaving `searchResults` pointing at detached nodes — a detached
        // card's getBoundingClientRect() is all zeros, which used to send
        // scrollCardToCenter's math (and the view) sliding toward the
        // top-left corner every time ileri/geri was pressed afterwards.
        function rebuildSearchMatches() {
            const rawQuery = searchInput.value.trim();
            const query = foldTurkish(rawQuery);
            // Split the query into individual keywords; every keyword must be
            // found somewhere in a person's fields for the card to match. This
            // lets "ahmet yilmaz" match a person whose name is "Ahmet" and
            // surname "Yılmaz" regardless of field order.
            const terms = query.split(/\s+/).filter(Boolean);

            // Temizle butonunu göster/gizle
            if (query.length > 0) {
                btnSearchClear.classList.remove('hidden');
                btnSearchClear.classList.add('flex');
            } else {
                btnSearchClear.classList.add('hidden');
                btnSearchClear.classList.remove('flex');
            }

            document.querySelectorAll('.search-match').forEach(el => {
                el.classList.remove('search-match');
                el.style.removeProperty('--search-color');
            });
            searchResults = [];

            if (!query) return;

            // Focus modundayken arama, o an ağaçta gösterilen (pruned) kartlarla
            // sınırlı kalır — .tree-node-card zaten sadece görünür kişileri
            // içerir, bu yüzden focus modundan çıkmaya gerek yok.
            document.querySelectorAll('.tree-node-card').forEach(card => {
                const detailsStr = card.getAttribute('data-details');
                if (detailsStr) {
                    try {
                        const details = JSON.parse(detailsStr);
                        const attrs = details.attributes || {};
                        const searchableValues = details.isRoot ? [details.title] : [
                            details.name,
                            details.id,
                            attrs.surname,
                            // Explicit "name surname" so full-name queries match
                            // even when keyword splitting isn't enough.
                            `${details.name || ''} ${attrs.surname || ''}`,
                            ...Object.values(attrs)
                        ];

                        const text = foldTurkish(searchableValues.filter(Boolean).join(' '));

                        if (terms.every(term => text.includes(term))) {
                            searchResults.push(card);
                            card.classList.add('search-match');

                            const gen = parseInt(card.getAttribute('data-generation')) || 1;
                            const len = generationColors.length;
                            const colorIndex = ((gen - 1) % len + len) % len;
                            const colorObj = generationColors[colorIndex];
                            card.style.setProperty('--search-color', colorObj.hex);
                        }
                    } catch (e) {}
                }
            });
        }

        function performSearch() {
            rebuildSearchMatches();
            currentSearchIndex = searchResults.length > 0 ? 0 : -1;
            if (searchResults.length > 0) focusSearchResult();
        }

        // Called after every full tree re-render (renderTreeFromHierarchy) so
        // an in-progress search keeps pointing at real, attached cards. Keeps
        // the user's place in the result list (by person id) instead of
        // jumping back to the first match, and — unlike performSearch —
        // never auto-scrolls/clicks, since the re-render already settled its
        // own view (e.g. toggleFocusMode's fitTreeToScreen).
        function refreshSearchAfterRender() {
            if (!searchInput.value.trim()) return;

            const prevId = (currentSearchIndex >= 0 && searchResults[currentSearchIndex])
                ? searchResults[currentSearchIndex].getAttribute('data-id')
                : null;

            rebuildSearchMatches();

            if (searchResults.length === 0) {
                currentSearchIndex = -1;
            } else if (prevId !== null) {
                const sameIndex = searchResults.findIndex(card => card.getAttribute('data-id') === prevId);
                currentSearchIndex = sameIndex !== -1 ? sameIndex : Math.min(currentSearchIndex, searchResults.length - 1);
            } else {
                currentSearchIndex = Math.min(Math.max(currentSearchIndex, 0), searchResults.length - 1);
            }
        }

        // Centers `targetCard` in the scroll viewport (accounting for the
        // current zoom, since tree-transform is what's actually scaled).
        function scrollCardToCenter(targetCard) {
            const cardRect = targetCard.getBoundingClientRect();
            const treeRect = treeTransform.getBoundingClientRect();
            const containerRect = scrollContainer.getBoundingClientRect();

            const cardCenterX = (cardRect.left - treeRect.left) + (cardRect.width / 2);
            const cardCenterY = (cardRect.top - treeRect.top) + (cardRect.height / 2);

            scrollContainer.scrollTo({
                left: cardCenterX - (containerRect.width / 2),
                top: cardCenterY - (containerRect.height / 2),
                behavior: 'smooth'
            });
        }

        function focusSearchResult() {
            if (searchResults.length === 0 || currentSearchIndex < 0) return;

            const targetCard = searchResults[currentSearchIndex];
            scrollCardToCenter(targetCard);

            // Trigger click simulation to show person details perfectly.
            // Skipped while picking the two people for "İki kişi arası bağ" —
            // there a click commits a pick, so let the user click deliberately
            // once search has scrolled the match into view.
            if (!targetCard.classList.contains('highlighted') && relationshipMode !== 'picking') {
                 targetCard.click();
            }
        }

        // Finds the rendered card for a person id (not a root diamond), so
        // the "go to my card" badge click and similar shortcuts can jump to
        // it — null if that person isn't currently rendered (e.g. pruned out
        // by focus mode).
        function findPersonCardEl(personId) {
            const cards = document.querySelectorAll('.tree-node-card[data-details]');
            for (const card of cards) {
                try {
                    const details = JSON.parse(card.getAttribute('data-details'));
                    if (!details.isRoot && Number(details.id) === Number(personId)) return card;
                } catch (e) {}
            }
            return null;
        }

        function goToPersonCard(personId) {
            const card = findPersonCardEl(personId);
            if (!card) return false;
            scrollCardToCenter(card);
            card.click();
            return true;
        }

        function navigateSearch(direction) {
            if (searchResults.length === 0) return;
            currentSearchIndex += direction;
            if (currentSearchIndex < 0) currentSearchIndex = searchResults.length - 1;
            if (currentSearchIndex >= searchResults.length) currentSearchIndex = 0;
            focusSearchResult();
        }

        searchInput.addEventListener('input', performSearch);

        btnSearchClear.addEventListener('click', () => {
            searchInput.value = '';
            performSearch();
            searchInput.focus();
        });
        
        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                navigateSearch(e.shiftKey ? -1 : 1);
            }
        });

        btnSearchPrev.addEventListener('click', () => navigateSearch(-1));
        btnSearchNext.addEventListener('click', () => navigateSearch(1));

        // Cmd+F / Ctrl+F focuses the search box instead of the browser's find bar
        document.addEventListener('keydown', (e) => {
            if ((e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'F')) {
                e.preventDefault();
                searchInput.focus();
                searchInput.select();
                return;
            }

            // Shift+F toggles focus mode, same as the toolbar button — but not
            // while typing in a text field/textarea/select or a contenteditable
            // element.
            if (e.key === 'F' && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
                const tag = (e.target.tagName || '').toLowerCase();
                const isTyping = tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable;
                if (!isTyping) {
                    e.preventDefault();
                    toggleFocusMode();
                }
            }
        });

        // --- Theme toggle (light / dark) ---
        const btnThemeToggle = document.getElementById('btn-theme-toggle');
        function syncThemeIcon() {
            const isDark = document.documentElement.classList.contains('dark');
            btnThemeToggle.innerHTML = `<i data-lucide="${isDark ? 'sun' : 'moon'}" class="w-4 h-4"></i>`;
            createIcons();
        }
        btnThemeToggle.addEventListener('click', () => {
            const isDark = document.documentElement.classList.toggle('dark');
            try { localStorage.setItem('theme', isDark ? 'dark' : 'light'); } catch (e) {}
            syncThemeIcon();
            // The minimap is drawn on a <canvas>, so its colors don't follow CSS.
            drawMinimap();
        });
        syncThemeIcon();

        // --- Auth: login screen, session bootstrap, logout ---
        function showApp() {
            loginOverlay.classList.add('hidden');
            appTreeArea.classList.remove('hidden');
            appSidebar.classList.remove('hidden');
            appSidebar.classList.add('flex');
            if (btnSidebarToggle) btnSidebarToggle.classList.remove('hidden');
        }

        function showLogin() {
            appTreeArea.classList.add('hidden');
            appSidebar.classList.add('hidden');
            appSidebar.classList.remove('flex');
            closeToolsDrawer();
            hidePersonPanel();
            if (btnSidebarToggle) btnSidebarToggle.classList.add('hidden');
            loginOverlay.classList.remove('hidden');
            loginPassword.value = '';
            setTimeout(() => loginUsername.focus(), 0);
        }

        function applyRoleUI() {
            if (btnAddPerson) btnAddPerson.classList.toggle('hidden', !canEditTree());
            if (btnAddRoot) btnAddRoot.classList.toggle('hidden', !canEditTree());
            if (btnAdminPanel) btnAdminPanel.classList.toggle('hidden', currentUserRole !== 'admin');
        }

        async function onAuthenticated(user, { fresh = false } = {}) {
            currentUserRole = user.role;
            currentUserId = user.id;
            currentUserPersonId = user.personId;
            const roleLabel = { admin: 'Admin', editor: 'Editor', viewer: 'Viewer' }[user.role] || user.role;
            currentUserBadge.textContent = `${user.username} · ${roleLabel}`;
            currentUserBadge.classList.toggle('cursor-pointer', currentUserPersonId != null);
            currentUserBadge.classList.toggle('hover:bg-slate-100', currentUserPersonId != null);
            currentUserBadge.title = currentUserPersonId != null ? 'Kendi kartınıza gidin' : '';
            applyRoleUI();
            showApp();
            await loadAndRenderTree();
            // Guided tutorial on every login (not on a silent session restore).
            // Several tour steps point at controls that live in the drawer, so
            // open it first on narrow screens.
            if (fresh) { if (isNarrow()) openToolsDrawer(); startTour(); }
        }

        if (btnHelpTour) btnHelpTour.addEventListener('click', () => { if (isNarrow()) openToolsDrawer(); startTour(); });

        currentUserBadge.addEventListener('click', () => {
            if (currentUserPersonId == null) return;
            goToPersonCard(currentUserPersonId);
        });

        loginForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            loginError.classList.add('hidden');
            btnLoginSubmit.disabled = true;
            btnLoginSubmit.textContent = 'Giriş yapılıyor...';
            try {
                const user = await login(loginUsername.value.trim(), loginPassword.value);
                await onAuthenticated(user, { fresh: true });
            } catch (err) {
                loginError.textContent = err.message;
                loginError.classList.remove('hidden');
            } finally {
                btnLoginSubmit.disabled = false;
                btnLoginSubmit.textContent = 'Giriş Yap';
            }
        });

        btnLogout.addEventListener('click', async () => {
            await logout();
            currentUserRole = 'viewer';
            showLogin();
        });

        // --- Change my own password ---
        function openChangePassword() {
            changePasswordForm.reset();
            changePasswordError.classList.add('hidden');
            changePasswordSuccess.classList.add('hidden');
            changePasswordOverlay.classList.remove('hidden');
            changePasswordOverlay.classList.add('flex');
            changePasswordCurrent.focus();
        }

        function closeChangePassword() {
            changePasswordOverlay.classList.add('hidden');
            changePasswordOverlay.classList.remove('flex');
        }

        btnChangePassword.addEventListener('click', openChangePassword);
        btnChangePasswordClose.addEventListener('click', closeChangePassword);
        changePasswordOverlay.addEventListener('click', (e) => { if (e.target === changePasswordOverlay) closeChangePassword(); });

        changePasswordForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            changePasswordError.classList.add('hidden');
            changePasswordSuccess.classList.add('hidden');

            const current = changePasswordCurrent.value;
            const nextPassword = changePasswordNew.value;
            const confirmPassword = changePasswordConfirm.value;
            if (nextPassword.length < 8) {
                changePasswordError.textContent = 'Yeni şifre en az 8 karakter olmalıdır.';
                changePasswordError.classList.remove('hidden');
                return;
            }
            if (nextPassword !== confirmPassword) {
                changePasswordError.textContent = 'Yeni şifreler eşleşmiyor.';
                changePasswordError.classList.remove('hidden');
                return;
            }

            btnChangePasswordSubmit.disabled = true;
            try {
                await changeMyPassword(current, nextPassword);
                changePasswordSuccess.classList.remove('hidden');
                setTimeout(closeChangePassword, 1200);
            } catch (err) {
                changePasswordError.textContent = err.message;
                changePasswordError.classList.remove('hidden');
            } finally {
                btnChangePasswordSubmit.disabled = false;
            }
        });

        // --- Admin panel: user list, role changes, soyağacı kişisi bağlama ---
        // (an unused, non-root-aware second copy of personLabel used to sit
        // here and, by hoisting, shadow the real one above — the relationship
        // chain then labelled root nodes as "#-1".)

        function populateAdminPersonSelect(selectEl, selectedId) {
            selectEl.innerHTML = buildPersonOptions(null, selectedId);
        }

        async function renderAdminUserList() {
            const users = await listUsers();
            const adminCount = users.filter(x => x.role === 'admin').length;
            adminUserList.innerHTML = '';
            users.forEach(u => {
                const isSelf = Number(u.id) === Number(currentUserId);
                const isLastAdmin = u.role === 'admin' && adminCount <= 1;
                const createdDate = (u.createdAt || '').split(' ')[0];
                const row = document.createElement('div');
                row.className = 'flex flex-col gap-1.5 px-4 py-3 border-b border-slate-200';
                row.innerHTML = `
                    <div class="flex items-center justify-between gap-2">
                        <span class="font-medium text-slate-800 truncate">
                            ${escapeHTML(u.username)}
                            ${isSelf ? '<span class="font-normal text-[10px] text-blue-600">(Siz)</span>' : ''}
                        </span>
                        <div class="flex items-center gap-2 shrink-0">
                            ${createdDate ? `<span class="text-[10px] text-slate-400" title="Hesap oluşturulma tarihi">${escapeHTML(createdDate)}</span>` : ''}
                            <button class="btn-admin-delete p-1 rounded cursor-pointer ${(isSelf || isLastAdmin) ? 'text-slate-300 cursor-not-allowed' : 'text-slate-400 hover:bg-red-50 hover:text-red-500'}" ${(isSelf || isLastAdmin) ? 'disabled' : ''} title="${isSelf ? 'Kendi hesabınızı silemezsiniz' : isLastAdmin ? 'Sistemdeki tek admin — önce başka birini admin yapmadan silinemez' : 'Kullanıcıyı sil'}"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>
                        </div>
                    </div>
                    <div class="flex items-center gap-2">
                        <label class="flex flex-col gap-0.5">
                            <span class="text-[9px] font-semibold text-slate-400 uppercase">Rol</span>
                            <select class="admin-role-select border border-slate-300 rounded-md px-1.5 py-1 text-xs bg-white text-slate-800 outline-none" ${isLastAdmin ? 'disabled title="Sistemdeki tek admin — rolü değiştirilemez"' : ''}>
                                <option value="viewer" ${u.role === 'viewer' ? 'selected' : ''}>Viewer</option>
                                <option value="editor" ${u.role === 'editor' ? 'selected' : ''}>Editor</option>
                                <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Admin</option>
                            </select>
                        </label>
                        <label class="flex-1 min-w-0 flex flex-col gap-0.5">
                            <span class="text-[9px] font-semibold text-slate-400 uppercase">Soyağacındaki Kişi</span>
                            <select class="admin-person-select w-full border border-slate-300 rounded-md px-1.5 py-1 text-xs bg-white text-slate-800 outline-none"></select>
                        </label>
                    </div>
                    <button type="button" class="btn-admin-reset-password self-start text-[10px] text-blue-600 hover:underline cursor-pointer">Şifre sıfırla</button>
                    <div class="admin-reset-password-box hidden flex gap-2">
                        <input type="password" class="admin-reset-password-input flex-1 min-w-0 border border-slate-300 rounded-md px-2 py-1 text-xs outline-none focus:border-blue-400 bg-white text-slate-800" placeholder="Yeni şifre (en az 8 karakter)">
                        <button type="button" class="btn-admin-reset-password-save bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold px-3 rounded-md cursor-pointer shrink-0">Kaydet</button>
                    </div>
                    <div class="admin-row-error text-[10px] text-red-500 hidden"></div>
                `;
                const personSelect = row.querySelector('.admin-person-select');
                populateAdminPersonSelect(personSelect, u.personId);
                const errEl = row.querySelector('.admin-row-error');
                const showRowError = (msg) => { errEl.textContent = msg; errEl.classList.remove('hidden'); };

                const resetBox = row.querySelector('.admin-reset-password-box');
                const resetInput = row.querySelector('.admin-reset-password-input');
                row.querySelector('.btn-admin-reset-password').addEventListener('click', () => {
                    resetBox.classList.toggle('hidden');
                    resetBox.classList.toggle('flex');
                    if (!resetBox.classList.contains('hidden')) resetInput.focus();
                });
                row.querySelector('.btn-admin-reset-password-save').addEventListener('click', async () => {
                    const newPassword = resetInput.value;
                    if (newPassword.length < 8) {
                        showRowError('Şifre en az 8 karakter olmalıdır.');
                        return;
                    }
                    try {
                        await updateUser(u.id, { password: newPassword });
                        errEl.classList.add('hidden');
                        resetInput.value = '';
                        resetBox.classList.add('hidden');
                        resetBox.classList.remove('flex');
                    } catch (err) {
                        showRowError(err.message);
                    }
                });

                row.querySelector('.admin-role-select').addEventListener('change', async (e) => {
                    try {
                        await updateUser(u.id, { role: e.target.value });
                        errEl.classList.add('hidden');
                    } catch (err) {
                        e.target.value = u.role;
                        showRowError(err.message);
                    }
                });
                personSelect.addEventListener('change', async (e) => {
                    const personId = e.target.value ? Number(e.target.value) : null;
                    try {
                        await updateUser(u.id, { personId });
                        errEl.classList.add('hidden');
                    } catch (err) {
                        populateAdminPersonSelect(personSelect, u.personId);
                        showRowError(err.message);
                    }
                });
                row.querySelector('.btn-admin-delete').addEventListener('click', async () => {
                    if (!confirm(`"${u.username}" kullanıcısını silmek istediğinize emin misiniz?`)) return;
                    try {
                        await deleteUser(u.id);
                        await renderAdminUserList();
                    } catch (err) {
                        showRowError(err.message);
                    }
                });

                adminUserList.appendChild(row);
            });
            createIcons();
        }

        async function openAdminPanel() {
            adminAddError.classList.add('hidden');
            adminNewUsername.value = '';
            adminNewPassword.value = '';
            adminNewRole.value = 'viewer';
            populateAdminPersonSelect(adminNewPerson, null);
            adminPanelOverlay.classList.remove('hidden');
            adminPanelOverlay.classList.add('flex');
            try {
                await renderAdminUserList();
            } catch (err) {
                adminAddError.textContent = err.message;
                adminAddError.classList.remove('hidden');
            }
        }

        function closeAdminPanel() {
            adminPanelOverlay.classList.add('hidden');
            adminPanelOverlay.classList.remove('flex');
        }

        if (btnAdminPanel) btnAdminPanel.addEventListener('click', openAdminPanel);
        if (btnAdminPanelClose) btnAdminPanelClose.addEventListener('click', closeAdminPanel);
        adminPanelOverlay.addEventListener('click', (e) => { if (e.target === adminPanelOverlay) closeAdminPanel(); });

        btnAdminAddUser.addEventListener('click', async () => {
            adminAddError.classList.add('hidden');
            const username = adminNewUsername.value.trim();
            const password = adminNewPassword.value;
            const role = adminNewRole.value;
            const personId = adminNewPerson.value ? Number(adminNewPerson.value) : null;
            btnAdminAddUser.disabled = true;
            try {
                await createUser({ username, password, role, personId });
                adminNewUsername.value = '';
                adminNewPassword.value = '';
                adminNewRole.value = 'viewer';
                populateAdminPersonSelect(adminNewPerson, null);
                await renderAdminUserList();
            } catch (err) {
                adminAddError.textContent = err.message;
                adminAddError.classList.remove('hidden');
            } finally {
                btnAdminAddUser.disabled = false;
            }
        });

        // Initial Execution: only reveal the app once a session is confirmed.
        (async () => {
            try {
                const user = await getMe();
                if (user) {
                    await onAuthenticated(user);
                } else {
                    showLogin();
                }
            } catch (err) {
                showLogin();
            }
        })();
    });
