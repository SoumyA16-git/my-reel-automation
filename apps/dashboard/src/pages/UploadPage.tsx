import React, { useState } from 'react';
import { api } from '../api/client';
import { formatBytes, formatDurationMs } from '../lib/utils';
import {
  UploadCloud,
  FileVideo,
  Sparkles,
  CheckCircle2,
  AlertTriangle,
  Play,
  RotateCw,
  Hash,
} from 'lucide-react';

interface UploadPageProps {
  onSuccess: () => void;
}

export const UploadPage: React.FC<UploadPageProps> = ({ onSuccess }) => {
  const [reelId, setReelId] = useState<number | null>(null);
  const [publicId, setPublicId] = useState<string | null>(null);

  // File states
  const [censoredFile, setCensoredFile] = useState<File | null>(null);
  const [rawFile, setRawFile] = useState<File | null>(null);
  const [censoredProbe, setCensoredProbe] = useState<any | null>(null);
  const [rawProbe, setRawProbe] = useState<any | null>(null);
  const [censoredFileId, setCensoredFileId] = useState<number | null>(null);

  // Upload status
  const [isUploadingCensored, setIsUploadingCensored] = useState(false);
  const [isUploadingRaw, setIsUploadingRaw] = useState(false);

  // AI caption state
  const [caption, setCaption] = useState<any | null>(null);
  const [isGeneratingAi, setIsGeneratingAi] = useState(false);
  const [editedTitle, setEditedTitle] = useState('');
  const [editedTags, setEditedTags] = useState('');
  const [isApproving, setIsApproving] = useState(false);
  const [approvalSuccess, setApprovalSuccess] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // 1. Create draft reel on first file select
  const ensureDraft = async (fileName: string) => {
    if (reelId) return reelId;
    const res = await api.createDraft(fileName);
    setReelId(res.reelId);
    setPublicId(res.publicId);
    return res.reelId;
  };

  // 2. Handle Censored Upload
  const handleCensoredSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setCensoredFile(file);
    setErrorMsg(null);

    try {
      setIsUploadingCensored(true);
      const rId = await ensureDraft(file.name);
      const res = await api.uploadMedia(rId, 'censored', file);
      setCensoredProbe(res.probe);
      setCensoredFileId(res.fileId);
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to upload censored video');
    } finally {
      setIsUploadingCensored(false);
    }
  };

  // 3. Handle Raw Upload
  const handleRawSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setRawFile(file);
    setErrorMsg(null);

    try {
      setIsUploadingRaw(true);
      const rId = await ensureDraft(file.name);
      const res = await api.uploadMedia(rId, 'raw', file);
      setRawProbe(res.probe);
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to upload raw video');
    } finally {
      setIsUploadingRaw(false);
    }
  };

  // 4. Trigger Gemini AI Caption
  const handleGenerateAi = async () => {
    if (!reelId) return;
    try {
      setIsGeneratingAi(true);
      setErrorMsg(null);
      const res = await api.generateCaption(reelId);
      setCaption(res.caption);
      setEditedTitle(res.caption.title || '');
      let tagsArr: string[] = [];
      try {
        tagsArr = typeof res.caption.hashtags === 'string' ? JSON.parse(res.caption.hashtags) : res.caption.hashtags;
      } catch {
        tagsArr = [];
      }
      setEditedTags(tagsArr.join(' '));
    } catch (err: any) {
      setErrorMsg(err.message || 'Gemini caption generation failed');
    } finally {
      setIsGeneratingAi(false);
    }
  };

  // 5. Approve & Mark Ready (FR-004)
  const handleApprove = async () => {
    if (!reelId || !caption) return;

    // Validate 2 hashtags format
    const tags = editedTags
      .split(/\s+/)
      .map((t) => t.trim())
      .filter((t) => t.startsWith('#'));

    if (tags.length !== 2) {
      setErrorMsg('Exactly 2 hashtags starting with # are required.');
      return;
    }

    try {
      setIsApproving(true);
      setErrorMsg(null);
      await api.approveCaption(reelId, {
        captionId: caption.id,
        title: editedTitle,
        hashtags: tags,
      });
      setApprovalSuccess(true);
      setTimeout(() => {
        onSuccess();
      }, 1200);
    } catch (err: any) {
      setErrorMsg(err.message || 'Failed to approve caption');
    } finally {
      setIsApproving(false);
    }
  };

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold">Dual-Video Upload & Caption Review</h2>
          <p className="text-xs text-slate-500 mt-1">
            Upload pairs of videos: censored for Instagram/Facebook Page, and raw for Telegram Channel.
          </p>
        </div>
        {publicId && (
          <span className="font-mono text-xs px-2.5 py-1 rounded bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400">
            Reel ID: {publicId}
          </span>
        )}
      </div>

      {errorMsg && (
        <div className="p-4 rounded-xl bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-800 text-red-700 dark:text-red-300 text-sm flex items-center gap-2">
          <AlertTriangle className="w-5 h-5 flex-shrink-0" />
          <span>{errorMsg}</span>
        </div>
      )}

      {approvalSuccess && (
        <div className="p-4 rounded-xl bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300 text-sm flex items-center gap-2">
          <CheckCircle2 className="w-5 h-5 flex-shrink-0" />
          <span>Reel approved and marked Ready to Schedule! Redirecting...</span>
        </div>
      )}

      {/* Dual Dropzone (FR-001 / PRD 14) */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Censored Video Slot */}
        <div className="p-5 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-bold uppercase tracking-wider text-pink-600 dark:text-pink-400">
                1. Censored Video (Instagram & FB)
              </span>
              {censoredProbe && (
                <span className="text-xs px-2 py-0.5 rounded font-medium bg-emerald-50 dark:bg-emerald-950 text-emerald-600">
                  Probe Valid
                </span>
              )}
            </div>

            <label className="border-2 border-dashed border-slate-200 dark:border-slate-700 hover:border-brand-500 rounded-xl p-6 flex flex-col items-center justify-center cursor-pointer transition text-center min-h-[160px]">
              <FileVideo className="w-10 h-10 text-slate-400 mb-2" />
              {censoredFile ? (
                <div>
                  <p className="font-semibold text-sm text-slate-900 dark:text-slate-100">{censoredFile.name}</p>
                  <p className="text-xs text-slate-400 mt-1">{formatBytes(censoredFile.size)}</p>
                </div>
              ) : (
                <div>
                  <p className="text-sm font-semibold text-slate-700 dark:text-slate-300">Click to select Censored video</p>
                  <p className="text-xs text-slate-400 mt-1">MP4 or MOV • Max 300 MB recommended for IG</p>
                </div>
              )}
              <input type="file" accept="video/mp4,video/quicktime" onChange={handleCensoredSelect} className="hidden" />
            </label>

            {isUploadingCensored && (
              <div className="mt-3 flex items-center gap-2 text-xs text-brand-600">
                <RotateCw className="w-3.5 h-3.5 animate-spin" /> Uploading & probing with ffprobe...
              </div>
            )}

            {/* Probe info */}
            {censoredProbe && (
              <div className="mt-3 p-3 rounded-lg bg-slate-50 dark:bg-slate-800/40 text-xs text-slate-600 dark:text-slate-400 space-y-1">
                <div className="flex justify-between">
                  <span>Resolution:</span>
                  <span className="font-mono">{censoredProbe.width}x{censoredProbe.height}</span>
                </div>
                <div className="flex justify-between">
                  <span>Duration:</span>
                  <span className="font-mono">{formatDurationMs(censoredProbe.duration_ms)}</span>
                </div>
                <div className="flex justify-between">
                  <span>Codecs:</span>
                  <span className="font-mono">{censoredProbe.video_codec} / {censoredProbe.audio_codec}</span>
                </div>
                {censoredProbe.size_bytes > 300 * 1024 * 1024 && (
                  <p className="text-amber-600 font-semibold mt-1">⚠️ Exceeds Instagram 300 MB limit</p>
                )}
                {censoredProbe.height < 540 && (
                  <p className="text-rose-600 font-semibold mt-1">⚠️ Below Facebook 540p min resolution</p>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Raw Video Slot */}
        <div className="p-5 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-bold uppercase tracking-wider text-sky-600 dark:text-sky-400">
                2. Raw Video (Telegram Channel)
              </span>
              {rawProbe && (
                <span className="text-xs px-2 py-0.5 rounded font-medium bg-emerald-50 dark:bg-emerald-950 text-emerald-600">
                  Probe Valid
                </span>
              )}
            </div>

            <label className="border-2 border-dashed border-slate-200 dark:border-slate-700 hover:border-brand-500 rounded-xl p-6 flex flex-col items-center justify-center cursor-pointer transition text-center min-h-[160px]">
              <UploadCloud className="w-10 h-10 text-slate-400 mb-2" />
              {rawFile ? (
                <div>
                  <p className="font-semibold text-sm text-slate-900 dark:text-slate-100">{rawFile.name}</p>
                  <p className="text-xs text-slate-400 mt-1">{formatBytes(rawFile.size)}</p>
                </div>
              ) : (
                <div>
                  <p className="text-sm font-semibold text-slate-700 dark:text-slate-300">Click to select Raw video</p>
                  <p className="text-xs text-slate-400 mt-1">Full resolution raw copy for Telegram</p>
                </div>
              )}
              <input type="file" accept="video/mp4,video/quicktime" onChange={handleRawSelect} className="hidden" />
            </label>

            {isUploadingRaw && (
              <div className="mt-3 flex items-center gap-2 text-xs text-brand-600">
                <RotateCw className="w-3.5 h-3.5 animate-spin" /> Uploading & probing with ffprobe...
              </div>
            )}

            {/* Probe info */}
            {rawProbe && (
              <div className="mt-3 p-3 rounded-lg bg-slate-50 dark:bg-slate-800/40 text-xs text-slate-600 dark:text-slate-400 space-y-1">
                <div className="flex justify-between">
                  <span>Resolution:</span>
                  <span className="font-mono">{rawProbe.width}x{rawProbe.height}</span>
                </div>
                <div className="flex justify-between">
                  <span>Duration:</span>
                  <span className="font-mono">{formatDurationMs(rawProbe.duration_ms)}</span>
                </div>
                {rawProbe.size_bytes > 50 * 1024 * 1024 && (
                  <p className="text-amber-600 font-semibold mt-1">⚠️ Exceeds Cloud Bot API 50 MB limit</p>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Video Streaming Preview (HTTP 206 Partial Content) */}
      {censoredFileId && (
        <div className="p-5 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-3">
          <h3 className="text-sm font-bold flex items-center gap-2">
            <Play className="w-4 h-4 text-brand-600" /> Authenticated In-Browser Video Preview
          </h3>
          <div className="max-w-md mx-auto aspect-[9/16] bg-black rounded-xl overflow-hidden shadow-inner">
            <video
              controls
              playsInline
              preload="metadata"
              className="w-full h-full object-contain"
              src={`/api/v1/media/${censoredFileId}/stream`}
            />
          </div>
        </div>
      )}

      {/* Gemini AI Caption Section (FR-004) */}
      <div className="p-5 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <h3 className="text-base font-bold flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-purple-600" /> AI Caption & Hashtags
            </h3>
            <p className="text-xs text-slate-400">
              Generated by Gemini using deterministic clean stem prompt. Exactly 2 hashtags required.
            </p>
          </div>
          <button
            onClick={handleGenerateAi}
            disabled={!reelId || isGeneratingAi}
            className="px-4 py-2 rounded-xl bg-purple-600 text-white font-semibold text-xs hover:bg-purple-700 disabled:opacity-50 flex items-center gap-1.5 shadow"
          >
            {isGeneratingAi ? (
              <>
                <RotateCw className="w-3.5 h-3.5 animate-spin" /> Generating...
              </>
            ) : (
              <>
                <Sparkles className="w-3.5 h-3.5" /> Generate Caption with Gemini
              </>
            )}
          </button>
        </div>

        {caption && (
          <div className="space-y-4 pt-3 border-t border-slate-100 dark:border-slate-800">
            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                Hook / Title (20–150 characters)
              </label>
              <input
                type="text"
                value={editedTitle}
                onChange={(e) => setEditedTitle(e.target.value)}
                className="w-full px-3.5 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm focus:ring-2 focus:ring-brand-500"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300 mb-1">
                Hashtags (Exactly 2 unique #tags)
              </label>
              <div className="relative">
                <Hash className="w-4 h-4 text-slate-400 absolute left-3 top-2.5" />
                <input
                  type="text"
                  value={editedTags}
                  onChange={(e) => setEditedTags(e.target.value)}
                  placeholder="#tag1 #tag2"
                  className="w-full pl-9 pr-3.5 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm font-mono focus:ring-2 focus:ring-brand-500"
                />
              </div>
            </div>

            <div className="flex justify-end pt-2">
              <button
                onClick={handleApprove}
                disabled={isApproving}
                className="px-5 py-2.5 rounded-xl bg-brand-600 text-white font-bold text-sm shadow hover:bg-brand-700 disabled:opacity-50 flex items-center gap-2"
              >
                <CheckCircle2 className="w-4 h-4" /> Approve & Mark Ready to Schedule
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

