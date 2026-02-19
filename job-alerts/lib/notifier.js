const nodemailer = require('nodemailer');

let twilioClient = null;

function getTwilioClient() {
  if (twilioClient) return twilioClient;
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token || sid === 'your-account-sid') return null;
  try {
    const twilio = require('twilio');
    twilioClient = twilio(sid, token);
    return twilioClient;
  } catch {
    return null;
  }
}

function getEmailTransport() {
  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  if (!host || !user || !pass || user === 'your-email@gmail.com') return null;
  return nodemailer.createTransport({
    host,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_PORT === '465',
    auth: { user, pass },
  });
}

// Group alerts by tab, then by match_type
function groupAlerts(alerts) {
  const grouped = {};
  for (const alert of alerts) {
    const key = alert.tab_name;
    if (!grouped[key]) grouped[key] = { title: [], description: [] };
    grouped[key][alert.match_type].push(alert);
  }
  return grouped;
}

function formatAlertText(grouped) {
  let text = '🔔 JOB ALERT\n\n';

  for (const [tabName, matches] of Object.entries(grouped)) {
    text += `━━━ ${tabName.toUpperCase()} ━━━\n\n`;

    if (matches.title.length > 0) {
      text += `▸ TITLE MATCHES:\n`;
      for (const a of matches.title) {
        text += `  • "${a.job_title}" (keyword: "${a.keyword}")\n`;
        if (a.job_location) text += `    📍 ${a.job_location}\n`;
        if (a.job_url) text += `    ${a.job_url}\n`;
      }
      text += '\n';
    }

    if (matches.description.length > 0) {
      text += `▸ DESCRIPTION MATCHES:\n`;
      for (const a of matches.description) {
        text += `  • "${a.job_title}" (keyword: "${a.keyword}")\n`;
        if (a.job_location) text += `    📍 ${a.job_location}\n`;
        if (a.job_url) text += `    ${a.job_url}\n`;
      }
      text += '\n';
    }
  }
  return text;
}

function formatAlertHtml(grouped) {
  let html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto;">
      <h1 style="color: #1a1a2e; border-bottom: 2px solid #e94560; padding-bottom: 8px;">Job Alert</h1>
  `;

  for (const [tabName, matches] of Object.entries(grouped)) {
    html += `<h2 style="color: #16213e; margin-top: 24px; background: #f0f0f0; padding: 8px 12px; border-radius: 4px;">${tabName}</h2>`;

    if (matches.title.length > 0) {
      html += `<h3 style="color: #e94560;">Title Matches</h3><ul style="list-style: none; padding: 0;">`;
      for (const a of matches.title) {
        html += `
          <li style="padding: 10px; margin: 6px 0; background: #fff8f0; border-left: 3px solid #e94560; border-radius: 0 4px 4px 0;">
            <strong>${escapeHtml(a.job_title)}</strong>
            <span style="color: #888; font-size: 0.85em;"> — matched: "${escapeHtml(a.keyword)}"</span><br/>
            ${a.job_location ? `<span style="color: #666; font-size: 0.85em;">📍 ${escapeHtml(a.job_location)}</span><br/>` : ''}
            ${a.job_url ? `<a href="${escapeHtml(a.job_url)}" style="color: #0066cc; font-size: 0.85em;">View Job →</a>` : ''}
          </li>`;
      }
      html += `</ul>`;
    }

    if (matches.description.length > 0) {
      html += `<h3 style="color: #0a9396;">Description Matches</h3><ul style="list-style: none; padding: 0;">`;
      for (const a of matches.description) {
        html += `
          <li style="padding: 10px; margin: 6px 0; background: #f0fff4; border-left: 3px solid #0a9396; border-radius: 0 4px 4px 0;">
            <strong>${escapeHtml(a.job_title)}</strong>
            <span style="color: #888; font-size: 0.85em;"> — matched: "${escapeHtml(a.keyword)}"</span><br/>
            ${a.job_location ? `<span style="color: #666; font-size: 0.85em;">📍 ${escapeHtml(a.job_location)}</span><br/>` : ''}
            ${a.job_url ? `<a href="${escapeHtml(a.job_url)}" style="color: #0066cc; font-size: 0.85em;">View Job →</a>` : ''}
          </li>`;
      }
      html += `</ul>`;
    }
  }

  html += `<p style="color: #999; font-size: 0.8em; margin-top: 24px; border-top: 1px solid #eee; padding-top: 12px;">Sent by Job Listing Alerts</p></div>`;
  return html;
}

function formatSmsText(grouped) {
  let sms = 'JOB ALERT\n';
  let count = 0;

  for (const [tabName, matches] of Object.entries(grouped)) {
    const all = [...matches.title, ...matches.description];
    if (all.length === 0) continue;
    sms += `\n[${tabName}]\n`;
    for (const a of all.slice(0, 5)) { // Limit per tab for SMS
      const matchLabel = a.match_type === 'title' ? 'T' : 'D';
      sms += `${matchLabel}: ${a.job_title} ("${a.keyword}")`;
      if (a.job_url) sms += `\n${a.job_url}`;
      sms += '\n';
      count++;
    }
    if (all.length > 5) {
      sms += `...and ${all.length - 5} more\n`;
    }
  }

  if (count === 0) return null;
  return sms;
}

async function sendEmailAlert(alerts) {
  const transport = getEmailTransport();
  if (!transport) {
    console.log('  Email not configured, skipping');
    return false;
  }
  const to = process.env.ALERT_TO_EMAIL;
  if (!to) {
    console.log('  ALERT_TO_EMAIL not set, skipping');
    return false;
  }

  const grouped = groupAlerts(alerts);
  const totalCount = alerts.length;

  try {
    await transport.sendMail({
      from: process.env.ALERT_FROM_EMAIL || process.env.SMTP_USER,
      to,
      subject: `Job Alert: ${totalCount} new match${totalCount > 1 ? 'es' : ''} found`,
      text: formatAlertText(grouped),
      html: formatAlertHtml(grouped),
    });
    console.log(`  Email sent to ${to} (${totalCount} alerts)`);
    return true;
  } catch (err) {
    console.error('  Email send failed:', err.message);
    return false;
  }
}

async function sendSmsAlert(alerts) {
  const client = getTwilioClient();
  if (!client) {
    console.log('  Twilio not configured, skipping');
    return false;
  }
  const to = process.env.ALERT_TO_PHONE;
  const from = process.env.TWILIO_FROM_NUMBER;
  if (!to || !from) {
    console.log('  Phone numbers not set, skipping');
    return false;
  }

  const grouped = groupAlerts(alerts);
  const body = formatSmsText(grouped);
  if (!body) return false;

  try {
    await client.messages.create({ body, from, to });
    console.log(`  SMS sent to ${to}`);
    return true;
  } catch (err) {
    console.error('  SMS send failed:', err.message);
    return false;
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = {
  sendEmailAlert,
  sendSmsAlert,
  groupAlerts,
};
