/**
 * sheet_plan_capture.js
 * Optimized Plan d'Action Google Sheets tabs capture.
 * Uses robust navigation and UI hiding logic provided by the user.
 */
import { chromium } from 'playwright';
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { uploadToCloudinary } from '../utils/cloudinary.js';
import { analyzeImage } from '../utils/openai.js';
import { sanitizeCookies } from '../utils/cookies.js';

// ── CSS to hide Google Sheets UI chrome ──────────────────────────────────────
const SHEETS_HIDE_CSS = `
  .grid-bottom-bar, .docs-sheet-tab-bar, #docs-header,
  #docs-chrome, .docs-titlebar-badges, .waffle-chip-container,
  #docs-menubar, .docs-butterbar-container, .docs-offline-indicator,
  .docs-gm3-topbar, .notranslate[role="banner"] { display: none !important; }
`;

const SHEET_CROP_PROMPT = `Tu es un expert en rognage d'images.
Cette image est une capture d'écran d'un Google Sheet.
Tu DOIS rogner pour ne garder STRICTEMENT que le tableau de données visibles.

RÈGLES STRICTES :
1. Supprime TOUT en haut : barre de menus, barre d'outils, barre de formule, en-tête du document
2. Supprime TOUT en bas : barre d'onglets, barre de défilement, pied de page
3. Supprime TOUTES les marges vides à droite et en bas du tableau
4. Supprime les colonnes de lettres (A, B, C...) et les numéros de lignes (1, 2, 3...)
5. Le résultat doit être un tableau SERRÉ sans aucun espace vide autour
6. NE COUPE AUCUNE donnée du tableau. Tu DOIS ABSOLUMENT CONSERVER la première ligne d'en-tête contenant les noms des colonnes (ex: URL, Destination, H1...). Ne la rogne surtout pas.

Réponds UNIQUEMENT avec : CROP: x=[left], y=[top], width=[largeur], height=[hauteur]`;

// ── Plan d'action tabs mapping ────────────────────────────────────────────────
const PLAN_TABS = [
    {
        airtableField: "Img_planD'action",
        tabName: "Synthèse Audit - Plan d'action",
        cloudinarySlug: "plan-synthese"
    },
    {
        airtableField: "Img_Requetes_cles",
        tabName: "Requêtes Clés / Calédito",
        cloudinarySlug: "plan-requetes"
    },
    {
        airtableField: "Img_donnee image",
        tabName: "Données Images",
        cloudinarySlug: "plan-donnee-img"
    },
    {
        airtableField: "Img_longeur_page_plan",
        tabName: "Longueur de page",
        cloudinarySlug: "plan-longueur"
    },
];

// ── AI crop helper ────────────────────────────────────────────────────────────
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
        if (fs.existsSync(imagePath)) fs.unlinkSync(imagePath);
        return croppedPath;
    } catch (e) {
        console.warn(`[PLAN-CAPTURE] AI crop failed: ${e.message}`);
        return imagePath;
    }
}

// ── Navigate to a sheet and select a specific tab by name ────────────────────
async function navigateToTab(page, tabName) {
    console.log(`[PLAN-CAPTURE] Navigating to tab: "${tabName}"`);
    await page.evaluate(() => {
        const tabBar = document.querySelector('.docs-sheet-tab-bar') || document.querySelector('.grid-bottom-bar');
        if (tabBar) tabBar.style.display = 'block';
    });
    await page.waitForTimeout(2000);

    const result = await page.evaluate((name) => {
        const tabSelectors = [
            '.docs-sheet-tab-name',
            '.docs-sheet-tab .docs-sheet-tab-caption',
            '[data-tab-name]',
            '.docs-sheet-tab span'
        ];
        let tabs = [];
        for (const sel of tabSelectors) {
            tabs = Array.from(document.querySelectorAll(sel));
            if (tabs.length > 0) break;
        }
        if (tabs.length === 0) return { found: false, noTabs: true };
        const target = tabs.find(t => t.innerText.trim().toLowerCase().includes(name.toLowerCase()));
        if (!target) return { found: false, available: tabs.map(t => t.innerText.trim()) };
        const parent = target.closest('.docs-sheet-tab');
        const isActive = parent && parent.classList.contains('docs-sheet-active-tab');
        let gid = null;
        if (parent && parent.id && parent.id.startsWith('sheet-button-')) gid = parent.id.replace('sheet-button-', '');
        if (!gid && parent) {
            const dataId = parent.getAttribute('data-id');
            if (dataId) gid = dataId;
        }
        return { found: true, gid, isActive, name: target.innerText.trim() };
    }, tabName);

    if (!result.found) {
        await page.evaluate(() => { const b = document.querySelector('.grid-bottom-bar'); if (b) b.style.display = 'none'; });
        return false;
    }

    if (!result.isActive && result.gid) {
        const url = new URL(page.url());
        url.hash = `gid=${result.gid}`;
        await page.goto(url.toString(), { waitUntil: 'networkidle', timeout: 60000 });
        await page.addStyleTag({ content: SHEETS_HIDE_CSS });
    } else if (!result.isActive) {
        await page.evaluate((name) => {
            const tabSelectors = ['.docs-sheet-tab-name', '.docs-sheet-tab span'];
            for (const sel of tabSelectors) {
                const tabs = Array.from(document.querySelectorAll(sel));
                const target = tabs.find(t => t.innerText.trim().toLowerCase().includes(name.toLowerCase()));
                if (target) {
                    const parent = target.closest('.docs-sheet-tab') || target;
                    parent.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                    parent.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
                    parent.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                    return true;
                }
            }
            return false;
        }, tabName);
        await page.waitForTimeout(4000);
    }
    await page.evaluate(() => { const b = document.querySelector('.grid-bottom-bar'); if (b) b.style.display = 'none'; });
    await page.waitForTimeout(2000);
    return true;
}

// ── Open a Google Sheet with injected Google cookies ─────────────────────────
async function openSheet(sheetUrl, googleCookies) {
    const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
    });
    const context = await browser.newContext({
        viewport: { width: 1600, height: 900 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        locale: 'fr-FR'
    });
    if (googleCookies && googleCookies.length) {
        const cleanCookies = sanitizeCookies(googleCookies);
        await context.addCookies(cleanCookies);
    }
    const page = await context.newPage();
    page.setDefaultTimeout(90000);
    await page.goto(sheetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    try {
        await page.waitForSelector('#waffle-grid-container', { state: 'visible', timeout: 20000 });
    } catch {
        await page.waitForSelector('body', { state: 'visible', timeout: 5000 });
    }
    await page.addStyleTag({ content: SHEETS_HIDE_CSS });
    return { browser, context, page };
}

// ── Screenshot and upload ───────────────────────────────────────────────────
async function captureAndUpload(page, promptText, cloudinaryFolder) {
    const tmpDir = process.env.RAILWAY_ENVIRONMENT ? '/tmp' : '.';
    const tmpPath = path.join(tmpDir, `temp_plan_${uuidv4()}.png`);
    await page.screenshot({ path: tmpPath, fullPage: false });
    const croppedPath = await cropWithAI(tmpPath, promptText);
    const result = await uploadToCloudinary(croppedPath, cloudinaryFolder);
    if (fs.existsSync(croppedPath)) fs.unlinkSync(croppedPath);
    if (fs.existsSync(tmpPath) && tmpPath !== croppedPath) fs.unlinkSync(tmpPath);
    return result?.secure_url || result?.url || result;
}

// ── Main entry point ────────────────────────────────────────────────────────
export async function capturePlanDAction(sheetPlanUrl, auditId, googleCookies) {
    console.log(`[PLAN-CAPTURE] Starting Plan d'Action capture for URL: ${sheetPlanUrl}`);
    const results = {};
    let browser, page;

    try {
        const session = await openSheet(sheetPlanUrl, googleCookies);
        browser = session.browser;
        page = session.page;

        for (const tab of PLAN_TABS) {
            try {
                console.log(`[PLAN-CAPTURE] 🎯 Processing tab: "${tab.tabName}"`);
                const found = await navigateToTab(page, tab.tabName);
                if (!found) {
                    console.warn(`[PLAN-CAPTURE] ⚠️ Tab "${tab.tabName}" not found. skipping.`);
                    results[tab.airtableField] = { statut: 'SKIP', details: 'Onglet introuvable' };
                    continue;
                }

                console.log(`[PLAN-CAPTURE] 📸 Capturing content for: ${tab.tabName}`);
                const url = await captureAndUpload(page,
                    `${SHEET_CROP_PROMPT}\nRogne pour ne garder que le tableau. Supprime tous les menus.`,
                    `audit-results/${tab.cloudinarySlug}-${auditId}`
                );

                results[tab.airtableField] = { statut: 'SUCCESS', capture: url };
                console.log(`[PLAN-CAPTURE] ✅ Successfully captured and uploaded: ${tab.tabName}`);
            } catch (tabErr) {
                console.error(`[PLAN-CAPTURE] ❌ Error processing tab "${tab.tabName}": ${tabErr.message}`);
                results[tab.airtableField] = { statut: 'ERROR', details: tabErr.message };
            }
        }
    } catch (e) {
        console.error(`[PLAN-CAPTURE] 💥 Critical error opening sheet: ${e.message}`);
        // Mark all as error if we can't even open the sheet
        for (const tab of PLAN_TABS) {
            results[tab.airtableField] = { statut: 'ERROR', details: e.message };
        }
    } finally {
        if (browser) {
            console.log(`[PLAN-CAPTURE] Closing browser.`);
            await browser.close();
        }
    }
    return results;
}
