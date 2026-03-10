import React, { useState, useEffect } from 'react';
import { Settings as SettingsIcon, Globe, Lock, CheckCircle2, AlertCircle, ClipboardPaste, Save, Trash2 } from 'lucide-react';

const SERVICES = [
    {
        key: 'google',
        title: 'Google (Search Console)',
        icon: Globe,
        loginUrl: 'https://search.google.com/search-console',
        description: 'Nécessaire pour : Sitemaps déclarés, HTTPS, Google Sheets privés',
        cookieDomain: '.google.com'
    },
    {
        key: 'mrm',
        title: 'My Ranking Metrics',
        icon: Lock,
        loginUrl: 'https://myrankingmetrics.com/login',
        description: 'Nécessaire pour : Profondeur de clics, Codes HTTP',
        cookieDomain: '.myrankingmetrics.com'
    },
    {
        key: 'ubersuggest',
        title: 'Ubersuggest',
        icon: Lock,
        loginUrl: 'https://app.neilpatel.com/en/login',
        description: 'Nécessaire pour : Autorité de domaine',
        cookieDomain: '.neilpatel.com'
    }
];

const Settings = () => {
    const [connections, setConnections] = useState({});
    const [cookieInputs, setCookieInputs] = useState({ google: '', mrm: '', ubersuggest: '' });
    const [saving, setSaving] = useState({});
    const [messages, setMessages] = useState({});

    const fetchStatus = async () => {
        try {
            const token = localStorage.getItem('token');
            const res = await fetch('/api/sessions/status', {
                headers: { 'Authorization': `Bearer ${token}` },
                credentials: 'include'
            });
            if (res.ok) {
                const data = await res.json();
                const c = {};
                data.forEach(s => { c[s.service] = { status: 'connected', createdAt: s.created_at }; });
                setConnections(c);
            }
        } catch { }
    };

    useEffect(() => { fetchStatus(); }, []);

    const saveCookies = async (service) => {
        const raw = cookieInputs[service]?.trim();
        if (!raw) {
            setMessages(m => ({ ...m, [service]: { type: 'error', text: 'Collez les cookies JSON exportés depuis Cookie-Editor.' } }));
            return;
        }

        // Validate JSON
        let parsed;
        try {
            parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) throw new Error('Format invalide');
            if (parsed.length === 0) throw new Error('Aucun cookie trouvé');
            // Quick sanity check
            if (!parsed[0].name && !parsed[0].Name) throw new Error('Format non reconnu — utilisez Cookie-Editor');
        } catch (e) {
            setMessages(m => ({ ...m, [service]: { type: 'error', text: `JSON invalide : ${e.message}` } }));
            return;
        }

        setSaving(s => ({ ...s, [service]: true }));
        setMessages(m => ({ ...m, [service]: null }));

        try {
            const token = localStorage.getItem('token');
            const res = await fetch(`/api/sessions/import/${service}`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                credentials: 'include',
                body: JSON.stringify({ cookies: parsed })
            });
            const data = await res.json();
            if (res.ok) {
                setMessages(m => ({ ...m, [service]: { type: 'success', text: `✅ ${parsed.length} cookies enregistrés et chiffrés !` } }));
                setCookieInputs(c => ({ ...c, [service]: '' }));
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

    const deleteCookies = async (service) => {
        if (!confirm(`Supprimer les cookies ${service} ?`)) return;
        try {
            const token = localStorage.getItem('token');
            await fetch(`/api/sessions/delete/${service}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bearer ${token}` },
                credentials: 'include'
            });
            setConnections(c => { const n = { ...c }; delete n[service]; return n; });
            setMessages(m => ({ ...m, [service]: { type: 'success', text: 'Cookies supprimés.' } }));
        } catch { }
    };

    const ServiceCard = ({ svc }) => {
        const conn = connections[svc.key];
        const msg = messages[svc.key];
        const isSaving = saving[svc.key];

        return (
            <div className="glass rounded-xl p-6 border border-slate-200/80 hover:border-blue-200 transition-all">
                {/* Header */}
                <div className="flex items-center justify-between mb-4">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 bg-blue-50 rounded-lg flex items-center justify-center border border-blue-100">
                            <svc.icon className="w-5 h-5 text-blue-500" />
                        </div>
                        <div>
                            <h3 className="font-semibold text-slate-900">{svc.title}</h3>
                            <p className="text-xs text-slate-500">{svc.description}</p>
                        </div>
                    </div>
                    {conn && (
                        <div className="flex items-center gap-1.5 px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider bg-green-500/10 text-green-400 border border-green-500/20">
                            <CheckCircle2 className="w-3 h-3" />
                            Connecté
                        </div>
                    )}
                </div>

                {/* Connection info */}
                {conn && (
                    <div className="flex items-center justify-between mb-3 px-3 py-2 bg-green-500/5 rounded-lg border border-green-500/10">
                        <span className="text-xs text-green-400">
                            Importé le {new Date(conn.createdAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                        </span>
                        <button onClick={() => deleteCookies(svc.key)} className="text-red-400 hover:text-red-300 transition-colors" title="Supprimer">
                            <Trash2 className="w-3.5 h-3.5" />
                        </button>
                    </div>
                )}

                {/* Cookie input */}
                <div className="space-y-3">
                    <div className="flex items-center gap-2 text-xs text-slate-500">
                        <ClipboardPaste className="w-3.5 h-3.5" />
                        <span>
                            Connectez-vous sur <a href={svc.loginUrl} target="_blank" rel="noopener" className="text-blue-500 hover:underline">{svc.loginUrl}</a> puis exportez vos cookies avec Cookie-Editor
                        </span>
                    </div>

                    <textarea
                        className="w-full h-24 bg-white/90 border border-slate-200 rounded-lg p-3 text-xs font-mono text-slate-700 placeholder-slate-400 focus:outline-none focus:border-blue-400 resize-none shadow-sm"
                        placeholder='[{"name": "SID", "value": "...", "domain": ".google.com", ...}]'
                        value={cookieInputs[svc.key]}
                        onChange={e => setCookieInputs(c => ({ ...c, [svc.key]: e.target.value }))}
                    />

                    <button
                        onClick={() => saveCookies(svc.key)}
                        disabled={isSaving || !cookieInputs[svc.key]?.trim()}
                        className="w-full py-2.5 rounded-lg text-sm font-medium transition-all flex items-center justify-center gap-2 bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed shadow-lg shadow-blue-200/80"
                    >
                        {isSaving ? (
                            <>Enregistrement...</>
                        ) : (
                            <><Save className="w-4 h-4" /> Enregistrer les cookies</>
                        )}
                    </button>

                    {/* Message */}
                    {msg && (
                        <div className={`text-xs px-3 py-2 rounded-lg ${msg.type === 'success' ? 'bg-green-500/10 text-green-400 border border-green-500/20' : 'bg-red-500/10 text-red-400 border border-red-500/20'}`}>
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
                    <h1 className="text-2xl font-bold text-slate-900">Import de sessions</h1>
                    <p className="text-slate-600">Importez vos cookies pour activer les modules d'audit avancés</p>
                </div>
            </div>

            {/* Instructions */}
            <div className="glass rounded-2xl p-6 border border-blue-100 bg-blue-50/60">
                <div className="flex gap-4">
                    <div className="w-10 h-10 bg-white rounded-full flex items-center justify-center shrink-0 mt-0.5 border border-blue-100">
                        <AlertCircle className="w-5 h-5 text-blue-500" />
                    </div>
                    <div className="space-y-3">
                        <h4 className="font-semibold text-slate-900">Comment importer vos cookies ?</h4>
                        <ol className="text-sm text-slate-600 leading-relaxed space-y-1.5 list-decimal list-inside">
                            <li>Installez l'extension Chrome <a href="https://chromewebstore.google.com/detail/cookie-editor/hlkenndednhfkekhgcdicdfddnkalmdm" target="_blank" rel="noopener" className="text-blue-500 hover:underline font-medium">Cookie-Editor</a> (gratuit)</li>
                            <li>Connectez-vous sur le site du service (Google, MRM, Ubersuggest)</li>
                            <li>Cliquez sur l'icône Cookie-Editor → <strong className="text-slate-900">Export</strong></li>
                            <li>Collez le JSON dans le champ ci-dessous → <strong className="text-slate-900">Enregistrer</strong></li>
                        </ol>
                        <p className="text-xs text-slate-500">
                            🔒 Vos cookies sont chiffrés en AES-256 avant stockage. Ils servent uniquement à naviguer sur les sites d'audit. Vos mots de passe ne sont jamais stockés.
                        </p>
                    </div>
                </div>
            </div>

            {/* Service Cards */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                {SERVICES.map(svc => <ServiceCard key={svc.key} svc={svc} />)}
            </div>
        </div>
    );
};

export default Settings;
