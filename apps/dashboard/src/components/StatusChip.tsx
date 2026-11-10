import React from 'react';
import { cn } from '../lib/utils';
import {
  CheckCircle2,
  AlertCircle,
  Clock,
  PauseCircle,
  XCircle,
  HelpCircle,
  RefreshCw,
  Sparkles,
} from 'lucide-react';

interface StatusChipProps {
  status: string;
  size?: 'sm' | 'md';
  className?: string;
}

export const StatusChip: React.FC<StatusChipProps> = ({ status, size = 'sm', className }) => {
  const norm = status?.toLowerCase() || 'unknown';

  let config = {
    label: status.replace(/_/g, ' '),
    bg: 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-300 dark:border-slate-700',
    icon: <HelpCircle className="w-3.5 h-3.5" />,
  };

  switch (norm) {
    // Succeeded / Published / Active / Ready
    case 'completed':
    case 'published':
    case 'active':
    case 'success':
      config = {
        label: norm === 'published' ? 'Published' : norm === 'completed' ? 'Completed' : 'Active',
        bg: 'bg-emerald-50 dark:bg-emerald-950/40 text-emerald-700 dark:text-emerald-300 border-emerald-300 dark:border-emerald-800',
        icon: <CheckCircle2 className="w-3.5 h-3.5" />,
      };
      break;

    case 'ready':
      config = {
        label: 'Ready to Schedule',
        bg: 'bg-cyan-50 dark:bg-cyan-950/40 text-cyan-700 dark:text-cyan-300 border-cyan-300 dark:border-cyan-800',
        icon: <CheckCircle2 className="w-3.5 h-3.5" />,
      };
      break;

    // In flight / Scheduled
    case 'scheduled':
    case 'queued':
      config = {
        label: norm === 'scheduled' ? 'Scheduled' : 'Queued',
        bg: 'bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 border-blue-300 dark:border-blue-800',
        icon: <Clock className="w-3.5 h-3.5" />,
      };
      break;

    case 'publishing':
    case 'in_progress':
    case 'uploading':
    case 'processing_remote':
    case 'verifying':
      config = {
        label: norm.replace(/_/g, ' '),
        bg: 'bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-300 border-indigo-300 dark:border-indigo-800 animate-pulse',
        icon: <RefreshCw className="w-3.5 h-3.5 animate-spin" />,
      };
      break;

    case 'waiting_for_ai':
      config = {
        label: 'Generating Caption',
        bg: 'bg-purple-50 dark:bg-purple-950/40 text-purple-700 dark:text-purple-300 border-purple-300 dark:border-purple-800',
        icon: <Sparkles className="w-3.5 h-3.5 animate-bounce" />,
      };
      break;

    // Partially published / Partial
    case 'partially_published':
      config = {
        label: 'Partially Published',
        bg: 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-300 dark:border-amber-800',
        icon: <AlertCircle className="w-3.5 h-3.5" />,
      };
      break;

    // Uncertain outcome (PRD 10.5 / 12.4)
    case 'uncertain':
      config = {
        label: 'Delivery Uncertain',
        bg: 'bg-orange-50 dark:bg-orange-950/40 text-orange-700 dark:text-orange-300 border-orange-400 dark:border-orange-700',
        icon: <AlertCircle className="w-3.5 h-3.5" />,
      };
      break;

    // Action needed / Auth needed
    case 'needs_auth':
      config = {
        label: 'Needs Re-auth',
        bg: 'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border-rose-300 dark:border-rose-800',
        icon: <AlertCircle className="w-3.5 h-3.5" />,
      };
      break;

    case 'needs_action':
      config = {
        label: 'Action Required',
        bg: 'bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-300 border-rose-300 dark:border-rose-800',
        icon: <AlertCircle className="w-3.5 h-3.5" />,
      };
      break;

    // Failed
    case 'failed':
    case 'failed_retryable':
    case 'critical':
      config = {
        label: norm === 'failed_retryable' ? 'Retryable Failure' : 'Failed',
        bg: 'bg-red-50 dark:bg-red-950/40 text-red-700 dark:text-red-300 border-red-300 dark:border-red-800',
        icon: <XCircle className="w-3.5 h-3.5" />,
      };
      break;

    // Paused / Cancelled / Draft
    case 'paused':
      config = {
        label: 'Paused',
        bg: 'bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border-amber-300 dark:border-amber-800',
        icon: <PauseCircle className="w-3.5 h-3.5" />,
      };
      break;

    case 'cancelled':
      config = {
        label: 'Cancelled',
        bg: 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-slate-300 dark:border-slate-700',
        icon: <XCircle className="w-3.5 h-3.5" />,
      };
      break;

    case 'draft':
      config = {
        label: 'Draft',
        bg: 'bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-300 dark:border-slate-700',
        icon: <Clock className="w-3.5 h-3.5" />,
      };
      break;
  }

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 font-medium border rounded-full capitalize',
        size === 'sm' ? 'px-2.5 py-0.5 text-xs' : 'px-3 py-1 text-sm',
        config.bg,
        className,
      )}
    >
      {config.icon}
      <span>{config.label}</span>
    </span>
  );
};

