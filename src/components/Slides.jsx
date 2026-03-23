import React, { useEffect, useState } from 'react';
import {
    AlertCircle,
    CheckCircle2,
    Clock,
    ExternalLink,
    FileSpreadsheet,
    Link2,
    PlaySquare,
    RefreshCw,
    X
} from 'lucide-react';

const SLIDES_STATUS_META = {
    NON_GENERE: {
        label: 'Non généré',
        className: 'bg-slate-100 text-slate-600 border-slate-200'
    },
    EN_COURS: {
        label: 'Génération en cours',
        className: 'bg-blue-50 text-blue-600 border-blue-200'
    },
    PRET: {
        label: 'Lien disponible',
        className: 'bg-emerald-50 text-emerald-600 border-emerald-200'
    },
    ERREUR: {
        label: 'Erreur',
        className: 'bg-rose-50 text-rose-600 border-rose-200'
    }
};

function formatDate(value) {
    if (!value) return null;
    return new Date(value).toLocaleString('fr-FR');
}

async function readJsonSafely(response) {
    const text = await response.text();
    if (!text) return {};

    try {
        return JSON.parse(text);
    } catch {
        return { error: text };
    }
}

function Slides() {
    const [audits, setAudits] = useState([]);
    const [loading, setLoading] = useState(true);
    const [refreshing, setRefreshing] = useState(false);
    const [submittingAuditId, setSubmittingAuditId] = useState(null);
    const [submittingActionPlanAuditId, setSubmittingActionPlanAuditId] = useState(null);
    const [reviewingAuditId, setReviewingAuditId] = useState(null);
    const [pageError, setPageError] = useState('');
    const [pageNotice, setPageNotice] = useState('');
    const [reviewPromptAuditId, setReviewPromptAuditId] = useState(null);
    const [dismissedReviewPromptKeys, setDismissedReviewPromptKeys] = useState([]);
    const [emailPromptAudit, setEmailPromptAudit] = useState(null);
    const [shareEmail, setShareEmail] = useState('');

    const applyAuditUpdate = (audit) => {
        if (!audit) return;
        setAudits((current) => current.map((item) => (item.id === audit.id ? audit : item)));
    };

    const applyAuditPatch = (auditId, patch) => {
        setAudits((current) =>
            current.map((item) => (item.id === auditId ? { ...item, ...patch } : item))
        );
    };

    const getReviewPromptKey = (audit) =>
        `${audit.id}:${audit.slides_generated_at || audit.google_slides_url || 'pending'}`;

    const fetchAudits = async ({ silent = false } = {}) => {
        if (silent) {
            setRefreshing(true);
        } else {
            setLoading(true);
        }

        try {
            const response = await fetch('/api/audits', {
                credentials: 'include'
            });

            const data = await readJsonSafely(response);
            if (!response.ok) {
                throw new Error(data.error || 'Impossible de charger les audits');
            }

            setAudits(data);
            setPageError('');
            if (!silent) {
                setPageNotice('');
            }
        } catch (err) {
            setPageNotice('');
            setPageError(err.message || 'Impossible de charger les audits');
        } finally {
            setLoading(false);
            setRefreshing(false);
        }
    };

    useEffect(() => {
        fetchAudits();
    }, []);

    useEffect(() => {
        const hasPendingDeliverable = audits.some(
            (audit) =>
                audit.slides_generation_status === 'EN_COURS' ||
                audit.action_plan_generation_status === 'EN_COURS'
        );

        if (!hasPendingDeliverable) {
            return undefined;
        }

        const intervalId = window.setInterval(() => {
            fetchAudits({ silent: true });
        }, 1000);

        return () => window.clearInterval(intervalId);
    }, [audits]);

    useEffect(() => {
        if (!reviewPromptAuditId) {
            return;
        }

        const currentAudit = audits.find((audit) => audit.id === reviewPromptAuditId);
        if (!currentAudit || !currentAudit.google_slides_url || currentAudit.slides_review_confirmed_at) {
            setReviewPromptAuditId(null);
        }
    }, [audits, reviewPromptAuditId]);

    useEffect(() => {
        if (reviewPromptAuditId) {
            return;
        }

        const candidate = audits.find((audit) => (
            audit.statut_global === 'TERMINE' &&
            audit.google_slides_url &&
            !audit.slides_review_confirmed_at &&
            !dismissedReviewPromptKeys.includes(getReviewPromptKey(audit))
        ));

        if (candidate) {
            setReviewPromptAuditId(candidate.id);
        }
    }, [audits, dismissedReviewPromptKeys, reviewPromptAuditId]);

    const handleGenerateSlides = async (audit) => {
        setSubmittingAuditId(audit.id);
        setPageError('');
        setPageNotice('');
        applyAuditPatch(audit.id, {
            slides_generation_status: 'EN_COURS',
            slides_generation_error: null,
            slides_review_confirmed_at: null,
            google_action_plan_url: null,
            action_plan_generation_status: 'NON_GENERE',
            action_plan_generation_error: null,
            action_plan_generated_at: null
        });

        try {
            const response = await fetch(`/api/audits/${audit.id}/generate-slides`, {
                method: 'POST',
                credentials: 'include'
            });

            const data = await readJsonSafely(response);
            if (!response.ok) {
                if (data.audit) applyAuditUpdate(data.audit);
                throw new Error(data.error || 'La génération du Google Slides a échoué');
            }

            if (data.audit) {
                applyAuditUpdate(data.audit);
            }

            setPageNotice(
                data.message ||
                (data.googleSlidesUrl
                    ? 'Google Slides généré avec succès.'
                    : 'La génération du Google Slides a été lancée.')
            );
        } catch (err) {
            applyAuditPatch(audit.id, {
                slides_generation_status: audit.slides_generation_status || 'NON_GENERE',
                slides_generation_error: audit.slides_generation_error || null,
                slides_review_confirmed_at: audit.slides_review_confirmed_at || null,
                google_action_plan_url: audit.google_action_plan_url || null,
                action_plan_generation_status: audit.action_plan_generation_status || 'NON_GENERE',
                action_plan_generation_error: audit.action_plan_generation_error || null,
                action_plan_generated_at: audit.action_plan_generated_at || null
            });
            setPageNotice('');
            setPageError(err.message || 'La génération du Google Slides a échoué');
        } finally {
            setSubmittingAuditId(null);
        }
    };

    const handleSlidesReviewConfirmation = async (audit, confirmed) => {
        setReviewingAuditId(audit.id);
        setPageError('');
        setPageNotice('');

        try {
            const response = await fetch(`/api/audits/${audit.id}/confirm-slides-review`, {
                method: confirmed ? 'POST' : 'DELETE',
                credentials: 'include'
            });

            const data = await readJsonSafely(response);
            if (!response.ok) {
                if (data.audit) applyAuditUpdate(data.audit);
                throw new Error(data.error || 'Impossible de mettre à jour la confirmation de relecture');
            }

            if (data.audit) {
                applyAuditUpdate(data.audit);
            }

            setPageNotice(
                data.message ||
                (confirmed
                    ? 'Relecture du Google Slides confirmée.'
                    : 'Confirmation de relecture retirée.')
            );
            return data.audit || { ...audit, slides_review_confirmed_at: confirmed ? new Date().toISOString() : null };
        } catch (err) {
            setPageNotice('');
            setPageError(err.message || 'Impossible de mettre à jour la confirmation de relecture');
            return null;
        } finally {
            setReviewingAuditId(null);
        }
    };

    const handleGenerateActionPlan = async (audit, email) => {
        setSubmittingActionPlanAuditId(audit.id);
        setPageError('');
        setPageNotice('');
        applyAuditPatch(audit.id, {
            action_plan_generation_status: 'EN_COURS',
            action_plan_generation_error: null
        });

        try {
            const response = await fetch(`/api/audits/${audit.id}/generate-action-plan`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ email })
            });

            const data = await readJsonSafely(response);
            if (!response.ok) {
                if (data.audit) applyAuditUpdate(data.audit);
                throw new Error(data.error || 'La génération du Google Sheet plan d’actions a échoué');
            }

            if (data.audit) {
                applyAuditUpdate(data.audit);
            }

            setPageNotice(
                data.message ||
                (data.googleActionPlanUrl
                    ? 'Google Sheet plan d’actions généré avec succès.'
                    : 'Le Google Sheet plan d’actions est en cours de génération.')
            );
        } catch (err) {
            applyAuditPatch(audit.id, {
                action_plan_generation_status: audit.action_plan_generation_status || 'NON_GENERE',
                action_plan_generation_error: audit.action_plan_generation_error || null,
                google_action_plan_url: audit.google_action_plan_url || null,
                action_plan_generated_at: audit.action_plan_generated_at || null
            });
            setPageNotice('');
            setPageError(err.message || 'La génération du Google Sheet plan d’actions a échoué');
        } finally {
            setSubmittingActionPlanAuditId(null);
        }
    };

    const dismissReviewPrompt = (audit) => {
        if (!audit) {
            setReviewPromptAuditId(null);
            return;
        }

        const promptKey = getReviewPromptKey(audit);
        setDismissedReviewPromptKeys((current) =>
            current.includes(promptKey) ? current : [...current, promptKey]
        );
        setReviewPromptAuditId(null);
    };

    const completedAudits = audits.filter((audit) => audit.statut_global === 'TERMINE');
    const pendingAudits = audits.filter((audit) => audit.statut_global !== 'TERMINE');
    const reviewPromptAudit = audits.find((audit) => audit.id === reviewPromptAuditId) || null;

    if (loading) {
        return <div className="py-20 text-center animate-pulse text-blue-600">Chargement des livrables...</div>;
    }

    return (
        <div className="space-y-8">
            <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
                <div>
                    <h3 className="text-xl font-semibold text-slate-900 mb-2">Livrables Module 2</h3>
                    <p className="text-sm text-slate-600 max-w-3xl">
                        Générez d’abord le Google Slides, validez sa relecture dans l’application,
                        puis lancez le Google Sheet plan d’actions client généré directement par le backend.
                    </p>
                </div>

                <button
                    type="button"
                    onClick={() => fetchAudits({ silent: true })}
                    disabled={refreshing}
                    className="inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl border border-slate-200 bg-white text-slate-700 hover:border-blue-200 hover:text-blue-600 transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
                >
                    <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
                    Actualiser
                </button>
            </div>

            {pageError && (
                <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700 flex items-start gap-3">
                    <AlertCircle className="w-5 h-5 mt-0.5 shrink-0" />
                    <span>{pageError}</span>
                </div>
            )}

            {pageNotice && (
                <div className="rounded-2xl border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-700 flex items-start gap-3">
                    <Clock className="w-5 h-5 mt-0.5 shrink-0" />
                    <span>{pageNotice}</span>
                </div>
            )}

            <div className="space-y-4">
                <div className="flex items-center gap-2 text-sm font-bold text-slate-500 uppercase tracking-widest">
                    <CheckCircle2 className="w-4 h-4" />
                    Audits terminés
                </div>

                {completedAudits.length === 0 ? (
                    <div className="glass rounded-2xl p-10 border border-dashed border-slate-200 text-center text-slate-500">
                        Aucun audit terminé pour le moment. Le bouton Slides sera disponible une fois l’audit fini.
                    </div>
                ) : (
                    <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
                        {completedAudits.map((audit) => {
                            const slidesStatus = audit.slides_generation_status || 'NON_GENERE';
                            const slidesMeta = SLIDES_STATUS_META[slidesStatus] || SLIDES_STATUS_META.NON_GENERE;
                            const actionPlanStatus = audit.action_plan_generation_status || 'NON_GENERE';
                            const actionPlanMeta = SLIDES_STATUS_META[actionPlanStatus] || SLIDES_STATUS_META.NON_GENERE;
                            const isSubmitting = submittingAuditId === audit.id;
                            const isGenerating = slidesStatus === 'EN_COURS';
                            const isActionPlanSubmitting = submittingActionPlanAuditId === audit.id;
                            const isActionPlanGenerating = actionPlanStatus === 'EN_COURS';
                            const isReviewing = reviewingAuditId === audit.id;
                            const hasSlidesLink = Boolean(audit.google_slides_url);
                            const hasSlidesReviewConfirmation = Boolean(audit.slides_review_confirmed_at);
                            const hasActionPlanLink = Boolean(audit.google_action_plan_url);

                            return (
                                <div key={audit.id} className="glass rounded-2xl p-6 border border-slate-200/80 shadow-sm">
                                    <div className="flex flex-col gap-4">
                                        <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-3">
                                            <div>
                                                <h4 className="text-lg font-bold text-slate-900">{audit.nom_site}</h4>
                                                <p className="text-sm text-slate-500">{audit.url_site}</p>
                                                <p className="text-xs text-slate-400 mt-2">
                                                    Audit créé le {formatDate(audit.created_at)}
                                                </p>
                                            </div>

                                            <div className="flex flex-wrap gap-2">
                                                <span className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-emerald-700">
                                                    {audit.statut_global}
                                                </span>
                                                <span className={`inline-flex items-center rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-wide ${slidesMeta.className}`}>
                                                    Slides · {slidesMeta.label}
                                                </span>
                                                <span className={`inline-flex items-center rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-wide ${actionPlanMeta.className}`}>
                                                    Plan · {actionPlanMeta.label}
                                                </span>
                                            </div>
                                        </div>

                                        <div className="rounded-2xl border border-slate-200 bg-white/80 p-4">
                                            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">
                                                <Link2 className="w-4 h-4" />
                                                Lien Google Slides
                                            </div>

                                            {hasSlidesLink ? (
                                                <div className="space-y-3">
                                                    <a
                                                        href={audit.google_slides_url}
                                                        target="_blank"
                                                        rel="noreferrer"
                                                        className="block text-sm text-blue-600 hover:text-blue-700 break-all"
                                                    >
                                                        {audit.google_slides_url}
                                                    </a>
                                                    <div className="flex items-center gap-2 text-xs text-slate-500">
                                                        <Clock className="w-4 h-4" />
                                                        Dernière génération le {formatDate(audit.slides_generated_at)}
                                                    </div>
                                                </div>
                                            ) : (
                                                <p className="text-sm text-slate-500">
                                                    Aucun lien disponible pour cet audit.
                                                </p>
                                            )}
                                        </div>

                                        <div className={`rounded-2xl border p-4 ${hasSlidesReviewConfirmation
                                            ? 'border-emerald-200 bg-emerald-50/80'
                                            : 'border-amber-200 bg-amber-50/80'
                                            }`}>
                                            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">
                                                <CheckCircle2 className="w-4 h-4" />
                                                Validation client du Google Slides
                                            </div>

                                            {!hasSlidesLink ? (
                                                <p className="text-sm text-slate-600">
                                                    Cette validation sera disponible dès que le Google Slides sera généré. Une fenêtre de confirmation apparaîtra alors pour guider la suite.
                                                </p>
                                            ) : hasSlidesReviewConfirmation ? (
                                                <div className="space-y-3">
                                                    <p className="text-sm text-slate-700">
                                                        Le deck a été relu et validé dans l’application.
                                                    </p>
                                                    <div className="flex items-center gap-2 text-xs text-slate-500">
                                                        <Clock className="w-4 h-4" />
                                                        Validation confirmée le {formatDate(audit.slides_review_confirmed_at)}
                                                    </div>
                                                    <button
                                                        type="button"
                                                        onClick={() => handleSlidesReviewConfirmation(audit, false)}
                                                        disabled={isReviewing}
                                                        className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-xl border border-slate-200 bg-white text-slate-700 hover:border-blue-200 hover:text-blue-600 transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-sm"
                                                    >
                                                        {isReviewing ? <RefreshCw className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                                                        Retirer la validation
                                                    </button>
                                                </div>
                                            ) : (
                                                <div className="space-y-3">
                                                    <p className="text-sm text-slate-700">
                                                        Avant de préparer le Google Sheet plan d’actions client, confirmez ici que le Google Slides a bien été relu et ajusté si nécessaire.
                                                    </p>
                                                    <button
                                                        type="button"
                                                        onClick={() => handleSlidesReviewConfirmation(audit, true)}
                                                        disabled={isReviewing}
                                                        className="inline-flex items-center justify-center gap-2 px-4 py-2 rounded-xl bg-blue-600 text-white hover:bg-blue-500 transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-lg shadow-blue-200/80"
                                                    >
                                                        {isReviewing ? <RefreshCw className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                                                        Confirmer la relecture
                                                    </button>
                                                </div>
                                            )}
                                        </div>

                                        <div className={`rounded-2xl border p-4 ${hasSlidesReviewConfirmation
                                            ? 'border-blue-200 bg-blue-50/80'
                                            : 'border-slate-200 bg-slate-50/80'
                                            }`}>
                                            <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">
                                                <FileSpreadsheet className="w-4 h-4" />
                                                Google Sheet plan d’actions client
                                            </div>

                                            {!hasSlidesLink ? (
                                                <p className="text-sm text-slate-600">
                                                    Cette étape sera disponible après la génération du Google Slides.
                                                </p>
                                            ) : !hasSlidesReviewConfirmation ? (
                                                <div className="space-y-3">
                                                    <p className="text-sm text-slate-600">
                                                        En attente de validation du Google Slides par le client.
                                                    </p>
                                                    <p className="text-xs text-slate-500">
                                                        Le document contiendra la structure métier du cahier des charges: axe, action, description, priorité, impact, difficulté, données sources et commentaire.
                                                    </p>
                                                </div>
                                            ) : (
                                                <div className="space-y-3">
                                                    {hasActionPlanLink ? (
                                                        <>
                                                            <a
                                                                href={audit.google_action_plan_url}
                                                                target="_blank"
                                                                rel="noreferrer"
                                                                className="block text-sm text-blue-600 hover:text-blue-700 break-all"
                                                            >
                                                                {audit.google_action_plan_url}
                                                            </a>
                                                            <div className="flex items-center gap-2 text-xs text-slate-500">
                                                                <Clock className="w-4 h-4" />
                                                                Dernière génération le {formatDate(audit.action_plan_generated_at)}
                                                            </div>
                                                        </>
                                                    ) : (
                                                        <p className="text-sm text-slate-700">
                                                            Le Google Sheet client peut maintenant être généré directement par le backend.
                                                        </p>
                                                    )}

                                                    <div className="flex flex-col sm:flex-row gap-3">
                                                        <button
                                                            type="button"
                                                            onClick={() => { setShareEmail(''); setEmailPromptAudit(audit); }}
                                                            disabled={isActionPlanSubmitting || isActionPlanGenerating}
                                                            className="inline-flex items-center justify-center gap-2 px-5 py-3 rounded-xl bg-slate-900 text-white hover:bg-slate-800 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                                                        >
                                                            {isActionPlanSubmitting || isActionPlanGenerating ? (
                                                                <RefreshCw className="w-4 h-4 animate-spin" />
                                                            ) : (
                                                                <FileSpreadsheet className="w-4 h-4" />
                                                            )}
                                                            {isActionPlanGenerating
                                                                ? 'Génération en cours'
                                                                : hasActionPlanLink
                                                                    ? 'Mettre à jour le Google Sheet'
                                                                    : 'Générer le Google Sheet'}
                                                        </button>

                                                        {hasActionPlanLink && (
                                                            <a
                                                                href={audit.google_action_plan_url}
                                                                target="_blank"
                                                                rel="noreferrer"
                                                                className="inline-flex items-center justify-center gap-2 px-5 py-3 rounded-xl border border-slate-200 bg-white text-slate-700 hover:border-blue-200 hover:text-blue-600 transition-all shadow-sm"
                                                            >
                                                                <ExternalLink className="w-4 h-4" />
                                                                Ouvrir le Google Sheet
                                                            </a>
                                                        )}
                                                    </div>
                                                </div>
                                            )}
                                        </div>

                                        {audit.slides_generation_error && (
                                            <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                                                {audit.slides_generation_error}
                                            </div>
                                        )}

                                        {audit.action_plan_generation_error && (
                                            <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                                                {audit.action_plan_generation_error}
                                            </div>
                                        )}

                                        <div className="flex flex-col sm:flex-row gap-3">
                                            <button
                                                type="button"
                                                onClick={() => handleGenerateSlides(audit)}
                                                disabled={isSubmitting || isGenerating}
                                                className="btn-primary px-5 py-3 flex items-center justify-center gap-3 disabled:opacity-50 disabled:cursor-not-allowed"
                                            >
                                                {isSubmitting || isGenerating ? (
                                                    <RefreshCw className="w-4 h-4 animate-spin" />
                                                ) : (
                                                    <PlaySquare className="w-4 h-4" />
                                                )}
                                                {isGenerating
                                                    ? 'Génération en cours'
                                                    : hasSlidesLink
                                                        ? 'Mettre à jour le Google Slides'
                                                        : 'Générer le Google Slides'}
                                            </button>

                                            {hasSlidesLink && (
                                                <a
                                                    href={audit.google_slides_url}
                                                    target="_blank"
                                                    rel="noreferrer"
                                                    className="inline-flex items-center justify-center gap-2 px-5 py-3 rounded-xl border border-slate-200 bg-white text-slate-700 hover:border-blue-200 hover:text-blue-600 transition-all shadow-sm"
                                                >
                                                    <ExternalLink className="w-4 h-4" />
                                                    Ouvrir le deck
                                                </a>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>

            {pendingAudits.length > 0 && (
                <div className="space-y-4">
                    <div className="flex items-center gap-2 text-sm font-bold text-slate-500 uppercase tracking-widest">
                        <Clock className="w-4 h-4" />
                        Audits non terminés
                    </div>

                    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                        {pendingAudits.map((audit) => (
                            <div key={audit.id} className="rounded-2xl border border-slate-200 bg-white/70 px-5 py-4">
                                <div className="flex items-start justify-between gap-4">
                                    <div>
                                        <h4 className="font-semibold text-slate-900">{audit.nom_site}</h4>
                                        <p className="text-sm text-slate-500">{audit.url_site}</p>
                                    </div>
                                    <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-slate-600">
                                        {audit.statut_global}
                                    </span>
                                </div>
                                <p className="text-sm text-slate-500 mt-3">
                                    La génération du deck sera disponible quand toutes les variables de l’audit seront prêtes.
                                </p>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {emailPromptAudit && (
                <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-950/45 px-4">
                    <div className="w-full max-w-xl rounded-3xl border border-slate-200 bg-white p-6 shadow-2xl">
                        <div className="flex items-start justify-between gap-4">
                            <div>
                                <p className="text-xs font-semibold uppercase tracking-[0.25em] text-blue-600">
                                    Partage du document
                                </p>
                                <h4 className="mt-2 text-2xl font-semibold text-slate-900">
                                    Adresse e-mail du destinataire
                                </h4>
                            </div>
                            <button
                                type="button"
                                onClick={() => setEmailPromptAudit(null)}
                                className="rounded-xl p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700 transition-colors"
                                aria-label="Fermer"
                            >
                                <X className="w-5 h-5" />
                            </button>
                        </div>

                        <div className="mt-4 space-y-3 text-sm text-slate-600">
                            <p>
                                Le Google Sheet plan d'actions sera partagé en édition avec cette adresse e-mail.
                            </p>
                            <input
                                type="email"
                                value={shareEmail}
                                onChange={(e) => setShareEmail(e.target.value)}
                                placeholder="exemple@domaine.com"
                                className="w-full rounded-xl border border-slate-300 px-4 py-3 text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                                autoFocus
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter' && shareEmail.trim()) {
                                        const audit = emailPromptAudit;
                                        setEmailPromptAudit(null);
                                        handleGenerateActionPlan(audit, shareEmail.trim());
                                    }
                                }}
                            />
                        </div>

                        <div className="mt-6 flex flex-col-reverse sm:flex-row sm:justify-end gap-3">
                            <button
                                type="button"
                                onClick={() => setEmailPromptAudit(null)}
                                className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-200 px-4 py-3 text-slate-700 hover:border-slate-300 hover:bg-slate-50 transition-all"
                            >
                                Annuler
                            </button>

                            <button
                                type="button"
                                disabled={!shareEmail.trim()}
                                onClick={() => {
                                    const audit = emailPromptAudit;
                                    setEmailPromptAudit(null);
                                    handleGenerateActionPlan(audit, shareEmail.trim());
                                }}
                                className="inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-3 text-white hover:bg-blue-500 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                <FileSpreadsheet className="w-4 h-4" />
                                Générer et partager
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {reviewPromptAudit && (
                <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-950/45 px-4">
                    <div className="w-full max-w-xl rounded-3xl border border-slate-200 bg-white p-6 shadow-2xl">
                        <div className="flex items-start justify-between gap-4">
                            <div>
                                <p className="text-xs font-semibold uppercase tracking-[0.25em] text-blue-600">
                                    Étape suivante
                                </p>
                                <h4 className="mt-2 text-2xl font-semibold text-slate-900">
                                    Avez-vous terminé l’édition du Google Slides ?
                                </h4>
                            </div>

                            <button
                                type="button"
                                onClick={() => dismissReviewPrompt(reviewPromptAudit)}
                                className="rounded-xl p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700 transition-colors"
                                aria-label="Fermer"
                            >
                                <X className="w-5 h-5" />
                            </button>
                        </div>

                        <div className="mt-4 space-y-3 text-sm text-slate-600">
                            <p>
                                Une fois le deck relu et ajusté, vous pourrez générer le Google Sheet plan d’actions client.
                            </p>
                            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
                                <p className="font-medium text-slate-900">{reviewPromptAudit.nom_site}</p>
                                <p className="mt-1 text-xs text-slate-500 break-all">{reviewPromptAudit.google_slides_url}</p>
                            </div>
                        </div>

                        <div className="mt-6 flex flex-col-reverse sm:flex-row sm:justify-end gap-3">
                            <button
                                type="button"
                                onClick={() => dismissReviewPrompt(reviewPromptAudit)}
                                className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-200 px-4 py-3 text-slate-700 hover:border-slate-300 hover:bg-slate-50 transition-all"
                            >
                                Je continue l’édition
                            </button>

                            <button
                                type="button"
                                onClick={async () => {
                                    const confirmedAudit = await handleSlidesReviewConfirmation(reviewPromptAudit, true);
                                    if (confirmedAudit) {
                                        setReviewPromptAuditId(null);
                                    }
                                }}
                                disabled={reviewingAuditId === reviewPromptAudit.id}
                                className="inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-3 text-white hover:bg-blue-500 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {reviewingAuditId === reviewPromptAudit.id ? (
                                    <RefreshCw className="w-4 h-4 animate-spin" />
                                ) : (
                                    <CheckCircle2 className="w-4 h-4" />
                                )}
                                Oui, j’ai terminé
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}

export default Slides;
