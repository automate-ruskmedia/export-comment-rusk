"use client";

import { useState, useRef, useEffect } from "react";
import { downloadZip } from "client-zip";
import Swal from "sweetalert2";
import styles from "./BatchExporter.module.css";
import { parseCSV, csvField } from "./csvUtils";

const BATCH_SIZE = 25;
// Terminal export statuses per the ExportComments API (docs.exportcomments.com/jobs). An export is
// "settled" only in one of these; anything else (queueing, progress, in_progress, requeueing, or an
// unknown future status) counts as still working, so we never call a run done prematurely.
const TERMINAL_STATUSES = new Set(["done", "error", "stopped"]);
// Safety net for the polling loop — if exports genuinely take longer than this, stop polling and
// point the user at the recovery button instead of spinning forever.
const MAX_POLL_MS = 6 * 60 * 60 * 1000;
const ZIP_CONCURRENCY = 6;
const TOKEN_STORAGE_KEY = "bulkExporter.token";
const URLS_STORAGE_KEY = "bulkExporter.urlsRaw";
const REPLIES_STORAGE_KEY = "bulkExporter.replies";
const RESULTS_STORAGE_KEY = "bulkExporter.results";
// batchIds of the last submitted run — persisted so exports can be re-downloaded in a fresh tab.
const BATCHIDS_STORAGE_KEY = "bulkExporter.batchIds";

type Status = "idle" | "submitting" | "polling" | "fetching-links" | "done" | "error";

type ResultItem = {
  url: string;
  status: string;
  totalExported: number;
  downloadUrl: string | null;
  fileName: string | null;
  error: string | null;
};

type Progress = {
  done: number;
  error: number;
  in_progress: number;
  progress_pct: number;
};

type LiveExport = {
  url: string;
  status: string;
  totalExported: number;
};

type CsvRow = {
  permalink: string;
  title: string;
  description: string;
  publishTime: string;
  comments: number;
};

type SearchScope = "title" | "description" | "both";

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function filterCsvRows(rows: CsvRow[], onlyWithComments: boolean, query: string, scope: SearchScope): CsvRow[] {
  let filtered = onlyWithComments ? rows.filter((r) => r.comments > 0) : rows;
  const q = query.trim().toLowerCase();
  if (q) {
    filtered = filtered.filter((r) => {
      const inTitle = r.title.toLowerCase().includes(q);
      const inDesc = r.description.toLowerCase().includes(q);
      if (scope === "title") return inTitle;
      if (scope === "description") return inDesc;
      return inTitle || inDesc;
    });
  }
  return filtered;
}

export default function BatchExporter() {
  const [token, setToken] = useState("");
  const [urlsRaw, setUrlsRaw] = useState("");
  const [replies, setReplies] = useState(true);
  const [status, setStatus] = useState<Status>("idle");
  const [progress, setProgress] = useState<Progress | null>(null);
  const [batchIndex, setBatchIndex] = useState(0);
  const [batchCount, setBatchCount] = useState(0);
  const [results, setResults] = useState<ResultItem[]>([]);
  const [liveExports, setLiveExports] = useState<LiveExport[]>([]);
  const [errorMsg, setErrorMsg] = useState("");
  const cancelRef = useRef(false);
  const bookmarkletRef = useRef<HTMLAnchorElement>(null);
  const [csvError, setCsvError] = useState("");
  const [tokenCheck, setTokenCheck] = useState<"idle" | "checking" | "valid" | "invalid">("idle");
  const [tokenCheckMsg, setTokenCheckMsg] = useState("");
  const [zipping, setZipping] = useState(false);
  const [zipProgress, setZipProgress] = useState({ done: 0, total: 0, failed: 0 });
  const [csvRows, setCsvRows] = useState<CsvRow[]>([]);
  const [csvStats, setCsvStats] = useState<{ total: number; unique: number; withComments: number } | null>(null);
  const [csvDragOver, setCsvDragOver] = useState(false);
  const [onlyWithComments, setOnlyWithComments] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchScope, setSearchScope] = useState<SearchScope>("both");
  const [savedBatchIds, setSavedBatchIds] = useState<string[]>([]);
  const [recovering, setRecovering] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  // True once the user hand-edits the URLs textarea after a CSV load — search/filter must not
  // silently overwrite those edits by regenerating urlsRaw from csvRows.
  const [urlsManuallyEdited, setUrlsManuallyEdited] = useState(false);

  function cancelRun() {
    cancelRef.current = true;
    setCancelling(true);
  }

  // Shared by the manual "Check token" button and the pre-flight check before each batch.
  async function validateToken(authHeader: string): Promise<{ ok: boolean; message: string }> {
    try {
      const res = await fetch("/api/me", { headers: { Authorization: authHeader } });
      const data = await res.json();
      if (res.ok) return { ok: true, message: data.email ? `Valid — ${data.email}` : "Valid" };
      return { ok: false, message: data.error || "Invalid or expired token" };
    } catch {
      return { ok: false, message: "Could not reach token check endpoint" };
    }
  }

  async function checkToken() {
    setTokenCheck("checking");
    setTokenCheckMsg("");
    const authHeader = token.trim().startsWith("Bearer ") ? token.trim() : `Bearer ${token.trim()}`;
    const result = await validateToken(authHeader);
    setTokenCheck(result.ok ? "valid" : "invalid");
    setTokenCheckMsg(result.message);
    if (result.ok) localStorage.setItem(TOKEN_STORAGE_KEY, token.trim());
  }

  useEffect(() => {
    const savedUrls = localStorage.getItem(URLS_STORAGE_KEY);
    if (savedUrls) setUrlsRaw(savedUrls);
    const savedToken = localStorage.getItem(TOKEN_STORAGE_KEY);
    if (savedToken) setToken(savedToken);
    const savedReplies = localStorage.getItem(REPLIES_STORAGE_KEY);
    if (savedReplies !== null) setReplies(savedReplies === "true");
    const savedResults = localStorage.getItem(RESULTS_STORAGE_KEY);
    if (savedResults) {
      try {
        setResults(JSON.parse(savedResults));
      } catch {}
    }
    const savedIds = localStorage.getItem(BATCHIDS_STORAGE_KEY);
    if (savedIds) {
      try {
        setSavedBatchIds(JSON.parse(savedIds));
      } catch {}
    }
  }, []);

  useEffect(() => {
    localStorage.setItem(URLS_STORAGE_KEY, urlsRaw);
  }, [urlsRaw]);

  useEffect(() => {
    localStorage.setItem(REPLIES_STORAGE_KEY, String(replies));
  }, [replies]);

  useEffect(() => {
    localStorage.setItem(RESULTS_STORAGE_KEY, JSON.stringify(results));
  }, [results]);

  // React blocks javascript: hrefs set via JSX props (XSS precaution) — set it on the raw DOM node
  // instead, which bypasses that sanitizer since React never sees the value as a prop.
  useEffect(() => {
    if (bookmarkletRef.current) {
      bookmarkletRef.current.href =
        "javascript:(function(){var m=document.cookie.match(/jwt_token=([^;]*)/);if(!m)return alert('no token');var t=decodeURIComponent(m[1]);navigator.clipboard.writeText(t);alert('Copied: '+t.slice(0,24)+'…');})();";
    }
  }, []);

  async function resetSession() {
    const confirmed = await Swal.fire({
      title: "Reset session?",
      text: "Clears URLs, results and the loaded CSV. Your saved token is kept.",
      icon: "warning",
      showCancelButton: true,
      confirmButtonText: "Reset",
      confirmButtonColor: "#dc2626",
    });
    if (!confirmed.isConfirmed) return;

    localStorage.removeItem(URLS_STORAGE_KEY);
    localStorage.removeItem(REPLIES_STORAGE_KEY);
    localStorage.removeItem(RESULTS_STORAGE_KEY);
    setUrlsRaw("");
    setReplies(true);
    setResults([]);
    setLiveExports([]);
    setErrorMsg("");
    setCsvError("");
    setStatus("idle");
    setProgress(null);
    setBatchIndex(0);
    setBatchCount(0);
    setCsvRows([]);
    setCsvStats(null);
    setOnlyWithComments(false);
    setSearchQuery("");
    setSearchScope("both");
    setUrlsManuallyEdited(false);

    Swal.fire({ title: "Session reset", icon: "success", timer: 1200, showConfirmButton: false });
  }

  function handleCsvUpload(file: File) {
    setCsvError("");
    setCsvStats(null);
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const text = (reader.result as string).replace(/^﻿/, "");
        const rows = parseCSV(text);
        if (rows.length === 0) {
          setCsvError("This CSV appears to be empty.");
          return;
        }
        const header = rows[0];
        const iLink = header.indexOf("Permalink");
        const iTitle = header.indexOf("Title");
        const iDesc = header.indexOf("Description");
        const iPublish = header.indexOf("Publish time");
        const iComments = header.indexOf("Comments");
        if (iLink === -1) {
          setCsvError('Could not find a "Permalink" column in this CSV.');
          return;
        }

        const byLink = new Map<string, CsvRow>();
        let totalRows = 0;
        for (const r of rows.slice(1)) {
          const link = r[iLink];
          if (!link) continue;
          totalRows++;
          const c = iComments !== -1 ? parseInt(r[iComments] || "0", 10) || 0 : 0;
          const existing = byLink.get(link);
          if (existing) {
            existing.comments += c;
          } else {
            byLink.set(link, {
              permalink: link,
              title: iTitle !== -1 ? r[iTitle] || "" : "",
              description: iDesc !== -1 ? r[iDesc] || "" : "",
              publishTime: iPublish !== -1 ? r[iPublish] || "" : "",
              comments: c,
            });
          }
        }

        const parsed = Array.from(byLink.values());
        const withComments = parsed.filter((r) => r.comments > 0).length;

        setCsvRows(parsed);
        setCsvStats({ total: totalRows, unique: parsed.length, withComments });
        setOnlyWithComments(false);
        setSearchQuery("");
        setUrlsManuallyEdited(false);
        setUrlsRaw(parsed.map((r) => r.permalink).join("\n"));

        Swal.fire({
          title: "CSV loaded",
          text: `${parsed.length} unique links · ${withComments} with comments`,
          icon: "success",
          timer: 1800,
          showConfirmButton: false,
        });
      } catch (e: any) {
        setCsvError(e.message || "Failed to read CSV.");
      }
    };
    reader.readAsText(file);
  }

  function applyFilters(onlyWc: boolean, query: string, scope: SearchScope) {
    if (urlsManuallyEdited) {
      setErrorMsg('You\'ve manually edited the URL list — search/filter is disabled to avoid losing your edits. Reload the CSV to use search again.');
      return;
    }
    const filtered = filterCsvRows(csvRows, onlyWc, query, scope);
    setUrlsRaw(filtered.map((r) => r.permalink).join("\n"));
  }

  function downloadCleanedCsv() {
    const filtered = filterCsvRows(csvRows, onlyWithComments, searchQuery, searchScope);
    const sorted = [...filtered].sort((a, b) => b.comments - a.comments);
    const header = ["Title", "Description", "Permalink", "Publish time", "Comments"];
    const lines = [
      header,
      ...sorted.map((r) => [r.title, r.description, r.permalink, r.publishTime, String(r.comments)]),
    ];
    const csvOut = lines.map((r) => r.map(csvField).join(",")).join("\n");
    const blob = new Blob([csvOut], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `cleaned_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const urls = urlsRaw.split("\n").map((s) => s.trim()).filter(Boolean);
  const batches = chunk(urls, BATCH_SIZE);
  const isBusy = status === "submitting" || status === "polling" || status === "fetching-links";

  // Submit every batch to ExportComments 2 min apart, then poll the jobs list in the browser until
  // every submitted export finishes, and auto-download the whole lot as one combined ZIP. Tab must
  // stay open for the duration — the loop lives here, not on the server.
  async function run() {
    setErrorMsg("");
    setResults([]);
    setProgress(null);
    setLiveExports([]);
    cancelRef.current = false;
    setCancelling(false);

    if (!token.trim()) return setErrorMsg("Paste your bearer token first.");
    if (urls.length === 0) return setErrorMsg("Add at least one URL.");

    const authHeader = token.trim().startsWith("Bearer ") ? token.trim() : `Bearer ${token.trim()}`;
    setBatchCount(batches.length);

    const check = await validateToken(authHeader);
    if (!check.ok) return setErrorMsg(`Token check failed: ${check.message}`);

    // 1. Submit all batches, 2 min apart. Remember each batchId and how many exports it should have.
    // batchIds are persisted after every submit, so a run interrupted by a tab close is still
    // recoverable via the "Download completed exports" button.
    setStatus("submitting");
    const expectedByBatch: Record<string, number> = {};
    localStorage.setItem(BATCHIDS_STORAGE_KEY, "[]");
    setSavedBatchIds([]);
    for (let i = 0; i < batches.length; i++) {
      if (cancelRef.current) { setCancelling(false); return setStatus("idle"); }
      setBatchIndex(i + 1);
      try {
        const res = await fetch("/api/batch-export", {
          method: "POST",
          headers: { Authorization: authHeader, "Content-Type": "application/json" },
          body: JSON.stringify({ urls: batches[i], options: { replies } }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Submit failed (${res.status})`);
        if (data.batchId) {
          expectedByBatch[data.batchId] = batches[i].length;
          const ids = Object.keys(expectedByBatch);
          localStorage.setItem(BATCHIDS_STORAGE_KEY, JSON.stringify(ids));
          setSavedBatchIds(ids);
        }
      } catch (e: any) {
        setStatus("error");
        setErrorMsg(`Batch ${i + 1}/${batches.length} submit failed: ${e.message}`);
        return;
      }
      if (i < batches.length - 1) await sleepCancelable(2 * 60 * 1000, cancelRef);
    }

    const batchIds = Object.keys(expectedByBatch);
    if (batchIds.length === 0) {
      setStatus("error");
      setErrorMsg("No batch IDs returned — cannot track or download exports.");
      return;
    }

    // 2. Poll the jobs list until every batch's exports are all out of a pending state.
    setStatus("polling");
    const totalExpected = Object.values(expectedByBatch).reduce((a, b) => a + b, 0);
    const pollStart = Date.now();
    let allJobs: ResultItem[] = [];
    while (true) {
      if (cancelRef.current) { setCancelling(false); return setStatus("idle"); }
      if (Date.now() - pollStart > MAX_POLL_MS) {
        setStatus("error");
        setErrorMsg(
          "Still not finished after 6 hours of polling — stopping here. Your batches may still be processing on ExportComments; use \"Download completed exports\" below once they're done."
        );
        return;
      }
      let byBatch: Record<string, ResultItem[]>;
      try {
        byBatch = await fetchMyJobs(authHeader, new Set(batchIds));
      } catch (e: any) {
        setStatus("error");
        setErrorMsg(
          `Lost connection while polling: ${e.message}. Your batches are still processing on ExportComments — use "Download completed exports" below to check later.`
        );
        return;
      }
      allJobs = batchIds.flatMap((id) => byBatch[id] ?? []);
      setResults([...allJobs]);
      const settled = allJobs.filter((j) => TERMINAL_STATUSES.has(j.status)).length;
      setProgress({
        done: allJobs.filter((j) => j.status === "done").length,
        error: allJobs.filter((j) => j.status === "error").length,
        in_progress: allJobs.length - settled,
        progress_pct: totalExpected ? Math.round((settled / totalExpected) * 100) : 0,
      });
      const allBatchesDone = batchIds.every((id) => {
        const mine = byBatch[id] ?? [];
        return mine.length >= expectedByBatch[id] && mine.every((e) => TERMINAL_STATUSES.has(e.status));
      });
      if (allBatchesDone) break;
      await sleepCancelable(15000, cancelRef);
    }

    // 3. Everything settled — download all successful exports as one combined ZIP.
    setStatus("done");
    await downloadAllAsZip(allJobs);
  }

  // Pages through the jobs list and returns our exports grouped by batch_id. Our batches are the
  // most recent, so a few pages of 100 cover them; stop on a short/empty page.
  async function fetchMyJobs(authHeader: string, wanted: Set<string>): Promise<Record<string, ResultItem[]>> {
    const grouped: Record<string, ResultItem[]> = {};
    for (let page = 1; page <= 30; page++) {
      const r = await fetch(`/api/jobs?page=${page}&limit=100`, { headers: { Authorization: authHeader } });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Failed to fetch jobs");
      const items = d.items || [];
      for (const it of items) {
        const batchId = it.comment.batch_id;
        if (!wanted.has(batchId)) continue;
        (grouped[batchId] ??= []).push({
          url: it.comment.url,
          status: it.comment.status,
          totalExported: it.comment.total_exported ?? 0,
          downloadUrl: it.comment.download_url ?? it.comment.download_link ?? null,
          fileName: it.comment.file_name ?? it.comment.rawFile ?? null,
          error: it.comment.error ?? null,
        });
      }
      if (items.length < 100) break;
    }
    return grouped;
  }

  // Fetches files with a bounded lookahead window and yields each Response as soon as it's ready.
  // Response bodies are handed to client-zip unread — it streams/compresses them on the fly, so
  // memory use stays bounded to ~ZIP_CONCURRENCY files in flight, not the whole archive.
  async function* streamFiles(items: ResultItem[]) {
    const usedNames = new Set<string>();
    let idx = 0;
    let failed = 0;
    const inFlight: Promise<{ name: string; res: Response | null }>[] = [];

    function launch() {
      if (idx >= items.length) return;
      const item = items[idx++];
      inFlight.push(
        fetch(item.downloadUrl!)
          .then((res) => (res.ok ? { name: item.fileName || `export_${idx}.xlsx`, res } : { name: "", res: null }))
          .catch(() => ({ name: "", res: null }))
      );
    }
    for (let i = 0; i < ZIP_CONCURRENCY && i < items.length; i++) launch();

    let done = 0;
    while (inFlight.length) {
      const { name, res } = await inFlight.shift()!;
      launch();
      done++;
      if (!res) {
        failed++;
        setZipProgress({ done, total: items.length, failed });
        continue;
      }
      let finalName = name;
      if (usedNames.has(finalName)) {
        const base = finalName.replace(/\.[^.]+$/, "");
        const ext = finalName.match(/\.[^.]+$/)?.[0] || "";
        finalName = `${base}_${done}${ext}`;
      }
      usedNames.add(finalName);
      setZipProgress({ done, total: items.length, failed });
      yield { name: finalName, input: res };
    }
  }

  async function downloadAllAsZip(items?: ResultItem[]) {
    const source = items ?? results;
    const downloadable = source.filter((r) => r.status === "done" && r.downloadUrl);
    if (downloadable.length === 0) return;

    setZipping(true);
    setZipProgress({ done: 0, total: downloadable.length, failed: 0 });

    const zipResponse = downloadZip(streamFiles(downloadable));
    const fileName = `comment_exports_${new Date().toISOString().slice(0, 10)}.zip`;

    // File System Access API streams straight to disk (near-constant memory). Chrome/Edge only —
    // Safari/Firefox fall back to buffering the finished zip as one Blob, still one copy instead
    // of the old approach's every-file-blob-plus-archive double buffering.
    if ("showSaveFilePicker" in window) {
      let handle: any;
      try {
        handle = await (window as any).showSaveFilePicker({ suggestedName: fileName });
      } catch (e: any) {
        if (e?.name === "AbortError") {
          setZipping(false);
          return;
        }
        handle = null; // couldn't get a file handle — fall through to the blob download below
      }
      if (handle) {
        try {
          const writable = await handle.createWritable();
          await zipResponse.body!.pipeTo(writable);
          setZipping(false);
          return;
        } catch (e: any) {
          // The response stream is already consumed/errored at this point — it cannot be re-read
          // via .blob() below, so report the failure instead of falling through to a broken stream.
          setZipping(false);
          setErrorMsg(`Failed to save ZIP: ${e.message || e}`);
          return;
        }
      }
    }

    const blob = await zipResponse.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
    setZipping(false);
  }

  // Recovery path: re-fetch the last run's exports from the jobs list (persisted batchIds survive a
  // tab close) and download whatever's finished. Works in a fresh tab hours/days later.
  async function downloadSavedExports() {
    setErrorMsg("");
    if (!token.trim()) return setErrorMsg("Paste your bearer token first.");
    if (savedBatchIds.length === 0) return setErrorMsg("No previous batches saved on this browser.");

    const authHeader = token.trim().startsWith("Bearer ") ? token.trim() : `Bearer ${token.trim()}`;
    setRecovering(true);
    try {
      const byBatch = await fetchMyJobs(authHeader, new Set(savedBatchIds));
      const all = savedBatchIds.flatMap((id) => byBatch[id] ?? []);
      setResults([...all]);
      const ready = all.filter((r) => r.status === "done" && r.downloadUrl).length;
      const pending = all.filter((r) => !TERMINAL_STATUSES.has(r.status)).length;
      if (ready === 0) {
        setErrorMsg(pending > 0 ? `Nothing ready yet — ${pending} export(s) still processing.` : "No completed exports found for your saved batches.");
        return;
      }
      if (pending > 0) {
        setErrorMsg(`Downloading ${ready} finished export(s); ${pending} still processing — run this again later for the rest.`);
      }
      await downloadAllAsZip(all);
    } catch (e: any) {
      setErrorMsg(`Recovery failed: ${e.message}`);
    } finally {
      setRecovering(false);
    }
  }

  function statusLabel() {
    const prefix = batchCount > 1 ? `Batch ${batchIndex}/${batchCount} — ` : "";
    switch (status) {
      case "submitting":
        return `${prefix}Submitting batches…`;
      case "polling":
        return `${prefix}Processing… ${progress ? `${progress.progress_pct}%` : ""}`;
      case "fetching-links":
        return `${prefix}Fetching links…`;
      case "done":
        return "Done";
      case "error":
        return "Error";
      default:
        return "";
    }
  }

  return (
    <>
      <div className={styles.topbar}>
        <button
          type="button"
          className={styles.button}
          style={{ width: "auto", padding: "6px 14px", background: "transparent", color: "#dc2626", border: "1px solid #fecaca" }}
          onClick={resetSession}
          disabled={isBusy}
        >
          Reset session
        </button>
      </div>
      <div className={styles.page} style={{ paddingTop: 32 }}>
        <div className={styles.card}>
          <header className={styles.header}>
            <span className={styles.kicker}>Comment Export Console</span>
            <h1>Bulk Comment Exporter</h1>
            <p>Paste any number of URLs — they&apos;re split into batches of {BATCH_SIZE}, submitted 2 min apart, then auto-downloaded together as one ZIP when all finish. Keep this tab open.</p>
          </header>

          <label
            htmlFor="csv-upload"
            className={styles.textarea}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              minHeight: 100,
              cursor: isBusy ? "default" : "pointer",
              textAlign: "center",
              color: csvDragOver ? "var(--accent)" : "#948f84",
              borderColor: csvDragOver ? "var(--accent)" : undefined,
              opacity: isBusy ? 0.6 : 1,
              marginBottom: 14,
            }}
            onDragOver={(e) => {
              e.preventDefault();
              if (!isBusy) setCsvDragOver(true);
            }}
            onDragLeave={() => setCsvDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setCsvDragOver(false);
              if (!isBusy && e.dataTransfer.files[0]) handleCsvUpload(e.dataTransfer.files[0]);
            }}
          >
            Click or drop a CSV with a &quot;Permalink&quot; column
          </label>
          <input
            id="csv-upload"
            type="file"
            accept=".csv"
            style={{ display: "none" }}
            disabled={isBusy}
            onChange={(e) => {
              if (e.target.files?.[0]) handleCsvUpload(e.target.files[0]);
              e.target.value = "";
            }}
          />
          {csvError && <div className={styles.error} style={{ marginBottom: 14 }}>{csvError}</div>}

          {csvStats && (
            <>
              <div className={styles.results} style={{ fontSize: 13, marginBottom: 8, paddingTop: 0, borderTop: "none" }}>
                <span className={styles.count}>{csvStats.total} total links</span>
                {" · "}
                <span className={styles.count}>{csvStats.unique} unique</span>
                {" · "}
                <span className={styles.count}>{csvStats.withComments} unique with comments</span>
              </div>

              <label className={styles.checkboxRow} style={{ marginBottom: 14 }}>
                <input
                  type="checkbox"
                  checked={onlyWithComments}
                  disabled={isBusy}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setOnlyWithComments(checked);
                    applyFilters(checked, searchQuery, searchScope);
                  }}
                />
                Only process links with comments ({csvStats.withComments} of {csvStats.unique})
              </label>

              <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                <input
                  className={styles.input}
                  style={{ flex: 1 }}
                  placeholder="Search title / description…"
                  value={searchQuery}
                  disabled={isBusy}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") applyFilters(onlyWithComments, searchQuery, searchScope);
                  }}
                />
                <select
                  className={styles.input}
                  style={{ width: 140 }}
                  value={searchScope}
                  disabled={isBusy}
                  onChange={(e) => setSearchScope(e.target.value as SearchScope)}
                >
                  <option value="both">Title + Desc</option>
                  <option value="title">Title only</option>
                  <option value="description">Description only</option>
                </select>
                <button
                  type="button"
                  className={styles.button}
                  style={{ width: "auto", padding: "0 18px" }}
                  disabled={isBusy}
                  onClick={() => applyFilters(onlyWithComments, searchQuery, searchScope)}
                >
                  Search
                </button>
              </div>
              {searchQuery && (
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
                  <span className={styles.count} style={{ fontSize: 12 }}>
                    {urls.length} match{urls.length === 1 ? "" : "es"}
                  </span>
                  <button
                    type="button"
                    className={styles.button}
                    style={{ width: "auto", padding: "4px 12px", fontSize: 12, background: "transparent", color: "#6b6860", border: "1px solid var(--line)" }}
                    disabled={isBusy}
                    onClick={() => {
                      setSearchQuery("");
                      applyFilters(onlyWithComments, "", searchScope);
                    }}
                  >
                    Clear search
                  </button>
                </div>
              )}

              <button
                type="button"
                className={styles.button}
                style={{ marginBottom: 18, background: "transparent", color: "var(--foreground)", border: "1px solid var(--line)" }}
                disabled={isBusy}
                onClick={downloadCleanedCsv}
              >
                Download cleaned CSV ({urls.length} rows shown)
              </button>
            </>
          )}

          <details style={{ marginBottom: 14, fontSize: 13, color: "#6b6860" }}>
            <summary style={{ cursor: "pointer", fontWeight: 600 }}>How do I get my token?</summary>

            <p style={{ marginTop: 8, fontWeight: 600 }}>Quick way — drag this to your bookmarks bar:</p>
            <p>
              <a
                ref={bookmarkletRef}
                style={{
                  display: "inline-block",
                  padding: "6px 12px",
                  borderRadius: 6,
                  background: "var(--accent)",
                  color: "#fff",
                  fontWeight: 600,
                  textDecoration: "none",
                }}
                onClick={(e) => e.preventDefault()}
              >
                📌 Get EC Token
              </a>
            </p>
            <p>
              Then, while logged in on{" "}
              <a href="https://app.exportcomments.com/user/exports" target="_blank" rel="noreferrer">
                app.exportcomments.com
              </a>
              , click that bookmark — it copies your token straight to your clipboard. Paste it below.
            </p>

            <p style={{ marginTop: 12, fontWeight: 600 }}>Manual way (DevTools):</p>
            <ol style={{ marginTop: 8, paddingLeft: 18, lineHeight: 1.7 }}>
              <li>
                Go to{" "}
                <a href="https://app.exportcomments.com/user/exports" target="_blank" rel="noreferrer">
                  app.exportcomments.com/user/exports
                </a>{" "}
                and make sure you&apos;re logged in.
              </li>
              <li>Open DevTools (Cmd+Option+I on Mac, F12 on Windows), click the Network tab.</li>
              <li>Refresh the page — this page calls the <code>/me</code> endpoint on load, which is the easiest request to find.</li>
              <li>Click the <code>me</code> request in the list (filter by typing &quot;me&quot; if needed).</li>
              <li>Open Headers → Request Headers → find <code>Authorization: Bearer eyJ...</code></li>
              <li>Copy everything after &quot;Bearer &quot; and paste it below.</li>
            </ol>
            <p style={{ marginTop: 8 }}>
              Tokens expire after ~24h, so you&apos;ll need to redo this daily. Once a token checks out valid, it&apos;s
              saved in this browser so you won&apos;t need to paste it again next time.
            </p>
          </details>

          <label className={styles.label}>
            Bearer token
            <input
              className={styles.input}
              type="password"
              placeholder="eyJ0eXAiOiJKV1QiLCJhbGciOiJSUzI1NiJ9..."
              value={token}
              onChange={(e) => {
                setToken(e.target.value);
                setTokenCheck("idle");
              }}
              disabled={isBusy}
            />
          </label>
          <button
            type="button"
            className={styles.button}
            style={{ marginBottom: 18 }}
            onClick={checkToken}
            disabled={isBusy || tokenCheck === "checking" || !token.trim()}
          >
            {tokenCheck === "checking" ? "Checking…" : "Check token"}
          </button>
          {tokenCheck === "valid" && <div className={styles.results} style={{ color: "#16a34a", marginTop: -10, marginBottom: 14, fontSize: 13 }}>✓ {tokenCheckMsg}</div>}
          {tokenCheck === "invalid" && <div className={styles.error} style={{ marginTop: -10, marginBottom: 14 }}>{tokenCheckMsg}</div>}

          <label className={styles.label}>
            <span className={styles.labelRow}>
              URLs (one per line)
              <span className={styles.count}>
                {urls.length} URL{urls.length === 1 ? "" : "s"}
                {batches.length > 1 ? ` · ${batches.length} batches` : ""}
              </span>
            </span>
            <textarea
              className={styles.textarea}
              placeholder={"https://www.facebook.com/reel/...\nhttps://www.instagram.com/p/..."}
              value={urlsRaw}
              onChange={(e) => {
                setUrlsRaw(e.target.value);
                if (csvRows.length > 0) setUrlsManuallyEdited(true);
              }}
              disabled={isBusy}
            />
          </label>

          <label className={styles.checkboxRow}>
            <input type="checkbox" checked={replies} onChange={(e) => setReplies(e.target.checked)} disabled={isBusy} />
            Include replies
          </label>

          <button className={styles.button} onClick={run} disabled={isBusy}>
            {isBusy ? statusLabel() : "Submit"}
          </button>

          {isBusy && (
            <button
              type="button"
              className={styles.button}
              style={{ marginTop: 10, background: "transparent", color: "#9a4319", border: "1px solid var(--line)" }}
              onClick={cancelRun}
              disabled={cancelling}
            >
              {cancelling ? "Cancelling…" : "Cancel"}
            </button>
          )}

          {savedBatchIds.length > 0 && !isBusy && (
            <button
              type="button"
              className={styles.button}
              style={{ marginTop: 10, background: "transparent", color: "var(--accent)", border: "1px solid var(--line)" }}
              onClick={downloadSavedExports}
              disabled={recovering}
            >
              {recovering
                ? "Fetching your exports…"
                : `Download completed exports (${savedBatchIds.length} batch${savedBatchIds.length === 1 ? "" : "es"})`}
            </button>
          )}

          {status === "polling" && progress && (
            <div className={styles.progressBarTrack}>
              <div className={styles.progressBarFill} style={{ width: `${progress.progress_pct}%` }} />
            </div>
          )}

          {errorMsg && <div className={styles.error}>{errorMsg}</div>}

          {liveExports.length > 0 && (
            <div className={styles.results}>
              <h2>Processing batch {batchIndex}/{batchCount}</h2>
              {liveExports.map((e, i) => (
                <div key={`${e.url}-${i}`} className={styles.resultRow}>
                  <div className={styles.resultUrl}>{e.url}</div>
                  <span className={styles[`liveStatus_${e.status}`] ?? styles.liveStatus}>
                    {e.status === "done"
                      ? `✓ ${e.totalExported} comment${e.totalExported === 1 ? "" : "s"}`
                      : e.status}
                  </span>
                </div>
              ))}
            </div>
          )}

          {results.length > 0 && (
            <div className={styles.results}>
              <h2>
                Results ({results.filter((r) => r.status === "done").length}/{results.length} succeeded)
              </h2>
              <button
                type="button"
                className={styles.button}
                style={{ marginBottom: 16 }}
                onClick={() => downloadAllAsZip()}
                disabled={zipping || results.filter((r) => r.status === "done" && r.downloadUrl).length === 0}
              >
                {zipping
                  ? `Zipping ${zipProgress.done}/${zipProgress.total}${zipProgress.failed ? ` (${zipProgress.failed} failed)` : ""}…`
                  : `Download all ${results.filter((r) => r.status === "done" && r.downloadUrl).length} as ZIP`}
              </button>
              {results.map((r, i) => (
                <div key={`${r.url}-${i}`} className={styles.resultRow}>
                  <div className={styles.resultUrl}>{r.url}</div>
                  {r.status === "done" && r.downloadUrl ? (
                    <a className={styles.downloadLink} href={r.downloadUrl} target="_blank" rel="noreferrer">
                      ↓ {r.fileName} · {r.totalExported} comment{r.totalExported === 1 ? "" : "s"}
                    </a>
                  ) : (
                    <span className={styles.resultError}>{r.error || "No comments found"}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// Sleeps in 1s steps, bailing out early if cancelRef flips true — so Cancel takes effect within
// ~1s instead of waiting out the full 2min/15s gap.
async function sleepCancelable(ms: number, cancelRef: { current: boolean }) {
  const step = 1000;
  for (let waited = 0; waited < ms; waited += step) {
    if (cancelRef.current) return;
    await sleep(Math.min(step, ms - waited));
  }
}
