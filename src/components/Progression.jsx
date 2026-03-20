import React, { useState, useEffect } from 'react';
import {
    BarChart3,
    Hourglass,
    RefreshCw,
    Clock,
    ExternalLink,
    Bot,
    PlaySquare,
    Trash2
} from 'lucide-react';
import { io } from 'socket.io-client';

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

const SUCCESS_STEP_STATUSES = new Set([
    'SUCCESS',
    'SUCCES',
    'WARNING',
    'FAIT'
]);

const STEP_LABELS = {
    robots_txt: 'Fichier robots.txt',
    sitemap: 'Plan du site',
    logo: 'Logo',
    ami_responsive: 'Version responsive',
    responsive_menu_mobile_1: 'Menu mobile 1',
    responsive_menu_mobile_2: 'Menu mobile 2',
    ssl_labs: 'Sécurité SSL',
    psi_mobile: 'Performance mobile',
    psi_desktop: 'Performance desktop',
    sheet_images: 'Poids des images',
    sheet_meme_title: 'Titres dupliqués',
    sheet_meta_desc_double: 'Meta descriptions dupliquées',
    sheet_doublons_h1: 'Doublons H1',
    sheet_h1_absente: 'H1 absente',
    sheet_h1_vides: 'H1 vides',
    sheet_h1_au_moins: 'Au moins une H1 vide',
    sheet_hn_pas_h1: 'Première balise Hn non H1',
    sheet_sauts_hn: 'Sauts de niveau Hn',
    sheet_hn_longue: 'Balises Hn trop longues',
    sheet_mots_body: 'Longueur des pages',
    sheet_meta_desc: 'Meta descriptions',
    sheet_balise_title: 'Balises title',
    plan_synthese: 'Plan d’action synthèse',
    plan_requetes: 'Plan d’action requêtes',
    plan_donnees_img: 'Plan d’action données images',
    plan_longueur: 'Plan d’action longueur des pages',
    gsc_sitemaps: 'Google Search Console - sitemaps',
    gsc_https: 'Google Search Console - HTTPS',
    gsc_performance: 'Google Search Console - performances',
    gsc_meilleure_requete: 'Google Search Console - meilleure requête',
    gsc_query_page_clicks_impressions: 'Google Search Console - requêtes et impressions',
    gsc_coverage: 'Google Search Console - couverture',
    gsc_indexation_image: 'Google Search Console - pages indexées',
    gsc_problemes_indexation: 'Google Search Console - problèmes d’indexation',
    gsc_top_pages: 'Google Search Console - top pages',
    mrm_profondeur: 'My Ranking Metrics - profondeur',
    ubersuggest_da: 'Ubersuggest - autorité du domaine',
    semrush_authority: 'Semrush - autorité du domaine',
    ahrefs_authority: 'Ahrefs - autorité du domaine',
    check_404: 'Pages 404',
    majestic_backlinks: 'Backlinks'
};

function isTerminalStepStatus(status) {
    return TERMINAL_STEP_STATUSES.has(String(status || '').toUpperCase());
}

function isSuccessfulStepStatus(status) {
    return SUCCESS_STEP_STATUSES.has(String(status || '').toUpperCase());
}

function getStepLabel(stepKey) {
    return STEP_LABELS[stepKey] || stepKey.replace(/_/g, ' ');
}

function getAuditStatusLabel(status) {
    switch (String(status || '').toUpperCase()) {
        case 'TERMINE':
            return 'Terminé';
        case 'ERREUR':
            return 'Terminé avec erreurs';
        case 'EN_COURS':
            return 'En cours';
        case 'EN_ATTENTE':
            return 'En attente';
        default:
            return status || 'Inconnu';
    }
}

function getStepStatusLabel(status) {
    switch (String(status || '').toUpperCase()) {
        case 'SUCCESS':
        case 'SUCCES':
        case 'FAIT':
            return 'Réussi';
        case 'WARNING':
            return 'Réussi avec réserve';
        case 'SKIP':
            return 'Non disponible';
        case 'FAILED':
        case 'ERROR':
        case 'ERREUR':
            return 'Erreur';
        case 'EN_COURS':
            return 'En cours';
        case 'IA_EN_COURS':
            return 'Analyse en cours';
        case 'EN_ATTENTE':
            return 'En attente';
        default:
            return status || 'Inconnu';
    }
}

function parseStepMessage(result) {
    if (!result) return '';

    try {
        const parsed = JSON.parse(result);
        if (typeof parsed === 'string') {
            return parsed.trim();
        }
        if (parsed && typeof parsed === 'object') {
            if (typeof parsed.details === 'string') return parsed.details.trim();
            if (typeof parsed.message === 'string') return parsed.message.trim();
        }
    } catch { }

    return String(result).replace(/^"|"$/g, '').trim();
}

function simplifyReason(message) {
    const text = String(message || '').trim();
    if (!text) return '';

    if (/session google/i.test(text) || /redirigé vers login/i.test(text)) {
        return 'Connexion Google expirée';
    }
    if (/onglet .*introuvable/i.test(text) || /^onglet introuvable$/i.test(text)) {
        return 'Onglet manquant dans le Google Sheet';
    }
    if (/aucun match|aucune donnée/i.test(text)) {
        return 'Aucune donnée exploitable trouvée';
    }
    if (/lien google sheet plan d'action non fourni/i.test(text)) {
        return 'Lien du plan d’action manquant';
    }
    if (/lien google sheet audit non fourni|lien google sheet non fourni/i.test(text)) {
        return 'Lien Google Sheet manquant';
    }
    if (/session mrm/i.test(text)) {
        return 'Connexion My Ranking Metrics indisponible';
    }
    if (/session ubersuggest/i.test(text)) {
        return 'Connexion Ubersuggest indisponible';
    }
    if (/capture .* non générée/i.test(text)) {
        return 'Capture non générée';
    }

    return text.charAt(0).toUpperCase() + text.slice(1);
}

function buildAuditSummary(steps, auditStatus) {
    if (!steps?.length) return null;

    const total = steps.length;
    const completed = steps.filter((step) => isTerminalStepStatus(step.statut)).length;
    const successCount = steps.filter((step) => isSuccessfulStepStatus(step.statut)).length;
    const skippedCount = steps.filter((step) => String(step.statut || '').toUpperCase() === 'SKIP').length;
    const failedCount = steps.filter((step) => ['FAILED', 'ERROR', 'ERREUR'].includes(String(step.statut || '').toUpperCase())).length;
    const unavailableCount = skippedCount + failedCount;
    const groupedReasons = new Map();

    for (const step of steps) {
        const normalizedStatus = String(step.statut || '').toUpperCase();
        if (!['SKIP', 'FAILED', 'ERROR', 'ERREUR'].includes(normalizedStatus)) {
            continue;
        }

        const reason = simplifyReason(parseStepMessage(step.resultat)) || 'Raison non précisée';
        const currentCount = groupedReasons.get(reason) || 0;
        groupedReasons.set(reason, currentCount + 1);
    }

    const topReasons = Array.from(groupedReasons.entries())
        .map(([label, count]) => ({ label, count }))
        .sort((left, right) => right.count - left.count)
        .slice(0, 3);

    if (completed === total && !['TERMINE', 'ERREUR'].includes(String(auditStatus || '').toUpperCase())) {
        return {
            variant: 'info',
            title: 'Traitement terminé, mise à jour en cours',
            description: 'Toutes les étapes sont finalisées. Le statut global est en cours de synchronisation.',
            topReasons
        };
    }

    if (completed < total) {
        return {
            variant: 'info',
            title: 'Audit en cours',
            description: `${completed} étape${completed > 1 ? 's' : ''} finalisée${completed > 1 ? 's' : ''} sur ${total}.`,
            topReasons
        };
    }

    if (unavailableCount > 0) {
        return {
            variant: 'warning',
            title: 'Audit terminé avec des données partielles',
            description: `${successCount} élément${successCount > 1 ? 's' : ''} récupéré${successCount > 1 ? 's' : ''}. ${unavailableCount} élément${unavailableCount > 1 ? 's n’ont' : ' n’a'} pas pu être fourni${unavailableCount > 1 ? 's' : ''}.`,
            topReasons
        };
    }

    return {
        variant: 'success',
        title: 'Audit terminé',
        description: 'Toutes les données prévues ont été récupérées.',
        topReasons: []
    };
}

const Progression = ({ onOpenSlides }) => {
    const [audits, setAudits] = useState([]);
    const [activeAudit, setActiveAudit] = useState(null);
    const [loading, setLoading] = useState(true);
    const [deletingAuditId, setDeletingAuditId] = useState(null);

    const fetchAudits = async () => {
        try {
            const response = await fetch('/api/audits', {
                credentials: 'include'
            });
            if (response.ok) {
                const data = await response.json();
                setAudits(data);
                if (data.length > 0 && !activeAudit) {
                    fetchAuditDetails(data[0].id);
                }
            }
        } catch (err) {
            console.error('Err audits:', err);
        } finally {
            setLoading(false);
        }
    };

    const fetchAuditDetails = async (id) => {
        try {
            const response = await fetch(`/api/audits/${id}`, {
                credentials: 'include'
            });
            if (response.ok) {
                const data = await response.json();
                setActiveAudit(data);
            }
        } catch (err) {
            console.error('Err details:', err);
        }
    };

    const handleDeleteAudit = async (audit) => {
        if (!audit) return;

        const confirmDelete = window.confirm(
            `Supprimer définitivement l'audit "${audit.nom_site}" ?`
        );

        if (!confirmDelete) {
            return;
        }

        setDeletingAuditId(audit.id);

        try {
            const response = await fetch(`/api/audits/${audit.id}`, {
                method: 'DELETE',
                credentials: 'include'
            });

            const data = await response.json().catch(() => ({}));
            if (!response.ok) {
                throw new Error(data.error || 'Impossible de supprimer cet audit');
            }

            const updatedAudits = audits.filter((item) => item.id !== audit.id);
            setAudits(updatedAudits);

            if (activeAudit?.id === audit.id) {
                const nextAudit = updatedAudits[0] || null;
                if (nextAudit) {
                    fetchAuditDetails(nextAudit.id);
                } else {
                    setActiveAudit(null);
                }
            }
        } catch (err) {
            window.alert(err.message || 'Impossible de supprimer cet audit');
        } finally {
            setDeletingAuditId(null);
        }
    };

    const socketRef = React.useRef(null);

    useEffect(() => {
        fetchAudits();

        socketRef.current = io('/', {
            path: '/socket.io',
            withCredentials: true,
            transports: ['polling', 'websocket']
        });

        const socket = socketRef.current;

        socket.on('connect', () => {
            console.log('Socket connecté:', socket.id);
        });

        socket.on('audit:created', (newAudit) => {
            setAudits(prev => {
                const exists = prev.find(a => a.id === newAudit.id);
                if (exists) return prev;
                return [newAudit, ...prev];
            });
            if (!activeAudit) fetchAuditDetails(newAudit.id);
        });

        socket.on('audit:update', (updatedAudit) => {
            setAudits(prev => {
                const exists = prev.some(a => a.id === updatedAudit.id);
                if (!exists) return [updatedAudit, ...prev];
                return prev.map(a => a.id === updatedAudit.id ? { ...a, ...updatedAudit } : a);
            });

            setActiveAudit(prev => {
                if (prev?.id !== updatedAudit.id) return prev;
                return {
                    ...prev,
                    ...updatedAudit,
                    steps: updatedAudit.steps || prev.steps
                };
            });
        });

        socket.on('step:update', ({ auditId, step }) => {
            setActiveAudit(prev => {
                if (prev?.id !== auditId) return prev;
                return {
                    ...prev,
                    steps: prev.steps.map(s => s.step_key === step.step_key ? { ...s, ...step } : s)
                };
            });
        });

        socket.on('audit:deleted', ({ id }) => {
            setAudits((prev) => prev.filter((audit) => audit.id !== id));
            setActiveAudit((prev) => (prev?.id === id ? null : prev));
        });

        return () => socket.disconnect();
    }, []);

    // Effect to join the specific audit room whenever activeAudit changes or socket reconnects
    useEffect(() => {
        const socket = socketRef.current;
        if (socket && activeAudit?.id) {
            console.log('Joining audit room:', activeAudit.id);
            socket.emit('join-audit', activeAudit.id);
        }
    }, [activeAudit?.id]);

    const getStepIcon = (stepKey, status) => {
        const s = status?.toUpperCase();
        const isPending = s === 'EN_ATTENTE' || !s;
        const color = isPending ? 'text-slate-500' :
            (s === 'SUCCESS' || s === 'SUCCES' || s === 'FAIT' ? 'text-green-400' :
                (s === 'SKIP' ? 'text-amber-500' :
                    (s === 'FAILED' || s === 'ERROR' || s === 'ERREUR' ? 'text-red-400' : 'text-blue-400')));

        const icons = {
            robots_txt: Hourglass,
            sitemap: Hourglass,
            logo: Bot,
            psi_mobile: Hourglass,
            psi_desktop: Hourglass,
            ami_responsive: Hourglass,
            ssl_labs: Hourglass,
            semrush: Hourglass,
            ahrefs: Hourglass,
            ubersuggest: Hourglass,
            sheets_audit: Hourglass,
            sheets_plan: Hourglass,
            gsc: Hourglass,
            mrm: Hourglass
        };

        const IconComponent = icons[stepKey] || Hourglass;

        if (s === 'EN_COURS') return <RefreshCw className={`w-6 h-6 ${color} animate-spin`} />;
        if (s === 'IA_EN_COURS') return <Bot className={`w-6 h-6 ${color} animate-pulse`} />;

        return <IconComponent className={`w-6 h-6 ${color}`} />;
    };

    const StepItem = ({ step }) => {
        const normalizedStatus = step.statut?.toUpperCase();
        const stepMessage = parseStepMessage(step.resultat);
        const displayMessage = normalizedStatus === 'SKIP' || ['FAILED', 'ERROR', 'ERREUR'].includes(normalizedStatus)
            ? simplifyReason(stepMessage)
            : stepMessage;

        return (
        <div className="flex flex-col p-4 rounded-xl border border-slate-200 bg-white/80 hover:bg-white transition-all group gap-2 shadow-sm">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                    <div className={`w-12 h-12 rounded-xl flex items-center justify-center bg-slate-50 border border-slate-200 group-hover:border-blue-300 transition-all ${['SUCCESS', 'SUCCES', 'FAIT'].includes(normalizedStatus) ? 'bg-green-50 border-green-200' :
                        ['SKIP'].includes(normalizedStatus) ? 'bg-amber-50 border-amber-200' :
                            ['FAILED', 'ERROR', 'ERREUR'].includes(normalizedStatus) ? 'bg-rose-50 border-rose-200' : ''
                        }`}>
                        {getStepIcon(step.step_key, step.statut)}
                    </div>
                    <div>
                        <h4 className="font-semibold text-sm text-slate-800 leading-none mb-1">{getStepLabel(step.step_key)}</h4>
                        <div className="flex items-center gap-2">
                            <span className={`text-[10px] font-bold uppercase tracking-tight px-1.5 py-0.5 rounded ${['SUCCESS', 'SUCCES', 'FAIT'].includes(normalizedStatus) ? 'bg-green-500/10 text-green-500' :
                                step.statut === 'EN_COURS' ? 'bg-blue-500/10 text-blue-400' :
                                    normalizedStatus === 'SKIP' ? 'bg-amber-500/10 text-amber-600' :
                                        ['FAILED', 'ERROR', 'ERREUR'].includes(normalizedStatus) ? 'bg-rose-500/10 text-rose-600' :
                                            'bg-slate-100 text-slate-500'
                                }`}>
                                {getStepStatusLabel(step.statut)}
                            </span>
                        </div>
                    </div>
                </div>
                <div className="flex items-center gap-4">
                    {step.output_cloudinary_url && (
                        <a href={step.output_cloudinary_url} target="_blank" rel="noreferrer" className="p-2 hover:bg-blue-500/10 rounded-lg text-blue-400 transition-all" title="Voir la capture">
                            <ExternalLink className="w-4 h-4" />
                        </a>
                    )}
                </div>
            </div>
            {displayMessage && (
                <div className="mt-1 pl-16">
                    <p className="text-[11px] text-slate-600 leading-relaxed bg-slate-50 p-2 rounded-lg border border-slate-200">
                        {displayMessage}
                    </p>
                </div>
            )}
        </div>
        );
    };

    if (loading) return <div className="py-20 text-center animate-pulse text-blue-600">Chargement des audits...</div>;

    const auditSummary = activeAudit ? buildAuditSummary(activeAudit.steps || [], activeAudit.statut_global) : null;

    return (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 h-full">
            {/* Sidebar: Audit List */}
            <div className="lg:col-span-1 space-y-4">
                <h3 className="text-sm font-bold text-slate-500 uppercase tracking-widest flex items-center gap-2">
                    <Clock className="w-4 h-4" /> Historique Récent
                </h3>
                <div className="space-y-3 max-h-[600px] overflow-auto pr-2">
                    {audits.map(audit => (
                        <button
                            key={audit.id}
                            onClick={() => fetchAuditDetails(audit.id)}
                            className={`w-full p-4 rounded-2xl border transition-all text-left group ${activeAudit?.id === audit.id
                                ? 'bg-blue-50 border-blue-200 ring-1 ring-blue-100'
                                : 'bg-white/80 border-slate-200 hover:border-slate-300 shadow-sm'
                                }`}
                        >
                            <div className="flex justify-between items-start mb-2">
                                <span className="font-bold text-slate-900 group-hover:text-blue-600 transition-colors truncate max-w-[150px]">
                                    {audit.nom_site}
                                </span>
                                <span className={`text-[10px] px-2 py-0.5 rounded-full ${audit.statut_global === 'TERMINE' ? 'bg-green-500/10 text-green-400' : 'bg-blue-500/10 text-blue-400'
                                    }`}>
                                    {getAuditStatusLabel(audit.statut_global)}
                                </span>
                            </div>
                            <p className="text-xs text-slate-500 truncate">{audit.url_site}</p>
                        </button>
                    ))}
                    {audits.length === 0 && <div className="text-slate-600 italic text-sm py-10">Aucun audit trouvé.</div>}
                </div>
            </div>

            {/* Main: Active Audit Details */}
            <div className="lg:col-span-2 space-y-6">
                {activeAudit ? (
                    <>
                        <div className="glass rounded-2xl p-6 border border-slate-200/80">
                            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-6">
                                <div>
                                    <h2 className="text-xl font-bold text-slate-900 flex items-center gap-2">
                                        {activeAudit.nom_site}
                                        <a href={activeAudit.url_site} target="_blank" rel="noreferrer" className="text-slate-400 hover:text-blue-500 transition-all">
                                            <ExternalLink className="w-4 h-4" />
                                        </a>
                                    </h2>
                                    <p className="text-sm text-slate-500 italic">Lancé le {new Date(activeAudit.created_at).toLocaleString()}</p>
                                </div>
                                <div className="flex gap-4">
                                    <button
                                        type="button"
                                        onClick={() => handleDeleteAudit(activeAudit)}
                                        disabled={deletingAuditId === activeAudit.id || ['EN_ATTENTE', 'EN_COURS'].includes(String(activeAudit.statut_global || '').toUpperCase())}
                                        className="inline-flex items-center justify-center gap-2 rounded-xl border border-rose-200 bg-white px-4 py-2 text-sm font-semibold text-rose-600 transition-all hover:bg-rose-50 disabled:cursor-not-allowed disabled:opacity-50"
                                        title={['EN_ATTENTE', 'EN_COURS'].includes(String(activeAudit.statut_global || '').toUpperCase())
                                            ? 'Suppression indisponible pendant le traitement'
                                            : 'Supprimer cet audit'}
                                    >
                                        {deletingAuditId === activeAudit.id ? (
                                            <RefreshCw className="w-4 h-4 animate-spin" />
                                        ) : (
                                            <Trash2 className="w-4 h-4" />
                                        )}
                                        Supprimer l’audit
                                    </button>
                                    <div className="text-center px-4 py-2 bg-white/85 rounded-xl border border-slate-200 shadow-sm">
                                        <p className="text-[10px] text-slate-500 uppercase">Progression</p>
                                        <p className="text-lg font-bold text-blue-600">
                                            {(() => {
                                                const total = activeAudit.steps?.length || 1;
                                                const completed = activeAudit.steps?.filter(s =>
                                                    isTerminalStepStatus(s.statut)
                                                ).length || 0;
                                                return Math.round((completed / total) * 100);
                                            })()}%
                                        </p>
                                    </div>
                                </div>
                            </div>

                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                {auditSummary && (
                                    <div className={`md:col-span-2 rounded-2xl px-5 py-4 border ${auditSummary.variant === 'success'
                                        ? 'border-emerald-200 bg-emerald-50/80'
                                        : auditSummary.variant === 'warning'
                                            ? 'border-amber-200 bg-amber-50/80'
                                            : 'border-blue-200 bg-blue-50/80'
                                        }`}>
                                        <p className="text-sm font-semibold text-slate-900">{auditSummary.title}</p>
                                        <p className="mt-1 text-sm text-slate-600">{auditSummary.description}</p>

                                        {auditSummary.topReasons.length > 0 && (
                                            <details className="mt-3 text-sm text-slate-700">
                                                <summary className="cursor-pointer font-medium">
                                                    Voir les raisons principales
                                                </summary>
                                                <div className="mt-2 space-y-1 text-slate-600">
                                                    {auditSummary.topReasons.map((reason) => (
                                                        <p key={reason.label}>
                                                            {reason.label} ({reason.count})
                                                        </p>
                                                    ))}
                                                </div>
                                            </details>
                                        )}
                                    </div>
                                )}

                                {activeAudit.statut_global === 'TERMINE' && (
                                    <div className="md:col-span-2 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 rounded-2xl border border-blue-200 bg-blue-50/80 px-5 py-4">
                                        <div>
                                            <p className="text-sm font-semibold text-slate-900">Audit terminé</p>
                                            <p className="text-sm text-slate-600">
                                                Passez à l’onglet Slides pour générer la présentation Google Slides.
                                            </p>
                                        </div>
                                        <button
                                            type="button"
                                            onClick={() => onOpenSlides?.()}
                                            className="inline-flex items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white transition-all hover:bg-blue-500 shadow-lg shadow-blue-200/80"
                                        >
                                            <PlaySquare className="w-4 h-4" />
                                            Générer la présentation
                                        </button>
                                    </div>
                                )}
                                {activeAudit.steps?.map(step => (
                                    <StepItem key={step.id} step={step} />
                                ))}
                            </div>
                        </div>
                    </>
                ) : (
                    <div className="glass rounded-2xl p-20 text-center border border-dashed border-slate-200">
                        <BarChart3 className="w-12 h-12 text-slate-400 mx-auto mb-4" />
                        <p className="text-slate-500">Sélectionnez un audit pour voir sa progression</p>
                    </div>
                )}
            </div>
        </div>
    );
};

export default Progression;
