import Airtable from 'airtable';

const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);
const table = base(process.env.AIRTABLE_TABLE_ID);
export const GENERATED_SLIDES_FIELD_NAME = 'Document Slide Généré';
export const GENERATED_ACTION_PLAN_FIELD_NAME =
    process.env.AIRTABLE_GENERATED_ACTION_PLAN_FIELD_NAME ||
    "Document Plan d'action Généré";

const GENERATED_ACTION_PLAN_FIELD_CANDIDATES = Array.from(new Set([
    GENERATED_ACTION_PLAN_FIELD_NAME,
    "Document Plan d’actions Généré",
    "Document Plan d'action Généré",
    "Document Plan d’Action Généré",
    "Document Plan d'Action Généré"
].filter(Boolean)));

function extractAirtableUrl(value, visited = new Set()) {
    if (!value) return null;

    if (typeof value === 'string') {
        const trimmed = value.trim();
        return trimmed || null;
    }

    if (Array.isArray(value)) {
        for (const item of value) {
            const match = extractAirtableUrl(item, visited);
            if (match) return match;
        }
        return null;
    }

    if (typeof value === 'object') {
        if (visited.has(value)) return null;
        visited.add(value);

        if (typeof value.url === 'string' && value.url.trim()) {
            return value.url.trim();
        }

        if (typeof value.href === 'string' && value.href.trim()) {
            return value.href.trim();
        }

        for (const nestedValue of Object.values(value)) {
            const match = extractAirtableUrl(nestedValue, visited);
            if (match) return match;
        }
    }

    return null;
}

export async function createAirtableAudit(data) {
    const record = await table.create({
        "Nom de site": data.siteName,
        "URL Site": data.siteUrl,
        "Lien Google Sheet": data.auditSheetUrl,
        "Lien Google Sheet plan d'action": data.actionPlanSheetUrl,
        "Lien du rapport my ranking metrics": data.mrmReportUrl,
        "Statut": "A faire"
    });
    return record.id;
}

export async function updateAirtableStatut(recordId, statut) {
    console.log(`[AIRTABLE] SYNC STATUS: record=${recordId}, value="${statut}"`);
    try {
        await table.update(recordId, { "Statut": statut });
        console.log(`[AIRTABLE] Successfully updated status to ${statut}.`);
    } catch (err) {
        console.error(`[AIRTABLE] FAILED to update status:`, err.message);
    }
}

export async function updateAirtableField(recordId, fieldName, value) {
    if (!value) {
        console.warn(`[AIRTABLE] Skipping update for ${fieldName}: value is null/empty`);
        return;
    }
    console.log(`[AIRTABLE] SYNC FIELD: record=${recordId}, field="${fieldName}"`);
    try {
        await table.update(recordId, { [fieldName]: value });
        console.log(`[AIRTABLE] SUCCESS: ${fieldName} updated.`);
    } catch (err) {
        console.error(`[AIRTABLE] ERROR syncing ${fieldName}:`, err.message);
        if (err.message.includes('invalid') || err.message.includes('cell value')) {
            console.warn(`[AIRTABLE] Field "${fieldName}" likely expects Attachment format. If you want a link, change the field type to "URL" or "Single line text" in Airtable.`);
        }
    }
}

export async function getAirtableRecord(recordId) {
    return table.find(recordId);
}

export async function deleteAirtableAudit(recordId) {
    if (!recordId) return;

    console.log(`[AIRTABLE] DELETE RECORD: ${recordId}`);
    try {
        await table.destroy(recordId);
        console.log(`[AIRTABLE] SUCCESS: record ${recordId} deleted.`);
    } catch (err) {
        const isMissingRecord =
            err?.statusCode === 404 ||
            /not found/i.test(err?.message || '');

        if (isMissingRecord) {
            console.warn(`[AIRTABLE] Record ${recordId} already missing, continuing local deletion.`);
            return;
        }

        throw err;
    }
}

function readGeneratedUrlFromFields(record, fieldNames) {
    if (!record) return null;

    for (const fieldName of fieldNames) {
        const rawValue =
            typeof record.get === 'function'
                ? record.get(fieldName)
                : record[fieldName];

        const url = extractAirtableUrl(rawValue);
        if (url) {
            return url;
        }
    }

    return null;
}

export function readGeneratedSlidesUrl(record) {
    return readGeneratedUrlFromFields(record, [GENERATED_SLIDES_FIELD_NAME]);
}

export function readGeneratedActionPlanUrl(record) {
    return readGeneratedUrlFromFields(record, GENERATED_ACTION_PLAN_FIELD_CANDIDATES);
}
