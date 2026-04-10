import { chromium } from 'playwright';
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { uploadToCloudinary } from '../utils/cloudinary.js';
import { analyzeImage } from '../utils/openai.js';
import { sanitizeCookies } from '../utils/cookies.js';

// -- AI crop helper ------------------------------------------------------------
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
        console.warn(`[MRM] AI crop failed: ${e.message}`);
        return imagePath;
    }
}

// -- Auto-login via Playwright -------------------------------------------------
async function loginToMrm(page, email, password) {
    console.log(`[MRM] Tentative de connexion automatique pour: ${email}`);

    try {
        await page.goto('https://myrankingmetrics.com/login', { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (err) {
        throw new Error(`La connexion à My Ranking Metrics a échoué. Veuillez vous reconnecter et réessayer.`);
    }
    await page.waitForTimeout(2000);

    // Fill email
    const emailInput = page.locator('input[name="email"], input[type="email"], input[name="_username"]').first();
    try {
        await emailInput.waitFor({ state: 'visible', timeout: 10000 });
    } catch {
        throw new Error(`[MRM] Le champ email est introuvable sur la page de login. La page MRM a peut-être changé de structure.`);
    }
    await emailInput.fill(email);
    console.log(`[MRM] Email renseigné.`);

    // Fill password
    const passwordInput = page.locator('input[name="password"], input[type="password"], input[name="_password"]').first();
    try {
        await passwordInput.waitFor({ state: 'visible', timeout: 5000 });
    } catch {
        throw new Error(`[MRM] Le champ mot de passe est introuvable sur la page de login. La page MRM a peut-être changé de structure.`);
    }
    await passwordInput.fill(password);
    console.log(`[MRM] Mot de passe renseigné.`);

    // Submit
    const submitBtn = page.locator('button[type="submit"], input[type="submit"]').first();
    try {
        await submitBtn.waitFor({ state: 'visible', timeout: 5000 });
    } catch {
        throw new Error(`[MRM] Le bouton de soumission est introuvable sur la page de login. La page MRM a peut-être changé de structure.`);
    }
    await submitBtn.click();
    console.log(`[MRM] Formulaire soumis, attente de redirection...`);

    // Wait for navigation after login
    await page.waitForLoadState('domcontentloaded', { timeout: 30000 });
    await page.waitForTimeout(3000);

    // Verify login succeeded
    const currentUrl = page.url();
    if (currentUrl.includes('login') || currentUrl.includes('signin') || currentUrl.includes('connexion')) {
        const pageContent = await page.textContent('body').catch(() => '');
        const hasErrorMsg = /incorrect|invalide|erreur|error|wrong|invalid/i.test(pageContent);
        if (hasErrorMsg) {
            throw new Error(`[MRM] Identifiants incorrects — email ou mot de passe invalide (URL: ${currentUrl})`);
        }
        throw new Error(`[MRM] Connexion échouée — toujours sur la page de login après soumission (URL: ${currentUrl})`);
    }

    console.log(`[MRM] Connexion réussie — redirigé vers: ${currentUrl}`);
}

// -- Launch browser with appropriate auth method -------------------------------
async function launchWithAuth(authData) {
    const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const context = await browser.newContext({
        viewport: { width: 1400, height: 900 },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        locale: 'fr-FR'
    });
    const page = await context.newPage();
    page.setDefaultTimeout(90000);

    if (Array.isArray(authData)) {
        // Legacy cookie mode
        const cleanCookies = sanitizeCookies(authData);
        await context.addCookies(cleanCookies);
        console.log(`[MRM] Cookies injected: ${authData.length} cookies`);
    } else if (authData?.email && authData?.password) {
        // New auto-login mode
        await loginToMrm(page, authData.email, authData.password);
    }

    return { browser, context, page };
}

//  MY RANKING METRICS — Profondeur des pages
export async function captureMrmProfondeur(mrmReportUrl, auditId, authData) {
    const result = { statut: 'ERROR', capture: null };

    // Validate auth data
    const hasAuth = Array.isArray(authData)
        ? authData.length > 0
        : (authData?.email && authData?.password);

    if (!hasAuth) {
        result.statut = 'SKIP';
        result.details = 'Identifiants MRM non configurés — ajoutez vos identifiants dans les paramètres';
        console.warn('[MRM] Aucun identifiant configuré (ni credentials, ni cookies). Étape ignorée.');
        return result;
    }

    const { browser, page } = await launchWithAuth(authData);

    try {
        console.log(`[MRM] Navigating to: ${mrmReportUrl}`);
        await page.goto(mrmReportUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(5000);

        // Vérifier si on est toujours connectés
        const currentUrl = page.url();
        console.log(`[MRM] Current URL after navigation: ${currentUrl}`);
        if (currentUrl.includes('login') || currentUrl.includes('signin') || currentUrl.includes('connexion')) {
            result.statut = 'SKIP';
            result.details = 'Session MRM expirée — reconnectez-vous dans les paramètres ou vérifiez vos identifiants';
            console.error(`[MRM] Session expirée ou identifiants invalides — redirigé vers la page de login: ${currentUrl}`);
            return result;
        }

        // Stratégie de scroll pour MRM Section 4
        let tableEl = page.locator('table').first();
        try {
            console.log(`[MRM] Hunting for section 4 ("Profondeur")...`);

            // 1. Cibler le conteneur principal ou le titre
            const sectionHeader = page.locator('h2#profondeur').first();

            if (await sectionHeader.isVisible()) {
                console.log(`[MRM] Found section by h2#profondeur.`);
                await sectionHeader.scrollIntoViewIfNeeded();
                await page.waitForTimeout(500);
            }

            // 2. Trouver le tableau de données de la section 4.1 (Profondeur)
            tableEl = page.locator('#profondeur, #s4\\.1').locator('xpath=following::table').first();

            if (await tableEl.isVisible()) {
                console.log(`[MRM] Found depth table. Scrolling...`);
                await tableEl.evaluate(el => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
                await page.evaluate(() => window.scrollBy(0, -150));
                console.log(`[MRM] Scrolled to Section 4 table.`);
            } else {
                console.warn(`[MRM] Table not found with XPath, searching by class.`);
                tableEl = page.locator('.tablecenter').first();
                await tableEl.scrollIntoViewIfNeeded();
            }

            await page.waitForTimeout(3000);
        } catch (err) {
            console.warn(`[MRM] Precise section 4 scrolling failed: ${err.message}.`);
            await page.locator('table').first().scrollIntoViewIfNeeded().catch(() => { });
        }

        const tmpPath = path.resolve(`temp_mrm_${uuidv4()}.png`);

        // Screenshot du TABLEAU uniquement (plus propre que la page entière)
        if (await tableEl.isVisible()) {
            await tableEl.screenshot({ path: tmpPath });
        } else {
            await page.screenshot({ path: tmpPath, fullPage: false });
        }

        const prompt = `Cette image montre un tableau de données My Ranking Metrics sur la profondeur des pages.
Rogne pour ne garder que le tableau, sans aucun menu ni chrome de l'application.
CROP: x=[left], y=[top], width=[largeur], height=[hauteur]`;

        const croppedPath = await cropWithAI(tmpPath, prompt);
        const uploaded = await uploadToCloudinary(croppedPath, `audit-results/mrm-profondeur-${auditId}`);
        if (fs.existsSync(croppedPath)) fs.unlinkSync(croppedPath);
        if (fs.existsSync(tmpPath) && tmpPath !== croppedPath) fs.unlinkSync(tmpPath);

        result.capture = uploaded?.secure_url || uploaded?.url || uploaded;
        result.statut = 'SUCCESS';
    } catch (e) {
        result.details = e.message;
        console.error(`[MRM] Erreur lors de la capture MRM: ${e.message}`);
        if (e.message.includes('Timeout') || e.message.includes('timeout')) {
            console.error('[MRM] La page MRM a mis trop de temps à répondre. Vérifiez que le lien du rapport est correct et que le site MRM est accessible.');
        }
    } finally { await browser.close(); }
    return result;
}
