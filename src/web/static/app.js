/**
 * Engram Web Interface
 * Vanilla JavaScript - no build step required
 */

const API_BASE = '';

// State
let currentView = 'memories';
let editingMemoryId = null;

// DOM Elements
const views = {
  memories: document.getElementById('memories-view'),
  entities: document.getElementById('entities-view'),
  graph: document.getElementById('graph-view'),
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
  statsEl.textContent = `${stats.memories} memories \u00b7 ${stats.entities} entities \u00b7 ${stats.relations} relations`;
}

// Load memories
async function loadMemories(query = '') {
  const path = query ? `/api/memories?q=${encodeURIComponent(query)}` : '/api/memories';
  const data = await api(path);

  if (data.memories.length === 0) {
    memoriesList.innerHTML = '<div class="empty-state">No memories found</div>';
    return;
  }

  memoriesList.innerHTML = data.memories.map(m => `
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
}

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
      chatStatus.textContent = data.message;
      chatStatus.classList.add('error');
      chatInput.disabled = true;
    } else {
      chatStatus.textContent = '';
      chatStatus.classList.remove('error');
      chatInput.disabled = false;
    }
  } catch (e) {
    chatStatus.textContent = 'Failed to connect to chat service';
    chatStatus.classList.add('error');
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

// Send chat message
async function sendChatMessage(message) {
  if (!message.trim()) return;

  // Add user message
  addChatMessage(message, 'user');
  chatInput.value = '';
  chatInput.disabled = true;

  // Show thinking indicator
  const thinkingDiv = document.createElement('div');
  thinkingDiv.className = 'chat-message thinking';
  thinkingDiv.innerHTML = '<p>Thinking...</p>';
  chatMessages.appendChild(thinkingDiv);
  chatMessages.scrollTop = chatMessages.scrollHeight;

  try {
    const data = await api('/api/chat', {
      method: 'POST',
      body: { message },
    });

    // Remove thinking indicator
    thinkingDiv.remove();

    // Add assistant response
    addChatMessage(data.response, 'assistant');

    // Refresh data in case something changed
    loadStats();
    if (currentView === 'entities') loadEntities(entityTypeFilter.value);
    if (currentView === 'graph') loadGraph();
    if (currentView === 'memories') loadMemories(searchInput.value);

  } catch (e) {
    thinkingDiv.remove();
    addChatMessage('Error: Failed to get response. Please try again.', 'assistant');
  }

  chatInput.disabled = false;
  chatInput.focus();
}

// Clear chat history
async function clearChatHistory() {
  try {
    await api('/api/chat/clear', { method: 'POST' });
    // Keep only the initial welcome message
    chatMessages.innerHTML = `
      <div class="chat-message assistant">
        <p>Hi! I can help you manage your memories and entities. Try:</p>
        <ul>
          <li>"Show me all entities"</li>
          <li>"Find duplicates"</li>
          <li>"Merge Boris into Boris Djordjevic"</li>
          <li>"Delete the entity 'crashed'"</li>
        </ul>
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

// Initialize
loadStats();
loadMemories();
