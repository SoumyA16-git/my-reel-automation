import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';

export type ConnectionStatus = 'connected' | 'connecting' | 'disconnected';

interface EventsContextValue {
  status: ConnectionStatus;
  lastEvent: any | null;
  subscribe: (eventType: string, callback: (data: any) => void) => () => void;
}

const EventsContext = createContext<EventsContextValue>({
  status: 'disconnected',
  lastEvent: null,
  subscribe: () => () => {},
});

export const EventsProvider: React.FC<{ children: React.ReactNode; enabled?: boolean }> = ({
  children,
  enabled = true,
}) => {
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [lastEvent, setLastEvent] = useState<any | null>(null);
  const listenersRef = useRef<Map<string, Set<(data: any) => void>>>(new Map());
  const eventSourceRef = useRef<EventSource | null>(null);

  const subscribe = useCallback((eventType: string, callback: (data: any) => void) => {
    let set = listenersRef.current.get(eventType);
    if (!set) {
      set = new Set();
      listenersRef.current.set(eventType, set);
    }
    set.add(callback);

    return () => {
      set?.delete(callback);
    };
  }, []);

  const dispatchEvent = useCallback((type: string, data: any) => {
    setLastEvent({ type, data, ts: Date.now() });
    const listeners = listenersRef.current.get(type);
    if (listeners) {
      listeners.forEach((cb) => {
        try {
          cb(data);
        } catch (e) {
          console.error('Error in SSE subscriber callback:', e);
        }
      });
    }
  }, []);

  useEffect(() => {
    if (!enabled) {
      setStatus('disconnected');
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
      return;
    }

    setStatus('connecting');
    const es = new EventSource('/api/v1/events', { withCredentials: true });
    eventSourceRef.current = es;

    es.onopen = () => {
      setStatus('connected');
    };

    es.onerror = () => {
      setStatus('connecting');
    };

    // Registered event listeners
    const eventTypes = [
      'connected',
      'ping',
      'reel.status_changed',
      'job.state_changed',
      'notification.created',
      'destination.status_changed',
      'file.deleted',
    ];

    eventTypes.forEach((eventType) => {
      es.addEventListener(eventType, (e: MessageEvent) => {
        try {
          const parsed = JSON.parse(e.data);
          dispatchEvent(eventType, parsed);
        } catch {
          // ignore
        }
      });
    });

    return () => {
      es.close();
      eventSourceRef.current = null;
    };
  }, [enabled, dispatchEvent]);

  return (
    <EventsContext.Provider value={{ status, lastEvent, subscribe }}>
      {children}
    </EventsContext.Provider>
  );
};

export const useEvents = () => useContext(EventsContext);
