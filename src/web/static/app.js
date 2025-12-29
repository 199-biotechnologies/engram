/**
 * Engram Web Interface
 * Vanilla JavaScript - no build step required
 */

const API_BASE = '';

// State
let currentView = 'memories';
let editingMemoryId = null;
let memoriesOffset = 0;
const MEMORIES_PAGE_SIZE = 25;

// DOM Elements
const views = {
  memories: document.getElementById('memories-view'),
  entities: document.getElementById('entities-view'),
  graph: document.getElementById('graph-view'),
  consolidation: document.getElementById('consolidation-view'),
};

const statsEl = document.getElementById('stats');
const memoriesList = document.getElementById('memories-list');
const entitiesList = document.getElementById('entities-list');
const graphContainer = document.getElementById('graph-container');
const searchInput = document.getElementById('search-input');
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

// API helpers
async function api(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  return res.json();
}

// Format date
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

// Load stats
async function loadStats() {
  const stats = await api('/api/stats');
  let text = `${stats.memories} memories \u00b7 ${stats.entities} entities \u00b7 ${stats.relations} relations`;
  if (stats.digests > 0) {
    text += ` \u00b7 ${stats.digests} digests`;
  }
  if (stats.contradictions > 0) {
    text += ` \u00b7 ${stats.contradictions} contradictions`;
  }
  statsEl.textContent = text;
}

// Load memories with pagination
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
    memoriesList.innerHTML = '<div class="empty-state">No memories found</div>';
    return;
  }

  const memoriesHtml = data.memories.map(m => `
    <div class="list-item memory-item" data-id="${m.id}">
      <div class="content">${escapeHtml(m.content)}</div>
      <div class="meta">
        <span>${formatDate(m.timestamp)}</span>
        <span>${m.source}</span>
        <span>importance: ${m.importance}</span>
        ${m.score ? `<span class="score">${m.score.toFixed(4)}</span>` : ''}
      </div>
      <div class="actions">
        <button class="edit-btn" data-id="${m.id}">Edit</button>
        <button class="delete-btn" data-id="${m.id}">Delete</button>
      </div>
    </div>
  `).join('');

  if (append) {
    // Remove old "Load More" button if exists
    const oldLoadMore = memoriesList.querySelector('.load-more-container');
    if (oldLoadMore) oldLoadMore.remove();
    memoriesList.insertAdjacentHTML('beforeend', memoriesHtml);
  } else {
    memoriesList.innerHTML = memoriesHtml;
  }

  // Add "Load More" button if we got a full page and not searching
  if (!query && data.memories.length === MEMORIES_PAGE_SIZE) {
    memoriesList.insertAdjacentHTML('beforeend', `
      <div class="load-more-container">
        <button class="load-more-btn">Load More</button>
      </div>
    `);
    memoriesList.querySelector('.load-more-btn').addEventListener('click', () => {
      memoriesOffset += MEMORIES_PAGE_SIZE;
      loadMemories('', true);
    });
  }

  // Attach event listeners to new items
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

// Load entities
async function loadEntities(type = '') {
  const path = type ? `/api/entities?type=${type}` : '/api/entities';
  const data = await api(path);

  if (data.entities.length === 0) {
    entitiesList.innerHTML = '<div class="empty-state">No entities found</div>';
    return;
  }

  entitiesList.innerHTML = data.entities.map(e => `
    <div class="list-item entity-item" data-name="${escapeHtml(e.name)}">
      <div class="name">${escapeHtml(e.name)}</div>
      <div class="type">${e.type}</div>
    </div>
  `).join('');

  // Attach event listeners
  entitiesList.querySelectorAll('.entity-item').forEach(item => {
    item.addEventListener('click', () => {
      showEntityDetails(item.dataset.name);
    });
  });
}

// Show entity details
async function showEntityDetails(name) {
  const data = await api(`/api/entities/${encodeURIComponent(name)}`);

  entityModalTitle.textContent = data.name;

  let html = `<p><strong>Type:</strong> ${data.type}</p>`;

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
      html += `<li>${r.type} \u2192 ${escapeHtml(r.targetEntity?.name || r.to)}</li>`;
    });
    html += `</ul>`;
  }

  if (data.relationsTo && data.relationsTo.length > 0) {
    html += `<h3>Relationships (incoming)</h3><ul>`;
    data.relationsTo.forEach(r => {
      html += `<li>${escapeHtml(r.sourceEntity?.name || r.from)} \u2192 ${r.type}</li>`;
    });
    html += `</ul>`;
  }

  entityModalBody.innerHTML = html;
  entityModal.classList.remove('hidden');
}

// Load graph
async function loadGraph() {
  const data = await api('/api/graph');

  // Simple visualization using CSS
  if (data.nodes.length === 0) {
    graphContainer.innerHTML = '<div class="empty-state">No entities in graph</div>';
    return;
  }

  // Create a simple text-based visualization
  let html = '<div style="padding: 2rem; font-size: 0.875rem;">';
  html += '<p style="margin-bottom: 1rem; color: var(--text-muted);">Knowledge graph visualization. Click entities to see details.</p>';

  // Group by type
  const byType = {};
  data.nodes.forEach(n => {
    if (!byType[n.type]) byType[n.type] = [];
    byType[n.type].push(n);
  });

  for (const [type, nodes] of Object.entries(byType)) {
    html += `<div style="margin-bottom: 1.5rem;">`;
    html += `<h3 style="font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.1em; color: var(--text-muted); margin-bottom: 0.5rem;">${type}</h3>`;
    html += `<div style="display: flex; flex-wrap: wrap; gap: 0.5rem;">`;
    nodes.forEach(n => {
      html += `<span class="graph-node" data-name="${escapeHtml(n.label)}" style="padding: 0.375rem 0.75rem; background: var(--bg-tertiary); cursor: pointer;">${escapeHtml(n.label)}</span>`;
    });
    html += `</div></div>`;
  }

  if (data.edges.length > 0) {
    html += `<div style="margin-top: 2rem;">`;
    html += `<h3 style="font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.1em; color: var(--text-muted); margin-bottom: 0.5rem;">Relationships</h3>`;
    html += `<ul style="list-style: none;">`;
    data.edges.forEach(e => {
      const fromNode = data.nodes.find(n => n.id === e.from);
      const toNode = data.nodes.find(n => n.id === e.to);
      if (fromNode && toNode) {
        html += `<li style="padding: 0.25rem 0; color: var(--text-secondary);">${escapeHtml(fromNode.label)} <span style="color: var(--accent);">\u2192 ${e.label} \u2192</span> ${escapeHtml(toNode.label)}</li>`;
      }
    });
    html += `</ul></div>`;
  }

  html += '</div>';
  graphContainer.innerHTML = html;

  // Attach click handlers
  graphContainer.querySelectorAll('.graph-node').forEach(node => {
    node.addEventListener('click', () => {
      showEntityDetails(node.dataset.name);
    });
  });
}

// Edit memory
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

// Delete memory
async function deleteMemory(id) {
  if (!confirm('Delete this memory?')) return;

  await api(`/api/memories/${id}`, { method: 'DELETE' });
  await loadMemories(searchInput.value);
  await loadStats();
}

// Save memory
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

// Close modal
function closeModal() {
  modal.classList.add('hidden');
  editingMemoryId = null;
  modalContentInput.value = '';
  modalSource.value = 'web';
  modalImportance.value = '0.5';
  importanceValue.textContent = '0.5';
}

// Escape HTML
function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Switch view
function switchView(view) {
  currentView = view;

  // Update nav buttons
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.view === view);
  });

  // Update views
  Object.entries(views).forEach(([name, el]) => {
    el.classList.toggle('active', name === view);
  });

  // Load data for view
  if (view === 'memories') loadMemories(searchInput.value);
  if (view === 'entities') loadEntities(entityTypeFilter.value);
  if (view === 'graph') loadGraph();
  if (view === 'consolidation') loadConsolidation();
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

// Load consolidation view
async function loadConsolidation() {
  await Promise.all([
    loadConsolidationStatus(),
    loadContradictions(),
    loadDigests(),
  ]);
}

// Load consolidation status
async function loadConsolidationStatus() {
  try {
    const status = await api('/api/consolidation/status');
    unconsolidatedCount.textContent = status.unconsolidatedMemories;
    digestsCount.textContent = status.totalDigests;
    contradictionsCount.textContent = status.unresolvedContradictions;
    runConsolidationBtn.disabled = !status.configured;
    if (!status.configured) {
      runConsolidationBtn.title = 'Set ANTHROPIC_API_KEY to enable';
    }
  } catch (e) {
    console.error('Failed to load consolidation status', e);
  }
}

// Load contradictions
async function loadContradictions() {
  try {
    const data = await api('/api/contradictions?resolved=false');

    if (data.contradictions.length === 0) {
      contradictionsList.innerHTML = '<div class="empty-state">No contradictions found</div>';
      return;
    }

    contradictionsList.innerHTML = data.contradictions.map(c => `
      <div class="list-item contradiction-item" data-id="${c.id}">
        ${c.entity ? `<span class="entity-tag">${escapeHtml(c.entity.name)}</span>` : ''}
        <div class="description">${escapeHtml(c.description)}</div>
        <div class="memories">
          <div class="memory-quote">
            ${escapeHtml(c.memory_a?.content || 'Memory deleted')}
            <span class="date">${c.memory_a ? formatDate(c.memory_a.timestamp) : ''}</span>
          </div>
          <div class="memory-quote">
            ${escapeHtml(c.memory_b?.content || 'Memory deleted')}
            <span class="date">${c.memory_b ? formatDate(c.memory_b.timestamp) : ''}</span>
          </div>
        </div>
        <div class="actions">
          <button class="resolve-btn" data-id="${c.id}">Resolve</button>
        </div>
      </div>
    `).join('');

    // Attach event listeners
    contradictionsList.querySelectorAll('.resolve-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openContradictionModal(btn.dataset.id);
      });
    });
  } catch (e) {
    console.error('Failed to load contradictions', e);
    contradictionsList.innerHTML = '<div class="empty-state">Failed to load contradictions</div>';
  }
}

// Load digests with hierarchy visualization
async function loadDigests() {
  try {
    const data = await api('/api/digests');

    if (data.digests.length === 0) {
      digestsList.innerHTML = '<div class="empty-state">No digests yet. Run consolidation to create summaries.</div>';
      return;
    }

    // Group digests by level
    const byLevel = { 1: [], 2: [], 3: [] };
    data.digests.forEach(d => {
      const level = d.level || 1;
      if (!byLevel[level]) byLevel[level] = [];
      byLevel[level].push(d);
    });

    const levelLabels = {
      1: 'Session Summaries',
      2: 'Topic Digests',
      3: 'Entity Profiles'
    };

    const levelDescs = {
      1: 'Summaries of individual conversations',
      2: 'Consolidated topic-based knowledge',
      3: 'High-level entity profiles and patterns'
    };

    let html = '';
    for (const level of [3, 2, 1]) { // Show highest level first
      const digests = byLevel[level];
      if (digests.length === 0) continue;

      html += `
        <div class="digest-level">
          <h3 class="level-header">
            <span class="level-badge">L${level}</span>
            ${levelLabels[level]}
            <span class="level-count">(${digests.length})</span>
          </h3>
          <p class="level-desc">${levelDescs[level]}</p>
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
    digestsList.innerHTML = '<div class="empty-state">Failed to load digests</div>';
  }
}

// Run consolidation
async function runConsolidation() {
  runConsolidationBtn.disabled = true;
  runConsolidationBtn.textContent = 'Consolidating...';

  try {
    const result = await api('/api/consolidation/run', { method: 'POST' });
    alert(`Consolidation complete!\n\nDigests created: ${result.digestsCreated}\nContradictions found: ${result.contradictionsFound}\nMemories processed: ${result.memoriesProcessed}`);
    await loadConsolidation();
  } catch (e) {
    console.error('Consolidation failed', e);
    alert('Consolidation failed. Check console for details.');
  } finally {
    runConsolidationBtn.disabled = false;
    runConsolidationBtn.textContent = 'Run Consolidation';
  }
}

// Open contradiction modal
function openContradictionModal(id) {
  const item = contradictionsList.querySelector(`[data-id="${id}"]`);
  if (!item) return;

  currentContradictionId = id;

  // Copy the memories to the modal
  const description = item.querySelector('.description').textContent;
  const memories = item.querySelectorAll('.memory-quote');

  contradictionModalBody.innerHTML = `
    <p><strong>${escapeHtml(description)}</strong></p>
    <div class="memory-quote">${memories[0].innerHTML}</div>
    <div class="memory-quote">${memories[1].innerHTML}</div>
  `;

  contradictionResolution.value = '';
  contradictionModal.classList.remove('hidden');
}

// Close contradiction modal
function closeContradictionModal() {
  contradictionModal.classList.add('hidden');
  currentContradictionId = null;
}

// Resolve contradiction
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

// Dismiss contradiction
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

// Event listeners for consolidation
runConsolidationBtn.addEventListener('click', runConsolidation);

contradictionForm.addEventListener('submit', (e) => {
  e.preventDefault();
  resolveContradiction(contradictionResolution.value);
});

document.getElementById('contradiction-cancel').addEventListener('click', closeContradictionModal);
document.getElementById('contradiction-dismiss').addEventListener('click', dismissContradiction);

contradictionModal.addEventListener('click', (e) => {
  if (e.target === contradictionModal) closeContradictionModal();
});

// Event listeners
document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});

document.getElementById('search-btn').addEventListener('click', () => {
  loadMemories(searchInput.value);
});

searchInput.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') loadMemories(searchInput.value);
});

entityTypeFilter.addEventListener('change', () => {
  loadEntities(entityTypeFilter.value);
});

document.getElementById('add-memory-btn').addEventListener('click', () => {
  editingMemoryId = null;
  modalTitle.textContent = 'Add Memory';
  modal.classList.remove('hidden');
});

document.getElementById('modal-cancel').addEventListener('click', closeModal);

modalForm.addEventListener('submit', (e) => {
  e.preventDefault();
  saveMemory();
});

modalImportance.addEventListener('input', () => {
  importanceValue.textContent = modalImportance.value;
});

document.getElementById('entity-modal-close').addEventListener('click', () => {
  entityModal.classList.add('hidden');
});

// Close modals on backdrop click
modal.addEventListener('click', (e) => {
  if (e.target === modal) closeModal();
});

entityModal.addEventListener('click', (e) => {
  if (e.target === entityModal) entityModal.classList.add('hidden');
});

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

// Check if chat is configured
async function checkChatStatus() {
  try {
    const data = await api('/api/chat/status');
    chatConfigured = data.configured;
    if (!chatConfigured) {
      chatStatus.textContent = 'Set ANTHROPIC_API_KEY env var to enable chat';
      chatStatus.classList.add('error');
      chatInput.disabled = true;
      chatInput.placeholder = 'Chat disabled - API key not configured';
    } else {
      chatStatus.textContent = '';
      chatStatus.classList.remove('error');
      chatInput.disabled = false;
      chatInput.placeholder = 'Ask me to manage entities...';
    }
  } catch (e) {
    chatStatus.textContent = 'Failed to connect to chat service';
    chatStatus.classList.add('error');
    chatInput.disabled = true;
    chatInput.placeholder = 'Chat unavailable';
  }
}

// Toggle chat panel
function toggleChat() {
  const isHidden = chatPanel.classList.contains('hidden');
  chatPanel.classList.toggle('hidden');
  chatToggle.classList.toggle('active', isHidden);
  document.body.classList.toggle('chat-open', isHidden);

  if (isHidden) {
    checkChatStatus();
    chatInput.focus();
  }
}

// Add message to chat
function addChatMessage(content, role) {
  const div = document.createElement('div');
  div.className = `chat-message ${role}`;

  // Simple markdown-like parsing
  const formatted = content
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code>$1</code>');

  div.innerHTML = `<p>${formatted}</p>`;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// Send chat message with streaming
async function sendChatMessage(message) {
  if (!message.trim()) return;

  // Add user message
  addChatMessage(message, 'user');
  chatInput.value = '';
  chatInput.disabled = true;

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
                contentEl.innerHTML = formatChatContent(currentContent);
                chatMessages.scrollTop = chatMessages.scrollHeight;
                break;

              case 'tool_start':
                // Show tool execution indicator
                const toolIndicator = document.createElement('span');
                toolIndicator.className = 'tool-indicator';
                toolIndicator.textContent = `Using ${event.tool}...`;
                contentEl.appendChild(toolIndicator);
                chatMessages.scrollTop = chatMessages.scrollHeight;
                break;

              case 'tool_end':
                // Remove tool indicator
                const indicators = contentEl.querySelectorAll('.tool-indicator');
                indicators.forEach(ind => ind.remove());
                break;

              case 'error':
                currentContent += `\n\nError: ${event.content}`;
                contentEl.innerHTML = formatChatContent(currentContent);
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
    if (currentView === 'entities') loadEntities(entityTypeFilter.value);
    if (currentView === 'graph') loadGraph();
    if (currentView === 'memories') loadMemories(searchInput.value);

  } catch (e) {
    responseDiv.classList.remove('streaming');
    contentEl.innerHTML = formatChatContent(`Error: ${e.message || 'Failed to get response'}`);
  }

  chatInput.disabled = false;
  chatInput.focus();
}

// Format chat content (markdown-like)
function formatChatContent(content) {
  return content
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`(.+?)`/g, '<code>$1</code>');
}

// Clear chat history
async function clearChatHistory() {
  try {
    await api('/api/chat/clear', { method: 'POST' });
    // Keep only the initial welcome message
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
        <p style="font-size: 0.8em; color: var(--text-muted); margin-top: 0.5rem;">Requires ANTHROPIC_API_KEY environment variable.</p>
      </div>
    `;
  } catch (e) {
    console.error('Failed to clear chat history', e);
  }
}

// Chat event listeners
chatToggle.addEventListener('click', toggleChat);
chatClose.addEventListener('click', toggleChat);
chatClear.addEventListener('click', clearChatHistory);

chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  sendChatMessage(chatInput.value);
});

// ============ API Status Indicator ============

const apiStatusEl = document.getElementById('api-status');

async function checkApiStatus() {
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
      apiStatusEl.title = 'API key not configured - set ANTHROPIC_API_KEY';
    }
  } catch (e) {
    apiStatusEl.classList.remove('checking');
    apiStatusEl.classList.add('disconnected');
    apiStatusEl.title = 'Failed to check API status';
  }
}

// Initialize
checkApiStatus();
loadStats();
loadMemories();
