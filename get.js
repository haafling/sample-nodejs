/*
 * Resilient Express + Puppeteer-extra (Stealth) service
 * • Singleton browser with auto-relaunch on crash
 * • Concurrency limit: 2 analyses at once
 * • Health check GET /
 * • POST /analyze → { jobId }
 * • GET  /result/:jobId → { status, result?, error? }
 */

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

// Concurrency limiter: max 2 parallel analyses
const limit = pLimit(2);

// --- Singleton browser with auto-relaunch ---
let browser = null;
async function getBrowser() {
  if (browser && browser.isConnected()) {
    return browser;
  }
  if (browser) {
    try { await browser.close(); } catch (e) { /* ignore */ }
  }
  browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process'
    ],
    timeout: 0,
    dumpio: false
  });
  console.log('🔄 Browser (re)launched');
  return browser;
}

// Catch and recover from unhandled errors
process.on('unhandledRejection', async err => {
  console.error('UnhandledRejection', err);
  await getBrowser();
});
process.on('uncaughtException', async err => {
  console.error('UncaughtException', err);
  await getBrowser();
});

// --- Health check ---
app.get('/', (_req, res) => res.send('OK'));

// --- Enqueue analysis ---
app.post('/analyze', (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });
  try { new URL(url); }
  catch { return res.status(400).json({ error: 'Invalid URL' }); }

  const jobId = uuidv4();
  jobs.set(jobId, { status: 'pending' });
  res.json({ jobId });

  // launch work asynchronously, without blocking response
  setImmediate(() => {
    limit(() => handleAnalysis(jobId, url))
      .catch(err => console.error(`Job ${jobId} failed:`, err));
  });
});

// --- Fetch job result ---
app.get('/result/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// --- Core analysis logic ---
async function handleAnalysis(jobId, url) {
  let page = null;
  try {
    const b = await getBrowser();
    page = await b.newPage();
    page.setDefaultNavigationTimeout(30000);
    page.setDefaultTimeout(30000);

    // log page errors without crashing
    page.on('error', err => console.error('Page error:', err));
    page.on('pageerror', err => console.error('Page uncaught exception:', err));

    // set headers
    await page.setExtraHTTPHeaders({
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html'
    });

    // block heavy resources
    await page.setRequestInterception(true);
    page.on('request', req => {
      const t = req.resourceType();
      if (t === 'image' || t === 'stylesheet' || t === 'font') req.abort();
      else req.continue();
    });

    // retry navigation up to 2 times
    let html;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        html = await page.content();
        break;
      } catch (e) {
        console.warn(`goto attempt #${attempt + 1} failed:`, e.message);
        if (attempt === 1) throw e;
      }
    }

    // GTM detection
    const isGTMFound = html.includes('?id=GTM-');
    let isProxified = false;
    let gtmDomain   = '';

    if (isGTMFound) {
      const m = html.match(/src=["']([^"']*\?id=GTM-[^"']*)["']/);
      if (m) {
        let src = m[1].startsWith('//') ? 'https:' + m[1] : m[1];
        try {
          const host = new URL(src).hostname;
          gtmDomain = host;
          const main = new URL(url).hostname.split('.').slice(-2).join('.');
          if (!host.includes('google') && host.endsWith(main)) {
            isProxified = true;
          }
        } catch {}
      }
    }

    // store result
    jobs.set(jobId, {
      status: 'done',
      result: { url, gtmDomain, isProxified, isGTMFound }
    });
  } catch (err) {
    console.error(`Error in job ${jobId}:`, err.stack || err);
    jobs.set(jobId, { status: 'error', error: err.message });
  } finally {
    if (page) {
      try { await page.close(); }
      catch (e) { console.error('Failed to close page:', e); }
    }
  }
}

// --- Start server ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
