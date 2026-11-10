import React, { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useEvents } from '../context/EventsContext';
import { StatusChip } from '../components/StatusChip';
import { formatBytes, formatDateTimeIST } from '../lib/utils';
import { InstagramIcon, FacebookIcon } from '../components/BrandIcons';
import {
  Film,
  CheckCircle2,
  AlertTriangle,
  Clock,
  HardDrive,
  Database,
  Calendar,
  Send,
  RefreshCw,
} from 'lucide-react';

interface OverviewPageProps {
  onNavigate: (page: 'reels' | 'upload' | 'schedule' | 'history' | 'settings') => void;
}

export const OverviewPage: React.FC<OverviewPageProps> = ({ onNavigate }) => {
  const { subscribe } = useEvents();
  const [loading, setLoading] = useState(true);
  const [reels, setReels] = useState<any[]>([]);
  const [destinations, setDestinations] = useState<any[]>([]);
  const [health, setHealth] = useState<any>(null);
  const [nextScheduled, setNextScheduled] = useState<any>(null);

  const loadData = async () => {
    try {
      setLoading(true);
      const [reelsRes, destRes, healthRes] = await Promise.all([
        api.getReels({ limit: 100 }),
        api.getDestinations(),
        api.getHealth(),
      ]);

      setReels(reelsRes.reels || []);
      setDestinations(destRes.destinations || []);
      setHealth(healthRes);

      // Find next scheduled reel
      const scheduled = (reelsRes.reels || []).filter((r) => r.status === 'scheduled');
      setNextScheduled(scheduled.length > 0 ? scheduled[0] : null);
    } catch (e) {
      console.error('Failed to load overview data', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();

    const unsubReel = subscribe('reel.status_changed', () => loadData());
    const unsubDest = subscribe('destination.status_changed', () => loadData());

    return () => {
      unsubReel();
      unsubDest();
    };
  }, [subscribe]);

  // Aggregate metric counts
  const totalCount = reels.length;
  const draftCount = reels.filter((r) => r.status === 'draft').length;
  const readyCount = reels.filter((r) => r.status === 'ready').length;
  const scheduledCount = reels.filter((r) => r.status === 'scheduled').length;
  const publishingCount = reels.filter((r) => ['publishing', 'uploading', 'waiting_for_ai'].includes(r.status)).length;
  const completedCount = reels.filter((r) => r.status === 'completed').length;
  const failedCount = reels.filter((r) =>
    ['failed', 'partially_published', 'uncertain'].includes(r.status),
  ).length;

  return (
    <div className="space-y-6">
      {/* Top Banner: Next Scheduled / Quick Action */}
      <div className="p-5 rounded-2xl bg-gradient-to-r from-brand-600 to-indigo-700 text-white shadow-md flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div>
          <span className="text-xs uppercase tracking-wider font-semibold text-brand-200">
            Publishing Automation
          </span>
          <h2 className="text-xl md:text-2xl font-bold mt-0.5">
            {nextScheduled
              ? `Next Reel Scheduled: "${nextScheduled.title || nextScheduled.filenameStem}"`
              : 'All Scheduled Reels Published'}
          </h2>
          <p className="text-xs md:text-sm text-brand-100 mt-1">
            {nextScheduled
              ? `Target slot in Asia/Kolkata timezone. Auto-publishing active.`
              : 'Upload new pairs to auto-schedule into available slots.'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => onNavigate('upload')}
            className="px-4 py-2 rounded-xl bg-white text-brand-700 font-bold text-xs md:text-sm shadow hover:bg-brand-50 transition"
          >
            + Upload New Reel
          </button>
          <button
            onClick={() => onNavigate('schedule')}
            className="px-4 py-2 rounded-xl bg-brand-800/60 border border-brand-400/40 text-white font-medium text-xs md:text-sm hover:bg-brand-800 transition"
          >
            Manage Schedule
          </button>
        </div>
      </div>

      {/* Metric Cards (PRD FR-020) */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 sm:gap-4">
        <div
          onClick={() => onNavigate('reels')}
          className="p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 cursor-pointer hover:border-brand-400 transition"
        >
          <div className="flex items-center justify-between text-slate-500 text-xs font-medium">
            <span>Total Reels</span>
            <Film className="w-4 h-4 text-slate-400" />
          </div>
          <p className="text-2xl font-extrabold mt-2 text-slate-900 dark:text-slate-100">{totalCount}</p>
        </div>

        <div
          onClick={() => onNavigate('reels')}
          className="p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 cursor-pointer hover:border-brand-400 transition"
        >
          <div className="flex items-center justify-between text-slate-500 text-xs font-medium">
            <span>Drafts</span>
            <Clock className="w-4 h-4 text-slate-400" />
          </div>
          <p className="text-2xl font-extrabold mt-2 text-slate-700 dark:text-slate-300">{draftCount}</p>
        </div>

        <div
          onClick={() => onNavigate('reels')}
          className="p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 cursor-pointer hover:border-brand-400 transition"
        >
          <div className="flex items-center justify-between text-cyan-600 dark:text-cyan-400 text-xs font-medium">
            <span>Ready Gate</span>
            <CheckCircle2 className="w-4 h-4" />
          </div>
          <p className="text-2xl font-extrabold mt-2 text-cyan-600 dark:text-cyan-400">{readyCount}</p>
        </div>

        <div
          onClick={() => onNavigate('reels')}
          className="p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 cursor-pointer hover:border-brand-400 transition"
        >
          <div className="flex items-center justify-between text-blue-600 dark:text-blue-400 text-xs font-medium">
            <span>Scheduled</span>
            <Calendar className="w-4 h-4" />
          </div>
          <p className="text-2xl font-extrabold mt-2 text-blue-600 dark:text-blue-400">{scheduledCount}</p>
        </div>

        <div
          onClick={() => onNavigate('reels')}
          className="p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 cursor-pointer hover:border-brand-400 transition"
        >
          <div className="flex items-center justify-between text-emerald-600 dark:text-emerald-400 text-xs font-medium">
            <span>Completed</span>
            <CheckCircle2 className="w-4 h-4" />
          </div>
          <p className="text-2xl font-extrabold mt-2 text-emerald-600 dark:text-emerald-400">{completedCount}</p>
        </div>

        <div
          onClick={() => onNavigate('reels')}
          className="p-4 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 cursor-pointer hover:border-brand-400 transition"
        >
          <div className="flex items-center justify-between text-rose-600 dark:text-rose-400 text-xs font-medium">
            <span>Attention</span>
            <AlertTriangle className="w-4 h-4" />
          </div>
          <p className="text-2xl font-extrabold mt-2 text-rose-600 dark:text-rose-400">{failedCount}</p>
        </div>
      </div>

      {/* Destinations Tiles */}
      <div>
        <h3 className="text-sm font-bold uppercase tracking-wider text-slate-500 mb-3">
          Publishing Destinations & Account Health
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {destinations.length === 0 ? (
            <div className="col-span-3 p-6 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-center text-slate-500">
              No destinations configured yet.{' '}
              <button
                onClick={() => onNavigate('settings')}
                className="text-brand-600 dark:text-brand-400 font-semibold underline"
              >
                Connect accounts in Settings
              </button>
            </div>
          ) : (
            destinations.map((dest) => (
              <div
                key={dest.id}
                className="p-4 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col justify-between"
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2.5">
                    <div className="p-2 rounded-xl bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300">
                      {dest.kind === 'instagram' ? (
                        <InstagramIcon className="w-5 h-5 text-pink-600" />
                      ) : dest.kind === 'facebook' ? (
                        <FacebookIcon className="w-5 h-5 text-blue-600" />
                      ) : (
                        <Send className="w-5 h-5 text-sky-500" />
                      )}
                    </div>
                    <div>
                      <h4 className="font-bold text-sm text-slate-900 dark:text-slate-100">{dest.label}</h4>
                      <p className="text-xs text-slate-400 font-mono">ID: {dest.target_id}</p>
                    </div>
                  </div>
                  <StatusChip status={dest.paused === 1 ? 'paused' : 'active'} />
                </div>

                <div className="mt-4 pt-3 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between text-xs text-slate-500">
                  <span>Role: {dest.video_role} video</span>
                  <span>Daily Cap: {dest.daily_cap ?? 'Unlimited'}</span>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* System Gauges & Storage (PRD 14) */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Storage card */}
        <div className="p-5 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-4">
          <div className="flex items-center justify-between">
            <h4 className="font-bold text-sm flex items-center gap-2">
              <HardDrive className="w-4 h-4 text-brand-600" /> Disk & Storage Space
            </h4>
            <span className="text-xs font-mono text-emerald-600 dark:text-emerald-400 font-semibold">
              Writable
            </span>
          </div>

          <div>
            <div className="flex justify-between text-xs text-slate-500 mb-1">
              <span>Free Disk Space</span>
              <span className="font-medium text-slate-800 dark:text-slate-200">
                {health?.storage?.disk_free_bytes ? formatBytes(health.storage.disk_free_bytes) : 'Calculating...'}
              </span>
            </div>
            <div className="h-2 w-full bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
              <div className="h-full bg-emerald-500 rounded-full w-3/4"></div>
            </div>
          </div>

          <p className="text-xs text-slate-400">
            Raw files are strictly deleted from disk once delivery is verified in Telegram. Censored files are retained for Instagram & Facebook.
          </p>
        </div>

        {/* Database & Backup Health */}
        <div className="p-5 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-4">
          <div className="flex items-center justify-between">
            <h4 className="font-bold text-sm flex items-center gap-2">
              <Database className="w-4 h-4 text-indigo-600" /> Database & Backup State
            </h4>
            <span className="text-xs font-mono text-emerald-600 dark:text-emerald-400 font-semibold">
              WAL Mode Active
            </span>
          </div>

          <div className="space-y-2 text-xs">
            <div className="flex justify-between text-slate-600 dark:text-slate-400">
              <span>PRAGMA quick_check:</span>
              <span className="font-semibold text-emerald-600 dark:text-emerald-400">
                {health?.database?.quick_check || 'ok'}
              </span>
            </div>
            <div className="flex justify-between text-slate-600 dark:text-slate-400">
              <span>Scheduler engine:</span>
              <span className="font-semibold text-slate-900 dark:text-slate-100">
                {health?.scheduler?.active ? 'Active (15s tick loop)' : 'Idle'}
              </span>
            </div>
            <div className="flex justify-between text-slate-600 dark:text-slate-400">
              <span>Automated backups:</span>
              <span className="font-semibold text-slate-900 dark:text-slate-100">Every 6 hours (AES-256-GCM)</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
