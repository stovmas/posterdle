const axios = require('axios');
const cheerio = require('cheerio');

const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// --- ATS Detection & Adapters ---

const ATS_PATTERNS = [
  { name: 'greenhouse', match: /boards\.greenhouse\.io\/(\w+)/i, adapter: scrapeGreenhouse },
  { name: 'greenhouse_embed', match: /greenhouse\.io.*board_token=(\w+)/i, adapter: scrapeGreenhouse },
  { name: 'lever', match: /jobs\.lever\.co\/([^\/\?]+)/i, adapter: scrapeLever },
  { name: 'ashby', match: /jobs\.ashbyhq\.com\/([^\/\?]+)/i, adapter: scrapeAshby },
  { name: 'workable', match: /apply\.workable\.com\/([^\/\?]+)/i, adapter: scrapeWorkable },
];

function detectATS(url) {
  for (const pattern of ATS_PATTERNS) {
    const match = url.match(pattern.match);
    if (match) {
      return { name: pattern.name, slug: match[1], adapter: pattern.adapter };
    }
  }
  return null;
}

// --- Greenhouse Adapter ---

async function scrapeGreenhouse(url, slug) {
  const apiUrl = `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`;
  const resp = await axios.get(apiUrl, {
    headers: { 'User-Agent': USER_AGENT },
    timeout: 15000,
  });
  const data = resp.data;
  const jobs = [];

  for (const job of (data.jobs || [])) {
    let description = '';
    // Fetch individual job for full description
    try {
      const detail = await axios.get(`${apiUrl}/${job.id}`, {
        headers: { 'User-Agent': USER_AGENT },
        timeout: 10000,
      });
      const $ = cheerio.load(detail.data.content || '');
      description = $.text().trim();
    } catch {
      // Use what we have
    }

    jobs.push({
      external_id: String(job.id),
      title: job.title,
      description,
      url: job.absolute_url,
      location: job.location ? job.location.name : null,
      department: job.departments && job.departments[0] ? job.departments[0].name : null,
    });
  }
  return jobs;
}

// --- Lever Adapter ---

async function scrapeLever(url, slug) {
  const apiUrl = `https://api.lever.co/v0/postings/${slug}?mode=json`;
  const resp = await axios.get(apiUrl, {
    headers: { 'User-Agent': USER_AGENT },
    timeout: 15000,
  });
  const data = resp.data;
  return (data || []).map(job => {
    const descParts = (job.lists || []).map(l => {
      return l.text + ': ' + l.content;
    }).join('\n');
    const desc = [job.descriptionPlain || job.description || '', descParts].join('\n').trim();

    return {
      external_id: job.id,
      title: job.text,
      description: stripHtml(desc),
      url: job.hostedUrl || job.applyUrl,
      location: job.categories ? job.categories.location : null,
      department: job.categories ? (job.categories.department || job.categories.team) : null,
    };
  });
}

// --- Ashby Adapter ---

async function scrapeAshby(url, slug) {
  const apiUrl = `https://api.ashbyhq.com/posting-api/job-board/${slug}`;
  const resp = await axios.get(apiUrl, {
    headers: { 'User-Agent': USER_AGENT },
    timeout: 15000,
  });
  const data = resp.data;
  return (data.jobs || []).map(job => ({
    external_id: job.id,
    title: job.title,
    description: stripHtml(job.descriptionHtml || job.descriptionPlain || ''),
    url: `https://jobs.ashbyhq.com/${slug}/${job.id}`,
    location: job.location,
    department: job.department,
  }));
}

// --- Workable Adapter ---

async function scrapeWorkable(url, slug) {
  // Workable has a JSON endpoint at /spi/v1/job_board
  const apiUrl = `https://apply.workable.com/api/v1/widget/accounts/${slug}`;
  try {
    const resp = await axios.get(apiUrl, {
      headers: { 'User-Agent': USER_AGENT },
      timeout: 15000,
    });
    const data = resp.data;
    return (data.jobs || []).map(job => ({
      external_id: job.shortcode,
      title: job.title,
      description: stripHtml(job.description || ''),
      url: job.url || `https://apply.workable.com/${slug}/j/${job.shortcode}`,
      location: job.city ? `${job.city}, ${job.country}` : job.country,
      department: job.department,
    }));
  } catch {
    // Fallback to HTML scraping
    return scrapeGenericHTML(url);
  }
}

// --- Generic HTML Scraper ---

async function scrapeGenericHTML(url) {
  const resp = await axios.get(url, {
    headers: { 'User-Agent': USER_AGENT },
    timeout: 20000,
    maxRedirects: 5,
  });
  const $ = cheerio.load(resp.data);
  const jobs = [];
  const seen = new Set();
  const baseUrl = new URL(url);

  // Strategy 1: Look for JSON-LD structured data
  const jsonLdJobs = extractJsonLd($);
  if (jsonLdJobs.length > 0) return jsonLdJobs;

  // Strategy 2: Look for links that look like job postings
  const jobLinkPatterns = [
    /\/jobs?\//i, /\/careers?\//i, /\/positions?\//i, /\/openings?\//i,
    /\/opportunities?\//i, /\/vacancies?\//i, /\/roles?\//i,
    /\/apply/i, /job_id=/i, /posting/i,
    /greenhouse\.io/i, /lever\.co/i, /workday\.com/i, /ashbyhq\.com/i,
  ];

  // Collect all links that look like job listings
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;

    const text = $(el).text().trim();
    if (!text || text.length < 3 || text.length > 200) return;

    const fullUrl = resolveUrl(href, baseUrl);
    if (!fullUrl || seen.has(fullUrl)) return;

    const isJobLink = jobLinkPatterns.some(p => p.test(fullUrl)) ||
                      jobLinkPatterns.some(p => p.test(href));

    // Also check if parent has job-related classes
    const parentClasses = ($(el).parent().attr('class') || '') + ' ' + ($(el).closest('[class]').attr('class') || '');
    const hasJobClass = /job|career|position|opening|posting|vacancy|role/i.test(parentClasses);

    if (isJobLink || hasJobClass) {
      seen.add(fullUrl);
      // Try to extract department/location from sibling or parent text
      const container = $(el).closest('li, tr, div[class], article');
      const containerText = container.length ? container.text().trim() : '';
      const location = extractLocation(containerText, text);

      jobs.push({
        external_id: null,
        title: text,
        description: containerText.length > text.length ? containerText : '',
        url: fullUrl,
        location,
        department: null,
      });
    }
  });

  // Strategy 3: If we found very few links, look for structured lists
  if (jobs.length < 3) {
    const listJobs = extractFromLists($, baseUrl);
    for (const job of listJobs) {
      if (!seen.has(job.url)) {
        seen.add(job.url);
        jobs.push(job);
      }
    }
  }

  return jobs;
}

// --- Helpers ---

function extractJsonLd($) {
  const jobs = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).html());
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        if (item['@type'] === 'JobPosting') {
          jobs.push({
            external_id: item.identifier ? item.identifier.value : null,
            title: item.title,
            description: stripHtml(item.description || ''),
            url: item.url || null,
            location: item.jobLocation ? formatLocation(item.jobLocation) : null,
            department: item.occupationalCategory || null,
          });
        }
        // Handle @graph arrays
        if (item['@graph']) {
          for (const node of item['@graph']) {
            if (node['@type'] === 'JobPosting') {
              jobs.push({
                external_id: node.identifier ? node.identifier.value : null,
                title: node.title,
                description: stripHtml(node.description || ''),
                url: node.url || null,
                location: node.jobLocation ? formatLocation(node.jobLocation) : null,
                department: node.occupationalCategory || null,
              });
            }
          }
        }
      }
    } catch {
      // ignore malformed JSON-LD
    }
  });
  return jobs;
}

function formatLocation(loc) {
  if (typeof loc === 'string') return loc;
  if (Array.isArray(loc)) return loc.map(formatLocation).join('; ');
  if (loc.address) {
    const a = loc.address;
    return [a.addressLocality, a.addressRegion, a.addressCountry].filter(Boolean).join(', ');
  }
  return loc.name || null;
}

function extractFromLists($, baseUrl) {
  const jobs = [];
  // Look for table rows or list items with links
  $('table tr, ul li, ol li').each((_, el) => {
    const $el = $(el);
    const link = $el.find('a[href]').first();
    if (!link.length) return;
    const href = link.attr('href');
    const text = link.text().trim();
    if (!text || text.length < 3) return;
    const fullUrl = resolveUrl(href, baseUrl);
    if (fullUrl) {
      jobs.push({
        external_id: null,
        title: text,
        description: $el.text().trim(),
        url: fullUrl,
        location: null,
        department: null,
      });
    }
  });
  return jobs;
}

function resolveUrl(href, baseUrl) {
  try {
    if (href.startsWith('http')) return href;
    if (href.startsWith('//')) return baseUrl.protocol + href;
    if (href.startsWith('/')) return baseUrl.origin + href;
    if (href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:')) return null;
    return new URL(href, baseUrl.href).href;
  } catch {
    return null;
  }
}

function extractLocation(text, title) {
  // Simple location extraction from container text
  const parts = text.replace(title, '').trim();
  const locMatch = parts.match(/(?:Location|Office|Based in)[:\s]*([^\n\|]+)/i);
  if (locMatch) return locMatch[1].trim();
  // Check for common location patterns (City, ST)
  const cityState = parts.match(/([A-Z][a-z]+(?:\s[A-Z][a-z]+)*,\s*[A-Z]{2})/);
  if (cityState) return cityState[1];
  return null;
}

function stripHtml(html) {
  if (!html) return '';
  const $ = cheerio.load(html);
  return $.text().replace(/\s+/g, ' ').trim();
}

// --- Fetch individual job description for deeper keyword matching ---

async function fetchJobDescription(jobUrl) {
  if (!jobUrl) return '';
  try {
    const resp = await axios.get(jobUrl, {
      headers: { 'User-Agent': USER_AGENT },
      timeout: 15000,
      maxRedirects: 5,
    });
    const $ = cheerio.load(resp.data);

    // Try JSON-LD first
    let desc = '';
    $('script[type="application/ld+json"]').each((_, el) => {
      try {
        const data = JSON.parse($(el).html());
        if (data['@type'] === 'JobPosting' && data.description) {
          desc = stripHtml(data.description);
        }
      } catch { /* ignore */ }
    });
    if (desc) return desc;

    // Remove scripts, styles, nav, footer
    $('script, style, nav, footer, header, [role="navigation"]').remove();

    // Look for main content area
    const selectors = [
      '[class*="description"]', '[class*="content"]', '[class*="details"]',
      '[id*="description"]', '[id*="content"]', '[id*="details"]',
      'main', 'article', '[role="main"]',
    ];
    for (const sel of selectors) {
      const el = $(sel).first();
      if (el.length && el.text().trim().length > 100) {
        return el.text().replace(/\s+/g, ' ').trim().slice(0, 5000);
      }
    }

    // Fallback: body text
    return $('body').text().replace(/\s+/g, ' ').trim().slice(0, 5000);
  } catch {
    return '';
  }
}

// --- Main Scrape Function ---

async function scrapeSource(source) {
  const ats = detectATS(source.url);
  if (ats) {
    console.log(`  [${ats.name}] Using API adapter for: ${source.url}`);
    return ats.adapter(source.url, ats.slug);
  }
  console.log(`  [generic] Scraping HTML for: ${source.url}`);
  return scrapeGenericHTML(source.url);
}

module.exports = {
  scrapeSource,
  fetchJobDescription,
  detectATS,
};
