import { useContext } from 'react';

import { AuthContext } from '@/providers/auth-provider';

export function useAuth() {
  const context = useContext(AuthContext);

  if (!context) {
    throw new Error('useAuth 必须包在 AuthProvider 内部使用。');
  }

  return context;
}
