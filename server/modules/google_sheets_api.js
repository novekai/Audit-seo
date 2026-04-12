import { google } from "googleapis";
import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import sharp from "sharp";

import { uploadToCloudinary } from "../utils/cloudinary.js";

/**
 * =========================
 * CONFIG CAPTURES (2 SHEETS)
 * - target: "audit" | "plan"
 * - mode: 
 *    - "transform": API lit + filtre/tri/colonnes => rendu HTML
 *    - "raw": API lit brut => rendu HTML (avec trimming colonnes vides)
 * - skipIfEmpty: si true et aucun match => SKIP (pas de capture)
 * =========================
 */
const CAPTURE_CONFIGS = [
    // ===== SHEET AUDIT =====
    {
        airtableField: "Img_Poids_image",
        target: "audit",
        mode: "transform",
        tabName: "Images",
        keep: [
            { label: "Destination", matchAny: ["destination"] },
            { label: "Taille (octets)", matchAny: ["taille", "octet", "bytes"] },
        ],
        where: { colMatchAny: ["taille", "octet", "bytes"], op: "bytes_gte", value: 100000 },
        sort: { colMatchAny: ["taille", "octet", "bytes"], type: "bytes", order: "desc" },
        limitRows: 15,
        skipIfEmpty: true,
    },

    { airtableField: "Img_meme_title", target: "audit", mode: "raw", tabName: "Même title" },
    { airtableField: "Img_meta_description_double", target: "audit", mode: "raw", tabName: "Même balise meta desc" },
    { airtableField: "Img_balise_h1_double", target: "audit", mode: "raw", tabName: "Doublons H1" },

    {
        airtableField: "Img_balise_h1_absente",
        target: "audit",
        mode: "transform",
        tabName: "Balises H1-H6",
        keep: [{ label: "URL", matchAny: ["url"] }, { label: "H1 absente", matchAny: ["h1 absente"] }],
        where: { colMatchAny: ["h1 absente"], op: "equals_ci", value: "oui" },
        limitRows: 15,
        skipIfEmpty: true,
    },
    {
        airtableField: "Img_que des H1 vides",
        target: "audit",
        mode: "transform",
        tabName: "Balises H1-H6",
        keep: [{ label: "URL", matchAny: ["url"] }, { label: "que des H1 vides", matchAny: ["que des h1 vides"] }],
        where: { colMatchAny: ["que des h1 vides"], op: "equals_ci", value: "oui" },
        limitRows: 15,
        skipIfEmpty: true,
    },
    {
        airtableField: "Img_au moins une H1 vide",
        target: "audit",
        mode: "transform",
        tabName: "Balises H1-H6",
        keep: [{ label: "URL", matchAny: ["url"] }, { label: "au moins une H1 vide", matchAny: ["au moins une h1 vide"] }],
        where: { colMatchAny: ["au moins une h1 vide"], op: "equals_ci", value: "oui" },
        limitRows: 15,
        skipIfEmpty: true,
    },
    {
        airtableField: "Img_1ère balise Hn n'est pas H1",
        target: "audit",
        mode: "transform",
        tabName: "Balises H1-H6",
        keep: [{ label: "URL", matchAny: ["url"] }, { label: "1ère balise Hn n'est pas H1", matchAny: ["1ere balise hn", "pas h1", "n'est pas h1"] }],
        where: { colMatchAny: ["1ere balise hn", "pas h1", "n'est pas h1"], op: "equals_ci", value: "oui" },
        limitRows: 15,
        skipIfEmpty: true,
    },
    {
        airtableField: "Img_Sauts de niveau entre les Hn",
        target: "audit",
        mode: "transform",
        tabName: "Balises H1-H6",
        keep: [{ label: "URL", matchAny: ["url"] }, { label: "Sauts de niveau entre les Hn", matchAny: ["sauts de niveau"] }],
        where: { colMatchAny: ["sauts de niveau"], op: "number_not_zero" },
        sort: { colMatchAny: ["sauts de niveau"], type: "number", order: "desc" },
        limitRows: 15,
        skipIfEmpty: true,
    },
    {
        airtableField: "Img_Hn trop longue",
        target: "audit",
        mode: "transform",
        tabName: "Balises H1-H6",
        keep: [{ label: "URL", matchAny: ["url"] }, { label: "Hn trop longue", matchAny: ["hn trop longue"] }],
        where: { colMatchAny: ["hn trop longue"], op: "number_eq", value: 1 },
        sort: { colMatchAny: ["hn trop longue"], type: "number", order: "desc" },
        limitRows: 15,
        skipIfEmpty: true,
    },

    {
        airtableField: "Img_longeur_page",
        target: "audit",
        mode: "transform",
        tabName: "Nb mots body",
        keep: "ALL",
        sort: { colMatchAny: ["gravité", "gravite", "gravite du probleme"], type: "number", order: "desc" },
        limitRows: 15,
        skipIfEmpty: true,
    },

    {
        airtableField: "Img_meta_description",
        target: "audit",
        mode: "transform",
        tabName: "Meta desc",
        keep: [{ label: "URL", matchAny: ["url"] }, { label: "Nb de caractères", matchAny: ["nb de caracteres", "caractere", "caracter"] }],
        where: { colMatchAny: ["nb de caracteres", "caractere", "caracter"], op: "number_eq", value: 0 },
        sort: { colMatchAny: ["nb de caracteres", "caractere", "caracter"], type: "number", order: "asc" },
        limitRows: 15,
        skipIfEmpty: true,
    },

    {
        airtableField: "Img_balises_title",
        target: "audit",
        mode: "transform",
        tabName: "Balise title",
        keep: [{ label: "URL", matchAny: ["url"] }, { label: "État balise title", matchAny: ["etat", "état", "status"] }],
        where: { colMatchAny: ["etat", "état", "status"], op: "includes_ci", value: "trop longue" },
        limitRows: 15,
        skipIfEmpty: true,
    },

    // ===== SHEET PLAN D'ACTION =====
    { airtableField: "Img_planD'action", target: "plan", mode: "raw", tabName: "Synthèse Audit - Plan d'action", skipIfEmpty: true },
    { airtableField: "Img_Requetes_cles", target: "plan", mode: "raw", tabName: "Requêtes Clés / Calédito", skipIfEmpty: true },
    { airtableField: "Img_donnee_image", target: "plan", mode: "raw", tabName: "Données Images", skipIfEmpty: true },
    { airtableField: "Img_longeur_page_plan", target: "plan", mode: "raw", tabName: "Longueur de page", skipIfEmpty: true },
];

/**
 * =========================
 * GOOGLE SHEETS CLIENT (OAuth refresh_token)
 * =========================
 */
function sheetsClient(refreshToken) {
    const oauth2 = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET);
    const effectiveRefreshToken = refreshToken || process.env.GOOGLE_REFRESH_TOKEN;
    if (!effectiveRefreshToken) {
        throw new Error("Aucun compte Google connecté pour lire les Google Sheets.");
    }
    oauth2.setCredentials({ refresh_token: effectiveRefreshToken });
    return google.sheets({ version: "v4", auth: oauth2 });
}

function extractSpreadsheetId(url) {
    if (!url) return null;
    const m = String(url).match(/\/d\/([a-zA-Z0-9-_]+)/);
    return m ? m[1] : null;
}

function buildGoogleSheetReconnectMessage() {
    return "Le compte Google n'est plus connecté à l'application. Reconnectez le bon compte Google dans les paramètres, puis relancez l'audit.";
}

function buildGoogleSheetAccessMessage() {
    return "Le compte Google connecté n'a pas accès à ce Google Sheet. Connectez le bon compte Google ou partagez ce document avec ce compte, puis relancez l'audit.";
}

function normalizeSheetsErrorMessage(error, tabName) {
    const rawMessage = String(
        error?.response?.data?.error?.message ||
        error?.response?.data?.error ||
        error?.message ||
        ''
    ).trim();
    const normalized = rawMessage.toLowerCase();

    if (
        !rawMessage ||
        /no google refresh token available|invalid_grant|invalid credentials|login required|unauthorized|auth/i.test(normalized)
    ) {
        return buildGoogleSheetReconnectMessage();
    }

    if (
        error?.code === 401 ||
        error?.code === 403 ||
        /permission|forbidden|access denied|insufficient/i.test(normalized)
    ) {
        return buildGoogleSheetAccessMessage();
    }

    if (
        error?.code === 404 ||
        /unable to parse range|requested entity was not found|not found/i.test(normalized)
    ) {
        return `Le Google Sheet ou l'onglet "${tabName}" est introuvable. Vérifiez le lien du document et le nom de l'onglet, puis relancez l'audit.`;
    }

    return `Impossible de lire l'onglet "${tabName}" dans Google Sheets. Vérifiez que le bon compte Google est connecté et qu'il a accès à ce document, puis relancez l'audit.`;
}

function norm(s) {
    return String(s ?? "")
        .trim()
        .toLowerCase()
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .replace(/\s+/g, " ");
}

function toFloatAny(v) {
    const s = String(v ?? "").trim();
    if (!s) return NaN;
    return parseFloat(s.replace(/\s/g, "").replace(",", "."));
}

function toBytes(v) {
    const raw = String(v ?? "").trim();
    if (!raw) return NaN;
    const s = raw.toLowerCase().replace(/\s/g, "").replace(",", ".");
    const n = parseFloat(s);
    if (!Number.isFinite(n)) return NaN;
    if (s.includes("mo") || s.includes("mb")) return n * 1024 * 1024;
    if (s.includes("ko") || s.includes("kb")) return n * 1024;
    return n;
}

function findColIndex(headers, matchAny) {
    const H = headers.map(norm);
    const targets = (matchAny || []).map(norm);
    for (let i = 0; i < H.length; i++) {
        for (const t of targets) if (t && H[i].includes(t)) return i;
    }
    return -1;
}

async function readTab(sheets, spreadsheetId, tabName) {
    try {
        const res = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: `'${tabName.replace(/'/g, "''")}'!A1:ZZ`,
            valueRenderOption: "FORMATTED_VALUE",
        });
        return { values: res?.data?.values || [], found: true };
    } catch (e) {
        const userMessage = normalizeSheetsErrorMessage(e, tabName);
        console.error(`[SHEETS-API] Erreur lecture onglet "${tabName}": ${e.message}`);
        return { values: [], found: false, error: userMessage };
    }
}

/**
 * Trim colonnes vides à droite (pour éviter images avec 80% de blanc)
 */
function trimEmptyColumns(values) {
    if (!values.length) return values;
    const rows = values;
    const maxCols = Math.max(...rows.map((r) => r.length));
    let lastUsed = -1;

    for (let c = 0; c < maxCols; c++) {
        const used = rows.some((r) => String(r[c] ?? "").trim() !== "");
        if (used) lastUsed = c;
    }
    if (lastUsed < 0) return [["(vide)"]];
    return rows.map((r) => r.slice(0, lastUsed + 1));
}

function padRow(row, width) {
    return Array.from({ length: width }, (_, index) => String(row?.[index] ?? ""));
}

function countNonEmptyCells(row) {
    return (row || []).filter((cell) => String(cell ?? "").trim() !== "").length;
}

function buildRawTableModel(values) {
    const rows = values.filter((row) => row.some((cell) => String(cell ?? "").trim() !== ""));
    if (rows.length === 0) return null;

    const width = Math.max(1, ...rows.map((row) => row.length));
    const firstRow = rows[0] || [];
    const secondRow = rows[1] || [];
    const hasMergedBanner =
        rows.length >= 2 &&
        countNonEmptyCells(firstRow) === 1 &&
        countNonEmptyCells(secondRow) > 1;

    if (hasMergedBanner) {
        const bannerTitle = firstRow.find((cell) => String(cell ?? "").trim() !== "") || "";
        return {
            table: [padRow(secondRow, width), ...rows.slice(2).map((row) => padRow(row, width))],
            bannerTitle
        };
    }

    return {
        table: rows.map((row) => padRow(row, width)),
        bannerTitle: null
    };
}

function applyWhere(cell, where) {
    const v = String(cell ?? "").trim();
    if (!where) return true;

    switch (where.op) {
        case "equals_ci":
            return norm(v) === norm(where.value);
        case "includes_ci":
            return norm(v).includes(norm(where.value));
        case "number_eq": {
            const n = toFloatAny(v);
            return Number.isFinite(n) && n === Number(where.value);
        }
        case "number_not_zero": {
            const n = toFloatAny(v);
            return Number.isFinite(n) && n !== 0;
        }
        case "bytes_gte": {
            const b = toBytes(v);
            return Number.isFinite(b) && b >= Number(where.value);
        }
        default:
            return true;
    }
}

function sortRows(rows, colIdx, sort) {
    if (!sort || colIdx < 0) return rows;
    const dir = sort.order === "asc" ? 1 : -1;

    const keyFn =
        sort.type === "bytes"
            ? (r) => toBytes(r[colIdx])
            : sort.type === "number"
                ? (r) => toFloatAny(r[colIdx])
                : (r) => norm(r[colIdx]);

    return rows.slice().sort((a, b) => {
        const ka = keyFn(a);
        const kb = keyFn(b);
        const va = Number.isFinite(ka) ? ka : -Infinity;
        const vb = Number.isFinite(kb) ? kb : -Infinity;
        if (va < vb) return -1 * dir;
        if (va > vb) return 1 * dir;
        return 0;
    });
}

function buildTable(values, cfg, { found = true, error = null } = {}) {
    if (!values || values.length === 0) {
        if (!found && error) {
            return { table: null, reason: error };
        }
        return { table: null, reason: found ? "Onglet vide — aucune donnée dans cet onglet" : `Onglet "${cfg.tabName}" introuvable dans le Google Sheet` };
    }

    const trimmed = trimEmptyColumns(values);
    const header = trimmed[0] || [];
    const data = trimmed.slice(1);

    // RAW = juste trimming colonnes + return
    if (cfg.mode === "raw") {
        const rawTable = buildRawTableModel(trimmed);
        if (!rawTable?.table?.length) return { table: null, reason: "Aucune donnée" };
        return rawTable;
    }

    // TRANSFORM
    let keepIdx = [];
    let outHeader = [];

    if (cfg.keep === "ALL") {
        keepIdx = header.map((_, i) => i);
        outHeader = header;
    } else {
        for (const col of cfg.keep) {
            const idx = findColIndex(header, col.matchAny);
            keepIdx.push(idx);
            outHeader.push(idx >= 0 ? header[idx] : col.label);
        }
    }

    const whereIdx = cfg.where ? findColIndex(header, cfg.where.colMatchAny) : -1;
    let rows = data
        .filter((r) => r.some((c) => String(c ?? "").trim() !== ""))
        .filter((r) => (cfg.where ? (whereIdx >= 0 ? applyWhere(r[whereIdx], cfg.where) : false) : true));

    if (rows.length === 0) {
        return cfg.skipIfEmpty ? { table: null, reason: "Aucun match pour le filtre" } : { table: [outHeader] };
    }

    const sortIdx = cfg.sort ? findColIndex(header, cfg.sort.colMatchAny) : -1;
    rows = sortRows(rows, sortIdx, cfg.sort);

    if (cfg.limitRows) rows = rows.slice(0, cfg.limitRows);

    const projected = rows.map((r) => keepIdx.map((i) => (i >= 0 ? r[i] ?? "" : "")));
    return { table: [outHeader, ...projected] };
}

function renderHtmlTable({ table, bannerTitle = null }) {
    const headers = table[0] || [];
    const rows = table.slice(1);
    const sheetLike = Boolean(bannerTitle);

    const ths = headers
        .map((h) => `<th>${escapeHtml(String(h ?? ""))}</th>`)
        .join("");

    const trs = rows
        .map((r) => {
            const tds = headers
                .map((_, i) => {
                    const val = String(r[i] ?? "");
                    // Detect URLs and make them blue like Google Sheets
                    if (/^https?:\/\//i.test(val.trim())) {
                        return `<td><span style="color:#1155cc;">${escapeHtml(val)}</span></td>`;
                    }
                    return `<td>${escapeHtml(val)}</td>`;
                })
                .join("");
            return `<tr>${tds}</tr>`;
        })
        .join("");

    return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8"/>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #fff; }
  .wrap {
    display: inline-block;
    padding: 0;
    font-family: Arial, Helvetica, sans-serif;
    font-size: 11px;
  }
  .sheet-banner {
    background: #1f4e79;
    color: #fff;
    padding: 10px 14px;
    font-size: 13px;
    font-weight: 700;
    text-align: center;
    border: 1px solid #1f4e79;
    border-bottom: 0;
  }
  table {
    border-collapse: collapse;
    table-layout: ${sheetLike ? "fixed" : "auto"};
    width: ${sheetLike ? "1520px" : "auto"};
  }
  thead th {
    background: ${sheetLike ? "#1f4e79" : "#f3f3f3"};
    border: 1px solid #e2e2e2;
    padding: 3px 8px;
    font-size: 11px;
    font-weight: 700;
    color: ${sheetLike ? "#fff" : "#333"};
    text-align: left;
    white-space: ${sheetLike ? "normal" : "nowrap"};
  }
  tbody td {
    border: 1px solid #e2e2e2;
    padding: ${sheetLike ? "6px 8px" : "2px 8px"};
    font-size: 11px;
    color: #333;
    vertical-align: top;
    white-space: ${sheetLike ? "normal" : "nowrap"};
    max-width: ${sheetLike ? "320px" : "700px"};
    overflow: hidden;
    text-overflow: ellipsis;
    line-height: ${sheetLike ? "1.35" : "1.2"};
  }
  tbody tr:nth-child(even) td { background: #f8f9fa; }
  tbody tr:nth-child(odd) td { background: #fff; }
</style>
</head>
<body>
  <div class="wrap" id="capture">
    ${bannerTitle ? `<div class="sheet-banner">${escapeHtml(bannerTitle)}</div>` : ""}
    <table>
      <thead><tr>${ths}</tr></thead>
      <tbody>${trs}</tbody>
    </table>
  </div>
</body>
</html>`;
}

function escapeHtml(s) {
    return s
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

function renderOkStatusHtml(title) {
    return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8"/>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #fff; }
  .wrap {
    display: inline-block;
    padding: 28px 38px;
    font-family: Arial, Helvetica, sans-serif;
  }
  .card {
    border: 2px solid #22c55e;
    border-radius: 12px;
    padding: 22px 32px;
    background: #f0fdf4;
    min-width: 420px;
  }
  .title {
    font-size: 15px;
    font-weight: 700;
    color: #166534;
    margin-bottom: 6px;
  }
  .msg {
    font-size: 13px;
    color: #15803d;
  }
</style>
</head>
<body>
  <div class="wrap" id="capture">
    <div class="card">
      <div class="title">${escapeHtml(title)}</div>
      <div class="msg">Aucun probleme detecte sur ce critere.</div>
    </div>
  </div>
</body>
</html>`;
}

async function htmlToPng(html, outPath) {
    const browser = await chromium.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    try {
        const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
        await page.setContent(html, { waitUntil: "load" });

        const el = page.locator("#capture");
        await el.waitFor({ state: "visible", timeout: 15000 });

        await el.screenshot({ path: outPath });

        // Trim automatique des marges blanches éventuelles
        const buf = await sharp(outPath).trim().toBuffer();
        fs.writeFileSync(outPath, buf);
    } finally {
        await browser.close();
    }
}

/**
 * =========================
 * POINT D'ENTRÉE DU MODULE
 * =========================
 */
export async function auditGoogleSheetsAPI(sheetAuditUrl, sheetPlanUrl, auditId, options = {}) {
    const auditSpreadsheetId = extractSpreadsheetId(sheetAuditUrl);
    const planSpreadsheetId = extractSpreadsheetId(sheetPlanUrl);
    const allowedTargets = Array.isArray(options.targets) && options.targets.length
        ? new Set(options.targets)
        : null;
    const allowedFields = Array.isArray(options.fields) && options.fields.length
        ? new Set(options.fields)
        : null;

    if (!auditSpreadsheetId && !planSpreadsheetId) {
        console.error("[SHEETS-API] URL de Google Sheet invalide.");
        return { error: "URL de Google Sheet invalide." };
    }

    const sheets = sheetsClient(options.refreshToken);
    const results = {};

    console.log(`[SHEETS-API] Démarrage (Audit: ${auditSpreadsheetId}, Plan: ${planSpreadsheetId || 'N/A'})`);

    for (const cfg of CAPTURE_CONFIGS) {
        if (allowedTargets && !allowedTargets.has(cfg.target)) {
            continue;
        }
        if (allowedFields && !allowedFields.has(cfg.airtableField)) {
            continue;
        }

        const spreadsheetId = cfg.target === "audit" ? auditSpreadsheetId : planSpreadsheetId;
        if (!spreadsheetId) continue;

        try {
            const { values, found, error } = await readTab(sheets, spreadsheetId, cfg.tabName);
            const built = buildTable(values, cfg, { found, error });

            if (!built.table) {
                // Tab found but no matching rows → generate "OK" capture instead of skipping
                if (found && cfg.skipIfEmpty) {
                    console.log(`[SHEETS-API] Aucun problème trouvé pour ${cfg.airtableField} (${cfg.tabName}) — génération capture OK`);
                    const okHtml = renderOkStatusHtml(`${cfg.tabName} — Aucun problème`);
                    const tmpDir = process.env.RAILWAY_ENVIRONMENT ? "/tmp" : ".";
                    const pngPath = path.join(tmpDir, `sheet_${cfg.airtableField}_ok_${uuidv4()}.png`);
                    await htmlToPng(okHtml, pngPath);
                    const cloudinaryUrl = await uploadToCloudinary(pngPath, `audit-results/${auditId}`);
                    if (fs.existsSync(pngPath)) fs.unlinkSync(pngPath);
                    results[cfg.airtableField] = {
                        statut: "SUCCESS",
                        capture: cloudinaryUrl?.secure_url || cloudinaryUrl?.url || cloudinaryUrl,
                        details: built.reason || "Aucun problème détecté"
                    };
                } else {
                    results[cfg.airtableField] = { statut: "SKIP", details: built.reason || "Aucune donnée" };
                }
                continue;
            }

            console.log(`[SHEETS-API] Rendu HTML pour ${cfg.airtableField} (${cfg.tabName})`);
            const html = renderHtmlTable({
                table: built.table,
                bannerTitle: built.bannerTitle,
            });

            const tmpDir = process.env.RAILWAY_ENVIRONMENT ? "/tmp" : ".";
            const pngPath = path.join(tmpDir, `sheet_${cfg.airtableField}_${uuidv4()}.png`);

            await htmlToPng(html, pngPath);

            const cloudinaryUrl = await uploadToCloudinary(
                pngPath,
                `audit-results/${auditId}`
            );

            if (fs.existsSync(pngPath)) fs.unlinkSync(pngPath);

            results[cfg.airtableField] = {
                statut: "SUCCESS",
                capture: cloudinaryUrl?.secure_url || cloudinaryUrl?.url || cloudinaryUrl,
                details: `${built.table.length - 1} lignes.`
            };
        } catch (e) {
            console.error(`[SHEETS-API] Erreur sur ${cfg.airtableField}: ${e.message}`);
            results[cfg.airtableField] = { statut: "FAILED", details: e.message };
        }
    }

    return results;
}
