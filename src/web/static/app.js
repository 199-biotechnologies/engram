/**
 * Engram Web Interface
 * Modern vanilla JavaScript - no build step required
 */

const API_BASE = '';

// ============ State ============
let currentView = 'memories';
let editingMemoryId = null;
let memoriesOffset = 0;
const MEMORIES_PAGE_SIZE = 25;

// ============ DOM Elements ============
const views = {
  memories: document.getElementById('memories-view'),
  entities: document.getElementById('entities-view'),
  graph: document.getElementById('graph-view'),
  consolidation: document.getElementById('consolidation-view'),
  settings: document.getElementById('settings-view'),
};

const viewTitles = {
  memories: 'Memories',
  entities: 'Entities',
  graph: 'Knowledge Graph',
  consolidation: 'Consolidation',
  settings: 'Settings',
};

// Sidebar elements
const sidebar = document.getElementById('sidebar');
const sidebarToggle = document.getElementById('sidebar-toggle');

// Stats elements
const statMemories = document.getElementById('stat-memories');
const statEntities = document.getElementById('stat-entities');
const statRelations = document.getElementById('stat-relations');

// Header elements
const viewTitle = document.getElementById('view-title');
const searchInput = document.getElementById('search-input');
const headerSearch = document.getElementById('header-search');

// List containers
const memoriesList = document.getElementById('memories-list');
const entitiesList = document.getElementById('entities-list');
const graphContainer = document.getElementById('graph-container');

// Filters
const entityTypeFilter = document.getElementById('entity-type-filter');

// Modal elements
const modal = document.getElementById('modal');
const modalTitle = document.getElementById('modal-title');
const modalForm = document.getElementById('modal-form');
const modalContentInput = document.getElementById('modal-content-input');
const modalSource = document.getElementById('modal-source');
const modalImportance = document.getElementById('modal-importance');
const importanceValue = document.getElementById('importance-value');

const entityModal = document.getElementById('entity-modal');
const entityModalTitle = document.getElementById('entity-modal-title');
const entityModalBody = document.getElementById('entity-modal-body');

// Theme elements
const themeToggle = document.getElementById('theme-toggle');
const themeSelect = document.getElementById('theme-select');

// ============ Theme Management ============
function initTheme() {
  const savedTheme = localStorage.getItem('engram-theme') || 'system';
  applyTheme(savedTheme);
  if (themeSelect) {
    themeSelect.value = savedTheme;
  }
}

function applyTheme(theme) {
  if (theme === 'system') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', theme);
  }
  localStorage.setItem('engram-theme', theme);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;

  // Determine current effective theme
  let effectiveDark = current === 'dark' || (current !== 'light' && prefersDark);

  // Toggle to opposite
  const newTheme = effectiveDark ? 'light' : 'dark';
  applyTheme(newTheme);

  if (themeSelect) {
    themeSelect.value = newTheme;
  }
}

// Theme event listeners
if (themeToggle) {
  themeToggle.addEventListener('click', toggleTheme);
}

if (themeSelect) {
  themeSelect.addEventListener('change', (e) => {
    applyTheme(e.target.value);
  });
}

// ============ Sidebar Management ============
function initSidebar() {
  const collapsed = localStorage.getItem('engram-sidebar-collapsed') === 'true';
  if (collapsed) {
    sidebar.classList.add('collapsed');
    document.body.classList.add('sidebar-collapsed');
  }
}

function toggleSidebar() {
  sidebar.classList.toggle('collapsed');
  document.body.classList.toggle('sidebar-collapsed');
  localStorage.setItem('engram-sidebar-collapsed', sidebar.classList.contains('collapsed'));
}

if (sidebarToggle) {
  sidebarToggle.addEventListener('click', toggleSidebar);
}

// ============ API Helper ============
async function api(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  return res.json();
}

// ============ Utilities ============
function formatDate(dateStr) {
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ============ Stats ============
async function loadStats() {
  try {
    const stats = await api('/api/stats');
    if (statMemories) statMemories.textContent = stats.memories.toLocaleString();
    if (statEntities) statEntities.textContent = stats.entities.toLocaleString();
    if (statRelations) statRelations.textContent = stats.relations.toLocaleString();

    // Update consolidation badge
    const badge = document.getElementById('consolidation-badge');
    if (badge && stats.contradictions > 0) {
      badge.textContent = stats.contradictions;
      badge.style.display = 'inline-flex';
    } else if (badge) {
      badge.style.display = 'none';
    }
  } catch (e) {
    console.error('Failed to load stats', e);
  }
}

// ============ Memories ============
async function loadMemories(query = '', append = false) {
  if (!append) {
    memoriesOffset = 0;
  }

  const limit = MEMORIES_PAGE_SIZE;
  let path;
  if (query) {
    path = `/api/memories?q=${encodeURIComponent(query)}&limit=${limit}`;
  } else {
    path = `/api/memories?limit=${limit}&offset=${memoriesOffset}`;
  }

  const data = await api(path);

  if (data.memories.length === 0 && !append) {
    memoriesList.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/>
          <path d="M3.29 7L12 12l8.71-5M12 22V12"/>
        </svg>
        <h3>No memories found</h3>
        <p>${query ? 'Try a different search term' : 'Add your first memory to get started'}</p>
      </div>
    `;
    return;
  }

  const memoriesHtml = data.memories.map(m => `
    <div class="list-item memory-item" data-id="${m.id}">
      <div class="content">${escapeHtml(m.content)}</div>
      <div class="meta">
        <span class="meta-item">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
            <path d="M16 2v4M8 2v4M3 10h18"/>
          </svg>
          ${formatDate(m.timestamp)}
        </span>
        <span class="meta-item">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/>
            <circle cx="12" cy="7" r="4"/>
          </svg>
          ${escapeHtml(m.source)}
        </span>
        ${m.score ? `<span class="score-badge">${m.score.toFixed(4)}</span>` : ''}
      </div>
      <div class="actions">
        <button class="btn btn-sm btn-secondary edit-btn" data-id="${m.id}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
            <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
          </svg>
          Edit
        </button>
        <button class="btn btn-sm btn-ghost delete-btn" data-id="${m.id}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
          </svg>
          Delete
        </button>
      </div>
    </div>
  `).join('');

  if (append) {
    const oldLoadMore = memoriesList.querySelector('.load-more-container');
    if (oldLoadMore) oldLoadMore.remove();
    memoriesList.insertAdjacentHTML('beforeend', memoriesHtml);
  } else {
    memoriesList.innerHTML = memoriesHtml;
  }

  // Add "Load More" button
  if (!query && data.memories.length === MEMORIES_PAGE_SIZE) {
    memoriesList.insertAdjacentHTML('beforeend', `
      <div class="load-more-container">
        <button class="btn btn-secondary load-more-btn">Load More</button>
      </div>
    `);
    memoriesList.querySelector('.load-more-btn').addEventListener('click', () => {
      memoriesOffset += MEMORIES_PAGE_SIZE;
      loadMemories('', true);
    });
  }

  // Attach event listeners
  memoriesList.querySelectorAll('.edit-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      editMemory(btn.dataset.id);
    });
  });

  memoriesList.querySelectorAll('.delete-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteMemory(btn.dataset.id);
    });
  });
}

// ============ Entities ============
async function loadEntities(type = '') {
  const path = type ? `/api/entities?type=${type}` : '/api/entities';
  const data = await api(path);

  if (data.entities.length === 0) {
    entitiesList.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2"/>
          <circle cx="9" cy="7" r="4"/>
          <path d="M23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75"/>
        </svg>
        <h3>No entities found</h3>
        <p>Entities are extracted automatically from memories</p>
      </div>
    `;
    return;
  }

  entitiesList.innerHTML = data.entities.map(e => `
    <div class="list-item entity-item clickable" data-name="${escapeHtml(e.name)}">
      <div class="entity-name">${escapeHtml(e.name)}</div>
      <div class="entity-type">
        ${getEntityIcon(e.type)}
        ${e.type}
      </div>
    </div>
  `).join('');

  entitiesList.querySelectorAll('.entity-item').forEach(item => {
    item.addEventListener('click', () => {
      showEntityDetails(item.dataset.name);
    });
  });
}

function getEntityIcon(type) {
  const icons = {
    person: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
    organization: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 21h18M9 8h1M9 12h1M9 16h1M14 8h1M14 12h1M14 16h1M5 21V5a2 2 0 012-2h10a2 2 0 012 2v16"/></svg>',
    place: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>',
    concept: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3M12 17h.01"/></svg>',
    event: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>',
  };
  return icons[type] || icons.concept;
}

// ============ Entity Details ============
async function showEntityDetails(name) {
  const data = await api(`/api/entities/${encodeURIComponent(name)}`);

  entityModalTitle.textContent = data.name;

  let html = `
    <div class="entity-type">
      ${getEntityIcon(data.type)}
      ${data.type}
    </div>
  `;

  if (data.observations && data.observations.length > 0) {
    html += `<h3>Observations</h3><ul>`;
    data.observations.forEach(o => {
      html += `<li>${escapeHtml(o.content)}</li>`;
    });
    html += `</ul>`;
  }

  if (data.relationsFrom && data.relationsFrom.length > 0) {
    html += `<h3>Relationships (outgoing)</h3><ul>`;
    data.relationsFrom.forEach(r => {
      html += `<li><span class="text-accent">${r.type}</span> → ${escapeHtml(r.targetEntity?.name || r.to)}</li>`;
    });
    html += `</ul>`;
  }

  if (data.relationsTo && data.relationsTo.length > 0) {
    html += `<h3>Relationships (incoming)</h3><ul>`;
    data.relationsTo.forEach(r => {
      html += `<li>${escapeHtml(r.sourceEntity?.name || r.from)} → <span class="text-accent">${r.type}</span></li>`;
    });
    html += `</ul>`;
  }

  entityModalBody.innerHTML = html;
  entityModal.classList.remove('hidden');
}

// ============ Graph ============
async function loadGraph() {
  const data = await api('/api/graph');

  if (data.nodes.length === 0) {
    graphContainer.innerHTML = `
      <div class="empty-state">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <circle cx="18" cy="5" r="3"/>
          <circle cx="6" cy="12" r="3"/>
          <circle cx="18" cy="19" r="3"/>
          <path d="M8.59 13.51l6.82 3.98M15.41 6.51l-6.82 3.98"/>
        </svg>
        <h3>No graph data</h3>
        <p>Add memories with entities to build your knowledge graph</p>
      </div>
    `;
    return;
  }

  // Group nodes by type
  const byType = {};
  data.nodes.forEach(n => {
    if (!byType[n.type]) byType[n.type] = [];
    byType[n.type].push(n);
  });

  let html = '<div style="padding: 24px;">';
  html += '<p class="text-muted" style="margin-bottom: 24px;">Knowledge graph visualization. Click entities to see details.</p>';

  for (const [type, nodes] of Object.entries(byType)) {
    html += `
      <div style="margin-bottom: 24px;">
        <h3 style="font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-tertiary); margin-bottom: 12px;">${type}</h3>
        <div style="display: flex; flex-wrap: wrap; gap: 8px;">
    `;
    nodes.forEach(n => {
      html += `<button class="btn btn-sm btn-secondary graph-node" data-name="${escapeHtml(n.label)}">${escapeHtml(n.label)}</button>`;
    });
    html += '</div></div>';
  }

  if (data.edges.length > 0) {
    html += `
      <div style="margin-top: 32px;">
        <h3 style="font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-tertiary); margin-bottom: 12px;">Relationships</h3>
        <div class="list">
    `;
    data.edges.slice(0, 50).forEach(e => {
      const fromNode = data.nodes.find(n => n.id === e.from);
      const toNode = data.nodes.find(n => n.id === e.to);
      if (fromNode && toNode) {
        html += `
          <div class="list-item" style="padding: 12px 16px;">
            <span>${escapeHtml(fromNode.label)}</span>
            <span class="text-accent" style="margin: 0 8px;">→ ${e.label} →</span>
            <span>${escapeHtml(toNode.label)}</span>
          </div>
        `;
      }
    });
    html += '</div></div>';
  }

  html += '</div>';
  graphContainer.innerHTML = html;

  graphContainer.querySelectorAll('.graph-node').forEach(node => {
    node.addEventListener('click', () => {
      showEntityDetails(node.dataset.name);
    });
  });
}

// ============ Memory CRUD ============
async function editMemory(id) {
  const data = await api('/api/memories');
  const memory = data.memories.find(m => m.id === id);
  if (!memory) return;

  editingMemoryId = id;
  modalTitle.textContent = 'Edit Memory';
  modalContentInput.value = memory.content;
  modalSource.value = memory.source;
  modalImportance.value = memory.importance;
  importanceValue.textContent = memory.importance;
  modal.classList.remove('hidden');
}

async function deleteMemory(id) {
  if (!confirm('Delete this memory? This action cannot be undone.')) return;

  await api(`/api/memories/${id}`, { method: 'DELETE' });
  await loadMemories(searchInput.value);
  await loadStats();
}

async function saveMemory() {
  const content = modalContentInput.value.trim();
  if (!content) return;

  const body = {
    content,
    source: modalSource.value || 'web',
    importance: parseFloat(modalImportance.value),
  };

  if (editingMemoryId) {
    await api(`/api/memories/${editingMemoryId}`, { method: 'PUT', body });
  } else {
    await api('/api/memories', { method: 'POST', body });
  }

  closeModal();
  await loadMemories(searchInput.value);
  await loadStats();
}

function closeModal() {
  modal.classList.add('hidden');
  editingMemoryId = null;
  modalContentInput.value = '';
  modalSource.value = 'web';
  modalImportance.value = '0.5';
  importanceValue.textContent = '0.5';
}

// ============ View Switching ============
function switchView(view) {
  currentView = view;

  // Update nav items
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === view);
  });

  // Update views
  Object.entries(views).forEach(([name, el]) => {
    if (el) el.classList.toggle('active', name === view);
  });

  // Update header
  if (viewTitle) viewTitle.textContent = viewTitles[view] || view;

  // Show/hide search based on view
  if (headerSearch) {
    headerSearch.style.display = view === 'memories' ? 'block' : 'none';
  }

  // Load data
  if (view === 'memories') loadMemories(searchInput?.value || '');
  if (view === 'entities') loadEntities(entityTypeFilter?.value || '');
  if (view === 'graph') loadGraph();
  if (view === 'consolidation') loadConsolidation();
  if (view === 'settings') loadSettings();
}

// ============ Consolidation ============
const contradictionsList = document.getElementById('contradictions-list');
const digestsList = document.getElementById('digests-list');
const unconsolidatedCount = document.getElementById('unconsolidated-count');
const digestsCount = document.getElementById('digests-count');
const contradictionsCount = document.getElementById('contradictions-count');
const runConsolidationBtn = document.getElementById('run-consolidation-btn');
const contradictionModal = document.getElementById('contradiction-modal');
const contradictionModalBody = document.getElementById('contradiction-modal-body');
const contradictionForm = document.getElementById('contradiction-form');
const contradictionResolution = document.getElementById('contradiction-resolution');

let currentContradictionId = null;

async function loadConsolidation() {
  await Promise.all([
    loadConsolidationStatus(),
    loadContradictions(),
    loadDigests(),
  ]);
}

async function loadConsolidationStatus() {
  try {
    const status = await api('/api/consolidation/status');
    if (unconsolidatedCount) unconsolidatedCount.textContent = status.unconsolidatedMemories;
    if (digestsCount) digestsCount.textContent = status.totalDigests;
    if (contradictionsCount) contradictionsCount.textContent = status.unresolvedContradictions;
    if (runConsolidationBtn) {
      runConsolidationBtn.disabled = !status.configured;
      if (!status.configured) {
        runConsolidationBtn.title = 'Configure ANTHROPIC_API_KEY to enable';
      }
    }
  } catch (e) {
    console.error('Failed to load consolidation status', e);
  }
}

async function loadContradictions() {
  if (!contradictionsList) return;

  try {
    const data = await api('/api/contradictions?resolved=false');

    if (data.contradictions.length === 0) {
      contradictionsList.innerHTML = `
        <div class="empty-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M20 6L9 17l-5-5"/>
          </svg>
          <h3>No contradictions</h3>
          <p>All conflicts have been resolved</p>
        </div>
      `;
      return;
    }

    contradictionsList.innerHTML = data.contradictions.map(c => `
      <div class="list-item contradiction-item" data-id="${c.id}">
        ${c.entity ? `<span class="entity-tag">${escapeHtml(c.entity.name)}</span>` : ''}
        <div class="description">${escapeHtml(c.description)}</div>
        <div class="memory-quote">
          ${escapeHtml(c.memory_a?.content || 'Memory deleted')}
          <span class="date">${c.memory_a ? formatDate(c.memory_a.timestamp) : ''}</span>
        </div>
        <div class="memory-quote">
          ${escapeHtml(c.memory_b?.content || 'Memory deleted')}
          <span class="date">${c.memory_b ? formatDate(c.memory_b.timestamp) : ''}</span>
        </div>
        <div class="actions" style="margin-top: 16px;">
          <button class="btn btn-sm btn-primary resolve-btn" data-id="${c.id}">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M20 6L9 17l-5-5"/>
            </svg>
            Resolve
          </button>
        </div>
      </div>
    `).join('');

    contradictionsList.querySelectorAll('.resolve-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openContradictionModal(btn.dataset.id);
      });
    });
  } catch (e) {
    console.error('Failed to load contradictions', e);
    contradictionsList.innerHTML = '<div class="empty-state"><p>Failed to load contradictions</p></div>';
  }
}

async function loadDigests() {
  if (!digestsList) return;

  try {
    const data = await api('/api/digests');

    if (data.digests.length === 0) {
      digestsList.innerHTML = `
        <div class="empty-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/>
            <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/>
          </svg>
          <h3>No digests yet</h3>
          <p>Run consolidation to create summaries</p>
        </div>
      `;
      return;
    }

    // Group by level
    const byLevel = { 1: [], 2: [], 3: [] };
    data.digests.forEach(d => {
      const level = d.level || 1;
      if (!byLevel[level]) byLevel[level] = [];
      byLevel[level].push(d);
    });

    const levelLabels = { 1: 'Session Summaries', 2: 'Topic Digests', 3: 'Entity Profiles' };
    const levelDescs = {
      1: 'Summaries of individual conversations',
      2: 'Consolidated topic-based knowledge',
      3: 'High-level entity profiles and patterns'
    };

    let html = '';
    for (const level of [3, 2, 1]) {
      const digests = byLevel[level];
      if (digests.length === 0) continue;

      html += `
        <div class="digest-level">
          <div class="level-header">
            <span class="level-badge">L${level}</span>
            <span class="level-title">${levelLabels[level]}</span>
            <span class="level-count">(${digests.length})</span>
          </div>
          <p class="section-desc" style="margin-bottom: 16px;">${levelDescs[level]}</p>
          <div class="digest-list">
      `;

      digests.forEach(d => {
        html += `
          <div class="list-item digest-item" data-level="${level}">
            <div class="content">${escapeHtml(d.content)}</div>
            <div class="meta">
              ${d.topic ? `<span class="topic">${escapeHtml(d.topic)}</span>` : ''}
              <span>${d.source_count} sources</span>
              <span>${formatDate(d.created_at)}</span>
            </div>
          </div>
        `;
      });

      html += '</div></div>';
    }

    digestsList.innerHTML = html;
  } catch (e) {
    console.error('Failed to load digests', e);
    digestsList.innerHTML = '<div class="empty-state"><p>Failed to load digests</p></div>';
  }
}

async function runConsolidation() {
  if (!runConsolidationBtn) return;

  runConsolidationBtn.disabled = true;
  runConsolidationBtn.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="spin">
      <path d="M21 12a9 9 0 11-6.219-8.56"/>
    </svg>
    Consolidating...
  `;

  try {
    const result = await api('/api/consolidation/run', { method: 'POST' });
    alert(`Consolidation complete!\n\nDigests created: ${result.digestsCreated}\nContradictions found: ${result.contradictionsFound}\nMemories processed: ${result.memoriesProcessed}`);
    await loadConsolidation();
    await loadStats();
  } catch (e) {
    console.error('Consolidation failed', e);
    alert('Consolidation failed. Check console for details.');
  } finally {
    runConsolidationBtn.disabled = false;
    runConsolidationBtn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 017.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>
      </svg>
      Run Consolidation
    `;
  }
}

function openContradictionModal(id) {
  const item = contradictionsList?.querySelector(`[data-id="${id}"]`);
  if (!item) return;

  currentContradictionId = id;
  const description = item.querySelector('.description')?.textContent || '';
  const memories = item.querySelectorAll('.memory-quote');

  if (contradictionModalBody) {
    contradictionModalBody.innerHTML = `
      <p style="font-weight: 500; margin-bottom: 16px;">${escapeHtml(description)}</p>
      <div class="memory-quote">${memories[0]?.innerHTML || ''}</div>
      <div class="memory-quote">${memories[1]?.innerHTML || ''}</div>
    `;
  }

  if (contradictionResolution) contradictionResolution.value = '';
  contradictionModal?.classList.remove('hidden');
}

function closeContradictionModal() {
  contradictionModal?.classList.add('hidden');
  currentContradictionId = null;
}

async function resolveContradiction(resolution) {
  if (!currentContradictionId || !resolution.trim()) return;

  try {
    await api(`/api/contradictions/${currentContradictionId}/resolve`, {
      method: 'POST',
      body: { resolution: resolution.trim() },
    });
    closeContradictionModal();
    await loadConsolidation();
    await loadStats();
  } catch (e) {
    console.error('Failed to resolve contradiction', e);
    alert('Failed to resolve contradiction');
  }
}

async function dismissContradiction() {
  if (!currentContradictionId) return;
  if (!confirm('Dismiss this contradiction without resolution?')) return;

  try {
    await api(`/api/contradictions/${currentContradictionId}`, { method: 'DELETE' });
    closeContradictionModal();
    await loadConsolidation();
    await loadStats();
  } catch (e) {
    console.error('Failed to dismiss contradiction', e);
    alert('Failed to dismiss contradiction');
  }
}

// ============ Settings ============
const apiStatusBadge = document.getElementById('api-status-badge');
const apiKeyInput = document.getElementById('api-key-input');
const toggleKeyVisibility = document.getElementById('toggle-key-visibility');
const saveApiKeyBtn = document.getElementById('save-api-key');
const clearApiKeyBtn = document.getElementById('clear-api-key');

async function loadSettings() {
  try {
    const settings = await api('/api/settings');
    updateSettingsUI(settings);
  } catch (e) {
    console.error('Failed to load settings', e);
  }
}

function updateSettingsUI(settings) {
  if (!apiStatusBadge) return;

  if (settings.has_api_key) {
    apiStatusBadge.textContent = `Configured (${settings.api_key_source})`;
    apiStatusBadge.className = 'status-badge configured';
    if (apiKeyInput) {
      apiKeyInput.placeholder = settings.api_key_preview || 'sk-ant-api03-...';
      apiKeyInput.value = '';
    }
  } else {
    apiStatusBadge.textContent = 'Not configured';
    apiStatusBadge.className = 'status-badge not-configured';
    if (apiKeyInput) apiKeyInput.placeholder = 'sk-ant-api03-...';
  }
}

// ============ Chat Panel ============
const chatPanel = document.getElementById('chat-panel');
const chatToggle = document.getElementById('chat-toggle');
const chatClose = document.getElementById('chat-close');
const chatClear = document.getElementById('chat-clear');
const chatMessages = document.getElementById('chat-messages');
const chatStatus = document.getElementById('chat-status');
const chatForm = document.getElementById('chat-form');
const chatInput = document.getElementById('chat-input');

let chatConfigured = false;

async function checkChatStatus() {
  try {
    const data = await api('/api/chat/status');
    chatConfigured = data.configured;
    if (!chatConfigured && chatStatus) {
      chatStatus.textContent = 'Configure ANTHROPIC_API_KEY to enable chat';
      chatStatus.classList.add('error');
      if (chatInput) {
        chatInput.disabled = true;
        chatInput.placeholder = 'Chat disabled - API key not configured';
      }
    } else if (chatStatus) {
      chatStatus.textContent = '';
      chatStatus.classList.remove('error');
      if (chatInput) {
        chatInput.disabled = false;
        chatInput.placeholder = 'Ask me to manage entities...';
      }
    }
  } catch (e) {
    if (chatStatus) {
      chatStatus.textContent = 'Failed to connect to chat service';
      chatStatus.classList.add('error');
    }
    if (chatInput) {
      chatInput.disabled = true;
      chatInput.placeholder = 'Chat unavailable';
    }
  }
}

function toggleChat() {
  if (!chatPanel) return;

  const isHidden = chatPanel.classList.contains('hidden');
  chatPanel.classList.toggle('hidden');
  chatToggle?.classList.toggle('active', isHidden);
  document.body.classList.toggle('chat-open', isHidden);

  if (isHidden) {
    checkChatStatus();
    chatInput?.focus();
  }
}

function addChatMessage(content, role) {
  if (!chatMessages) return;

  const div = document.createElement('div');
  div.className = `chat-message ${role}`;
  div.innerHTML = `<p>${formatChatContent(content)}</p>`;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function formatChatContent(content) {
  return content
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code>$1</code>');
}

async function sendChatMessage(message) {
  if (!message.trim() || !chatMessages) return;

  addChatMessage(message, 'user');
  if (chatInput) chatInput.value = '';
  if (chatInput) chatInput.disabled = true;

  // Create assistant message div for streaming
  const responseDiv = document.createElement('div');
  responseDiv.className = 'chat-message assistant streaming';
  responseDiv.innerHTML = '<p></p>';
  chatMessages.appendChild(responseDiv);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  const contentEl = responseDiv.querySelector('p');
  let currentContent = '';

  try {
    const response = await fetch('/api/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.error || 'Stream request failed');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const event = JSON.parse(line.slice(6));

            switch (event.type) {
              case 'text':
                currentContent += event.content;
                if (contentEl) contentEl.innerHTML = formatChatContent(currentContent);
                chatMessages.scrollTop = chatMessages.scrollHeight;
                break;

              case 'thinking':
                // Handle streaming thinking content
                let thinkingEl = contentEl?.querySelector('.thinking-indicator');
                if (!thinkingEl) {
                  // Create thinking indicator on first thinking event
                  thinkingEl = document.createElement('div');
                  thinkingEl.className = 'tool-indicator thinking-indicator';
                  thinkingEl.innerHTML = `
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <circle cx="12" cy="12" r="10"/>
                      <path d="M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3M12 17h.01"/>
                    </svg>
                    <span class="thinking-text">Reasoning...</span>
                  `;
                  contentEl?.appendChild(thinkingEl);
                }
                // Optionally show truncated thinking preview (last 50 chars)
                if (event.content && event.content.length > 0) {
                  const thinkingTextEl = thinkingEl.querySelector('.thinking-text');
                  if (thinkingTextEl) {
                    const preview = event.content.slice(-80).replace(/\n/g, ' ').trim();
                    thinkingTextEl.textContent = `Reasoning... ${preview.length > 60 ? '...' + preview.slice(-60) : preview}`;
                  }
                }
                chatMessages.scrollTop = chatMessages.scrollHeight;
                break;

              case 'tool_start':
                // Remove thinking indicator if present
                const thinkingInd = contentEl?.querySelector('.thinking-indicator');
                if (thinkingInd) thinkingInd.remove();

                // Show tool execution indicator
                const toolIndicator = document.createElement('div');
                toolIndicator.className = 'tool-indicator';
                toolIndicator.innerHTML = `
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M21 12a9 9 0 11-6.219-8.56"/>
                  </svg>
                  Using ${event.tool}...
                `;
                contentEl?.appendChild(toolIndicator);
                chatMessages.scrollTop = chatMessages.scrollHeight;
                break;

              case 'tool_end':
                // Remove tool indicator
                const indicators = contentEl?.querySelectorAll('.tool-indicator');
                indicators?.forEach(ind => ind.remove());
                break;

              case 'error':
                currentContent += `\n\n**Error:** ${event.content}`;
                if (contentEl) contentEl.innerHTML = formatChatContent(currentContent);
                break;

              case 'done':
                responseDiv.classList.remove('streaming');
                break;
            }
          } catch (e) {
            // Ignore JSON parse errors for incomplete chunks
          }
        }
      }
    }

    // Refresh data in case something changed
    loadStats();
    if (currentView === 'entities') loadEntities(entityTypeFilter?.value || '');
    if (currentView === 'graph') loadGraph();
    if (currentView === 'memories') loadMemories(searchInput?.value || '');

  } catch (e) {
    responseDiv.classList.remove('streaming');
    if (contentEl) contentEl.innerHTML = formatChatContent(`**Error:** ${e.message || 'Failed to get response'}`);
  }

  if (chatInput) {
    chatInput.disabled = false;
    chatInput.focus();
  }
}

async function clearChatHistory() {
  try {
    await api('/api/chat/clear', { method: 'POST' });
    if (chatMessages) {
      chatMessages.innerHTML = `
        <div class="chat-message assistant">
          <p>Hi! I can help you manage your memories and entities.</p>
          <p><strong>Examples:</strong></p>
          <ul>
            <li>"Show me all entities"</li>
            <li>"Find duplicates"</li>
            <li>"Merge Boris into Boris Djordjevic"</li>
            <li>"Delete the entity 'crashed'"</li>
          </ul>
          <p style="font-size: 0.8em; color: var(--text-tertiary); margin-top: 0.5rem;">Requires ANTHROPIC_API_KEY to be configured.</p>
        </div>
      `;
    }
  } catch (e) {
    console.error('Failed to clear chat history', e);
  }
}

// ============ API Status Indicator ============
const apiStatusEl = document.getElementById('api-status');

async function checkApiStatus() {
  if (!apiStatusEl) return;

  apiStatusEl.classList.remove('connected', 'disconnected');
  apiStatusEl.classList.add('checking');
  apiStatusEl.title = 'Checking API status...';

  try {
    const data = await api('/api/chat/status');
    apiStatusEl.classList.remove('checking');
    if (data.configured) {
      apiStatusEl.classList.add('connected');
      apiStatusEl.title = 'Anthropic API connected';
    } else {
      apiStatusEl.classList.add('disconnected');
      apiStatusEl.title = 'API key not configured';
    }
  } catch (e) {
    apiStatusEl.classList.remove('checking');
    apiStatusEl.classList.add('disconnected');
    apiStatusEl.title = 'Failed to check API status';
  }
}

// ============ Event Listeners ============

// Navigation
document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});

// Search
document.getElementById('search-input')?.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') loadMemories(e.target.value);
});

// Entity filter
entityTypeFilter?.addEventListener('change', () => {
  loadEntities(entityTypeFilter.value);
});

// Add memory button
document.getElementById('add-memory-btn')?.addEventListener('click', () => {
  editingMemoryId = null;
  if (modalTitle) modalTitle.textContent = 'Add Memory';
  modal?.classList.remove('hidden');
});

// Modal events
document.getElementById('modal-cancel')?.addEventListener('click', closeModal);
document.getElementById('modal-cancel-btn')?.addEventListener('click', closeModal);
modalForm?.addEventListener('submit', (e) => {
  e.preventDefault();
  saveMemory();
});
modalImportance?.addEventListener('input', () => {
  if (importanceValue) importanceValue.textContent = modalImportance.value;
});
modal?.addEventListener('click', (e) => {
  if (e.target === modal) closeModal();
});

// Entity modal
document.getElementById('entity-modal-close')?.addEventListener('click', () => {
  entityModal?.classList.add('hidden');
});
document.getElementById('entity-modal-close-btn')?.addEventListener('click', () => {
  entityModal?.classList.add('hidden');
});
entityModal?.addEventListener('click', (e) => {
  if (e.target === entityModal) entityModal.classList.add('hidden');
});

// Consolidation
runConsolidationBtn?.addEventListener('click', runConsolidation);
contradictionForm?.addEventListener('submit', (e) => {
  e.preventDefault();
  resolveContradiction(contradictionResolution?.value || '');
});
document.getElementById('contradiction-cancel')?.addEventListener('click', closeContradictionModal);
document.getElementById('contradiction-close')?.addEventListener('click', closeContradictionModal);
document.getElementById('contradiction-dismiss')?.addEventListener('click', dismissContradiction);
contradictionModal?.addEventListener('click', (e) => {
  if (e.target === contradictionModal) closeContradictionModal();
});

// Settings
toggleKeyVisibility?.addEventListener('click', () => {
  if (!apiKeyInput) return;
  const type = apiKeyInput.type === 'password' ? 'text' : 'password';
  apiKeyInput.type = type;
  const eyeIcon = document.getElementById('eye-icon');
  if (eyeIcon) {
    eyeIcon.innerHTML = type === 'password'
      ? '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>'
      : '<path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/><path d="M1 1l22 22"/>';
  }
});

saveApiKeyBtn?.addEventListener('click', async () => {
  const apiKey = apiKeyInput?.value.trim();
  if (!apiKey) {
    alert('Please enter an API key');
    return;
  }

  if (!apiKey.startsWith('sk-ant-')) {
    alert('Invalid API key format. Should start with sk-ant-');
    return;
  }

  try {
    saveApiKeyBtn.disabled = true;
    saveApiKeyBtn.textContent = 'Saving...';

    const result = await api('/api/settings', {
      method: 'POST',
      body: { anthropic_api_key: apiKey },
    });

    if (result.success) {
      if (apiKeyInput) apiKeyInput.value = '';
      await loadSettings();
      await checkApiStatus();
      alert('API key saved successfully!');
    } else {
      alert('Failed to save API key');
    }
  } catch (e) {
    console.error('Failed to save API key', e);
    alert('Error saving API key');
  } finally {
    saveApiKeyBtn.disabled = false;
    saveApiKeyBtn.textContent = 'Save API Key';
  }
});

clearApiKeyBtn?.addEventListener('click', async () => {
  if (!confirm('Are you sure you want to clear the API key?')) return;

  try {
    clearApiKeyBtn.disabled = true;
    await api('/api/settings', {
      method: 'POST',
      body: { anthropic_api_key: '' },
    });
    await loadSettings();
    await checkApiStatus();
  } catch (e) {
    console.error('Failed to clear API key', e);
  } finally {
    clearApiKeyBtn.disabled = false;
  }
});

// Chat
chatToggle?.addEventListener('click', toggleChat);
chatClose?.addEventListener('click', toggleChat);
chatClear?.addEventListener('click', clearChatHistory);
chatForm?.addEventListener('submit', (e) => {
  e.preventDefault();
  sendChatMessage(chatInput?.value || '');
});

// ============ Initialization ============
function init() {
  initTheme();
  initSidebar();
  checkApiStatus();
  loadStats();
  loadMemories();
}

// Run on DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
