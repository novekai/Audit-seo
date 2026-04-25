/**
 * sheet_plan_capture.js
 * Plan d'Action Google Sheets tabs capture.
 * Captures each tab as a raw PNG and uploads it to Cloudinary.
 */
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { uploadToCloudinary } from '../utils/cloudinary.js';
import { sanitizeCookies } from '../utils/cookies.js';

// ── Large viewport so Google Sheets renders many columns/rows at once ────────
// Google Sheets uses canvas-based virtual rendering, so we MUST open the browser
// with a large viewport from the start — resizing later does not re-render the grid.
const VIEWPORT = { width: 2560, height: 1600 };

// ── CSS to hide Google Sheets UI chrome ──────────────────────────────────────
const SHEETS_HIDE_CSS = `
  .grid-bottom-bar, .docs-sheet-tab-bar, #docs-header,
  #docs-chrome, .docs-titlebar-badges, .waffle-chip-container,
  #docs-menubar, .docs-butterbar-container, .docs-offline-indicator,
  .docs-gm3-topbar, .notranslate[role="banner"] { display: none !important; }
`;

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
        airtableField: "Img_donnee_image",
        tabName: "Données Images",
        cloudinarySlug: "plan-donnee-img"
    },
    {
        airtableField: "Img_longeur_page_plan",
        tabName: "Longueur de page",
        cloudinarySlug: "plan-longueur"
    },
    {
        airtableField: "Lien_image_qualite_des_pages",
        linkField: "Lien_qualite_des_pages",
        tabName: "Qualité des pages",
        cloudinarySlug: "plan-qualite-pages"
    },
];

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
        if (!gid) {
            gid = new URL(window.location.href).hash.match(/gid=([^&]+)/)?.[1] || null;
        }
        return { found: true, gid, isActive, name: target.innerText.trim() };
    }, tabName);

    if (!result.found) {
        await page.evaluate(() => { const b = document.querySelector('.grid-bottom-bar'); if (b) b.style.display = 'none'; });
        return { found: false };
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
    return { found: true, gid: result.gid };
}

function buildCurrentSheetTabUrl(page, gid) {
    if (!gid) return null;
    const url = new URL(page.url());
    url.hash = `gid=${gid}&range=A1`;
    return url.toString();
}

// ── Make sure the grid is scrolled to A1 and fully rendered ─────────────────
async function prepareGridForCapture(page) {
    // Jump to cell A1 so the capture always starts from the top-left of the sheet.
    try {
        await page.keyboard.press('Control+Home');
        await page.waitForTimeout(500);
    } catch { /* ignore */ }

    // Nudge Google Sheets to re-render by firing a resize event.
    await page.evaluate(() => window.dispatchEvent(new Event('resize')));
    await page.waitForTimeout(1500);
}

// ── Screenshot the grid element and upload raw to Cloudinary ────────────────
async function captureAndUpload(page, cloudinaryFolder) {
    const tmpDir = process.env.RAILWAY_ENVIRONMENT ? '/tmp' : '.';
    const tmpPath = path.join(tmpDir, `temp_plan_${uuidv4()}.png`);

    await prepareGridForCapture(page);

    // Prefer element screenshot of the grid container (it contains the canvas
    // cells + row/column headers). Fallback to a viewport screenshot if the
    // element is not available for any reason.
    const gridHandle = await page.$('#waffle-grid-container');
    if (gridHandle) {
        await gridHandle.screenshot({ path: tmpPath });
    } else {
        console.warn('[PLAN-CAPTURE] #waffle-grid-container not found, falling back to viewport screenshot');
        await page.screenshot({ path: tmpPath, fullPage: false });
    }

    const result = await uploadToCloudinary(tmpPath, cloudinaryFolder);
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    return result?.secure_url || result?.url || result;
}

// ── Open a Google Sheet with injected Google cookies ─────────────────────────
async function openSheet(sheetUrl, googleCookies) {
    const browser = await chromium.launch({
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-blink-features=AutomationControlled',
            `--window-size=${VIEWPORT.width},${VIEWPORT.height}`
        ]
    });
    const context = await browser.newContext({
        viewport: VIEWPORT,
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
    // Give the grid time to render its initial canvas paint.
    await page.waitForTimeout(2500);
    return { browser, context, page };
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
                const tabNavigation = await navigateToTab(page, tab.tabName);
                if (!tabNavigation.found) {
                    console.warn(`[PLAN-CAPTURE] ⚠️ Tab "${tab.tabName}" not found. skipping.`);
                    results[tab.airtableField] = { statut: 'SKIP', details: 'Onglet introuvable' };
                    continue;
                }

                console.log(`[PLAN-CAPTURE] 📸 Capturing content for: ${tab.tabName}`);
                const url = await captureAndUpload(page, `audit-results/${tab.cloudinarySlug}-${auditId}`);

                results[tab.airtableField] = {
                    statut: 'SUCCESS',
                    capture: url,
                    linkField: tab.linkField,
                    sheetUrl: buildCurrentSheetTabUrl(page, tabNavigation.gid)
                };
                console.log(`[PLAN-CAPTURE] ✅ Successfully captured and uploaded: ${tab.tabName}`);
            } catch (tabErr) {
                console.error(`[PLAN-CAPTURE] ❌ Error processing tab "${tab.tabName}": ${tabErr.message}`);
                results[tab.airtableField] = { statut: 'ERROR', details: tabErr.message };
            }
        }
    } catch (e) {
        console.error(`[PLAN-CAPTURE] 💥 Critical error opening sheet: ${e.message}`);
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
