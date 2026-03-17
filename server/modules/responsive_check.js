import { chromium, devices } from 'playwright';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { uploadToCloudinary } from '../utils/cloudinary.js';

const MOBILE_DEVICE = devices['iPhone 13'];

function getTmpDir() {
    return process.env.RAILWAY_ENVIRONMENT ? '/tmp' : '.';
}

function cleanupFile(filePath) {
    if (filePath && fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
    }
}

async function uploadScreenshot(filePath, folder) {
    return await uploadToCloudinary(filePath, folder);
}

async function dismissCookieBanners(page) {
    for (const txt of ['Accept', 'OK', 'Tout accepter', 'I agree', 'Accept all', 'Accepter']) {
        try {
            const btn = page.locator(`button:has-text("${txt}")`).first();
            if (await btn.count() > 0 && await btn.isVisible()) {
                await btn.click();
                await page.waitForTimeout(500);
                return;
            }
        } catch {
            // Continue with the next candidate.
        }
    }
}

async function clickFirstVisible(page, selectors) {
    for (const selector of selectors) {
        try {
            const locator = page.locator(selector).first();
            if (await locator.count() === 0) continue;
            if (!await locator.isVisible()) continue;
            await locator.click({ timeout: 5000 });
            return true;
        } catch {
            // Continue with the next selector candidate.
        }
    }

    return false;
}

async function captureMobileSite(browser, url, auditId) {
    const context = await browser.newContext({
        ...MOBILE_DEVICE,
        locale: 'fr-FR',
        ignoreHTTPSErrors: true
    });
    const page = await context.newPage();

    let capture1 = null;
    let capture2 = null;

    try {
        console.log('[MODULE-RESPONSIVE] Capture mobile dédiée...');
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => { });
        await dismissCookieBanners(page);
        await page.waitForTimeout(2500);

        const screenshotPath1 = path.join(getTmpDir(), `temp_responsive_mobile_1_${uuidv4()}.png`);
        const screenshotPath2 = path.join(getTmpDir(), `temp_responsive_mobile_2_${uuidv4()}.png`);

        try {
            await page.screenshot({ path: screenshotPath1, fullPage: false });
            capture1 = await uploadScreenshot(screenshotPath1, `audit-results/responsive-mobile-1-${auditId}`);

            const menuOpened = await clickFirstVisible(page, [
                'button[aria-label*="menu" i]',
                '[role="button"][aria-label*="menu" i]',
                'button[aria-controls*="menu" i]',
                'button[class*="menu"]',
                'button[class*="Menu"]',
                'button[class*="burger"]',
                'button[class*="hamb"]',
                '.menu-toggle',
                '.navbar-toggler',
                'button:has-text("Menu")',
                'a:has-text("Menu")',
                'summary'
            ]);

            await page.waitForTimeout(menuOpened ? 1800 : 1200);

            if (!menuOpened) {
                await page.evaluate(() => window.scrollBy(0, Math.max(window.innerHeight * 0.75, 450)));
                await page.waitForTimeout(800);
            }

            await page.screenshot({ path: screenshotPath2, fullPage: false });
            capture2 = await uploadScreenshot(screenshotPath2, `audit-results/responsive-mobile-2-${auditId}`);
        } finally {
            cleanupFile(screenshotPath1);
            cleanupFile(screenshotPath2);
        }
    } finally {
        await context.close();
    }

    return { capture1, capture2 };
}

/**
 * Audit Responsive Design via AmIResponsive
 * - Navigate to amiresponsive.co.uk with the site URL
 * - Wait for the devices container (.devices) to appear
 * - Wait for the iframes inside the devices to actually load the site content
 * - Dismiss cookie banners if any
 * - Capture only the devices area
 */
export async function auditResponsive(url, auditId) {
    const domain = new URL(url).hostname;
    const amiUrl = `https://amiresponsive.co.uk/?url=${encodeURIComponent(url)}`;
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({
        viewport: { width: 1400, height: 1000 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();

    let result = {
        statut: 'FAILED',
        capture: null,
        is_responsive: false,
        menu_capture_1: null,
        menu_capture_2: null
    };

    try {
        console.log(`[MODULE-RESPONSIVE] Starting check for ${domain}...`);
        // Use domcontentloaded for faster start, then wait specifically for what we need
        await page.goto(amiUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

        // ── 1. Forcer la soumission de l'URL car l'URL parameter ne marche pas toujours ──
        console.log('[MODULE-RESPONSIVE] Saisie de l\'URL et validation...');
        try {
            for (const inputSel of ['input[name="url"]', 'input[type="text"]', 'input[id="url"]']) {
                const input = page.locator(inputSel).first();
                if (await input.count() > 0 && await input.isVisible()) {
                    await input.fill(url);
                    break;
                }
            }
            for (const btnSel of ['button:has-text("GO")', 'input[type="submit"]', 'button[type="submit"]', '#go']) {
                const btn = page.locator(btnSel).first();
                if (await btn.count() > 0 && await btn.isVisible()) {
                    await btn.click();
                    break;
                }
            }
            await page.waitForTimeout(10000); // Laisse le temps aux iframes de se générer et charger sur tous les écrans
        } catch {
            console.log('[MODULE-RESPONSIVE] Échec de la saisie manuelle, tentative via paramètre URL seule.');
        }

        // Wait for the devices container to appear
        console.log('[MODULE-RESPONSIVE] Waiting for devices container...');
        try {
            await page.waitForSelector('.FrameContainer, .devices, [class*="device"], iframe', {
                state: 'visible', timeout: 20000
            });
            console.log('[MODULE-RESPONSIVE] Devices container found.');
        } catch { }

        await dismissCookieBanners(page);

        // CRITICAL: Wait for iframes to actually load the site content
        console.log('[MODULE-RESPONSIVE] Attente du chargement DOM réel dans les iframes...');
        try {
            // Surveille la présence du contenu (body) dans les iframes
            await page.waitForFunction(() => {
                const iframes = document.querySelectorAll('iframe');
                if (iframes.length === 0) return false;
                for (const frame of iframes) {
                    try {
                        const content = frame.contentWindow || frame.contentDocument;
                        const doc = frame.contentDocument || content.document;
                        // Considéré comme chargé si le document d'iframe a une taille et un body
                        if (doc && doc.body && doc.body.innerHTML.length > 50) return true;
                    } catch (e) {
                        // Cross-origin: on assume que ça charge si src a changé
                        if (frame.src && frame.src.length > 10) return true;
                    }
                }
                return false;
            }, { timeout: 25000 });
            console.log('[MODULE-RESPONSIVE] Iframes prêtes.');
        } catch {
            console.log('[MODULE-RESPONSIVE] Délai dépassé pour iframes, on continue...');
        }

        // Wait additional time for images/CSS to render fully in the iframe
        console.log('[MODULE-RESPONSIVE] Attente supplémentaire pour le rendu (8s)...');
        await page.waitForTimeout(8000);

        // Take screenshot — capture only the devices area if possible
        const screenshotPath = path.join(getTmpDir(), `temp_responsive_${uuidv4()}.png`);

        // Try to screenshot just the device frames area
        const devicesElement = await page.$('.FrameContainer, .devices, [class*="frame-container"]');
        if (devicesElement) {
            await devicesElement.screenshot({ path: screenshotPath });
            console.log('[MODULE-RESPONSIVE] Captured devices container');
        } else {
            // Fallback to viewport screenshot
            await page.screenshot({ path: screenshotPath, fullPage: false });
            console.log('[MODULE-RESPONSIVE] Captured full viewport (fallback)');
        }

        console.log('[MODULE-RESPONSIVE] Uploading to Cloudinary...');
        const cloudRes = await uploadScreenshot(screenshotPath, `audit-results/responsive-${auditId}`);

        result.capture = cloudRes;
        result.statut = 'SUCCESS';
        result.is_responsive = true;

        const mobileCaptures = await captureMobileSite(browser, url, auditId).catch((err) => {
            console.warn(`[MODULE-RESPONSIVE] Mobile captures failed: ${err.message}`);
            return { capture1: null, capture2: null };
        });

        result.menu_capture_1 = mobileCaptures.capture1;
        result.menu_capture_2 = mobileCaptures.capture2;

        cleanupFile(screenshotPath);

    } catch (e) {
        console.error('[MODULE-RESPONSIVE] FATAL:', e.message);
        result.statut = 'FAILED';
    } finally {
        await browser.close();
    }

    return result;
}
