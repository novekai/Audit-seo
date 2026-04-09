/**
 * robots_sitemap.js
 * Restored to "Premium" aesthetics from yesterday morning.
 * Uses programmatic pixel-perfect cropping for Sitemap.
 * Includes "Skip if missing" logic.
 */
import { chromium } from 'playwright';
import sharp from 'sharp';
import { uploadBufferToCloudinary } from '../utils/cloudinary.js';

function extractPreviewLines(text, limit = 40) {
    const rawLines = String(text || '')
        .split(/\r?\n/)
        .map((line) => line.trimEnd())
        .filter((line) => line.trim());

    return {
        lines: rawLines.slice(0, limit),
        truncated: rawLines.length > limit,
        total: rawLines.length
    };
}

async function renderSitemapCapture(page, auditId, { title, subtitle, lines, tone = 'info', footerNote = '' }) {
    const palette = tone === 'success'
        ? {
            badgeBg: 'rgba(34, 197, 94, 0.18)',
            badgeColor: '#86efac',
            borderColor: 'rgba(34, 197, 94, 0.24)',
            accentColor: '#7dd3fc'
        }
        : tone === 'error'
            ? {
                badgeBg: 'rgba(251, 113, 133, 0.18)',
                badgeColor: '#fecdd3',
                borderColor: 'rgba(251, 113, 133, 0.24)',
                accentColor: '#fda4af'
            }
            : {
                badgeBg: 'rgba(250, 204, 21, 0.18)',
                badgeColor: '#fde68a',
                borderColor: 'rgba(250, 204, 21, 0.24)',
                accentColor: '#fcd34d'
            };

    const captureLines = Array.isArray(lines) && lines.length > 0
        ? lines
        : ['Aucune ligne exploitable disponible pour cette capture.'];

    const dimensions = await page.evaluate(({ title, subtitle, lines, footerNote, palette }) => {
        document.body.innerHTML = '';
        document.body.style.cssText = 'background: #020617; margin: 0; padding: 0; overflow: hidden;';

        const shell = document.createElement('div');
        shell.style.cssText = `
            width: 1120px;
            padding: 30px 34px;
            background: linear-gradient(180deg, #0f172a 0%, #020617 100%);
            color: #e2e8f0;
            font-family: 'Inter', 'Segoe UI', sans-serif;
            border: 1px solid ${palette.borderColor};
            border-radius: 22px;
            box-shadow: 0 24px 70px rgba(2, 6, 23, 0.35);
        `;

        const heading = document.createElement('div');
        heading.style.cssText = 'display:flex; align-items:flex-start; justify-content:space-between; gap:24px; margin-bottom:18px;';

        const titleBlock = document.createElement('div');

        const titleEl = document.createElement('div');
        titleEl.textContent = title;
        titleEl.style.cssText = 'font-size: 26px; font-weight: 800; color: #f8fafc; letter-spacing: -0.03em;';
        titleBlock.appendChild(titleEl);

        if (subtitle) {
            const subtitleEl = document.createElement('div');
            subtitleEl.textContent = subtitle;
            subtitleEl.style.cssText = 'margin-top: 8px; font-size: 14px; line-height: 1.6; color: #94a3b8;';
            titleBlock.appendChild(subtitleEl);
        }

        const badge = document.createElement('div');
        badge.textContent = 'Capture sitemap';
        badge.style.cssText = `
            padding: 8px 12px;
            border-radius: 999px;
            background: ${palette.badgeBg};
            color: ${palette.badgeColor};
            font-size: 12px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 0.16em;
            white-space: nowrap;
        `;

        heading.appendChild(titleBlock);
        heading.appendChild(badge);
        shell.appendChild(heading);

        const panel = document.createElement('div');
        panel.style.cssText = `
            padding: 18px 20px;
            border-radius: 18px;
            background: rgba(15, 23, 42, 0.72);
            border: 1px solid rgba(148, 163, 184, 0.14);
            font-family: 'Fira Code', 'Courier New', monospace;
            font-size: 13px;
            line-height: 1.6;
            color: #cbd5e1;
            min-height: 120px;
        `;

        lines.forEach((line) => {
            const row = document.createElement('div');
            row.textContent = line;
            row.style.cssText = 'padding: 2px 0; word-break: break-word;';
            if (line.includes('://') || line.trim().startsWith('<') || line.trim().startsWith('<?xml')) {
                row.style.color = palette.accentColor;
            }
            panel.appendChild(row);
        });

        shell.appendChild(panel);

        if (footerNote) {
            const footer = document.createElement('div');
            footer.textContent = footerNote;
            footer.style.cssText = 'margin-top: 14px; font-size: 13px; line-height: 1.6; color: #94a3b8;';
            shell.appendChild(footer);
        }

        document.body.appendChild(shell);
        const rect = shell.getBoundingClientRect();
        return {
            width: Math.ceil(rect.width) + 20,
            height: Math.ceil(rect.height) + 20
        };
    }, { title, subtitle, lines: captureLines, footerNote, palette });

    await page.waitForTimeout(300);
    const buffer = await page.screenshot({ fullPage: false });
    const meta = await sharp(buffer).metadata();

    const width = Math.min(Math.max(dimensions.width, 420), meta.width);
    const height = Math.min(Math.max(dimensions.height, 180), meta.height);

    const finalBuffer = await sharp(buffer)
        .extract({ left: 0, top: 0, width, height })
        .toBuffer();

    return uploadBufferToCloudinary(finalBuffer, `sitemap-final-${auditId}.png`, 'audit-captures');
}

/**
 * Audit robots.txt and detect sitemap(s).
 */
export async function auditRobotsSitemap(url, auditId) {
    console.log(`[MODULE-ROBOTS] Démarrage de l'audit pour : ${url}`);

    const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const context = await browser.newContext({
        viewport: { width: 1400, height: 900 }
    });

    const page = await context.newPage();
    let robotsUrl = url.endsWith('/') ? `${url}robots.txt` : `${url}/robots.txt`;

    const robotsResult = {
        robots_txt: { statut: 'EN_COURS', capture: null, url: robotsUrl },
        sitemap: { statut: 'EN_ATTENTE', url: null, capture: null }
    };

    try {
        // --- STAGE 1: robots.txt ---
        console.log(`[MODULE-ROBOTS] Navigation vers : ${robotsUrl}`);
        const robotsResponse = await page.goto(robotsUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

        if (!robotsResponse || robotsResponse.status() >= 400) {
            robotsResult.robots_txt.statut = 'ERROR';
            robotsResult.robots_txt.details = `Erreur HTTP: ${robotsResponse ? robotsResponse.status() : 'Pas de réponse'}`;
        } else {
            // Analyse simple pour détecter les sitemaps
            const rawText = await page.evaluate(() => document.body.textContent || document.body.innerText || '');
            const lines = rawText.split('\n');

            const sitemapLinesIndices = [];
            let firstSitemapUrl = null;

            lines.forEach((line, idx) => {
                if (line.trim().toLowerCase().startsWith('sitemap:')) {
                    sitemapLinesIndices.push(idx);
                    const match = line.match(/sitemaps?:\s*(https?:\/\/\S+)/i);
                    if (match && !firstSitemapUrl) firstSitemapUrl = match[1];
                }
            });

            if (firstSitemapUrl) {
                robotsResult.sitemap.url = firstSitemapUrl;
                robotsResult.sitemap.statut = 'EN_COURS';
            }

            // Rendu Premium Robots.txt
            const robotsDimensions = await page.evaluate((sitemapIndices) => {
                const text = document.body.textContent || '';
                const lines = text.split('\n');

                document.body.innerHTML = '';
                document.body.style.cssText = 'background: #0d1117; margin: 0; padding: 0; overflow: hidden;';

                const container = document.createElement('div');
                container.style.cssText = `
                    padding: 30px 40px;
                    font-family: 'Fira Code', 'Courier New', monospace;
                    font-size: 16px;
                    line-height: 1.7;
                    color: #c9d1d9;
                    background: #0d1117;
                    display: inline-block;
                    min-width: 400px;
                `;

                lines.forEach((line, idx) => {
                    const div = document.createElement('div');
                    div.textContent = line || ' ';

                    if (sitemapIndices.includes(idx)) {
                        div.style.cssText = 'background: rgba(56, 139, 253, 0.25); border-left: 4px solid #58a6ff; padding: 4px 12px; margin: 4px 0; border-radius: 4px; font-weight: bold; color: #ffffff;';
                    } else if (line.trim().startsWith('#')) {
                        div.style.color = '#6e7681';
                    } else if (line.toLowerCase().startsWith('user-agent')) {
                        div.style.color = '#ff7b72';
                        div.style.fontWeight = 'bold';
                    }
                    container.appendChild(div);
                });

                document.body.appendChild(container);
                const rect = container.getBoundingClientRect();
                return { width: Math.ceil(rect.width) + 20, height: Math.ceil(rect.height) + 20 };
            }, sitemapLinesIndices);

            await page.waitForTimeout(500);
            const robotsBuffer = await page.screenshot({ fullPage: false });
            const robotsMeta = await sharp(robotsBuffer).metadata();

            const rWidth = Math.min(robotsDimensions.width, robotsMeta.width);
            const rHeight = Math.min(robotsDimensions.height, robotsMeta.height);

            const robotsFinalBuffer = await sharp(robotsBuffer)
                .extract({ left: 0, top: 0, width: Math.max(rWidth, 400), height: Math.max(rHeight, 100) })
                .toBuffer();

            robotsResult.robots_txt.capture = await uploadBufferToCloudinary(robotsFinalBuffer, `robots-final-${auditId}.png`, 'audit-captures');
            robotsResult.robots_txt.statut = 'SUCCESS';
        }

        // --- STAGE 2: Sitemap Navigation & Capture ---
        const fallbackCandidates = [`${url}/sitemap.xml`, `${url}/sitemap_index.xml`, `${url}/wp-sitemap.xml`];

        if (!robotsResult.sitemap.url) {
            console.log("[MODULE-ROBOTS] Pas de sitemap direct. Test des fallbacks...");
            for (const fb of fallbackCandidates) {
                try {
                    const res = await page.goto(fb, { timeout: 10000 });
                    if (res && res.status() < 400) {
                        robotsResult.sitemap.url = fb;
                        break;
                    }
                } catch { }
            }
        }

        if (robotsResult.sitemap.url) {
            console.log(`[MODULE-ROBOTS] Capture Sitemap : ${robotsResult.sitemap.url}`);
            try {
                // Navigate away and then set content to avoid XML issues
                const sitemapRes = await page.goto(robotsResult.sitemap.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
                let rawText = '';
                try { rawText = await sitemapRes.text(); } catch {
                    rawText = await page.evaluate(() => document.body?.textContent || document.documentElement?.textContent || '');
                }
                const preview = extractPreviewLines(rawText);
                const footerNote = preview.truncated
                    ? `Aperçu tronqué: ${preview.total} lignes détectées, 40 premières lignes affichées.`
                    : `Source détectée: ${robotsResult.sitemap.url}`;

                robotsResult.sitemap.capture = await renderSitemapCapture(page, auditId, {
                    title: 'Sitemap détecté',
                    subtitle: robotsResult.sitemap.url,
                    lines: preview.lines,
                    tone: 'success',
                    footerNote
                });
                robotsResult.sitemap.statut = 'SUCCESS';
                robotsResult.sitemap.details = `Capture sitemap générée depuis ${robotsResult.sitemap.url}`;

            } catch (err) {
                console.error("[MODULE-ROBOTS] Erreur Sitemap:", err.message);
                robotsResult.sitemap.capture = await renderSitemapCapture(page, auditId, {
                    title: 'Sitemap détecté mais capture incomplète',
                    subtitle: robotsResult.sitemap.url,
                    lines: [
                        `URL sitemap: ${robotsResult.sitemap.url}`,
                        `Erreur: ${err.message}`
                    ],
                    tone: 'error',
                    footerNote: 'La récupération du contenu sitemap a échoué pendant la capture.'
                });
                robotsResult.sitemap.statut = 'ERROR';
                robotsResult.sitemap.details = `Erreur pendant la capture du sitemap: ${err.message}`;
            }
        } else {
            console.log("[MODULE-ROBOTS] Sitemap NON DÉTECTÉ. Génération d'un visuel de diagnostic.");
            robotsResult.sitemap.capture = await renderSitemapCapture(page, auditId, {
                title: 'Sitemap non détecté',
                subtitle: url,
                lines: [
                    'Aucune URL de sitemap valide n a été détectée dans robots.txt.',
                    'Fallbacks testés :',
                    ...fallbackCandidates
                ],
                tone: 'warning',
                footerNote: 'Le step sitemap reste visible dans l audit avec un diagnostic explicite.'
            });
            robotsResult.sitemap.statut = 'SKIP';
            robotsResult.sitemap.details = 'Aucun sitemap détecté sur les URLs testées.';
        }

    } catch (err) {
        console.error('[MODULE-ROBOTS] Global error:', err);
        robotsResult.robots_txt.statut = 'ERROR';
    } finally {
        await browser.close();
    }
    return robotsResult;
}
