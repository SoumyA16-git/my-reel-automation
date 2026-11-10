import React, { useState, useEffect } from 'react';
import { api } from '../api/client';
import { useAuth } from '../context/AuthContext';
import { useEvents } from '../context/EventsContext';
import { NotificationDrawer } from './NotificationDrawer';
import {
  Pause,
  Play,
  Bell,
  Sun,
  Moon,
  LogOut,
  Radio,
  Menu,
} from 'lucide-react';

interface NavbarProps {
  onToggleSidebar: () => void;
}

export const Navbar: React.FC<NavbarProps> = ({ onToggleSidebar }) => {
  const { user, logout } = useAuth();
  const { status: sseStatus, subscribe } = useEvents();
  const [isPaused, setIsPaused] = useState(false);
  const [isPausing, setIsPausing] = useState(false);
  const [isDark, setIsDark] = useState(
    document.documentElement.classList.contains('dark') ||
      window.matchMedia('(prefers-color-scheme: dark)').matches,
  );
  const [notifications, setNotifications] = useState<any[]>([]);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);

  const fetchAutomationStatus = async () => {
    try {
      const res = await api.getAutomationStatus();
      setIsPaused(res.paused);
    } catch {
      // ignore
    }
  };

  const fetchNotifications = async () => {
    try {
      const res = await api.getNotifications(false);
      setNotifications(res.notifications || []);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    fetchAutomationStatus();
    fetchNotifications();

    const unsubNotif = subscribe('notification.created', () => {
      fetchNotifications();
    });

    return () => {
      unsubNotif();
    };
  }, [subscribe]);

  const toggleAutomation = async () => {
    try {
      setIsPausing(true);
      if (isPaused) {
        await api.resumeAutomation();
        setIsPaused(false);
      } else {
        await api.pauseAutomation();
        setIsPaused(true);
      }
    } catch (e) {
      console.error('Failed to toggle automation pause', e);
    } finally {
      setIsPausing(false);
    }
  };

  const toggleTheme = () => {
    const next = !isDark;
    setIsDark(next);
    if (next) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  };

  const unreadCount = notifications.filter((n) => !n.read_at).length;

  return (
    <>
      <header className="h-16 bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between px-4 lg:px-8 z-30 sticky top-0">
        <div className="flex items-center gap-3">
          <button
            onClick={onToggleSidebar}
            className="lg:hidden p-2 rounded-lg text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <Menu className="w-5 h-5" />
          </button>
          <div className="flex items-center gap-2">
            <span className="font-extrabold text-xl tracking-tight bg-gradient-to-r from-brand-600 to-indigo-600 bg-clip-text text-transparent">
              ReelHub
            </span>
            <span className="text-xs px-2 py-0.5 rounded font-mono font-medium bg-slate-100 dark:bg-slate-800 text-slate-500">
              v1.0
            </span>
          </div>
        </div>

        {/* Global persistent controls */}
        <div className="flex items-center gap-2 sm:gap-4">
          {/* SSE Live status indicator */}
          <div
            title={`Real-time events: ${sseStatus}`}
            className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700"
          >
            <Radio
              className={`w-3.5 h-3.5 ${
                sseStatus === 'connected'
                  ? 'text-emerald-500 animate-pulse'
                  : sseStatus === 'connecting'
                  ? 'text-amber-500 animate-spin'
                  : 'text-slate-400'
              }`}
            />
            <span className="capitalize">{sseStatus === 'connected' ? 'Live' : sseStatus}</span>
          </div>

          {/* Global Automation Pause Toggle (PRD 14) */}
          <button
            onClick={toggleAutomation}
            disabled={isPausing}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all ${
              isPaused
                ? 'bg-amber-500/10 border-amber-500/30 text-amber-600 dark:text-amber-400 hover:bg-amber-500/20'
                : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/20'
            }`}
          >
            {isPaused ? (
              <>
                <Play className="w-3.5 h-3.5 fill-current" />
                <span>Resume Automation</span>
              </>
            ) : (
              <>
                <Pause className="w-3.5 h-3.5 fill-current" />
                <span>Automation Active</span>
              </>
            )}
          </button>

          {/* Notifications Bell */}
          <button
            onClick={() => setIsDrawerOpen(true)}
            className="relative p-2 rounded-lg text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            title="Notifications"
          >
            <Bell className="w-5 h-5" />
            {unreadCount > 0 && (
              <span className="absolute top-1.5 right-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[10px] font-bold text-white animate-pulse">
                {unreadCount > 9 ? '9+' : unreadCount}
              </span>
            )}
          </button>

          {/* Theme Toggle */}
          <button
            onClick={toggleTheme}
            className="p-2 rounded-lg text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
            title="Toggle theme"
          >
            {isDark ? <Sun className="w-5 h-5" /> : <Moon className="w-5 h-5" />}
          </button>

          {/* User profile / Logout */}
          <div className="flex items-center gap-2 pl-2 border-l border-slate-200 dark:border-slate-800">
            <span className="text-xs font-medium text-slate-700 dark:text-slate-300 hidden md:inline-block">
              {user?.username}
            </span>
            <button
              onClick={logout}
              className="p-2 rounded-lg text-slate-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors"
              title="Logout"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>
      </header>

      <NotificationDrawer
        isOpen={isDrawerOpen}
        onClose={() => setIsDrawerOpen(false)}
        notifications={notifications}
        onRefresh={fetchNotifications}
      />
    </>
  );
};

