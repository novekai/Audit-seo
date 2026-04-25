import { google } from 'googleapis';

// ─── Structure "Synthèse Audit - Plan d'action" (9 colonnes) ───
const SYNTHESE_HEADERS = [
    'N°',
    'Catégorie',
    'Sous-catégorie',
    'Sujet',
    'Conforme ?',
    'Remarque(s)',
    'Action suggérée',
    'Priorité',
    'Statut'
];

const PLAN_SOURCE_TAB_NAMES = [
    "Synthèse Audit - Plan d'action",
    'Contenu',
    'Requêtes Clés / Calédito',
    'Données Images',
    'Longueur de page',
    'Qualité des pages'
];

const AUDIT_RULE_TABS = [
    'Images',
    'Balise title',
    'Meta desc',
    'Doublons H1',
    'Balises H1-H6',
    'Nb mots body'
];

const ACTION_PLAN_OUTPUT_TAB_CONFIGS = [
    {
        sourceTabName: 'Contenu',
        targetTitle: 'Contenu',
        airtableField: 'Lien_contenu'
    },
    {
        sourceTabName: 'Données Images',
        targetTitle: 'Analyse Images',
        airtableField: 'Lien_analyse_image'
    },
    {
        sourceTabName: 'Longueur de page',
        targetTitle: 'Longueur de page',
        airtableField: 'Lien_longueur_page'
    },
    {
        sourceTabName: 'Qualité des pages',
        targetTitle: 'Qualité des pages',
        airtableField: 'Lien_qualite_des_pages'
    }
];

// ─── Google Auth & Sheets ───

function createGoogleAuth() {
    if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !process.env.GOOGLE_REFRESH_TOKEN) {
        throw new Error('Les accès Google Sheets ne sont pas configurés côté backend.');
    }

    const oauth2 = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET
    );

    oauth2.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
    return oauth2;
}

function createSheetsClient(auth) {
    return google.sheets({ version: 'v4', auth });
}

function extractSpreadsheetId(url) {
    if (!url) return null;
    const match = String(url).match(/\/d\/([a-zA-Z0-9-_]+)/);
    return match ? match[1] : null;
}

function buildGoogleSheetRangeUrl(spreadsheetId, sheetId, range = 'A1') {
    return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=${sheetId}&range=${encodeURIComponent(range)}`;
}

function buildA1Range(sheetTitle, range) {
    return `'${String(sheetTitle).replace(/'/g, "''")}'!${range}`;
}

// ─── Utilitaires texte & données ───

function normalizeText(value) {
    return String(value ?? '')
        .trim()
        .toLowerCase()
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
        .replace(/\s+/g, ' ');
}

function sanitizeSheetTitle(title, usedTitles = new Set()) {
    const cleaned = String(title || 'Onglet')
        .replace(/[\[\]\*\/\\\?\:]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 100) || 'Onglet';

    let candidate = cleaned;
    let suffix = 2;

    while (usedTitles.has(candidate)) {
        const base = cleaned.slice(0, Math.max(1, 100 - String(suffix).length - 1)).trim();
        candidate = `${base} ${suffix}`;
        suffix += 1;
    }

    usedTitles.add(candidate);
    return candidate;
}

function trimValues(values, maxRows = 400, maxCols = 16) {
    if (!Array.isArray(values) || values.length === 0) {
        return [];
    }

    return values
        .slice(0, maxRows)
        .map((row) => (Array.isArray(row) ? row.slice(0, maxCols) : [String(row ?? '')]));
}

async function readSheetValues(sheets, spreadsheetId, tabName) {
    try {
        const response = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range: `'${tabName.replace(/'/g, "''")}'!A1:Z400`,
            valueRenderOption: 'FORMATTED_VALUE'
        });

        return trimValues(response.data.values || []);
    } catch (err) {
        console.warn(`[ACTION PLAN] Impossible de lire l'onglet "${tabName}": ${err.message}`);
        return [];
    }
}

function getHeaders(values) {
    return Array.isArray(values) && values.length > 0 ? values[0] : [];
}

function getRows(values) {
    return Array.isArray(values) && values.length > 1
        ? values.slice(1).filter((row) => row.some((cell) => String(cell ?? '').trim() !== ''))
        : [];
}

function findColIndex(headers, matchAny) {
    const normalizedHeaders = headers.map(normalizeText);
    const targets = (matchAny || []).map(normalizeText);

    for (let i = 0; i < normalizedHeaders.length; i += 1) {
        for (const target of targets) {
            if (target && normalizedHeaders[i].includes(target)) {
                return i;
            }
        }
    }

    return -1;
}

function parseNumber(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return NaN;
    const cleaned = raw.replace(/\s/g, '').replace(',', '.');
    const match = cleaned.match(/-?\d+(\.\d+)?/);
    return match ? Number(match[0]) : NaN;
}

function toBytes(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return NaN;
    const normalized = raw.toLowerCase().replace(/\s/g, '').replace(',', '.');
    const number = parseNumber(normalized);

    if (!Number.isFinite(number)) {
        return NaN;
    }

    if (normalized.includes('mo') || normalized.includes('mb')) {
        return number * 1024 * 1024;
    }

    if (normalized.includes('ko') || normalized.includes('kb')) {
        return number * 1024;
    }

    return number;
}

function countMatchingRows(values, predicate) {
    return getRows(values).filter((row) => {
        try {
            return predicate(row);
        } catch {
            return false;
        }
    }).length;
}

// ─── Helpers de résultat d'audit ───

function formatPriority(level) {
    switch (level) {
        case 'importante': return '🔑🔑🔑 Importante';
        case 'moyenne': return '🔑🔑 Moyenne';
        case 'faible': return '🔑 Faible';
        default: return 'RAS';
    }
}

function conforme(remark = 'RAS') {
    return { conformity: 'Oui', remark, action: 'RAS', priority: 'RAS', status: 'RAS' };
}

function nonConforme(remark, action, priority = 'importante') {
    return { conformity: 'Non', remark, action, priority: formatPriority(priority), status: 'À traiter' };
}

function amelioration(remark, action, priority = 'moyenne') {
    return { conformity: 'Amélioration possible', remark, action, priority: formatPriority(priority), status: 'À traiter' };
}

function nonConcerne(remark = 'RAS') {
    return { conformity: 'Non concerné', remark, action: 'RAS', priority: 'RAS', status: 'RAS' };
}

function nonVerifie(remark = 'Données non disponibles.') {
    return { conformity: 'Non vérifié', remark, action: 'RAS', priority: 'RAS', status: 'RAS' };
}

// ─── Définition des points d'audit ───

const AUDIT_CHECKS = [
    // ══════════ TECHNIQUE — Images ══════════
    {
        category: 'Technique',
        subcategory: 'Images',
        subject: 'Les images du site sont optimisées en termes de poids (< 100 Ko).',
        evaluate: (vbt) => {
            const values = vbt['Images'];
            if (!values || values.length <= 1) return nonVerifie('Onglet "Images" non disponible.');
            const headers = getHeaders(values);
            const sizeIdx = findColIndex(headers, ['taille', 'octet', 'bytes', 'poids']);
            const total = getRows(values).length;
            if (sizeIdx < 0) return nonVerifie('Colonne de taille non trouvée dans l\'onglet Images.');
            const heavy = countMatchingRows(values, (r) => toBytes(r[sizeIdx]) >= 100000);
            if (heavy === 0) return conforme();
            if (heavy > Math.ceil(total * 0.3)) {
                return nonConforme(
                    `${heavy}/${total} image(s) dépassent 100 Ko.`,
                    'Compresser ou redimensionner les images trop lourdes pour améliorer le temps de chargement.',
                    heavy > 10 ? 'importante' : 'moyenne'
                );
            }
            return amelioration(
                `${heavy} image(s) > 100 Ko sur ${total}.`,
                'Compresser les images concernées pour réduire le temps de chargement.',
                'moyenne'
            );
        }
    },

    // ══════════ CONTENU — SEO Texte et structure ══════════
    {
        category: 'Contenu',
        subcategory: 'SEO Texte et structure',
        subject: 'Les balises <title> sont de longueur adéquate sur chaque page.',
        evaluate: (vbt) => {
            const values = vbt['Balise title'];
            if (!values || values.length <= 1) return nonVerifie('Onglet "Balise title" non disponible.');
            const headers = getHeaders(values);
            const statusIdx = findColIndex(headers, ['etat balise title', 'etat', 'état', 'status']);
            const total = getRows(values).length;
            if (statusIdx < 0) return nonVerifie('Colonne d\'état non trouvée dans l\'onglet Balise title.');
            const tooLong = countMatchingRows(values, (r) => normalizeText(r[statusIdx]).includes('trop longue'));
            const tooShort = countMatchingRows(values, (r) => normalizeText(r[statusIdx]).includes('trop courte'));
            const issues = tooLong + tooShort;
            if (issues === 0) return conforme();
            const details = [];
            if (tooLong > 0) details.push(`${tooLong} trop longue(s)`);
            if (tooShort > 0) details.push(`${tooShort} trop courte(s)`);
            if (issues > Math.ceil(total * 0.5)) {
                return nonConforme(
                    `${issues}/${total} balise(s) title non conformes (${details.join(', ')}).`,
                    'Raccourcir ou compléter les balises title pour améliorer leur lisibilité dans les SERP.',
                    'importante'
                );
            }
            return amelioration(
                `${issues} balise(s) title à corriger sur ${total} (${details.join(', ')}).`,
                'Ajuster les balises title concernées pour respecter la longueur recommandée (50-60 caractères).',
                issues > 5 ? 'importante' : 'moyenne'
            );
        }
    },
    {
        category: 'Contenu',
        subcategory: 'SEO Texte et structure',
        subject: 'Chaque page possède une meta description renseignée et de longueur adéquate.',
        evaluate: (vbt) => {
            const values = vbt['Meta desc'];
            if (!values || values.length <= 1) return nonVerifie('Onglet "Meta desc" non disponible.');
            const headers = getHeaders(values);
            const countIdx = findColIndex(headers, ['nb de caracteres', 'caractere', 'caracter', 'longueur']);
            const total = getRows(values).length;
            if (countIdx < 0) return nonVerifie('Colonne de caractères non trouvée dans l\'onglet Meta desc.');
            const missing = countMatchingRows(values, (r) => parseNumber(r[countIdx]) === 0);
            if (missing === 0) return conforme();
            if (missing > Math.ceil(total * 0.5)) {
                return nonConforme(
                    `${missing}/${total} page(s) sans meta description.`,
                    'Rédiger des meta descriptions uniques et attractives (150-160 caractères) sur les pages concernées.',
                    'importante'
                );
            }
            return amelioration(
                `${missing} page(s) sans meta description sur ${total}.`,
                'Rédiger des meta descriptions pertinentes sur les pages concernées.',
                'moyenne'
            );
        }
    },
    {
        category: 'Contenu',
        subcategory: 'SEO Texte et structure',
        subject: 'Les balises H1 sont uniques sur chaque page (pas de doublons).',
        evaluate: (vbt) => {
            const values = vbt['Doublons H1'];
            if (!values || values.length <= 1) return conforme('Aucun doublon H1 détecté.');
            const count = getRows(values).length;
            if (count === 0) return conforme();
            return nonConforme(
                `${count} doublon(s) H1 détecté(s).`,
                'Attribuer un H1 unique et pertinent sur chaque page pour clarifier le sujet principal.',
                count > 5 ? 'importante' : 'moyenne'
            );
        }
    },
    {
        category: 'Contenu',
        subcategory: 'SEO Texte et structure',
        subject: 'Chaque page comporte une balise H1.',
        evaluate: (vbt) => {
            const values = vbt['Balises H1-H6'];
            if (!values || values.length <= 1) return nonVerifie('Onglet "Balises H1-H6" non disponible.');
            const headers = getHeaders(values);
            const h1Idx = findColIndex(headers, ['h1 absente']);
            if (h1Idx < 0) return nonVerifie('Colonne "H1 absente" non trouvée.');
            const missing = countMatchingRows(values, (r) => normalizeText(r[h1Idx]) === 'oui');
            if (missing === 0) return conforme();
            return nonConforme(
                `${missing} page(s) sans balise H1.`,
                'Ajouter une balise H1 pertinente contenant le mot-clé principal sur chaque page concernée.',
                'importante'
            );
        }
    },
    {
        category: 'Contenu',
        subcategory: 'SEO Texte et structure',
        subject: 'La première balise Hn de chaque page est un H1.',
        evaluate: (vbt) => {
            const values = vbt['Balises H1-H6'];
            if (!values || values.length <= 1) return nonVerifie('Onglet "Balises H1-H6" non disponible.');
            const headers = getHeaders(values);
            const idx = findColIndex(headers, ['1ere balise hn', '1ère balise hn', 'pas h1', "n'est pas h1"]);
            if (idx < 0) return nonVerifie('Colonne "1ère balise Hn" non trouvée.');
            const count = countMatchingRows(values, (r) => normalizeText(r[idx]) === 'oui');
            if (count === 0) return conforme();
            return amelioration(
                `${count} page(s) où la première balise Hn n'est pas un H1.`,
                'Réorganiser la hiérarchie des titres pour que le H1 soit la première balise de chaque page.',
                'moyenne'
            );
        }
    },
    {
        category: 'Contenu',
        subcategory: 'SEO Texte et structure',
        subject: 'Il n\'y a pas de sauts de niveaux dans la hiérarchie des balises Hn.',
        evaluate: (vbt) => {
            const values = vbt['Balises H1-H6'];
            if (!values || values.length <= 1) return nonVerifie('Onglet "Balises H1-H6" non disponible.');
            const headers = getHeaders(values);
            const idx = findColIndex(headers, ['sauts de niveau', 'saut']);
            if (idx < 0) return nonVerifie('Colonne "Sauts de niveau" non trouvée.');
            const count = countMatchingRows(values, (r) => parseNumber(r[idx]) > 0);
            if (count === 0) return conforme();
            return amelioration(
                `${count} page(s) avec des sauts de niveaux dans la hiérarchie Hn.`,
                'Corriger la hiérarchie des titres pour respecter l\'ordre H1 > H2 > H3, etc.',
                'faible'
            );
        }
    },
    {
        category: 'Contenu',
        subcategory: 'SEO Texte et structure',
        subject: 'Les balises Hn ne sont pas trop longues.',
        evaluate: (vbt) => {
            const values = vbt['Balises H1-H6'];
            if (!values || values.length <= 1) return nonVerifie('Onglet "Balises H1-H6" non disponible.');
            const headers = getHeaders(values);
            const idx = findColIndex(headers, ['hn trop longue', 'trop longue']);
            if (idx < 0) return nonVerifie('Colonne "Hn trop longue" non trouvée.');
            const count = countMatchingRows(values, (r) => parseNumber(r[idx]) >= 1);
            if (count === 0) return conforme();
            return amelioration(
                `${count} page(s) avec des balises Hn trop longues.`,
                'Raccourcir les titres Hn pour plus de clarté et d\'impact SEO.',
                'faible'
            );
        }
    },
    {
        category: 'Contenu',
        subcategory: 'SEO Texte et structure',
        subject: 'Le contenu des pages est suffisant (min. 350 mots).',
        evaluate: (vbt) => {
            const values = vbt['Nb mots body'];
            if (!values || values.length <= 1) return nonVerifie('Onglet "Nb mots body" non disponible.');
            const total = getRows(values).length;
            if (total === 0) return conforme();
            if (total > 5) {
                return nonConforme(
                    `${total} page(s) avec moins de 350 mots.`,
                    'Enrichir le contenu des pages concernées avec du texte pertinent intégrant le champ sémantique du sujet.',
                    'importante'
                );
            }
            return amelioration(
                `${total} page(s) avec un contenu insuffisant.`,
                'Ajouter du contenu pertinent comportant le champ sémantique et des termes de géolocalisation si applicable.',
                'moyenne'
            );
        }
    },
    {
        category: 'Contenu',
        subcategory: 'SEO Texte et structure',
        subject: 'Les pages sont alignées sur les requêtes stratégiques.',
        evaluate: (vbt) => {
            const contentValues = vbt['Contenu'];
            const queriesValues = contentValues && contentValues.length > 1
                ? contentValues
                : vbt['Requêtes Clés / Calédito'];
            if (!queriesValues || queriesValues.length <= 1) {
                return nonVerifie('Onglet "Contenu" ou "Requêtes Clés" non disponible.');
            }
            const count = getRows(queriesValues).length;
            const source = contentValues && contentValues.length > 1 ? 'Contenu' : 'Requêtes Clés / Calédito';
            if (count > 0) {
                return amelioration(
                    `${count} requête(s) stratégique(s) identifiée(s) dans l'onglet ${source}.`,
                    'Aligner les contenus et pages cibles sur les requêtes les plus stratégiques pour capter une demande qualifiée.',
                    'importante'
                );
            }
            return nonVerifie('Aucune requête stratégique identifiée.');
        }
    },

    // ══════════ CONTENU — SEO Images ══════════
    {
        category: 'Contenu',
        subcategory: 'SEO Images',
        subject: 'Les signaux SEO des images sont optimisés (alt, nommage, poids).',
        evaluate: (vbt) => {
            const values = vbt['Données Images'];
            if (!values || values.length <= 1) return nonVerifie('Onglet "Données Images" non disponible.');
            const count = getRows(values).length;
            if (count === 0) return conforme();
            return amelioration(
                `${count} image(s) à analyser pour les signaux SEO.`,
                'Uniformiser les images prioritaires : optimiser le poids, le nommage des fichiers et les attributs alt.',
                'moyenne'
            );
        }
    },

    // ══════════ CONTENU — Longueur de page ══════════
    {
        category: 'Contenu',
        subcategory: 'SEO Texte et structure',
        subject: 'La longueur des pages stratégiques est équilibrée.',
        evaluate: (vbt) => {
            const values = vbt['Longueur de page'];
            if (!values || values.length <= 1) return nonVerifie('Onglet "Longueur de page" non disponible.');
            const count = getRows(values).length;
            if (count === 0) return conforme();
            return amelioration(
                `${count} page(s) avec un déséquilibre de longueur détecté.`,
                'Harmoniser la profondeur éditoriale des pages clés pour éviter les contenus trop courts ou peu compétitifs.',
                'moyenne'
            );
        }
    }
];

// ─── Construction des lignes Synthèse ───

function buildSyntheseRows(valuesByTab) {
    const rows = [];

    for (let i = 0; i < AUDIT_CHECKS.length; i += 1) {
        const check = AUDIT_CHECKS[i];
        const result = check.evaluate(valuesByTab);

        rows.push([
            String(i + 1),
            check.category,
            check.subcategory,
            check.subject,
            result.conformity,
            result.remark,
            result.action,
            result.priority,
            result.status
        ]);
    }

    if (rows.length === 0) {
        rows.push([
            '1',
            'Technique',
            'Général',
            'Consolidation manuelle des priorités SEO',
            'Non vérifié',
            'Aucune règle automatique n\'a pu produire de résultat exploitable.',
            'Utiliser le Google Slides validé et les onglets source importés pour compléter ce plan manuellement.',
            '🔑🔑🔑 Importante',
            'À traiter'
        ]);
    }

    return rows;
}

// ─── Contexte audit ───

function buildContextRows(audit, sourceTabsCopied, checkCount) {
    return [
        ['Champ', 'Valeur'],
        ['Nom du client', audit.nom_site || 'Non renseigné'],
        ['URL du site', audit.url_site || 'Non renseignée'],
        ['Google Slides validé', audit.google_slides_url || 'Non renseigné'],
        ['Google Sheet audit source', audit.sheet_audit_url || 'Non renseigné'],
        ['Google Sheet plan source', audit.sheet_plan_url || 'Non renseigné'],
        ['Date de génération', new Date().toLocaleString('fr-FR')],
        ['Points d\'audit évalués', String(checkCount)],
        ['Onglets source importés', String(sourceTabsCopied)],
        ['Mode', 'Synthèse Audit - Plan d\'action (auto-généré)'],
        ['Note', 'Cette synthèse est générée automatiquement à partir des données d\'audit. Les points peuvent être complétés manuellement.']
    ];
}

// ─── Chargement des données ───

async function loadValuesByTab(sheets, sheetUrl, tabNames) {
    const spreadsheetId = extractSpreadsheetId(sheetUrl);
    if (!spreadsheetId) {
        return {};
    }

    const valuesByTab = {};

    for (const tabName of tabNames) {
        const values = await readSheetValues(sheets, spreadsheetId, tabName);
        if (values.length > 0) {
            valuesByTab[tabName] = values;
        }
    }

    return valuesByTab;
}

function buildMissingSourceRows(sourceTabName) {
    return [
        ['Information'],
        [`Onglet source "${sourceTabName}" vide ou introuvable dans le Google Sheet plan source.`]
    ];
}

function buildSourceTabTargets(planValuesByTab, usedTitles) {
    const targets = [];
    const summaryTabName = "Synthèse Audit - Plan d'action";
    const summaryValues = planValuesByTab[summaryTabName];

    if (summaryValues?.length > 0) {
        targets.push({
            title: summaryTabName,
            values: summaryValues,
            targetTitle: sanitizeSheetTitle(`Source - ${summaryTabName}`, usedTitles),
            sourceFound: true
        });
    }

    for (const config of ACTION_PLAN_OUTPUT_TAB_CONFIGS) {
        const values = planValuesByTab[config.sourceTabName];
        const sourceFound = values?.length > 0;

        targets.push({
            title: config.sourceTabName,
            values: sourceFound ? values : buildMissingSourceRows(config.sourceTabName),
            targetTitle: sanitizeSheetTitle(config.targetTitle, usedTitles),
            airtableField: config.airtableField,
            sourceFound
        });
    }

    return targets;
}

async function readSheetIdByTitle(sheets, spreadsheetId) {
    try {
        const response = await sheets.spreadsheets.get({
            spreadsheetId,
            fields: 'sheets.properties(sheetId,title)'
        });

        return new Map(
            (response.data.sheets || [])
                .map((sheet) => sheet.properties)
                .filter((properties) => properties?.title && typeof properties.sheetId === 'number')
                .map((properties) => [properties.title, properties.sheetId])
        );
    } catch (err) {
        console.warn(`[ACTION PLAN] Impossible de récupérer les IDs des onglets générés: ${err.message}`);
        return new Map();
    }
}

function buildAirtableSheetLinks(spreadsheetId, sheetIdByTitle, sourceTabTargets) {
    const links = {};

    for (const tab of sourceTabTargets) {
        if (!tab.airtableField) {
            continue;
        }

        const sheetId = sheetIdByTitle.get(tab.targetTitle);
        if (typeof sheetId !== 'number') {
            console.warn(`[ACTION PLAN] Onglet "${tab.targetTitle}" introuvable dans le Google Sheet généré.`);
            continue;
        }

        links[tab.airtableField] = buildGoogleSheetRangeUrl(spreadsheetId, sheetId, 'A1');
    }

    return links;
}

// ─── Formatage : couleurs et styles ───

const COLORS = {
    headerBg: { red: 0.12, green: 0.25, blue: 0.61 },
    white: { red: 1, green: 1, blue: 1 },
    green: { red: 0.35, green: 0.67, blue: 0.35 },
    orange: { red: 0.91, green: 0.6, blue: 0.2 },
    red: { red: 0.80, green: 0.20, blue: 0.20 },
    gray: { red: 0.75, green: 0.75, blue: 0.75 },
    darkRed: { red: 0.55, green: 0.10, blue: 0.10 },
    lightGreen: { red: 0.42, green: 0.65, blue: 0.31 }
};

function buildFormattingRequests(sheetId, dataRowCount) {
    const lastRow = dataRowCount + 2; // +2 pour bandeau + header
    const colCount = SYNTHESE_HEADERS.length; // 9

    return [
        // ── Bandeau titre (ligne 1) : fusion + style ──
        {
            mergeCells: {
                range: {
                    sheetId,
                    startRowIndex: 0,
                    endRowIndex: 1,
                    startColumnIndex: 0,
                    endColumnIndex: colCount
                },
                mergeType: 'MERGE_ALL'
            }
        },
        {
            repeatCell: {
                range: { sheetId, startRowIndex: 0, endRowIndex: 1 },
                cell: {
                    userEnteredFormat: {
                        backgroundColor: COLORS.headerBg,
                        textFormat: {
                            bold: true,
                            fontSize: 14,
                            foregroundColor: COLORS.white
                        },
                        horizontalAlignment: 'CENTER',
                        verticalAlignment: 'MIDDLE'
                    }
                },
                fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment)'
            }
        },

        // ── Header (ligne 2) : fond bleu, texte blanc, bold ──
        {
            repeatCell: {
                range: { sheetId, startRowIndex: 1, endRowIndex: 2 },
                cell: {
                    userEnteredFormat: {
                        backgroundColor: COLORS.headerBg,
                        textFormat: {
                            bold: true,
                            foregroundColor: COLORS.white
                        },
                        horizontalAlignment: 'CENTER',
                        verticalAlignment: 'MIDDLE',
                        wrapStrategy: 'WRAP'
                    }
                },
                fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment,verticalAlignment,wrapStrategy)'
            }
        },

        // ── Freeze 2 premières lignes ──
        {
            updateSheetProperties: {
                properties: {
                    sheetId,
                    gridProperties: { frozenRowCount: 2 }
                },
                fields: 'gridProperties.frozenRowCount'
            }
        },

        // ── Filtres sur la ligne header ──
        {
            setBasicFilter: {
                filter: {
                    range: {
                        sheetId,
                        startRowIndex: 1,
                        endRowIndex: lastRow,
                        startColumnIndex: 0,
                        endColumnIndex: colCount
                    }
                }
            }
        },

        // ── Couleurs conditionnelles sur "Conforme ?" (colonne E = index 4) ──
        // Ordre : plus spécifique d'abord
        {
            addConditionalFormatRule: {
                rule: {
                    ranges: [{ sheetId, startRowIndex: 2, endRowIndex: lastRow, startColumnIndex: 4, endColumnIndex: 5 }],
                    booleanRule: {
                        condition: { type: 'TEXT_CONTAINS', values: [{ userEnteredValue: 'Non concerné' }] },
                        format: { backgroundColor: COLORS.gray }
                    }
                },
                index: 0
            }
        },
        {
            addConditionalFormatRule: {
                rule: {
                    ranges: [{ sheetId, startRowIndex: 2, endRowIndex: lastRow, startColumnIndex: 4, endColumnIndex: 5 }],
                    booleanRule: {
                        condition: { type: 'TEXT_CONTAINS', values: [{ userEnteredValue: 'Non vérifié' }] },
                        format: { backgroundColor: COLORS.gray }
                    }
                },
                index: 1
            }
        },
        {
            addConditionalFormatRule: {
                rule: {
                    ranges: [{ sheetId, startRowIndex: 2, endRowIndex: lastRow, startColumnIndex: 4, endColumnIndex: 5 }],
                    booleanRule: {
                        condition: { type: 'TEXT_CONTAINS', values: [{ userEnteredValue: 'Amélioration' }] },
                        format: {
                            backgroundColor: COLORS.orange,
                            textFormat: { foregroundColor: COLORS.white }
                        }
                    }
                },
                index: 2
            }
        },
        {
            addConditionalFormatRule: {
                rule: {
                    ranges: [{ sheetId, startRowIndex: 2, endRowIndex: lastRow, startColumnIndex: 4, endColumnIndex: 5 }],
                    booleanRule: {
                        condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: 'Non' }] },
                        format: {
                            backgroundColor: COLORS.red,
                            textFormat: { foregroundColor: COLORS.white }
                        }
                    }
                },
                index: 3
            }
        },
        {
            addConditionalFormatRule: {
                rule: {
                    ranges: [{ sheetId, startRowIndex: 2, endRowIndex: lastRow, startColumnIndex: 4, endColumnIndex: 5 }],
                    booleanRule: {
                        condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: 'Oui' }] },
                        format: {
                            backgroundColor: COLORS.green,
                            textFormat: { foregroundColor: COLORS.white }
                        }
                    }
                },
                index: 4
            }
        },

        // ── Couleurs conditionnelles sur "Priorité" (colonne H = index 7) ──
        {
            addConditionalFormatRule: {
                rule: {
                    ranges: [{ sheetId, startRowIndex: 2, endRowIndex: lastRow, startColumnIndex: 7, endColumnIndex: 8 }],
                    booleanRule: {
                        condition: { type: 'TEXT_CONTAINS', values: [{ userEnteredValue: 'Importante' }] },
                        format: {
                            backgroundColor: COLORS.darkRed,
                            textFormat: { foregroundColor: COLORS.white }
                        }
                    }
                },
                index: 5
            }
        },
        {
            addConditionalFormatRule: {
                rule: {
                    ranges: [{ sheetId, startRowIndex: 2, endRowIndex: lastRow, startColumnIndex: 7, endColumnIndex: 8 }],
                    booleanRule: {
                        condition: { type: 'TEXT_CONTAINS', values: [{ userEnteredValue: 'Moyenne' }] },
                        format: {
                            backgroundColor: COLORS.orange,
                            textFormat: { foregroundColor: COLORS.white }
                        }
                    }
                },
                index: 6
            }
        },
        {
            addConditionalFormatRule: {
                rule: {
                    ranges: [{ sheetId, startRowIndex: 2, endRowIndex: lastRow, startColumnIndex: 7, endColumnIndex: 8 }],
                    booleanRule: {
                        condition: { type: 'TEXT_CONTAINS', values: [{ userEnteredValue: 'Faible' }] },
                        format: {
                            backgroundColor: COLORS.lightGreen,
                            textFormat: { foregroundColor: COLORS.white }
                        }
                    }
                },
                index: 7
            }
        },

        // ── Couleur conditionnelle sur "Statut" (colonne I = index 8) ──
        {
            addConditionalFormatRule: {
                rule: {
                    ranges: [{ sheetId, startRowIndex: 2, endRowIndex: lastRow, startColumnIndex: 8, endColumnIndex: 9 }],
                    booleanRule: {
                        condition: { type: 'TEXT_EQ', values: [{ userEnteredValue: 'À traiter' }] },
                        format: {
                            backgroundColor: COLORS.orange,
                            textFormat: { foregroundColor: COLORS.white }
                        }
                    }
                },
                index: 8
            }
        },

        // ── Auto-resize des colonnes ──
        {
            autoResizeDimensions: {
                dimensions: {
                    sheetId,
                    dimension: 'COLUMNS',
                    startIndex: 0,
                    endIndex: colCount
                }
            }
        },

        // ── Largeur minimale pour les colonnes textuelles (Sujet, Remarques, Action) ──
        {
            updateDimensionProperties: {
                range: { sheetId, dimension: 'COLUMNS', startIndex: 3, endIndex: 4 },
                properties: { pixelSize: 300 },
                fields: 'pixelSize'
            }
        },
        {
            updateDimensionProperties: {
                range: { sheetId, dimension: 'COLUMNS', startIndex: 5, endIndex: 6 },
                properties: { pixelSize: 280 },
                fields: 'pixelSize'
            }
        },
        {
            updateDimensionProperties: {
                range: { sheetId, dimension: 'COLUMNS', startIndex: 6, endIndex: 7 },
                properties: { pixelSize: 300 },
                fields: 'pixelSize'
            }
        },

        // ── Hauteur de la ligne bandeau ──
        {
            updateDimensionProperties: {
                range: { sheetId, dimension: 'ROWS', startIndex: 0, endIndex: 1 },
                properties: { pixelSize: 50 },
                fields: 'pixelSize'
            }
        }
    ];
}

// ─── Fonction principale ───

export async function generateActionPlanSheet(audit) {
    if (!audit) {
        throw new Error("Audit introuvable pour la génération du plan d'actions.");
    }

    const auth = createGoogleAuth();
    const sheets = createSheetsClient(auth);

    // 1. Créer le Google Sheet
    const createResponse = await sheets.spreadsheets.create({
        requestBody: {
            properties: {
                title: `Plan d'actions - ${audit.nom_site || 'Client'}`
            }
        }
    });

    const spreadsheetId = createResponse.data.spreadsheetId;
    const spreadsheetUrl =
        createResponse.data.spreadsheetUrl ||
        `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
    const defaultSheetId = createResponse.data.sheets?.[0]?.properties?.sheetId;

    if (!spreadsheetId) {
        throw new Error("La création du Google Sheet plan d'actions a échoué.");
    }

    // 2. Charger les données source
    const planValuesByTab = await loadValuesByTab(sheets, audit.sheet_plan_url, PLAN_SOURCE_TAB_NAMES);
    const auditValuesByTab = await loadValuesByTab(sheets, audit.sheet_audit_url, AUDIT_RULE_TABS);

    // 3. Générer les lignes Synthèse Audit
    const syntheseRows = buildSyntheseRows({
        ...planValuesByTab,
        ...auditValuesByTab
    });

    // 4. Préparer les onglets
    const usedTitles = new Set();
    const syntheseTitle = sanitizeSheetTitle("Synthèse Audit - Plan d'action", usedTitles);
    const contextTitle = sanitizeSheetTitle('Contexte audit', usedTitles);
    const addSheetRequests = [];

    // Renommer l'onglet par défaut → Synthèse Audit - Plan d'action
    if (typeof defaultSheetId === 'number') {
        addSheetRequests.push({
            updateSheetProperties: {
                properties: {
                    sheetId: defaultSheetId,
                    title: syntheseTitle
                },
                fields: 'title'
            }
        });
    }

    // Onglet Contexte
    addSheetRequests.push({
        addSheet: {
            properties: { title: contextTitle }
        }
    });

    // Onglets source
    const sourceTabTargets = buildSourceTabTargets(planValuesByTab, usedTitles);
    const sourceTabsCopied = sourceTabTargets.filter((tab) => tab.sourceFound).length;

    for (const tab of sourceTabTargets) {
        addSheetRequests.push({
            addSheet: {
                properties: { title: tab.targetTitle }
            }
        });
    }

    if (addSheetRequests.length > 0) {
        await sheets.spreadsheets.batchUpdate({
            spreadsheetId,
            requestBody: { requests: addSheetRequests }
        });
    }

    // 5. Écrire les données
    const bannerDate = new Date().toLocaleDateString('fr-FR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric'
    }).replace(/\//g, '.');

    const bannerText = `AUDIT SEO - Synthèse ${bannerDate} - ${(audit.nom_site || 'Client').toUpperCase()}`;

    const contextRows = buildContextRows(audit, sourceTabsCopied, syntheseRows.length);
    const valueData = [
        // Bandeau titre (ligne 1)
        {
            range: buildA1Range(syntheseTitle, 'A1'),
            values: [[bannerText]]
        },
        // Headers (ligne 2)
        {
            range: buildA1Range(syntheseTitle, `A2:I2`),
            values: [SYNTHESE_HEADERS]
        },
        // Données (ligne 3+)
        {
            range: buildA1Range(syntheseTitle, `A3:I${syntheseRows.length + 2}`),
            values: syntheseRows
        },
        // Contexte
        {
            range: buildA1Range(contextTitle, `A1:B${contextRows.length}`),
            values: contextRows
        }
    ];

    // Onglets source
    for (const tab of sourceTabTargets) {
        valueData.push({
            range: buildA1Range(tab.targetTitle, 'A1'),
            values: tab.values
        });
    }

    await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
            valueInputOption: 'RAW',
            data: valueData
        }
    });

    // 6. Appliquer le formatage
    if (typeof defaultSheetId === 'number') {
        const formattingRequests = buildFormattingRequests(defaultSheetId, syntheseRows.length);

        await sheets.spreadsheets.batchUpdate({
            spreadsheetId,
            requestBody: { requests: formattingRequests }
        });
    }

    // 7. Construire les liens Airtable
    const sheetIdByTitle = await readSheetIdByTitle(sheets, spreadsheetId);
    const airtableSheetLinks = buildAirtableSheetLinks(spreadsheetId, sheetIdByTitle, sourceTabTargets);

    return {
        spreadsheetId,
        spreadsheetUrl,
        airtableSheetLinks,
        sourceTabsCopied,
        actionCount: syntheseRows.length
    };
}
