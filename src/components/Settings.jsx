import React, { useEffect, useState } from 'react';
import {
    AlertCircle,
    ArrowRight,
    CheckCircle2,
    Eye,
    EyeOff,
    Globe,
    Lock,
    LogIn,
    LogOut,
    RefreshCw,
    Save,
    Settings as SettingsIcon,
    Shield,
    Sparkles,
    Trash2,
    Zap
} from 'lucide-react';

const SERVICE_ORDER = ['google', 'mrm', 'ubersuggest'];

const serviceLabels = {
    google: 'Google Search Console',
    mrm: 'My Ranking Metrics',
    ubersuggest: 'Ubersuggest'
};

const formatConnectionDate = (value) => {
    if (!value) return 'Date indisponible';
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime())
        ? 'Date indisponible'
        : parsed.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
};

const StatusBadge = ({ active, label }) => (
    <div className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] ${
        active
            ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
            : 'border-amber-200 bg-amber-50 text-amber-700'
    }`}>
        {active ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertCircle className="h-3.5 w-3.5" />}
        <span>{label}</span>
    </div>
);

const MessageBanner = ({ message, className = '' }) => {
    if (!message) return null;

    const toneClasses = message.type === 'success'
        ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
        : message.type === 'info'
            ? 'border-sky-200 bg-sky-50 text-sky-700'
            : 'border-rose-200 bg-rose-50 text-rose-700';

    const Icon = message.type === 'success'
        ? CheckCircle2
        : message.type === 'info'
            ? Sparkles
            : AlertCircle;

    return (
        <div className={`flex items-start gap-3 rounded-2xl border px-4 py-3 text-sm ${toneClasses} ${className}`}>
            <Icon className="mt-0.5 h-4.5 w-4.5 shrink-0" />
            <span>{message.text}</span>
        </div>
    );
};

const Settings = () => {
    const [connections, setConnections] = useState([]);
    const [credentialInputs, setCredentialInputs] = useState({
        mrm: { email: '', password: '' },
        ubersuggest: { email: '', password: '' }
    });
    const [sessionInputs, setSessionInputs] = useState({ ubersuggest: '' });
    const [showPassword, setShowPassword] = useState({ mrm: false, ubersuggest: false });
    const [saving, setSaving] = useState({});
    const [testing, setTesting] = useState({});
    const [importingSessions, setImportingSessions] = useState({});
    const [resettingConnections, setResettingConnections] = useState(false);
    const [refreshingStatus, setRefreshingStatus] = useState(false);
    const [showSessionImport, setShowSessionImport] = useState({ ubersuggest: false });
    const [messages, setMessages] = useState({});

    const fetchStatus = async ({ silent = false } = {}) => {
        if (!silent) setRefreshingStatus(true);
        try {
            const token = localStorage.getItem('token');
            const res = await fetch('/api/credentials/status', {
                headers: { Authorization: `Bearer ${token}` },
                credentials: 'include'
            });
            if (res.ok) {
                setConnections(await res.json());
            }
        } catch {
        } finally {
            if (!silent) setRefreshingStatus(false);
        }
    };

    useEffect(() => {
        fetchStatus({ silent: true });

        const params = new URLSearchParams(window.location.search);
        const googleAuth = params.get('google_auth');
        if (googleAuth === 'success') {
            setMessages((current) => ({
                ...current,
                google: { type: 'success', text: 'Compte Google connecte avec succes.' }
            }));
            window.history.replaceState({}, '', window.location.pathname);
        } else if (googleAuth === 'error') {
            const reason = params.get('reason') || 'unknown';
            const reasons = {
                denied: 'Vous avez refuse la connexion.',
                no_refresh_token: 'Aucun token obtenu. Revoquez l acces dans votre compte Google puis reconnectez-vous.',
                expired: 'Le lien a expire. Veuillez reessayer.',
                server_error: 'Erreur serveur. Veuillez reessayer.'
            };
            setMessages((current) => ({
                ...current,
                google: { type: 'error', text: reasons[reason] || 'Erreur inconnue.' }
            }));
            window.history.replaceState({}, '', window.location.pathname);
        }
    }, []);

    const getServiceStatus = (service) => connections.find((connection) => connection.service === service);

    const resetLocalConnectionInputs = () => {
        setCredentialInputs({
            mrm: { email: '', password: '' },
            ubersuggest: { email: '', password: '' }
        });
        setSessionInputs({ ubersuggest: '' });
        setShowPassword({ mrm: false, ubersuggest: false });
        setShowSessionImport({ ubersuggest: false });
    };

    const saveCredentials = async (service) => {
        const { email, password } = credentialInputs[service];
        if (!email?.trim() || !password?.trim()) {
            setMessages((current) => ({
                ...current,
                [service]: { type: 'error', text: 'Email et mot de passe requis.' }
            }));
            return;
        }

        setSaving((current) => ({ ...current, [service]: true }));
        setMessages((current) => ({ ...current, [service]: null }));

        try {
            const token = localStorage.getItem('token');
            const res = await fetch(`/api/credentials/${service}`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                credentials: 'include',
                body: JSON.stringify({ email: email.trim(), password })
            });
            const data = await res.json();
            if (res.ok) {
                setMessages((current) => ({
                    ...current,
                    [service]: { type: 'success', text: 'Identifiants enregistres et chiffres.' }
                }));
                setCredentialInputs((current) => ({
                    ...current,
                    [service]: { email: '', password: '' }
                }));
                setShowSessionImport((current) => ({ ...current, [service]: false }));
                setSessionInputs((current) => ({ ...current, [service]: '' }));
                await fetchStatus({ silent: true });
            } else {
                setMessages((current) => ({
                    ...current,
                    [service]: { type: 'error', text: data.error || 'Impossible d enregistrer ces identifiants.' }
                }));
            }
        } catch {
            setMessages((current) => ({
                ...current,
                [service]: { type: 'error', text: 'Erreur reseau.' }
            }));
        } finally {
            setSaving((current) => ({ ...current, [service]: false }));
        }
    };

    const deleteCredentials = async (service) => {
        if (!window.confirm(`Supprimer la connexion ${serviceLabels[service] || service} ?`)) return;
        try {
            const token = localStorage.getItem('token');
            await fetch(`/api/credentials/${service}`, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${token}` },
                credentials: 'include'
            });
            await fetch(`/api/sessions/delete/${service}`, {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${token}` },
                credentials: 'include'
            }).catch(() => {});
            setShowSessionImport((current) => ({ ...current, [service]: false }));
            setSessionInputs((current) => ({ ...current, [service]: '' }));
            setMessages((current) => ({
                ...current,
                [service]: { type: 'success', text: 'Connexion supprimee.' }
            }));
            await fetchStatus({ silent: true });
        } catch {
            setMessages((current) => ({
                ...current,
                [service]: { type: 'error', text: 'Impossible de supprimer cette connexion.' }
            }));
        }
    };

    const testCredentials = async (service) => {
        setTesting((current) => ({ ...current, [service]: true }));
        setMessages((current) => ({ ...current, [service]: null }));
        try {
            const token = localStorage.getItem('token');
            const res = await fetch(`/api/credentials/test/${service}`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}` },
                credentials: 'include'
            });
            const data = await res.json();
            setMessages((current) => ({
                ...current,
                [service]: data.success
                    ? { type: 'success', text: data.message }
                    : { type: 'error', text: data.error || 'Test echoue.' }
            }));
        } catch {
            setMessages((current) => ({
                ...current,
                [service]: { type: 'error', text: 'Erreur reseau.' }
            }));
        } finally {
            setTesting((current) => ({ ...current, [service]: false }));
        }
    };

    const resetConnectedAccounts = async () => {
        const confirmed = window.confirm(
            'Reinitialiser tous les comptes connectes ? Cela supprimera les connexions Google Search Console, MRM et Ubersuggest enregistrees pour cet administrateur.'
        );
        if (!confirmed) return;

        setResettingConnections(true);
        setMessages((current) => ({ ...current, reset: null }));

        try {
            const token = localStorage.getItem('token');
            const res = await fetch('/api/connections/reset', {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${token}` },
                credentials: 'include'
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                throw new Error(data.error || 'Impossible de reinitialiser les comptes connectes.');
            }
            resetLocalConnectionInputs();
            setMessages((current) => ({
                ...current,
                reset: { type: 'success', text: data.message || 'Tous les comptes connectes ont ete reinitialises.' }
            }));
            await fetchStatus({ silent: true });
        } catch (err) {
            setMessages((current) => ({
                ...current,
                reset: { type: 'error', text: err.message || 'Impossible de reinitialiser les comptes connectes.' }
            }));
        } finally {
            setResettingConnections(false);
        }
    };

    const beginGoogleSessionConnect = (service, loginUrl) => {
        if (service === 'ubersuggest' && getServiceStatus('google')?.status !== 'active') {
            setMessages((current) => ({
                ...current,
                [service]: {
                    type: 'error',
                    text: 'Connectez d abord Google Search Console, puis utilisez le meme compte Google pour ouvrir Ubersuggest.'
                }
            }));
            return;
        }

        window.open(loginUrl, '_blank', 'noopener,noreferrer');
        setShowSessionImport((current) => ({ ...current, [service]: true }));
        setMessages((current) => ({
            ...current,
            [service]: {
                type: 'info',
                text: 'Connectez-vous a Ubersuggest dans l onglet ouvert, puis collez ici le JSON de cookies pour enregistrer la session.'
            }
        }));
    };

    const saveSession = async (service) => {
        const rawValue = sessionInputs[service];
        if (!rawValue?.trim()) {
            setMessages((current) => ({
                ...current,
                [service]: { type: 'error', text: 'Collez le JSON de cookies avant de valider la session.' }
            }));
            return;
        }

        let cookies;
        try {
            const parsed = JSON.parse(rawValue);
            cookies = Array.isArray(parsed) ? parsed : parsed?.cookies;
            if (!Array.isArray(cookies)) throw new Error('invalid_format');
        } catch {
            setMessages((current) => ({
                ...current,
                [service]: { type: 'error', text: 'Format invalide. Utilisez un tableau JSON ou un objet contenant "cookies".' }
            }));
            return;
        }

        setImportingSessions((current) => ({ ...current, [service]: true }));
        setMessages((current) => ({ ...current, [service]: null }));

        try {
            const token = localStorage.getItem('token');
            const res = await fetch(`/api/sessions/import/${service}`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                credentials: 'include',
                body: JSON.stringify({ cookies })
            });
            const data = await res.json();
            if (res.ok) {
                setMessages((current) => ({
                    ...current,
                    [service]: {
                        type: 'success',
                        text: service === 'ubersuggest'
                            ? 'Session Ubersuggest via Google enregistree et chiffree.'
                            : data.message
                    }
                }));
                setSessionInputs((current) => ({ ...current, [service]: '' }));
                setShowSessionImport((current) => ({ ...current, [service]: false }));
                await fetchStatus({ silent: true });
            } else {
                setMessages((current) => ({
                    ...current,
                    [service]: { type: 'error', text: data.error || 'Impossible d enregistrer la session.' }
                }));
            }
        } catch {
            setMessages((current) => ({
                ...current,
                [service]: { type: 'error', text: 'Erreur reseau.' }
            }));
        } finally {
            setImportingSessions((current) => ({ ...current, [service]: false }));
        }
    };

    const disconnectGoogle = async () => {
        if (!window.confirm('Deconnecter votre compte Google ?')) return;
        try {
            const token = localStorage.getItem('token');
            const res = await fetch('/api/credentials/google', {
                method: 'DELETE',
                headers: { Authorization: `Bearer ${token}` },
                credentials: 'include'
            });
            if (res.ok) {
                setMessages((current) => ({
                    ...current,
                    google: { type: 'success', text: 'Compte Google deconnecte.' }
                }));
                await fetchStatus({ silent: true });
            } else {
                const data = await res.json().catch(() => ({}));
                setMessages((current) => ({
                    ...current,
                    google: { type: 'error', text: data.error || 'Erreur lors de la deconnexion.' }
                }));
            }
        } catch {
            setMessages((current) => ({
                ...current,
                google: { type: 'error', text: 'Erreur reseau.' }
            }));
        }
    };

    const googleStatus = getServiceStatus('google');
    const mrmStatus = getServiceStatus('mrm');
    const ubersuggestStatus = getServiceStatus('ubersuggest');
    const connectedCount = SERVICE_ORDER.filter((service) => getServiceStatus(service)?.status === 'active').length;
    const googleConnected = googleStatus?.status === 'active';
    const mrmConnected = mrmStatus?.status === 'active';
    const ubersuggestConnected = ubersuggestStatus?.status === 'active';
    const usesGoogleSession = ubersuggestStatus?.auth_type === 'session' || ubersuggestStatus?.auth_type === 'cookie';

    const renderCredentialCard = ({ service, title, icon: Icon, loginUrl, description, allowGoogleSession = false }) => {
        const status = getServiceStatus(service);
        const isConnected = status?.status === 'active';
        const isPasswordAuth = status?.auth_type === 'password';
        const isSessionAuth = status?.auth_type === 'session' || status?.auth_type === 'cookie';
        const input = credentialInputs[service];
        const msg = messages[service];
        const sessionModeActive = allowGoogleSession && showSessionImport[service];

        return (
            <article className="settings-card rounded-[30px] p-6 lg:p-7">
                <div className="flex flex-col gap-5">
                    <div className="flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between">
                        <div className="space-y-4">
                            <div className="flex items-center gap-4">
                                <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-slate-200 bg-white text-slate-800 shadow-sm">
                                    <Icon className="h-6 w-6" />
                                </div>
                                <div>
                                    <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Service d audit</p>
                                    <h2 className="settings-display mt-1 text-2xl font-black text-slate-900">{title}</h2>
                                    <p className="mt-1 text-sm leading-6 text-slate-600">{description}</p>
                                </div>
                            </div>

                        </div>
                        <div className="flex flex-wrap items-center gap-3">
                            <StatusBadge active={isConnected} label={isConnected ? (isSessionAuth ? 'Session prete' : 'Connexion prete') : 'A configurer'} />
                            {isConnected && <div className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-600"><Zap className="h-3.5 w-3.5 text-sky-600" />{formatConnectionDate(status?.created_at)}</div>}
                        </div>
                    </div>

                    {isConnected && (
                        <div className="grid gap-3 lg:grid-cols-[1fr_auto]">
                            <div className={`rounded-2xl border px-4 py-4 ${isSessionAuth ? 'border-amber-200 bg-amber-50' : 'border-emerald-200 bg-emerald-50'}`}>
                                <div className="text-sm font-semibold text-slate-900">Connexion active</div>
                                <div className={`mt-1 text-sm ${isSessionAuth ? 'text-amber-700' : 'text-emerald-700'}`}>
                                    {isSessionAuth ? 'Session web enregistree.' : 'Identifiants valides enregistres.'}
                                </div>
                            </div>
                            <div className="flex flex-wrap gap-2">
                                <button type="button" onClick={() => deleteCredentials(service)} className="inline-flex items-center gap-2 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-600 transition-all hover:bg-rose-100">
                                    <Trash2 className="h-4 w-4" />
                                    Supprimer
                                </button>
                            </div>
                        </div>
                    )}

                    <div className="rounded-[26px] border border-slate-200/80 bg-white/85 p-5 shadow-[0_16px_40px_rgba(15,23,42,0.04)]">
                        {allowGoogleSession && (
                            <div className="mb-5 rounded-2xl border border-slate-200 bg-slate-100/90 p-1">
                                <div className="grid grid-cols-2 gap-1">
                                    <button type="button" onClick={() => setShowSessionImport((current) => ({ ...current, [service]: false }))} className={`rounded-[18px] px-3 py-2.5 text-sm font-semibold transition-all ${!sessionModeActive ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>Identifiants</button>
                                    <button type="button" onClick={() => setShowSessionImport((current) => ({ ...current, [service]: true }))} className={`rounded-[18px] px-3 py-2.5 text-sm font-semibold transition-all ${sessionModeActive ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>Via Google</button>
                                </div>
                            </div>
                        )}

                        {!sessionModeActive ? (
                            <div className="space-y-4">
                                <div className="rounded-2xl border border-slate-200 bg-slate-50/80 px-4 py-4 text-sm leading-6 text-slate-600">
                                    Entrez vos identifiants <a href={loginUrl} target="_blank" rel="noopener" className="font-semibold text-sky-700 hover:underline">{title}</a>. La plateforme se reconnectera automatiquement avant chaque audit.
                                </div>
                                <div className="grid gap-3 lg:grid-cols-2">
                                    <input type="email" className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700 placeholder:text-slate-400 shadow-sm transition-all focus:border-sky-300 focus:outline-none focus:ring-4 focus:ring-sky-100" placeholder="Email de connexion" value={input.email} onChange={(event) => setCredentialInputs((current) => ({ ...current, [service]: { ...current[service], email: event.target.value } }))} />
                                    <div className="relative">
                                        <input type={showPassword[service] ? 'text' : 'password'} className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 pr-12 text-sm text-slate-700 placeholder:text-slate-400 shadow-sm transition-all focus:border-sky-300 focus:outline-none focus:ring-4 focus:ring-sky-100" placeholder="Mot de passe" value={input.password} onChange={(event) => setCredentialInputs((current) => ({ ...current, [service]: { ...current[service], password: event.target.value } }))} />
                                        <button type="button" onClick={() => setShowPassword((current) => ({ ...current, [service]: !current[service] }))} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 transition-colors hover:text-slate-700">{showPassword[service] ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}</button>
                                    </div>
                                </div>
                                <div className="flex flex-wrap items-center justify-between gap-4">
                                    <div className="flex items-center gap-2 text-xs text-slate-500"><Lock className="h-3.5 w-3.5" />Stockage chiffre et reutilisation automatique.</div>
                                    <button type="button" onClick={() => saveCredentials(service)} disabled={saving[service] || !input.email?.trim() || !input.password?.trim()} className="inline-flex items-center gap-2 rounded-2xl bg-sky-600 px-4 py-3 text-sm font-semibold text-white transition-all hover:bg-sky-500 disabled:opacity-45 shadow-[0_18px_40px_rgba(14,165,233,0.24)]">
                                        <Save className="h-4 w-4" />
                                        {saving[service] ? 'Enregistrement...' : 'Enregistrer la connexion'}
                                    </button>
                                </div>
                            </div>
                        ) : (
                            <div className="space-y-4">
                                <div className="rounded-2xl border border-sky-200 bg-sky-50 px-4 py-4 text-sm leading-6 text-slate-700">
                                    Utilisez le meme compte Google que pour GSC. Ouvrez Ubersuggest, connectez-vous, puis collez le JSON de cookies.
                                </div>
                                <button type="button" onClick={() => beginGoogleSessionConnect(service, loginUrl)} disabled={!googleConnected} className="inline-flex items-center justify-center gap-2 rounded-2xl border border-sky-200 bg-white px-4 py-3 text-sm font-semibold text-sky-700 transition-all hover:bg-sky-50 disabled:opacity-45">
                                    <Globe className="h-4 w-4" />
                                    Ouvrir Ubersuggest
                                </button>
                                <textarea rows={8} value={sessionInputs[service] || ''} onChange={(event) => setSessionInputs((current) => ({ ...current, [service]: event.target.value }))} className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-700 placeholder:text-slate-400 shadow-sm transition-all focus:border-sky-300 focus:outline-none focus:ring-4 focus:ring-sky-100" placeholder='Collez ici le JSON de cookies Ubersuggest' />
                                <div className="flex flex-wrap items-center justify-between gap-4">
                                    <div className="flex items-center gap-2 text-xs text-slate-500"><Shield className="h-3.5 w-3.5" />Session chiffree puis rejouee pour les audits suivants.</div>
                                    <button type="button" onClick={() => saveSession(service)} disabled={importingSessions[service] || !(sessionInputs[service] || '').trim()} className="inline-flex items-center gap-2 rounded-2xl bg-slate-950 px-4 py-3 text-sm font-semibold text-white transition-all hover:bg-slate-800 disabled:opacity-45">
                                        <Save className="h-4 w-4" />
                                        {importingSessions[service] ? 'Enregistrement...' : 'Enregistrer la session'}
                                    </button>
                                </div>
                            </div>
                        )}

                        <MessageBanner message={msg} className="mt-4" />
                    </div>
                </div>
            </article>
        );
    };

    return (
        <div className="mx-auto max-w-6xl space-y-8 settings-body-copy">
            <section className="settings-shell relative overflow-hidden rounded-[34px] p-5 lg:p-6">
                <div className="settings-grid-overlay absolute inset-0 opacity-60" />
                <div className="relative grid gap-6 xl:grid-cols-[1.25fr_0.95fr]">
                    <div className="space-y-5">
                        <div className="inline-flex items-center gap-2 rounded-full border border-sky-200 bg-white/80 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.18em] text-sky-700">
                            <SettingsIcon className="h-3.5 w-3.5" />
                            Parametres de connexion
                        </div>
                        <div className="space-y-3">
                            <h1 className="settings-display max-w-3xl text-3xl font-black tracking-tight text-slate-900 lg:text-[2.6rem] lg:leading-[1.05]">
                                Connecter les bons comptes sans friction ni hesitation
                            </h1>
                          
                        </div>
                       
                    </div>

                    <div className="grid gap-4 sm:grid-cols-2">
                        <div className="rounded-3xl border border-white/70 bg-white/85 px-4 py-4 shadow-[0_16px_40px_rgba(15,23,42,0.06)]">
                            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Services actifs</div>
                            <div className="mt-2 text-2xl font-black tracking-tight text-slate-900">{connectedCount}/3</div>
                            <div className="mt-1 text-sm text-slate-600">{connectedCount === 3 ? 'Plateforme prete pour auditer' : 'Quelques connexions restent a finaliser'}</div>
                        </div>
                        <div className="rounded-3xl border border-white/70 bg-white/85 px-4 py-4 shadow-[0_16px_40px_rgba(15,23,42,0.06)]">
                            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Compte principal</div>
                            <div className="mt-2 text-2xl font-black tracking-tight text-slate-900">{googleConnected ? 'Pret' : 'A faire'}</div>
                            <div className="mt-1 text-sm text-slate-600">{googleConnected ? 'Google pilote GSC et Sheets' : 'Google est la premiere etape recommandee'}</div>
                        </div>
                        <div className="rounded-3xl border border-white/70 bg-white/85 px-4 py-4 shadow-[0_16px_40px_rgba(15,23,42,0.06)]">
                            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Ubersuggest</div>
                            <div className="mt-2 text-2xl font-black tracking-tight text-slate-900">{ubersuggestConnected ? (usesGoogleSession ? 'Session' : 'Login') : 'A choisir'}</div>
                            <div className="mt-1 text-sm text-slate-600">{ubersuggestConnected ? 'Le mode actif est deja enregistre' : 'Identifiants ou parcours Google'}</div>
                        </div>
                        <div className="rounded-3xl border border-white/70 bg-white/85 px-4 py-4 shadow-[0_16px_40px_rgba(15,23,42,0.06)]">
                            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Maintenance</div>
                            <div className="mt-3 flex flex-col gap-3">
                                <button type="button" onClick={() => fetchStatus()} disabled={refreshingStatus} className="inline-flex items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm font-semibold text-slate-700 transition-all hover:border-sky-200 hover:text-sky-700 disabled:opacity-50">
                                    <RefreshCw className={`h-4 w-4 ${refreshingStatus ? 'animate-spin' : ''}`} />
                                    {refreshingStatus ? 'Actualisation...' : 'Actualiser les statuts'}
                                </button>
                                <button type="button" onClick={resetConnectedAccounts} disabled={resettingConnections} className="inline-flex items-center justify-center gap-2 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-600 transition-all hover:bg-rose-100 disabled:opacity-50">
                                    <RefreshCw className={`h-4 w-4 ${resettingConnections ? 'animate-spin' : ''}`} />
                                    {resettingConnections ? 'Reinitialisation...' : 'Reset des comptes'}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            </section>

            <MessageBanner message={messages.reset} />

            <section className="space-y-4">
                <div className="flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between">
                    <div>
                        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-sky-700">Parcours recommande</p>
                    </div>
                    <p className="max-w-2xl text-sm leading-6 text-slate-600">
                        Google d abord, puis MRM, puis Ubersuggest avec le mode le plus propre pour le compte utilise.
                    </p>
                </div>
                <div className="grid gap-4 xl:grid-cols-3">
                    <div className="settings-card group rounded-[28px] p-5 transition-all duration-300 hover:-translate-y-1"><div className="flex items-start justify-between gap-4"><div className="flex items-start gap-4"><div className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border text-lg font-black ${googleConnected ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-sky-200 bg-sky-50 text-sky-700'}`}>1</div><div><h3 className="settings-display text-lg font-black text-slate-900">Connecter Google</h3><p className="mt-2 text-sm leading-6 text-slate-600">Le compte doit avoir acces a la Search Console et aux Google Sheets relies a l audit.</p></div></div><StatusBadge active={googleConnected} label={googleConnected ? 'Pret' : 'A faire'} /></div></div>
                    <div className="settings-card group rounded-[28px] p-5 transition-all duration-300 hover:-translate-y-1"><div className="flex items-start justify-between gap-4"><div className="flex items-start gap-4"><div className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border text-lg font-black ${mrmConnected ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-sky-200 bg-sky-50 text-sky-700'}`}>2</div><div><h3 className="settings-display text-lg font-black text-slate-900">Configurer MRM</h3><p className="mt-2 text-sm leading-6 text-slate-600">Ajoutez une connexion stable pour les donnees MRM et la profondeur de clics.</p></div></div><StatusBadge active={mrmConnected} label={mrmConnected ? 'Pret' : 'A faire'} /></div></div>
                    <div className="settings-card group rounded-[28px] p-5 transition-all duration-300 hover:-translate-y-1"><div className="flex items-start justify-between gap-4"><div className="flex items-start gap-4"><div className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl border text-lg font-black ${ubersuggestConnected ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-sky-200 bg-sky-50 text-sky-700'}`}>3</div><div><h3 className="settings-display text-lg font-black text-slate-900">Choisir Ubersuggest</h3><p className="mt-2 text-sm leading-6 text-slate-600">Utilisez des identifiants classiques ou le parcours Google selon votre mode reel d acces.</p></div></div><StatusBadge active={ubersuggestConnected} label={ubersuggestConnected ? 'Pret' : 'A faire'} /></div></div>
                </div>
            </section>

            <article className="settings-card overflow-hidden rounded-[30px] p-6 lg:p-7">
                <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
                    <div className="space-y-4">
                        <div className="flex flex-wrap items-center gap-4">
                            <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-sky-200 bg-sky-50 text-sky-700 shadow-sm"><Globe className="h-6 w-6" /></div>
                            <div>
                                <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-sky-700">Compte principal</p>
                                <h2 className="settings-display mt-1 text-2xl font-black text-slate-900">Google Search Console</h2>
                                <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">Ce compte pilote les donnees GSC et les captures Google Sheets. </p>
                            </div>
                        </div>
                        <div className="flex flex-wrap gap-2">
                            <span className="rounded-full border border-sky-200 bg-white/90 px-3 py-1.5 text-xs font-medium text-slate-700">OAuth2 par utilisateur</span>
                            <span className="rounded-full border border-sky-200 bg-white/90 px-3 py-1.5 text-xs font-medium text-slate-700">Search Console</span>
                            <span className="rounded-full border border-sky-200 bg-white/90 px-3 py-1.5 text-xs font-medium text-slate-700">Google Sheets</span>
                        </div>
                    </div>
                    <StatusBadge active={googleConnected} label={googleConnected ? 'Compte connecte' : 'Connexion requise'} />
                </div>

                <div className="mt-7 grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
                    <div className="rounded-[26px] border border-slate-200/80 bg-white/85 p-5 shadow-[0_16px_40px_rgba(15,23,42,0.04)]">
                        {googleConnected ? (
                            <div className="space-y-5">
                                <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-4"><div className="flex items-center gap-3"><CheckCircle2 className="h-5 w-5 text-emerald-600" /><div><div className="text-sm font-semibold text-slate-900">Connexion active</div><div className="mt-1 text-sm text-emerald-700">Connecte le {formatConnectionDate(googleStatus?.created_at)}.</div></div></div></div>
                                <div className="grid gap-3 sm:grid-cols-2"><div className="rounded-2xl border border-slate-200 bg-slate-50/80 px-4 py-4"><div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Utilise pour</div><div className="mt-2 text-sm leading-6 text-slate-700">GSC, lecture des Sheets d audit et parcours Google pour Ubersuggest.</div></div><div className="rounded-2xl border border-slate-200 bg-slate-50/80 px-4 py-4"><div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Bon reflexe</div><div className="mt-2 text-sm leading-6 text-slate-700">Verifiez que ce compte a bien acces au domaine et aux documents avant chaque nouvel audit.</div></div></div>
                                <div className="flex flex-wrap gap-3">
                                    <button type="button" onClick={() => fetchStatus()} disabled={refreshingStatus} className="inline-flex items-center gap-2 rounded-2xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition-all hover:border-sky-200 hover:text-sky-700 disabled:opacity-50"><RefreshCw className={`h-4 w-4 ${refreshingStatus ? 'animate-spin' : ''}`} />Actualiser le statut</button>
                                    <button type="button" onClick={disconnectGoogle} className="inline-flex items-center gap-2 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-2.5 text-sm font-semibold text-rose-600 transition-all hover:bg-rose-100"><LogOut className="h-4 w-4" />Deconnecter Google</button>
                                </div>
                            </div>
                        ) : (
                            <div className="space-y-5">
                                <div className="rounded-2xl border border-sky-200 bg-sky-50 px-4 py-4"><div className="flex items-center gap-3"><Shield className="h-5 w-5 text-sky-700" /><div><div className="text-sm font-semibold text-slate-900">Etape de demarrage</div><div className="mt-1 text-sm text-sky-700">Connectez votre compte Google pour activer GSC et la lecture des Google Sheets.</div></div></div></div>
                                <div className="grid gap-3 sm:grid-cols-2"><div className="rounded-2xl border border-slate-200 bg-slate-50/80 px-4 py-4 text-sm leading-6 text-slate-700">Cette connexion debloque la majorite des modules critiques de l audit.</div><div className="rounded-2xl border border-slate-200 bg-slate-50/80 px-4 py-4 text-sm leading-6 text-slate-700">Le bon compte doit avoir acces a la propriete Search Console et aux Google Sheets concernes.</div></div>
                                <a href="/api/auth/google/connect" className="inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-sky-600 px-4 py-3 text-sm font-semibold text-white transition-all hover:bg-sky-500 shadow-[0_18px_40px_rgba(14,165,233,0.24)]"><LogIn className="h-4 w-4" />Connecter Google Search Console</a>
                            </div>
                        )}
                        <MessageBanner message={messages.google} className="mt-4" />
                    </div>
                    <div className="relative overflow-hidden rounded-[26px] bg-slate-950 p-5 text-white shadow-[0_22px_55px_rgba(15,23,42,0.22)]">
                        <div className="absolute -right-10 -top-10 h-32 w-32 rounded-full bg-sky-400/20 blur-3xl" />
                        <div className="absolute bottom-0 right-0 h-28 w-28 rounded-full bg-blue-500/20 blur-3xl" />
                        <div className="relative">
                            <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.18em] text-sky-100"><Sparkles className="h-3.5 w-3.5" />Flux active</div>
                            <h3 className="settings-display mt-4 text-xl font-black">Ce que cette connexion debloque</h3>
                            <div className="mt-5 space-y-3">
                                {['Lecture des proprietes Search Console', 'Captures des onglets Google Sheets relies a l audit', 'Base recommandee pour Ubersuggest via Google'].map((item) => (
                                    <div key={item} className="flex items-start gap-3 rounded-2xl border border-white/10 bg-white/5 px-4 py-3"><CheckCircle2 className="mt-0.5 h-4.5 w-4.5 shrink-0 text-sky-300" /><span className="text-sm leading-6 text-slate-100">{item}</span></div>
                                ))}
                            </div>
                        </div>
                    </div>
                </div>
            </article>

            <section className="space-y-4">
                <div className="flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between">
                    <div><p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">Services complementaires</p><h2 className="settings-display mt-2 text-2xl font-black text-slate-900">Finaliser les outils metier pour les audits avances</h2></div>
                    <p className="max-w-2xl text-sm leading-6 text-slate-600">Chaque carte montre le statut, le mode actif, les actions disponibles et le prochain geste a faire, sans chercher ailleurs.</p>
                </div>
                <div className="grid gap-5 xl:grid-cols-2">
                    {renderCredentialCard({ service: 'mrm', title: 'My Ranking Metrics', icon: Lock, loginUrl: 'https://myrankingmetrics.com/login', description: 'Profondeur de clics, signaux techniques et donnees du rapport MRM.' })}
                    {renderCredentialCard({ service: 'ubersuggest', title: 'Ubersuggest', icon: Lock, loginUrl: 'https://app.neilpatel.com/en/login', description: 'Autorite de domaine et parcours alternatif via session Google.', allowGoogleSession: true })}
                </div>
            </section>

            <section className="settings-card rounded-[30px] p-6 lg:p-7">
                <div className="grid gap-4 xl:grid-cols-[0.95fr_1.05fr]">
                    <div className="space-y-3">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-sky-700">Pour aller vite</p>
                        <h2 className="settings-display text-2xl font-black text-slate-900">Les regles utiles pour eviter les blocages</h2>
                    </div>
                    <div className="grid gap-3 md:grid-cols-2">
                        {[
                            'Le bon compte Google doit avoir acces a la propriete GSC et aux Google Sheets utilises dans l audit.',
                            'Le reset global est pratique avant de passer a un nouveau site ou a un autre client.',
                            'Si Ubersuggest passe par Google, privilegiez le mode session pour rester aligne avec le compte deja connecte.',
                            'Chaque message apparait au plus pres de l action concernee pour eviter les doutes.'
                        ].map((item) => (
                            <div key={item} className="rounded-2xl border border-slate-200 bg-slate-50/80 px-4 py-4 text-sm leading-6 text-slate-600">{item}</div>
                        ))}
                    </div>
                </div>
            </section>
        </div>
    );
};

export default Settings;
