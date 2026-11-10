import React, { useEffect, useState } from 'react';
import { api } from '../api/client';
import {
  Calendar,
  Plus,
  Trash2,
  Clock,
  Sparkles,
  CheckCircle2,
  AlertCircle,
  Pause,
  Play,
} from 'lucide-react';

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export const SchedulePage: React.FC = () => {
  const [slots, setSlots] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);

  // Form states
  const [label, setLabel] = useState('Evening Prime');
  const [localTime, setLocalTime] = useState('18:00');
  const [capacity, setCapacity] = useState(1);
  const [selectedDays, setSelectedDays] = useState<number[]>([0, 1, 2, 3, 4, 5, 6]); // all days
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [autoAssignMsg, setAutoAssignMsg] = useState<string | null>(null);

  const loadSlots = async () => {
    try {
      setLoading(true);
      const res = await api.getSlots();
      setSlots(res.slots || []);
    } catch (e) {
      console.error('Failed to load slots', e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadSlots();
  }, []);

  const toggleDay = (dayIndex: number) => {
    if (selectedDays.includes(dayIndex)) {
      setSelectedDays(selectedDays.filter((d) => d !== dayIndex));
    } else {
      setSelectedDays([...selectedDays, dayIndex]);
    }
  };

  // Convert array of day indices to weekday bitmask
  const calculateBitmask = () => {
    return selectedDays.reduce((acc, d) => acc | (1 << d), 0);
  };

  const handleCreateSlot = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      setIsSubmitting(true);
      const weekdayMask = calculateBitmask();
      await api.createSlot({
        label,
        localTime,
        weekdayMask,
        capacity,
        timezone: 'Asia/Kolkata',
      });
      setShowAddModal(false);
      await loadSlots();
    } catch (err: any) {
      alert(`Failed to create slot: ${err.message}`);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeleteSlot = async (id: number) => {
    if (!confirm('Are you sure you want to delete this schedule slot?')) return;
    try {
      await api.deleteSlot(id);
      await loadSlots();
    } catch (err: any) {
      alert(`Failed to delete slot: ${err.message}`);
    }
  };

  const handleAutoAssign = async () => {
    try {
      setAutoAssignMsg('Assigning ready reels into upcoming slots...');
      await fetch('/api/v1/scheduler/auto-assign', { method: 'POST', credentials: 'include' });
      setAutoAssignMsg('Ready reels assigned successfully into upcoming slots!');
      setTimeout(() => setAutoAssignMsg(null), 3000);
    } catch (e: any) {
      setAutoAssignMsg(`Auto-assign error: ${e.message}`);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-xl font-bold">Schedule Slots & Auto-Assign Engine</h2>
          <p className="text-xs text-slate-500 mt-1">
            Slots are evaluated every 15 seconds against Asia/Kolkata timezone with conflict detection.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={handleAutoAssign}
            className="px-3.5 py-2 rounded-xl bg-purple-50 dark:bg-purple-950/40 border border-purple-200 dark:border-purple-800 text-purple-700 dark:text-purple-300 font-semibold text-xs hover:bg-purple-100 flex items-center gap-1.5 shadow-sm"
          >
            <Sparkles className="w-3.5 h-3.5" /> Auto-Assign Ready Reels
          </button>
          <button
            onClick={() => setShowAddModal(true)}
            className="px-3.5 py-2 rounded-xl bg-brand-600 hover:bg-brand-700 text-white font-semibold text-xs shadow-sm flex items-center gap-1.5"
          >
            <Plus className="w-3.5 h-3.5" /> Add New Slot
          </button>
        </div>
      </div>

      {autoAssignMsg && (
        <div className="p-3.5 rounded-xl bg-purple-50 dark:bg-purple-950/40 border border-purple-200 text-xs text-purple-700 flex items-center gap-2">
          <Sparkles className="w-4 h-4" />
          <span>{autoAssignMsg}</span>
        </div>
      )}

      {/* Slots List */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {slots.length === 0 ? (
          <div className="col-span-3 p-12 text-center rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-slate-400">
            No schedule slots configured. Add a slot to enable automated publishing.
          </div>
        ) : (
          slots.map((slot) => {
            const mask = slot.weekday_mask ?? 127;
            return (
              <div
                key={slot.id}
                className="p-5 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm flex flex-col justify-between"
              >
                <div>
                  <div className="flex items-start justify-between">
                    <div>
                      <h4 className="font-bold text-sm text-slate-900 dark:text-slate-100">{slot.label}</h4>
                      <div className="flex items-center gap-1 text-brand-600 dark:text-brand-400 font-mono text-lg font-extrabold mt-1">
                        <Clock className="w-4 h-4" /> {slot.local_time} <span className="text-xs font-normal text-slate-400">IST</span>
                      </div>
                    </div>
                    <button
                      onClick={() => handleDeleteSlot(slot.id)}
                      className="p-1.5 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950"
                      title="Delete slot"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>

                  {/* Days pills */}
                  <div className="mt-4 flex flex-wrap gap-1">
                    {WEEKDAYS.map((day, idx) => {
                      const isEnabled = (mask & (1 << idx)) !== 0;
                      return (
                        <span
                          key={day}
                          className={`text-[10px] font-semibold px-2 py-0.5 rounded ${
                            isEnabled
                              ? 'bg-brand-50 dark:bg-brand-950/60 text-brand-600 dark:text-brand-400 border border-brand-200 dark:border-brand-800'
                              : 'bg-slate-100 dark:bg-slate-800 text-slate-400 line-through'
                          }`}
                        >
                          {day}
                        </span>
                      );
                    })}
                  </div>
                </div>

                <div className="mt-4 pt-3 border-t border-slate-100 dark:border-slate-800 flex justify-between text-xs text-slate-500">
                  <span>Capacity: {slot.capacity} reel / slot</span>
                  <span>Gap: 600s</span>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Add Slot Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm">
          <div className="w-full max-w-md bg-white dark:bg-slate-900 rounded-2xl border border-slate-200 dark:border-slate-800 shadow-2xl p-6">
            <h3 className="text-lg font-bold">Add Schedule Slot</h3>
            <p className="text-xs text-slate-400 mt-1 mb-4">
              Configured times are in Asia/Kolkata timezone.
            </p>

            <form onSubmit={handleCreateSlot} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold mb-1">Slot Name</label>
                <input
                  type="text"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  required
                  className="w-full px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm focus:ring-2 focus:ring-brand-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold mb-1">Time (HH:MM)</label>
                <input
                  type="time"
                  value={localTime}
                  onChange={(e) => setLocalTime(e.target.value)}
                  required
                  className="w-full px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm focus:ring-2 focus:ring-brand-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold mb-1">Capacity</label>
                <input
                  type="number"
                  min="1"
                  max="5"
                  value={capacity}
                  onChange={(e) => setCapacity(parseInt(e.target.value, 10))}
                  required
                  className="w-full px-3 py-2 rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-sm focus:ring-2 focus:ring-brand-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold mb-2">Active Days</label>
                <div className="flex flex-wrap gap-1.5">
                  {WEEKDAYS.map((day, idx) => (
                    <button
                      type="button"
                      key={day}
                      onClick={() => toggleDay(idx)}
                      className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition ${
                        selectedDays.includes(idx)
                          ? 'bg-brand-500 text-white border-brand-500'
                          : 'bg-slate-100 dark:bg-slate-800 text-slate-500 border-slate-200 dark:border-slate-700'
                      }`}
                    >
                      {day}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-4 border-t border-slate-100 dark:border-slate-800">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="px-4 py-2 rounded-xl border border-slate-200 dark:border-slate-700 text-xs font-semibold hover:bg-slate-100 dark:hover:bg-slate-800"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-4 py-2 rounded-xl bg-brand-600 text-white text-xs font-semibold hover:bg-brand-700 shadow"
                >
                  Create Slot
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

