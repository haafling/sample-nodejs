const puppeteer = require('puppeteer-extra'); // switched to core
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const express = require('express');
const pLimit = require('p-limit');
const tld = require('tldjs');

const app = express();
puppeteer.use(StealthPlugin());

app.use(express.json());

// Limite à 1 tâche simultanée (vCPU et RAM limitées)
const limit = pLimit(1);

// Singleton browser instance
let browserPromise;
async function getBrowser() {
  if (!browserPromise) {
    browserPromise = puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
  }
  return browserPromise;
}

app.post('/analyze', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  // Validation SSRF basique
  let parsed;
  try {
    parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
    if (/^(localhost|127\.0\.0\.1|169\.254\.169\.254)$/.test(parsed.hostname)) throw new Error();
  } catch {
    return res.status(400).json({ error: 'Invalid or unsafe URL' });
  }

  try {
    await limit(() => handleAnalysis(req, res, parsed.href));
  } catch (err) {
    console.error('Error in queue handler:', err);
    res.status(500).json({ error: 'Failed to analyze' });
  }
});

async function handleAnalysis(req, res, url) {
  let page;
  const browser = await getBrowser();
  try {
    page = await browser.newPage();
    await page.setExtraHTTPHeaders({
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Accept-Language': 'en-US,en;q=0.9',
    });
    await page.setRequestInterception(true);
    page.on('request', r => {
      const rt = r.resourceType();
      if (['image','stylesheet','font','media','script'].includes(rt)) r.abort();
      else r.continue();
    });

    console.info(`Navigating to ${url}`);
    try {
      // Timeout après 30s même si networkidle2 non atteint
      await Promise.race([
        page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 }),
        new Promise(resolve => setTimeout(resolve, 30000))
      ]);
    } catch (e) {
      if (e.name === 'TimeoutError') {
        console.warn('Navigation timeout: proceeding with available content');
      } else {
        throw e;
      }
    }

    const source = await page.content();
    // ... logique GTM (inchangée)
    // Exemple minimal :
    const isGTMFound = source.includes('?id=GTM-');
    res.json({ url, isGTMFound });

  } catch (err) {
    console.error('Error during analysis:', err);
    res.status(500).json({ error: 'Analysis failed' });
  } finally {
    if (page) await page.close();
  }
}

app.listen(3000, '0.0.0.0', () => console.info('Server running'));
