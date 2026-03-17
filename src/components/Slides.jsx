import React, { useEffect, useState } from 'react';
import {
    AlertCircle,
    CheckCircle2,
    Clock,
    ExternalLink,
    Link2,
    PlaySquare,
    RefreshCw
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
    const [pageError, setPageError] = useState('');

    const applyAuditUpdate = (audit) => {
        if (!audit) return;
        setAudits((current) => current.map((item) => (item.id === audit.id ? audit : item)));
    };

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
        } catch (err) {
            setPageError(err.message || 'Impossible de charger les audits');
        } finally {
            setLoading(false);
            setRefreshing(false);
        }
    };

    useEffect(() => {
        fetchAudits();
    }, []);

    const handleGenerateSlides = async (audit) => {
        setSubmittingAuditId(audit.id);
        setPageError('');

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

            applyAuditUpdate(data.audit);
        } catch (err) {
            setPageError(err.message || 'La génération du Google Slides a échoué');
        } finally {
            setSubmittingAuditId(null);
        }
    };

    const completedAudits = audits.filter((audit) => audit.statut_global === 'TERMINE');
    const pendingAudits = audits.filter((audit) => audit.statut_global !== 'TERMINE');

    if (loading) {
        return <div className="py-20 text-center animate-pulse text-blue-600">Chargement des decks Slides...</div>;
    }

    return (
        <div className="space-y-8">
            <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
                <div>
                    <h3 className="text-xl font-semibold text-slate-900 mb-2">Génération des Google Slides</h3>
                    <p className="text-sm text-slate-600 max-w-3xl">
                        Lancez la création ou la mise à jour du deck depuis ici.
                        Le lien Google Slides sera disponible une fois la génération terminée, ce qui peut prendre quelques minutes.
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
                            const isSubmitting = submittingAuditId === audit.id;
                            const hasSlidesLink = Boolean(audit.google_slides_url);

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
                                                    {slidesMeta.label}
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

                                        {audit.slides_generation_error && (
                                            <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
                                                {audit.slides_generation_error}
                                            </div>
                                        )}

                                        <div className="flex flex-col sm:flex-row gap-3">
                                            <button
                                                type="button"
                                                onClick={() => handleGenerateSlides(audit)}
                                                disabled={isSubmitting}
                                                className="btn-primary px-5 py-3 flex items-center justify-center gap-3 disabled:opacity-50 disabled:cursor-not-allowed"
                                            >
                                                {isSubmitting ? (
                                                    <RefreshCw className="w-4 h-4 animate-spin" />
                                                ) : (
                                                    <PlaySquare className="w-4 h-4" />
                                                )}
                                                {hasSlidesLink ? 'Mettre à jour le Google Slides' : 'Générer le Google Slides'}
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
        </div>
    );
}

export default Slides;
