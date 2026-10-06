import { createContext, type PropsWithChildren, useEffect, useRef, useState } from 'react';

import {
  BackendApiError, clearStoredUserToken, getCurrentUser, getStoredUserId,
  getStoredUserToken, login, register, type LoginCredentials, storeUserToken,
} from '@/services/backend-api';

export type AuthContextValue = {
  isAuthenticated: boolean;
  isHydrating: boolean;
  sessionError: string | null;
  refreshToken: () => Promise<void>;
  signIn: (credentials: LoginCredentials) => Promise<void>;
  signOut: (expectedToken?: string) => Promise<void>;
  signUp: (credentials: LoginCredentials) => Promise<void>;
  token: string | null;
  userId: string | null;
};

type Session = { token: string | null; userId: string | null };
type RestoredSession = Session & { error: string | null; rejected?: boolean };

export const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: PropsWithChildren) {
  const [session, setSession] = useState<Session>({ token: null, userId: null });
  const [isHydrating, setIsHydrating] = useState(true);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const sessionRef = useRef(session);
  const operationRef = useRef(0);
  const storageQueueRef = useRef<Promise<unknown>>(Promise.resolve());

  function commitSession(next: Session) {
    sessionRef.current = next;
    setSession(next);
  }

  // Pending login, restore and logout operations cannot overwrite a newer session.
  async function persistCurrent(operation: number, write: () => Promise<void>) {
    const next = storageQueueRef.current.catch(() => undefined).then(async () => {
      if (operation !== operationRef.current) return false;
      await write();
      return operation === operationRef.current;
    });
    storageQueueRef.current = next;
    return await next;
  }

  async function restore(operation: number) {
    const next = await restoreStoredSession();
    if (operation !== operationRef.current) return;
    if (next.rejected) {
      if (!await persistCurrent(operation, clearStoredUserToken)) return;
    } else if (next.token && next.userId) {
      if (!await persistCurrent(operation, () => storeUserToken(next.token!, next.userId!))) return;
    }
    if (operation !== operationRef.current) return;
    commitSession({ token: next.token, userId: next.userId });
    setSessionError(next.error);
  }

  useEffect(() => {
    let isMounted = true;
    const operation = ++operationRef.current;
    void restore(operation).catch(() => {
      if (isMounted && operation === operationRef.current) {
        setSessionError('无法读取已保存的登录状态，请重新登录。');
      }
    }).finally(() => {
      if (isMounted && operation === operationRef.current) setIsHydrating(false);
    });
    return () => { isMounted = false; operationRef.current += 1; };
    // Initial hydration runs once; later validation is explicit through refreshToken.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function authenticate(action: typeof login, credentials: LoginCredentials) {
    const operation = ++operationRef.current;
    const response = await action(credentials);
    if (!await persistCurrent(operation, () => storeUserToken(response.token, response.user.id))) return;
    commitSession({ token: response.token, userId: response.user.id });
    setSessionError(null);
    setIsHydrating(false);
  }

  async function signIn(credentials: LoginCredentials) { await authenticate(login, credentials); }
  async function signUp(credentials: LoginCredentials) { await authenticate(register, credentials); }

  async function signOut(expectedToken?: string) {
    if (expectedToken && sessionRef.current.token !== expectedToken) return;
    const operation = ++operationRef.current;
    // Clear the visible session immediately even if local storage is unavailable.
    commitSession({ token: null, userId: null });
    setSessionError(null);
    setIsHydrating(false);
    await persistCurrent(operation, clearStoredUserToken);
  }

  async function refreshToken() {
    const operation = ++operationRef.current;
    await restore(operation);
  }

  return (
    <AuthContext.Provider value={{
      isAuthenticated: Boolean(session.token), isHydrating, sessionError,
      refreshToken, signIn, signOut, signUp, token: session.token, userId: session.userId,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

async function restoreStoredSession(): Promise<RestoredSession> {
  const token = await getStoredUserToken();
  if (!token) return { token: null, userId: null, error: null };
  const userId = await getStoredUserId(token);
  try {
    const response = await getCurrentUser(token);
    return { token, userId: response.user.id, error: null };
  } catch (error) {
    if (error instanceof BackendApiError && error.status === 401) {
      return { token: null, userId: null, error: '登录状态已失效，请重新登录。', rejected: true };
    }
    return { token, userId, error: '暂时无法验证登录状态，已保留登录信息，请稍后重试。' };
  }
}
