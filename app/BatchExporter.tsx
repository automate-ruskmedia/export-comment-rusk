"use client";

import { useState, useRef, useEffect } from "react";
import { downloadZip } from "client-zip";
import Swal from "sweetalert2";
import styles from "./BatchExporter.module.css";
import { parseCSV, csvField } from "./csvUtils";

const BATCH_SIZE = 25;
const ZIP_CONCURRENCY = 6;
const TOKEN_STORAGE_KEY = "bulkExporter.token";
const URLS_STORAGE_KEY = "bulkExporter.urlsRaw";
const REPLIES_STORAGE_KEY = "bulkExporter.replies";
const RESULTS_STORAGE_KEY = "bulkExporter.results";

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

  // Fire-and-forget: submit every batch to ExportComments spaced 5s apart, then stop. The jobs
  // run in the background on their servers — no client-side polling to babysit or time out. Grab
  // the finished files from your ExportComments dashboard once they're done.
  async function run() {
    setErrorMsg("");
    setResults([]);
    setProgress(null);
    setLiveExports([]);
    cancelRef.current = false;

    if (!token.trim()) return setErrorMsg("Paste your bearer token first.");
    if (urls.length === 0) return setErrorMsg("Add at least one URL.");

    const authHeader = token.trim().startsWith("Bearer ") ? token.trim() : `Bearer ${token.trim()}`;
    setBatchCount(batches.length);

    const check = await validateToken(authHeader);
    if (!check.ok) return setErrorMsg(`Token check failed: ${check.message}`);

    setStatus("submitting");
    for (let i = 0; i < batches.length; i++) {
      if (cancelRef.current) return setStatus("idle");
      setBatchIndex(i + 1);
      try {
        const res = await fetch("/api/batch-export", {
          method: "POST",
          headers: { Authorization: authHeader, "Content-Type": "application/json" },
          body: JSON.stringify({ urls: batches[i], options: { replies } }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Submit failed (${res.status})`);
        if (i === 0) window.open("https://app.exportcomments.com/user/exports", "_blank", "noopener");
      } catch (e: any) {
        setStatus("error");
        setErrorMsg(`Batch ${i + 1}/${batches.length} submit failed: ${e.message}`);
        return;
      }
      if (i < batches.length - 1) await sleep(5000);
    }

    setStatus("done");
    Swal.fire({
      icon: "success",
      title: `Submitted ${batches.length} batch${batches.length > 1 ? "es" : ""}`,
      text: "They're processing in the background on ExportComments. Grab the finished files from your ExportComments dashboard once they're ready.",
    });
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

  async function downloadAllAsZip() {
    const downloadable = results.filter((r) => r.status === "done" && r.downloadUrl);
    if (downloadable.length === 0) return;

    setZipping(true);
    setZipProgress({ done: 0, total: downloadable.length, failed: 0 });

    const zipResponse = downloadZip(streamFiles(downloadable));
    const fileName = `comment_exports_${new Date().toISOString().slice(0, 10)}.zip`;

    // File System Access API streams straight to disk (near-constant memory). Chrome/Edge only —
    // Safari/Firefox fall back to buffering the finished zip as one Blob, still one copy instead
    // of the old approach's every-file-blob-plus-archive double buffering.
    if ("showSaveFilePicker" in window) {
      try {
        const handle = await (window as any).showSaveFilePicker({ suggestedName: fileName });
        const writable = await handle.createWritable();
        await zipResponse.body!.pipeTo(writable);
        setZipping(false);
        return;
      } catch (e: any) {
        if (e?.name === "AbortError") {
          setZipping(false);
          return;
        }
        // fall through to blob download on any other failure
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
            <h1>Bulk Comment Exporter</h1>
            <p>Paste any number of URLs — they&apos;re split into batches of {BATCH_SIZE} and processed one at a time.</p>
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
              color: csvDragOver ? "#6366f1" : "#737373",
              borderColor: csvDragOver ? "#6366f1" : undefined,
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
                <button
                  type="button"
                  className={styles.button}
                  style={{ width: "auto", padding: "4px 12px", fontSize: 12, marginBottom: 14, background: "transparent", color: "#525252", border: "1px solid #d4d4d4" }}
                  disabled={isBusy}
                  onClick={() => {
                    setSearchQuery("");
                    applyFilters(onlyWithComments, "", searchScope);
                  }}
                >
                  Clear search
                </button>
              )}

              <button
                type="button"
                className={styles.button}
                style={{ marginBottom: 18, background: "transparent", color: "#171717", border: "1px solid #d4d4d4" }}
                disabled={isBusy}
                onClick={downloadCleanedCsv}
              >
                Download cleaned CSV ({urls.length} rows shown)
              </button>
            </>
          )}

          <details style={{ marginBottom: 14, fontSize: 13, color: "#525252" }}>
            <summary style={{ cursor: "pointer", fontWeight: 600 }}>How do I get my token?</summary>
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
              onChange={(e) => setUrlsRaw(e.target.value)}
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
                onClick={downloadAllAsZip}
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
