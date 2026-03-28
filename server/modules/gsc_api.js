import { google } from 'googleapis';
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import sharp from 'sharp';
import { uploadToCloudinary } from '../utils/cloudinary.js';

// -- OAuth2 client for Google Search Console API ------------------------------
function gscAuth() {
    const oauth2 = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET
    );
    oauth2.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
    return oauth2;
}

function webmastersClient() {
    return google.webmasters({ version: 'v3', auth: gscAuth() });
}

function searchConsoleClient() {
    return google.searchconsole({ version: 'v1', auth: gscAuth() });
}

// -- Helpers ------------------------------------------------------------------

function getTmpDir() {
    return process.env.RAILWAY_ENVIRONMENT ? '/tmp' : '.';
}

function escapeHtml(s) {
    return String(s ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

function formatNumber(n) {
    if (n == null || isNaN(n)) return '—';
    return Number(n).toLocaleString('fr-FR');
}

function formatPercent(n) {
    if (n == null || isNaN(n)) return '—';
    return (Number(n) * 100).toFixed(1) + '%';
}

function formatPosition(n) {
    if (n == null || isNaN(n)) return '—';
    return Number(n).toFixed(1);
}

function dateDaysAgo(days) {
    const d = new Date();
    d.setDate(d.getDate() - days);
    return d.toISOString().split('T')[0];
}

// -- Resolve site URL for API (try https:// and sc-domain:) ------------------
async function resolveSiteUrl(wm, domain) {
    const candidates = [
        `https://${domain}/`,
        `sc-domain:${domain}`,
        `http://${domain}/`
    ];

    try {
        const { data } = await wm.sites.list();
        const sites = (data.siteEntry || []).map(s => s.siteUrl);
        console.log(`[GSC-API] Available properties: ${sites.join(', ')}`);

        for (const cand of candidates) {
            if (sites.includes(cand)) {
                console.log(`[GSC-API] Matched property: ${cand}`);
                return cand;
            }
        }
        // Try partial match (domain without trailing slash)
        for (const site of sites) {
            if (site.includes(domain)) {
                console.log(`[GSC-API] Partial match: ${site}`);
                return site;
            }
        }
    } catch (e) {
        console.warn(`[GSC-API] sites.list failed: ${e.message}`);
    }

    return candidates[0]; // fallback
}

// -- HTML rendering + screenshot ---------------------------------------------

function renderHtmlTable({ title, headers, rows, subtitle }) {
    const ths = headers.map(h => `<th>${escapeHtml(h)}</th>`).join('');
    const trs = rows.map(row => {
        const tds = row.map(cell => {
            const val = String(cell ?? '');
            if (/^https?:\/\//i.test(val.trim())) {
                return `<td><span style="color:#1155cc;">${escapeHtml(val)}</span></td>`;
            }
            return `<td>${escapeHtml(val)}</td>`;
        }).join('');
        return `<tr>${tds}</tr>`;
    }).join('');

    const subtitleHtml = subtitle ? `<p class="subtitle">${escapeHtml(subtitle)}</p>` : '';

    return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8"/>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #fff; }
  .wrap {
    display: inline-block;
    padding: 16px;
    font-family: 'Google Sans', Arial, Helvetica, sans-serif;
    font-size: 13px;
  }
  h2 {
    font-size: 16px;
    font-weight: 600;
    color: #202124;
    margin-bottom: 4px;
  }
  .subtitle {
    font-size: 12px;
    color: #5f6368;
    margin-bottom: 12px;
  }
  table { border-collapse: collapse; width: 100%; }
  thead th {
    background: #f8f9fa;
    border-bottom: 2px solid #dadce0;
    padding: 8px 12px;
    font-size: 12px;
    font-weight: 600;
    color: #5f6368;
    text-align: left;
    white-space: nowrap;
  }
  tbody td {
    border-bottom: 1px solid #e8eaed;
    padding: 8px 12px;
    font-size: 13px;
    color: #202124;
    vertical-align: top;
    white-space: nowrap;
    max-width: 500px;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  tbody tr:hover td { background: #f8f9fa; }
</style>
</head>
<body>
  <div class="wrap" id="capture">
    <h2>${escapeHtml(title)}</h2>
    ${subtitleHtml}
    <table>
      <thead><tr>${ths}</tr></thead>
      <tbody>${trs}</tbody>
    </table>
  </div>
</body>
</html>`;
}

function renderHtmlMetricCards({ title, metrics, subtitle }) {
    const cards = metrics.map(m => `
        <div class="card">
            <div class="card-value" style="color:${m.color || '#1a73e8'}">${escapeHtml(String(m.value))}</div>
            <div class="card-label">${escapeHtml(m.label)}</div>
        </div>
    `).join('');

    const subtitleHtml = subtitle ? `<p class="subtitle">${escapeHtml(subtitle)}</p>` : '';

    return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8"/>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #fff; }
  .wrap {
    display: inline-block;
    padding: 16px;
    font-family: 'Google Sans', Arial, Helvetica, sans-serif;
  }
  h2 {
    font-size: 16px;
    font-weight: 600;
    color: #202124;
    margin-bottom: 4px;
  }
  .subtitle {
    font-size: 12px;
    color: #5f6368;
    margin-bottom: 16px;
  }
  .cards {
    display: flex;
    gap: 24px;
  }
  .card {
    padding: 16px 24px;
    border: 1px solid #dadce0;
    border-radius: 8px;
    min-width: 140px;
    text-align: center;
  }
  .card-value {
    font-size: 28px;
    font-weight: 700;
    margin-bottom: 4px;
  }
  .card-label {
    font-size: 12px;
    color: #5f6368;
    font-weight: 500;
  }
</style>
</head>
<body>
  <div class="wrap" id="capture">
    <h2>${escapeHtml(title)}</h2>
    ${subtitleHtml}
    <div class="cards">${cards}</div>
  </div>
</body>
</html>`;
}

function renderHtmlStatus({ title, status, icon, details }) {
    const iconColor = status === 'OK' ? '#0d904f' : '#d93025';
    const iconSymbol = status === 'OK' ? '✓' : '✗';

    return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8"/>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #fff; }
  .wrap {
    display: inline-block;
    padding: 24px;
    font-family: 'Google Sans', Arial, Helvetica, sans-serif;
  }
  h2 { font-size: 16px; font-weight: 600; color: #202124; margin-bottom: 16px; }
  .status-box {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 16px 24px;
    border: 1px solid #dadce0;
    border-radius: 8px;
    background: ${status === 'OK' ? '#e6f4ea' : '#fce8e6'};
  }
  .icon { font-size: 28px; color: ${iconColor}; font-weight: 700; }
  .label { font-size: 14px; color: #202124; font-weight: 500; }
  .detail { font-size: 12px; color: #5f6368; margin-top: 2px; }
</style>
</head>
<body>
  <div class="wrap" id="capture">
    <h2>${escapeHtml(title)}</h2>
    <div class="status-box">
      <span class="icon">${iconSymbol}</span>
      <div>
        <div class="label">${escapeHtml(icon || (status === 'OK' ? 'Aucun problème détecté' : 'Problèmes détectés'))}</div>
        ${details ? `<div class="detail">${escapeHtml(details)}</div>` : ''}
      </div>
    </div>
  </div>
</body>
</html>`;
}

async function htmlToPng(html, outPath) {
    const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    try {
        const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
        await page.setContent(html, { waitUntil: 'load' });
        const el = page.locator('#capture');
        await el.waitFor({ state: 'visible', timeout: 15000 });
        await el.screenshot({ path: outPath });
        const buf = await sharp(outPath).trim().toBuffer();
        fs.writeFileSync(outPath, buf);
    } finally {
        await browser.close();
    }
}

async function renderAndUpload(html, cloudinaryFolder) {
    const tmpPath = path.join(getTmpDir(), `gsc_api_${uuidv4()}.png`);
    try {
        await htmlToPng(html, tmpPath);
        const uploaded = await uploadToCloudinary(tmpPath, cloudinaryFolder);
        return uploaded?.secure_url || uploaded?.url || uploaded;
    } finally {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// 1. SITEMAPS
// ══════════════════════════════════════════════════════════════════════════════
export async function captureGscSitemapsAPI(siteUrl, auditId) {
    const result = { statut: 'ERROR', capture: null };
    try {
        const domain = new URL(siteUrl).hostname;
        const wm = webmastersClient();
        const siteUrlResolved = await resolveSiteUrl(wm, domain);

        console.log(`[GSC-API] Fetching sitemaps for: ${siteUrlResolved}`);
        const { data } = await wm.sitemaps.list({ siteUrl: siteUrlResolved });
        const sitemaps = data.sitemap || [];

        if (sitemaps.length === 0) {
            const html = renderHtmlStatus({
                title: 'Sitemaps déclarés — Google Search Console',
                status: 'KO',
                icon: 'Aucun sitemap déclaré',
                details: `Propriété : ${siteUrlResolved}`
            });
            result.capture = await renderAndUpload(html, `audit-results/gsc-sitemaps-${auditId}`);
            result.statut = 'SUCCESS';
            return result;
        }

        const headers = ['Sitemap', 'Type', 'Statut', 'URLs découvertes', 'Dernier téléchargement'];
        const rows = sitemaps.map(s => [
            s.path || '—',
            s.type || '—',
            s.lastSubmitted ? 'Soumis' : '—',
            formatNumber(s.contents?.reduce((sum, c) => sum + (c.submitted || 0), 0)),
            s.lastDownloaded ? new Date(s.lastDownloaded).toLocaleDateString('fr-FR') : '—'
        ]);

        const html = renderHtmlTable({
            title: 'Sitemaps déclarés — Google Search Console',
            subtitle: `Propriété : ${siteUrlResolved} — ${sitemaps.length} sitemap(s)`,
            headers,
            rows
        });

        result.capture = await renderAndUpload(html, `audit-results/gsc-sitemaps-${auditId}`);
        result.statut = 'SUCCESS';
    } catch (e) {
        result.details = e.message;
        console.error('[GSC-API] Sitemaps error:', e.message);
    }
    return result;
}

// ══════════════════════════════════════════════════════════════════════════════
// 2. HTTPS / Security
// ══════════════════════════════════════════════════════════════════════════════
export async function captureGscHttpsAPI(siteUrl, auditId) {
    const result = { statut: 'ERROR', capture: null };
    try {
        const domain = new URL(siteUrl).hostname;
        const wm = webmastersClient();
        const siteUrlResolved = await resolveSiteUrl(wm, domain);

        // Check if site uses HTTPS (based on property type)
        const isHttps = siteUrlResolved.startsWith('https://') || siteUrlResolved.startsWith('sc-domain:');

        // Query search analytics to get a sample of pages to verify HTTPS
        const sc = searchConsoleClient();
        let httpsPages = 0;
        let totalPages = 0;

        try {
            const { data } = await sc.searchanalytics.query({
                siteUrl: siteUrlResolved,
                requestBody: {
                    startDate: dateDaysAgo(28),
                    endDate: dateDaysAgo(1),
                    dimensions: ['page'],
                    rowLimit: 100
                }
            });

            const pages = data.rows || [];
            totalPages = pages.length;
            httpsPages = pages.filter(p => p.keys[0].startsWith('https://')).length;
        } catch (e) {
            console.warn(`[GSC-API] HTTPS analytics check failed: ${e.message}`);
        }

        const allHttps = totalPages > 0 ? httpsPages === totalPages : isHttps;
        const html = renderHtmlStatus({
            title: 'HTTPS — Google Search Console',
            status: allHttps ? 'OK' : 'KO',
            icon: allHttps
                ? 'Toutes les pages sont en HTTPS'
                : `${httpsPages}/${totalPages} pages en HTTPS`,
            details: `Propriété : ${siteUrlResolved}`
        });

        result.capture = await renderAndUpload(html, `audit-results/gsc-https-${auditId}`);
        result.statut = 'SUCCESS';
    } catch (e) {
        result.details = e.message;
        console.error('[GSC-API] HTTPS error:', e.message);
    }
    return result;
}

// ══════════════════════════════════════════════════════════════════════════════
// 3. PERFORMANCE (Traffic) — returns multiple captures
// ══════════════════════════════════════════════════════════════════════════════
export async function captureGscPerformanceAPI(siteUrl, auditId) {
    const result = {
        statut: 'ERROR',
        capture1: null,
        capture2: null,
        clics: null,
        pagesIndexed: null,
        bestQueryCapture: null,
        queryPageClicksImpressionsCapture: null
    };

    try {
        const domain = new URL(siteUrl).hostname;
        const wm = webmastersClient();
        const sc = searchConsoleClient();
        const siteUrlResolved = await resolveSiteUrl(wm, domain);

        const startDate = dateDaysAgo(30);
        const endDate = dateDaysAgo(1);

        // -- Fetch aggregate metrics --
        console.log(`[GSC-API] Fetching performance for: ${siteUrlResolved}`);
        const { data: summaryData } = await sc.searchanalytics.query({
            siteUrl: siteUrlResolved,
            requestBody: { startDate, endDate }
        });

        const totalClicks = summaryData.rows?.[0]?.clicks || 0;
        const totalImpressions = summaryData.rows?.[0]?.impressions || 0;
        const avgCtr = summaryData.rows?.[0]?.ctr || 0;
        const avgPosition = summaryData.rows?.[0]?.position || 0;

        result.clics = formatNumber(totalClicks);

        // -- Capture 1: Summary metrics cards --
        const metricsHtml = renderHtmlMetricCards({
            title: 'Performance — Google Search Console',
            subtitle: `${new Date(startDate).toLocaleDateString('fr-FR')} — ${new Date(endDate).toLocaleDateString('fr-FR')}`,
            metrics: [
                { label: 'Clics totaux', value: formatNumber(totalClicks), color: '#1a73e8' },
                { label: 'Impressions', value: formatNumber(totalImpressions), color: '#9334e6' },
                { label: 'CTR moyen', value: formatPercent(avgCtr), color: '#0d904f' },
                { label: 'Position moyenne', value: formatPosition(avgPosition), color: '#e37400' }
            ]
        });
        result.capture1 = await renderAndUpload(metricsHtml, `audit-results/gsc-perf1-${auditId}`);

        // -- Fetch top queries --
        const { data: queryData } = await sc.searchanalytics.query({
            siteUrl: siteUrlResolved,
            requestBody: {
                startDate,
                endDate,
                dimensions: ['query'],
                rowLimit: 25
            }
        });

        const queryRows = (queryData.rows || []).map(r => [
            r.keys[0],
            formatNumber(r.clicks),
            formatNumber(r.impressions),
            formatPercent(r.ctr),
            formatPosition(r.position)
        ]);

        // -- Capture 2: Query table --
        if (queryRows.length > 0) {
            const queryTableHtml = renderHtmlTable({
                title: 'Top requêtes — Google Search Console',
                subtitle: `${queryRows.length} requêtes — ${new Date(startDate).toLocaleDateString('fr-FR')} au ${new Date(endDate).toLocaleDateString('fr-FR')}`,
                headers: ['Requête', 'Clics', 'Impressions', 'CTR', 'Position'],
                rows: queryRows
            });
            result.capture2 = await renderAndUpload(queryTableHtml, `audit-results/gsc-perf2-${auditId}`);
            result.queryPageClicksImpressionsCapture = result.capture2;

            // -- Best query capture (first row only) --
            const bestQueryHtml = renderHtmlTable({
                title: 'Meilleure requête — Google Search Console',
                headers: ['Requête', 'Clics', 'Impressions', 'CTR', 'Position'],
                rows: [queryRows[0]]
            });
            result.bestQueryCapture = await renderAndUpload(bestQueryHtml, `audit-results/gsc-best-query-${auditId}`);
        }

        result.statut = 'SUCCESS';
    } catch (e) {
        result.details = e.message;
        console.error('[GSC-API] Performance error:', e.message);
    }
    return result;
}

// ══════════════════════════════════════════════════════════════════════════════
// 4. COVERAGE (Pages Indexed)
// ══════════════════════════════════════════════════════════════════════════════
export async function captureGscCoverageAPI(siteUrl, auditId) {
    const result = {
        statut: 'ERROR',
        capture: null,
        pagesIndexed: null,
        indexationCapture: null,
        problemCapture: null
    };

    try {
        const domain = new URL(siteUrl).hostname;
        const wm = webmastersClient();
        const sc = searchConsoleClient();
        const siteUrlResolved = await resolveSiteUrl(wm, domain);

        // Use search analytics to count unique pages appearing in search (≈ indexed pages)
        console.log(`[GSC-API] Fetching coverage for: ${siteUrlResolved}`);
        const { data: pageData } = await sc.searchanalytics.query({
            siteUrl: siteUrlResolved,
            requestBody: {
                startDate: dateDaysAgo(90),
                endDate: dateDaysAgo(1),
                dimensions: ['page'],
                rowLimit: 5000
            }
        });

        const indexedPages = pageData.rows || [];
        const indexedCount = indexedPages.length;
        result.pagesIndexed = String(indexedCount);

        console.log(`[GSC-API] Pages appearing in search: ${indexedCount}`);

        // -- Capture: Indexation summary --
        const metricsHtml = renderHtmlMetricCards({
            title: 'Indexation — Google Search Console',
            subtitle: `Propriété : ${siteUrlResolved} — 90 derniers jours`,
            metrics: [
                { label: 'Pages dans les résultats de recherche', value: formatNumber(indexedCount), color: '#0d904f' }
            ]
        });
        result.capture = await renderAndUpload(metricsHtml, `audit-results/gsc-coverage-${auditId}`);
        result.indexationCapture = result.capture;

        // -- Try URL Inspection for a sample to check indexation problems --
        const sampleUrls = indexedPages.slice(0, 5).map(r => r.keys[0]);
        const problems = [];

        for (const inspectUrl of sampleUrls) {
            try {
                const { data: inspection } = await sc.urlInspection.index.inspect({
                    requestBody: {
                        inspectionUrl: inspectUrl,
                        siteUrl: siteUrlResolved
                    }
                });
                const verdict = inspection.inspectionResult?.indexStatusResult?.verdict;
                const coverageState = inspection.inspectionResult?.indexStatusResult?.coverageState;
                if (verdict && verdict !== 'PASS') {
                    problems.push({
                        url: inspectUrl,
                        verdict,
                        reason: coverageState || 'Unknown'
                    });
                }
            } catch (e) {
                console.warn(`[GSC-API] URL Inspection failed for ${inspectUrl}: ${e.message}`);
                break; // Stop if quota exceeded
            }
        }

        if (problems.length > 0) {
            const problemHtml = renderHtmlTable({
                title: 'Problèmes d\'indexation détectés',
                subtitle: `Échantillon de ${sampleUrls.length} URLs inspectées`,
                headers: ['URL', 'Verdict', 'Raison'],
                rows: problems.map(p => [p.url, p.verdict, p.reason])
            });
            result.problemCapture = await renderAndUpload(problemHtml, `audit-results/gsc-coverage-problems-${auditId}`);
        } else {
            const okHtml = renderHtmlStatus({
                title: 'Problèmes d\'indexation — Google Search Console',
                status: 'OK',
                icon: 'Aucun problème d\'indexation détecté',
                details: `${sampleUrls.length} URLs inspectées — toutes indexées correctement`
            });
            result.problemCapture = await renderAndUpload(okHtml, `audit-results/gsc-coverage-problems-${auditId}`);
        }

        result.statut = 'SUCCESS';
    } catch (e) {
        result.details = e.message;
        console.error('[GSC-API] Coverage error:', e.message);
    }
    return result;
}

// ══════════════════════════════════════════════════════════════════════════════
// 5. TOP PAGES (Meilleures pages)
// ══════════════════════════════════════════════════════════════════════════════
export async function captureGscTopPagesAPI(siteUrl, auditId) {
    const result = { statut: 'ERROR', capture: null };
    try {
        const domain = new URL(siteUrl).hostname;
        const wm = webmastersClient();
        const sc = searchConsoleClient();
        const siteUrlResolved = await resolveSiteUrl(wm, domain);

        console.log(`[GSC-API] Fetching top pages for: ${siteUrlResolved}`);
        const { data } = await sc.searchanalytics.query({
            siteUrl: siteUrlResolved,
            requestBody: {
                startDate: dateDaysAgo(30),
                endDate: dateDaysAgo(1),
                dimensions: ['page'],
                rowLimit: 20
            }
        });

        const pages = data.rows || [];
        if (pages.length === 0) {
            const html = renderHtmlStatus({
                title: 'Meilleures pages — Google Search Console',
                status: 'KO',
                icon: 'Aucune page avec du trafic',
                details: `Propriété : ${siteUrlResolved}`
            });
            result.capture = await renderAndUpload(html, `audit-results/gsc-top-pages-${auditId}`);
            result.statut = 'SUCCESS';
            return result;
        }

        const headers = ['Page', 'Clics', 'Impressions', 'CTR', 'Position'];
        const rows = pages.map(r => {
            // Shorten URL for display
            let pageUrl = r.keys[0];
            try {
                const u = new URL(pageUrl);
                pageUrl = u.pathname + (u.search || '');
            } catch { }

            return [
                pageUrl,
                formatNumber(r.clicks),
                formatNumber(r.impressions),
                formatPercent(r.ctr),
                formatPosition(r.position)
            ];
        });

        const html = renderHtmlTable({
            title: 'Meilleures pages — Google Search Console',
            subtitle: `${pages.length} pages — 30 derniers jours`,
            headers,
            rows
        });

        result.capture = await renderAndUpload(html, `audit-results/gsc-top-pages-${auditId}`);
        result.statut = 'SUCCESS';
    } catch (e) {
        result.details = e.message;
        console.error('[GSC-API] Top Pages error:', e.message);
    }
    return result;
}
