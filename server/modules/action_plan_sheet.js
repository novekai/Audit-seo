import { google } from 'googleapis';

const ACTION_PLAN_HEADERS = [[
    'Axe',
    'Action',
    'Description',
    'Priorité (1/2/3)',
    'Impact estimé (faible/moyen/fort)',
    'Difficulté (facile/technique/développeur)',
    'Données sources',
    'Commentaire'
]];

const PLAN_SOURCE_TAB_NAMES = [
    "Synthèse Audit - Plan d'action",
    'Requêtes Clés / Calédito',
    'Données Images',
    'Longueur de page'
];

const AUDIT_RULE_TABS = [
    'Images',
    'Balise title',
    'Meta desc',
    'Doublons H1',
    'Balises H1-H6',
    'Nb mots body'
];

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

function createDriveClient(auth) {
    return google.drive({ version: 'v3', auth });
}

function extractSpreadsheetId(url) {
    if (!url) return null;
    const match = String(url).match(/\/d\/([a-zA-Z0-9-_]+)/);
    return match ? match[1] : null;
}

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

function buildActionRow({
    axis,
    action,
    description,
    priority,
    impact,
    difficulty,
    source
}) {
    return [
        axis,
        action,
        description,
        String(priority),
        impact,
        difficulty,
        source,
        ''
    ];
}

function buildContextRows(audit, sourceTabsCopied, actionCount) {
    return [
        ['Champ', 'Valeur'],
        ['Nom du client', audit.nom_site || 'Non renseigné'],
        ['URL du site', audit.url_site || 'Non renseignée'],
        ['Google Slides validé', audit.google_slides_url || 'Non renseigné'],
        ['Google Sheet audit source', audit.sheet_audit_url || 'Non renseigné'],
        ['Google Sheet plan source', audit.sheet_plan_url || 'Non renseigné'],
        ['Date de génération', new Date().toLocaleString('fr-FR')],
        ['Actions générées', String(actionCount)],
        ['Onglets source importés', String(sourceTabsCopied)],
        ['Mode', 'V1 par règles par défaut issue du cahier des charges'],
        ['Note', 'Cette version utilise des règles métier par défaut en attendant la base structurée des 25 actions types.']
    ];
}

function extractRuleInput(valuesByTab, tabName) {
    return valuesByTab[tabName] || [];
}

function buildDefaultActionRows(valuesByTab) {
    const rows = [];
    const seenActions = new Set();

    const pushAction = (config) => {
        if (!config || seenActions.has(config.action)) {
            return;
        }

        seenActions.add(config.action);
        rows.push(buildActionRow(config));
    };

    const imagesValues = extractRuleInput(valuesByTab, 'Images');
    if (imagesValues.length > 0) {
        const headers = getHeaders(imagesValues);
        const sizeIdx = findColIndex(headers, ['taille', 'octet', 'bytes']);
        const heavyImagesCount = sizeIdx >= 0
            ? countMatchingRows(imagesValues, (row) => toBytes(row[sizeIdx]) >= 100000)
            : getRows(imagesValues).length;

        if (heavyImagesCount > 0) {
            pushAction({
                axis: 'Technique',
                action: 'Optimiser le poids des images',
                description: 'Compresser ou redimensionner les images trop lourdes pour améliorer le temps de chargement des pages les plus exposées.',
                priority: 2,
                impact: 'moyen',
                difficulty: 'technique',
                source: `${heavyImagesCount} image(s) détectée(s) dans l’onglet Images`
            });
        }
    }

    const titleValues = extractRuleInput(valuesByTab, 'Balise title');
    if (titleValues.length > 0) {
        const headers = getHeaders(titleValues);
        const statusIdx = findColIndex(headers, ['etat balise title', 'etat', 'état', 'status']);
        const count = statusIdx >= 0
            ? countMatchingRows(titleValues, (row) => normalizeText(row[statusIdx]).includes('trop longue'))
            : getRows(titleValues).length;

        if (count > 0) {
            pushAction({
                axis: 'Contenu',
                action: 'Corriger les balises title trop longues',
                description: 'Raccourcir et clarifier les balises title pour améliorer leur lisibilité et leur efficacité dans les résultats de recherche.',
                priority: 1,
                impact: 'fort',
                difficulty: 'facile',
                source: `${count} page(s) concernée(s) dans l’onglet Balise title`
            });
        }
    }

    const metaValues = extractRuleInput(valuesByTab, 'Meta desc');
    if (metaValues.length > 0) {
        const headers = getHeaders(metaValues);
        const countIdx = findColIndex(headers, ['nb de caracteres', 'caractere', 'caracter']);
        const count = countIdx >= 0
            ? countMatchingRows(metaValues, (row) => parseNumber(row[countIdx]) === 0)
            : getRows(metaValues).length;

        if (count > 0) {
            pushAction({
                axis: 'Contenu',
                action: 'Renseigner les meta descriptions manquantes',
                description: 'Rédiger des meta descriptions utiles sur les pages sans extrait pour mieux valoriser les contenus dans les SERP.',
                priority: 2,
                impact: 'moyen',
                difficulty: 'facile',
                source: `${count} page(s) sans meta description exploitable`
            });
        }
    }

    const duplicateH1Values = extractRuleInput(valuesByTab, 'Doublons H1');
    if (duplicateH1Values.length > 0) {
        const count = getRows(duplicateH1Values).length;
        if (count > 0) {
            pushAction({
                axis: 'Contenu',
                action: 'Supprimer les doublons H1',
                description: 'Attribuer un H1 unique et cohérent sur chaque page afin de clarifier le sujet principal du contenu.',
                priority: 1,
                impact: 'fort',
                difficulty: 'facile',
                source: `${count} ligne(s) relevée(s) dans l’onglet Doublons H1`
            });
        }
    }

    const headingsValues = extractRuleInput(valuesByTab, 'Balises H1-H6');
    if (headingsValues.length > 0) {
        const headers = getHeaders(headingsValues);
        const h1AbsenteIdx = findColIndex(headers, ['h1 absente']);
        const hnNotH1Idx = findColIndex(headers, ['1ere balise hn', '1ère balise hn', 'pas h1', "n'est pas h1"]);
        const skippedLevelsIdx = findColIndex(headers, ['sauts de niveau']);
        const longHeadingsIdx = findColIndex(headers, ['hn trop longue']);

        const issuesCount = countMatchingRows(headingsValues, (row) => {
            const missingH1 = h1AbsenteIdx >= 0 && normalizeText(row[h1AbsenteIdx]) === 'oui';
            const wrongFirstHeading = hnNotH1Idx >= 0 && normalizeText(row[hnNotH1Idx]) === 'oui';
            const skippedLevels = skippedLevelsIdx >= 0 && parseNumber(row[skippedLevelsIdx]) > 0;
            const longHeadings = longHeadingsIdx >= 0 && parseNumber(row[longHeadingsIdx]) >= 1;
            return missingH1 || wrongFirstHeading || skippedLevels || longHeadings;
        });

        if (issuesCount > 0) {
            pushAction({
                axis: 'Contenu',
                action: 'Reprendre la hiérarchie des titres Hn',
                description: 'Réorganiser les titres H1 à H6 pour renforcer la compréhension des pages par les utilisateurs et les moteurs.',
                priority: 1,
                impact: 'fort',
                difficulty: 'facile',
                source: `${issuesCount} page(s) avec structure de titres à corriger`
            });
        }
    }

    const bodyValues = extractRuleInput(valuesByTab, 'Nb mots body');
    if (bodyValues.length > 0) {
        const count = getRows(bodyValues).length;
        if (count > 0) {
            pushAction({
                axis: 'Contenu',
                action: 'Enrichir les pages au contenu trop faible',
                description: 'Prioriser les pages les plus pauvres en contenu ou les plus critiques pour renforcer leur valeur SEO et commerciale.',
                priority: 2,
                impact: 'fort',
                difficulty: 'facile',
                source: `${count} ligne(s) relevée(s) dans l’onglet Nb mots body`
            });
        }
    }

    const queriesValues = extractRuleInput(valuesByTab, 'Requêtes Clés / Calédito');
    if (queriesValues.length > 1) {
        pushAction({
            axis: 'Contenu',
            action: 'Prioriser les pages liées aux requêtes clés',
            description: 'Aligner les contenus et les pages cibles sur les requêtes jugées les plus stratégiques pour capter une demande qualifiée.',
            priority: 1,
            impact: 'fort',
            difficulty: 'technique',
            source: `${getRows(queriesValues).length} ligne(s) exploitable(s) dans Requêtes Clés / Calédito`
        });
    }

    const imageDataValues = extractRuleInput(valuesByTab, 'Données Images');
    if (imageDataValues.length > 1) {
        pushAction({
            axis: 'Technique',
            action: 'Fiabiliser les signaux SEO des images',
            description: 'Uniformiser les images prioritaires en travaillant leur poids, leur nommage et leurs attributs utiles au référencement.',
            priority: 2,
            impact: 'moyen',
            difficulty: 'technique',
            source: `${getRows(imageDataValues).length} ligne(s) exploitable(s) dans Données Images`
        });
    }

    const pageLengthValues = extractRuleInput(valuesByTab, 'Longueur de page');
    if (pageLengthValues.length > 1) {
        pushAction({
            axis: 'Contenu',
            action: 'Rééquilibrer la longueur des pages stratégiques',
            description: 'Harmoniser la profondeur éditoriale des pages clés pour éviter les contenus trop courts ou peu compétitifs.',
            priority: 2,
            impact: 'moyen',
            difficulty: 'facile',
            source: `${getRows(pageLengthValues).length} ligne(s) exploitable(s) dans Longueur de page`
        });
    }

    rows.sort((a, b) => Number(a[3]) - Number(b[3]));

    if (rows.length === 0) {
        rows.push(buildActionRow({
            axis: 'Technique',
            action: 'Consolider manuellement les priorités SEO',
            description: 'Aucune règle par défaut n’a pu proposer d’action exploitable. Utiliser le Google Slides validé et les onglets source importés pour compléter ce plan.',
            priority: 1,
            impact: 'moyen',
            difficulty: 'facile',
            source: 'Aucune correspondance détectée automatiquement'
        }));
    }

    return rows;
}

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

export async function generateActionPlanSheet(audit, email) {
    if (!audit) {
        throw new Error("Audit introuvable pour la génération du plan d'actions.");
    }

    const auth = createGoogleAuth();
    const sheets = createSheetsClient(auth);
    const drive = createDriveClient(auth);
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

    try {
        await drive.permissions.create({
            fileId: spreadsheetId,
            requestBody: {
                type: 'user',
                role: 'writer',
                emailAddress: email
            },
            sendNotificationEmail: true
        });
    } catch (err) {
        throw new Error(
            `Le Google Sheet a bien été créé, mais le partage avec ${email} a échoué: ${err.message}`
        );
    }

    const planValuesByTab = await loadValuesByTab(sheets, audit.sheet_plan_url, PLAN_SOURCE_TAB_NAMES);
    const auditValuesByTab = await loadValuesByTab(sheets, audit.sheet_audit_url, AUDIT_RULE_TABS);
    const generatedActionRows = buildDefaultActionRows({
        ...planValuesByTab,
        ...auditValuesByTab
    });

    const usedTitles = new Set();
    const actionsTitle = sanitizeSheetTitle('Actions proposées', usedTitles);
    const contextTitle = sanitizeSheetTitle('Contexte audit', usedTitles);
    const addSheetRequests = [];

    if (typeof defaultSheetId === 'number') {
        addSheetRequests.push({
            updateSheetProperties: {
                properties: {
                    sheetId: defaultSheetId,
                    title: actionsTitle,
                    gridProperties: {
                        frozenRowCount: 1
                    }
                },
                fields: 'title,gridProperties.frozenRowCount'
            }
        });
    }

    addSheetRequests.push({
        addSheet: {
            properties: {
                title: contextTitle
            }
        }
    });

    const sourceTabTargets = Object.entries(planValuesByTab).map(([title, values]) => ({
        title,
        values,
        targetTitle: sanitizeSheetTitle(`Source - ${title}`, usedTitles)
    }));

    for (const tab of sourceTabTargets) {
        addSheetRequests.push({
            addSheet: {
                properties: {
                    title: tab.targetTitle
                }
            }
        });
    }

    if (addSheetRequests.length > 0) {
        await sheets.spreadsheets.batchUpdate({
            spreadsheetId,
            requestBody: {
                requests: addSheetRequests
            }
        });
    }

    const contextRows = buildContextRows(audit, sourceTabTargets.length, generatedActionRows.length);
    const valueData = [
        {
            range: `${actionsTitle}!A1:H1`,
            values: ACTION_PLAN_HEADERS
        },
        {
            range: `${actionsTitle}!A2:H${generatedActionRows.length + 1}`,
            values: generatedActionRows
        },
        {
            range: `${contextTitle}!A1:B${contextRows.length}`,
            values: contextRows
        }
    ];

    for (const tab of sourceTabTargets) {
        valueData.push({
            range: `${tab.targetTitle}!A1`,
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

    if (typeof defaultSheetId === 'number') {
        await sheets.spreadsheets.batchUpdate({
            spreadsheetId,
            requestBody: {
                requests: [
                    {
                        repeatCell: {
                            range: {
                                sheetId: defaultSheetId,
                                startRowIndex: 0,
                                endRowIndex: 1
                            },
                            cell: {
                                userEnteredFormat: {
                                    backgroundColor: { red: 0.12, green: 0.25, blue: 0.61 },
                                    textFormat: {
                                        bold: true,
                                        foregroundColor: { red: 1, green: 1, blue: 1 }
                                    }
                                }
                            },
                            fields: 'userEnteredFormat(backgroundColor,textFormat)'
                        }
                    },
                    {
                        autoResizeDimensions: {
                            dimensions: {
                                sheetId: defaultSheetId,
                                dimension: 'COLUMNS',
                                startIndex: 0,
                                endIndex: 8
                            }
                        }
                    }
                ]
            }
        });
    }

    return {
        spreadsheetId,
        spreadsheetUrl,
        sourceTabsCopied: sourceTabTargets.length,
        actionCount: generatedActionRows.length
    };
}
