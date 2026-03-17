import { chromium } from 'playwright';
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { uploadToCloudinary } from '../utils/cloudinary.js';
import { analyzeImage } from '../utils/openai.js';
import { sanitizeCookies } from '../utils/cookies.js';

async function cropWithAI(imagePath, prompt) {
    try {
        const response = await analyzeImage(imagePath, prompt);
        const match = response.match(/CROP:\s*x=(\d+),\s*y=(\d+),\s*width=(\d+),\s*height=(\d+)/i);
        if (!match) return imagePath;
        const [, x, y, w, h] = match.map(Number);
        const meta = await sharp(imagePath).metadata();
        const left = Math.min(x, meta.width - 10);
        const top = Math.min(y, meta.height - 10);
        const width = Math.min(w, meta.width - left);
        const height = Math.min(h, meta.height - top);
        if (width < 20 || height < 20) return imagePath;
        const croppedPath = imagePath.replace('.png', '_cropped.png');
        await sharp(imagePath).extract({ left, top, width, height }).toFile(croppedPath);
        fs.unlinkSync(imagePath);
        return croppedPath;
    } catch (e) { return imagePath; }
}

// ── UBERSUGGEST — Domain Authority ───────────────────────────────────────────
export async function captureUbersuggest(siteUrl, auditId, cookies) {
    const result = { statut: 'ERROR', capture: null };

    if (!cookies || !cookies.length) {
        result.statut = 'SKIP';
        result.details = 'Session Ubersuggest non configurée ou invalide';
        return result;
    }

    const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const context = await browser.newContext({
        viewport: { width: 1400, height: 900 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        locale: 'fr-FR'
    });
    await context.addCookies(sanitizeCookies(cookies));
    const page = await context.newPage();
    page.setDefaultTimeout(90000);

    try {
        // Navigate to Traffic Analyzer
        const domain = new URL(siteUrl.startsWith('http') ? siteUrl : `https://${siteUrl}`).hostname;
        const uberUrl = `https://app.neilpatel.com/fr/traffic_analyzer/overview?domain=${domain}`;
        await page.goto(uberUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

        // Check login
        if (page.url().includes('login') || page.url().includes('signin')) {
            result.statut = 'SKIP'; result.details = 'Session Ubersuggest expirée'; return result;
        }

        await page.waitForTimeout(15000); // Results in Ubersuggest can take significant time to render

        const tmpPath = path.resolve(`temp_uber_${uuidv4()}.png`);
        await page.screenshot({ path: tmpPath, fullPage: false });

        const prompt = `Cette image est une capture d'Ubersuggest.
Identifie et rogne pour ne garder que la carte intitulée "DOMAIN AUTHORITY".
CROP: x=[left], y=[top], width=[largeur], height=[hauteur]`;

        const croppedPath = await cropWithAI(tmpPath, prompt);
        const uploaded = await uploadToCloudinary(croppedPath, `audit-results/ubersuggest-da-${auditId}`);
        if (fs.existsSync(croppedPath)) fs.unlinkSync(croppedPath);
        if (fs.existsSync(tmpPath) && tmpPath !== croppedPath) fs.unlinkSync(tmpPath);

        result.capture = uploaded?.secure_url || uploaded?.url || uploaded;
        result.statut = 'SUCCESS';
    } catch (e) {
        result.details = e.message;
        console.error('[UBERSUGGEST] Error:', e.message);
    } finally { await browser.close(); }
    return result;
}
