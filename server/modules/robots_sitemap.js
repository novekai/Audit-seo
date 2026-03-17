/**
 * robots_sitemap.js
 * Restored to "Premium" aesthetics from yesterday morning.
 * Uses programmatic pixel-perfect cropping for Sitemap.
 * Includes "Skip if missing" logic.
 */
import { chromium } from 'playwright';
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { uploadBufferToCloudinary } from '../utils/cloudinary.js';

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
        if (!robotsResult.sitemap.url) {
            console.log("[MODULE-ROBOTS] Pas de sitemap direct. Test des fallbacks...");
            const fallbacks = [`${url}/sitemap.xml`, `${url}/sitemap_index.xml`, `${url}/wp-sitemap.xml`];
            for (const fb of fallbacks) {
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

                const sitemapDimensions = await page.evaluate((text) => {
                    const lines = text.split('\n').filter(l => l.trim()).slice(0, 40);

                    document.body.innerHTML = '';
                    document.body.style.cssText = 'background: #0d1117; margin: 0; padding: 0; overflow: hidden;';

                    const container = document.createElement('div');
                    container.style.cssText = `
                        padding: 30px 40px;
                        font-family: 'Fira Code', 'Courier New', monospace;
                        font-size: 14px;
                        line-height: 1.5;
                        color: #c9d1d9;
                        background: #0d1117;
                        display: inline-block;
                        min-width: 400px;
                    `;

                    lines.forEach(line => {
                        const div = document.createElement('div');
                        div.textContent = line;
                        if (line.includes('://') || line.trim().startsWith('<')) {
                            div.style.color = '#79c0ff';
                        }
                        container.appendChild(div);
                    });

                    if (text.split('\n').length > 40) {
                        const more = document.createElement('div');
                        more.textContent = `... (+ de 40 lignes)`;
                        more.style.cssText = 'color: #6e7681; font-style: italic; margin-top: 10px;';
                        container.appendChild(more);
                    }

                    document.body.appendChild(container);
                    const rect = container.getBoundingClientRect();
                    return { width: Math.ceil(rect.width) + 20, height: Math.ceil(rect.height) + 20 };
                }, rawText);

                await page.waitForTimeout(500);
                const sitemapBuffer = await page.screenshot({ fullPage: false });
                const sMeta = await sharp(sitemapBuffer).metadata();

                const sWidth = Math.min(Math.max(sitemapDimensions.width, 400), sMeta.width);
                const sHeight = Math.min(Math.max(sitemapDimensions.height, 100), sMeta.height);

                const sitemapFinalBuffer = await sharp(sitemapBuffer)
                    .extract({ left: 0, top: 0, width: sWidth, height: sHeight })
                    .toBuffer();

                robotsResult.sitemap.capture = await uploadBufferToCloudinary(sitemapFinalBuffer, `sitemap-final-${auditId}.png`, 'audit-captures');
                robotsResult.sitemap.statut = 'SUCCESS';

            } catch (err) {
                console.error("[MODULE-ROBOTS] Erreur Sitemap:", err.message);
                robotsResult.sitemap.statut = 'ERROR';
            }
        } else {
            console.log("[MODULE-ROBOTS] Sitemap NON DÉTECTÉ. Aucun placeholder généré.");
            robotsResult.sitemap.capture = null;
            robotsResult.sitemap.statut = 'SKIP';
        }

    } catch (err) {
        console.error('[MODULE-ROBOTS] Global error:', err);
        robotsResult.robots_txt.statut = 'ERROR';
    } finally {
        await browser.close();
    }
    return robotsResult;
}
