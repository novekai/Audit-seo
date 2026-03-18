const TERMINAL_STEP_STATUSES = new Set([
    'SUCCESS',
    'SUCCES',
    'WARNING',
    'FAIT',
    'SKIP',
    'FAILED',
    'ERROR',
    'ERREUR'
]);

const TERMINAL_AUDIT_STATUSES = new Set([
    'TERMINE',
    'ERREUR'
]);

function normalizeStatus(status) {
    return String(status || '').trim().toUpperCase();
}

export function isTerminalStepStatus(status) {
    return TERMINAL_STEP_STATUSES.has(normalizeStatus(status));
}

export function isTerminalAuditStatus(status) {
    return TERMINAL_AUDIT_STATUSES.has(normalizeStatus(status));
}

export function shouldIgnoreAirtableStatusRegression(localStatus, remoteStatus) {
    const normalizedLocalStatus = normalizeStatus(localStatus);
    const normalizedRemoteStatus = normalizeStatus(remoteStatus);

    return (
        normalizedLocalStatus === 'TERMINE' &&
        (normalizedRemoteStatus === 'EN_COURS' || normalizedRemoteStatus === 'EN_ATTENTE')
    );
}

export async function reconcileAuditCompletion(db, audit) {
    if (!audit || isTerminalAuditStatus(audit.statut_global)) {
        return audit;
    }

    const steps = await db.all('SELECT statut FROM audit_steps WHERE audit_id = ?', [audit.id]);
    if (!steps.length) {
        return audit;
    }

    const allStepsTerminal = steps.every((step) => isTerminalStepStatus(step.statut));
    if (!allStepsTerminal) {
        return audit;
    }

    await db.run(
        'UPDATE audits SET statut_global = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
        ['TERMINE', audit.id]
    );

    return db.get('SELECT * FROM audits WHERE id = ?', [audit.id]);
}
