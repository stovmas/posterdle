const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'jobs.db');

let db;

function getDb() {
  if (!db) {
    const fs = require('fs');
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema();
  }
  return db;
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tabs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS keywords (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tab_id INTEGER NOT NULL REFERENCES tabs(id) ON DELETE CASCADE,
      keyword TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(tab_id, keyword)
    );

    CREATE TABLE IF NOT EXISTS sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tab_id INTEGER NOT NULL REFERENCES tabs(id) ON DELETE CASCADE,
      url TEXT NOT NULL,
      source_type TEXT DEFAULT 'auto',
      last_checked_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(tab_id, url)
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      external_id TEXT,
      title TEXT NOT NULL,
      description TEXT,
      url TEXT,
      location TEXT,
      department TEXT,
      first_seen_at TEXT DEFAULT (datetime('now')),
      UNIQUE(source_id, url)
    );

    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tab_id INTEGER NOT NULL REFERENCES tabs(id) ON DELETE CASCADE,
      job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      keyword_id INTEGER NOT NULL REFERENCES keywords(id) ON DELETE CASCADE,
      match_type TEXT NOT NULL CHECK(match_type IN ('title', 'description')),
      notified_email INTEGER DEFAULT 0,
      notified_sms INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(job_id, keyword_id, match_type)
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
}

// --- Tabs ---

function getTabs() {
  return getDb().prepare('SELECT * FROM tabs ORDER BY id').all();
}

function createTab(name) {
  const stmt = getDb().prepare('INSERT INTO tabs (name) VALUES (?)');
  const info = stmt.run(name);
  return { id: info.lastInsertRowid, name };
}

function deleteTab(id) {
  getDb().prepare('DELETE FROM tabs WHERE id = ?').run(id);
}

function renameTab(id, name) {
  getDb().prepare('UPDATE tabs SET name = ? WHERE id = ?').run(name, id);
}

// --- Keywords ---

function getKeywords(tabId) {
  return getDb().prepare('SELECT * FROM keywords WHERE tab_id = ? ORDER BY keyword').all(tabId);
}

function addKeyword(tabId, keyword) {
  const stmt = getDb().prepare('INSERT OR IGNORE INTO keywords (tab_id, keyword) VALUES (?, ?)');
  const info = stmt.run(tabId, keyword.toLowerCase().trim());
  if (info.changes === 0) return null;
  return { id: info.lastInsertRowid, tab_id: tabId, keyword: keyword.toLowerCase().trim() };
}

function removeKeyword(id) {
  getDb().prepare('DELETE FROM keywords WHERE id = ?').run(id);
}

// --- Sources ---

function getSources(tabId) {
  return getDb().prepare('SELECT * FROM sources WHERE tab_id = ? ORDER BY created_at DESC').all(tabId);
}

function addSource(tabId, url, sourceType = 'auto') {
  const stmt = getDb().prepare('INSERT OR IGNORE INTO sources (tab_id, url, source_type) VALUES (?, ?, ?)');
  const info = stmt.run(tabId, url, sourceType);
  if (info.changes === 0) return null;
  return { id: info.lastInsertRowid, tab_id: tabId, url, source_type: sourceType };
}

function removeSource(id) {
  getDb().prepare('DELETE FROM sources WHERE id = ?').run(id);
}

function updateSourceChecked(id) {
  getDb().prepare("UPDATE sources SET last_checked_at = datetime('now') WHERE id = ?").run(id);
}

// --- Jobs ---

function upsertJob(sourceId, job) {
  const stmt = getDb().prepare(`
    INSERT OR IGNORE INTO jobs (source_id, external_id, title, description, url, location, department)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const info = stmt.run(
    sourceId,
    job.external_id || null,
    job.title,
    job.description || null,
    job.url || null,
    job.location || null,
    job.department || null
  );
  if (info.changes > 0) {
    return { id: info.lastInsertRowid, isNew: true, ...job };
  }
  // Already existed
  const existing = getDb().prepare('SELECT id FROM jobs WHERE source_id = ? AND url = ?').get(sourceId, job.url);
  return { id: existing ? existing.id : null, isNew: false, ...job };
}

function getJobsForTab(tabId, limit = 100) {
  return getDb().prepare(`
    SELECT j.*, s.url as source_url
    FROM jobs j
    JOIN sources s ON j.source_id = s.id
    WHERE s.tab_id = ?
    ORDER BY j.first_seen_at DESC
    LIMIT ?
  `).all(tabId, limit);
}

// --- Alerts ---

function createAlert(tabId, jobId, keywordId, matchType) {
  const stmt = getDb().prepare(`
    INSERT OR IGNORE INTO alerts (tab_id, job_id, keyword_id, match_type)
    VALUES (?, ?, ?, ?)
  `);
  const info = stmt.run(tabId, jobId, keywordId, matchType);
  return info.changes > 0;
}

function getUnnotifiedAlerts(type) {
  const column = type === 'email' ? 'notified_email' : 'notified_sms';
  return getDb().prepare(`
    SELECT a.*, j.title as job_title, j.description as job_description, j.url as job_url,
           j.location as job_location, j.department as job_department,
           k.keyword, t.name as tab_name
    FROM alerts a
    JOIN jobs j ON a.job_id = j.id
    JOIN keywords k ON a.keyword_id = k.id
    JOIN tabs t ON a.tab_id = t.id
    WHERE a.${column} = 0
    ORDER BY a.created_at DESC
  `).all();
}

function markNotified(alertIds, type) {
  const column = type === 'email' ? 'notified_email' : 'notified_sms';
  const stmt = getDb().prepare(`UPDATE alerts SET ${column} = 1 WHERE id = ?`);
  const txn = getDb().transaction((ids) => {
    for (const id of ids) stmt.run(id);
  });
  txn(alertIds);
}

function getAlertsForTab(tabId, limit = 200) {
  return getDb().prepare(`
    SELECT a.*, j.title as job_title, j.description as job_description, j.url as job_url,
           j.location as job_location, j.department as job_department,
           k.keyword, t.name as tab_name
    FROM alerts a
    JOIN jobs j ON a.job_id = j.id
    JOIN keywords k ON a.keyword_id = k.id
    JOIN tabs t ON a.tab_id = t.id
    WHERE a.tab_id = ?
    ORDER BY a.created_at DESC
    LIMIT ?
  `).all(tabId, limit);
}

// --- Settings ---

function getSetting(key) {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  getDb().prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
}

function getAllSettings() {
  const rows = getDb().prepare('SELECT * FROM settings').all();
  const result = {};
  for (const row of rows) result[row.key] = row.value;
  return result;
}

module.exports = {
  getDb,
  getTabs, createTab, deleteTab, renameTab,
  getKeywords, addKeyword, removeKeyword,
  getSources, addSource, removeSource, updateSourceChecked,
  upsertJob, getJobsForTab,
  createAlert, getUnnotifiedAlerts, markNotified, getAlertsForTab,
  getSetting, setSetting, getAllSettings,
};
