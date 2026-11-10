import React from 'react';
import {
  LayoutDashboard,
  Film,
  UploadCloud,
  Calendar,
  History,
  Settings,
  X,
} from 'lucide-react';

export type PageId = 'overview' | 'reels' | 'upload' | 'schedule' | 'history' | 'settings';

interface SidebarProps {
  currentPage: PageId;
  onSelectPage: (page: PageId) => void;
  isOpen: boolean;
  onClose: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  currentPage,
  onSelectPage,
  isOpen,
  onClose,
}) => {
  const navItems: Array<{ id: PageId; label: string; icon: React.ReactNode }> = [
    { id: 'overview', label: 'Overview', icon: <LayoutDashboard className="w-5 h-5" /> },
    { id: 'reels', label: 'Reel Manager', icon: <Film className="w-5 h-5" /> },
    { id: 'upload', label: 'Upload & Pair', icon: <UploadCloud className="w-5 h-5" /> },
    { id: 'schedule', label: 'Schedule & Slots', icon: <Calendar className="w-5 h-5" /> },
    { id: 'history', label: 'Publish History', icon: <History className="w-5 h-5" /> },
    { id: 'settings', label: 'Settings', icon: <Settings className="w-5 h-5" /> },
  ];

  const handleSelect = (id: PageId) => {
    onSelectPage(id);
    onClose();
  };

  return (
    <>
      {/* Mobile backdrop */}
      {isOpen && (
        <div
          onClick={onClose}
          className="fixed inset-0 z-40 bg-slate-900/50 backdrop-blur-sm lg:hidden"
        />
      )}

      <aside
        className={`fixed top-0 bottom-0 left-0 z-40 w-64 bg-white dark:bg-slate-900 border-r border-slate-200 dark:border-slate-800 flex flex-col transition-transform duration-200 ease-in-out lg:translate-x-0 ${
          isOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="h-16 flex items-center justify-between px-6 border-b border-slate-200 dark:border-slate-800">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-tr from-brand-600 to-indigo-600 flex items-center justify-center text-white font-black text-lg shadow-sm">
              R
            </div>
            <span className="font-extrabold text-lg tracking-tight">ReelHub</span>
          </div>
          <button
            onClick={onClose}
            className="lg:hidden p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Navigation list */}
        <nav className="flex-1 p-4 space-y-1.5 overflow-y-auto">
          {navItems.map((item) => {
            const active = currentPage === item.id;
            return (
              <button
                key={item.id}
                onClick={() => handleSelect(item.id)}
                className={`w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl text-sm font-semibold transition-all ${
                  active
                    ? 'bg-brand-500 text-white shadow-sm shadow-brand-500/20'
                    : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800/60 hover:text-slate-900 dark:hover:text-slate-100'
                }`}
              >
                {item.icon}
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        {/* Footer info */}
        <div className="p-4 border-t border-slate-200 dark:border-slate-800 text-xs text-slate-400 dark:text-slate-500 space-y-1">
          <div className="flex justify-between">
            <span>Timezone:</span>
            <span className="font-medium text-slate-700 dark:text-slate-300">Asia/Kolkata</span>
          </div>
          <div className="flex justify-between">
            <span>Engine:</span>
            <span className="font-medium text-slate-700 dark:text-slate-300">Fastify + SQLite WAL</span>
          </div>
        </div>
      </aside>
    </>
  );
};

