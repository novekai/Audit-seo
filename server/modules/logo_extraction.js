import 'dotenv/config';
import { chromium } from 'playwright';
import { uploadBufferToCloudinary } from '../utils/cloudinary.js';
import { analyzeImage } from '../utils/openai.js';
import axios from 'axios';
import sharp from 'sharp';

/**
 * Audit Module: Logo Extraction (Refined)
 * 
 * 3-Stage Fetching Pipeline:
 * 1. Clearbit API
 * 2. Google Favicon API
 * 3. Playwright Scraper (Icon links & IMG tags)
 * 4. GPT-4o Vision fallback / validation
 */
export async function extractLogo(siteUrl, auditId) {
    const results = {
        statut: 'ERROR',
        details: 'Échec de l\'extraction',
        url: null
    };

    const urlObj = new URL(siteUrl);
    const domain = urlObj.hostname.replace('www.', '');

    // --- STAGE 1: CLEARBIT ---
    console.log(`[MODULE-LOGO] Stage 1: Trying Clearbit for ${domain}`);
    try {
        const clearbitUrl = `https://logo.clearbit.com/${domain}?size=500`;
        const res = await axios.get(clearbitUrl, { responseType: 'arraybuffer', timeout: 5000 });
        if (res.status === 200) {
            results.url = await uploadBufferToCloudinary(res.data, `logo-cb-${auditId}.png`, 'audit-results');
            results.statut = 'SUCCESS';
            results.details = 'Logo extrait via Clearbit API';
            console.log(`[MODULE-LOGO] Clearbit Success: ${results.url}`);
            return results;
        }
    } catch (e) {
        console.log(`[MODULE-LOGO] Stage 1 (Clearbit) failed: ${e.message}`);
    }

    // --- STAGE 2: GOOGLE FAVICON ---
    console.log(`[MODULE-LOGO] Stage 2: Trying Google Favicon for ${domain}`);
    try {
        const googleUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=256`;
        const res = await axios.get(googleUrl, { responseType: 'arraybuffer', timeout: 5000 });
        if (res.status === 200) {
            results.url = await uploadBufferToCloudinary(res.data, `logo-gg-${auditId}.png`, 'audit-results');
            results.statut = 'SUCCESS';
            results.details = 'Logo extrait via Google Favicon API';
            console.log(`[MODULE-LOGO] Google Success: ${results.url}`);
            return results;
        }
    } catch (e) {
        console.log(`[MODULE-LOGO] Stage 2 (Google) failed: ${e.message}`);
    }

    // --- STAGE 3: PLAYWRIGHT SCRAPER ---
    let browser;
    try {
        console.log(`[MODULE-LOGO] Stage 3: Scraping homepage for ${siteUrl}`);
        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage();
        await page.goto(siteUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

        // A. Check common icon/meta tags
        const selectors = [
            "link[rel='icon']", "link[rel='shortcut icon']",
            "link[rel='apple-touch-icon']", "meta[property='og:image']"
        ];

        let foundUrl = null;
        for (const sel of selectors) {
            const el = await page.locator(sel).first();
            if (await el.count() > 0) {
                const attr = sel.includes('meta') ? 'content' : 'href';
                foundUrl = await el.getAttribute(attr);
                if (foundUrl && foundUrl.length > 5) break;
            }
        }

        // B. Check IMG tags with "logo"
        if (!foundUrl) {
            foundUrl = await page.evaluate(() => {
                const imgs = Array.from(document.querySelectorAll('img'));
                const logoImg = imgs.find(img =>
                    (img.src && img.src.toLowerCase().includes('logo')) ||
                    (img.alt && img.alt.toLowerCase().includes('logo'))
                );
                return logoImg ? logoImg.src : null;
            });
        }

        if (foundUrl) {
            const absoluteUrl = foundUrl.startsWith('http') ? foundUrl : new URL(foundUrl, siteUrl).href;
            const res = await axios.get(absoluteUrl, { responseType: 'arraybuffer', timeout: 10000 });
            results.url = await uploadBufferToCloudinary(res.data, `logo-sc-${auditId}.png`, 'audit-results');
            results.statut = 'SUCCESS';
            results.details = 'Logo extrait via Scraping DOM';
            console.log(`[MODULE-LOGO] Scraper Success: ${results.url}`);
            return results;
        }

        // --- STAGE 4: AI FALLBACK ---
        console.log(`[MODULE-LOGO] Stage 4: Using AI Vision to find logo...`);
        // Take a screenshot of the top of the page
        const headerBuffer = await page.screenshot({ clip: { x: 0, y: 0, width: 1280, height: 500 } });
        const headerUrl = await uploadBufferToCloudinary(headerBuffer, `header-${auditId}.png`, 'audit-captures');

        const prompt = "Identify the main company logo in this screenshot. Return ONLY a JSON object: {\"x\": 10, \"y\": 10, \"width\": 200, \"height\": 80}. Coordinates are relative to 1280x500. No text.";
        const aiResponse = await analyzeImage(headerUrl, prompt);

        const jsonMatch = aiResponse.match(/\{.*\}/s);
        if (jsonMatch) {
            const coords = JSON.parse(jsonMatch[0]);
            if (coords && !coords.error && coords.width > 0) {
                const logoBuffer = await sharp(headerBuffer)
                    .extract({
                        left: Math.max(0, Math.floor(coords.x - 10)),
                        top: Math.max(0, Math.floor(coords.y - 10)),
                        width: Math.min(1280 - coords.x, Math.floor(coords.width + 20)),
                        height: Math.min(500 - coords.y, Math.floor(coords.height + 20))
                    })
                    .toBuffer();

                results.url = await uploadBufferToCloudinary(logoBuffer, `logo-ai-${auditId}.png`, 'audit-results');
                results.statut = 'SUCCESS';
                results.details = 'Logo extrait via AI Vision (Coup de grâce)';
                return results;
            }
        }

    } catch (err) {
        console.error(`[MODULE-LOGO] Error: ${err.message}`);
        results.details = `Erreur: ${err.message}`;
    } finally {
        if (browser) await browser.close();
    }

    return results;
}
