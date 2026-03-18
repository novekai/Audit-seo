import React, { useState } from 'react';
import { Send, Globe, FileSpreadsheet, FileBarChart } from 'lucide-react';

const DEFAULT_AUDIT_SHEET_URL =
    import.meta.env.VITE_DEFAULT_AUDIT_SHEET_URL ||
    'https://docs.google.com/spreadsheets/d/119SxL31wtYHjkeNLH28mGHuy4-lkp91SKHHbxyrYJHk/edit?gid=941263829#gid=941263829';

const DEFAULT_ACTION_PLAN_SHEET_URL =
    import.meta.env.VITE_DEFAULT_ACTION_PLAN_SHEET_URL ||
    'https://docs.google.com/spreadsheets/d/1dW7DK86dxmlJjCPPTdX_i8kbdA6hctt8OhupwLMmQ5k/edit?gid=1094454912#gid=1094454912';

const createInitialFormData = () => ({
    siteName: '',
    siteUrl: '',
    auditSheetUrl: DEFAULT_AUDIT_SHEET_URL,
    actionPlanSheetUrl: DEFAULT_ACTION_PLAN_SHEET_URL,
    mrmReportUrl: ''
});

const NewAuditForm = ({ onAuditSuccess }) => {
    const [formData, setFormData] = useState(createInitialFormData);

    const [loading, setLoading] = useState(false);

    const handleSubmit = async (e) => {
        e.preventDefault();
        setLoading(true);
        try {
            const token = localStorage.getItem('token');
            const response = await fetch('/api/audits', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },
                body: JSON.stringify(formData),
                credentials: 'include'
            });
            const data = await response.json();
            if (response.ok) {
                // Success - redirect to progression
                if (onAuditSuccess) {
                    onAuditSuccess();
                }
                setFormData(createInitialFormData());
            } else {
                alert(data.error || 'Erreur lors du lancement');
            }
        } catch (err) {
            alert('Erreur réseau lors du lancement de l\'audit');
        } finally {
            setLoading(false);
        }
    };

    const handleChange = (e) => {
        setFormData({ ...formData, [e.target.name]: e.target.value });
    };

    const fields = [
        { name: 'siteName', label: 'Nom du site', icon: Globe, placeholder: 'Ex: EurekIA' },
        { name: 'siteUrl', label: 'Lien du site', icon: Globe, placeholder: 'https://mon-site.fr' },
        { name: 'auditSheetUrl', label: 'Lien Google Sheet Audit', icon: FileSpreadsheet, placeholder: 'Lien avec droits éditeurs' },
        { name: 'actionPlanSheetUrl', label: 'Lien Google Sheet Plan d\'action (source audit)', icon: FileSpreadsheet, placeholder: 'Sheet source utilisé pour les captures' },
        { name: 'mrmReportUrl', label: 'Lien Rapport My Ranking Metrics', icon: FileBarChart, placeholder: 'Lien du rapport' },
    ];

    return (
        <div className="max-w-3xl mx-auto">
            <div className="mb-8">
                <h3 className="text-xl font-semibold text-slate-900 mb-2">Lancer une nouvelle analyse</h3>
                <p className="text-slate-600 text-sm">
                    Remplissez les informations ci-dessous. Le système utilisera Playwright pour les captures et Airtable pour le stockage.
                </p>
            </div>

            <form onSubmit={handleSubmit} className="grid grid-cols-1 md:grid-cols-2 gap-6">
                {fields.map((field) => (
                    <div key={field.name} className={`space-y-2 ${field.name === 'mrmReportUrl' ? 'md:col-span-2' : ''}`}>
                        <label className="text-sm font-medium text-slate-700 ml-1 flex items-center gap-2">
                            <field.icon size={16} className="text-blue-500" />
                            {field.label}
                        </label>
                        <input
                            type="text"
                            name={field.name}
                            value={formData[field.name]}
                            onChange={handleChange}
                            className="w-full bg-white/90 border border-slate-200 rounded-xl py-3 px-4 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 transition-all text-slate-900 placeholder:text-slate-400 shadow-sm"
                            placeholder={field.placeholder}
                            required
                        />
                    </div>
                ))}

                <div className="md:col-span-2 pt-6">
                    <button
                        type="submit"
                        disabled={loading}
                        className="w-full md:w-auto btn-primary px-12 py-4 flex items-center justify-center gap-3 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                        {loading ? (
                            <div className="w-5 h-5 border-2 border-white/20 border-t-white rounded-full animate-spin" />
                        ) : (
                            <>
                                Lancer l'audit
                                <Send size={18} />
                            </>
                        )}
                    </button>
                </div>
            </form>
        </div>
    );
};

export default NewAuditForm;
