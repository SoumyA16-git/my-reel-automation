import React, { useEffect, useState } from 'react';
import { api } from '../api/client';
import { StatusChip } from '../components/StatusChip';
import { InstagramIcon, FacebookIcon } from '../components/BrandIcons';
import {
  Settings,
  Send,
  Database,
  Shield,
  Key,
  CheckCircle2,
  AlertCircle,
  RotateCw,
  Sliders,
} from 'lucide-react';

export const SettingsPage: React.FC = () => {
  const [destinations, setDestinations] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'accounts' | 'system' | 'limits'>('accounts');

  // Telegram connect form
  const [tgBotToken, setTgBotToken] = useState('');
  const [tgChatId, setTgChatId] = useState('');
  const [isConnectingTg, setIsConnectingTg] = useState(false);

  // Meta connect form
  const [metaKind, setMetaKind] = useState<'instagram' | 'facebook'>('instagram');
  const [metaTargetId, setMetaTargetId] = useState('');
  const [metaToken, setMetaToken] = useState('');
  const [isConnectingMeta, setIsConnectingMeta] = useState(false);

  // Backup trigger state
  const [backupRunning, setBackupRunning] = useState(false);
  const [backupResult, setBackupResult] = useState<string | null>(null);

  const loadDestinations = async () => {
    try {
      setLoading(true);
      const res = await api.getDestinations();
      setDestinations(res.destinations || []);
    } catch (e) {
      console.error('Failed to load destinations', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadDestinations();
  }, []);

  const handleConnectTelegram = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setIsConnectingTg(true);
      await api.connectTelegram({
        botToken: tgBotToken,
        chatId: tgChatId,
      });
      alert('Telegram channel connected successfully!');
      setTgBotToken('');
      setTgChatId('');
      await loadDestinations();
    } catch (err: any) {
      alert(`Telegram connect failed: ${err.message}`);
    } finally {
      setIsConnectingTg(false);
    }
  };

  const handleConnectMeta = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setIsConnectingMeta(true);
      await api.connectMetaManual({
        kind: metaKind,
        targetId: metaTargetId,
        accessToken: metaToken,
      });
      alert(`${metaKind === 'instagram' ? 'Instagram' : 'Facebook'} connected successfully!`);
      setMetaTargetId('');
      setMetaToken('');
      await loadDestinations();
    } catch (err: any) {
      alert(`Meta connect failed: ${err.message}`);
    } finally {
      setIsConnectingMeta(false);
    }
  };

  const handleRunBackup = async () => {
    try {
      setBackupRunning(true);
      setBackupResult(null);
      const res = await api.runBackup();
      setBackupResult(`Backup created and encrypted successfully! File: ${res.backupPath}`);
    } catch (err: any) {
      alert(`Backup failed: ${err.message}`);
    } finally {
      setBackupRunning(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold">Settings & Account Management</h2>
        <p className="text-xs text-slate-500 mt-1">
          Manage destination credentials, online backups, and platform publishing limits.
        </p>
      </div>

      {/* Tabs */}
      <div className="flex items-center gap-2 border-b border-slate-200 dark:border-slate-800 text-xs font-semibold">
        <button
          onClick={() => setActiveTab('accounts')}
          className={`pb-2.5 px-3 border-b-2 transition ${
            activeTab === 'accounts'
              ? 'border-brand-600 text-brand-600 dark:text-brand-400'
              : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
          }`}
        >
          Connected Accounts
        </button>
        <button
          onClick={() => setActiveTab('system')}
          className={`pb-2.5 px-3 border-b-2 transition ${
            activeTab === 'system'
              ? 'border-brand-600 text-brand-600 dark:text-brand-400'
              : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
          }`}
        >
          System Health & Backups
        </button>
        <button
          onClick={() => setActiveTab('limits')}
          className={`pb-2.5 px-3 border-b-2 transition ${
            activeTab === 'limits'
              ? 'border-brand-600 text-brand-600 dark:text-brand-400'
              : 'border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200'
          }`}
        >
          Platform Limits & Pre-flight
        </button>
      </div>

      {/* TAB 1: Accounts */}
      {activeTab === 'accounts' && (
        <div className="space-y-6">
          {/* Active Destinations */}
          <div className="p-5 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-3">
            <h3 className="text-sm font-bold">Configured Destinations</h3>
            <div className="space-y-2">
              {destinations.map((d) => (
                <div
                  key={d.id}
                  className="flex items-center justify-between p-3 rounded-xl bg-slate-50 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-700 text-xs"
                >
                  <div className="flex items-center gap-2.5">
                    {d.kind === 'instagram' ? (
                      <InstagramIcon className="w-4 h-4 text-pink-600" />
                    ) : d.kind === 'facebook' ? (
                      <FacebookIcon className="w-4 h-4 text-blue-600" />
                    ) : (
                      <Send className="w-4 h-4 text-sky-500" />
                    )}
                    <div>
                      <span className="font-bold text-slate-900 dark:text-slate-100">{d.label}</span>
                      <span className="font-mono text-slate-400 ml-2">({d.target_id})</span>
                    </div>
                  </div>
                  <StatusChip status={d.paused === 1 ? 'paused' : 'active'} />
                </div>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            {/* Connect Telegram Channel */}
            <div className="p-5 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-4">
              <div className="flex items-center gap-2">
                <Send className="w-5 h-5 text-sky-500" />
                <h3 className="text-sm font-bold">Connect Telegram Channel</h3>
              </div>
              <p className="text-xs text-slate-400">
                Bot must be an admin of the channel with 'can_post_messages' permission.
              </p>

              <form onSubmit={handleConnectTelegram} className="space-y-3 text-xs">
                <div>
                  <label className="block font-semibold mb-1">Bot Token</label>
                  <input
                    type="password"
                    placeholder="123456789:ABCdefGHIjkl..."
                    value={tgBotToken}
                    onChange={(e) => setTgBotToken(e.target.value)}
                    required
                    className="w-full px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 font-mono"
                  />
                </div>
                <div>
                  <label className="block font-semibold mb-1">Channel Chat ID</label>
                  <input
                    type="text"
                    placeholder="-1001234567890 or @channelname"
                    value={tgChatId}
                    onChange={(e) => setTgChatId(e.target.value)}
                    required
                    className="w-full px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 font-mono"
                  />
                </div>
                <button
                  type="submit"
                  disabled={isConnectingTg}
                  className="w-full py-2.5 rounded-xl bg-sky-600 text-white font-semibold hover:bg-sky-700 disabled:opacity-50"
                >
                  {isConnectingTg ? 'Verifying...' : 'Save & Encrypt Telegram Bot'}
                </button>
              </form>
            </div>

            {/* Connect Meta Asset */}
            <div className="p-5 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-4">
              <div className="flex items-center gap-2">
                <InstagramIcon className="w-5 h-5 text-pink-600" />
                <h3 className="text-sm font-bold">Connect Meta (Instagram / Facebook)</h3>
              </div>
              <p className="text-xs text-slate-400">
                Direct token connection (Token is encrypted at rest using AES-256-GCM).
              </p>

              <form onSubmit={handleConnectMeta} className="space-y-3 text-xs">
                <div>
                  <label className="block font-semibold mb-1">Platform Kind</label>
                  <select
                    value={metaKind}
                    onChange={(e: any) => setMetaKind(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800"
                  >
                    <option value="instagram">Instagram Professional Account</option>
                    <option value="facebook">Facebook Page Reels</option>
                  </select>
                </div>
                <div>
                  <label className="block font-semibold mb-1">Target ID (IG User ID or Page ID)</label>
                  <input
                    type="text"
                    placeholder="e.g. 17841400000000000"
                    value={metaTargetId}
                    onChange={(e) => setMetaTargetId(e.target.value)}
                    required
                    className="w-full px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 font-mono"
                  />
                </div>
                <div>
                  <label className="block font-semibold mb-1">Access Token</label>
                  <input
                    type="password"
                    placeholder="EAAB..."
                    value={metaToken}
                    onChange={(e) => setMetaToken(e.target.value)}
                    required
                    className="w-full px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 font-mono"
                  />
                </div>
                <button
                  type="submit"
                  disabled={isConnectingMeta}
                  className="w-full py-2.5 rounded-xl bg-brand-600 text-white font-semibold hover:bg-brand-700 disabled:opacity-50"
                >
                  {isConnectingMeta ? 'Validating...' : 'Save & Encrypt Meta Asset'}
                </button>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: System */}
      {activeTab === 'system' && (
        <div className="space-y-4">
          <div className="p-5 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-4">
            <h3 className="text-sm font-bold flex items-center gap-2">
              <Database className="w-4 h-4 text-indigo-600" /> Online SQLite Backup Engine
            </h3>
            <p className="text-xs text-slate-500">
              Backups run automatically every 6 hours using SQLite's online backup API, encrypted with AES-256-GCM.
            </p>

            {backupResult && (
              <div className="p-3.5 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 text-xs text-emerald-700 dark:text-emerald-300 flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4" />
                <span>{backupResult}</span>
              </div>
            )}

            <button
              onClick={handleRunBackup}
              disabled={backupRunning}
              className="px-4 py-2.5 rounded-xl bg-brand-600 hover:bg-brand-700 text-white text-xs font-semibold flex items-center gap-2 shadow disabled:opacity-50"
            >
              {backupRunning ? (
                <>
                  <RotateCw className="w-3.5 h-3.5 animate-spin" /> Creating Encrypted Backup...
                </>
              ) : (
                <>
                  <Database className="w-3.5 h-3.5" /> Trigger Manual Backup Now
                </>
              )}
            </button>
          </div>
        </div>
      )}

      {/* TAB 3: Limits */}
      {activeTab === 'limits' && (
        <div className="p-6 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-4 text-xs">
          <h3 className="text-sm font-bold flex items-center gap-2">
            <Sliders className="w-4 h-4 text-brand-600" /> Platform Pre-Flight Publishing Limits (PRD 10.7)
          </h3>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-2">
            <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-700 space-y-2">
              <h4 className="font-bold text-pink-600">Instagram Platform Limits</h4>
              <p>• Max file size: 300 MB</p>
              <p>• Duration: 3s – 15 min</p>
              <p>• Formats: MP4/MOV, H.264/HEVC, AAC</p>
              <p>• Rolling 24h limit: 100 posts</p>
            </div>

            <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-700 space-y-2">
              <h4 className="font-bold text-blue-600">Facebook Page Reels</h4>
              <p>• Min resolution: 540p (blocked if &lt;540p)</p>
              <p>• Rolling 24h limit: 30 posts per page</p>
              <p>• Formats: MP4, H.264, AAC</p>
            </div>

            <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-800/40 border border-slate-200 dark:border-slate-700 space-y-2">
              <h4 className="font-bold text-sky-600">Telegram Bot API</h4>
              <p>• Cloud Bot API limit: 50 MB</p>
              <p>• Local Bot API server: 2000 MB</p>
              <p>• Max caption length: 1024 characters</p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
