// Configuration for loading sql.js wasm
const sqlConfig = {
    locateFile: filename => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/${filename}`
};

function mapResults(res) {
    if (!res || res.length === 0) return [];
    const columns = res[0].columns;
    return res[0].values.map(row => {
        const obj = {};
        columns.forEach((col, i) => obj[col] = row[i]);
        return obj;
    });
}

// Initialize the Database and UI
initSqlJs(sqlConfig).then(function(SQL) {
    fetch('data.sqlite')
        .then(res => {
            if (!res.ok) throw new Error("Could not load data.sqlite");
            return res.arrayBuffer();
        })
        .then(buf => {
            const db = new SQL.Database(new Uint8Array(buf));
            buildTree(db);
            
            // Hide Loader
            const loader = document.getElementById('loader');
            loader.style.opacity = '0';
            setTimeout(() => loader.style.display = 'none', 500);
        })
        .catch(err => {
            console.error(err);
            document.getElementById('loader-text').innerText = "Error loading database: " + err.message;
        });
});

let d3zoom;

function buildTree(db) {
    // 1. Query Data
    const people = mapResults(db.exec("SELECT * FROM People"));
    const parents = mapResults(db.exec("SELECT * FROM Parents"));
    const spouses = mapResults(db.exec("SELECT * FROM Spouses"));

    // 2. Initialize ELK Graph
    const elk = new ELK();
    const graph = {
        id: "root",
        layoutOptions: {
            'elk.algorithm': 'layered',
            'elk.direction': 'DOWN',
            'elk.edgeRouting': 'ORTHOGONAL',
            'elk.spacing.nodeNode': '100',
            'elk.layered.spacing.nodeNodeBetweenLayers': '120'
        },
        children: [],
        edges: []
    };

    // 3. Add People Nodes
    const peopleMap = new Map();
    people.forEach(p => {
        peopleMap.set(p.id, p);
        graph.children.push({ 
            id: `p_${p.id}`,
            width: 260, // Width including padding
            height: 140, // Approximate height
            type: 'person', 
            data: p 
        });
    });

    // Helper for Spouses / Parents unions
    const unions = new Map();
    let edgeCounter = 0;
    
    function getUnionId(p1, p2) {
        if (!p1 && !p2) return null;
        
        let sorted;
        if (!p2) {
            sorted = `${p1}_single`;
        } else if (!p1) {
            sorted = `${p2}_single`;
        } else {
            // Ensure consistent ID regardless of order
            sorted = [p1, p2].sort((a,b) => a-b).join('_');
        }
        
        const uId = `u_${sorted}`;
        
        if (!unions.has(sorted)) {
            unions.set(sorted, uId);
            graph.children.push({ id: uId, width: 4, height: 4, type: 'union' });
            
            // Link both spouses to the union node
            if (p1 && peopleMap.has(p1)) {
                graph.edges.push({ id: `e_${edgeCounter++}`, sources: [`p_${p1}`], targets: [uId] });
            }
            if (p2 && peopleMap.has(p2)) {
                graph.edges.push({ id: `e_${edgeCounter++}`, sources: [`p_${p2}`], targets: [uId] });
            }
        }
        return uId;
    }

    // 4. Add Spouse Unions
    spouses.forEach(s => {
        // Only process if both spouses actually exist in People table
        if (peopleMap.has(s.spouse1Id) && peopleMap.has(s.spouse2Id)) {
            getUnionId(s.spouse1Id, s.spouse2Id);
        }
    });

    // 5. Add Parent-Child Relationships
    parents.forEach(p => {
        if (!peopleMap.has(p.childId)) return; // Skip if child doesn't exist
        
        const childId = `p_${p.childId}`;
        const uId = getUnionId(p.parent1Id, p.parent2Id);
        
        if (uId) {
            graph.edges.push({ id: `e_${edgeCounter++}`, sources: [uId], targets: [childId] });
        }
    });

    // 6. Compute Layout with ELK
    elk.layout(graph).then(layoutedGraph => {
        // 7. Render
        const nodesLayer = document.getElementById('nodes-layer');
        const svgLayer = d3.select('#svg-layer');

        // Draw Edges (Lines)
        const lineGenerator = d3.line()
            .x(d => d.x)
            .y(d => d.y)
            .curve(d3.curveLinear); // ELK ORTHOGONAL routing produces sharp corners automatically

        layoutedGraph.edges.forEach(edge => {
            if (edge.sections) {
                edge.sections.forEach(section => {
                    const points = [section.startPoint];
                    if (section.bendPoints) {
                        points.push(...section.bendPoints);
                    }
                    points.push(section.endPoint);
                    
                    svgLayer.append('path')
                        .attr('class', 'edge-path')
                        .attr('d', lineGenerator(points));
                });
            }
        });

        // Draw Nodes (HTML Cards)
        layoutedGraph.children.forEach(node => {
            // ELK returns x, y as top-left, but CSS uses center translation (-50%, -50%)
            // So we provide the center coordinates to match CSS.
            const centerX = node.x + node.width / 2;
            const centerY = node.y + node.height / 2;

            if (node.type === 'union') {
                const div = document.createElement('div');
                div.className = 'node union-node';
                div.style.left = centerX + 'px';
                div.style.top = centerY + 'px';
                nodesLayer.appendChild(div);
            } else if (node.type === 'person') {
                const p = node.data;
                const div = document.createElement('div');
                div.className = `node person-card gender-${p.gender}`;
                div.style.left = centerX + 'px';
                div.style.top = centerY + 'px';
                
                const fullname = `${p.name || ''} ${p.surname || ''}`.trim();
                div.dataset.id = p.id;
                div.dataset.searchstr = fullname.toLowerCase();
                div.dataset.raw = JSON.stringify(p);
                div.dataset.centerx = centerX;
                div.dataset.centery = centerY;
                
                const initials = p.name ? p.name.charAt(0).toUpperCase() : '?';
                
                // Format dates simply
                const birth = p.birthdate ? new Date(p.birthdate).toLocaleDateString() : 'Unknown date';
                
                let html = `
                    <div class="avatar">${initials}</div>
                    <h3 class="name">${fullname}</h3>
                    <p class="details">🎂 ${birth}</p>
                `;
                
                if (p.birthplace) {
                    html += `<p class="details">📍 ${p.birthplace}</p>`;
                }
                if (p.note) {
                    html += `<p class="details" style="margin-top: 6px; font-style: italic; opacity: 0.8;">${p.note}</p>`;
                }
                
                div.innerHTML = html;
                nodesLayer.appendChild(div);
            }
        });

        // 8. Setup Zoom and Panning
        const container = d3.select('#tree-container');
        const canvas = d3.select('#canvas');

        d3zoom = d3.zoom()
            .scaleExtent([0.05, 3])
            .on('zoom', (event) => {
                canvas.style('transform', `translate(${event.transform.x}px, ${event.transform.y}px) scale(${event.transform.k})`);
            });

        container.call(d3zoom);
        
        // Initial Fit to Screen
        fitToScreen(layoutedGraph.children);

        // Setup UI Controls (re-clone to remove old listeners)
        const setupBtn = (id, action) => {
            const btn = document.getElementById(id);
            const newBtn = btn.cloneNode(true);
            btn.parentNode.replaceChild(newBtn, btn);
            newBtn.addEventListener('click', action);
        };

        setupBtn('btn-zoom-in', () => container.transition().duration(300).call(d3zoom.scaleBy, 1.3));
        setupBtn('btn-zoom-out', () => container.transition().duration(300).call(d3zoom.scaleBy, 0.7));
        setupBtn('btn-fit', () => fitToScreen(layoutedGraph.children));
    }).catch(console.error);
}

function fitToScreen(nodes) {
    const containerEl = document.getElementById('tree-container');
    const width = containerEl.clientWidth;
    const height = containerEl.clientHeight;
    
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    nodes.forEach(node => {
        if (node.x !== undefined && node.y !== undefined) {
            const w = node.width || 0;
            const h = node.height || 0;
            minX = Math.min(minX, node.x);
            maxX = Math.max(maxX, node.x + w);
            minY = Math.min(minY, node.y);
            maxY = Math.max(maxY, node.y + h);
        }
    });
    
    // If graph is empty, do nothing
    if (minX === Infinity) return;

    // Add padding
    minX -= 50; maxX += 50;
    minY -= 50; maxY += 50;

    const dx = maxX - minX;
    const dy = maxY - minY;
    const x = (minX + maxX) / 2;
    const y = (minY + maxY) / 2;
    
    const scale = Math.max(0.05, Math.min(1.5, 0.9 / Math.max(dx / width, dy / height)));
    const translate = [width / 2 - scale * x, height / 2 - scale * y];
    
    d3.select('#tree-container').transition().duration(750).call(
        d3zoom.transform, 
        d3.zoomIdentity.translate(translate[0], translate[1]).scale(scale)
    );
}

// ==========================================
// Interaction Logic (Search & Click)
// ==========================================

let searchResults = [];
let currentSearchIndex = -1;

function centerOnCoordinates(x, y, scale = 1.2) {
    const containerEl = document.getElementById('tree-container');
    const width = containerEl.clientWidth;
    const height = containerEl.clientHeight;
    
    const translate = [width / 2 - scale * x, height / 2 - scale * y];
    
    d3.select('#tree-container').transition().duration(500).call(
        d3zoom.transform, 
        d3.zoomIdentity.translate(translate[0], translate[1]).scale(scale)
    );
}

document.addEventListener('DOMContentLoaded', () => {
    const searchInput = document.getElementById('search-input');
    const btnSearchClear = document.getElementById('btn-search-clear');
    const btnSearchPrev = document.getElementById('btn-search-prev');
    const btnSearchNext = document.getElementById('btn-search-next');
    
    const detailsPanel = document.getElementById('details-panel');
    const detailsContent = document.getElementById('details-content');
    const btnCloseDetails = document.getElementById('btn-close-details');
    
    // Focus search on matching query
    function performSearch() {
        const query = searchInput.value.toLowerCase().trim();
        
        // Clear old marks
        document.querySelectorAll('.search-match').forEach(el => el.classList.remove('search-match'));
        searchResults = [];
        currentSearchIndex = -1;
        
        if (!query) {
            btnSearchClear.style.display = 'none';
            return;
        }
        
        btnSearchClear.style.display = 'flex';
        
        // Find matches
        document.querySelectorAll('.person-card').forEach(card => {
            if (card.dataset.searchstr && card.dataset.searchstr.includes(query)) {
                card.classList.add('search-match');
                searchResults.push(card);
            }
        });
        
        if (searchResults.length > 0) {
            navigateSearch(0);
        }
    }
    
    function navigateSearch(offset) {
        if (searchResults.length === 0) return;
        
        currentSearchIndex += offset;
        if (currentSearchIndex >= searchResults.length) currentSearchIndex = 0;
        if (currentSearchIndex < 0) currentSearchIndex = searchResults.length - 1;
        
        const target = searchResults[currentSearchIndex];
        const cx = parseFloat(target.dataset.centerx);
        const cy = parseFloat(target.dataset.centery);
        
        centerOnCoordinates(cx, cy);
    }
    
    searchInput.addEventListener('input', performSearch);
    btnSearchPrev.addEventListener('click', () => navigateSearch(-1));
    btnSearchNext.addEventListener('click', () => navigateSearch(1));
    btnSearchClear.addEventListener('click', () => {
        searchInput.value = '';
        performSearch();
    });
    
    // Node clicking logic
    document.getElementById('tree-container').addEventListener('click', (e) => {
        const card = e.target.closest('.person-card');
        if (!card) return;
        
        // Clear previous selected
        document.querySelectorAll('.selected-node').forEach(el => el.classList.remove('selected-node'));
        card.classList.add('selected-node');
        
        // Center camera
        const cx = parseFloat(card.dataset.centerx);
        const cy = parseFloat(card.dataset.centery);
        centerOnCoordinates(cx, cy);
        
        // Populate Details
        try {
            const p = JSON.parse(card.dataset.raw);
            const fullname = `${p.name || ''} ${p.surname || ''}`.trim();
            const birth = p.birthdate ? new Date(p.birthdate).toLocaleDateString() : 'Bilinmiyor';
            
            let html = `
                <div style="font-size: 18px; font-weight: 600; color: white;">${fullname}</div>
                <div style="font-size: 11px; color: var(--text-secondary); font-family: monospace;">ID: ${p.id}</div>
                
                <div style="margin-top: 10px; display: flex; flex-direction: column; gap: 8px;">
                    <div style="background: rgba(255,255,255,0.05); padding: 8px 12px; border-radius: 8px; border: 1px solid var(--card-border);">
                        <div style="font-size: 10px; text-transform: uppercase; color: var(--text-secondary); margin-bottom: 2px;">Cinsiyet</div>
                        <div>${p.gender === 1 ? 'Erkek' : p.gender === 2 ? 'Kadın' : 'Bilinmiyor'}</div>
                    </div>
                    
                    <div style="background: rgba(255,255,255,0.05); padding: 8px 12px; border-radius: 8px; border: 1px solid var(--card-border);">
                        <div style="font-size: 10px; text-transform: uppercase; color: var(--text-secondary); margin-bottom: 2px;">Doğum Tarihi</div>
                        <div>${birth}</div>
                    </div>
            `;
            
            if (p.birthplace) {
                html += `
                    <div style="background: rgba(255,255,255,0.05); padding: 8px 12px; border-radius: 8px; border: 1px solid var(--card-border);">
                        <div style="font-size: 10px; text-transform: uppercase; color: var(--text-secondary); margin-bottom: 2px;">Doğum Yeri</div>
                        <div>${p.birthplace}</div>
                    </div>
                `;
            }
            
            if (p.note) {
                html += `
                    <div style="background: rgba(245, 158, 11, 0.1); padding: 8px 12px; border-radius: 8px; border: 1px solid rgba(245, 158, 11, 0.2);">
                        <div style="font-size: 10px; text-transform: uppercase; color: #fcd34d; margin-bottom: 2px;">Not</div>
                        <div style="color: #fde68a;">${p.note}</div>
                    </div>
                `;
            }
            
            html += `</div>`;
            
            detailsContent.innerHTML = html;
            detailsPanel.style.display = 'flex';
            
        } catch (err) {
            console.error("Failed to parse node data", err);
        }
    });
    
    btnCloseDetails.addEventListener('click', () => {
        detailsPanel.style.display = 'none';
        document.querySelectorAll('.selected-node').forEach(el => el.classList.remove('selected-node'));
    });
});

