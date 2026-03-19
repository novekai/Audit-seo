import Airtable from 'airtable';
import { auditQueue } from './queue.js';
import { v4 as uuidv4 } from 'uuid';
import { reconcileAuditCompletion, shouldIgnoreAirtableStatusRegression } from '../utils/auditStatus.js';
import { readGeneratedActionPlanUrl, readGeneratedSlidesUrl } from '../airtable.js';

const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY }).base(process.env.AIRTABLE_BASE_ID);
const table = base(process.env.AIRTABLE_TABLE_ID);

function mapAirtableStatusToLocalStatus(status) {
    switch (status) {
        case 'fait':
            return 'TERMINE';
        case 'Erreur':
            return 'ERREUR';
        case 'En cours':
            return 'EN_COURS';
        case 'A faire':
        default:
            return 'EN_ATTENTE';
    }
}

export async function initAirtablePoller(io, db) {
    console.log('[POLLER] Airtable Sync initialized (Interval: 20s)');

    // Poll every 20 seconds for better real-time feel
    setInterval(() => {
        syncAirtableToDb(io, db).catch(err => {
            console.error('[POLLER] Sync error:', err);
        });
    }, 20000);

    // Initial sync
    syncAirtableToDb(io, db).catch(err => console.error('[POLLER] Initial sync error:', err));
}

async function syncAirtableToDb(io, db) {


    try {
        const records = await table.select({
            filterByFormula: 'OR({Statut} = "A faire", {Statut} = "En cours", {Statut} = "fait", {Statut} = "Erreur")',
            maxRecords: 50
        }).all();

        if (records.length === 0) {
            return;
        }

        console.log(`[POLLER] Found ${records.length} records in work-set.`);

        // Get a default user ID if none is provided (e.g., first user or admin)
        const defaultUser = await db.get('SELECT id FROM users LIMIT 1');
        if (!defaultUser) {
            console.warn('[POLLER] No user found in DB, skipping sync.');
            return;
        }

        for (const record of records) {
            const airtableId = record.id;
            const airtableStatus = record.get('Statut');
            const siteName = record.get('Nom de site') || 'Site Sans Nom';
            const siteUrl = record.get('URL Site') || '';
            const sheetAuditUrl = record.get('Lien Google Sheet');
            const sheetPlanUrl = record.get('Lien Google Sheet plan d\'action');
            const mrmReportUrl = record.get('Lien du rapport my ranking metrics');
            const generatedSlidesUrl = readGeneratedSlidesUrl(record);
            const generatedActionPlanUrl = readGeneratedActionPlanUrl(record);

            // Check if already in DB
            const existing = await db.get('SELECT * FROM audits WHERE airtable_record_id = ?', [airtableId]);

            if (existing) {
                const localAudit = await reconcileAuditCompletion(db, existing);

                // Determine what the target local status should be
                const targetLocalStatus = mapAirtableStatusToLocalStatus(airtableStatus);
                const hasSlidesLinkUpdate =
                    Boolean(generatedSlidesUrl) &&
                    (
                        localAudit.google_slides_url !== generatedSlidesUrl ||
                        localAudit.slides_generation_status !== 'PRET'
                    );
                const hasActionPlanLinkUpdate =
                    Boolean(generatedActionPlanUrl) &&
                    (
                        localAudit.google_action_plan_url !== generatedActionPlanUrl ||
                        localAudit.action_plan_generation_status !== 'PRET'
                    );

                // 1. Bidirectional Sync: Only update if REALLY needed
                const hasChanged =
                    localAudit.nom_site !== siteName ||
                    localAudit.url_site !== siteUrl ||
                    localAudit.sheet_audit_url !== sheetAuditUrl ||
                    localAudit.sheet_plan_url !== sheetPlanUrl ||
                    localAudit.mrm_report_url !== mrmReportUrl ||
                    hasSlidesLinkUpdate ||
                    hasActionPlanLinkUpdate ||
                    (
                        localAudit.statut_global !== targetLocalStatus &&
                        !shouldIgnoreAirtableStatusRegression(localAudit.statut_global, targetLocalStatus)
                    );
                // If local is matching Airtable, or we just updated it, worker will see it.

                if (hasChanged) {
                    console.log(`[POLLER] Updating local record ${localAudit.id} (Airtable: ${airtableStatus})`);

                    await db.run(
                        `UPDATE audits
                         SET nom_site = ?,
                             url_site = ?,
                             sheet_audit_url = ?,
                             sheet_plan_url = ?,
                             mrm_report_url = ?,
                             google_slides_url = ?,
                             slides_generation_status = ?,
                             slides_generation_error = ?,
                             slides_generated_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE slides_generated_at END,
                             google_action_plan_url = ?,
                             action_plan_generation_status = ?,
                             action_plan_generation_error = ?,
                             action_plan_generated_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE action_plan_generated_at END,
                             statut_global = ?
                         WHERE id = ?`,
                        [
                            siteName,
                            siteUrl,
                            sheetAuditUrl,
                            sheetPlanUrl,
                            mrmReportUrl,
                            generatedSlidesUrl || localAudit.google_slides_url,
                            hasSlidesLinkUpdate ? 'PRET' : localAudit.slides_generation_status,
                            hasSlidesLinkUpdate ? null : localAudit.slides_generation_error,
                            hasSlidesLinkUpdate,
                            generatedActionPlanUrl || localAudit.google_action_plan_url,
                            hasActionPlanLinkUpdate ? 'PRET' : localAudit.action_plan_generation_status,
                            hasActionPlanLinkUpdate ? null : localAudit.action_plan_generation_error,
                            hasActionPlanLinkUpdate,
                            shouldIgnoreAirtableStatusRegression(localAudit.statut_global, targetLocalStatus)
                                ? localAudit.statut_global
                                : targetLocalStatus,
                            localAudit.id
                        ]
                    );

                    // Notify frontend
                    io.emit('audit:update', {
                        ...localAudit,
                        nom_site: siteName,
                        url_site: siteUrl,
                        sheet_audit_url: sheetAuditUrl,
                        sheet_plan_url: sheetPlanUrl,
                        mrm_report_url: mrmReportUrl,
                        google_slides_url: generatedSlidesUrl || localAudit.google_slides_url,
                        slides_generation_status: hasSlidesLinkUpdate ? 'PRET' : localAudit.slides_generation_status,
                        slides_generation_error: hasSlidesLinkUpdate ? null : localAudit.slides_generation_error,
                        google_action_plan_url: generatedActionPlanUrl || localAudit.google_action_plan_url,
                        action_plan_generation_status: hasActionPlanLinkUpdate ? 'PRET' : localAudit.action_plan_generation_status,
                        action_plan_generation_error: hasActionPlanLinkUpdate ? null : localAudit.action_plan_generation_error,
                        statut_global: shouldIgnoreAirtableStatusRegression(localAudit.statut_global, targetLocalStatus)
                            ? localAudit.statut_global
                            : targetLocalStatus
                    });
                }

                // 2. Progressive Step Sync: If Airtable has specific image fields, mark steps as SUCCESS
                const stepMappings = [
                    { key: 'robots_txt', field: 'Img_Robots_Txt' },
                    { key: 'sitemap', field: 'Img_Sitemap' },
                    { key: 'logo', field: 'Img_Logo' },
                    { key: 'ssl_labs', field: 'Img_SSL' },
                    { key: 'ami_responsive', field: 'Img_AmIResponsive' },
                    { key: 'responsive_menu_mobile_1', field: 'Img_menu_mobile_1' },
                    { key: 'responsive_menu_mobile_2', field: 'Img_menu_mobile_2' },
                    { key: 'psi_mobile', field: 'Img_PSI_Mobile' },
                    { key: 'psi_desktop', field: 'Img_PSI_Desktop' },
                    { key: 'sheet_images', field: 'Img_Poids_image' },
                    { key: 'sheet_meme_title', field: 'Img_meme_title' },
                    { key: 'sheet_meta_desc_double', field: 'Img_meta_description_double' },
                    { key: 'sheet_doublons_h1', field: 'Img_balise_h1_double' },
                    { key: 'sheet_h1_absente', field: 'Img_balise_h1_absente' },
                    { key: 'sheet_h1_vides', field: 'Img_que des H1 vides' },
                    { key: 'sheet_h1_au_moins', field: 'Img_au moins une H1 vide' },
                    { key: 'sheet_hn_pas_h1', field: "Img_1ère balise Hn n'est pas H1" },
                    { key: 'sheet_sauts_hn', field: 'Img_Sauts de niveau entre les Hn' },
                    { key: 'sheet_hn_longue', field: 'Img_Hn trop longue' },
                    { key: 'sheet_mots_body', field: 'Img_longeur_page' },
                    { key: 'sheet_meta_desc', field: 'Img_meta_description' },
                    { key: 'sheet_balise_title', field: 'Img_balises_title' },
                    { key: 'plan_synthese', field: "Img_planD'action" },
                    { key: 'plan_requetes', field: 'Img_Requetes_cles' },
                    { key: 'plan_donnees_img', field: 'Img_donnee image' },
                    { key: 'plan_longueur', field: 'Img_longeur_page_plan' },
                    { key: 'gsc_sitemaps', field: 'Img_sitemap_declaré' },
                    { key: 'gsc_https', field: 'Img_https' },
                    { key: 'gsc_performance', field: 'Img_trafic actuel1' },
                    { key: 'gsc_meilleure_requete', field: 'Img_meilleure_requete' },
                    { key: 'gsc_query_page_clicks_impressions', field: 'Img_query_page_clicks_impressions' },
                    { key: 'gsc_coverage', field: 'Img_indexation_gsc' },
                    { key: 'gsc_indexation_image', field: 'Img_indexation_gsc' },
                    { key: 'gsc_problemes_indexation', field: 'Img_probleme_indexation_gsc' },
                    { key: 'gsc_top_pages', field: 'Img_meilleure_page' },
                    { key: 'mrm_profondeur', field: 'Img_profondeur_clics' },
                    { key: 'ubersuggest_da', field: 'Img_autorité_domaine_UBERSUGGEST' },
                    { key: 'semrush_authority', field: 'Img_autorité_domaine_SEMRUSH' },
                    { key: 'ahrefs_authority', field: 'Img_autorité_domaine_AHREF' },
                    { key: 'majestic_backlinks', field: 'Img_BACKLINKS' },
                ];

                for (const mapping of stepMappings) {
                    const imageUrl = record.get(mapping.field);
                    let step = await db.get('SELECT * FROM audit_steps WHERE audit_id = ? AND step_key = ?', [localAudit.id, mapping.key]);

                    if (!step) {
                        await db.run(
                            'INSERT INTO audit_steps (id, audit_id, step_key, statut, output_cloudinary_url) VALUES (?, ?, ?, ?, ?)',
                            [uuidv4(), localAudit.id, mapping.key, imageUrl ? 'SUCCESS' : 'EN_ATTENTE', imageUrl || null]
                        );
                        step = await db.get('SELECT * FROM audit_steps WHERE audit_id = ? AND step_key = ?', [localAudit.id, mapping.key]);
                    }

                    if (imageUrl) {
                        if (step && step.statut !== 'SUCCESS' && step.statut !== 'SUCCES') {
                            console.log(`[POLLER] Step ${mapping.key} mark as SUCCESS for ${localAudit.id} (found URL in Airtable)`);
                            await db.run(
                                'UPDATE audit_steps SET statut = ?, output_cloudinary_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
                                ['SUCCESS', imageUrl, step.id]
                            );

                            // Real-time update for this specific step
                            io.to(`audit:${localAudit.id}`).emit('step:update', {
                                auditId: localAudit.id,
                                step: { step_key: mapping.key, statut: 'SUCCESS', output_cloudinary_url: imageUrl }
                            });
                        }
                    }
                }

                // 3. Re-trigger logic: If "A faire" in Airtable AND local status is not already "EN_ATTENTE"
                // We allow re-trigger even from "EN_COURS" because the user might have clicked "A faire" to restart a stuck job.
                if (airtableStatus === 'A faire' && localAudit.statut_global !== 'EN_ATTENTE') {
                    console.log(`[POLLER] Re-triggering audit ${localAudit.id} from Airtable (Force Reset).`);
                    await db.run('UPDATE audits SET statut_global = ? WHERE id = ?', ['EN_ATTENTE', localAudit.id]);
                    await db.run(
                        'UPDATE audit_steps SET statut = ?, output_cloudinary_url = NULL, resultat = NULL WHERE audit_id = ?',
                        ['EN_ATTENTE', localAudit.id]
                    );

                    await auditQueue.add(`audit-${localAudit.id}`, { auditId: localAudit.id, userId: defaultUser.id }, {
                        attempts: 3,
                        backoff: { type: 'exponential', delay: 5000 }
                    });

                    io.emit('audit:update', { id: localAudit.id, statut_global: 'EN_ATTENTE' });
                }
                continue;
            }

            // Import NEW records
            const auditId = uuidv4();
            console.log(`[POLLER] Importing new audit from Airtable: ${siteName} (${airtableId})`);

            // If Airtable says it's already done, mark it as TERMINE locally
            const initialLocalStatus = mapAirtableStatusToLocalStatus(airtableStatus);

            // 1. Create Local Audit
            await db.run(
                `INSERT INTO audits (
                    id,
                    user_id,
                    nom_site,
                    url_site,
                    sheet_audit_url,
                    sheet_plan_url,
                    mrm_report_url,
                    airtable_record_id,
                    google_slides_url,
                    slides_generation_status,
                    google_action_plan_url,
                    action_plan_generation_status,
                    statut_global
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    auditId,
                    defaultUser.id,
                    siteName,
                    siteUrl,
                    record.get('Lien Google Sheet'),
                    record.get('Lien Google Sheet plan d\'action'),
                    record.get('Lien du rapport my ranking metrics'),
                    airtableId,
                    generatedSlidesUrl,
                    generatedSlidesUrl ? 'PRET' : 'NON_GENERE',
                    generatedActionPlanUrl,
                    generatedActionPlanUrl ? 'PRET' : 'NON_GENERE',
                    initialLocalStatus
                ]
            );

            // 2. Initialize Steps — must match worker.js step_keys exactly
            const stepsKeys = [
                'robots_txt', 'sitemap', 'logo',
                'ami_responsive', 'responsive_menu_mobile_1', 'responsive_menu_mobile_2', 'ssl_labs',
                'psi_mobile', 'psi_desktop',
                'sheet_images', 'sheet_meme_title', 'sheet_meta_desc_double',
                'sheet_doublons_h1', 'sheet_h1_absente', 'sheet_h1_vides',
                'sheet_h1_au_moins', 'sheet_hn_pas_h1', 'sheet_sauts_hn',
                'sheet_hn_longue', 'sheet_mots_body', 'sheet_meta_desc',
                'sheet_balise_title', 'check_404',
                'plan_synthese', 'plan_requetes', 'plan_donnees_img', 'plan_longueur',
                'gsc_sitemaps', 'gsc_https',
                'gsc_performance', 'gsc_meilleure_requete', 'gsc_query_page_clicks_impressions',
                'gsc_coverage', 'gsc_indexation_image', 'gsc_problemes_indexation', 'gsc_top_pages',
                'mrm_profondeur', 'ubersuggest_da',
                'semrush_authority', 'ahrefs_authority', 'majestic_backlinks'
            ];

            for (const stepKey of stepsKeys) {
                await db.run(
                    'INSERT INTO audit_steps (id, audit_id, step_key, statut) VALUES (?, ?, ?, ?)',
                    [uuidv4(), auditId, stepKey, initialLocalStatus === 'TERMINE' ? 'SUCCESS' : 'EN_ATTENTE']
                );
            }

            // 4. Add to BullMQ only if not already finished
            if (initialLocalStatus === 'EN_ATTENTE') {
                await auditQueue.add(`audit-${auditId}`, { auditId, userId: defaultUser.id });
            }

            // 5. Notify Frontend
            io.emit('audit:created', {
                id: auditId,
                user_id: defaultUser.id,
                nom_site: siteName,
                url_site: siteUrl,
                google_slides_url: generatedSlidesUrl,
                slides_generation_status: generatedSlidesUrl ? 'PRET' : 'NON_GENERE',
                google_action_plan_url: generatedActionPlanUrl,
                action_plan_generation_status: generatedActionPlanUrl ? 'PRET' : 'NON_GENERE',
                statut_global: initialLocalStatus,
                created_at: new Date().toISOString()
            });
        }
    } catch (err) {
        console.error('[POLLER] Error during check:', err.message);
    }
}
