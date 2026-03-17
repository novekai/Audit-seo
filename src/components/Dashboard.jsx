import React, { useState } from 'react';
import {
    BarChart3,
    FilePlus2,
    PlaySquare,
    Menu,
    X,
    LogOut,
    Settings as SettingsIcon,
    Bell,
    Search,
    User
} from 'lucide-react';
import NewAuditForm from './NewAuditForm';
import Settings from './Settings';
import Progression from './Progression';
import Slides from './Slides';

const Layout = ({ user, onLogout }) => {
    const [activeTab, setActiveTab] = useState(() => {
        return sessionStorage.getItem('activeTab') || 'new-audit';
    });
    const [isSidebarOpen, setSidebarOpen] = useState(false);

    const handleTabChange = (tabId) => {
        setActiveTab(tabId);
        sessionStorage.setItem('activeTab', tabId);
    };

    const menuItems = [
        { id: 'new-audit', label: 'Nouvel audit', icon: FilePlus2 },
        { id: 'progression', label: 'Progression', icon: BarChart3 },
        { id: 'slides', label: 'Slides', icon: PlaySquare },
        { id: 'settings', label: 'Paramètres', icon: SettingsIcon },
    ];

    return (
        <div className="min-h-screen flex text-slate-900 overflow-hidden relative">
            {isSidebarOpen && (
                <div
                    className="fixed inset-0 bg-slate-900/20 backdrop-blur-sm z-40 lg:hidden"
                    onClick={() => setSidebarOpen(false)}
                />
            )}

            <aside
                className={`fixed inset-y-0 left-0 z-50 transition-all duration-300 ease-in-out flex flex-col glass border-r border-slate-200/80
                    ${isSidebarOpen ? 'w-64 translate-x-0' : 'w-64 -translate-x-full lg:translate-x-0 lg:w-20'}
                    lg:relative lg:translate-x-0`}
            >
                <div className="p-6 flex items-center justify-between">
                    <div className={`flex items-center gap-3 ${!isSidebarOpen && 'lg:hidden'}`}>
                        <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
                            <span className="font-bold text-white">S</span>
                        </div>
                        <span className="font-bold text-xl tracking-tight leading-none">Smart Audit</span>
                    </div>
                    <button
                        onClick={() => setSidebarOpen(!isSidebarOpen)}
                        className="p-2 hover:bg-slate-100 rounded-lg transition-colors text-slate-500 hover:text-slate-900"
                    >
                        {isSidebarOpen ? <X size={20} /> : <Menu size={20} />}
                    </button>
                </div>

                <nav className="flex-1 px-3 py-6 space-y-2 flex flex-col items-center">
                    {menuItems.map((item) => {
                        const Icon = item.icon;
                        const isActive = activeTab === item.id;
                        return (
                            <button
                                key={item.id}
                                onClick={() => {
                                    handleTabChange(item.id);
                                    if (window.innerWidth < 1024) setSidebarOpen(false);
                                }}
                                className={`w-full flex items-center p-3 rounded-xl transition-all duration-200 group relative ${isActive
                                    ? 'bg-blue-600 text-white shadow-lg shadow-blue-200'
                                    : 'text-slate-600 hover:bg-white/80 hover:text-slate-900'
                                    } ${!isSidebarOpen ? 'justify-center lg:w-12 lg:h-12' : 'gap-4'}`}
                            >
                                <Icon
                                    size={24}
                                    className={`${isActive ? 'scale-110' : 'group-hover:scale-110'} transition-transform duration-300 shrink-0`}
                                />
                                {isSidebarOpen && (
                                    <span className="font-medium whitespace-nowrap overflow-hidden transition-all duration-300">
                                        {item.label}
                                    </span>
                                )}
                                {!isSidebarOpen && (
                                    <div className="absolute left-full ml-4 px-2 py-1 bg-slate-900 text-white text-xs rounded opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity whitespace-nowrap z-50 shadow-lg">
                                        {item.label}
                                    </div>
                                )}
                            </button>
                        );
                    })}
                </nav>

                <div className="p-4 border-t border-slate-200/80 flex justify-center">
                    <button
                        onClick={onLogout}
                        className={`flex items-center rounded-xl text-rose-500 hover:bg-rose-50 transition-all font-medium ${!isSidebarOpen ? 'lg:w-12 lg:h-12 justify-center' : 'w-full gap-4 p-3'}`}
                        title="Déconnexion"
                    >
                        <LogOut size={22} className="shrink-0" />
                        {isSidebarOpen && <span>Déconnexion</span>}
                    </button>
                </div>
            </aside>

            <main className="flex-1 flex flex-col relative overflow-auto">
                <header className="h-20 lg:h-16 flex items-center justify-between px-4 lg:px-8 border-b border-slate-200/80 glass sticky top-0 z-30 gap-4">
                    <div className="flex items-center lg:hidden mr-2">
                        <button
                            onClick={() => setSidebarOpen(true)}
                            className="p-2 hover:bg-slate-100 rounded-lg text-slate-500 hover:text-slate-900"
                        >
                            <Menu size={24} />
                        </button>
                    </div>

                    <div className="flex-1 max-w-xl">
                        <div className="flex items-center gap-3 bg-white/85 border border-slate-200 px-4 py-2 rounded-xl group focus-within:ring-2 focus-within:ring-blue-500/20 focus-within:border-blue-300 transition-all shadow-sm">
                            <Search size={18} className="text-slate-400 group-focus-within:text-blue-500 transition-colors shrink-0" />
                            <input
                                type="text"
                                placeholder="Rechercher..."
                                className="bg-transparent border-none outline-none text-sm w-full placeholder:text-slate-400 text-slate-800"
                            />
                        </div>
                    </div>

                    <div className="flex items-center gap-2 lg:gap-6">
                        <button className="relative p-2 text-slate-500 hover:text-slate-900 transition-colors">
                            <Bell size={20} />
                            <div className="absolute top-2 right-2 w-2 h-2 bg-blue-500 rounded-full border-2 border-white" />
                        </button>

                        <div className="flex items-center gap-3 pl-2 lg:pl-6 border-l border-slate-200">
                            <div className="text-right hidden sm:block">
                                <p className="text-sm font-semibold whitespace-nowrap">{user?.email || 'Admin Novek'}</p>
                                <p className="text-[10px] text-slate-500 uppercase tracking-tighter">Administrateur</p>
                            </div>
                            <div className="w-9 h-9 lg:w-10 lg:h-10 bg-gradient-to-tr from-blue-500 to-cyan-500 rounded-full flex items-center justify-center border-2 border-white shadow-lg shadow-blue-100 overflow-hidden shrink-0 text-white">
                                <User size={18} />
                            </div>
                        </div>
                    </div>
                </header>

                <section className="p-4 lg:p-8">
                    <div className="mb-6 lg:mb-8">
                        <h2 className="text-xl lg:text-2xl font-bold mb-2">
                            {menuItems.find(i => i.id === activeTab)?.label}
                        </h2>
                        <div className="h-1 w-16 lg:w-20 bg-blue-500 rounded-full" />
                    </div>

                    <div className="glass rounded-3xl p-4 lg:p-8 border border-slate-200/80 relative overflow-hidden min-h-[calc(100vh-12rem)]">
                        {activeTab === 'new-audit' && <NewAuditForm onAuditSuccess={() => handleTabChange('progression')} />}
                        {activeTab === 'slides' && <Slides />}
                        {activeTab === 'progression' && <Progression onOpenSlides={() => handleTabChange('slides')} />}
                        {activeTab === 'settings' && <Settings />}
                    </div>
                </section>
            </main>
        </div>
    );
};

export default Layout;
