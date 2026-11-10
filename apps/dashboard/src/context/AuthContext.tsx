import React, { createContext, useContext, useEffect, useState } from 'react';
import { api } from '../api/client';

interface AdminUser {
  id: number;
  username: string;
}

interface AuthContextValue {
  user: AdminUser | null;
  loading: boolean;
  needsBootstrap: boolean;
  login: (username: string, password?: string, token?: string) => Promise<void>;
  logout: () => Promise<void>;
  bootstrap: (token: string, username: string, password: string) => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  loading: true,
  needsBootstrap: false,
  login: async () => {},
  logout: async () => {},
  bootstrap: async () => {},
  refresh: async () => {},
});

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<AdminUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [needsBootstrap, setNeedsBootstrap] = useState(false);

  const checkAuth = async () => {
    try {
      setLoading(true);
      const res = await api.getMe();
      if (res.ok && res.admin) {
        setUser(res.admin);
        setNeedsBootstrap(false);
      } else {
        setUser(null);
      }
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    checkAuth();
  }, []);

  const login = async (username: string, password?: string, token?: string) => {
    await api.login({ username, password, token });
    await checkAuth();
  };

  const logout = async () => {
    await api.logout();
    setUser(null);
  };

  const bootstrap = async (token: string, username: string, password: string) => {
    await api.bootstrap({ token, username, password });
    await checkAuth();
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        needsBootstrap,
        login,
        logout,
        bootstrap,
        refresh: checkAuth,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);

