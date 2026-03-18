import React, { useState, useEffect } from 'react';
import {
    BarChart3,
    Hourglass,
    RefreshCw,
    Clock,
    ExternalLink,
    Bot,
    PlaySquare
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

function isTerminalStepStatus(status) {
    return TERMINAL_STEP_STATUSES.has(String(status || '').toUpperCase());
}

const Progression = ({ onOpenSlides }) => {
    const [audits, setAudits] = useState([]);
    const [activeAudit, setActiveAudit] = useState(null);
    const [loading, setLoading] = useState(true);

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

    const StepItem = ({ step }) => (
        <div className="flex flex-col p-4 rounded-xl border border-slate-200 bg-white/80 hover:bg-white transition-all group gap-2 shadow-sm">
            <div className="flex items-center justify-between">
                <div className="flex items-center gap-4">
                    <div className={`w-12 h-12 rounded-xl flex items-center justify-center bg-slate-50 border border-slate-200 group-hover:border-blue-300 transition-all ${['SUCCESS', 'SUCCES', 'FAIT'].includes(step.statut?.toUpperCase()) ? 'bg-green-50 border-green-200' :
                        ['SKIP'].includes(step.statut?.toUpperCase()) ? 'bg-amber-50 border-amber-200' :
                            ['FAILED', 'ERROR', 'ERREUR'].includes(step.statut?.toUpperCase()) ? 'bg-rose-50 border-rose-200' : ''
                        }`}>
                        {getStepIcon(step.step_key, step.statut)}
                    </div>
                    <div>
                        <h4 className="font-semibold text-sm text-slate-800 capitalize leading-none mb-1">{step.step_key.replace(/_/g, ' ')}</h4>
                        <div className="flex items-center gap-2">
                            <span className={`text-[10px] font-bold uppercase tracking-tight px-1.5 py-0.5 rounded ${['SUCCESS', 'SUCCES', 'FAIT'].includes(step.statut?.toUpperCase()) ? 'bg-green-500/10 text-green-500' :
                                step.statut === 'EN_COURS' ? 'bg-blue-500/10 text-blue-400' :
                                    step.statut?.toUpperCase() === 'SKIP' ? 'bg-amber-500/10 text-amber-600' :
                                        ['FAILED', 'ERROR', 'ERREUR'].includes(step.statut?.toUpperCase()) ? 'bg-rose-500/10 text-rose-600' :
                                            'bg-slate-100 text-slate-500'
                                }`}>
                                {step.statut}
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
            {step.resultat && (
                <div className="mt-1 pl-16">
                    <p className="text-[11px] text-slate-600 leading-relaxed bg-slate-50 p-2 rounded-lg border border-slate-200">
                        {step.resultat.replace(/^"|"$/g, '')}
                    </p>
                </div>
            )}
        </div>
    );

    if (loading) return <div className="py-20 text-center animate-pulse text-blue-600">Chargement des audits...</div>;

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
                                    {audit.statut_global}
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
