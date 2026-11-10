import React, { useEffect, useState } from 'react';
import { api } from '../api/client';
import { useEvents } from '../context/EventsContext';
import { StatusChip } from '../components/StatusChip';
import { formatDateTimeIST } from '../lib/utils';
import {
  Film,
  Search,
  Filter,
  Zap,
  Trash2,
  ExternalLink,
  RotateCw,
  RefreshCcw,
  CheckCircle,
} from 'lucide-react';

export const ReelsPage: React.FC = () => {
  const { subscribe } = useEvents();
  const [reels, setReels] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedReel, setSelectedReel] = useState<any | null>(null);
  const [actionLoading, setActionLoading] = useState<number | null>(null);

  const loadReels = async () => {
    try {
      setLoading(true);
      const res = await api.getReels({
        status: statusFilter === 'all' ? undefined : statusFilter,
        limit: 100,
      });
      setReels(res.reels || []);
    } catch (e) {
      console.error('Failed to load reels', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadReels();

    const unsubReel = subscribe('reel.status_changed', () => loadReels());
    return () => unsubReel();
  }, [statusFilter, subscribe]);

  const handlePublishNow = async (id: number) => {
    try {
      setActionLoading(id);
      await api.publishNow(id);
      await loadReels();
    } catch (e: any) {
      alert(`Publish Now failed: ${e.message}`);
    } finally {
      setActionLoading(null);
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('Are you sure you want to delete this Reel? If raw file is present and not delivered, it will be deleted.')) {
      return;
    }
    try {
      await api.deleteReel(id);
      await loadReels();
    } catch (e: any) {
      alert(`Delete failed: ${e.message}`);
    }
  };

  const handleRetryDestination = async (reelId: number, destId: number) => {
    try {
      await api.retryDestination(reelId, destId);
      await loadReels();
    } catch (e: any) {
      alert(`Retry failed: ${e.message}`);
    }
  };

  const filteredReels = reels.filter((r) => {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      r.publicId?.toLowerCase().includes(q) ||
      r.originalFilename?.toLowerCase().includes(q) ||
      r.filenameStem?.toLowerCase().includes(q)
    );
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold">Reel Manager</h2>
          <p className="text-xs text-slate-500 mt-1">
            Filter, inspect captions, trigger Publish Now, and resolve destination delivery outcomes.
          </p>
        </div>

        {/* Search */}
        <div className="relative min-w-[240px]">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-3" />
          <input
            type="text"
            placeholder="Search by filename or ID..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-9 pr-3.5 py-2 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 text-xs focus:ring-2 focus:ring-brand-500"
          />
        </div>
      </div>

      {/* Filter Tabs */}
      <div className="flex items-center gap-1.5 overflow-x-auto pb-1 text-xs">
        {['all', 'draft', 'ready', 'scheduled', 'publishing', 'completed', 'failed'].map((st) => (
          <button
            key={st}
            onClick={() => setStatusFilter(st)}
            className={`px-3 py-1.5 rounded-lg capitalize font-semibold transition ${
              statusFilter === st
                ? 'bg-brand-600 text-white shadow-sm'
                : 'bg-white dark:bg-slate-900 text-slate-600 dark:text-slate-400 border border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800'
            }`}
          >
            {st}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 dark:bg-slate-800/50 text-slate-500 font-semibold border-b border-slate-200 dark:border-slate-800">
              <tr>
                <th className="p-3.5">Reel ID & Filename</th>
                <th className="p-3.5">Status</th>
                <th className="p-3.5">Videos</th>
                <th className="p-3.5">Destinations</th>
                <th className="p-3.5">Created (IST)</th>
                <th className="p-3.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60 font-medium">
              {filteredReels.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-center py-12 text-slate-400">
                    No reels matching current filter.
                  </td>
                </tr>
              ) : (
                filteredReels.map((reel) => (
                  <tr
                    key={reel.id}
                    className="hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition"
                  >
                    <td className="p-3.5">
                      <div className="font-bold text-slate-900 dark:text-slate-100">
                        {reel.filenameStem || reel.originalFilename}
                      </div>
                      <div className="font-mono text-[11px] text-slate-400">{reel.publicId}</div>
                    </td>

                    <td className="p-3.5">
                      <StatusChip status={reel.status} />
                    </td>

                    <td className="p-3.5">
                      <div className="flex items-center gap-1.5">
                        <span className="px-1.5 py-0.5 rounded text-[10px] bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
                          Censored
                        </span>
                        <span className="px-1.5 py-0.5 rounded text-[10px] bg-sky-50 dark:bg-sky-950 text-sky-600 dark:text-sky-300">
                          Raw
                        </span>
                      </div>
                    </td>

                    <td className="p-3.5">
                      <div className="flex items-center gap-1">
                        <span className="px-1.5 py-0.5 rounded text-[10px] bg-pink-50 dark:bg-pink-950 text-pink-600">IG</span>
                        <span className="px-1.5 py-0.5 rounded text-[10px] bg-blue-50 dark:bg-blue-950 text-blue-600">FB</span>
                        <span className="px-1.5 py-0.5 rounded text-[10px] bg-cyan-50 dark:bg-cyan-950 text-cyan-600">TG</span>
                      </div>
                    </td>

                    <td className="p-3.5 text-slate-500 whitespace-nowrap">
                      {formatDateTimeIST(reel.createdAt)}
                    </td>

                    <td className="p-3.5 text-right space-x-1 whitespace-nowrap">
                      {/* Publish Now Button (FR-010) */}
                      {reel.status === 'ready' && (
                        <button
                          onClick={() => handlePublishNow(reel.id)}
                          disabled={actionLoading === reel.id}
                          className="px-2.5 py-1 rounded-lg bg-brand-500 hover:bg-brand-600 text-white text-xs font-semibold shadow-sm inline-flex items-center gap-1"
                          title="Immediately schedule & publish to all destinations"
                        >
                          <Zap className="w-3 h-3 fill-current" /> Publish Now
                        </button>
                      )}

                      <button
                        onClick={() => handleDelete(reel.id)}
                        className="p-1.5 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40"
                        title="Delete Reel"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};

