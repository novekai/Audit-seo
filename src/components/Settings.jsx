import React, { useState, useEffect } from 'react';
import { Settings as SettingsIcon, Globe, Lock, CheckCircle2, AlertCircle, Save, Trash2, RefreshCw, Shield, Eye, EyeOff, Zap } from 'lucide-react';

const Settings = () => {
    const [connections, setConnections] = useState([]);
    const [credentialInputs, setCredentialInputs] = useState({
        mrm: { email: '', password: '' },
        ubersuggest: { email: '', password: '' }
    });
    const [showPassword, setShowPassword] = useState({ mrm: false, ubersuggest: false });
    const [saving, setSaving] = useState({});
    const [testing, setTesting] = useState({});
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

    useEffect(() => { fetchStatus(); }, []);

    const getServiceStatus = (service) => {
        return connections.find(c => c.service === service);
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
            // Delete credentials
            await fetch(`/api/credentials/${service}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${token}` },
                credentials: 'include'
            });
            // Also delete legacy cookies if any
            await fetch(`/api/sessions/delete/${service}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${token}` },
                credentials: 'include'
            }).catch(() => {});
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

    // ── Google Card (OAuth2, server-managed) ──
    const GoogleCard = () => {
        const status = getServiceStatus('google');
        const isActive = status?.status === 'active';

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
                        {isActive ? 'Connecté via OAuth2' : 'Non configuré'}
                    </div>
                </div>

                <div className="flex items-center gap-3 px-4 py-3 bg-blue-50/60 rounded-lg border border-blue-100">
                    <Shield className="w-5 h-5 text-blue-500 shrink-0" />
                    <div className="text-sm text-slate-600">
                        {isActive ? (
                            <>
                                La connexion Google Search Console est <strong className="text-slate-900">gérée automatiquement</strong> via OAuth2.
                                Plus besoin d'exporter vos cookies — la connexion ne expire jamais.
                            </>
                        ) : (
                            <>
                                Les variables <code className="text-xs bg-white px-1 py-0.5 rounded">GOOGLE_CLIENT_ID</code>, <code className="text-xs bg-white px-1 py-0.5 rounded">GOOGLE_CLIENT_SECRET</code> et <code className="text-xs bg-white px-1 py-0.5 rounded">GOOGLE_REFRESH_TOKEN</code> doivent être configurées sur le serveur.
                            </>
                        )}
                    </div>
                </div>
            </div>
        );
    };

    // ── Credential Card (MRM, Ubersuggest) ──
    const CredentialCard = ({ service, title, icon: Icon, loginUrl, description }) => {
        const status = getServiceStatus(service);
        const isConnected = status?.status === 'active';
        const isLegacy = status?.legacy;
        const msg = messages[service];
        const isSaving = saving[service];
        const isTesting = testing[service];
        const input = credentialInputs[service];
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
                            isLegacy
                                ? 'bg-amber-500/10 text-amber-500 border border-amber-500/20'
                                : 'bg-green-500/10 text-green-500 border border-green-500/20'
                        }`}>
                            <CheckCircle2 className="w-3 h-3" />
                            {isLegacy ? 'Cookies (ancien)' : 'Connecté'}
                        </div>
                    )}
                </div>

                {/* Connection info */}
                {isConnected && (
                    <div className="flex items-center justify-between mb-3 px-3 py-2 bg-green-500/5 rounded-lg border border-green-500/10">
                        <div className="flex items-center gap-2">
                            <Zap className="w-3.5 h-3.5 text-green-500" />
                            <span className="text-xs text-green-600">
                                {isLegacy
                                    ? 'Cookies importés (ancien système)'
                                    : `Configuré le ${new Date(status.created_at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' })}`
                                }
                            </span>
                        </div>
                        <div className="flex items-center gap-2">
                            <button
                                onClick={() => testCredentials(service)}
                                disabled={isTesting || isLegacy}
                                className="text-blue-500 hover:text-blue-400 transition-colors disabled:opacity-40"
                                title="Tester la connexion"
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
                            Entrez vos identifiants <a href={loginUrl} target="_blank" rel="noopener" className="text-blue-500 hover:underline">{title}</a> — connexion automatique à chaque audit
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

                    {/* Message */}
                    {msg && (
                        <div className={`text-xs px-3 py-2 rounded-lg ${
                            msg.type === 'success'
                                ? 'bg-green-500/10 text-green-500 border border-green-500/20'
                                : 'bg-red-500/10 text-red-400 border border-red-500/20'
                        }`}>
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
                            La plateforme se connecte automatiquement aux services avant chaque audit — plus besoin d'exporter vos cookies manuellement.
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
                />
            </div>
        </div>
    );
};

export default Settings;
