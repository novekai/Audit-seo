import { chromium } from 'playwright';
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { uploadToCloudinary } from '../utils/cloudinary.js';
import { analyzeImage } from '../utils/openai.js';
import { sanitizeCookies } from '../utils/cookies.js';

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
        fs.unlinkSync(imagePath);
        return croppedPath;
    } catch (e) {
        console.warn(`[GSC] AI crop failed: ${e.message}`);
        return imagePath;
    }
}

// ── Create a Playwright context with Google cookies injected ─────────────────
async function launchWithCookies(cookies) {
    const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled']
    });
    const context = await browser.newContext({
        viewport: { width: 1600, height: 900 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        locale: 'fr-FR'
    });
    if (cookies && cookies.length) {
        const cleanCookies = sanitizeCookies(cookies);
        await context.addCookies(cleanCookies);
    }
    const page = await context.newPage();
    page.setDefaultTimeout(90000);
    return { browser, context, page };
}

function getTmpDir() {
    return process.env.RAILWAY_ENVIRONMENT ? '/tmp' : '.';
}

function cleanupFile(filePath) {
    if (filePath && fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
    }
}

async function captureSection(page, { tmpPrefix, uploadFolder, prompt, fullPage = false }) {
    const tmpPath = path.join(getTmpDir(), `${tmpPrefix}_${uuidv4()}.png`);
    let croppedPath = tmpPath;

    try {
        await page.screenshot({ path: tmpPath, fullPage });
        croppedPath = await cropWithAI(tmpPath, prompt);
        return await uploadToCloudinary(croppedPath, uploadFolder);
    } finally {
        cleanupFile(croppedPath);
        if (croppedPath !== tmpPath) {
            cleanupFile(tmpPath);
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

async function scrollToFirstVisible(page, selectors) {
    for (const selector of selectors) {
        try {
            const locator = page.locator(selector).first();
            if (await locator.count() === 0) continue;
            await locator.scrollIntoViewIfNeeded({ timeout: 5000 });
            return true;
        } catch {
            // Continue with the next selector candidate.
        }
    }

    return false;
}

// ── Force la période "12 derniers mois" via interaction UI ──────────────────
// Le paramètre URL num_of_months n'est PAS reconnu par GSC : la page s'ouvre
// toujours sur sa période par défaut (3 derniers mois). Le seul moyen fiable
// d'obtenir 12 mois est de cliquer dans le sélecteur de période comme un humain.
// En cas d'échec (Google change son DOM), on log et on continue : au pire on
// retombe sur le comportement par défaut (3 mois), jamais pire qu'avant.
async function selectLast12MonthsPeriod(page) {
    const opened = await clickFirstVisible(page, [
        'button:has-text("3 derniers mois")',
        'button:has-text("Last 3 months")',
        '[aria-label*="Période"]',
        '[aria-label*="Date"]',
        '[role="button"]:has-text("mois")',
        '[role="button"]:has-text("months")',
    ]);
    if (!opened) {
        console.warn('[GSC] Sélecteur de période introuvable, période par défaut conservée (3 mois)');
        return false;
    }
    await page.waitForTimeout(1000);

    const selected = await clickFirstVisible(page, [
        '[role="menuitemradio"]:has-text("12 derniers mois")',
        '[role="menuitemradio"]:has-text("Last 12 months")',
        'text=/^\\s*12 derniers mois\\s*$/i',
        'text=/^\\s*Last 12 months\\s*$/i',
        '[role="menuitemradio"]:has-text("12")',
    ]);
    if (!selected) {
        console.warn('[GSC] Option "12 derniers mois" introuvable, période par défaut conservée (3 mois)');
        return false;
    }
    await page.waitForTimeout(800);

    // Certains layouts GSC exigent un clic sur "Appliquer" pour valider la période.
    await clickFirstVisible(page, [
        'button:has-text("Appliquer")',
        'button:has-text("Apply")',
    ]);

    // Laisser le graphique et le tableau se recharger sur la nouvelle période.
    await page.waitForTimeout(4000);
    console.log('[GSC] Période "12 derniers mois" sélectionnée');
    return true;
}

async function gotoGscPage(page, url, label) {
    console.log(`[GSC] Navigating to ${label}: ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {
        console.warn(`[GSC] ${label}: networkidle non atteint, poursuite avec le DOM actuel.`);
    });
}

function buildGoogleDomainAccessMessage(domain, accountEmail = null) {
    const accountSuffix = accountEmail ? ` Le compte actuellement utilisé est ${accountEmail}.` : '';
    return `Le compte Google connecté n'est pas relié au domaine ${domain} dans Google Search Console.${accountSuffix} Connectez le bon compte Google ou ajoutez ce compte à la propriété, puis relancez l'audit.`;
}

function buildGoogleReconnectMessage() {
    return "Le compte Google n'est plus connecté à l'application. Reconnectez le bon compte Google dans les paramètres, puis relancez l'audit.";
}

const GSC_TRAFFIC_LOOKBACK_MONTHS = 12;

/**
 * ── HELPER: Resolve Property ID ──────────────────────────────────────────────
 * Detects if the property is URL-prefix (https://domain/) or Domain (sc-domain:domain).
 */
async function resolvePropertyId(page, domain) {
    const propertyCandidates = [
        `https://${domain}/`,
        `sc-domain:${domain}`,
        `http://${domain}/`
    ];

    console.log(`[GSC] 🔍 Detecting property ID for: ${domain}`);
    for (const cand of propertyCandidates) {
        const url = `https://search.google.com/search-console/sitemaps?resource_id=${encodeURIComponent(cand)}`;
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

        const noAccess = await page.locator('text=/.*don\'t have access to this property.*/i').count();
        if (noAccess === 0) {
            console.log(`[GSC] ✅ Found valid property ID: ${cand}`);
            return cand;
        }
    }
    console.warn(`[GSC] ⚠️ No accessible property found for candidates: ${propertyCandidates.join(', ')}`);
    return propertyCandidates[0]; // Fallback to first
}

// ── GOOGLE SEARCH CONSOLE — SITEMAPS ────────────────────────────────────────
export async function captureGscSitemaps(siteUrl, auditId, googleCookies) {
    const result = { statut: 'ERROR', capture: null };
    const { browser, page } = await launchWithCookies(googleCookies);
    try {
        const domain = new URL(siteUrl).hostname;
        const propertyId = await resolvePropertyId(page, domain);

        // Navigate to GSC sitemaps tab
        const gscUrl = `https://search.google.com/search-console/sitemaps?resource_id=${encodeURIComponent(propertyId)}`;
        console.log(`[GSC] Navigating to Sitemaps: ${gscUrl}`);
        await page.goto(gscUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

        // Check we're logged in
        const currentUrl = page.url();
        console.log(`[GSC] Current URL after navigation: ${currentUrl}`);
        if (currentUrl.includes('accounts.google.com') || currentUrl.includes('signin')) {
            result.statut = 'SKIP';
            result.details = buildGoogleReconnectMessage();
            console.error(`[GSC] ❌ Session expired — redirected to: ${currentUrl}`);
            return result;
        }

        await page.waitForTimeout(6000);

        // Check for "No access" property screen
        const missingAccess = await page.locator('text=/.*don\'t have access to this property.*/i').count();
        if (missingAccess > 0) {
            const accountEmail = await page.locator('[aria-label*="@gmail.com"], [class*="profile"] text').first().innerText().catch(() => 'inconnu');
            result.statut = 'SKIP';
            result.details = buildGoogleDomainAccessMessage(domain, accountEmail.trim());
            console.error(`[GSC] ❌ Access denied for property ${domain} (Account: ${accountEmail})`);
            return result;
        }

        const tmpPath = path.resolve(`temp_gsc_sitemap_${uuidv4()}.png`);
        await page.screenshot({ path: tmpPath, fullPage: false });

        const prompt = `Cette image est une capture de Google Search Console, onglet Sitemaps.
Rogne pour ne garder que le tableau listant les sitemaps déclarés.
Supprime le menu de navigation GSC, le header, et tout ce qui n'est pas le tableau.
CROP: x=[left], y=[top], width=[largeur], height=[hauteur]`;

        const croppedPath = await cropWithAI(tmpPath, prompt);
        const uploaded = await uploadToCloudinary(croppedPath, `audit-results/gsc-sitemaps-${auditId}`);
        if (fs.existsSync(croppedPath)) fs.unlinkSync(croppedPath);
        if (fs.existsSync(tmpPath) && tmpPath !== croppedPath) fs.unlinkSync(tmpPath);

        result.capture = uploaded?.secure_url || uploaded?.url || uploaded;
        result.statut = 'SUCCESS';
    } catch (e) {
        result.details = e.message;
        console.error('[GSC] Sitemaps error:', e.message);
    } finally { await browser.close(); }
    return result;
}

// ── GOOGLE SEARCH CONSOLE — HTTPS ────────────────────────────────────────────
export async function captureGscHttps(siteUrl, auditId, googleCookies) {
    const result = { statut: 'ERROR', capture: null };
    const { browser, page } = await launchWithCookies(googleCookies);
    try {
        const domain = new URL(siteUrl).hostname;
        const propertyId = await resolvePropertyId(page, domain);

        const gscUrl = `https://search.google.com/search-console/security-issues?resource_id=${encodeURIComponent(propertyId)}`;
        console.log(`[GSC] Navigating to HTTPS: ${gscUrl}`);
        await page.goto(gscUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

        if (page.url().includes('accounts.google.com')) {
            result.statut = 'SKIP';
            result.details = buildGoogleReconnectMessage();
            return result;
        }

        await page.waitForTimeout(4000);

        // Check for "No access" property screen
        const missingAccess = await page.locator('text=/.*don\'t have access to this property.*/i').count();
        if (missingAccess > 0) {
            result.statut = 'SKIP';
            result.details = buildGoogleDomainAccessMessage(domain);
            return result;
        }

        const tmpPath = path.resolve(`temp_gsc_https_${uuidv4()}.png`);
        await page.screenshot({ path: tmpPath, fullPage: false });

        const prompt = `Cette image montre un rapport HTTPS de Google Search Console.
Il y a un graphe avec des couleurs, notamment une zone verte.
Rogne pour ne garder que la partie du graphe colorée en vert et son contexte immédiat.
CROP: x=[left], y=[top], width=[largeur], height=[hauteur]`;

        const croppedPath = await cropWithAI(tmpPath, prompt);
        const uploaded = await uploadToCloudinary(croppedPath, `audit-results/gsc-https-${auditId}`);
        if (fs.existsSync(croppedPath)) fs.unlinkSync(croppedPath);
        if (fs.existsSync(tmpPath) && tmpPath !== croppedPath) fs.unlinkSync(tmpPath);

        result.capture = uploaded?.secure_url || uploaded?.url || uploaded;
        result.statut = 'SUCCESS';
    } catch (e) {
        result.details = e.message;
        console.error('[GSC] HTTPS error:', e.message);
    } finally { await browser.close(); }
    return result;
}

// ── GOOGLE SEARCH CONSOLE — PERFORMANCE (Traffic) ────────────────────────────
export async function captureGscPerformance(siteUrl, auditId, googleCookies) {
    const result = {
        statut: 'ERROR',
        capture1: null,
        capture2: null,
        clics: null,
        pagesIndexed: null,
        bestQueryCapture: null,
        queryPageClicksImpressionsCapture: null
    };
    const { browser, page } = await launchWithCookies(googleCookies);
    try {
        const domain = new URL(siteUrl).hostname;
        const propertyId = await resolvePropertyId(page, domain);

        // GSC Performance page
        // NB: num_of_months n'est pas honoré par GSC (voir selectLast12MonthsPeriod) ;
        // la vraie sélection de période se fait par interaction UI plus bas.
        const gscUrl = `https://search.google.com/search-console/performance/search-analytics?resource_id=${encodeURIComponent(propertyId)}&num_of_months=${GSC_TRAFFIC_LOOKBACK_MONTHS}`;
        await gotoGscPage(page, gscUrl, 'Performance');

        if (page.url().includes('accounts.google.com')) {
            result.statut = 'SKIP';
            result.details = buildGoogleReconnectMessage();
            return result;
        }
        await page.waitForTimeout(5000);

        // Check for "No access" property screen
        const missingAccess = await page.locator('text=/.*don\'t have access to this property.*/i').count();
        if (missingAccess > 0) {
            result.statut = 'SKIP';
            result.details = buildGoogleDomainAccessMessage(domain);
            return result;
        }

        // Forcer la période sur 12 derniers mois (num_of_months ne suffit pas)
        await selectLast12MonthsPeriod(page);

        // Try to extract total clicks from the page
        const metrics = await page.evaluate(() => {
            const data = {};
            // Look for the summary metrics (Total Clics, Total Impressions)
            document.querySelectorAll('[class*="metric"], [class*="stat"], span, div').forEach(el => {
                const text = el.innerText?.trim();
                if (text && /^\d[\d,.KMk]*$/.test(text.replace(/\s/g, ''))) {
                    const parent = el.closest('[class*="card"], [class*="metric"]');
                    const label = parent?.querySelector('[class*="label"], [class*="title"]')?.innerText?.toLowerCase();
                    if (label?.includes('clic')) data.clics = text;
                    if (label?.includes('impression')) data.impressions = text;
                }
            });
            return data;
        });
        if (metrics.clics) result.clics = metrics.clics;
        console.log(`[GSC] Performance metrics:`, JSON.stringify(metrics));

        // Screenshot 1: Full performance graph
        const prompt1 = `Cette image est Google Search Console, page Performance.
Rogne pour ne garder que le graphe de performance (courbe des clics/impressions) et les métriques résumées en haut.
Supprime le menu latéral GSC et tout le texte sous le graphe.
CROP: x=[left], y=[top], width=[largeur], height=[hauteur]`;

        result.capture1 = await captureSection(page, {
            tmpPrefix: 'temp_gsc_perf1',
            uploadFolder: `audit-results/gsc-perf1-${auditId}`,
            prompt: prompt1
        });

        await clickFirstVisible(page, [
            '[role="tab"]:has-text("Requêtes")',
            '[role="tab"]:has-text("Queries")',
            'text=Requêtes',
            'text=Queries'
        ]);

        // Scroll down for the table
        await page.evaluate(() => window.scrollBy(0, 600));
        await page.waitForTimeout(2000);

        const prompt2 = `Cette image montre le tableau de données de Google Search Console.
Rogne pour ne garder que le tableau des requêtes/pages (les lignes de données avec clics et impressions).
Supprime le graphe, le menu latéral, et les filtres.
CROP: x=[left], y=[top], width=[largeur], height=[hauteur]`;

        result.capture2 = await captureSection(page, {
            tmpPrefix: 'temp_gsc_perf2',
            uploadFolder: `audit-results/gsc-perf2-${auditId}`,
            prompt: prompt2
        });
        result.queryPageClicksImpressionsCapture = result.capture2;

        const promptBestQuery = `Cette image montre le tableau des requêtes dans Google Search Console.
Rogne pour ne garder que l'entête du tableau et la toute premiere ligne correspondant a la meilleure requête.
Supprime le graphe, le menu lateral, les filtres, et les lignes inutiles en dessous.
CROP: x=[left], y=[top], width=[largeur], height=[hauteur]`;

        try {
            result.bestQueryCapture = await captureSection(page, {
                tmpPrefix: 'temp_gsc_best_query',
                uploadFolder: `audit-results/gsc-best-query-${auditId}`,
                prompt: promptBestQuery
            });
        } catch (e) {
            console.warn(`[GSC] Best query capture failed: ${e.message}`);
        }

        result.statut = 'SUCCESS';
    } catch (e) {
        result.details = e.message;
        console.error('[GSC] Performance error:', e.message);
    } finally { await browser.close(); }
    return result;
}

// ── GOOGLE SEARCH CONSOLE — COVERAGE (Pages Indexed) ────────────────────────
export async function captureGscCoverage(siteUrl, auditId, googleCookies) {
    const result = {
        statut: 'ERROR',
        capture: null,
        pagesIndexed: null,
        indexationCapture: null,
        problemCapture: null
    };
    const { browser, page } = await launchWithCookies(googleCookies);
    try {
        const domain = new URL(siteUrl).hostname;
        const propertyId = await resolvePropertyId(page, domain);

        const gscUrl = `https://search.google.com/search-console/index?resource_id=${encodeURIComponent(propertyId)}`;
        await gotoGscPage(page, gscUrl, 'Coverage (Index)');

        if (page.url().includes('accounts.google.com')) {
            result.statut = 'SKIP';
            result.details = buildGoogleReconnectMessage();
            return result;
        }
        await page.waitForTimeout(5000);

        // Check for "No access" property screen
        const missingAccess = await page.locator('text=/.*don\'t have access to this property.*/i').count();
        if (missingAccess > 0) {
            result.statut = 'SKIP';
            result.details = buildGoogleDomainAccessMessage(domain);
            return result;
        }

        const indexationTotals = await page.evaluate(() => {
            const normalize = (text) => String(text || '')
                .replace(/\s+/g, ' ')
                .trim()
                .toLowerCase();
            const firstNumber = (text) => String(text || '').match(/\d[\d\s.,]*/)?.[0]?.trim() || null;
            const containers = Array.from(document.querySelectorAll('[class*="card"], [role="button"], div, section, article'));
            const totals = { indexed: null, notIndexed: null };

            for (const container of containers) {
                const text = normalize(container.innerText);
                if (!text) continue;
                const number = firstNumber(container.innerText);
                if (!number) continue;

                const isNotIndexedBlock = text.includes('non indexées') || text.includes('non indexees') || text.includes('not indexed');
                const isIndexedBlock = text.includes('dans l’index') || text.includes("dans l'index") || text.includes('indexed');

                if (!totals.indexed && isIndexedBlock && !isNotIndexedBlock) {
                    totals.indexed = number;
                }

                if (!totals.notIndexed && isNotIndexedBlock) {
                    totals.notIndexed = number;
                }

                if (totals.indexed && totals.notIndexed) break;
            }

            return totals;
        });
        if (indexationTotals.indexed) result.pagesIndexed = indexationTotals.indexed;
        console.log(`[GSC] Indexation totals: ${JSON.stringify(indexationTotals)}`);

        const prompt = `Cette image montre Google Search Console, page Couverture/Index.
Rogne pour ne garder que le graphe de couverture (barres vertes/rouges montrant les pages indexées) et les chiffres résumés.
Supprime le menu latéral GSC et les détails sous le graphe.
CROP: x=[left], y=[top], width=[largeur], height=[hauteur]`;

        result.capture = await captureSection(page, {
            tmpPrefix: 'temp_gsc_coverage',
            uploadFolder: `audit-results/gsc-coverage-${auditId}`,
            prompt
        });
        result.indexationCapture = result.capture;

        await scrollToFirstVisible(page, [
            'text=Pourquoi les pages ne sont pas indexées',
            'text=Pages non indexées',
            `text=Why pages aren't indexed`
        ]);
        await page.evaluate(() => window.scrollBy(0, -140));
        await page.waitForTimeout(1500);
        await clickFirstVisible(page, [
            'text=Pourquoi les pages ne sont pas indexées',
            'text=Pages non indexées',
            `text=Why pages aren't indexed`
        ]);
        await page.setViewportSize({ width: 1600, height: 1200 });
        await scrollToFirstVisible(page, [
            'text=Pourquoi les pages ne sont pas indexées',
            'text=Pages non indexées',
            `text=Why pages aren't indexed`
        ]);
        await page.evaluate(() => window.scrollBy(0, -120));
        await page.waitForTimeout(2000);

        const problemPrompt = `Cette image montre Google Search Console, section d'explication de non-indexation.
Rogne pour garder le titre "Pourquoi des pages ne sont pas indexées" et le tableau complet juste en dessous.
Conserve toutes les lignes visibles du tableau, le pied de tableau, et les colonnes Raison, Source, Validation, Tendance et Pages.
Supprime le menu lateral, le graphe du dessus et les zones inutiles autour.
CROP: x=[left], y=[top], width=[largeur], height=[hauteur]`;

        try {
            result.problemCapture = await captureSection(page, {
                tmpPrefix: 'temp_gsc_coverage_problems',
                uploadFolder: `audit-results/gsc-coverage-problems-${auditId}`,
                prompt: problemPrompt,
                fullPage: true
            });
        } catch (e) {
            console.warn(`[GSC] Coverage problems capture failed: ${e.message}`);
        }

        result.statut = 'SUCCESS';
    } catch (e) {
        result.details = e.message;
        console.error('[GSC] Coverage error:', e.message);
    } finally { await browser.close(); }
    return result;
}

// ── GOOGLE SEARCH CONSOLE — TOP PAGES (Meilleures pages) ───────────────────
export async function captureGscTopPages(siteUrl, auditId, googleCookies) {
    const result = { statut: 'ERROR', capture: null };
    const { browser, page } = await launchWithCookies(googleCookies);
    try {
        const domain = new URL(siteUrl).hostname;
        const propertyId = await resolvePropertyId(page, domain);

        // Performance page sorted by pages tab
        // NB: num_of_months n'est pas honoré par GSC ; période forcée via UI plus bas.
        const gscUrl = `https://search.google.com/search-console/performance/search-analytics?resource_id=${encodeURIComponent(propertyId)}&num_of_months=${GSC_TRAFFIC_LOOKBACK_MONTHS}&breakdown=page`;
        await gotoGscPage(page, gscUrl, 'Top Pages');

        if (page.url().includes('accounts.google.com')) {
            result.statut = 'SKIP';
            result.details = buildGoogleReconnectMessage();
            return result;
        }
        await page.waitForTimeout(5000);

        // Check for "No access" property screen
        const missingAccess = await page.locator('text=/.*don\'t have access to this property.*/i').count();
        if (missingAccess > 0) {
            result.statut = 'SKIP';
            result.details = buildGoogleDomainAccessMessage(domain);
            return result;
        }

        // Forcer la période sur 12 derniers mois (num_of_months ne suffit pas)
        await selectLast12MonthsPeriod(page);

        // Click on "Pages" tab if visible
        try {
            const pagesTab = page.locator('text=Pages').first();
            if (await pagesTab.count() > 0) await pagesTab.click();
            await page.waitForTimeout(3000);
        } catch { }

        // Scroll to the table
        await page.evaluate(() => window.scrollBy(0, 400));
        await page.waitForTimeout(2000);

        const tmpDir = process.env.RAILWAY_ENVIRONMENT ? '/tmp' : '.';
        const tmpPath = path.join(tmpDir, `temp_gsc_pages_${uuidv4()}.png`);
        await page.screenshot({ path: tmpPath, fullPage: false });

        const prompt = `Cette image montre Google Search Console, onglet Pages.
Rogne pour ne garder que le tableau des meilleures pages (URLs avec clics et impressions).
Supprime le graphe au-dessus, le menu latéral, et les onglets.
CROP: x=[left], y=[top], width=[largeur], height=[hauteur]`;

        const croppedPath = await cropWithAI(tmpPath, prompt);
        const uploaded = await uploadToCloudinary(croppedPath, `audit-results/gsc-top-pages-${auditId}`);
        if (fs.existsSync(croppedPath)) fs.unlinkSync(croppedPath);
        if (fs.existsSync(tmpPath) && tmpPath !== croppedPath) fs.unlinkSync(tmpPath);

        result.capture = uploaded?.secure_url || uploaded?.url || uploaded;
        result.statut = 'SUCCESS';
    } catch (e) {
        result.details = e.message;
        console.error('[GSC] Top Pages error:', e.message);
    } finally { await browser.close(); }
    return result;
}
