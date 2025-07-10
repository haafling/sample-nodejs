

const express       = require('express');
const puppeteer     = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const pLimit        = require('p-limit');
const psl           = require('psl');
const { v4: uuidv4 }= require('uuid');

puppeteer.use(StealthPlugin());

const app = express();
app.use(express.json({ limit: '10kb' }));

// In-memory job store
const jobs = new Map();

// Concurrency limiter: 2 pages max
const limit = pLimit(2);

// Singleton browser
let browser = null;
async function getBrowser() {
  if (browser && browser.isConnected()) return browser;
  if (browser) await browser.close().catch(()=>{});
  browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process'
    ],
    timeout: 0
  });
  console.log('🔄 Browser (re)launched');
  return browser;
}

// Health-check
app.get('/', (_req, res) => res.send('OK'));

// Enqueue
app.post('/analyze', (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });
  try { new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL' }); }

  const jobId = uuidv4();
  jobs.set(jobId, { status: 'pending' });
  res.json({ jobId });

  setImmediate(() => {
    limit(() => handleAnalysis(jobId, url))
      .catch(err => console.error(`Job ${jobId} uncaught:`, err));
  });
});

// Fetch result
app.get('/result/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// Core logic
async function handleAnalysis(jobId, url) {
  let page;
  try {
    const b = await getBrowser();
    page = await b.newPage();
    page.setDefaultNavigationTimeout(30000);
    page.setDefaultTimeout(30000);

    // Block heavy resources
    await page.setRequestInterception(true);
    page.on('request', r => {
      const t = r.resourceType();
      if (t==='image' || t==='stylesheet' || t==='font') r.abort();
      else r.continue();
    });

    // Try navigation
    let html;
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      html = await page.content();
    } catch (e) {
      console.warn(`⚠️ Navigation timeout (${e.message}), capturing HTML anyway`);
      html = await page.content();
    }

    // GTM detection
    const isGTMFound = html.includes('?id=GTM-');
    let isProxified = false;
    let gtmDomain   = '';

    if (isGTMFound) {
      const m = html.match(/src=["']([^"']*\?id=GTM-[^"']*)["']/);
      if (m) {
        const src = m[1].startsWith('//') ? 'https:'+m[1] : m[1];
        try {
          gtmDomain = new URL(src).hostname;
          const main = new URL(url).hostname.split('.').slice(-2).join('.');
          if (!gtmDomain.includes('google') && gtmDomain.endsWith(main)) {
            isProxified = true;
          }
        } catch{}
      }
    }

    // Save result
    jobs.set(jobId, {
      status: 'done',
      result: { url, gtmDomain, isProxified, isGTMFound }
    });
  } catch (err) {
    console.error(`🔥 Job ${jobId} failed:`, err.stack||err);
    jobs.set(jobId, { status: 'error', error: err.message });
  } finally {
    if (page) await page.close().catch(()=>{});
  }
}

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
