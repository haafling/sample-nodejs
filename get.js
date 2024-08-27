const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

(async () => {
  try {
    console.log('Launching browser...');
    const browser = await puppeteer.launch({ headless: true });
    console.log('Browser launched.');

    const page = await browser.newPage();
    console.log('New page created.');

    // Set extra headers
    await page.setExtraHTTPHeaders({
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/92.0.4515.107 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8'
    });

    const url = 'https://bloon-paris.fr/'; // Remplacez par l'URL que vous souhaitez vérifier
    console.log(`Navigating to ${url}...`);
    await page.goto(url, { waitUntil: 'networkidle0' });
    console.log('Page loaded.');

    // Get the source code of the page
    const sourceCode = await page.content();
    console.log('Analyzing the source code...');

    const isGTMFound = sourceCode.includes('?id=GTM-');
    let isProxified = false;
    let gtmDomain = '';

    if (isGTMFound) {
      console.log('GTM ID found in the source code.');
      const gtmMatch = sourceCode.match(/src=["']([^"']*\?id=GTM-[^"']*)["']/);
      
      if (gtmMatch) {
        const gtmSrc = gtmMatch[1];
        console.log(`Found GTM source: ${gtmSrc}`);
        
        const gtmUrl = new URL(gtmSrc);
        gtmDomain = gtmUrl.hostname;

        const siteHostname = new URL(url).hostname;
        const mainDomain = siteHostname.split('.').slice(-2).join('.');

        // Vérifie si le domaine GTM est un sous-domaine ou le même domaine que le site visité
        if (gtmDomain.includes('google')) {
          console.log('GTM is not proxified (Google domain detected).');
        } else if (gtmDomain.endsWith(mainDomain)) {
          console.log('GTM is proxified (Site domain or subdomain detected).');
          isProxified = true;
        } else {
          console.log('GTM domain does not match known criteria.');
        }
      }
    } else {
      console.log('No GTM ID found in the source code, checking for inline script...');
      
      const scriptMatch = sourceCode.match(new RegExp(`<script[^>]*>([\\s\\S]*?GTM-[\\s\\S]*?)</script>`, 'i'));
      
      if (scriptMatch) {
        const scriptContent = scriptMatch[1];
        console.log('Found inline script containing GTM ID.');
        
        const siteHostname = new URL(url).hostname;
        const mainDomain = siteHostname.split('.').slice(-2).join('.');
        const subdomainPattern = new RegExp(`\\b${mainDomain.replace('.', '\\.')}`, 'i');
        
        if (scriptContent.includes('GTM-') && subdomainPattern.test(scriptContent)) {
          console.log('GTM is proxified (GTM ID and site domain detected in inline script).');
          isProxified = true;
        } else {
          console.log('GTM is not proxified.');
        }
      } else {
        console.log('No GTM-related inline script found.');
      }
    }

    console.log(`GTM Domain: ${gtmDomain}`);
    console.log(`Is GTM Proxified?: ${isProxified ? 'Yes' : 'No'}`);

    await browser.close();
    console.log('Browser closed.');
  } catch (error) {
    console.error('Error:', error);
  }
})();