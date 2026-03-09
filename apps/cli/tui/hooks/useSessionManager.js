import { useState, useCallback, useEffect, useRef } from "react";

/**
 * Session manager hook — gateway-synced sessions.
 *
 * All operations go through the gateway WS connection, so sessions
 * are accessible from CLI, Telegram, and web.
 *
 * @param {Object} gateway — GatewayClient instance
 * @param {string} currentSessionKey — current in-memory session key
 */
export function useSessionManager(gateway) {
  const [sessions, setSessions] = useState([]);
  const [currentSession, setCurrentSession] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const refreshSessions = useCallback(async () => {
    if (!gateway?.connected) return;
    setLoading(true);
    try {
      const list = await gateway.sessionList({ limit: 50 });
      setSessions(list);
      setError(null);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [gateway]);

  // Load sessions on mount
  useEffect(() => {
    if (gateway?.connected) {
      refreshSessions();
    }
  }, [gateway?.connected]);

  const createSession = useCallback(async (title) => {
    if (!gateway?.connected) return null;
    try {
      const session = await gateway.sessionCreate({ title, workingDir: process.cwd() });
      setCurrentSession(session);
      await refreshSessions();
      return session;
    } catch (err) {
      setError(err.message);
      return null;
    }
  }, [gateway, refreshSessions]);

  const switchSession = useCallback(async (sessionId) => {
    if (!gateway?.connected) return null;
    try {
      const session = await gateway.sessionGet(sessionId);
      setCurrentSession(session);
      return session;
    } catch (err) {
      setError(err.message);
      return null;
    }
  }, [gateway]);

  const renameSession = useCallback(async (sessionId, title) => {
    if (!gateway?.connected) return;
    try {
      await gateway.sessionRename(sessionId, title);
      await refreshSessions();
    } catch (err) {
      setError(err.message);
    }
  }, [gateway, refreshSessions]);

  const archiveSession = useCallback(async (sessionId) => {
    if (!gateway?.connected) return;
    try {
      await gateway.sessionArchive(sessionId);
      await refreshSessions();
    } catch (err) {
      setError(err.message);
    }
  }, [gateway, refreshSessions]);

  const forkSession = useCallback(async (sessionId, title) => {
    if (!gateway?.connected) return null;
    try {
      const forked = await gateway.sessionFork(sessionId, { title });
      setCurrentSession(forked);
      await refreshSessions();
      return forked;
    } catch (err) {
      setError(err.message);
      return null;
    }
  }, [gateway, refreshSessions]);

  const saveMessage = useCallback(async (sessionId, { role, text, metadata } = {}) => {
    if (!gateway?.connected || !sessionId) return;
    try {
      await gateway.sessionAddMessage(sessionId, { role, text, metadata });
    } catch {
      // Non-critical — don't surface to user
    }
  }, [gateway]);

  const getMessages = useCallback(async (sessionId, opts = {}) => {
    if (!gateway?.connected) return [];
    try {
      return await gateway.sessionMessages(sessionId, opts);
    } catch (err) {
      setError(err.message);
      return [];
    }
  }, [gateway]);

  return {
    sessions,
    currentSession,
    loading,
    error,
    createSession,
    switchSession,
    renameSession,
    archiveSession,
    forkSession,
    saveMessage,
    getMessages,
    refreshSessions,
  };
}
