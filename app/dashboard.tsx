"use client";

import {
  ArrowUpRight, BriefcaseBusiness, CalendarDays, Check, ChevronLeft,
  ChevronRight, CircleAlert, CircleCheck, Clock3, Filter,
  LayoutDashboard, Link2, LoaderCircle, Menu, Paperclip, Play, Plus, RefreshCw,
  Search, SlidersHorizontal, Unplug, X, Zap,
} from "lucide-react";
import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { io, type Socket } from "socket.io-client";

type RunStatus = "running" | "complete" | "partial" | "failed";
type SearchRun = {
  id: string; status: RunStatus; startedAt?: string; finishedAt?: string | null;
  plannedRequests: number; completedRequests?: number; jobsCount: number;
  errors?: Array<string | { message?: string; retryAfterSeconds?: number }>; stored?: boolean;
  keywords?: string[];
  lastCompletedSearch?: { keyword: string; country: string } | null;
};
type Lead = {
  _id: string; externalId: string; title: string; url: string; source: string;
  country: string; budget: string; jobType: string; duration: string;
  postedAt: string; searchedKeywords: string[]; skills: string[]; summary: string;
  hasAttachments?: boolean;
};
type LeadsResponse = { data: Lead[]; page: number; limit: number; totalPages: number; totalResults: number };
type ApiError = Error & { status?: number; retryAfterSeconds?: number; runId?: string };
type SearchProgress = SearchRun & { completedRequests?: number };

const TERMINAL_STATUSES: RunStatus[] = ["complete", "partial", "failed"];

function formatDate(value?: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
}
function formatBudget(value: string) {
  if (!value) return "Not specified";
  try {
    const parsed = JSON.parse(value) as { amount?: number; min?: number; max?: number; currency?: string };
    const currency = parsed.currency || "USD";
    if (parsed.amount) return new Intl.NumberFormat("en", { style: "currency", currency, maximumFractionDigits: 0 }).format(parsed.amount);
    if (parsed.min || parsed.max) return `${parsed.min || 0}–${parsed.max || "?"} ${currency}`;
  } catch { return value; }
  return "Not specified";
}
function isLeadNew(postedAt: string, currentTime: number) {
  if (!currentTime) return false;
  const postedTime = new Date(postedAt).getTime();
  const age = currentTime - postedTime;
  return Number.isFinite(postedTime) && age >= 0 && age < 10 * 60 * 1000;
}
function Spinner({ size = 16 }: { size?: number }) { return <LoaderCircle size={size} className="animate-spin" aria-hidden="true" />; }
function formatCountdown(seconds: number) { return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`; }

export default function Dashboard() {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [backendStatus, setBackendStatus] = useState<"checking" | "online" | "offline">("checking");
  const [upworkConnected, setUpworkConnected] = useState(false);
  const [authLoading, setAuthLoading] = useState(false);
  const [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null);
  const [activeRun, setActiveRun] = useState<SearchRun | null>(null);
  const activeRunRef = useRef<SearchRun | null>(null);
  const pendingProgressRef = useRef(new Map<string, SearchProgress>());
  const searchSocketRef = useRef<Socket | null>(null);
  const autoConnectAttemptedRef = useRef(false);
  const runInFlightRef = useRef(false);
  const autoTickInFlightRef = useRef(false);
  const autoStartRef = useRef<() => Promise<void>>(async () => {});
  const autoCanStartRef = useRef(false);
  const [leads, setLeads] = useState<Lead[]>([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 10, totalPages: 0, totalResults: 0 });
  const [selectedDate, setSelectedDate] = useState("");
  const [currentTime, setCurrentTime] = useState(0);
  const [keyword, setKeyword] = useState("");
  const [searchKeyword, setSearchKeyword] = useState("");
  const [sortBy, setSortBy] = useState("postedAt:desc");
  const [runLimit, setRunLimit] = useState(10);
  const [runCountry, setRunCountry] = useState("United States");
  const [autoScheduleEnabled, setAutoScheduleEnabled] = useState(false);
  const [autoScheduleMinutes, setAutoScheduleMinutes] = useState<10 | 15>(10);
  const [autoNextRunAt, setAutoNextRunAt] = useState<number | null>(null);
  const [autoSettingsLoaded, setAutoSettingsLoaded] = useState(false);
  const [keywordMode, setKeywordMode] = useState<"manual" | "default">("manual");
  const [keywordInput, setKeywordInput] = useState("");
  const [searchKeywords, setSearchKeywords] = useState<string[]>([]);
  const [searchFormError, setSearchFormError] = useState<string | null>(null);
  const [leadsLoading, setLeadsLoading] = useState(false);
  const [runLoading, setRunLoading] = useState(false);
  const [quotaRetryAt, setQuotaRetryAt] = useState<number | null>(null);
  const [notice, setNotice] = useState<{ tone: "error" | "success"; message: string } | null>(null);
  const finishedRunIdsRef = useRef(new Set<string>());
  const showNotice = useCallback((message: string, tone: "error" | "success" = "error") => {
    setNotice({ message, tone });
    window.setTimeout(() => setNotice(null), 5000);
  }, []);

  const apiRequest = useCallback(async <T,>(path: string, options: RequestInit = {}): Promise<T> => {
    const response = await fetch(`/api/backend${path}`, {
      ...options,
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...options.headers,
      },
    });
    const contentType = response.headers.get("content-type") || "";
    const body = contentType.includes("application/json") ? await response.json() : await response.text();
    if (!response.ok) {
      const error = new Error((body as { error?: string })?.error || body || "Request failed") as ApiError;
      error.status = response.status;
      const errorBody = body as { retryAfterSeconds?: number; runId?: string; activeRunId?: string; currentRunId?: string; id?: string; activeRun?: { id?: string }; run?: { id?: string } };
      error.retryAfterSeconds = errorBody?.retryAfterSeconds ?? (Number(response.headers.get("retry-after")) || undefined);
      error.runId = errorBody?.runId || errorBody?.activeRunId || errorBody?.currentRunId || errorBody?.activeRun?.id || errorBody?.run?.id || errorBody?.id;
      throw error;
    }
    return body as T;
  }, []);

  const loadLeads = useCallback(async (page = 1) => {
    setLeadsLoading(true);
    const query = new URLSearchParams({ page: String(page), limit: String(pagination.limit), sortBy });
    if (selectedDate) query.set("date", selectedDate);
    if (searchKeyword) query.set("searchedKeyword", searchKeyword);
    try {
      const result = await apiRequest<LeadsResponse>(`/v1/leads?${query.toString()}`);
      setLeads(result.data);
      setPagination({ page: result.page, limit: result.limit, totalPages: result.totalPages, totalResults: result.totalResults });
    } catch (error) { showNotice((error as Error).message); }
    finally { setLeadsLoading(false); }
  }, [apiRequest, pagination.limit, searchKeyword, selectedDate, showNotice, sortBy]);

  const showQuotaWait = useCallback((seconds: number) => {
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    const minutes = Math.ceil(seconds / 60);
    const message = `Search quota exhausted. Try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`;
    setQuotaRetryAt(Date.now() + seconds * 1000);
    setCurrentTime(Date.now());
    setSearchFormError(message);
    showNotice(message);
  }, [showNotice]);

  const finishSearchRun = useCallback((run: SearchRun) => {
    if (!TERMINAL_STATUSES.includes(run.status) || finishedRunIdsRef.current.has(run.id)) return;
    finishedRunIdsRef.current.add(run.id);
    const quotaError = run.errors?.find((error) => typeof error !== "string" && Number.isFinite(error.retryAfterSeconds));
    if (quotaError && typeof quotaError !== "string" && quotaError.retryAfterSeconds) {
      showQuotaWait(quotaError.retryAfterSeconds);
    }
    void loadLeads(1);
  }, [loadLeads, showQuotaWait]);

  const hydrateRun = useCallback(async (runId: string) => {
    try {
      const run = await apiRequest<SearchRun>(`/v1/search-runs/${runId}`);
      activeRunRef.current = run;
      setActiveRun(run);
      if (TERMINAL_STATUSES.includes(run.status)) {
        searchSocketRef.current?.disconnect();
        searchSocketRef.current = null;
        finishSearchRun(run);
      }
    } catch (error) {
      if ((error as ApiError).status === 404) { activeRunRef.current = null; setActiveRun(null); }
    }
  }, [apiRequest, finishSearchRun]);

  const updateSearchProgress = useCallback((progress: SearchProgress) => {
    activeRunRef.current = progress;
    setActiveRun(progress);
    if (TERMINAL_STATUSES.includes(progress.status)) {
      searchSocketRef.current?.disconnect();
      searchSocketRef.current = null;
      finishSearchRun(progress);
    }
  }, [finishSearchRun]);

  const createSearchSocket = useCallback(() => {
    if (searchSocketRef.current?.connected) return searchSocketRef.current;
    const apiKey = process.env.NEXT_PUBLIC_DASHBOARD_API_KEY;
    if (!apiKey) throw new Error("NEXT_PUBLIC_DASHBOARD_API_KEY is required for Vercel search sockets.");

    const configuredBase = process.env.NEXT_PUBLIC_BACKEND_SOCKET_URL;
    const baseUrl = configuredBase
      ? new URL(configuredBase)
      : new URL(`${window.location.protocol}//${window.location.hostname}:5050`);
    const basePath = baseUrl.pathname.replace(/\/+$/, "");
    const socket = io(baseUrl.origin, {
      path: `${basePath}/socket.io`,
      transports: ["websocket"],
      auth: { apiKey },
      autoConnect: false,
    });
    socket.on("search-run:progress", (progress: SearchProgress) => {
      if (progress.id === activeRunRef.current?.id) updateSearchProgress(progress);
      else if (!activeRunRef.current) pendingProgressRef.current.set(progress.id, progress);
    });
    let connectionCount = 0;
    socket.on("connect", () => {
      connectionCount += 1;
      const currentRun = activeRunRef.current;
      if (connectionCount > 1 && currentRun?.status === "running") {
        socket.emit("search-run:subscribe", { runId: currentRun.id });
      }
    });
    searchSocketRef.current = socket;
    return socket;
  }, [updateSearchProgress]);

  const connectSearchSocket = useCallback(async (socket: Socket) => {
    if (socket.connected) return;
    await new Promise<void>((resolve, reject) => {
      const onConnect = () => { socket.off("connect_error", onError); resolve(); };
      const onError = (error: Error) => { socket.off("connect", onConnect); reject(error); };
      socket.once("connect", onConnect);
      socket.once("connect_error", onError);
      socket.connect();
    });
  }, []);

  const beginAutomaticUpworkConnection = useCallback(async () => {
    if (autoConnectAttemptedRef.current) return;
    autoConnectAttemptedRef.current = true;
    setAuthLoading(true);
    try {
      const result = await apiRequest<{ connected: boolean; authorizationUrl?: string }>("/v1/auth/upwork/start", { method: "POST", body: "{}" });
      if (result.connected) {
        setUpworkConnected(true);
        setAuthLoading(false);
        return;
      }
      if (!result.authorizationUrl) throw new Error("The authorization URL was not returned.");
      setAuthorizationUrl(result.authorizationUrl);
      const popup = window.open(result.authorizationUrl, "upwork-oauth", "width=720,height=760");
      if (!popup) showNotice("Upwork authorization is ready. Use the authorization link shown on the dashboard.");
    } catch (error) {
      setAuthLoading(false);
      showNotice((error as Error).message);
    }
  }, [apiRequest, showNotice]);

  const checkServices = useCallback(async () => {
    setBackendStatus("checking");
    try { await apiRequest<{ ok: boolean }>("/health"); setBackendStatus("online"); }
    catch { setBackendStatus("offline"); return; }
    try {
      const status = await apiRequest<{ connected: boolean }>("/v1/auth/upwork/status");
      setUpworkConnected(status.connected);
      if (!status.connected) await beginAutomaticUpworkConnection();
    } catch (error) {
      setUpworkConnected(false);
      showNotice((error as Error).message);
    }
  }, [apiRequest, beginAutomaticUpworkConnection, showNotice]);
  useEffect(() => {
    const initialTimer = window.setTimeout(() => setCurrentTime(Date.now()), 0);
    const interval = window.setInterval(() => setCurrentTime(Date.now()), 10_000);
    return () => { window.clearTimeout(initialTimer); window.clearInterval(interval); };
  }, []);
  useEffect(() => {
    try {
      const saved = localStorage.getItem("upwork-auto-search-settings");
      if (saved) {
        const settings = JSON.parse(saved) as { enabled?: unknown; intervalMinutes?: unknown; nextRunAt?: unknown };
        const intervalMinutes: 10 | 15 = settings.intervalMinutes === 15 ? 15 : 10;
        if (typeof settings.enabled === "boolean") setAutoScheduleEnabled(settings.enabled);
        setAutoScheduleMinutes(intervalMinutes);
        if (settings.enabled === true) {
          const savedDeadline = (settings.intervalMinutes === 10 || settings.intervalMinutes === 15)
            && typeof settings.nextRunAt === "number"
            && Number.isFinite(settings.nextRunAt)
            ? settings.nextRunAt
            : Date.now() + intervalMinutes * 60_000;
          setAutoNextRunAt(savedDeadline);
        }
      }
    } catch { /* Ignore invalid or unavailable browser storage. */ }
    setAutoSettingsLoaded(true);
  }, []);
  useEffect(() => {
    if (!autoSettingsLoaded) return;
    try {
      localStorage.setItem("upwork-auto-search-settings", JSON.stringify({
        enabled: autoScheduleEnabled,
        intervalMinutes: autoScheduleMinutes,
        nextRunAt: autoScheduleEnabled ? autoNextRunAt : null,
      }));
    } catch { /* Scheduling still works for this page session if storage is unavailable. */ }
  }, [autoNextRunAt, autoScheduleEnabled, autoScheduleMinutes, autoSettingsLoaded]);
  useEffect(() => {
    if (quotaRetryAt === null) return;
    const timer = window.setTimeout(() => setCurrentTime(Date.now()), Math.max(0, quotaRetryAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [quotaRetryAt]);
  useEffect(() => () => { searchSocketRef.current?.disconnect(); }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => void checkServices(), 0);
    return () => window.clearTimeout(timer);
  }, [checkServices]);
  useEffect(() => {
    const timer = window.setTimeout(() => void loadLeads(1), 0);
    return () => window.clearTimeout(timer);
  }, [loadLeads, selectedDate]);

  useEffect(() => {
    if (!authorizationUrl || upworkConnected) return;
    const startedAt = Date.now();
    const poll = window.setInterval(async () => {
      if (Date.now() - startedAt > 5 * 60 * 1000) {
        window.clearInterval(poll);
        setAuthLoading(false);
        return;
      }
      try {
        const status = await apiRequest<{ connected: boolean }>("/v1/auth/upwork/status");
        if (status.connected) {
          window.clearInterval(poll);
          setUpworkConnected(true);
          setAuthorizationUrl(null);
          setAuthLoading(false);
          showNotice("Upwork connected successfully.", "success");
        }
      } catch { /* Keep polling while OAuth is in progress. */ }
    }, 2000);
    return () => window.clearInterval(poll);
  }, [apiRequest, authorizationUrl, showNotice, upworkConnected]);

  useEffect(() => {
    if (activeRun?.status !== "running") return;
    const runId = activeRun.id;
    const poll = window.setInterval(() => void hydrateRun(runId), 2000);
    return () => window.clearInterval(poll);
  }, [activeRun?.id, activeRun?.status, hydrateRun]);

  function addKeyword(value = keywordInput) {
    const keyword = value.trim();
    setSearchFormError(null);
    if (!keyword) return;
    if (keyword.length > 80) {
      setSearchFormError("Each keyword may contain at most 80 characters.");
      return;
    }
    if (searchKeywords.some((item) => item.toLocaleLowerCase() === keyword.toLocaleLowerCase())) {
      setKeywordInput("");
      return;
    }
    if (searchKeywords.length >= 13) {
      setSearchFormError("You can search up to 13 unique keywords at once.");
      return;
    }
    setSearchKeywords((current) => [...current, keyword]);
    setKeywordInput("");
  }

  function removeKeyword(keyword: string) {
    setSearchKeywords((current) => current.filter((item) => item !== keyword));
    setSearchFormError(null);
  }

  function handleKeywordKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      addKeyword();
    }
    if (event.key === "Backspace" && !keywordInput && searchKeywords.length) {
      setSearchKeywords((current) => current.slice(0, -1));
    }
  }

  async function startSearch(options: { useDefaults?: boolean } = {}) {
    setSearchFormError(null);
    if (runInFlightRef.current || activeRunRef.current?.status === "running") return;
    if (quotaRetryAt !== null && quotaRetryAt > Date.now()) {
      showQuotaWait(Math.ceil((quotaRetryAt - Date.now()) / 1000));
      return;
    }
    const useDefaults = options.useDefaults ?? keywordMode === "default";
    const pendingKeyword = keywordInput.trim();
    const submittedKeywords = [...searchKeywords, ...(pendingKeyword ? [pendingKeyword] : [])]
      .filter((keyword, index, keywords) => keywords.findIndex((item) => item.toLocaleLowerCase() === keyword.toLocaleLowerCase()) === index);
    if (!useDefaults && submittedKeywords.length === 0) {
      setSearchFormError("Add at least one keyword or select backend defaults.");
      return;
    }
    if (!useDefaults && (submittedKeywords.length > 13 || submittedKeywords.some((keyword) => keyword.length > 80))) {
      setSearchFormError("Use 1–13 unique keywords with no more than 80 characters each.");
      return;
    }
    runInFlightRef.current = true;
    setRunLoading(true);
    try {
      const requestBody = {
        limit: runLimit,
        country: runCountry,
        ...(!useDefaults ? { keywords: submittedKeywords } : {}),
      };
      const serverlessSocketMode = Boolean(process.env.NEXT_PUBLIC_BACKEND_SOCKET_URL);
      const canUseSocket = serverlessSocketMode || Boolean(process.env.NEXT_PUBLIC_DASHBOARD_API_KEY);
      let socket: Socket | null = null;
      if (canUseSocket) {
        socket = createSearchSocket();
        await connectSearchSocket(socket);
      }

      let started: SearchRun;
      if (serverlessSocketMode) {
        if (!socket) throw new Error("The Vercel search socket is not configured.");
        const acknowledgement = await socket.timeout(5000).emitWithAck("search-run:start", requestBody) as SearchRun & { success: boolean; error?: string };
        if (!acknowledgement.success) throw new Error(acknowledgement.error || "The backend could not start the search.");
        started = acknowledgement;
      } else {
        const httpRun = await apiRequest<SearchRun & { pollUrl: string }>("/v1/search-runs", {
          method: "POST",
          body: JSON.stringify(requestBody),
        });
        started = httpRun;
      }
      if (!useDefaults && keywordMode === "manual") {
        setSearchKeywords(submittedKeywords);
        setKeywordInput("");
      }
      setQuotaRetryAt(null);
      activeRunRef.current = started; setActiveRun(started);
      const pendingProgress = pendingProgressRef.current.get(started.id);
      if (pendingProgress) {
        pendingProgressRef.current.delete(started.id);
        updateSearchProgress(pendingProgress);
      }
      if (!serverlessSocketMode && socket) {
        try {
          const acknowledgement = await socket.timeout(5000).emitWithAck("search-run:subscribe", { runId: started.id }) as { success: boolean; error?: string };
          if (!acknowledgement.success) throw new Error(acknowledgement.error || "Could not subscribe to search progress.");
        } catch (error) {
          showNotice(`Search started, but live progress could not connect: ${(error as Error).message}`);
        }
      }
      if (!serverlessSocketMode) await hydrateRun(started.id);
    } catch (error) {
      const apiError = error as ApiError;
      const message = `${apiError.message}${apiError.retryAfterSeconds ? ` Try again in ${apiError.retryAfterSeconds}s.` : ""}`;
      if (apiError.status === 400) setSearchFormError(message);
      else if (apiError.status === 409) {
        if (apiError.runId) {
          showNotice("A search is already running. Reconnecting to its progress.");
          await hydrateRun(apiError.runId);
        } else {
          const conflictMessage = "Another search is already running. Wait for it to finish before starting a new one.";
          setSearchFormError(conflictMessage);
          showNotice(conflictMessage);
        }
      } else if (apiError.status === 429 && apiError.retryAfterSeconds) showQuotaWait(apiError.retryAfterSeconds);
      else showNotice(message);
      searchSocketRef.current?.disconnect();
      searchSocketRef.current = null;
    } finally {
      runInFlightRef.current = false;
      setRunLoading(false);
    }
  }
  autoStartRef.current = () => startSearch({ useDefaults: true });
  autoCanStartRef.current = backendStatus === "online"
    && upworkConnected
    && !runInFlightRef.current
    && activeRun?.status !== "running"
    && (quotaRetryAt === null || quotaRetryAt <= Date.now());
  useEffect(() => {
    if (!autoSettingsLoaded || !autoScheduleEnabled || autoNextRunAt === null) return;
    const tick = () => {
      const now = Date.now();
      setCurrentTime(now);
      if (now < autoNextRunAt || !autoCanStartRef.current || autoTickInFlightRef.current) return;
      autoTickInFlightRef.current = true;
      setAutoNextRunAt(now + autoScheduleMinutes * 60_000);
      void autoStartRef.current().finally(() => { autoTickInFlightRef.current = false; });
    };
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [autoNextRunAt, autoScheduleEnabled, autoScheduleMinutes, autoSettingsLoaded]);

  const runProgress = activeRun ? Math.round(((activeRun.completedRequests || 0) / Math.max(activeRun.plannedRequests, 1)) * 100) : 0;
  const searchInputsDisabled = runLoading || activeRun?.status === "running";
  const quotaWaitSeconds = quotaRetryAt !== null ? Math.max(0, Math.ceil((quotaRetryAt - currentTime) / 1000)) : 0;
  const quotaWaiting = quotaWaitSeconds > 0;
  const autoCountdownSeconds = autoNextRunAt !== null ? Math.max(0, Math.ceil((autoNextRunAt - currentTime) / 1000)) : 0;
  const hasManualKeywords = searchKeywords.length > 0 || Boolean(keywordInput.trim());
  const newestLead = leads[0]?.postedAt;
  const stats = useMemo(() => [
    { label: "Leads in view", value: pagination.totalResults, detail: selectedDate || "All collected leads", icon: BriefcaseBusiness, color: "violet" },
    { label: "Active search", value: activeRun?.status === "running" ? `${runProgress}%` : "Idle", detail: activeRun?.status === "running" ? `${activeRun.completedRequests || 0} of ${activeRun.plannedRequests} requests` : "Ready when you are", icon: Zap, color: "blue" },
    { label: "Upwork", value: upworkConnected ? "Connected" : "Not connected", detail: upworkConnected ? "OAuth session active" : "Connect to run searches", icon: Link2, color: "green" },
    { label: "Latest lead", value: newestLead ? formatDate(newestLead).split(",")[0] : "—", detail: newestLead ? formatDate(newestLead) : "No leads loaded", icon: Clock3, color: "amber" },
  ], [activeRun, newestLead, pagination.totalResults, runProgress, selectedDate, upworkConnected]);

  return (
    <div className="dashboard-theme min-h-screen overflow-x-hidden bg-[#171a20] text-slate-100">
      {notice && <div className={`fixed left-3 right-3 top-3 z-50 flex items-start gap-3 rounded-xl border px-4 py-3 text-sm shadow-xl sm:left-auto sm:right-4 sm:top-4 sm:max-w-sm ${notice.tone === "success" ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-rose-200 bg-rose-50 text-rose-900"}`} role="status">{notice.tone === "success" ? <CircleCheck size={18} /> : <CircleAlert size={18} />}<span className="min-w-0 flex-1">{notice.message}</span><button className="shrink-0" onClick={() => setNotice(null)} aria-label="Dismiss notification"><X size={16} /></button></div>}

      {mobileNavOpen && <button className="fixed inset-0 z-30 bg-slate-950/40 backdrop-blur-[2px] lg:hidden" onClick={() => setMobileNavOpen(false)} aria-label="Close navigation overlay" />}

      <aside className={`fixed inset-y-0 left-0 z-40 w-[min(18rem,86vw)] border-r border-slate-200 bg-white p-4 shadow-2xl transition-transform duration-200 lg:w-64 lg:translate-x-0 lg:shadow-none ${mobileNavOpen ? "translate-x-0" : "-translate-x-full"}`}>
        <div className="flex h-full flex-col">
          <div className="flex h-14 items-center justify-between px-2"><div className="flex min-w-0 items-center gap-2"><Image src="/esclatech-logo.webp" width={194} height={54} alt="Esclatech" priority className="h-auto w-[148px] object-contain sm:w-[166px]" /><span className="sr-only">Lead intelligence</span></div><button className="rounded-lg p-2 text-slate-500 lg:hidden" onClick={() => setMobileNavOpen(false)} aria-label="Close navigation"><X size={18} /></button></div>
          <nav className="mt-7 space-y-1" aria-label="Main navigation">
            <a onClick={() => setMobileNavOpen(false)} className="flex items-center gap-3 rounded-xl bg-violet-50 px-3 py-2.5 text-sm font-semibold text-violet-700" href="#overview"><LayoutDashboard size={18} /> Overview</a>
            <a onClick={() => setMobileNavOpen(false)} className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-slate-500 hover:bg-slate-50 hover:text-slate-900" href="#leads"><BriefcaseBusiness size={18} /> Saved leads <span className="ml-auto rounded-md bg-slate-100 px-2 py-0.5 text-xs text-slate-600">{pagination.totalResults}</span></a>
            <a onClick={() => setMobileNavOpen(false)} className="flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-slate-500 hover:bg-slate-50 hover:text-slate-900" href="#search-run"><Zap size={18} /> Search runs</a>
          </nav>
          <div className="mt-auto rounded-2xl bg-slate-950 p-4 text-white"><div className="mb-3 flex items-center justify-between"><p className="text-xs font-semibold uppercase tracking-wider text-slate-400">System status</p><span className={`size-2 rounded-full ${backendStatus === "online" ? "bg-emerald-400" : backendStatus === "checking" ? "bg-amber-400" : "bg-rose-400"}`} /></div><p className="text-sm font-semibold">{backendStatus === "online" ? "Backend online" : backendStatus === "checking" ? "Checking backend" : "Backend unavailable"}</p><p className="mt-1 text-xs leading-5 text-slate-400">Protected by the private Next.js server proxy.</p></div>
        </div>
      </aside>

      <div className="lg:pl-64">
        <header className="sticky top-0 z-20 flex h-16 min-w-0 items-center justify-between gap-2 border-b border-slate-200/80 bg-white/90 px-3 backdrop-blur-xl sm:h-[72px] sm:px-6 xl:px-8"><div className="flex min-w-0 items-center gap-2 sm:gap-3"><button onClick={() => setMobileNavOpen(true)} className="shrink-0 rounded-lg p-2 text-slate-600 lg:hidden" aria-label="Open navigation"><Menu size={20} /></button><div className="min-w-0"><h1 className="gradient-heading truncate text-sm font-bold sm:text-base">Lead dashboard</h1><p className="hidden text-xs text-slate-500 md:block">Monitor searches and turn fresh opportunities into action.</p></div></div><div className="flex shrink-0 items-center"><div className="flex items-center gap-2 rounded-full border border-slate-200 px-2.5 py-1.5 text-[11px] font-medium text-slate-600 sm:px-3 sm:text-xs"><span className={`size-2 shrink-0 rounded-full ${upworkConnected ? "bg-emerald-500" : authLoading ? "bg-amber-400" : "bg-slate-300"}`} /><span className="hidden min-[390px]:inline">{upworkConnected ? "Upwork connected" : authLoading ? "Authorizing Upwork" : "Upwork unavailable"}</span><span className="min-[390px]:hidden">Upwork</span></div></div></header>

        <main className="mx-auto min-w-0 max-w-[1500px] px-3 py-4 sm:px-6 sm:py-6 xl:p-8" id="overview">
          {authorizationUrl && !upworkConnected && <section className="mb-5 flex flex-col gap-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 sm:mb-6 md:flex-row md:items-center md:justify-between"><div className="flex min-w-0 gap-3"><div className="grid size-10 shrink-0 place-items-center rounded-xl bg-amber-100 text-amber-700"><Link2 size={19} /></div><div className="min-w-0"><p className="text-sm font-bold text-amber-950">Upwork authorization is waiting</p><p className="mt-1 text-xs leading-5 text-amber-800">If the authorization window did not open automatically, continue from this link. Connection status is checked automatically.</p></div></div><a href={authorizationUrl} target="_blank" rel="noreferrer" className="w-full rounded-lg bg-amber-900 px-4 py-2.5 text-center text-xs font-semibold text-white md:w-auto">Continue authorization</a></section>}
          <div className="mb-5 flex flex-col justify-between gap-4 sm:mb-6 sm:flex-row sm:items-end"><div className="min-w-0"><p className="mb-2 text-xs font-bold uppercase tracking-[.16em] text-violet-600">Overview</p><h2 className="gradient-heading text-2xl font-bold tracking-tight sm:text-3xl">Your opportunity pipeline</h2><p className="mt-2 text-sm text-slate-500">A live view of your Upwork lead collection.</p></div><button onClick={() => void loadLeads(pagination.page)} disabled={leadsLoading} className="flex h-10 w-full items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-50 sm:w-auto">{leadsLoading ? <Spinner /> : <RefreshCw size={16} />} Refresh data</button></div>
          <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{stats.map((stat) => <StatCard key={stat.label} {...stat} />)}</section>

          <section id="search-run" className="mt-5 scroll-mt-20 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm sm:mt-6"><div className="grid xl:grid-cols-[minmax(0,1.4fr)_minmax(18rem,.6fr)]">
            <div className="min-w-0 p-4 sm:p-6">
              <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between md:gap-5">
                <div className="min-w-0"><div className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-[.14em] text-violet-600"><Zap size={14} /> Search collector</div><h3 className="text-lg font-bold">Find your next best-fit lead</h3><p className="mt-1 max-w-xl text-sm leading-6 text-slate-500">Search with your own terms or use the backend defaults. Results are saved automatically as each request completes.</p></div>
                <div className="flex w-full shrink-0 flex-wrap items-center justify-between gap-2 md:w-auto md:justify-end">
                  <label className="flex items-center gap-2 rounded-xl bg-slate-100 p-1 pl-3 text-xs font-semibold text-slate-500" htmlFor="run-country">Country<select id="run-country" value={runCountry} disabled={searchInputsDisabled} onChange={(event) => setRunCountry(event.target.value)} className="rounded-lg border-0 bg-white py-1.5 pl-2 pr-7 text-xs font-bold text-slate-800 shadow-sm outline-none disabled:opacity-50"><option>United States</option><option>Canada</option></select></label>
                  <div className="flex items-center justify-between gap-2 rounded-xl bg-slate-100 p-1"><label htmlFor="run-limit" className="pl-2 text-xs font-semibold text-slate-500">Jobs / keyword</label><select id="run-limit" value={runLimit} disabled={searchInputsDisabled} onChange={(event) => setRunLimit(Number(event.target.value))} className="rounded-lg border-0 bg-white py-1.5 pl-2 pr-7 text-xs font-bold shadow-sm outline-none disabled:opacity-50">{[10, 25, 50].map((value) => <option key={value} value={value}>{value}</option>)}</select></div>
                </div>
              </div>

              <div className="mt-5 min-w-0 rounded-2xl border border-slate-200 p-3 sm:mt-6 sm:p-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div><p className="text-xs font-bold text-slate-800">Search keywords</p><p className="mt-1 text-xs text-slate-500">One Upwork request is made for each unique keyword.</p></div>
                  <div className="flex w-full rounded-lg bg-slate-100 p-1 sm:w-auto" role="group" aria-label="Keyword source">
                    <button type="button" disabled={searchInputsDisabled} onClick={() => { setKeywordMode("manual"); setSearchFormError(null); }} className={`flex-1 rounded-md px-3 py-1.5 text-xs font-semibold transition disabled:opacity-50 sm:flex-none ${keywordMode === "manual" ? "bg-white text-violet-700 shadow-sm" : "text-slate-500"}`}>Manual</button>
                    <button type="button" disabled={searchInputsDisabled} onClick={() => { setKeywordMode("default"); setSearchFormError(null); }} className={`flex-1 rounded-md px-3 py-1.5 text-xs font-semibold transition disabled:opacity-50 sm:flex-none ${keywordMode === "default" ? "bg-white text-violet-700 shadow-sm" : "text-slate-500"}`}>Backend defaults</button>
                  </div>
                </div>

                {keywordMode === "manual" ? <>
                  <div className={`mt-4 flex min-h-12 flex-wrap items-center gap-2 rounded-xl border bg-white p-2 transition ${searchFormError ? "border-rose-300 ring-2 ring-rose-50" : "border-slate-200 focus-within:border-violet-400 focus-within:ring-2 focus-within:ring-violet-100"}`}>
                    {searchKeywords.map((keyword) => <span key={keyword} className="flex max-w-[calc(100%_-_2.5rem)] items-center gap-1.5 rounded-lg bg-violet-50 px-2.5 py-1.5 text-xs font-semibold text-violet-700 sm:max-w-full"><span className="truncate">{keyword}</span><button type="button" disabled={searchInputsDisabled} onClick={() => removeKeyword(keyword)} className="shrink-0 rounded p-0.5 hover:bg-violet-100 disabled:opacity-50" aria-label={`Remove ${keyword}`}><X size={12} /></button></span>)}
                    <input value={keywordInput} disabled={searchInputsDisabled || searchKeywords.length >= 13} maxLength={80} onChange={(event) => { setKeywordInput(event.target.value); setSearchFormError(null); }} onKeyDown={handleKeywordKeyDown} onBlur={() => { if (keywordInput.trim()) addKeyword(); }} placeholder={searchKeywords.length ? "Add another keyword" : "Type a keyword and press Enter"} className="h-8 min-w-0 basis-full flex-1 border-0 bg-transparent px-1 text-sm outline-none placeholder:text-slate-400 disabled:cursor-not-allowed sm:basis-48" />
                    <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => addKeyword()} disabled={searchInputsDisabled || !keywordInput.trim() || searchKeywords.length >= 13} className="grid size-8 place-items-center rounded-lg bg-slate-100 text-slate-600 hover:bg-violet-100 hover:text-violet-700 disabled:opacity-40" aria-label="Add keyword"><Plus size={15} /></button>
                  </div>
                  <div className="mt-2 flex flex-col gap-1 text-[11px] sm:flex-row sm:items-center sm:justify-between sm:gap-3"><span className={searchFormError ? "font-medium text-rose-600" : "text-slate-400"}>{searchFormError || "Press Enter or comma to add a keyword."}</span><span className="shrink-0 text-slate-400">{keywordInput.length}/80 · {searchKeywords.length}/13 keywords</span></div>
                </> : <div className="mt-4 flex items-center gap-3 rounded-xl bg-slate-50 p-3 text-xs text-slate-600"><CircleCheck size={16} className="shrink-0 text-emerald-600" />The request will omit <code className="rounded bg-white px-1.5 py-0.5 font-mono text-[10px]">keywords</code> and use the backend’s 13 configured defaults.</div>}
              </div>
              {activeRun ? <div className="mt-5 rounded-2xl border border-slate-200 bg-slate-50 p-3 sm:mt-6 sm:p-4"><div className="flex flex-wrap items-center justify-between gap-3"><div className="flex min-w-0 items-center gap-3"><div className={`grid size-10 shrink-0 place-items-center rounded-xl ${activeRun.status === "running" ? "bg-violet-100 text-violet-700" : activeRun.status === "complete" ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>{activeRun.status === "running" ? <Spinner size={19} /> : activeRun.status === "complete" ? <Check size={19} /> : <CircleAlert size={19} />}</div><div className="min-w-0"><p className="text-sm font-bold capitalize">{activeRun.status} search</p><p className="truncate text-xs text-slate-500">Run {activeRun.id.slice(0, 8)} · {activeRun.jobsCount} leads found</p></div></div><span className="rounded-full bg-white px-3 py-1 text-xs font-bold text-slate-600 shadow-sm">{runProgress}%</span></div><div className="mt-4 h-2 overflow-hidden rounded-full bg-slate-200"><div className={`h-full rounded-full transition-all duration-500 ${activeRun.status === "failed" ? "bg-rose-500" : "bg-violet-600"}`} style={{ width: `${runProgress}%` }} /></div><div className="mt-3 flex flex-col gap-1 text-xs text-slate-500 sm:flex-row sm:justify-between"><span className="truncate">{activeRun.lastCompletedSearch ? `Latest: ${activeRun.lastCompletedSearch.keyword}` : "Preparing searches…"}</span><span className="shrink-0">{activeRun.completedRequests || 0} / {activeRun.plannedRequests} requests</span></div>{activeRun.keywords?.length ? <div className="mt-3 flex flex-wrap gap-1.5 border-t border-slate-200 pt-3">{activeRun.keywords.map((keyword) => <span key={keyword} className="max-w-full truncate rounded-md bg-white px-2 py-1 text-[10px] font-semibold text-slate-600 shadow-sm">{keyword}</span>)}</div> : null}</div> : <div className="mt-5 flex items-start gap-3 rounded-2xl border border-dashed border-slate-300 bg-slate-50/70 p-4 text-sm leading-5 text-slate-500 sm:mt-6 sm:items-center"><div className="grid size-9 shrink-0 place-items-center rounded-lg bg-white text-slate-400 shadow-sm"><Search size={17} /></div>No search run is active. Start one when your connections are ready.</div>}
            </div>
            <div className="flex min-w-0 flex-col justify-between border-t border-slate-200 bg-slate-950 p-5 text-white sm:p-6 xl:border-l xl:border-t-0">
              <div>
                <p className="text-xs font-bold uppercase tracking-[.14em] text-slate-400">Ready check</p>
                <div className="mt-4 space-y-3">
                  <ReadyRow ready={backendStatus === "online"} label="Backend API" />
                  <ReadyRow ready={upworkConnected} label="Upwork account" />
                  <ReadyRow ready={keywordMode === "default" || hasManualKeywords} label="Keywords" />
                </div>

                <div className="mt-6 rounded-xl border border-white/10 bg-white/5 p-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-white">Automatic search</p>
                      <p className="mt-1 text-xs leading-5 text-slate-400">{!autoScheduleEnabled ? "Off — no scheduled searches" : autoCountdownSeconds > 0 ? `Next default search in ${formatCountdown(autoCountdownSeconds)}` : autoCanStartRef.current ? "Starting next default search…" : "Due; waiting for the current run or services"}</p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={autoScheduleEnabled}
                      aria-label="Automatic default keyword searches"
                      disabled={!autoSettingsLoaded}
                      onClick={() => {
                        const enabled = !autoScheduleEnabled;
                        setAutoScheduleEnabled(enabled);
                        setAutoNextRunAt(enabled ? Date.now() + autoScheduleMinutes * 60_000 : null);
                      }}
                      className={`relative h-8 w-[4.5rem] shrink-0 rounded-full transition-colors disabled:opacity-50 ${autoScheduleEnabled ? "bg-emerald-500" : "bg-slate-700"}`}
                    >
                      <span className={`absolute left-1 top-1 size-6 rounded-full bg-white shadow transition-transform ${autoScheduleEnabled ? "translate-x-10" : "translate-x-0"}`} />
                      <span className={`absolute inset-y-0 flex items-center text-[10px] font-extrabold tracking-wide ${autoScheduleEnabled ? "left-3 text-white" : "right-3 text-slate-200"}`}>
                        {autoScheduleEnabled ? "ON" : "OFF"}
                      </span>
                    </button>
                  </div>
                  <label htmlFor="auto-search-interval" className="sr-only">Automatic search interval</label>
                  <select
                    id="auto-search-interval"
                    value={autoScheduleMinutes}
                    disabled={autoScheduleEnabled || !autoSettingsLoaded}
                    onChange={(event) => {
                      const minutes = Number(event.target.value) as 10 | 15;
                      setAutoScheduleMinutes(minutes);
                      if (autoScheduleEnabled) setAutoNextRunAt(Date.now() + minutes * 60_000);
                    }}
                    className="mt-3 w-full rounded-lg border border-white/10 bg-slate-900 px-3 py-2 text-xs font-semibold text-white outline-none disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <option value={10}>Every 10 minutes</option>
                    <option value={15}>Every 15 minutes</option>
                  </select>
                  <p className="mt-2 text-[11px] leading-4 text-slate-400">Choose the interval while Off; turning auto-search On locks it until you turn it Off again.</p>
                </div>
              </div>

              <button onClick={startSearch} disabled={autoScheduleEnabled || searchInputsDisabled || quotaWaiting || !upworkConnected || backendStatus !== "online" || (keywordMode === "manual" && !hasManualKeywords)} className="mt-6 flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-violet-500 px-3 text-center text-sm font-bold shadow-lg shadow-violet-950/30 hover:bg-violet-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400 disabled:shadow-none">{runLoading ? <Spinner /> : quotaWaiting ? <Clock3 className="shrink-0" size={17} /> : <Play className="shrink-0" size={17} fill="currentColor" />} <span className="truncate">{activeRun?.status === "running" ? "Search in progress" : autoScheduleEnabled ? "Auto search is on" : quotaWaiting ? `Retry in ${quotaWaitSeconds}s` : keywordMode === "default" ? "Search default keywords" : `Search ${searchKeywords.length + (keywordInput.trim() ? 1 : 0)} keyword${searchKeywords.length + (keywordInput.trim() ? 1 : 0) === 1 ? "" : "s"}`}</span></button>
            </div>
          </div></section>

          <section id="leads" className="mt-5 scroll-mt-20 rounded-2xl border border-slate-200 bg-white shadow-sm sm:mt-6">
            <div className="border-b border-slate-200 p-4 sm:p-6"><div className="flex min-w-0 flex-col gap-4 xl:flex-row xl:items-end xl:justify-between"><div className="min-w-0"><div className="mb-2 flex items-center gap-2 text-xs font-bold uppercase tracking-[.14em] text-violet-600"><BriefcaseBusiness size={14} /> Saved opportunities</div><h3 className="text-lg font-bold">Lead library</h3><p className="mt-1 text-sm text-slate-500">Search, sort, and review opportunities already saved to MongoDB.</p></div><div className="grid min-w-0 gap-2 md:grid-cols-[minmax(0,1fr)_auto_auto]"><form onSubmit={(event) => { event.preventDefault(); setSearchKeyword(keyword.trim()); }} className="relative min-w-0"><Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" /><input value={keyword} onChange={(event) => setKeyword(event.target.value)} placeholder="Filter by searched keyword" className="h-10 w-full min-w-0 rounded-xl border border-slate-200 bg-white pl-9 pr-3 text-sm outline-none transition focus:border-violet-400 focus:ring-2 focus:ring-violet-100" /></form><label className="relative block min-w-0" title="Optional date filter"><CalendarDays size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" /><input aria-label="Filter by date (optional)" type="date" value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)} className="h-10 w-full min-w-0 rounded-xl border border-slate-200 pl-9 pr-3 text-sm outline-none focus:border-violet-400 md:w-auto" /></label><label className="relative block min-w-0"><SlidersHorizontal size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" /><select aria-label="Sort leads" value={sortBy} onChange={(event) => setSortBy(event.target.value)} className="h-10 w-full min-w-0 rounded-xl border border-slate-200 bg-white pl-9 pr-8 text-sm outline-none focus:border-violet-400 md:w-auto"><option value="postedAt:desc">Newest first</option><option value="postedAt:asc">Oldest first</option><option value="title:asc">Title A–Z</option><option value="country:asc">Country A–Z</option></select></label></div></div></div>
            <div className="hidden overflow-x-auto lg:block"><table className="w-full text-left"><thead><tr className="border-b border-slate-200 bg-slate-50/70 text-[11px] font-bold uppercase tracking-wider text-slate-500"><th className="px-6 py-3">Opportunity</th><th className="px-4 py-3">Type & budget</th><th className="px-4 py-3">Matched via</th><th className="px-4 py-3">Posted</th><th className="px-6 py-3 text-right">Open</th></tr></thead><tbody className="divide-y divide-slate-100">
              {leadsLoading ? <TableMessage><Spinner size={20} /> Loading leads…</TableMessage> : leads.length === 0 ? <TableMessage><Filter size={20} /> No leads match these filters.</TableMessage> : leads.map((lead) => <tr key={lead._id} className="group hover:bg-slate-50/70"><td className="max-w-md px-6 py-4"><div className="flex min-w-0 items-center gap-2"><p className="truncate text-sm font-bold text-slate-900">{lead.title}</p>{isLeadNew(lead.postedAt, currentTime) && <span className="shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-700">New</span>}</div><p className="mt-1 line-clamp-1 text-xs text-slate-500">{lead.summary || "No summary available."}</p><div className="mt-2 flex items-center gap-1.5 text-[11px] font-medium text-slate-500"><span className="rounded-md bg-slate-100 px-2 py-1">{lead.country || "Unknown"}</span>{lead.hasAttachments && <span className="flex items-center gap-1 rounded-md bg-amber-50 px-2 py-1 text-amber-700"><Paperclip size={11} /> Attachments</span>}{lead.skills?.slice(0, 2).map((skill) => <span key={skill} className="rounded-md bg-violet-50 px-2 py-1 text-violet-700">{skill}</span>)}</div></td><td className="whitespace-nowrap px-4 py-4"><p className="text-xs font-semibold text-slate-800">{lead.jobType || "Not specified"}</p><p className="mt-1 text-xs text-slate-500">{formatBudget(lead.budget)}</p></td><td className="max-w-48 px-4 py-4"><div className="flex flex-wrap gap-1">{lead.searchedKeywords?.slice(0, 2).map((item) => <span key={item} className="rounded-full border border-slate-200 px-2 py-1 text-[10px] font-semibold text-slate-600">{item}</span>)}</div></td><td className="whitespace-nowrap px-4 py-4 text-xs text-slate-500">{formatDate(lead.postedAt)}</td><td className="px-6 py-4 text-right"><a href={lead.url} target="_blank" rel="noreferrer" aria-label={`Open ${lead.title}`} className="inline-grid size-9 place-items-center rounded-lg border border-slate-200 text-slate-500 transition hover:border-violet-200 hover:bg-violet-50 hover:text-violet-700"><ArrowUpRight size={16} /></a></td></tr>)}
            </tbody></table></div>
            <div className="divide-y divide-slate-100 lg:hidden">{leadsLoading ? <div className="flex items-center justify-center gap-2 p-10 text-sm text-slate-500"><Spinner /> Loading leads…</div> : leads.length === 0 ? <div className="p-10 text-center text-sm text-slate-500">No leads match these filters.</div> : leads.map((lead) => <MobileLeadCard key={lead._id} lead={lead} currentTime={currentTime} />)}</div>
            <div className="flex flex-col items-center gap-3 border-t border-slate-200 px-4 py-4 text-center text-xs text-slate-500 sm:flex-row sm:justify-between sm:px-5 sm:text-left">
              <div className="flex flex-col items-center gap-3 sm:flex-row">
                <p>Showing {leads.length ? (pagination.page - 1) * pagination.limit + 1 : 0}–{Math.min(pagination.page * pagination.limit, pagination.totalResults)} of {pagination.totalResults} leads</p>
                <label className="flex items-center gap-2 font-medium" htmlFor="leads-page-size">
                  Per page
                  <select
                    id="leads-page-size"
                    value={pagination.limit}
                    disabled={leadsLoading}
                    onChange={(event) => setPagination((current) => ({ ...current, page: 1, limit: Number(event.target.value) }))}
                    className="rounded-lg border border-slate-200 bg-white px-2.5 py-2 text-xs font-semibold text-slate-700 outline-none disabled:opacity-50"
                  >
                    {[10, 25, 50, 100].map((size) => <option key={size} value={size}>{size}</option>)}
                  </select>
                </label>
              </div>
              <div className="flex items-center gap-1 sm:gap-2"><button onClick={() => void loadLeads(pagination.page - 1)} disabled={pagination.page <= 1 || leadsLoading} className="grid size-9 place-items-center rounded-lg border border-slate-200 disabled:opacity-40" aria-label="Previous page"><ChevronLeft size={16} /></button><span className="px-1 font-semibold text-slate-700 sm:px-2">Page {pagination.page} of {Math.max(pagination.totalPages, 1)}</span><button onClick={() => void loadLeads(pagination.page + 1)} disabled={pagination.page >= pagination.totalPages || leadsLoading} className="grid size-9 place-items-center rounded-lg border border-slate-200 disabled:opacity-40" aria-label="Next page"><ChevronRight size={16} /></button></div>
            </div>
          </section>
        </main>
      </div>

    </div>
  );
}

function StatCard({ label, value, detail, icon: Icon, color }: { label: string; value: string | number; detail: string; icon: typeof BriefcaseBusiness; color: string }) {
  const colors: Record<string, string> = { violet: "bg-violet-50 text-violet-700", blue: "bg-blue-50 text-blue-700", green: "bg-emerald-50 text-emerald-700", amber: "bg-amber-50 text-amber-700" };
  return <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><div className="flex items-start justify-between"><p className="text-xs font-semibold text-slate-500">{label}</p><div className={`grid size-9 place-items-center rounded-xl ${colors[color]}`}><Icon size={17} /></div></div><p className="mt-3 text-2xl font-bold tracking-tight">{value}</p><p className="mt-1 text-xs text-slate-400">{detail}</p></div>;
}
function ReadyRow({ ready, label }: { ready: boolean; label: string }) { return <div className="flex items-center justify-between text-sm"><span className="text-slate-300">{label}</span><span className={`flex items-center gap-1.5 text-xs font-semibold ${ready ? "text-emerald-400" : "text-slate-500"}`}>{ready ? <CircleCheck size={15} /> : <Unplug size={15} />}{ready ? "Ready" : "Waiting"}</span></div>; }
function TableMessage({ children }: { children: React.ReactNode }) { return <tr><td colSpan={5}><div className="flex items-center justify-center gap-2 p-14 text-sm text-slate-500">{children}</div></td></tr>; }
function MobileLeadCard({ lead, currentTime }: { lead: Lead; currentTime: number }) { return <article className="min-w-0 p-4 sm:p-5"><div className="flex min-w-0 items-start justify-between gap-3 sm:gap-4"><div className="min-w-0 flex-1"><div className="flex min-w-0 items-start gap-2"><p className="line-clamp-2 min-w-0 text-sm font-bold leading-5">{lead.title}</p>{isLeadNew(lead.postedAt, currentTime) && <span className="mt-0.5 shrink-0 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-emerald-700">New</span>}</div><p className="mt-1 truncate text-xs text-slate-500">{lead.country || "Unknown"} · {formatDate(lead.postedAt)}</p></div><a href={lead.url} target="_blank" rel="noreferrer" className="grid size-9 shrink-0 place-items-center rounded-lg border border-slate-200 text-violet-700" aria-label={`Open ${lead.title}`}><ArrowUpRight size={16} /></a></div><p className="mt-3 line-clamp-2 text-xs leading-5 text-slate-500">{lead.summary || "No summary available."}</p><div className="mt-3 flex flex-wrap gap-1.5"><span className="max-w-full truncate rounded-md bg-slate-100 px-2 py-1 text-[10px] font-semibold">{lead.jobType || "Not specified"}</span><span className="max-w-full truncate rounded-md bg-emerald-50 px-2 py-1 text-[10px] font-semibold text-emerald-700">{formatBudget(lead.budget)}</span>{lead.hasAttachments && <span className="flex items-center gap-1 rounded-md bg-amber-50 px-2 py-1 text-[10px] font-semibold text-amber-700"><Paperclip size={11} /> Attachments</span>}{lead.skills?.slice(0, 2).map((skill) => <span key={skill} className="max-w-full truncate rounded-md bg-violet-50 px-2 py-1 text-[10px] font-semibold text-violet-700">{skill}</span>)}</div></article>; }
