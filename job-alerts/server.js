require('dotenv').config();

const express = require('express');
const path = require('path');
const cron = require('node-cron');
const db = require('./lib/db');
const scraper = require('./lib/scraper');
const notifier = require('./lib/notifier');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
//  API Routes
// ============================================================

// --- Tabs ---
app.get('/api/tabs', (req, res) => {
  const tabs = db.getTabs();
  res.json(tabs);
});

app.post('/api/tabs', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
  try {
    const tab = db.createTab(name.trim());
    res.json(tab);
  } catch (err) {
    res.status(409).json({ error: 'Tab with this name already exists' });
  }
});

app.put('/api/tabs/:id', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
  db.renameTab(req.params.id, name.trim());
  res.json({ ok: true });
});

app.delete('/api/tabs/:id', (req, res) => {
  db.deleteTab(req.params.id);
  res.json({ ok: true });
});

// --- Keywords ---
app.get('/api/tabs/:tabId/keywords', (req, res) => {
  res.json(db.getKeywords(req.params.tabId));
});

app.post('/api/tabs/:tabId/keywords', (req, res) => {
  const { keyword } = req.body;
  if (!keyword || !keyword.trim()) return res.status(400).json({ error: 'Keyword required' });
  const result = db.addKeyword(req.params.tabId, keyword.trim());
  if (!result) return res.status(409).json({ error: 'Keyword already exists in this tab' });
  res.json(result);
});

app.delete('/api/keywords/:id', (req, res) => {
  db.removeKeyword(req.params.id);
  res.json({ ok: true });
});

// --- Sources ---
app.get('/api/tabs/:tabId/sources', (req, res) => {
  res.json(db.getSources(req.params.tabId));
});

app.post('/api/tabs/:tabId/sources', (req, res) => {
  const { url } = req.body;
  if (!url || !url.trim()) return res.status(400).json({ error: 'URL required' });

  // Validate URL
  try { new URL(url.trim()); } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  // Auto-detect source type
  const ats = scraper.detectATS(url.trim());
  const sourceType = ats ? ats.name : 'generic';

  const result = db.addSource(req.params.tabId, url.trim(), sourceType);
  if (!result) return res.status(409).json({ error: 'This URL is already being tracked in this tab' });
  res.json(result);
});

app.delete('/api/sources/:id', (req, res) => {
  db.removeSource(req.params.id);
  res.json({ ok: true });
});

// --- Jobs ---
app.get('/api/tabs/:tabId/jobs', (req, res) => {
  res.json(db.getJobsForTab(req.params.tabId, parseInt(req.query.limit) || 100));
});

// --- Alerts ---
app.get('/api/tabs/:tabId/alerts', (req, res) => {
  res.json(db.getAlertsForTab(req.params.tabId, parseInt(req.query.limit) || 200));
});

// --- Manual scan ---
app.post('/api/tabs/:tabId/scan', async (req, res) => {
  try {
    const result = await runScanForTab(parseInt(req.params.tabId));
    res.json(result);
  } catch (err) {
    console.error('Scan error:', err);
    res.status(500).json({ error: err.message });
  }
});

// Full scan (all tabs)
app.post('/api/scan', async (req, res) => {
  try {
    const result = await runFullScan();
    res.json(result);
  } catch (err) {
    console.error('Scan error:', err);
    res.status(500).json({ error: err.message });
  }
});

// --- Settings ---
app.get('/api/settings', (req, res) => {
  res.json(db.getAllSettings());
});

app.put('/api/settings', (req, res) => {
  for (const [key, value] of Object.entries(req.body)) {
    db.setSetting(key, value);
  }
  res.json({ ok: true });
});

// --- Source type detection preview ---
app.post('/api/detect-source', (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });
  const ats = scraper.detectATS(url);
  res.json({
    type: ats ? ats.name : 'generic',
    label: ats ? `Detected: ${ats.name} (API-powered — reliable)` : 'Generic HTML scraper (best-effort)',
  });
});


// ============================================================
//  Scan Engine
// ============================================================

async function runScanForTab(tabId) {
  const sources = db.getSources(tabId);
  const keywords = db.getKeywords(tabId);

  if (sources.length === 0) return { jobs_found: 0, alerts_created: 0, message: 'No sources configured' };
  if (keywords.length === 0) return { jobs_found: 0, alerts_created: 0, message: 'No keywords configured' };

  let totalJobs = 0;
  let totalAlerts = 0;

  for (const source of sources) {
    try {
      console.log(`Scanning source: ${source.url}`);
      const jobs = await scraper.scrapeSource(source);
      console.log(`  Found ${jobs.length} job listings`);

      for (const job of jobs) {
        const result = db.upsertJob(source.id, job);
        if (result.isNew) totalJobs++;

        // Only generate alerts for new jobs
        if (!result.isNew) continue;

        // If generic scraper returned minimal description, try fetching the full page
        let description = job.description || '';
        if (description.length < 50 && job.url) {
          try {
            description = await scraper.fetchJobDescription(job.url);
          } catch { /* keep what we have */ }
        }

        const titleLower = (job.title || '').toLowerCase();
        const descLower = description.toLowerCase();

        for (const kw of keywords) {
          const kwLower = kw.keyword.toLowerCase();
          const titleMatch = titleLower.includes(kwLower);
          const descMatch = descLower.includes(kwLower);

          if (titleMatch) {
            const created = db.createAlert(tabId, result.id, kw.id, 'title');
            if (created) totalAlerts++;
          }
          if (descMatch) {
            const created = db.createAlert(tabId, result.id, kw.id, 'description');
            if (created) totalAlerts++;
          }
        }
      }

      db.updateSourceChecked(source.id);
    } catch (err) {
      console.error(`  Error scanning ${source.url}:`, err.message);
    }
  }

  return { jobs_found: totalJobs, alerts_created: totalAlerts };
}

async function runFullScan() {
  console.log(`\n[${new Date().toISOString()}] Starting full scan...`);
  const tabs = db.getTabs();
  let totalJobs = 0;
  let totalAlerts = 0;

  for (const tab of tabs) {
    console.log(`\nScanning tab: ${tab.name}`);
    const result = await runScanForTab(tab.id);
    totalJobs += result.jobs_found;
    totalAlerts += result.alerts_created;
  }

  // Send notifications for any unnotified alerts
  if (totalAlerts > 0) {
    await sendPendingNotifications();
  }

  console.log(`\nScan complete: ${totalJobs} new jobs, ${totalAlerts} new alerts`);
  return { jobs_found: totalJobs, alerts_created: totalAlerts };
}

async function sendPendingNotifications() {
  // Email
  const emailAlerts = db.getUnnotifiedAlerts('email');
  if (emailAlerts.length > 0) {
    const sent = await notifier.sendEmailAlert(emailAlerts);
    if (sent) {
      db.markNotified(emailAlerts.map(a => a.id), 'email');
    }
  }

  // SMS
  const smsAlerts = db.getUnnotifiedAlerts('sms');
  if (smsAlerts.length > 0) {
    const sent = await notifier.sendSmsAlert(smsAlerts);
    if (sent) {
      db.markNotified(smsAlerts.map(a => a.id), 'sms');
    }
  }
}


// ============================================================
//  Scheduled Scanning
// ============================================================

const intervalMinutes = parseInt(process.env.CHECK_INTERVAL_MINUTES || '30', 10);
const cronExpr = `*/${intervalMinutes} * * * *`;

cron.schedule(cronExpr, async () => {
  try {
    await runFullScan();
  } catch (err) {
    console.error('Scheduled scan error:', err);
  }
});

console.log(`Scheduled scans every ${intervalMinutes} minutes`);


// ============================================================
//  Start Server
// ============================================================

const PORT = parseInt(process.env.PORT || '3000', 10);
app.listen(PORT, () => {
  console.log(`Job Listing Alerts running at http://localhost:${PORT}`);
});
