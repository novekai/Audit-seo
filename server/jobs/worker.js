import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { auditRobotsSitemap } from '../modules/robots_sitemap.js';
import { extractLogo } from '../modules/logo_extraction.js';
import { auditSslLabs } from '../modules/ssl_labs.js';
import { auditResponsive } from '../modules/responsive_check.js';
import { auditPageSpeedMobile, auditPageSpeedDesktop } from '../modules/pagespeed.js';
import { auditGoogleSheetsAPI } from '../modules/google_sheets_api.js';
import { capturePlanDAction } from '../modules/sheet_plan_capture.js';
import { captureGscSitemaps, captureGscHttps, captureGscPerformance, captureGscCoverage, captureGscTopPages } from '../modules/google_search_console.js';
import { captureGscSitemapsAPI, captureGscHttpsAPI, captureGscPerformanceAPI, captureGscCoverageAPI, captureGscTopPagesAPI } from '../modules/gsc_api.js';
import { captureMrmProfondeur } from '../modules/mrm.js';
import { captureUbersuggest } from '../modules/ubersuggest.js';
import { captureSemrush, captureAhrefs } from '../modules/authority_checkers.js';
import { check404 } from '../modules/check_404.js';
import { captureMajesticBacklinks } from '../modules/majestic.js';
import { updateAirtableStatut, updateAirtableField } from '../airtable.js';
import { decrypt } from '../utils/encrypt.js';
import { v4 as uuidv4 } from 'uuid';

const REDIS_URL = process.env.REDIS_URL;
const finalRedisUrl = REDIS_URL || 'redis://localhost:6379';

const redisOptions = {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    retryStrategy: (times) => Math.min(times * 50, 2000)
};

if (finalRedisUrl.startsWith('rediss://')) {
    redisOptions.tls = { rejectUnauthorized: false };
}

const connection = new IORedis(finalRedisUrl, redisOptions);

connection.on('error', (err) => {
    console.error(`❌ [REDIS WORKER ERROR] ${err.message}`);
});

connection.on('connect', () => {
    console.log('[WORKER] Redis connection established.');
});

export const initWorker = (io, db) => {
    console.log('[WORKER] Initializing worker for "audit-jobs" queue...');

    const worker = new Worker('audit-jobs', async (job) => {
        const { auditId, userId } = job.data;
        console.log(`[WORKER] [JOB ${job.id}] Starting audit ${auditId} for user ${userId}`);

        try {
            // 1. Get Audit Data
            const audit = await db.get('SELECT * FROM audits WHERE id = ?', [auditId]);
            if (!audit) throw new Error('Audit not found');

            // 2. Initial Setup: Mark as "En cours" only when worker actually starts
            console.log(`[WORKER] [JOB ${job.id}] Transitioning status to "EN_COURS"`);
            await db.run('UPDATE audits SET statut_global = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', ['EN_COURS', auditId]);
            if (audit.airtable_record_id) {
                await updateAirtableStatut(audit.airtable_record_id, 'En cours');
            }

            // Emit update to clients
            const initialUpdate = await db.get('SELECT * FROM audits WHERE id = ?', [auditId]);
            io.to(`audit:${auditId}`).emit('audit:update', initialUpdate);

            let siteUrl = audit.url_site;
            if (siteUrl && !siteUrl.startsWith('http')) {
                siteUrl = `https://${siteUrl}`;
                console.log(`[WORKER] [JOB ${job.id}] Normalized URL to: ${siteUrl}`);
                // Persist the fixed URL
                await db.run('UPDATE audits SET url_site = ? WHERE id = ?', [siteUrl, auditId]);
            }

            // Helper to update step status
            const updateStep = async (stepKey, status, result = null, cloudinaryUrl = null) => {
                const serializedResult = result ? JSON.stringify(result) : null;
                const updateResult = await db.run(
                    'UPDATE audit_steps SET statut = ?, resultat = ?, output_cloudinary_url = ?, updated_at = CURRENT_TIMESTAMP WHERE audit_id = ? AND step_key = ?',
                    [status, serializedResult, cloudinaryUrl, auditId, stepKey]
                );

                if ((updateResult.rowCount || 0) === 0) {
                    await db.run(
                        'INSERT INTO audit_steps (id, audit_id, step_key, statut, resultat, output_cloudinary_url) VALUES (?, ?, ?, ?, ?, ?)',
                        [uuidv4(), auditId, stepKey, status, serializedResult, cloudinaryUrl]
                    );
                }

                // Fetch the updated step to emit to client
                const updatedStep = await db.get('SELECT * FROM audit_steps WHERE audit_id = ? AND step_key = ?', [auditId, stepKey]);

                io.to(`audit:${auditId}`).emit('step:update', { auditId, step: updatedStep });
                console.log(`[WORKER] [JOB ${job.id}] Step ${stepKey}: ${status}`);
            };

            // Timeout helper to prevent infinite hangs
            const runWithTimeout = async (promise, ms, stepName) => {
                let timeoutId;
                const timeoutPromise = new Promise((_, reject) => {
                    timeoutId = setTimeout(() => {
                        reject(new Error(`TIMEOUT: L'étape ${stepName} a dépassé la limite de ${ms / 1000}s`));
                    }, ms);
                });
                try {
                    return await Promise.race([promise, timeoutPromise]);
                } finally {
                    clearTimeout(timeoutId);
                }
            };

            const buildDerivedCaptureStep = (captureUrl, parentStatus, parentDetails, missingDetails) => {
                if (captureUrl) {
                    return { status: 'SUCCESS', details: null, outputUrl: captureUrl };
                }

                if (String(parentStatus || '').toUpperCase() === 'SKIP') {
                    return {
                        status: 'SKIP',
                        details: parentDetails || missingDetails,
                        outputUrl: null
                    };
                }

                return {
                    status: 'FAILED',
                    details: parentDetails || missingDetails,
                    outputUrl: null
                };
            };

            // Check if audit was cancelled or finished prematurely
            const checkCancellation = async () => {
                const currentAudit = await db.get('SELECT statut_global FROM audits WHERE id = ?', [auditId]);
                if (!currentAudit || currentAudit.statut_global === 'TERMINE' || currentAudit.statut_global === 'ERREUR') {
                    console.log(`[WORKER] [JOB ${job.id}] Audit ${auditId} was CANCELLED or marked as FINISHED. Stopping worker.`);
                    return true;
                }
                return false;
            };

            // Sequence of steps
            // STEP 1: Robots & Sitemap
            try {
                console.log(`[WORKER] [JOB ${job.id}] Executing Step: Robots & Sitemap...`);
                await updateStep('robots_txt', 'EN_COURS');
                const robotsResult = await auditRobotsSitemap(siteUrl, auditId);

                await updateStep('robots_txt', robotsResult.robots_txt.statut, robotsResult.robots_txt.details, robotsResult.robots_txt.capture);

                // Sync Robots to Airtable
                if (audit.airtable_record_id) {
                    if (robotsResult.robots_txt.statut === 'SUCCESS') {
                        console.log(`[WORKER] [JOB ${job.id}] Syncing Robots URL to Airtable...`);
                        await updateAirtableField(audit.airtable_record_id, 'robot', robotsResult.robots_txt.url);
                        if (robotsResult.robots_txt.capture) {
                            await updateAirtableField(audit.airtable_record_id, 'Img_Robots_Txt', robotsResult.robots_txt.capture);
                        }
                    }
                }

                console.log(`[WORKER] [JOB ${job.id}] Exécution de l'étape : Sitemap...`);
                await updateStep('sitemap', 'EN_COURS');
                await updateStep('sitemap', robotsResult.sitemap.statut, robotsResult.sitemap.details, robotsResult.sitemap.capture);

                // Synchronisation Sitemap vers Airtable
                if (audit.airtable_record_id) {
                    const sitemapUrlValue = robotsResult.sitemap.url || 'Le fichier sitemap(s) n\'existe pas';
                    await updateAirtableField(audit.airtable_record_id, 'sitemaps', sitemapUrlValue);
                    if (robotsResult.sitemap.capture) {
                        console.log(`[WORKER] [JOB ${job.id}] Synchronisation de la capture Sitemap vers Airtable...`);
                        await updateAirtableField(audit.airtable_record_id, 'Img_Sitemap', robotsResult.sitemap.capture);
                    }
                }
            } catch (e) {
                console.error(`[WORKER] [JOB ${job.id}] Robots/Sitemap step failed:`, e.message);
                await updateStep('robots_txt', 'FAILED', e.message);
                await updateStep('sitemap', 'FAILED', e.message);
            }

            // ------------------------------------------------------------------
            // HELPER: Load encrypted cookies for a service (legacy)
            // ------------------------------------------------------------------
            const getSessionCookies = async (service) => {
                const sessionRow = await db.get(
                    'SELECT encrypted_cookies FROM user_sessions WHERE user_id = ? AND service = ? ORDER BY created_at DESC LIMIT 1',
                    [userId, service]
                );
                if (!sessionRow) {
                    console.log(`[WORKER] [JOB ${job.id}] No session found in DB for service: ${service}`);
                    return null;
                }
                try {
                    const decryptedStr = decrypt(sessionRow.encrypted_cookies);
                    const cookies = JSON.parse(decryptedStr);
                    console.log(`[WORKER] [JOB ${job.id}] Successfully decrypted cookies for service: ${service} (${cookies.length} cookies)`);
                    return cookies;
                }
                catch (e) {
                    console.error(`[WORKER] [JOB ${job.id}] Failed to decrypt cookies for service: ${service}`, e.message);
                    return null;
                }
            };

            // ------------------------------------------------------------------
            // HELPER: Load credentials for auto-login (new system)
            // ------------------------------------------------------------------
            const getServiceCredentials = async (service) => {
                const row = await db.get(
                    'SELECT encrypted_data, auth_type FROM service_credentials WHERE user_id = ? AND service = ? AND status = ?',
                    [userId, service, 'active']
                );
                if (!row) {
                    console.log(`[WORKER] [JOB ${job.id}] No credentials found for service: ${service}`);
                    return null;
                }
                try {
                    const data = JSON.parse(decrypt(row.encrypted_data));
                    console.log(`[WORKER] [JOB ${job.id}] Successfully loaded credentials for service: ${service}`);
                    return data;
                } catch (e) {
                    console.error(`[WORKER] [JOB ${job.id}] Failed to decrypt credentials for service: ${service}`, e.message);
                    return null;
                }
            };

            // Helper: Get auth data for a service (credentials first, fallback to cookies)
            const getAuthData = async (service) => {
                const credentials = await getServiceCredentials(service);
                if (credentials) return credentials;
                return await getSessionCookies(service);
            };

            const hasAirtableValue = (value) =>
                value != null &&
                (
                    typeof value !== 'string' ||
                    value.trim() !== ''
                );

            const hasNumericValue = (value) =>
                hasAirtableValue(value) && Number.isFinite(Number(value));

            let googleCookies = null;
            const sheetAuditUrl = audit.sheet_audit_url;
            const sheetPlanUrl = audit.sheet_plan_url;
            const googleCreds = await getServiceCredentials('google');
            const googleRefreshToken = googleCreds?.refresh_token || process.env.GOOGLE_REFRESH_TOKEN || null;
            const googleApiAvailable = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && googleRefreshToken);

            // STEP 2: Google Sheets Plan d'Action — Direct Playwright Capture
            // Moved to Step 2 to satisfy user priority
            if (await checkCancellation()) return;

            const planStepsMap = {
                "Img_planD'action": "plan_synthese",
                "Img_Requetes_cles": "plan_requetes",
                "Img_donnee_image": "plan_donnees_img",
                "Img_donnee image": "plan_donnees_img",
                "Img_longeur_page_plan": "plan_longueur"
            };
            const planStepKeys = [...new Set(Object.values(planStepsMap))];

            if (!sheetPlanUrl) {
                console.log(`[WORKER] [JOB ${job.id}] Missing Plan d'Action Sheet URL, skipping.`);
                for (const k of planStepKeys) {
                    await updateStep(k, 'SKIP', "Lien Google Sheet plan d'action non fourni");
                }
            } else {
                console.log(`[WORKER] [JOB ${job.id}] Starting Plan d'Action captures...`);
                for (const stepKey of planStepKeys) {
                    await updateStep(stepKey, 'EN_COURS');
                }

                let planResults = null;
                let planCaptureError = null;
                let attemptedPlanCapture = false;

                if (googleApiAvailable) {
                    attemptedPlanCapture = true;
                    try {
                        console.log(`[WORKER] [JOB ${job.id}] Plan d'Action via Google Sheets API...`);
                        planResults = await runWithTimeout(
                            auditGoogleSheetsAPI(null, sheetPlanUrl, auditId, {
                                refreshToken: googleRefreshToken,
                                targets: ['plan']
                            }),
                            300000,
                            "Plan d'Action Sheets API"
                        );
                    } catch (e) {
                        planCaptureError = e;
                        console.error(`[WORKER] [JOB ${job.id}] Plan d'Action API failed:`, e.message);
                    }
                }

                const shouldFallbackToBrowser =
                    !planResults ||
                    Object.keys(planResults).length === 0 ||
                    Object.values(planResults).every((res) => ['FAILED', 'ERROR'].includes(String(res?.statut || '').toUpperCase()));

                if (shouldFallbackToBrowser) {
                    googleCookies = googleCookies || await getSessionCookies('google');
                }

                if (shouldFallbackToBrowser && googleCookies) {
                    attemptedPlanCapture = true;
                    try {
                        console.log(`[WORKER] [JOB ${job.id}] Plan d'Action fallback via session navigateur Google...`);
                        planResults = await runWithTimeout(
                            capturePlanDAction(sheetPlanUrl, auditId, googleCookies),
                            300000,
                            "Plan d'Action Capture"
                        );
                    } catch (e) {
                        planCaptureError = e;
                        console.error(`[WORKER] [JOB ${job.id}] Plan d'Action browser fallback failed:`, e.message);
                    }
                }

                if (!planResults) {
                    const fallbackStatus = attemptedPlanCapture ? 'FAILED' : 'SKIP';
                    const fallbackMessage = attemptedPlanCapture
                        ? (planCaptureError?.message || "Impossible de récupérer les captures du plan d'action.")
                        : "Aucun compte Google connecté ne permet de lire le Google Sheet du plan d'action.";

                    for (const stepKey of planStepKeys) {
                        await updateStep(stepKey, fallbackStatus, fallbackMessage);
                    }
                } else {
                    for (const [fieldId, res] of Object.entries(planResults)) {
                        const stepKey = planStepsMap[fieldId];
                        if (stepKey) {
                            await updateStep(stepKey, res.statut, res.details, res.capture);
                        }
                        if (
                            fieldId !== "Img_planD'action" &&
                            res.capture &&
                            res.statut === "SUCCESS" &&
                            audit.airtable_record_id
                        ) {
                            try {
                                await updateAirtableField(audit.airtable_record_id, fieldId, res.capture);
                            } catch (e) {
                                console.error(`[WORKER] Failed to update Airtable for ${fieldId}:`, e.message);
                            }
                        }
                    }
                }
            }

            // STEP 3: Logo Extraction
            if (await checkCancellation()) return;
            console.log(`[WORKER] [JOB ${job.id}] Executing Step: Logo Extraction...`);
            await updateStep('logo', 'IA_EN_COURS');
            const logoResult = await extractLogo(siteUrl, auditId);

            await updateStep('logo', logoResult.statut, logoResult.details, logoResult.url);

            // Sync Logo to Airtable
            if (audit.airtable_record_id) {
                if (logoResult.statut === 'SUCCESS' && logoResult.url) {
                    console.log(`[WORKER] [JOB ${job.id}] Syncing Logo to Airtable...`);
                    await updateAirtableField(audit.airtable_record_id, 'Img_Logo', logoResult.url);
                }
            }

            // STEP 4: SSL Labs
            console.log(`[WORKER] [JOB ${job.id}] Executing Step: SSL Labs...`);
            await updateStep('ssl_labs', 'EN_COURS');
            const domainSsl = new URL(siteUrl).hostname;
            const sslResult = await auditSslLabs(domainSsl, auditId);
            await updateStep('ssl_labs', sslResult.statut, null, sslResult.capture);
            if (audit.airtable_record_id && sslResult.capture) {
                await updateAirtableField(audit.airtable_record_id, 'Img_SSL', sslResult.capture);
            }

            // STEP 5: Responsive Check
            if (await checkCancellation()) return;
            try {
                console.log(`[WORKER] [JOB ${job.id}] Executing Step: Responsive Check...`);
                await updateStep('ami_responsive', 'EN_COURS');
                await updateStep('responsive_menu_mobile_1', 'EN_COURS');
                await updateStep('responsive_menu_mobile_2', 'EN_COURS');
                const respResult = await runWithTimeout(auditResponsive(siteUrl, auditId), 180000, 'Responsive'); // 3m
                await updateStep('ami_responsive', respResult.statut, null, respResult.capture);
                const mobileCapture1Step = buildDerivedCaptureStep(
                    respResult.menu_capture_1,
                    respResult.statut,
                    null,
                    'Capture mobile 1 non générée'
                );
                const mobileCapture2Step = buildDerivedCaptureStep(
                    respResult.menu_capture_2,
                    respResult.statut,
                    null,
                    'Capture mobile 2 non générée'
                );

                await updateStep('responsive_menu_mobile_1', mobileCapture1Step.status, mobileCapture1Step.details, mobileCapture1Step.outputUrl);
                await updateStep('responsive_menu_mobile_2', mobileCapture2Step.status, mobileCapture2Step.details, mobileCapture2Step.outputUrl);

                if (audit.airtable_record_id) {
                    if (respResult.capture) {
                        await updateAirtableField(audit.airtable_record_id, 'Img_AmIResponsive', respResult.capture);
                    }
                    if (respResult.menu_capture_1) {
                        await updateAirtableField(audit.airtable_record_id, 'Img_menu_mobile_1', respResult.menu_capture_1);
                    }
                    if (respResult.menu_capture_2) {
                        await updateAirtableField(audit.airtable_record_id, 'Img_menu_mobile_2', respResult.menu_capture_2);
                    }
                }
            } catch (e) {
                console.error(`[WORKER] [JOB ${job.id}] Responsive Check failed:`, e.message);
                await updateStep('ami_responsive', 'FAILED', e.message);
                await updateStep('responsive_menu_mobile_1', 'FAILED', e.message);
                await updateStep('responsive_menu_mobile_2', 'FAILED', e.message);
            }

            // STEP 6: PageSpeed Mobile
            try {
                console.log(`[WORKER] [JOB ${job.id}] Executing Step: PSI Mobile...`);
                await updateStep('psi_mobile', 'EN_COURS');
                const psiMobile = await runWithTimeout(auditPageSpeedMobile(siteUrl, auditId), 180000, 'PSI Mobile'); // 3m
                await updateStep('psi_mobile', psiMobile.statut, psiMobile.details, psiMobile.capture);
                if (audit.airtable_record_id) {
                    if (hasNumericValue(psiMobile.score)) {
                        const mobileScorePercent = Number(psiMobile.score) / 100;
                        await updateAirtableField(audit.airtable_record_id, 'pourcentage smartphone', mobileScorePercent);
                    }
                    if (psiMobile.capture) await updateAirtableField(audit.airtable_record_id, 'Img_PSI_Mobile', psiMobile.capture);
                }
            } catch (e) {
                console.error(`[WORKER] [JOB ${job.id}] PSI Mobile failed:`, e.message);
                await updateStep('psi_mobile', 'FAILED', e.message);
            }

            // STEP 7: PageSpeed Desktop
            try {
                console.log(`[WORKER] [JOB ${job.id}] Executing Step: PSI Desktop...`);
                await updateStep('psi_desktop', 'EN_COURS');
                const psiDesktop = await runWithTimeout(auditPageSpeedDesktop(siteUrl, auditId), 180000, 'PSI Desktop'); // 3m
                await updateStep('psi_desktop', psiDesktop.statut, psiDesktop.details, psiDesktop.capture);
                if (audit.airtable_record_id) {
                    if (hasNumericValue(psiDesktop.score)) {
                        const desktopScorePercent = Number(psiDesktop.score) / 100;
                        await updateAirtableField(audit.airtable_record_id, 'pourcentage desktop', desktopScorePercent);
                    }
                    if (psiDesktop.capture) await updateAirtableField(audit.airtable_record_id, 'Img_PSI_Desktop', psiDesktop.capture);
                }
            } catch (e) {
                console.error(`[WORKER] [JOB ${job.id}] PSI Desktop failed:`, e.message);
                await updateStep('psi_desktop', 'FAILED', e.message);
            }

            // STEP 8: Google Sheets Audit — API (HTML rendering)
            if (!sheetAuditUrl) {
                console.log(`[WORKER] [JOB ${job.id}] Missing Audit Sheet URL, skipping.`);
                for (const k of ['sheet_images', 'sheet_meme_title', 'sheet_meta_desc_double', 'sheet_doublons_h1', 'sheet_h1_absente', 'sheet_h1_vides', 'sheet_h1_au_moins', 'sheet_hn_pas_h1', 'sheet_sauts_hn', 'sheet_hn_longue', 'sheet_mots_body', 'sheet_meta_desc', 'sheet_balise_title']) {
                    await updateStep(k, 'SKIP', 'Lien Google Sheet Audit non fourni');
                }
            } else if (!googleApiAvailable) {
                const missingGoogleMessage = "Aucun compte Google connecté ne permet de lire le Google Sheet d'audit.";
                console.log(`[WORKER] [JOB ${job.id}] ${missingGoogleMessage}`);
                for (const k of ['sheet_images', 'sheet_meme_title', 'sheet_meta_desc_double', 'sheet_doublons_h1', 'sheet_h1_absente', 'sheet_h1_vides', 'sheet_h1_au_moins', 'sheet_hn_pas_h1', 'sheet_sauts_hn', 'sheet_hn_longue', 'sheet_mots_body', 'sheet_meta_desc', 'sheet_balise_title']) {
                    await updateStep(k, 'SKIP', missingGoogleMessage);
                }
            } else {
                if (await checkCancellation()) return;
                console.log(`[WORKER] [JOB ${job.id}] Starting Google Sheets API (Audit)...`);
                const sheetStepsMap = {
                    "Img_Poids_image": "sheet_images",
                    "Img_balise_h1_absente": "sheet_h1_absente",
                    "Img_que des H1 vides": "sheet_h1_vides",
                    "Img_au moins une H1 vide": "sheet_h1_au_moins",
                    "Img_1ère balise Hn n'est pas H1": "sheet_hn_pas_h1",
                    "Img_Sauts de niveau entre les Hn": "sheet_sauts_hn",
                    "Img_Hn trop longue": "sheet_hn_longue",
                    "Img_longeur_page": "sheet_mots_body",
                    "Img_meta_description": "sheet_meta_desc",
                    "Img_balises_title": "sheet_balise_title",
                    "Img_meme_title": "sheet_meme_title",
                    "Img_meta_description_double": "sheet_meta_desc_double",
                    "Img_balise_h1_double": "sheet_doublons_h1",
                };

                for (const stepKey of Object.values(sheetStepsMap)) {
                    await updateStep(stepKey, 'EN_COURS');
                }

                const sheetResults = await auditGoogleSheetsAPI(sheetAuditUrl, null, auditId, {
                    refreshToken: googleRefreshToken,
                    targets: ['audit']
                });

                for (const [fieldId, res] of Object.entries(sheetResults)) {
                    const stepKey = sheetStepsMap[fieldId];
                    if (stepKey) {
                        await updateStep(stepKey, res.statut, res.details, res.capture);
                    }
                    if (res.capture && res.statut === "SUCCESS" && audit.airtable_record_id) {
                        try {
                            await updateAirtableField(audit.airtable_record_id, fieldId, res.capture);
                        } catch (e) {
                            console.error(`[WORKER] Failed to update Airtable for ${fieldId}:`, e.message);
                        }
                    }
                }
            }

            // STEP 9: 404 Check
            if (await checkCancellation()) return;
            try {
                await updateStep('check_404', 'EN_COURS');
                if (sheetAuditUrl) {
                    console.log(`[WORKER] [JOB ${job.id}] Starting 404 check...`);
                    const res404 = await check404(sheetAuditUrl, auditId);
                    await updateStep('check_404', res404.statut, res404.details, res404.capture);
                    if (audit.airtable_record_id) {
                        if (res404.capture) await updateAirtableField(audit.airtable_record_id, 'Img_404', res404.capture);
                        if (res404.lien404) await updateAirtableField(audit.airtable_record_id, 'lien_404', res404.lien404);
                    }
                } else {
                    await updateStep('check_404', 'SKIP', 'Lien Google Sheet non fourni');
                }
            } catch (e) {
                console.error(`[WORKER] [JOB ${job.id}] 404 Step failed:`, e.message);
                await updateStep('check_404', 'FAILED', e.message);
            }

            // STEP 9: Google Search Console (API-based)
            if (await checkCancellation()) return;
            const gscApiAvailable = googleApiAvailable;

            try {
                await updateStep('gsc_sitemaps', 'EN_COURS');
                if (gscApiAvailable) {
                    console.log(`[WORKER] [JOB ${job.id}] Executing Step: GSC Sitemaps (API)...`);
                    const gscSitRes = await runWithTimeout(captureGscSitemapsAPI(siteUrl, auditId, googleRefreshToken), 240000, 'GSC Sitemaps API');
                    await updateStep('gsc_sitemaps', gscSitRes.statut, gscSitRes.details, gscSitRes.capture);
                    if (audit.airtable_record_id && gscSitRes.capture) await updateAirtableField(audit.airtable_record_id, 'Img_sitemap_declaré', gscSitRes.capture);

                    await updateStep('gsc_https', 'EN_COURS');
                    console.log(`[WORKER] [JOB ${job.id}] Executing Step: GSC HTTPS (API)...`);
                    const gscHttpsRes = await runWithTimeout(captureGscHttpsAPI(siteUrl, auditId, googleRefreshToken), 240000, 'GSC HTTPS API');
                    await updateStep('gsc_https', gscHttpsRes.statut, gscHttpsRes.details, gscHttpsRes.capture);
                    if (audit.airtable_record_id && gscHttpsRes.capture) await updateAirtableField(audit.airtable_record_id, 'Img_https', gscHttpsRes.capture);
                } else {
                    // Fallback to legacy cookie-based Playwright capture
                    googleCookies = await getSessionCookies('google');
                    if (!googleCookies) {
                        await updateStep('gsc_sitemaps', 'SKIP', 'Compte Google non connecte et aucune session cookie');
                        await updateStep('gsc_https', 'SKIP', 'Compte Google non connecte et aucune session cookie');
                    } else {
                        console.log(`[WORKER] [JOB ${job.id}] Executing Step: GSC Sitemaps (cookies fallback)...`);
                        const gscSitRes = await runWithTimeout(captureGscSitemaps(siteUrl, auditId, googleCookies), 240000, 'GSC Sitemaps');
                        await updateStep('gsc_sitemaps', gscSitRes.statut, gscSitRes.details, gscSitRes.capture);
                        if (audit.airtable_record_id && gscSitRes.capture) await updateAirtableField(audit.airtable_record_id, 'Img_sitemap_declaré', gscSitRes.capture);

                        await updateStep('gsc_https', 'EN_COURS');
                        const gscHttpsRes = await runWithTimeout(captureGscHttps(siteUrl, auditId, googleCookies), 240000, 'GSC HTTPS');
                        await updateStep('gsc_https', gscHttpsRes.statut, gscHttpsRes.details, gscHttpsRes.capture);
                        if (audit.airtable_record_id && gscHttpsRes.capture) await updateAirtableField(audit.airtable_record_id, 'Img_https', gscHttpsRes.capture);
                    }
                }
            } catch (e) {
                console.error(`[WORKER] [JOB ${job.id}] GSC Core steps failed:`, e.message);
                await updateStep('gsc_sitemaps', 'FAILED', e.message);
            }

            // STEP 10: MRM (credentials auto-login or cookie fallback)
            if (await checkCancellation()) return;
            try {
                await updateStep('mrm_profondeur', 'EN_COURS');
                if (!audit.mrm_report_url) {
                    await updateStep('mrm_profondeur', 'SKIP', 'Lien MRM non fourni');
                } else {
                    const mrmAuth = await getAuthData('mrm');
                    if (!mrmAuth) {
                        await updateStep('mrm_profondeur', 'SKIP', 'Identifiants MRM non configurés');
                    } else {
                        console.log(`[WORKER] [JOB ${job.id}] Executing Step: MRM...`);
                        const mrmRes = await runWithTimeout(captureMrmProfondeur(audit.mrm_report_url, auditId, mrmAuth), 240000, 'MRM');
                        await updateStep('mrm_profondeur', mrmRes.statut, mrmRes.details, mrmRes.capture);
                        if (audit.airtable_record_id && mrmRes.capture) await updateAirtableField(audit.airtable_record_id, 'Img_profondeur_clics_mrm', mrmRes.capture);
                    }
                }
            } catch (e) {
                console.error(`[WORKER] [JOB ${job.id}] MRM failed:`, e.message);
                await updateStep('mrm_profondeur', 'FAILED', e.message);
            }

            // STEP 11: Ubersuggest (credentials auto-login or cookie fallback)
            if (await checkCancellation()) return;
            try {
                await updateStep('ubersuggest_da', 'EN_COURS');
                const uberAuth = await getAuthData('ubersuggest');
                if (!uberAuth) {
                    await updateStep('ubersuggest_da', 'SKIP', 'Identifiants Ubersuggest non configurés');
                } else {
                    console.log(`[WORKER] [JOB ${job.id}] Executing Step: Ubersuggest...`);
                    const uberRes = await runWithTimeout(captureUbersuggest(siteUrl, auditId, uberAuth), 240000, 'Ubersuggest');
                    await updateStep('ubersuggest_da', uberRes.statut, uberRes.details, uberRes.capture);
                    if (audit.airtable_record_id && uberRes.capture) await updateAirtableField(audit.airtable_record_id, 'Img_autorité_domaine_UBERSUGGEST', uberRes.capture);
                }
            } catch (e) {
                console.error(`[WORKER] [JOB ${job.id}] Ubersuggest failed:`, e.message);
                await updateStep('ubersuggest_da', 'FAILED', e.message);
            }

            // STEP 12: Semrush
            if (await checkCancellation()) return;
            try {
                await updateStep('semrush_authority', 'EN_COURS');
                const semRes = await runWithTimeout(captureSemrush(siteUrl, auditId), 240000, 'Semrush');
                await updateStep('semrush_authority', semRes.statut, semRes.details, semRes.capture);
                if (audit.airtable_record_id && semRes.capture) await updateAirtableField(audit.airtable_record_id, 'Img_autorité_domaine_SEMRUSH', semRes.capture);
            } catch (e) {
                console.error(`[WORKER] [JOB ${job.id}] Semrush failed:`, e.message);
                await updateStep('semrush_authority', 'FAILED', e.message);
            }

            // STEP 13: Ahrefs
            if (await checkCancellation()) return;
            try {
                await updateStep('ahrefs_authority', 'EN_COURS');
                const ahrRes = await runWithTimeout(captureAhrefs(siteUrl, auditId), 240000, 'Ahrefs');
                await updateStep('ahrefs_authority', ahrRes.statut, ahrRes.details, ahrRes.capture);
                if (audit.airtable_record_id && ahrRes.capture) await updateAirtableField(audit.airtable_record_id, 'Img_autorité_domaine_AHREF', ahrRes.capture);
            } catch (e) {
                console.error(`[WORKER] [JOB ${job.id}] Ahrefs failed:`, e.message);
                await updateStep('ahrefs_authority', 'FAILED', e.message);
            }

            /* Moved up to STEP 8 */

            // STEP 15: GSC Performance (Traffic)
            if (await checkCancellation()) return;
            if (gscApiAvailable) {
                // -- API-based GSC Performance --
                try {
                    await updateStep('gsc_performance', 'EN_COURS');
                    await updateStep('gsc_meilleure_requete', 'EN_COURS');
                    await updateStep('gsc_query_page_clicks_impressions', 'EN_COURS');
                    const gscPerfRes = await runWithTimeout(
                        captureGscPerformanceAPI(siteUrl, auditId, googleRefreshToken),
                        240000,
                        'GSC Performance API'
                    );
                    await updateStep('gsc_performance', gscPerfRes.statut, gscPerfRes.details, gscPerfRes.capture1);
                    const bestQueryStep = buildDerivedCaptureStep(
                        gscPerfRes.bestQueryCapture, gscPerfRes.statut, gscPerfRes.details, 'Capture de la meilleure requête non générée'
                    );
                    const queryTableStep = buildDerivedCaptureStep(
                        gscPerfRes.queryPageClicksImpressionsCapture, gscPerfRes.statut, gscPerfRes.details, 'Capture query/page/clicks/impressions non générée'
                    );
                    await updateStep('gsc_meilleure_requete', bestQueryStep.status, bestQueryStep.details, bestQueryStep.outputUrl);
                    await updateStep('gsc_query_page_clicks_impressions', queryTableStep.status, queryTableStep.details, queryTableStep.outputUrl);
                    if (audit.airtable_record_id) {
                        if (gscPerfRes.capture1) await updateAirtableField(audit.airtable_record_id, 'Img_trafic actuel1', gscPerfRes.capture1);
                        if (gscPerfRes.capture2) await updateAirtableField(audit.airtable_record_id, 'Img_trafic actuel2', gscPerfRes.capture2);
                        if (hasAirtableValue(gscPerfRes.clics)) await updateAirtableField(audit.airtable_record_id, 'nombres de clics trafic actuel', gscPerfRes.clics);
                        if (gscPerfRes.capture2) await updateAirtableField(audit.airtable_record_id, 'Img_donnee_brute_gcs', gscPerfRes.capture2);
                        if (gscPerfRes.bestQueryCapture) await updateAirtableField(audit.airtable_record_id, 'Img_meilleure_requete', gscPerfRes.bestQueryCapture);
                        if (gscPerfRes.queryPageClicksImpressionsCapture) await updateAirtableField(audit.airtable_record_id, 'Img_query_page_clicks_impressions', gscPerfRes.queryPageClicksImpressionsCapture);
                    }
                } catch (e) {
                    console.error(`[WORKER] [JOB ${job.id}] GSC Performance API failed:`, e.message);
                    await updateStep('gsc_performance', 'FAILED', e.message);
                    await updateStep('gsc_meilleure_requete', 'FAILED', e.message);
                    await updateStep('gsc_query_page_clicks_impressions', 'FAILED', e.message);
                }

                // STEP 16: GSC Coverage (Pages Indexed) — API
                try {
                    await updateStep('gsc_coverage', 'EN_COURS');
                    await updateStep('gsc_indexation_image', 'EN_COURS');
                    await updateStep('gsc_problemes_indexation', 'EN_COURS');
                    const gscCovRes = await runWithTimeout(
                        captureGscCoverageAPI(siteUrl, auditId, googleRefreshToken),
                        240000,
                        'GSC Coverage API'
                    );
                    await updateStep('gsc_coverage', gscCovRes.statut, gscCovRes.details, gscCovRes.capture);
                    const indexationStep = buildDerivedCaptureStep(
                        gscCovRes.indexationCapture, gscCovRes.statut, gscCovRes.details, 'Capture d\'indexation GSC non générée'
                    );
                    const problemIndexationStep = buildDerivedCaptureStep(
                        gscCovRes.problemCapture, gscCovRes.statut, gscCovRes.details, 'Capture des problèmes d\'indexation non générée'
                    );
                    await updateStep('gsc_indexation_image', indexationStep.status, indexationStep.details, indexationStep.outputUrl);
                    await updateStep('gsc_problemes_indexation', problemIndexationStep.status, problemIndexationStep.details, problemIndexationStep.outputUrl);
                    if (audit.airtable_record_id) {
                        if (gscCovRes.capture) await updateAirtableField(audit.airtable_record_id, 'Img_urls', gscCovRes.capture);
                        if (hasNumericValue(gscCovRes.pagesIndexed)) await updateAirtableField(audit.airtable_record_id, 'nombres de pages indexé trafic actuel', Number(String(gscCovRes.pagesIndexed).replace(/[\s\u00A0.,]/g, '')));
                        if (gscCovRes.indexationCapture) await updateAirtableField(audit.airtable_record_id, 'Img_indexation_gsc', gscCovRes.indexationCapture);
                        if (gscCovRes.problemCapture) await updateAirtableField(audit.airtable_record_id, 'Img_probleme_indexation_gsc', gscCovRes.problemCapture);
                    }
                } catch (e) {
                    console.error(`[WORKER] [JOB ${job.id}] GSC Coverage API failed:`, e.message);
                    await updateStep('gsc_coverage', 'FAILED', e.message);
                    await updateStep('gsc_indexation_image', 'FAILED', e.message);
                    await updateStep('gsc_problemes_indexation', 'FAILED', e.message);
                }

                // STEP 17: GSC Top Pages — API
                try {
                    await updateStep('gsc_top_pages', 'EN_COURS');
                    const gscTopRes = await runWithTimeout(
                        captureGscTopPagesAPI(siteUrl, auditId, googleRefreshToken),
                        240000,
                        'GSC Top Pages API'
                    );
                    await updateStep('gsc_top_pages', gscTopRes.statut, gscTopRes.details, gscTopRes.capture);
                    if (audit.airtable_record_id && gscTopRes.capture) await updateAirtableField(audit.airtable_record_id, 'Img_meilleure_page', gscTopRes.capture);
                } catch (e) {
                    console.error(`[WORKER] [JOB ${job.id}] GSC Top Pages API failed:`, e.message);
                    await updateStep('gsc_top_pages', 'FAILED', e.message);
                }
            } else if (googleCookies) {
                // -- Fallback: Cookie-based Playwright capture --
                try {
                    await updateStep('gsc_performance', 'EN_COURS');
                    await updateStep('gsc_meilleure_requete', 'EN_COURS');
                    await updateStep('gsc_query_page_clicks_impressions', 'EN_COURS');
                    const gscPerfRes = await runWithTimeout(
                        captureGscPerformance(siteUrl, auditId, googleCookies),
                        240000,
                        'GSC Performance'
                    );
                    await updateStep('gsc_performance', gscPerfRes.statut, gscPerfRes.details, gscPerfRes.capture1);
                    const bestQueryStep = buildDerivedCaptureStep(
                        gscPerfRes.bestQueryCapture, gscPerfRes.statut, gscPerfRes.details, 'Capture de la meilleure requête non générée'
                    );
                    const queryTableStep = buildDerivedCaptureStep(
                        gscPerfRes.queryPageClicksImpressionsCapture, gscPerfRes.statut, gscPerfRes.details, 'Capture query/page/clicks/impressions non générée'
                    );
                    await updateStep('gsc_meilleure_requete', bestQueryStep.status, bestQueryStep.details, bestQueryStep.outputUrl);
                    await updateStep('gsc_query_page_clicks_impressions', queryTableStep.status, queryTableStep.details, queryTableStep.outputUrl);
                    if (audit.airtable_record_id) {
                        if (gscPerfRes.capture1) await updateAirtableField(audit.airtable_record_id, 'Img_trafic actuel1', gscPerfRes.capture1);
                        if (gscPerfRes.capture2) await updateAirtableField(audit.airtable_record_id, 'Img_trafic actuel2', gscPerfRes.capture2);
                        if (hasAirtableValue(gscPerfRes.clics)) await updateAirtableField(audit.airtable_record_id, 'nombres de clics trafic actuel', gscPerfRes.clics);
                        if (gscPerfRes.capture2) await updateAirtableField(audit.airtable_record_id, 'Img_donnee_brute_gcs', gscPerfRes.capture2);
                        if (gscPerfRes.bestQueryCapture) await updateAirtableField(audit.airtable_record_id, 'Img_meilleure_requete', gscPerfRes.bestQueryCapture);
                        if (gscPerfRes.queryPageClicksImpressionsCapture) await updateAirtableField(audit.airtable_record_id, 'Img_query_page_clicks_impressions', gscPerfRes.queryPageClicksImpressionsCapture);
                    }
                } catch (e) {
                    console.error(`[WORKER] [JOB ${job.id}] GSC Performance failed:`, e.message);
                    await updateStep('gsc_performance', 'FAILED', e.message);
                    await updateStep('gsc_meilleure_requete', 'FAILED', e.message);
                    await updateStep('gsc_query_page_clicks_impressions', 'FAILED', e.message);
                }

                try {
                    await updateStep('gsc_coverage', 'EN_COURS');
                    await updateStep('gsc_indexation_image', 'EN_COURS');
                    await updateStep('gsc_problemes_indexation', 'EN_COURS');
                    const gscCovRes = await runWithTimeout(
                        captureGscCoverage(siteUrl, auditId, googleCookies),
                        240000,
                        'GSC Coverage'
                    );
                    await updateStep('gsc_coverage', gscCovRes.statut, gscCovRes.details, gscCovRes.capture);
                    const indexationStep = buildDerivedCaptureStep(
                        gscCovRes.indexationCapture, gscCovRes.statut, gscCovRes.details, 'Capture d\'indexation GSC non générée'
                    );
                    const problemIndexationStep = buildDerivedCaptureStep(
                        gscCovRes.problemCapture, gscCovRes.statut, gscCovRes.details, 'Capture des problèmes d\'indexation non générée'
                    );
                    await updateStep('gsc_indexation_image', indexationStep.status, indexationStep.details, indexationStep.outputUrl);
                    await updateStep('gsc_problemes_indexation', problemIndexationStep.status, problemIndexationStep.details, problemIndexationStep.outputUrl);
                    if (audit.airtable_record_id) {
                        if (gscCovRes.capture) await updateAirtableField(audit.airtable_record_id, 'Img_urls', gscCovRes.capture);
                        if (hasNumericValue(gscCovRes.pagesIndexed)) await updateAirtableField(audit.airtable_record_id, 'nombres de pages indexé trafic actuel', Number(String(gscCovRes.pagesIndexed).replace(/[\s\u00A0.,]/g, '')));
                        if (gscCovRes.indexationCapture) await updateAirtableField(audit.airtable_record_id, 'Img_indexation_gsc', gscCovRes.indexationCapture);
                        if (gscCovRes.problemCapture) await updateAirtableField(audit.airtable_record_id, 'Img_probleme_indexation_gsc', gscCovRes.problemCapture);
                    }
                } catch (e) {
                    console.error(`[WORKER] [JOB ${job.id}] GSC Coverage failed:`, e.message);
                    await updateStep('gsc_coverage', 'FAILED', e.message);
                    await updateStep('gsc_indexation_image', 'FAILED', e.message);
                    await updateStep('gsc_problemes_indexation', 'FAILED', e.message);
                }

                try {
                    await updateStep('gsc_top_pages', 'EN_COURS');
                    const gscTopRes = await runWithTimeout(
                        captureGscTopPages(siteUrl, auditId, googleCookies),
                        240000,
                        'GSC Top Pages'
                    );
                    await updateStep('gsc_top_pages', gscTopRes.statut, gscTopRes.details, gscTopRes.capture);
                    if (audit.airtable_record_id && gscTopRes.capture) await updateAirtableField(audit.airtable_record_id, 'Img_meilleure_page', gscTopRes.capture);
                } catch (e) {
                    console.error(`[WORKER] [JOB ${job.id}] GSC Top Pages failed:`, e.message);
                    await updateStep('gsc_top_pages', 'FAILED', e.message);
                }
            } else {
                for (const k of [
                    'gsc_performance',
                    'gsc_meilleure_requete',
                    'gsc_query_page_clicks_impressions',
                    'gsc_coverage',
                    'gsc_indexation_image',
                    'gsc_problemes_indexation',
                    'gsc_top_pages'
                ]) {
                    await updateStep(k, 'SKIP', 'Compte Google non connecte et aucune session cookie');
                }
            }

            // STEP 18: Majestic Backlinks
            try {
                await updateStep('majestic_backlinks', 'EN_COURS');
                const majRes = await runWithTimeout(captureMajesticBacklinks(siteUrl, auditId), 240000, 'Majestic Backlinks');
                await updateStep('majestic_backlinks', majRes.statut, majRes.details, majRes.capture);
                if (audit.airtable_record_id && majRes.capture) await updateAirtableField(audit.airtable_record_id, 'Img_BACKLINKS', majRes.capture);
            } catch (e) {
                console.error(`[WORKER] [JOB ${job.id}] Majestic failed:`, e.message);
                await updateStep('majestic_backlinks', 'FAILED', e.message);
            }


            // Global Success
            console.log(`[WORKER] [JOB ${job.id}] Finalizing Audit ${auditId}...`);
            await db.run('UPDATE audits SET statut_global = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', ['TERMINE', auditId]);

            // Sync to Airtable (Non-blocking)
            if (audit.airtable_record_id) {
                try {
                    console.log(`[WORKER] [JOB ${job.id}] Updating Airtable Status to 'fait'...`);
                    await updateAirtableStatut(audit.airtable_record_id, 'fait');
                } catch (e) {
                    console.error('[WORKER] Failed to sync "Terminé" to Airtable:', e.message);
                }
            }

            const finalAudit = await db.get('SELECT * FROM audits WHERE id = ?', [auditId]);
            io.to(`audit:${auditId}`).emit('audit:update', finalAudit);

            console.log(`[WORKER] [JOB ${job.id}] Audit ${auditId} completed successfully`);

        } catch (err) {
            console.error(`[WORKER] [JOB ${job.id}] Audit ${auditId} failed:`, err);
            try {
                await db.run('UPDATE audits SET statut_global = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', ['ERREUR', auditId]);
            } catch { }

            // Sync Error to Airtable — safely check audit exists
            try {
                const auditRecord = await db.get('SELECT airtable_record_id FROM audits WHERE id = ?', [auditId]);
                if (auditRecord?.airtable_record_id) {
                    await updateAirtableStatut(auditRecord.airtable_record_id, 'Erreur');
                }
            } catch (e) {
                console.error('[WORKER] Failed to sync "Erreur" to Airtable:', e.message);
            }

            const finalAudit = await db.get('SELECT * FROM audits WHERE id = ?', [auditId]);
            if (finalAudit) {
                io.to(`audit:${auditId}`).emit('audit:update', finalAudit);
            }
        }

    }, { connection });

    worker.on('ready', () => {
        console.log('[WORKER] Worker is ready and listening for jobs.');
    });

    worker.on('active', (job) => {
        console.log(`[WORKER] Job ${job.id} active.`);
    });

    worker.on('completed', job => {
        console.log(`[WORKER] Job ${job.id} completed.`);
    });

    worker.on('failed', (job, err) => {
        console.error(`[WORKER] Job ${job.id || 'unknown'} failed: ${err.message}`);
    });

    worker.on('error', err => {
        console.error('[WORKER] Critical Worker Error:', err.message);
    });

    return worker;
};
