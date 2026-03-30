import { createContext, type PropsWithChildren, useEffect, useState } from 'react';

import {
  clearStoredUserToken,
  getStoredUserToken,
  login,
  type LoginCredentials,
  storeUserToken,
} from '@/services/backend-api';

export type AuthContextValue = {
  isAuthenticated: boolean;
  isHydrating: boolean;
  refreshToken: () => Promise<void>;
  signIn: (credentials: LoginCredentials) => Promise<void>;
  signOut: () => Promise<void>;
  token: string | null;
};

export const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: PropsWithChildren) {
  const [token, setToken] = useState<string | null>(null);
  const [isHydrating, setIsHydrating] = useState(true);

  useEffect(() => {
    let isMounted = true;

    void (async () => {
      try {
        const storedToken = await getStoredUserToken();

        if (isMounted) {
          setToken(storedToken);
        }
      } finally {
        if (isMounted) {
          setIsHydrating(false);
        }
      }
    })();

    return () => {
      isMounted = false;
    };
  }, []);

  async function signIn(credentials: LoginCredentials) {
    const response = await login(credentials);

    await storeUserToken(response.token);
    setToken(response.token);
  }

  async function signOut() {
    await clearStoredUserToken();
    setToken(null);
  }

  async function refreshToken() {
    const storedToken = await getStoredUserToken();
    setToken(storedToken);
  }

  return (
    <AuthContext.Provider
      value={{
        isAuthenticated: Boolean(token),
        isHydrating,
        refreshToken,
        signIn,
        signOut,
        token,
      }}>
      {children}
    </AuthContext.Provider>
  );
}
