const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const express = require('express');
const app = express();

puppeteer.use(StealthPlugin());

app.use(express.json()); // Parse JSON bodies

app.post('/analyze', async (req, res) => {
  const { url } = req.body;

  console.log('Received request body:', req.body); // Log request body

  if (!url) {
    console.log('No URL provided in the request');
    return res.status(400).json({ error: 'URL is required' });
  }

  try {
    console.log(`Navigating to ${url}...`);

    const browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'] // Ajoutez ces options
    });
    const page = await browser.newPage();

    console.log('Browser launched, new page created.');

    await page.setExtraHTTPHeaders({
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/92.0.4515.107 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8'
    });

    console.log('Headers set. Navigating to the page...');

    await page.goto(url, { waitUntil: 'networkidle0' });

    console.log('Page loaded. Extracting source code...');
    const sourceCode = await page.content();

    let isGTMFound = sourceCode.includes('?id=GTM-');
    let isProxified = false;
    let gtmDomain = '';

    if (isGTMFound) {
      console.log('GTM snippet found in the source code.');

      const gtmMatch = sourceCode.match(/src=["']([^"']*\?id=GTM-[^"']*)["']/);
      if (gtmMatch) {
        const gtmSrc = gtmMatch[1];
        const gtmUrl = new URL(gtmSrc);
        gtmDomain = gtmUrl.hostname;

        console.log(`GTM Domain: ${gtmDomain}`);

        const siteHostname = new URL(url).hostname;
        const mainDomain = siteHostname.split('.').slice(-2).join('.');

        if (!gtmDomain.includes('google') && gtmDomain.endsWith(mainDomain)) {
          isProxified = true;
          console.log('The GTM domain appears to be proxified.');
        } else {
          console.log('The GTM domain is not proxified.');
        }
      }
    } else {
      console.log('No GTM snippet found via script src.');
      const scriptMatch = sourceCode.match(new RegExp(`<script[^>]*>([\\s\\S]*?GTM-[\\s\\S]*?)</script>`, 'i'));

      if (scriptMatch) {
        console.log('GTM ID found within inline script.');
        const scriptContent = scriptMatch[1];
        const siteHostname = new URL(url).hostname;
        const mainDomain = siteHostname.split('.').slice(-2).join('.');
        const subdomainPattern = new RegExp(`\\b${mainDomain.replace('.', '\\.')}`, 'i');

        if (scriptContent.includes('GTM-') && subdomainPattern.test(scriptContent)) {
          isProxified = true;
          console.log('The inline script appears to be proxified.');
        }
      }
    }

    await browser.close();
    console.log('Browser closed successfully.');

    const jsonResponse = {
      url,
      gtmDomain,
      isProxified,
      isGTMFound
    };

    console.log('Sending JSON response:', jsonResponse); // Log the JSON response

    res.json(jsonResponse);

  } catch (error) {
    console.error('Error occurred during the analysis:', error);
    res.status(500).json({ error: 'Failed to analyze the page' });
  }
});

app.listen(3000, '0.0.0.0', () => {
  console.log('Server is running on port 3000');
});