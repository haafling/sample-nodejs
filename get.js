const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const express = require('express');
const pLimit = require('p-limit'); // Ajout de p-limit

const app = express();
puppeteer.use(StealthPlugin());

app.use(express.json()); // Parse JSON bodies

// Limite à 2 tâches simultanées
const limit = pLimit(2);

app.post('/analyze', async (req, res) => {
  const { url } = req.body;

  console.log('Received request body:', req.body); // Log request body

  if (!url) {
    console.log('No URL provided in the request');
    return res.status(400).json({ error: 'URL is required' });
  }

  try {
    // Utilise p-limit pour gérer une file d'attente et exécuter 2 tâches maximum à la fois
    await limit(() => handleAnalysis(req, res, url));
  } catch (error) {
    console.error('Error occurred during the analysis:', error);
    res.status(500).json({ error: 'Failed to analyze the page' });
  }
});

async function handleAnalysis(req, res, url) {
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

    // Ajouter l'interception des requêtes pour bloquer certains types de ressources
    await page.setRequestInterception(true);

    page.on('request', (req) => {
      const resourceType = req.resourceType();
      if (resourceType === 'image' || resourceType === 'stylesheet' || resourceType === 'font') {
        req.abort(); // Bloque ces ressources pour accélérer le chargement
      } else {
        req.continue();
      }
    });

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });

    console.log('Page loaded. Extracting source code...');
    const sourceCode = await page.content();

    let isGTMFound = sourceCode.includes('?id=GTM-');
    let isProxified = false;
    let gtmDomain = '';

    if (isGTMFound) {
      console.log('GTM snippet found in the source code.');

      const gtmMatch = sourceCode.match(/src=["']([^"']*\?id=GTM-[^"']*)["']/);
      if (gtmMatch) {
        let gtmSrc = gtmMatch[1];

        // Si l'URL commence par "//", ajoutez "https:" pour en faire une URL complète
        if (gtmSrc.startsWith('//')) {
          gtmSrc = 'https:' + gtmSrc; // Ajouter "https:" comme schéma
        }

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
      console.log('No GTM ID found in the source code, checking for inline script...');

      const scriptMatches = sourceCode.match(/<script[^>]*>([\s\S]*?)<\/script>/gi);
      if (scriptMatches) {
        scriptMatches.forEach((scriptTag) => {
          if (/GTM-[A-Z0-9]+/.test(scriptTag)) {
            isGTMFound = true;
            console.log('Found inline script containing GTM ID.');
            console.log('Captured script content:', scriptTag);  // Afficher le script capturé

            const siteHostname = new URL(url).hostname;
            const mainDomain = siteHostname.split('.').slice(-2).join('.');
            const subdomainPattern = new RegExp(`\\b${mainDomain.replace('.', '\\.')}`, 'i');

            if (subdomainPattern.test(scriptTag)) {
              console.log('GTM is proxified (GTM ID and site domain detected in inline script).');
              isProxified = true;
            } else {
              console.log('GTM is not proxified.');
            }
          }
        });

        if (!isGTMFound) {
          console.log('No GTM-related inline script found.');
        }
      } else {
        console.log('No <script> tags found in the source code.');
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
}

app.listen(3000, '0.0.0.0', () => {
  console.log('Server is running on port 3000');
});