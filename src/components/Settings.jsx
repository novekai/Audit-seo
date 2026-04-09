import React, { useState, useEffect } from 'react';
import { Settings as SettingsIcon, Globe, Lock, CheckCircle2, AlertCircle, Save, Trash2, RefreshCw, Shield, Eye, EyeOff, Zap, LogIn, LogOut } from 'lucide-react';

const Settings = () => {
    const [connections, setConnections] = useState([]);
    const [credentialInputs, setCredentialInputs] = useState({
        mrm: { email: '', password: '' },
        ubersuggest: { email: '', password: '' }
    });
    const [sessionInputs, setSessionInputs] = useState({
        ubersuggest: ''
    });
    const [showPassword, setShowPassword] = useState({ mrm: false, ubersuggest: false });
    const [saving, setSaving] = useState({});
    const [testing, setTesting] = useState({});
    const [importingSessions, setImportingSessions] = useState({});
    const [showSessionImport, setShowSessionImport] = useState({ ubersuggest: false });
    const [messages, setMessages] = useState({});

    const fetchStatus = async () => {
        try {
            const token = localStorage.getItem('token');
            const res = await fetch('/api/credentials/status', {
                headers: { 'Authorization': `Bearer ${token}` },
                credentials: 'include'
            });
            if (res.ok) {
                const data = await res.json();
                setConnections(data);
            }
        } catch { }
    };

    useEffect(() => {
        fetchStatus();
        // Handle Google OAuth callback redirect
        const params = new URLSearchParams(window.location.search);
        const googleAuth = params.get('google_auth');
        if (googleAuth === 'success') {
            setMessages(m => ({ ...m, google: { type: 'success', text: 'Compte Google connecte avec succes !' } }));
            window.history.replaceState({}, '', window.location.pathname);
        } else if (googleAuth === 'error') {
            const reason = params.get('reason') || 'unknown';
            const reasons = {
                denied: 'Vous avez refuse la connexion.',
                no_refresh_token: 'Aucun token obtenu. Essayez de revoquer l\'acces dans votre compte Google puis reconnectez.',
                expired: 'Le lien a expire. Veuillez reessayer.',
                server_error: 'Erreur serveur. Veuillez reessayer.'
            };
            setMessages(m => ({ ...m, google: { type: 'error', text: reasons[reason] || 'Erreur inconnue.' } }));
            window.history.replaceState({}, '', window.location.pathname);
        }
    }, []);

    const getServiceStatus = (service) => {
        return connections.find(c => c.service === service);
    };

    const getMessageClasses = (type) => {
        if (type === 'success') {
            return 'bg-green-500/10 text-green-500 border border-green-500/20';
        }
        if (type === 'info') {
            return 'bg-blue-500/10 text-blue-600 border border-blue-500/20';
        }
        return 'bg-red-500/10 text-red-400 border border-red-500/20';
    };

    const saveCredentials = async (service) => {
        const { email, password } = credentialInputs[service];
        if (!email?.trim() || !password?.trim()) {
            setMessages(m => ({ ...m, [service]: { type: 'error', text: 'Email et mot de passe requis.' } }));
            return;
        }

        setSaving(s => ({ ...s, [service]: true }));
        setMessages(m => ({ ...m, [service]: null }));

        try {
            const token = localStorage.getItem('token');
            const res = await fetch(`/api/credentials/${service}`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ email: email.trim(), password })
            });
            const data = await res.json();
            if (res.ok) {
                setMessages(m => ({ ...m, [service]: { type: 'success', text: 'Identifiants enregistrés et chiffrés !' } }));
                setCredentialInputs(c => ({ ...c, [service]: { email: '', password: '' } }));
                setShowSessionImport(s => ({ ...s, [service]: false }));
                setSessionInputs(s => ({ ...s, [service]: '' }));
                fetchStatus();
            } else {
                setMessages(m => ({ ...m, [service]: { type: 'error', text: data.error } }));
            }
        } catch {
            setMessages(m => ({ ...m, [service]: { type: 'error', text: 'Erreur réseau' } }));
        } finally {
            setSaving(s => ({ ...s, [service]: false }));
        }
    };

    const deleteCredentials = async (service) => {
        if (!confirm(`Supprimer les identifiants ${service} ?`)) return;
        try {
            const token = localStorage.getItem('token');
            await fetch(`/api/credentials/${service}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${token}` },
                credentials: 'include'
            });
            await fetch(`/api/sessions/delete/${service}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${token}` },
                credentials: 'include'
            }).catch(() => {});
            setShowSessionImport(s => ({ ...s, [service]: false }));
            setSessionInputs(s => ({ ...s, [service]: '' }));
            setMessages(m => ({ ...m, [service]: { type: 'success', text: 'Identifiants supprimés.' } }));
            fetchStatus();
        } catch { }
    };

    const testCredentials = async (service) => {
        setTesting(t => ({ ...t, [service]: true }));
        setMessages(m => ({ ...m, [service]: null }));

        try {
            const token = localStorage.getItem('token');
            const res = await fetch(`/api/credentials/test/${service}`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}` },
                credentials: 'include'
            });
            const data = await res.json();
            if (data.success) {
                setMessages(m => ({ ...m, [service]: { type: 'success', text: data.message } }));
            } else {
                setMessages(m => ({ ...m, [service]: { type: 'error', text: data.error || 'Test échoué' } }));
            }
        } catch {
            setMessages(m => ({ ...m, [service]: { type: 'error', text: 'Erreur réseau' } }));
        } finally {
            setTesting(t => ({ ...t, [service]: false }));
        }
    };

    const beginGoogleSessionConnect = (service, loginUrl) => {
        const googleStatus = getServiceStatus('google');

        if (service === 'ubersuggest' && googleStatus?.status !== 'active') {
            setMessages(m => ({
                ...m,
                [service]: {
                    type: 'error',
                    text: 'Connectez d’abord Google Search Console, puis utilisez le meme compte Google pour ouvrir Ubersuggest.'
                }
            }));
            return;
        }

        window.open(loginUrl, '_blank', 'noopener,noreferrer');
        setShowSessionImport(s => ({ ...s, [service]: true }));
        setMessages(m => ({
            ...m,
            [service]: {
                type: 'info',
                text: 'Connectez-vous a Ubersuggest dans l’onglet ouvert avec votre compte Google, puis collez ici le JSON de cookies Ubersuggest pour enregistrer la session.'
            }
        }));
    };

    const saveSession = async (service) => {
        const rawValue = sessionInputs[service];
        if (!rawValue?.trim()) {
            setMessages(m => ({ ...m, [service]: { type: 'error', text: 'Collez le JSON de cookies avant de valider la session.' } }));
            return;
        }

        let cookies;
        try {
            const parsed = JSON.parse(rawValue);
            if (Array.isArray(parsed)) {
                cookies = parsed;
            } else if (Array.isArray(parsed?.cookies)) {
                cookies = parsed.cookies;
            } else {
                throw new Error('invalid_format');
            }
        } catch {
            setMessages(m => ({
                ...m,
                [service]: {
                    type: 'error',
                    text: 'Format invalide. Collez soit un tableau JSON de cookies, soit un objet contenant une cle "cookies".'
                }
            }));
            return;
        }

        setImportingSessions(s => ({ ...s, [service]: true }));
        setMessages(m => ({ ...m, [service]: null }));

        try {
            const token = localStorage.getItem('token');
            const res = await fetch(`/api/sessions/import/${service}`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                credentials: 'include',
                body: JSON.stringify({ cookies })
            });

            const data = await res.json();
            if (res.ok) {
                setMessages(m => ({
                    ...m,
                    [service]: {
                        type: 'success',
                        text: service === 'ubersuggest'
                            ? 'Session Ubersuggest via Google enregistree et chiffree.'
                            : data.message
                    }
                }));
                setSessionInputs(s => ({ ...s, [service]: '' }));
                setShowSessionImport(s => ({ ...s, [service]: false }));
                fetchStatus();
            } else {
                setMessages(m => ({ ...m, [service]: { type: 'error', text: data.error || 'Impossible d’enregistrer la session.' } }));
            }
        } catch {
            setMessages(m => ({ ...m, [service]: { type: 'error', text: 'Erreur reseau' } }));
        } finally {
            setImportingSessions(s => ({ ...s, [service]: false }));
        }
    };

    const disconnectGoogle = async () => {
        if (!confirm('Deconnecter votre compte Google ?')) return;
        try {
            const token = localStorage.getItem('token');
            const res = await fetch('/api/credentials/google', {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${token}` },
                credentials: 'include'
            });
            if (res.ok) {
                setMessages(m => ({ ...m, google: { type: 'success', text: 'Compte Google deconnecte.' } }));
                await fetchStatus();
            } else {
                const data = await res.json().catch(() => ({}));
                setMessages(m => ({ ...m, google: { type: 'error', text: data.error || 'Erreur lors de la deconnexion' } }));
            }
        } catch {
            setMessages(m => ({ ...m, google: { type: 'error', text: 'Erreur reseau' } }));
        }
    };

    // ── Google Card (OAuth2, per-user) ──
    const GoogleCard = () => {
        const status = getServiceStatus('google');
        const isActive = status?.status === 'active';
        const canConnect = status?.can_connect;
        const msg = messages.google;

        return (
            <div className="glass rounded-xl p-6 border border-slate-200/80 hover:border-blue-200 transition-all lg:col-span-3">
                <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 bg-blue-50 rounded-lg flex items-center justify-center border border-blue-100">
                            <Globe className="w-5 h-5 text-blue-500" />
                        </div>
                        <div>
                            <h3 className="font-semibold text-slate-900">Google Search Console</h3>
                            <p className="text-xs text-slate-500">Sitemaps, HTTPS, Performance, Indexation, Meilleures pages</p>
                        </div>
                    </div>
                    <div className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider ${
                        isActive
                            ? 'bg-green-500/10 text-green-500 border border-green-500/20'
                            : 'bg-amber-500/10 text-amber-500 border border-amber-500/20'
                    }`}>
                        {isActive ? <CheckCircle2 className="w-3 h-3" /> : <AlertCircle className="w-3 h-3" />}
                        {isActive ? 'Compte connecte' : 'Non connecte'}
                    </div>
                </div>

                {isActive ? (
                    <div className="space-y-3">
                        <div className="flex items-center justify-between px-4 py-3 bg-green-500/5 rounded-lg border border-green-500/10">
                            <div className="flex items-center gap-2">
                                <Zap className="w-3.5 h-3.5 text-green-500" />
                                <span className="text-xs text-green-600">
                                    {status.created_at && !isNaN(new Date(status.created_at))
                                        ? `Connecte le ${new Date(status.created_at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })}`
                                        : 'Compte connecte'
                                    }
                                </span>
                            </div>
                            <button
                                onClick={disconnectGoogle}
                                className="flex items-center gap-1.5 text-xs text-red-400 hover:text-red-500 transition-colors"
                            >
                                <LogOut className="w-3.5 h-3.5" />
                                Deconnecter
                            </button>
                        </div>
                        <div className="flex items-center gap-3 px-4 py-3 bg-blue-50/60 rounded-lg border border-blue-100">
                            <Shield className="w-5 h-5 text-blue-500 shrink-0" />
                            <div className="text-sm text-slate-600">
                                Votre compte Google est connecte via OAuth2. Les audits utilisent automatiquement vos donnees Search Console.
                            </div>
                        </div>
                    </div>
                ) : (
                    <div className="space-y-3">
                        <div className="flex items-center gap-3 px-4 py-3 bg-blue-50/60 rounded-lg border border-blue-100">
                            <Shield className="w-5 h-5 text-blue-500 shrink-0" />
                            <div className="text-sm text-slate-600">
                                Connectez votre compte Google pour activer les modules Search Console (sitemaps, performance, indexation, etc.).
                            </div>
                        </div>
                        {canConnect !== false && (
                            <a
                                href="/api/auth/google/connect"
                                className="w-full py-2.5 rounded-lg text-sm font-medium transition-all flex items-center justify-center gap-2 bg-blue-600 text-white hover:bg-blue-500 shadow-lg shadow-blue-200/80"
                            >
                                <LogIn className="w-4 h-4" />
                                Connecter Google Search Console
                            </a>
                        )}
                    </div>
                )}

                {msg && (
                    <div className={`mt-3 text-xs px-3 py-2 rounded-lg ${getMessageClasses(msg.type)}`}>
                        {msg.text}
                    </div>
                )}
            </div>
        );
    };

    // ── Credential Card (MRM, Ubersuggest) ──
    const CredentialCard = ({ service, title, icon: Icon, loginUrl, description, allowGoogleSession = false }) => {
        const status = getServiceStatus(service);
        const isConnected = status?.status === 'active';
        const isLegacy = Boolean(status?.legacy);
        const isPasswordAuth = status?.auth_type === 'password';
        const isSessionAuth = status?.auth_type === 'session' || status?.auth_type === 'cookie';
        const usesGoogleSession = service === 'ubersuggest' && status?.auth_type === 'session';
        const googleConnected = getServiceStatus('google')?.status === 'active';
        const msg = messages[service];
        const isSaving = saving[service];
        const isTesting = testing[service];
        const isImportingSession = importingSessions[service];
        const input = credentialInputs[service];
        const sessionInput = sessionInputs[service] || '';
        const showGoogleSessionForm = showSessionImport[service];
        const showPwd = showPassword[service];

        return (
            <div className="glass rounded-xl p-6 border border-slate-200/80 hover:border-blue-200 transition-all">
                {/* Header */}
                <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 bg-blue-50 rounded-lg flex items-center justify-center border border-blue-100">
                            <Icon className="w-5 h-5 text-blue-500" />
                        </div>
                        <div>
                            <h3 className="font-semibold text-slate-900">{title}</h3>
                            <p className="text-xs text-slate-500">{description}</p>
                        </div>
                    </div>
                    {isConnected && (
                        <div className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider ${
                            (isLegacy || isSessionAuth)
                                ? 'bg-amber-500/10 text-amber-500 border border-amber-500/20'
                                : 'bg-green-500/10 text-green-500 border border-green-500/20'
                        }`}>
                            <CheckCircle2 className="w-3 h-3" />
                            {usesGoogleSession ? 'Session Google' : isLegacy ? 'Cookies (ancien)' : 'Connecte'}
                        </div>
                    )}
                </div>

                {/* Connection info */}
                {isConnected && (
                    <div className="flex items-center justify-between mb-3 px-3 py-2 bg-green-500/5 rounded-lg border border-green-500/10">
                        <div className="flex items-center gap-2">
                            <Zap className="w-3.5 h-3.5 text-green-500" />
                            <span className="text-xs text-green-600">
                                {usesGoogleSession
                                    ? `Session Google enregistree le ${new Date(status.created_at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })}`
                                    : isLegacy
                                    ? 'Cookies importés (ancien système)'
                                    : `Configuré le ${new Date(status.created_at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })}`
                                }
                            </span>
                        </div>
                        <div className="flex items-center gap-2">
                            <button
                                onClick={() => testCredentials(service)}
                                disabled={isTesting || !isPasswordAuth}
                                className="text-blue-500 hover:text-blue-400 transition-colors disabled:opacity-40"
                                title={isPasswordAuth ? 'Tester la connexion' : 'Test disponible uniquement pour le mode email / mot de passe'}
                            >
                                <RefreshCw className={`w-3.5 h-3.5 ${isTesting ? 'animate-spin' : ''}`} />
                            </button>
                            <button
                                onClick={() => deleteCredentials(service)}
                                className="text-red-400 hover:text-red-300 transition-colors"
                                title="Supprimer"
                            >
                                <Trash2 className="w-3.5 h-3.5" />
                            </button>
                        </div>
                    </div>
                )}

                {/* Credential input form */}
                <div className="space-y-3">
                    <div className="flex items-center gap-2 text-xs text-slate-500">
                        <Lock className="w-3.5 h-3.5" />
                        <span>
                            {allowGoogleSession
                                ? <>Entrez vos identifiants <a href={loginUrl} target="_blank" rel="noopener" className="text-blue-500 hover:underline">{title}</a> ou utilisez le parcours Google ci-dessous pour enregistrer une session web reutilisable.</>
                                : <>Entrez vos identifiants <a href={loginUrl} target="_blank" rel="noopener" className="text-blue-500 hover:underline">{title}</a> — connexion automatique à chaque audit</>
                            }
                        </span>
                    </div>

                    <input
                        type="email"
                        className="w-full bg-white/90 border border-slate-200 rounded-lg p-3 text-sm text-slate-700 placeholder-slate-400 focus:outline-none focus:border-blue-400 shadow-sm"
                        placeholder="Email de connexion"
                        value={input.email}
                        onChange={e => setCredentialInputs(c => ({ ...c, [service]: { ...c[service], email: e.target.value } }))}
                    />

                    <div className="relative">
                        <input
                            type={showPwd ? 'text' : 'password'}
                            className="w-full bg-white/90 border border-slate-200 rounded-lg p-3 pr-10 text-sm text-slate-700 placeholder-slate-400 focus:outline-none focus:border-blue-400 shadow-sm"
                            placeholder="Mot de passe"
                            value={input.password}
                            onChange={e => setCredentialInputs(c => ({ ...c, [service]: { ...c[service], password: e.target.value } }))}
                        />
                        <button
                            type="button"
                            onClick={() => setShowPassword(s => ({ ...s, [service]: !s[service] }))}
                            className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                        >
                            {showPwd ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        </button>
                    </div>

                    <div className={`grid gap-3 ${allowGoogleSession ? 'sm:grid-cols-2' : 'grid-cols-1'}`}>
                        <button
                            onClick={() => saveCredentials(service)}
                            disabled={isSaving || !input.email?.trim() || !input.password?.trim()}
                            className="w-full py-2.5 rounded-lg text-sm font-medium transition-all flex items-center justify-center gap-2 bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed shadow-lg shadow-blue-200/80"
                        >
                            {isSaving ? (
                                <>Enregistrement...</>
                            ) : (
                                <><Save className="w-4 h-4" /> Enregistrer les identifiants</>
                            )}
                        </button>

                        {allowGoogleSession && (
                            <button
                                type="button"
                                onClick={() => beginGoogleSessionConnect(service, loginUrl)}
                                disabled={!googleConnected}
                                className="w-full py-2.5 rounded-lg text-sm font-medium transition-all flex items-center justify-center gap-2 border border-slate-200 bg-white text-slate-700 hover:border-blue-200 hover:text-blue-600 disabled:opacity-40 disabled:cursor-not-allowed shadow-sm"
                                title={googleConnected ? 'Ouvrir la connexion Ubersuggest via Google' : 'Connectez d’abord Google Search Console'}
                            >
                                <Globe className="w-4 h-4" />
                                Via Google
                            </button>
                        )}
                    </div>

                    {allowGoogleSession && (
                        <div className="rounded-xl border border-blue-100 bg-blue-50/70 p-4 space-y-3">
                            <div className="space-y-1">
                                <p className="text-sm font-semibold text-slate-900">Connexion Ubersuggest via Google</p>
                                <p className="text-xs text-slate-600">
                                    Utilisez le meme compte Google que celui connecte pour GSC. Une fois connecte sur Ubersuggest, exportez les cookies du domaine depuis votre navigateur puis collez le JSON ci-dessous.
                                </p>
                            </div>

                            <div className="rounded-lg border border-blue-100 bg-white/80 px-3 py-2 text-xs text-slate-600">
                                1. Cliquez sur <strong>Via Google</strong>.
                                <br />
                                2. Connectez-vous a Ubersuggest avec votre compte Google.
                                <br />
                                3. Exportez les cookies Ubersuggest au format JSON et collez-les ici pour enregistrer la session.
                            </div>

                            {showGoogleSessionForm && (
                                <>
                                    <textarea
                                        rows={7}
                                        value={sessionInput}
                                        onChange={(e) => setSessionInputs(s => ({ ...s, [service]: e.target.value }))}
                                        className="w-full rounded-lg border border-slate-200 bg-white p-3 text-sm text-slate-700 placeholder-slate-400 focus:outline-none focus:border-blue-400 shadow-sm"
                                        placeholder='Collez ici le JSON de cookies Ubersuggest'
                                    />

                                    <button
                                        type="button"
                                        onClick={() => saveSession(service)}
                                        disabled={isImportingSession || !sessionInput.trim()}
                                        className="w-full py-2.5 rounded-lg text-sm font-medium transition-all flex items-center justify-center gap-2 bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-40 disabled:cursor-not-allowed"
                                    >
                                        {isImportingSession ? (
                                            <><RefreshCw className="w-4 h-4 animate-spin" /> Enregistrement de la session...</>
                                        ) : (
                                            <><Save className="w-4 h-4" /> Enregistrer la session Google</>
                                        )}
                                    </button>
                                </>
                            )}
                        </div>
                    )}

                    {/* Message */}
                    {msg && (
                        <div className={`text-xs px-3 py-2 rounded-lg ${getMessageClasses(msg.type)}`}>
                            {msg.text}
                        </div>
                    )}
                </div>
            </div>
        );
    };

    return (
        <div className="max-w-5xl mx-auto space-y-8">
            <div className="flex items-center gap-4 border-b border-slate-200 pb-6">
                <div className="w-12 h-12 bg-blue-50 rounded-xl flex items-center justify-center border border-blue-100">
                    <SettingsIcon className="w-6 h-6 text-blue-500" />
                </div>
                <div>
                    <h1 className="text-2xl font-bold text-slate-900">Connexions aux services</h1>
                    <p className="text-slate-600">Configurez vos connexions pour activer les modules d'audit avancés</p>
                </div>
            </div>

            {/* Info banner */}
            <div className="glass rounded-2xl p-6 border border-blue-100 bg-blue-50/60">
                <div className="flex gap-4">
                    <div className="w-10 h-10 bg-white rounded-full flex items-center justify-center shrink-0 mt-0.5 border border-blue-100">
                        <Shield className="w-5 h-5 text-blue-500" />
                    </div>
                    <div className="space-y-2">
                        <h4 className="font-semibold text-slate-900">Connexion automatique</h4>
                        <p className="text-sm text-slate-600 leading-relaxed">
                            Vos identifiants sont chiffrés en <strong>AES-256</strong> avant stockage.
                            La plateforme se connecte automatiquement aux services avant chaque audit.
                            Ubersuggest peut aussi etre relie proprement via une session Google enregistree quand le mot de passe n’est pas le bon mode de connexion.
                        </p>
                    </div>
                </div>
            </div>

            {/* Google Card (full width) */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                <GoogleCard />
            </div>

            {/* MRM & Ubersuggest Cards */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <CredentialCard
                    service="mrm"
                    title="My Ranking Metrics"
                    icon={Lock}
                    loginUrl="https://myrankingmetrics.com/login"
                    description="Profondeur de clics, Codes HTTP"
                />
                <CredentialCard
                    service="ubersuggest"
                    title="Ubersuggest"
                    icon={Lock}
                    loginUrl="https://app.neilpatel.com/en/login"
                    description="Autorité de domaine"
                    allowGoogleSession
                />
            </div>
        </div>
    );
};

export default Settings;
