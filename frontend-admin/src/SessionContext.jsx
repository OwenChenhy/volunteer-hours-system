import { createContext, useContext } from 'react';
export const SessionContext = createContext({ user: null, can: () => false });
export function useSession() { return useContext(SessionContext); }
