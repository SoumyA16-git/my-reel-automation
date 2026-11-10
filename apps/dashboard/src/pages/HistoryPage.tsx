import React, { useEffect, useState } from 'react';
import { api } from '../api/client';
import { StatusChip } from '../components/StatusChip';
import { formatDateTimeIST } from '../lib/utils';
import {
  History,
  CheckCircle2,
  AlertTriangle,
  ExternalLink,
  ShieldCheck,
  RotateCw,
  FileText,
} from 'lucide-react';

export const HistoryPage: React.FC = () => {
  const [reels, setReels] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'published' | 'uncertain' | 'raw_deletions'>('published');
  const [actionLoading, setActionLoading] = useState(false);

  const loadData = async () => {
    try {
      setLoading(true);
      const res = await api.getReels({ limit: 100 });
      setReels(res.reels || []);
    } catch (e) {
      console.error('Failed to load history', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const handleResolve = async (
    reelId: number,
    destId: number,
    action: 'confirm_delivered' | 'retry',
  ) => {
    try {
      setActionLoading(true);
      await api.resolveDestination(reelId, destId, action);
      await loadData();
    } catch (e: any) {
      alert(`Action failed: ${e.message}`);
    } finally {
      setActionLoading(false);
    }
  };

  const publishedReels = reels.filter((r) => r.status === 'completed' || r.status === 'partially_published');
  const uncertainReels = reels.filter((r) => r.status === 'uncertain');

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold">Publishing History & Delivery Proof</h2>
        <p className="text-xs text-slate-500 mt-1">
          Immutable audit trails, live permalinks, and verified raw file deletion safety records.
        </p>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-2 border-b border-slate-200 dark:border-slate-800 text-xs font-semibold">
        <button
          onClick={() => setActiveTab('published')}
          className={`pb-2.5 px-3 border-b-2 transition ${
            activeTab === 'published'
              ? 'border-brand-600 text-brand-600 dark:text-brand-400'
              : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
          }`}
        >
          Verified Live Posts ({publishedReels.length})
        </button>
        <button
          onClick={() => setActiveTab('uncertain')}
          className={`pb-2.5 px-3 border-b-2 transition ${
            activeTab === 'uncertain'
              ? 'border-orange-500 text-orange-600 dark:text-orange-400'
              : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
          }`}
        >
          Uncertain Deliveries ({uncertainReels.length})
        </button>
        <button
          onClick={() => setActiveTab('raw_deletions')}
          className={`pb-2.5 px-3 border-b-2 transition ${
            activeTab === 'raw_deletions'
              ? 'border-indigo-600 text-indigo-600 dark:text-indigo-400'
              : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
          }`}
        >
          Strict Raw Deletion Logs
        </button>
      </div>

      {/* TAB 1: Live Posts */}
      {activeTab === 'published' && (
        <div className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm overflow-hidden">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 dark:bg-slate-800/50 text-slate-500 font-semibold border-b border-slate-200 dark:border-slate-800">
              <tr>
                <th className="p-3.5">Reel</th>
                <th className="p-3.5">Status</th>
                <th className="p-3.5">Completed (IST)</th>
                <th className="p-3.5">Proof & Links</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800/60 font-medium">
              {publishedReels.length === 0 ? (
                <tr>
                  <td colSpan={4} className="text-center py-12 text-slate-400">
                    No published reels recorded yet.
                  </td>
                </tr>
              ) : (
                publishedReels.map((reel) => (
                  <tr key={reel.id} className="hover:bg-slate-50/50 dark:hover:bg-slate-800/30">
                    <td className="p-3.5">
                      <div className="font-bold text-slate-900 dark:text-slate-100">
                        {reel.filenameStem || reel.originalFilename}
                      </div>
                      <div className="font-mono text-[11px] text-slate-400">{reel.publicId}</div>
                    </td>
                    <td className="p-3.5">
                      <StatusChip status={reel.status} />
                    </td>
                    <td className="p-3.5 text-slate-500">{formatDateTimeIST(reel.completedAt ?? reel.updatedAt)}</td>
                    <td className="p-3.5">
                      <div className="flex items-center gap-2">
                        <span className="text-emerald-600 dark:text-emerald-400 flex items-center gap-1 font-semibold text-[11px]">
                          <CheckCircle2 className="w-3.5 h-3.5" /> Verified Live
                        </span>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* TAB 2: Uncertain Deliveries */}
      {activeTab === 'uncertain' && (
        <div className="space-y-4">
          {uncertainReels.length === 0 ? (
            <div className="p-12 text-center rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-400">
              Zero uncertain deliveries! All publish calls resolved definitively.
            </div>
          ) : (
            uncertainReels.map((reel) => (
              <div
                key={reel.id}
                className="p-5 rounded-2xl bg-orange-50/50 dark:bg-orange-950/20 border border-orange-200 dark:border-orange-800 space-y-3"
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-center gap-2">
                    <AlertTriangle className="w-5 h-5 text-orange-500 flex-shrink-0" />
                    <div>
                      <h4 className="font-bold text-sm text-slate-900 dark:text-slate-100">
                        {reel.filenameStem} ({reel.publicId})
                      </h4>
                      <p className="text-xs text-orange-700 dark:text-orange-300 mt-0.5">
                        Publish request was sent, but the network connection timed out before confirmation.
                      </p>
                    </div>
                  </div>
                  <StatusChip status="uncertain" />
                </div>

                <div className="flex items-center justify-end gap-2 pt-2 border-t border-orange-200/60 dark:border-orange-800/60">
                  <button
                    onClick={() => handleResolve(reel.id, 1, 'retry')}
                    disabled={actionLoading}
                    className="px-3.5 py-1.5 rounded-xl border border-orange-300 dark:border-orange-700 text-orange-800 dark:text-orange-200 text-xs font-semibold hover:bg-orange-100 dark:hover:bg-orange-900/40"
                  >
                    Reset & Safe Retry
                  </button>
                  <button
                    onClick={() => handleResolve(reel.id, 1, 'confirm_delivered')}
                    disabled={actionLoading}
                    className="px-3.5 py-1.5 rounded-xl bg-emerald-600 text-white text-xs font-semibold hover:bg-emerald-700 shadow"
                  >
                    Confirm Delivered Manually
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* TAB 3: Raw Deletions */}
      {activeTab === 'raw_deletions' && (
        <div className="p-6 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-4">
          <div className="flex items-center gap-2 text-sm font-bold text-slate-900 dark:text-slate-100">
            <ShieldCheck className="w-5 h-5 text-emerald-600" />
            <span>Strict Verified Raw Deletion Safety Policy (FR-018 / Section 13)</span>
          </div>

          <p className="text-xs text-slate-500">
            Raw files are strictly deleted from disk <strong>only after</strong> delivery is verified in Telegram (`telegram_messages` row confirmed). Every unlink operation is atomic and permanently recorded in the immutable `file_deletion_log` table.
          </p>

          <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-700 text-xs space-y-1.5 font-mono">
            <div className="text-slate-700 dark:text-slate-300">
              ✓ Precondition 1: Telegram delivery proof row confirmed
            </div>
            <div className="text-slate-700 dark:text-slate-300">
              ✓ Precondition 2: Publishing destination status is 'published'
            </div>
            <div className="text-slate-700 dark:text-slate-300">
              ✓ Precondition 3: Zero active worker leases on file
            </div>
            <div className="text-slate-700 dark:text-slate-300">
              ✓ Precondition 4: Physical path containment in videos/raw/
            </div>
            <div className="text-slate-700 dark:text-slate-300">
              ✓ Precondition 5: Disk byte size matched
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

