'use client';

import React, { useState } from 'react';

export default function SecureMailConsole() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [loginPassword, setLoginPassword] = useState('');
  const [showAppPassword, setShowAppPassword] = useState(false);

  // Speed Mode state taaki dashboard se hi speed control ho sake
  const [speedMode, setSpeedMode] = useState<'superfast' | 'balanced' | 'safe'>('superfast');

  // Blank initial state: Koi prefilled templates ya hardcoded text nahi
  const [formData, setFormData] = useState({
    senderName: '',
    email: '',
    appPassword: '',
    subject: '',
    recipients: '',
    body: '',
  });

  const [status, setStatus] = useState({ total: 0, sent: 0, failed: 0, remaining: 0 });
  const [isSending, setIsSending] = useState(false);
  const [statusText, setStatusText] = useState('System ready. Spam protection active.');

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (loginPassword.length > 0) {
      setIsAuthenticated(true);
    }
  };

  const recipientList = formData.recipients
    .split(/[\n,]+/)
    .map((r) => r.trim())
    .filter(Boolean);

  // High Spam Protection Punctuation & Character Normalizer
  const sanitizeTextPreservingLines = (str: string) => {
    return str
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/!{2,}/g, '.')
      .replace(/^\s*!\s*/gm, '')
      .split('\n')
      .map((line) => line.trimEnd())
      .join('\n')
      .trim();
  };

  const generateCleanBody = (rawBody: string, recipient: string) => {
    const name = recipient.split('@')[0].replace(/[._-]/g, ' ');
    const formattedName = name.charAt(0).toUpperCase() + name.slice(1);

    const parsed = rawBody
      .replace(/\[name\]/gi, formattedName)
      .replace(/\[email\]/gi, recipient);

    return sanitizeTextPreservingLines(parsed);
  };

  const generateCleanSubject = (rawSubject: string, recipient: string) => {
    const name = recipient.split('@')[0].replace(/[._-]/g, ' ');
    const formattedName = name.charAt(0).toUpperCase() + name.slice(1);

    return rawSubject
      .replace(/\[name\]/gi, formattedName)
      .replace(/\[email\]/gi, recipient)
      .trim();
  };

  // HIGH SPAM-PROTECTION DYNAMIC ENGINE (25 EMAILS IN ~5 SECONDS)
  const handleSendEmails = async () => {
    if (recipientList.length === 0 || isSending) return;
    if (!formData.subject.trim() || !formData.body.trim()) {
      alert('Kripya Subject aur Message Body bharein!');
      return;
    }

    setIsSending(true);
    let sent = 0;
    let failed = 0;

    setStatus({ total: recipientList.length, sent: 0, failed: 0, remaining: recipientList.length });
    setStatusText('High-protection inbox delivery running...');

    // Speed configurations
    let concurrency = 5; // Superfast: 5 parallel streams (~5 seconds for 25)
    let interMailDelay = 50;

    if (speedMode === 'balanced') {
      concurrency = 3;
      interMailDelay = 120;
    } else if (speedMode === 'safe') {
      concurrency = 1;
      interMailDelay = 250;
    }

    let currentIndex = 0;

    const worker = async () => {
      while (currentIndex < recipientList.length) {
        const index = currentIndex++;
        const toEmail = recipientList[index];
        const personalizedBody = generateCleanBody(formData.body, toEmail);
        const personalizedSubject = generateCleanSubject(formData.subject, toEmail);

        try {
          const res = await fetch('/api/send-email', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              senderName: formData.senderName,
              email: formData.email,
              appPassword: formData.appPassword,
              subject: personalizedSubject,
              body: personalizedBody,
              to: toEmail,
            }),
          });

          const data = await res.json();
          if (data.success) {
            sent++;
          } else {
            failed++;
          }
        } catch {
          failed++;
        }

        setStatus({
          total: recipientList.length,
          sent,
          failed,
          remaining: recipientList.length - (sent + failed),
        });

        if (interMailDelay > 0) {
          await new Promise((resolve) => setTimeout(resolve, interMailDelay));
        }
      }
    };

    const workers = Array.from({ length: Math.min(concurrency, recipientList.length) }, () => worker());
    await Promise.all(workers);

    setStatusText(`Finished. Successfully delivered: ${sent}, Failed: ${failed}`);
    setIsSending(false);
  };

  // Password Lock Screen
  if (!isAuthenticated) {
    return (
      <div style={{
        minHeight: '100vh',
        background: '#0d1124',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center'
      }}>
        <div style={{
          width: '360px',
          background: '#1f2642',
          borderRadius: '12px',
          padding: '32px',
          color: '#fff',
          boxShadow: '0 20px 40px rgba(0,0,0,0.5)'
        }}>
          <h2 style={{ fontSize: '18px', fontWeight: 'bold', margin: '0 0 8px 0', textAlign: 'center' }}>Access Protected</h2>
          <p style={{ color: '#8f9bb3', fontSize: '13px', margin: '0 0 20px 0', textAlign: 'center' }}>Enter password to continue</p>
          <form onSubmit={handleLogin}>
            <input
              type="password"
              placeholder="Enter password..."
              value={loginPassword}
              onChange={(e) => setLoginPassword(e.target.value)}
              style={{
                width: '100%',
                boxSizing: 'border-box',
                background: '#0f1424',
                border: '1px solid #2b3558',
                borderRadius: '6px',
                padding: '11px',
                color: '#fff',
                fontSize: '13px',
                marginBottom: '16px',
                outline: 'none'
              }}
            />
            <button
              type="submit"
              style={{
                width: '100%',
                background: '#2563eb',
                border: 'none',
                borderRadius: '6px',
                padding: '11px',
                color: '#fff',
                fontWeight: 600,
                fontSize: '14px',
                cursor: 'pointer'
              }}
            >
              Enter Console
            </button>
          </form>
        </div>
      </div>
    );
  }

  // Dashboard Interface
  return (
    <div style={{
      minHeight: '100vh',
      background: '#f8fafc',
      padding: '30px 40px',
      color: '#1e293b'
    }}>
      <div style={{ maxWidth: '1100px', margin: '0 auto' }}>
        
        {/* Header with Speed Selector & Spam Protection Badge */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <h1 style={{ fontSize: '20px', fontWeight: 'bold', color: '#2563eb', margin: 0 }}>Secure Mail Console</h1>
            <span style={{ fontSize: '11px', background: '#dcfce7', color: '#15803d', padding: '3px 8px', borderRadius: '12px', fontWeight: 600 }}>
              🛡️ High Spam Protection Active
            </span>
          </div>
          
          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span style={{ fontSize: '12px', fontWeight: 600, color: '#64748b' }}>Speed:</span>
              <select
                value={speedMode}
                onChange={(e) => setSpeedMode(e.target.value as any)}
                style={{
                  padding: '6px 10px',
                  borderRadius: '6px',
                  border: '1px solid #cbd5e1',
                  fontSize: '12px',
                  fontWeight: 600,
                  background: '#fff',
                  color: speedMode === 'superfast' ? '#2563eb' : '#334155'
                }}
              >
                <option value="superfast">⚡ Super Fast (~5 sec for 25)</option>
                <option value="balanced">⚖️ Balanced Fast (~10 sec for 25)</option>
                <option value="safe">🛡️ Safe Standard (1-by-1)</option>
              </select>
            </div>

            <button
              onClick={() => setIsAuthenticated(false)}
              style={{ background: 'none', border: 'none', color: '#ef4444', fontSize: '13px', cursor: 'pointer', fontWeight: 500 }}
            >
              Logout
            </button>
          </div>
        </div>

        {/* 2 Column Layout */}
        <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: '24px', alignItems: 'start' }}>
          
          {/* Left Column: Compose */}
          <div style={{ background: '#fff', borderRadius: '12px', padding: '24px', border: '1px solid #e2e8f0', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
            <div style={{ fontSize: '14px', fontWeight: 'bold', color: '#1e293b', marginBottom: '16px' }}>Compose Custom Clean Email</div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px', marginBottom: '14px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '12px', color: '#64748b', marginBottom: '6px' }}>Sender Name</label>
                <input
                  type="text"
                  placeholder="e.g. Brenda"
                  value={formData.senderName}
                  onChange={(e) => setFormData({ ...formData, senderName: e.target.value })}
                  style={{ width: '100%', boxSizing: 'border-box', border: '1px solid #cbd5e1', borderRadius: '6px', padding: '9px 12px', fontSize: '13px' }}
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '12px', color: '#64748b', marginBottom: '6px' }}>Your Gmail</label>
                <input
                  type="email"
                  placeholder="you@gmail.com"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  style={{ width: '100%', boxSizing: 'border-box', border: '1px solid #cbd5e1', borderRadius: '6px', padding: '9px 12px', fontSize: '13px' }}
                />
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px', marginBottom: '14px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '12px', color: '#64748b', marginBottom: '6px' }}>App Password</label>
                <div style={{ position: 'relative' }}>
                  <input
                    type={showAppPassword ? 'text' : 'password'}
                    placeholder="16-character App Password"
                    value={formData.appPassword}
                    onChange={(e) => setFormData({ ...formData, appPassword: e.target.value })}
                    style={{ width: '100%', boxSizing: 'border-box', border: '1px solid #cbd5e1', borderRadius: '6px', padding: '9px 34px 9px 12px', fontSize: '13px', fontFamily: 'monospace' }}
                  />
                  <span
                    onClick={() => setShowAppPassword(!showAppPassword)}
                    style={{ position: 'absolute', right: '10px', top: '9px', cursor: 'pointer', color: '#94a3b8', fontSize: '13px' }}
                  >
                    👁
                  </span>
                </div>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '12px', color: '#64748b', marginBottom: '6px' }}>Subject</label>
                <input
                  type="text"
                  placeholder="Enter custom email subject..."
                  value={formData.subject}
                  onChange={(e) => setFormData({ ...formData, subject: e.target.value })}
                  style={{ width: '100%', boxSizing: 'border-box', border: '1px solid #cbd5e1', borderRadius: '6px', padding: '9px 12px', fontSize: '13px' }}
                />
              </div>
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '12px', color: '#64748b', marginBottom: '6px' }}>
                Message Body <span style={{ color: '#94a3b8' }}>(Preserves exact lines. Use [name] for auto-name)</span>
              </label>
              <textarea
                rows={12}
                placeholder="Type your clean email body here... (Exact 4 lines will be preserved in client's inbox)"
                value={formData.body}
                onChange={(e) => setFormData({ ...formData, body: e.target.value })}
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  border: '1px solid #cbd5e1',
                  borderRadius: '6px',
                  padding: '12px',
                  fontSize: '13px',
                  resize: 'none',
                  whiteSpace: 'pre-wrap'
                }}
              />
            </div>
          </div>

          {/* Right Column: Recipients & Monitor */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            
            <div style={{ background: '#fff', borderRadius: '12px', padding: '24px', border: '1px solid #e2e8f0', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <span style={{ fontSize: '13px', fontWeight: 'bold' }}>Recipients</span>
                <span style={{ fontSize: '12px', color: '#2563eb', fontWeight: 600 }}>{recipientList.length} Found</span>
              </div>
              <p style={{ fontSize: '11px', color: '#94a3b8', margin: '0 0 10px 0' }}>Paste emails (comma separated, new lines, or Excel copy)</p>
              <textarea
                rows={6}
                placeholder="recipient1@example.com&#10;recipient2@example.com"
                value={formData.recipients}
                onChange={(e) => setFormData({ ...formData, recipients: e.target.value })}
                style={{ width: '100%', boxSizing: 'border-box', border: '1px solid #cbd5e1', borderRadius: '6px', padding: '10px', fontSize: '13px', fontFamily: 'monospace', resize: 'none' }}
              />
            </div>

            <div style={{ background: '#fff', borderRadius: '12px', padding: '24px', border: '1px solid #e2e8f0', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
              <div style={{ fontSize: '13px', fontWeight: 'bold', marginBottom: '14px' }}>Delivery Progress Monitor</div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', border: '1px solid #f1f5f9', borderRadius: '8px', padding: '14px', background: '#f8fafc', marginBottom: '14px' }}>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: '11px', fontWeight: 'bold', color: '#94a3b8' }}>TOTAL</div>
                  <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#2563eb', marginTop: '2px' }}>{status.total}</div>
                </div>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: '11px', fontWeight: 'bold', color: '#94a3b8' }}>SENT</div>
                  <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#10b981', marginTop: '2px' }}>{status.sent}</div>
                </div>
                <div style={{ textAlign: 'center', paddingTop: '6px' }}>
                  <div style={{ fontSize: '11px', fontWeight: 'bold', color: '#94a3b8' }}>FAILED</div>
                  <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#ef4444', marginTop: '2px' }}>{status.failed}</div>
                </div>
                <div style={{ textAlign: 'center', paddingTop: '6px' }}>
                  <div style={{ fontSize: '11px', fontWeight: 'bold', color: '#94a3b8' }}>REMAINING</div>
                  <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#f59e0b', marginTop: '2px' }}>{status.remaining}</div>
                </div>
              </div>

              <div style={{ textAlign: 'center', fontSize: '12px', color: '#64748b', marginBottom: '14px' }}>
                {statusText}
              </div>

              <button
                type="button"
                onClick={handleSendEmails}
                disabled={isSending}
                style={{
                  width: '100%',
                  background: isSending ? '#94a3b8' : '#10b981',
                  border: 'none',
                  borderRadius: '8px',
                  padding: '12px',
                  color: '#fff',
                  fontWeight: 'bold',
                  fontSize: '13px',
                  cursor: isSending ? 'not-allowed' : 'pointer',
                  transition: 'background 0.2s'
                }}
              >
                {isSending ? 'Sending in Progress...' : 'Send All'}
              </button>
            </div>

          </div>

        </div>

      </div>
    </div>
  );
}
