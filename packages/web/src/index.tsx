import React, { useMemo, useRef, useState, useEffect, type ChangeEvent, type DragEvent } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  decryptFilename,
  encodeRetrievalCode,
  decodeRetrievalCode,
  isValidRetrievalCode,
} from '@voidshare/shared';
import {
  downloadFile,
  uploadFile,
  resolveTransfer,
  type DownloadProgress,
  type UploadProgress,
  type UploadResult,
  type TransferPreview,
} from './transfer.js';
import { GradientBars } from '@/components/ui/GradientBars';
import './styles.css';

type AppMode = 'home' | 'send' | 'download';
type SendStep = 'select' | 'configure' | 'review' | 'uploading' | 'result';
type DownloadStep = 'input' | 'ready' | 'busy' | 'done' | 'error';

const MAX_FILE_SIZE_BYTES = 200 * 1024 * 1024; // 200 MB

const EXPIRATION_OPTIONS = [
  { label: '1 Hour', seconds: 3600, desc: 'Quick ephemeral transfer' },
  { label: '6 Hours', seconds: 21600, desc: 'Single workday' },
  { label: '12 Hours', seconds: 43200, desc: 'Half day' },
  { label: '24 Hours', seconds: 86400, desc: 'Recommended (1 day)' },
  { label: '48 Hours', seconds: 172800, desc: 'Maximum allowed duration' },
];

const DOWNLOAD_LIMIT_OPTIONS = [
  { label: '1 download', value: 1, desc: 'Self-destructs after first access' },
  { label: '5 downloads', value: 5, desc: 'Small group or team access' },
  { label: '10 downloads', value: 10, desc: 'Project workgroup' },
  { label: '25 downloads', value: 25, desc: 'Team distribution' },
  { label: '100 downloads', value: 100, desc: 'Extended access' },
];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatRelativeTime(seconds: number): string {
  if (seconds < 3600) return `${Math.round(seconds / 60)} minutes`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)} hours`;
  return `${Math.round(seconds / 86400)} days`;
}

function formatDateTime(isoString: string): string {
  try {
    const date = new Date(isoString);
    return date.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  } catch {
    return isoString;
  }
}

function parseLinkInput(input: string): { fileId: string; secret: string } | null {
  const trimmed = input.trim();
  const urlMatch = trimmed.match(/\/download\/([a-f0-9]{32})(?:#([a-f0-9]{64}))?$/i);
  if (urlMatch && urlMatch[1] && urlMatch[2]) {
    return { fileId: urlMatch[1], secret: urlMatch[2] };
  }

  const directMatch = trimmed.match(/^([a-f0-9]{32})#([a-f0-9]{64})$/i);
  if (directMatch && directMatch[1] && directMatch[2]) {
    return { fileId: directMatch[1], secret: directMatch[2] };
  }

  return null;
}

function fileIdFromPath(): string | null {
  const match = window.location.pathname.match(/^\/download\/([a-f0-9]{32})$/i);
  return match?.[1] ?? null;
}

function App() {
  const pathFileId = fileIdFromPath();
  const [mode, setMode] = useState<AppMode>(pathFileId ? 'download' : 'home');

  return (
    <Shell onGoHome={() => setMode('home')}>
      {mode === 'home' && (
        <HomeLanding
          onSelectSend={() => setMode('send')}
          onSelectDownload={() => setMode('download')}
        />
      )}
      {mode === 'send' && <SendFlow onBackToHome={() => setMode('home')} />}
      {mode === 'download' && (
        <DownloadFlow
          initialFileId={pathFileId}
          onBackToHome={() => {
            if (window.location.pathname !== '/') {
              window.history.pushState({}, '', '/');
            }
            setMode('home');
          }}
        />
      )}
    </Shell>
  );
}

function BrandLogo() {
  return (
    <div className="brand-badge" aria-hidden="true">
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <path
          d="M3.5 4.5L12 20.5L20.5 4.5"
          stroke="var(--text-primary)"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <path
          d="M7.5 4.5L12 13.5L16.5 4.5"
          stroke="var(--accent-lime)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="12" cy="13.5" r="1.5" fill="var(--accent-lime)" />
      </svg>
    </div>
  );
}

function Shell({ children, onGoHome }: { children: React.ReactNode; onGoHome: () => void }) {
  return (
    <>
      {/* Background Animated Gradient Bars (React Bits Pro - Midnight Precision) */}
      <div className="gradient-bars-bg" aria-hidden="true">
        <GradientBars
          barCount={14}
          gradientPower={0.85}
          balance={0.15}
          speed={0.9}
          phaseSpread={1.8}
          mirrorRepeat={2.0}
          alternateDirection={1.0}
          invertSpeed={0.15}
          phaseRange={2.0}
          curvePower={1.6}
          color="#d8dce6"
          backgroundColor="#08090a"
          opacity={0.55}
          vertical
        />
        <div className="bg-vignette" />
      </div>

      <main className="shell">
        <header className="topbar">
          <a
            className="brand"
            href="/"
            onClick={(e) => {
              e.preventDefault();
              onGoHome();
            }}
            aria-label="VoidShare home"
          >
            <BrandLogo />
            <span className="brand-title">
              void<span className="brand-title-muted">share</span>
            </span>
          </a>
        </header>

        {children}

        <footer className="footer">
          <div className="footer-content">
            <span>The master key stays exclusively in the URL fragment (#secret). Storage nodes retain zero keys.</span>
            <span>Max lifetime: 48h · Max size: 200MB</span>
          </div>
        </footer>
      </main>
    </>
  );
}

// 1. HOME LANDING: Precision developer aesthetic
function HomeLanding({
  onSelectSend,
  onSelectDownload,
}: {
  onSelectSend: () => void;
  onSelectDownload: () => void;
}) {
  return (
    <section className="wizard-container">
      <div className="landing-hero">
        <p className="kicker">
          <span className="pulse" />
          Client-Side Encrypted Transfers
        </p>
        <h1 className="landing-title">
          Share files.<br />Without the noise.
        </h1>
        <p className="landing-subtitle">
          In-browser WebCrypto AES-256-GCM encryption with atomic lease tracking and automatic 48-hour self-destruction.
        </p>
      </div>

      <div className="intent-grid">
        {/* SENDER — Send a File */}
        <div
          className="intent-card"
          role="button"
          tabIndex={0}
          onClick={onSelectSend}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onSelectSend()}
        >
          <div className="intent-icon-wrapper">
            <span className="intent-icon">↑</span>
          </div>
          <div className="intent-content">
            <h2 className="intent-title">Send a File</h2>
            <p className="intent-desc">
              Choose a file, configure access parameters, and generate a secure sharing link.
            </p>
            <ul className="intent-highlights">
              <li>Up to 200 MB per transfer</li>
              <li>Download limits from 1 to 100</li>
              <li>Auto-expiration up to 48 hours</li>
              <li>Local AES-256-GCM encryption</li>
            </ul>
          </div>
          <button className="intent-button primary" onClick={onSelectSend}>
            Send a File
          </button>
        </div>

        {/* RECEIVER — Download a File */}
        <div
          className="intent-card"
          role="button"
          tabIndex={0}
          onClick={onSelectDownload}
          onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onSelectDownload()}
        >
          <div className="intent-icon-wrapper download">
            <span className="intent-icon">↓</span>
          </div>
          <div className="intent-content">
            <h2 className="intent-title">Download a File</h2>
            <p className="intent-desc">
              Enter a sharing link you received to access and decrypt the file.
            </p>
            <ul className="intent-highlights">
              <li>Direct storage node streaming</li>
              <li>In-memory client decryption</li>
              <li>Integrity verified via SHA-256</li>
              <li>No account or installation</li>
            </ul>
          </div>
          <button className="intent-button secondary" onClick={onSelectDownload}>
            Download a File
          </button>
        </div>
      </div>

      <div className="trust-features">
        <div className="trust-item">
          <strong>AES-256-GCM Cipher</strong>
          <span>Payloads are encrypted in chunks with unique IVs before network transmission.</span>
        </div>
        <div className="trust-item">
          <strong>48-Hour Purge Window</strong>
          <span>All transfer ciphertext is purged from storage nodes within 48 hours.</span>
        </div>
        <div className="trust-item">
          <strong>URL Fragment Key</strong>
          <span>The master key lives in #secret and is never transmitted to the coordinator.</span>
        </div>
      </div>
    </section>
  );
}

// 2. SENDER FLOW
function SendFlow({ onBackToHome }: { onBackToHome: () => void }) {
  const [step, setStep] = useState<SendStep>('select');
  const [file, setFile] = useState<File | null>(null);
  const [downloadLimit, setDownloadLimit] = useState<number>(1);
  const [ttlSeconds, setTtlSeconds] = useState<number>(86400); // 24h default
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  const [uploadResult, setUploadResult] = useState<UploadResult | null>(null);
  const [error, setError] = useState<{ title: string; message: string; hint?: string } | null>(null);

  const abortControllerRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const handleFileSelect = (selectedFile?: File) => {
    setError(null);
    if (!selectedFile) return;

    if (selectedFile.size > MAX_FILE_SIZE_BYTES) {
      setError({
        title: 'File Exceeds Limit',
        message: `The selected file (${formatBytes(selectedFile.size)}) exceeds the maximum allowed size of 200 MB.`,
        hint: 'Please choose a smaller file or compress it before sending.',
      });
      return;
    }

    if (selectedFile.size === 0) {
      setError({
        title: 'Empty File',
        message: 'The selected file contains 0 bytes.',
        hint: 'Please choose a valid file that contains data.',
      });
      return;
    }

    setFile(selectedFile);
  };

  const onFileInputChange = (event: ChangeEvent<HTMLInputElement>) => {
    handleFileSelect(event.target.files?.[0]);
  };

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setDragging(false);
    handleFileSelect(event.dataTransfer.files[0]);
  };

  const executeUpload = async () => {
    if (!file) return;

    setStep('uploading');
    setError(null);
    const controller = new AbortController();
    abortControllerRef.current = controller;

    try {
      const result = await uploadFile(file, {
        ttlSeconds,
        maxDownloads: downloadLimit,
        signal: controller.signal,
        onProgress: (progress) => {
          setUploadProgress(progress);
        },
      });

      setUploadResult(result);
      setStep('result');
    } catch (cause: any) {
      if (cause?.name === 'AbortError' || cause?.message?.includes('aborted')) {
        setStep('review');
        return;
      }

      setError({
        title: 'Send Failed',
        message: cause instanceof Error ? cause.message : 'Unable to complete the encrypted transfer.',
        hint: 'Your file never left your browser unencrypted. Check your connection and try again.',
      });
      setStep('review');
    } finally {
      abortControllerRef.current = null;
    }
  };

  const cancelUpload = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setStep('review');
  };

  const resetAll = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setStep('select');
    setFile(null);
    setDownloadLimit(1);
    setTtlSeconds(86400);
    setUploadProgress(null);
    setUploadResult(null);
    setError(null);
  };

  return (
    <section className="wizard-container">
      {/* Header & Stepper */}
      <div className="wizard-header">
        <div className="wizard-breadcrumbs">
          <button className="breadcrumb-link" onClick={onBackToHome}>
            Home
          </button>
          <span className="breadcrumb-sep">/</span>
          <span className="breadcrumb-current">Send a File</span>
        </div>

        <div className="step-stepper">
          <div className={`step-node ${step === 'select' ? 'active' : file ? 'completed' : ''}`}>
            <span className="step-number">1</span>
            <span className="step-label">Select File</span>
          </div>
          <div className="step-line" />
          <div className={`step-node ${step === 'configure' ? 'active' : step === 'review' || step === 'uploading' || step === 'result' ? 'completed' : ''}`}>
            <span className="step-number">2</span>
            <span className="step-label">Configure</span>
          </div>
          <div className="step-line" />
          <div className={`step-node ${step === 'review' ? 'active' : step === 'uploading' || step === 'result' ? 'completed' : ''}`}>
            <span className="step-number">3</span>
            <span className="step-label">Review</span>
          </div>
          <div className="step-line" />
          <div className={`step-node ${step === 'result' ? 'active' : ''}`}>
            <span className="step-number">4</span>
            <span className="step-label">Share Link</span>
          </div>
        </div>
      </div>

      {/* Error Alert */}
      {error && (
        <div className="alert-card error" role="alert">
          <div className="alert-header">
            <strong>{error.title}</strong>
          </div>
          <p className="alert-message">{error.message}</p>
          {error.hint && <p className="alert-hint">💡 {error.hint}</p>}
        </div>
      )}

      {/* STEP 1: SELECT FILE */}
      {step === 'select' && (
        <div className="wizard-card">
          <div className="wizard-card-header">
            <h2>Select File</h2>
            <p className="muted">
              Choose a file up to 200 MB. Encryption and chunking begin after confirmation.
            </p>
          </div>

          {!file ? (
            <div
              className={`dropzone ${dragging ? 'is-dragging' : ''}`}
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && fileInputRef.current?.click()}
            >
              <input ref={fileInputRef} type="file" onChange={onFileInputChange} hidden />
              <span className="drop-icon">＋</span>
              <strong>Drop a file here or browse</strong>
              <span>Supports any file format up to 200 MB</span>
              <span className="dropzone-badge">AES-256-GCM · Client Encrypted</span>
            </div>
          ) : (
            <div className="selected-file-panel">
              <div className="file-info-box">
                <div className="file-icon">📄</div>
                <div className="file-details">
                  <h3 className="file-name">{file.name}</h3>
                  <div className="file-meta">
                    <span>{formatBytes(file.size)}</span>
                    <span>·</span>
                    <span>{file.type || 'Binary'}</span>
                    <span>·</span>
                    <span className="file-status-tag">Ready</span>
                  </div>
                </div>
                <button
                  className="file-remove-button"
                  onClick={() => setFile(null)}
                  title="Remove or choose another file"
                >
                  Change
                </button>
              </div>
            </div>
          )}

          <div className="wizard-actions">
            <button className="btn-secondary" onClick={onBackToHome}>
              Cancel
            </button>
            <button
              className="btn-primary"
              disabled={!file}
              onClick={() => setStep('configure')}
            >
              Continue
            </button>
          </div>
        </div>
      )}

      {/* STEP 2: CONFIGURE SHARING */}
      {step === 'configure' && file && (
        <div className="wizard-card">
          <div className="wizard-card-header">
            <h2>Configure Access & Expiration</h2>
            <p className="muted">
              Specify download limits and the link self-destruction timeline.
            </p>
          </div>

          <div className="file-context-pill">
            <span>Payload:</span>
            <strong>{file.name}</strong>
            <span className="pill-size">({formatBytes(file.size)})</span>
          </div>

          <div className="config-sections">
            {/* Download Limit */}
            <div className="config-block">
              <div className="config-label-group">
                <label className="config-title">Download Limit</label>
                <span className="config-desc">
                  Atomic lease quota before the file is purged from storage nodes.
                </span>
              </div>
              <div className="options-grid">
                {DOWNLOAD_LIMIT_OPTIONS.map((opt) => (
                  <div
                    key={opt.value}
                    className={`option-card ${downloadLimit === opt.value ? 'selected' : ''}`}
                    onClick={() => setDownloadLimit(opt.value)}
                  >
                    <div className="option-radio">
                      <span className={`radio-dot ${downloadLimit === opt.value ? 'checked' : ''}`} />
                    </div>
                    <div className="option-info">
                      <strong className="option-label">{opt.label}</strong>
                      <span className="option-sub">{opt.desc}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Expiration (Max 48h) */}
            <div className="config-block">
              <div className="config-label-group">
                <label className="config-title">Link Expiration (Max 48 Hours)</label>
                <span className="config-desc">
                  Hard expiration window. The maximum allowed lifetime is 48 hours.
                </span>
              </div>
              <div className="options-grid">
                {EXPIRATION_OPTIONS.map((opt) => (
                  <div
                    key={opt.seconds}
                    className={`option-card ${ttlSeconds === opt.seconds ? 'selected' : ''}`}
                    onClick={() => setTtlSeconds(opt.seconds)}
                  >
                    <div className="option-radio">
                      <span className={`radio-dot ${ttlSeconds === opt.seconds ? 'checked' : ''}`} />
                    </div>
                    <div className="option-info">
                      <strong className="option-label">{opt.label}</strong>
                      <span className="option-sub">{opt.desc}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="wizard-actions">
            <button className="btn-secondary" onClick={() => setStep('select')}>
              Back
            </button>
            <button className="btn-primary" onClick={() => setStep('review')}>
              Review Settings
            </button>
          </div>
        </div>
      )}

      {/* STEP 3: REVIEW */}
      {step === 'review' && file && (
        <div className="wizard-card">
          <div className="wizard-card-header">
            <h2>Review Transfer Settings</h2>
            <p className="muted">
              Confirm parameters before generating the local key and encrypting chunks.
            </p>
          </div>

          <div className="review-table">
            <div className="review-row">
              <span className="review-label">File</span>
              <div className="review-value">
                <strong>{file.name}</strong>
                <span className="muted"> ({formatBytes(file.size)})</span>
              </div>
            </div>

            <div className="review-row">
              <span className="review-label">Download Quota</span>
              <div className="review-value">
                <strong>
                  {downloadLimit === 1
                    ? '1 Download (Atomic single-use)'
                    : `${downloadLimit} Downloads`}
                </strong>
              </div>
            </div>

            <div className="review-row">
              <span className="review-label">Expiration Window</span>
              <div className="review-value">
                <strong>{formatRelativeTime(ttlSeconds)}</strong>
                <span className="muted"> (48h max security limit)</span>
              </div>
            </div>

            <div className="review-row">
              <span className="review-label">Cipher Unit</span>
              <div className="review-value">
                <span className="tag-crypto">AES-256-GCM · 4 MiB Chunks</span>
              </div>
            </div>
          </div>

          <div className="security-notice">
            <span className="security-icon">🛡️</span>
            <p>
              Your browser will generate a local 256-bit master key via WebCrypto, encrypt the payload into 4 MiB cipher chunks, and distribute them to storage nodes. The secret key stays in the URL fragment.
            </p>
          </div>

          <div className="wizard-actions">
            <button className="btn-secondary" onClick={() => setStep('configure')}>
              Back
            </button>
            <button className="btn-primary" onClick={executeUpload}>
              Create Share Link
            </button>
          </div>
        </div>
      )}

      {/* STEP 4: UPLOADING PROGRESS */}
      {step === 'uploading' && file && (
        <div className="wizard-card">
          <div className="wizard-card-header">
            <h2>Creating Share Link...</h2>
            <p className="muted">
              Encrypting payload and distributing ciphertext chunks to storage nodes.
            </p>
          </div>

          <div className="progress-section">
            <div className="progress-bar-container">
              <div
                className="progress-bar-fill"
                style={{ width: `${uploadProgress?.percent ?? 15}%` }}
              />
            </div>
            <div className="progress-meta">
              <span className="progress-percent">{uploadProgress?.percent ?? 15}%</span>
              <span className="progress-message">
                {uploadProgress?.message ?? 'Deriving encryption keys...'}
              </span>
            </div>
          </div>

          <div className="upload-file-summary">
            <span>{file.name}</span>
            <span> · </span>
            <span>{formatBytes(file.size)}</span>
          </div>

          <div className="wizard-actions center">
            <button className="btn-secondary cancel" onClick={cancelUpload}>
              Cancel Transfer
            </button>
          </div>
        </div>
      )}

      {/* STEP 5: SHARE LINK RESULT */}
      {step === 'result' && uploadResult && (
        <div className="wizard-card result">
          <SendResultCard
            result={uploadResult}
            onSendAnother={resetAll}
            onBackToHome={onBackToHome}
          />
        </div>
      )}
    </section>
  );
}

function SendResultCard({
  result,
  onSendAnother,
  onBackToHome,
}: {
  result: UploadResult;
  onSendAnother: () => void;
  onBackToHome: () => void;
}) {
  const [copiedLink, setCopiedLink] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);

  const shareLink = useMemo(
    () => `${window.location.origin}/download/${result.fileId}#${result.secret}`,
    [result],
  );

  const retrievalCode = useMemo(
    () => result.retrievalCode || encodeRetrievalCode(result.secret),
    [result],
  );

  const copyLink = async () => {
    await navigator.clipboard.writeText(shareLink);
    setCopiedLink(true);
    window.setTimeout(() => setCopiedLink(false), 2000);
  };

  const copyCode = async () => {
    await navigator.clipboard.writeText(retrievalCode);
    setCopiedCode(true);
    window.setTimeout(() => setCopiedCode(false), 2000);
  };

  const handleNativeShare = async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: `VoidShare: ${result.fileName}`,
          text: `Download encrypted file: ${result.fileName}\nRetrieval Code: ${retrievalCode}`,
          url: shareLink,
        });
      } catch {
        // User dismissed share sheet
      }
    } else {
      copyLink();
    }
  };

  return (
    <div className="success-container">
      <div className="success-badge">
        <span className="success-check">✓</span>
        <div>
          <p className="kicker">Transfer Active</p>
          <h2 className="success-heading">Transfer Ready to Share</h2>
        </div>
      </div>

      <p className="success-desc">
        Recipients can access and decrypt this file using either the <strong>Share Link</strong> or the <strong>Retrieval Code</strong> below. The encryption key is held locally and was never sent to the coordinator.
      </p>

      {/* Credentials Stack */}
      <div className="credentials-group">
        {/* Share Link */}
        <div className="credential-card">
          <div className="credential-header">
            <span className="credential-label">🔗 Share Link</span>
            <span className="credential-hint">Browser link with embedded #secret key</span>
          </div>
          <div className="share-link-box">
            <div className="share-link-text">
              <span className="link-base">{shareLink.replace(/#.*$/, '')}</span>
              <span className="link-secret">#secret</span>
            </div>
            <button className={`btn-copy ${copiedLink ? 'copied' : ''}`} onClick={copyLink}>
              {copiedLink ? 'Copied' : 'Copy Link'}
            </button>
          </div>
        </div>

        {/* Retrieval Code */}
        <div className="credential-card">
          <div className="credential-header">
            <span className="credential-label">🔑 Retrieval Code</span>
            <span className="credential-hint">43-character capability for direct code entry</span>
          </div>
          <div className="share-link-box">
            <div className="share-link-text retrieval-code-text">
              <code>{retrievalCode}</code>
            </div>
            <button className={`btn-copy ${copiedCode ? 'copied' : ''}`} onClick={copyCode}>
              {copiedCode ? 'Copied' : 'Copy Code'}
            </button>
          </div>
        </div>
      </div>

      {/* Metadata */}
      <div className="result-metadata-grid">
        <div className="meta-card">
          <span className="meta-label">File</span>
          <strong className="meta-value">{result.fileName}</strong>
        </div>
        <div className="meta-card">
          <span className="meta-label">Size</span>
          <strong className="meta-value">{formatBytes(result.fileSizeBytes)}</strong>
        </div>
        <div className="meta-card">
          <span className="meta-label">Quota</span>
          <strong className="meta-value">
            {result.maxDownloads === 1 ? '1 Download' : `${result.maxDownloads} Downloads`}
          </strong>
        </div>
        <div className="meta-card">
          <span className="meta-label">Expires</span>
          <strong className="meta-value">{formatDateTime(result.expiresAt)}</strong>
        </div>
      </div>

      <div className="result-actions">
        {typeof navigator !== 'undefined' && 'share' in navigator && (
          <button className="btn-secondary" onClick={handleNativeShare}>
            Share Link ↗
          </button>
        )}
        <button className="btn-secondary" onClick={onBackToHome}>
          Home
        </button>
        <button className="btn-primary" onClick={onSendAnother}>
          Send Another File
        </button>
      </div>
    </div>
  );
}

// 3. RECEIVER FLOW: Download a File
function DownloadFlow({
  initialFileId,
  onBackToHome,
}: {
  initialFileId: string | null;
  onBackToHome: () => void;
}) {
  const initialSecret = typeof window !== 'undefined' ? window.location.hash.slice(1) : '';
  const [entryTab, setEntryTab] = useState<'link' | 'code'>('link');
  const [linkInput, setLinkInput] = useState<string>(
    initialFileId && initialSecret ? `${window.location.origin}/download/${initialFileId}#${initialSecret}` : '',
  );
  const [codeInput, setCodeInput] = useState<string>('');

  const [activeFileId, setActiveFileId] = useState<string | null>(initialFileId);
  const [activeSecret, setActiveSecret] = useState<string>(initialSecret);
  const [previewMeta, setPreviewMeta] = useState<TransferPreview | null>(null);
  const [step, setStep] = useState<DownloadStep>(initialFileId && initialSecret ? 'ready' : 'input');
  const [resolving, setResolving] = useState<boolean>(false);
  
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [downloadedFileName, setDownloadedFileName] = useState<string>('');
  const [errorDetails, setErrorDetails] = useState<{ title: string; message: string; hint?: string } | null>(null);

  // Automatically resolve preview if loaded with direct URL
  useEffect(() => {
    if (initialFileId && initialSecret) {
      setResolving(true);
      resolveTransfer(initialSecret, initialFileId)
        .then((preview) => {
          setActiveFileId(preview.fileId);
          setActiveSecret(initialSecret);
          setPreviewMeta(preview);
          setStep('ready');
        })
        .catch((err) => {
          setErrorDetails({
            title: 'Transfer Unavailable',
            message: err instanceof Error ? err.message : 'Unable to access transfer',
            hint: 'The transfer link may have expired or reached its download limit.',
          });
          setStep('input');
        })
        .finally(() => setResolving(false));
    }
  }, [initialFileId, initialSecret]);

  // Handle Share Link submission
  const handleAccessLink = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setErrorDetails(null);

    const trimmed = linkInput.trim();
    // Auto-detect if user entered a 43-character retrieval code in the link input
    if (isValidRetrievalCode(trimmed)) {
      setEntryTab('code');
      setCodeInput(trimmed);
      return executeCodeResolution(trimmed);
    }

    const parsed = parseLinkInput(trimmed);
    if (!parsed) {
      setErrorDetails({
        title: 'Invalid Sharing Link',
        message: 'The link format is unrecognized or missing its #secret decryption key.',
        hint: 'Please paste the full sharing link (e.g. http://.../download/id#secret) or switch to the Retrieval Code tab.',
      });
      return;
    }

    setResolving(true);
    try {
      const preview = await resolveTransfer(parsed.secret, parsed.fileId);
      setActiveFileId(parsed.fileId);
      setActiveSecret(parsed.secret);
      setPreviewMeta(preview);
      setStep('ready');
    } catch (cause: any) {
      setErrorDetails({
        title: 'Transfer Unavailable',
        message: cause instanceof Error ? cause.message : 'Unable to access transfer.',
        hint: 'Please confirm the link has not expired and download limits remain.',
      });
    } finally {
      setResolving(false);
    }
  };

  // Helper for code resolution
  const executeCodeResolution = async (code: string) => {
    if (!isValidRetrievalCode(code)) {
      setErrorDetails({
        title: 'Invalid Retrieval Code',
        message: 'The retrieval code must be exactly 43 URL-safe Base64 characters.',
        hint: 'Check that you copied the complete code without extra spaces or symbols.',
      });
      return;
    }

    setResolving(true);
    try {
      const hexSecret = decodeRetrievalCode(code);
      const preview = await resolveTransfer(hexSecret);
      setActiveFileId(preview.fileId);
      setActiveSecret(hexSecret);
      setPreviewMeta(preview);
      setStep('ready');
    } catch (cause: any) {
      setErrorDetails({
        title: 'Transfer Unavailable',
        message: cause instanceof Error ? cause.message : 'Unable to resolve transfer from retrieval code.',
        hint: 'The transfer may have expired, reached its download limit, or the code is incorrect.',
      });
    } finally {
      setResolving(false);
    }
  };

  // Handle Retrieval Code submission
  const handleAccessCode = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setErrorDetails(null);

    const trimmed = codeInput.trim();
    // Auto-detect if user pasted a link into the code tab
    const parsed = parseLinkInput(trimmed);
    if (parsed) {
      setEntryTab('link');
      setLinkInput(trimmed);
      return handleAccessLink();
    }

    await executeCodeResolution(trimmed);
  };

  const startDownload = async () => {
    if (!activeFileId || !activeSecret) {
      setErrorDetails({
        title: 'Missing Parameters',
        message: 'A valid file ID and decryption key are required.',
        hint: 'Please re-enter your sharing link or retrieval code.',
      });
      setStep('input');
      return;
    }

    setStep('busy');
    setErrorDetails(null);

    try {
      const result = await downloadFile(activeFileId, activeSecret, {
        onProgress: (p) => setProgress(p),
      });

      const name = result.encryptedFileName
        ? await decryptFilename(result.encryptedFileName, activeSecret)
        : previewMeta?.fileName || 'voidshare-download';

      setDownloadedFileName(name);

      const blob = new Blob([result.bytes as unknown as BlobPart]);
      const anchor = document.createElement('a');
      anchor.href = URL.createObjectURL(blob);
      anchor.download = name;
      anchor.click();
      URL.revokeObjectURL(anchor.href);

      setStep('done');
    } catch (cause: any) {
      setStep('error');
      const msg = cause instanceof Error ? cause.message : 'The download could not be completed.';
      
      let hint = 'Contact the sender if you believe this transfer should still be active.';
      if (msg.includes('expired') || msg.includes('limit')) {
        hint = 'Files are deleted immediately once the download limit is reached or the expiration time passes.';
      } else if (msg.includes('progress')) {
        hint = 'Another download is currently acquiring chunks for this link. Wait a moment and try again.';
      }

      setErrorDetails({
        title: 'Download Unavailable',
        message: msg,
        hint,
      });
    }
  };

  return (
    <section className="wizard-container">
      <div className="wizard-header">
        <div className="wizard-breadcrumbs">
          <button className="breadcrumb-link" onClick={onBackToHome}>
            Home
          </button>
          <span className="breadcrumb-sep">/</span>
          <span className="breadcrumb-current">Download a File</span>
        </div>
      </div>

      {/* Error Alert */}
      {errorDetails && (
        <div className="alert-card error" role="alert">
          <div className="alert-header">
            <strong>{errorDetails.title}</strong>
          </div>
          <p className="alert-message">{errorDetails.message}</p>
          {errorDetails.hint && <p className="alert-hint">💡 {errorDetails.hint}</p>}
        </div>
      )}

      {/* STEP 1: ENTER LINK OR CODE */}
      {step === 'input' && (
        <div className="wizard-card">
          <div className="wizard-card-header">
            <h2>Access Encrypted File</h2>
            <p className="muted">
              Choose your access method: enter a direct sharing link or a 43-character retrieval code.
            </p>
          </div>

          {/* Mode Switcher Tabs */}
          <div className="tab-pill-group">
            <button
              type="button"
              className={`tab-pill ${entryTab === 'link' ? 'active' : ''}`}
              onClick={() => {
                setEntryTab('link');
                setErrorDetails(null);
              }}
            >
              🔗 Share Link
            </button>
            <button
              type="button"
              className={`tab-pill ${entryTab === 'code' ? 'active' : ''}`}
              onClick={() => {
                setEntryTab('code');
                setErrorDetails(null);
              }}
            >
              🔑 Retrieval Code
            </button>
          </div>

          {entryTab === 'link' ? (
            <form onSubmit={handleAccessLink} className="link-entry-form">
              <div className="form-group">
                <label className="config-title">Sharing Link</label>
                <input
                  type="text"
                  className="text-input"
                  placeholder="Paste sharing link (http://.../download/id#secret)"
                  value={linkInput}
                  onChange={(e) => setLinkInput(e.target.value)}
                  autoFocus
                />
                <span className="form-hint">
                  The link must contain the <code>#secret</code> fragment to derive decryption keys.
                </span>
              </div>

              <div className="wizard-actions">
                <button type="button" className="btn-secondary" onClick={onBackToHome}>
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn-primary"
                  disabled={!linkInput.trim() || resolving}
                >
                  {resolving ? 'Verifying Link...' : 'Access File'}
                </button>
              </div>
            </form>
          ) : (
            <form onSubmit={handleAccessCode} className="link-entry-form">
              <div className="form-group">
                <label className="config-title">Retrieval Code</label>
                <input
                  type="text"
                  className="text-input font-mono"
                  placeholder="Paste 43-character retrieval code"
                  value={codeInput}
                  onChange={(e) => setCodeInput(e.target.value)}
                  autoFocus
                />
                <span className="form-hint">
                  Enter the 43-character unpadded Base64url code provided by the sender.
                </span>
              </div>

              <div className="wizard-actions">
                <button type="button" className="btn-secondary" onClick={onBackToHome}>
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn-primary"
                  disabled={!codeInput.trim() || resolving}
                >
                  {resolving ? 'Verifying Code...' : 'Access File'}
                </button>
              </div>
            </form>
          )}
        </div>
      )}

      {/* STEP 2: FILE READY TO DOWNLOAD */}
      {(step === 'ready' || step === 'error') && activeFileId && (
        <div className="wizard-card">
          <div className="wizard-card-header">
            <h2>{previewMeta ? previewMeta.fileName : 'Encrypted File Ready'}</h2>
            <p className="muted">
              {previewMeta
                ? `${formatBytes(previewMeta.fileSizeBytes)} · Verified locally with 256-bit AES-GCM`
                : 'Ciphertext chunks will stream from storage nodes and decrypt locally in your browser.'}
            </p>
          </div>

          <div className="review-table">
            <div className="review-row">
              <span className="review-label">File Payload</span>
              <div className="review-value">
                <strong>{previewMeta?.fileName ?? 'Encrypted Payload'}</strong>
                {previewMeta && <span className="muted"> ({formatBytes(previewMeta.fileSizeBytes)})</span>}
              </div>
            </div>

            <div className="review-row">
              <span className="review-label">Transfer ID</span>
              <div className="review-value">
                <code>{activeFileId}</code>
              </div>
            </div>

            {previewMeta && (
              <>
                <div className="review-row">
                  <span className="review-label">Remaining Quota</span>
                  <div className="review-value">
                    <strong>
                      {previewMeta.maxDownloads - previewMeta.downloadCount} of {previewMeta.maxDownloads} downloads left
                    </strong>
                  </div>
                </div>

                <div className="review-row">
                  <span className="review-label">Expires</span>
                  <div className="review-value">
                    <span>{formatDateTime(previewMeta.expiresAt)}</span>
                  </div>
                </div>
              </>
            )}

            <div className="review-row">
              <span className="review-label">Decryption Key</span>
              <div className="review-value">
                <span className="tag-crypto">256-bit Master Key Verified ✓</span>
              </div>
            </div>

            <div className="review-row">
              <span className="review-label">Security Protocol</span>
              <div className="review-value">
                <span>In-Browser WebCrypto AES-256-GCM</span>
              </div>
            </div>
          </div>

          <div className="security-notice">
            <span className="security-icon">🛡️</span>
            <p>
              Click <strong>Download File</strong> to acquire an atomic download lease token, stream the encrypted chunks from storage nodes, verify SHA-256 integrity, and save the decrypted file.
            </p>
          </div>

          <div className="wizard-actions">
            <button
              className="btn-secondary"
              onClick={() => {
                setErrorDetails(null);
                setStep('input');
              }}
            >
              Enter Another Link or Code
            </button>
            <button className="btn-primary" onClick={startDownload}>
              Download File
            </button>
          </div>
        </div>
      )}

      {/* STEP 3: DOWNLOADING & DECRYPTING */}
      {step === 'busy' && (
        <div className="wizard-card">
          <div className="wizard-card-header">
            <h2>Decrypting in Browser...</h2>
            <p className="muted">
              Streaming ciphertext from storage nodes and assembling decrypted payload.
            </p>
          </div>

          <div className="progress-section">
            <div className="progress-bar-container">
              <div
                className="progress-bar-fill"
                style={{ width: `${progress?.percent ?? 25}%` }}
              />
            </div>
            <div className="progress-meta">
              <span className="progress-percent">{progress?.percent ?? 25}%</span>
              <span className="progress-message">
                {progress?.message ?? 'Connecting to storage nodes...'}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* STEP 4: DOWNLOAD COMPLETE */}
      {step === 'done' && (
        <div className="wizard-card result">
          <div className="success-container">
            <div className="success-badge">
              <span className="success-check">✓</span>
              <div>
                <p className="kicker">Complete</p>
                <h2 className="success-heading">File saved to device</h2>
              </div>
            </div>

            <p className="success-desc">
              Your file <strong>"{downloadedFileName}"</strong> has been decrypted in memory and saved to your downloads.
            </p>

            <div className="result-actions">
              <button className="btn-secondary" onClick={onBackToHome}>
                Home
              </button>
              <button
                className="btn-primary"
                onClick={() => {
                  setLinkInput('');
                  setActiveFileId(null);
                  setActiveSecret('');
                  setStep('input');
                }}
              >
                Download Another File
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

export default App;

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('VoidShare root element is missing');
const hotModule = (import.meta as ImportMeta & { hot?: { data: { root?: Root } } }).hot;
const root = hotModule?.data.root ?? createRoot(rootElement);
if (hotModule) hotModule.data.root = root;
root.render(<App />);
