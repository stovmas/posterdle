// ============================================================
//  Job Listing Alerts — Frontend
// ============================================================

(function () {
  'use strict';

  let tabs = [];
  let activeTabId = null;

  // --- API Helpers ---

  async function api(method, path, body) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch('/api' + path, opts);
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || 'Request failed');
    }
    return res.json();
  }

  // --- Initialization ---

  async function init() {
    bindGlobalEvents();
    await loadTabs();
    if (tabs.length > 0) {
      selectTab(tabs[0].id);
    }
  }

  function bindGlobalEvents() {
    $('#btn-add-tab').addEventListener('click', () => showModal('modal-add-tab', () => {
      $('#input-tab-name').value = '';
      $('#input-tab-name').focus();
    }));

    $('#btn-create-tab').addEventListener('click', createTab);
    $('#input-tab-name').addEventListener('keydown', e => {
      if (e.key === 'Enter') createTab();
    });

    $('#btn-settings').addEventListener('click', () => showModal('modal-settings', loadSettings));
    $('#btn-scan-all').addEventListener('click', scanAll);

    // Close modals
    document.querySelectorAll('.modal-backdrop, .modal-close').forEach(el => {
      el.addEventListener('click', () => {
        el.closest('.modal').classList.add('hidden');
      });
    });
  }

  // --- Tabs ---

  async function loadTabs() {
    tabs = await api('GET', '/tabs');
    renderTabs();
  }

  function renderTabs() {
    const list = $('#tab-list');
    list.innerHTML = '';
    for (const tab of tabs) {
      const el = document.createElement('div');
      el.className = 'tab-item' + (tab.id === activeTabId ? ' active' : '');
      el.dataset.id = tab.id;
      el.innerHTML = `
        <span class="tab-name">${esc(tab.name)}</span>
        <span class="tab-delete btn-icon danger" title="Delete tab">&times;</span>
      `;
      el.querySelector('.tab-name').addEventListener('click', () => selectTab(tab.id));
      el.querySelector('.tab-delete').addEventListener('click', (e) => {
        e.stopPropagation();
        deleteTab(tab.id, tab.name);
      });
      list.appendChild(el);
    }
  }

  async function selectTab(id) {
    activeTabId = id;
    renderTabs();
    await renderTabContent(id);
  }

  async function createTab() {
    const name = $('#input-tab-name').value.trim();
    if (!name) return;
    try {
      const tab = await api('POST', '/tabs', { name });
      tabs.push(tab);
      hideModal('modal-add-tab');
      selectTab(tab.id);
    } catch (err) {
      alert(err.message);
    }
  }

  async function deleteTab(id, name) {
    if (!confirm(`Delete the "${name}" tab and all its sources, keywords, and alerts?`)) return;
    await api('DELETE', `/tabs/${id}`);
    tabs = tabs.filter(t => t.id !== id);
    renderTabs();
    if (activeTabId === id) {
      activeTabId = tabs.length > 0 ? tabs[0].id : null;
      if (activeTabId) {
        selectTab(activeTabId);
      } else {
        $('#tab-content').innerHTML = `
          <div class="empty-state">
            <p>Create a tab to get started.</p>
            <p class="muted">Each tab represents a category of job alerts.</p>
          </div>`;
      }
    }
  }

  // --- Tab Content ---

  async function renderTabContent(tabId) {
    const content = $('#tab-content');
    content.innerHTML = '<div class="scan-status scanning"><span class="spinner"></span> Loading...</div>';

    const [keywords, sources, alerts] = await Promise.all([
      api('GET', `/tabs/${tabId}/keywords`),
      api('GET', `/tabs/${tabId}/sources`),
      api('GET', `/tabs/${tabId}/alerts`),
    ]);

    content.innerHTML = '';

    // Keywords Section
    content.appendChild(buildSection('Keywords', buildKeywordsUI(tabId, keywords)));

    // Sources Section
    content.appendChild(buildSection('Career Pages', buildSourcesUI(tabId, sources)));

    // Scan button
    const scanRow = document.createElement('div');
    scanRow.style.marginBottom = '20px';
    scanRow.innerHTML = `<button class="btn btn-primary" id="btn-scan-tab">Scan This Tab Now</button>
      <span id="scan-tab-result" style="margin-left: 12px; font-size: 0.85rem;"></span>`;
    content.appendChild(scanRow);
    $('#btn-scan-tab').addEventListener('click', () => scanTab(tabId));

    // Alerts Section
    content.appendChild(buildSection('Alerts', buildAlertsUI(alerts)));
  }

  function buildSection(title, innerEl) {
    const section = document.createElement('div');
    section.className = 'section';
    const header = document.createElement('div');
    header.className = 'section-header';
    header.innerHTML = `<h3>${title}</h3>`;
    section.appendChild(header);
    section.appendChild(innerEl);
    return section;
  }

  // --- Keywords UI ---

  function buildKeywordsUI(tabId, keywords) {
    const wrapper = document.createElement('div');

    // Input
    const row = document.createElement('div');
    row.className = 'input-row';
    row.innerHTML = `
      <input type="text" id="input-keyword" placeholder="Add keyword (e.g., sales, marketing, director)">
      <button class="btn btn-primary btn-sm" id="btn-add-keyword">Add</button>
    `;
    wrapper.appendChild(row);

    // Chip list
    const chips = document.createElement('div');
    chips.className = 'chip-list';
    chips.id = 'keyword-chips';
    for (const kw of keywords) {
      chips.appendChild(makeKeywordChip(kw));
    }
    wrapper.appendChild(chips);

    // Events
    setTimeout(() => {
      const input = $('#input-keyword');
      const btn = $('#btn-add-keyword');
      if (input && btn) {
        btn.addEventListener('click', () => addKeyword(tabId, input));
        input.addEventListener('keydown', e => {
          if (e.key === 'Enter') addKeyword(tabId, input);
        });
      }
    }, 0);

    return wrapper;
  }

  function makeKeywordChip(kw) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.dataset.id = kw.id;
    chip.innerHTML = `${esc(kw.keyword)} <span class="chip-remove" title="Remove">&times;</span>`;
    chip.querySelector('.chip-remove').addEventListener('click', async () => {
      await api('DELETE', `/keywords/${kw.id}`);
      chip.remove();
    });
    return chip;
  }

  async function addKeyword(tabId, input) {
    const keyword = input.value.trim();
    if (!keyword) return;
    try {
      const kw = await api('POST', `/tabs/${tabId}/keywords`, { keyword });
      if (kw) {
        $('#keyword-chips').appendChild(makeKeywordChip(kw));
      }
      input.value = '';
      input.focus();
    } catch (err) {
      alert(err.message);
    }
  }

  // --- Sources UI ---

  function buildSourcesUI(tabId, sources) {
    const wrapper = document.createElement('div');

    // Input
    const row = document.createElement('div');
    row.className = 'input-row';
    row.innerHTML = `
      <input type="url" id="input-source-url" placeholder="Paste careers page URL (e.g., https://boards.greenhouse.io/company)">
      <button class="btn btn-primary btn-sm" id="btn-add-source">Add</button>
    `;
    wrapper.appendChild(row);

    // Detection hint
    const hint = document.createElement('div');
    hint.id = 'source-detect-hint';
    hint.className = 'text-sm muted';
    hint.style.marginBottom = '12px';
    wrapper.appendChild(hint);

    // Source list
    const list = document.createElement('div');
    list.className = 'source-list';
    list.id = 'source-list';
    for (const src of sources) {
      list.appendChild(makeSourceItem(src));
    }
    if (sources.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'muted text-sm';
      empty.style.padding = '8px 0';
      empty.textContent = 'No career pages added yet. Paste a URL above to start tracking.';
      list.appendChild(empty);
    }
    wrapper.appendChild(list);

    // Events
    setTimeout(() => {
      const input = $('#input-source-url');
      const btn = $('#btn-add-source');
      if (input && btn) {
        btn.addEventListener('click', () => addSource(tabId, input));
        input.addEventListener('keydown', e => {
          if (e.key === 'Enter') addSource(tabId, input);
        });
        input.addEventListener('input', debounce(async () => {
          const url = input.value.trim();
          if (!url) { hint.textContent = ''; return; }
          try {
            const result = await api('POST', '/detect-source', { url });
            hint.textContent = result.label;
          } catch { hint.textContent = ''; }
        }, 400));
      }
    }, 0);

    return wrapper;
  }

  function makeSourceItem(src) {
    const isApi = src.source_type !== 'generic';
    const item = document.createElement('div');
    item.className = 'source-item';
    item.dataset.id = src.id;
    item.innerHTML = `
      <div class="source-info">
        <a href="${esc(src.url)}" target="_blank" rel="noopener" class="source-url">${esc(src.url)}</a>
        <div class="source-meta">
          <span class="source-badge ${isApi ? 'api' : 'generic'}">${isApi ? src.source_type + ' API' : 'HTML'}</span>
          ${src.last_checked_at ? `<span>Last checked: ${formatTime(src.last_checked_at)}</span>` : '<span>Not scanned yet</span>'}
        </div>
      </div>
      <div class="source-actions">
        <button class="btn-icon danger" title="Remove source">&times;</button>
      </div>
    `;
    item.querySelector('.btn-icon.danger').addEventListener('click', async () => {
      await api('DELETE', `/sources/${src.id}`);
      item.remove();
    });
    return item;
  }

  async function addSource(tabId, input) {
    const url = input.value.trim();
    if (!url) return;
    try {
      const src = await api('POST', `/tabs/${tabId}/sources`, { url });
      if (src) {
        const list = $('#source-list');
        // Remove empty message if present
        const emptyMsg = list.querySelector('.muted');
        if (emptyMsg) emptyMsg.remove();
        list.prepend(makeSourceItem(src));
      }
      input.value = '';
      $('#source-detect-hint').textContent = '';
    } catch (err) {
      alert(err.message);
    }
  }

  // --- Alerts UI ---

  function buildAlertsUI(alerts) {
    const wrapper = document.createElement('div');

    if (alerts.length === 0) {
      wrapper.innerHTML = '<div class="muted text-sm" style="padding: 8px 0;">No alerts yet. Add keywords and career pages, then run a scan.</div>';
      return wrapper;
    }

    // Split by match type
    const titleAlerts = alerts.filter(a => a.match_type === 'title');
    const descAlerts = alerts.filter(a => a.match_type === 'description');

    if (titleAlerts.length > 0) {
      const group = document.createElement('div');
      group.className = 'alert-section-group';
      group.innerHTML = `<div class="alert-type-label title">Title Matches (${titleAlerts.length})</div>`;
      const list = document.createElement('div');
      list.className = 'alert-list';
      for (const a of titleAlerts) {
        list.appendChild(makeAlertItem(a));
      }
      group.appendChild(list);
      wrapper.appendChild(group);
    }

    if (descAlerts.length > 0) {
      const group = document.createElement('div');
      group.className = 'alert-section-group';
      group.innerHTML = `<div class="alert-type-label description">Description Matches (${descAlerts.length})</div>`;
      const list = document.createElement('div');
      list.className = 'alert-list';
      for (const a of descAlerts) {
        list.appendChild(makeAlertItem(a));
      }
      group.appendChild(list);
      wrapper.appendChild(group);
    }

    return wrapper;
  }

  function makeAlertItem(alert) {
    const item = document.createElement('div');
    item.className = `alert-item ${alert.match_type}`;
    item.innerHTML = `
      <div>
        <div class="alert-job-title">
          ${alert.job_url ? `<a href="${esc(alert.job_url)}" target="_blank" rel="noopener">${esc(alert.job_title)}</a>` : esc(alert.job_title)}
        </div>
        <div class="alert-meta">
          <span>Keyword: <span class="alert-keyword">${esc(alert.keyword)}</span></span>
          ${alert.job_location ? `<span>Location: ${esc(alert.job_location)}</span>` : ''}
          <span class="alert-time">${formatTime(alert.created_at)}</span>
        </div>
      </div>
    `;
    return item;
  }

  // --- Scanning ---

  async function scanTab(tabId) {
    const btn = $('#btn-scan-tab');
    const result = $('#scan-tab-result');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Scanning...';
    result.textContent = '';

    try {
      const data = await api('POST', `/tabs/${tabId}/scan`);
      result.textContent = `Found ${data.jobs_found} new job(s), created ${data.alerts_created} alert(s).`;
      result.className = data.alerts_created > 0 ? 'scan-result success' : 'scan-result empty';
      // Reload the tab content to show new alerts
      await renderTabContent(tabId);
    } catch (err) {
      result.textContent = 'Scan failed: ' + err.message;
      result.className = 'scan-result';
      result.style.color = 'var(--danger)';
    }
    btn.disabled = false;
    btn.textContent = 'Scan This Tab Now';
  }

  async function scanAll() {
    const btn = $('#btn-scan-all');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Scanning...';

    try {
      const data = await api('POST', '/scan');
      alert(`Scan complete: ${data.jobs_found} new job(s), ${data.alerts_created} alert(s).`);
      if (activeTabId) await renderTabContent(activeTabId);
    } catch (err) {
      alert('Scan failed: ' + err.message);
    }
    btn.disabled = false;
    btn.textContent = 'Scan All Now';
  }

  // --- Settings ---

  async function loadSettings() {
    const container = $('#settings-status');
    container.innerHTML = '<span class="spinner"></span>';

    try {
      const settings = await api('GET', '/settings');
      container.innerHTML = `
        <div class="settings-row">
          <span>Email Notifications</span>
          <span><span class="status-dot ${settings.smtp_configured === 'true' || document.cookie.includes('email_ok') ? 'ok' : 'off'}"></span>${settings.email_status || 'Configure SMTP_* env vars'}</span>
        </div>
        <div class="settings-row">
          <span>SMS Notifications</span>
          <span><span class="status-dot ${settings.twilio_configured === 'true' ? 'ok' : 'off'}"></span>${settings.sms_status || 'Configure TWILIO_* env vars'}</span>
        </div>
      `;
    } catch {
      container.innerHTML = '<span class="muted">Could not load settings</span>';
    }
  }

  // --- Utility ---

  function $(sel) { return document.querySelector(sel); }

  function esc(str) {
    const div = document.createElement('div');
    div.textContent = str || '';
    return div.innerHTML;
  }

  function formatTime(isoStr) {
    if (!isoStr) return '';
    try {
      const d = new Date(isoStr + 'Z'); // SQLite stores UTC
      const now = new Date();
      const diff = now - d;
      if (diff < 60000) return 'just now';
      if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
      if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
      return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    } catch {
      return isoStr;
    }
  }

  function debounce(fn, ms) {
    let timer;
    return function (...args) {
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(this, args), ms);
    };
  }

  function showModal(id, onShow) {
    document.getElementById(id).classList.remove('hidden');
    if (onShow) onShow();
  }

  function hideModal(id) {
    document.getElementById(id).classList.add('hidden');
  }

  // --- Boot ---
  init();
})();
