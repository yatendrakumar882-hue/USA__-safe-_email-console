'use client';

import React, { useState, useEffect } from 'react';

export default function SecureMailConsole() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [loginPassword, setLoginPassword] = useState('');
  const [showAppPassword, setShowAppPassword] = useState(false);

  // Form Data with separate individual columns
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
  const [statusText, setStatusText] = useState('System ready. Dynamic variation engine active.');

  useEffect(() => {
    const savedAuth = localStorage.getItem('smc_auth');
    if (savedAuth === 'true') {
      setIsAuthenticated(true);
    }
  }, []);

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (loginPassword.length > 0) {
      localStorage.setItem('smc_auth', 'true');
      setIsAuthenticated(true);
    }
  };

  const handleDoubleClickLogout = () => {
    localStorage.removeItem('smc_auth');
    setIsAuthenticated(false);
  };

  const recipientList = formData.recipients
    .split(/[\n,]+/)
    .map((r) => r.trim())
    .filter(Boolean);

  // Spintax parser: {Hello|Hi|Greetings} me se random choice select karta hai
  const resolveSpintax = (text: string) => {
    const spintaxRegex = /\{([^{}]+)\}/g;
    let resolved = text;
    while (spintaxRegex.test(resolved)) {
      resolved = resolved.replace(spintaxRegex, (_, match) => {
        const choices = match.split('|');
        return choices[Math.floor(Math.random() * choices.length)];
      });
    }
    return resolved;
  };

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

  // Har client ko ALAG content banane wala engine
  const generateUniqueBody = (rawBody: string, recipient: string, index: number) => {
    const name = recipient.split('@')[0].replace(/[._-]/g, ' ');
    const formattedName = name.charAt(0).toUpperCase() + name.slice(1);

    // Dynamic tags personalize
    let personalized = rawBody
      .replace(/\[name\]/gi, formattedName)
      .replace(/\[email\]/gi, recipient);

    // User ne spintax diya ho toh random pick karega
    personalized = resolveSpintax(personalized);

    return sanitizeTextPreservingLines(personalized);
  };

  // Har client ke subject ko slightly unique banana taaki spam grouping na ho
  const generateUniqueSubject = (rawSubject: string, recipient: string) => {
    const name = recipient.split('@')[0].replace(/[._-]/g, ' ');
    const formattedName = name.charAt(0).toUpperCase() + name.slice(1);

    let subject = rawSubject
      .replace(/\[name\]/gi, formattedName)
      .replace(/\[email\]/gi, recipient);

    subject = resolveSpintax(subject);
    return subject.trim();
  };

  // FAST ENGINE: 1 BURST = 5 EMAILS (Har email 100% unique format me jayegi)
  const handleSendEmails = async () => {
    if (recipientList.length === 0 || isSending) return;
    if (!formData.subject.trim() || !formData.body.trim()) {
      alert('Kripya Subject aur Message Body bharein!');
      return;
    }
    if (!formData.email.trim() || !formData.appPassword.trim()) {
      alert('Gmail aur App Password bharein!');
      return;
    }

    setIsSending(true);
    let totalSent = 0;
    let totalFailed = 0;

    setStatus({ total: recipientList.length, sent: 0, failed: 0, remaining: recipientList.length });

    const BATCH_SIZE = 5; // 5 Emails in parallel
    const INTER_BATCH_PAUSE = 750;

    for (let i = 0; i < recipientList.length; i += BATCH_SIZE) {
      const batch = recipientList.slice(i, i + BATCH_SIZE);
      const batchNumber = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(recipientList.length / BATCH_SIZE);

      setStatusText(`Sending Burst ${batchNumber}/${totalBatches} (Unique Templates Generated)...`);

      const batchResults = await Promise.all(
        batch.map(async (toEmail, batchIdx) => {
          const globalIndex = i + batchIdx;
          const uniqueBody = generateUniqueBody(formData.body, toEmail, globalIndex);
          const uniqueSubject = generateUniqueSubject(formData.subject, toEmail);

          try {
            const res = await fetch('/api/send-email', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                senderName: formData.senderName,
                email: formData.email,
                appPassword: formData.appPassword,
                subject: uniqueSubject,
                body: uniqueBody,
                to: toEmail,
              }),
            });

            const data = await res.json();
            return data.success ? 'SENT' : 'FAILED';
          } catch {
            return 'FAILED';
          }
        })
      );

      const sentInBatch = batchResults.filter((r) => r === 'SENT').length;
      const failedInBatch = batchResults.filter((r) => r === 'FAILED').length;

      totalSent += sentInBatch;
      totalFailed += failedInBatch;

      setStatus({
        total: recipientList.length,
        sent: totalSent,
        failed: totalFailed,
        remaining: recipientList.length - (totalSent + totalFailed),
      });

      if (i + BATCH_SIZE < recipientList.length) {
        await new Promise((resolve) => setTimeout(resolve, INTER_BATCH_PAUSE));
      }
    }

    setStatusText(`Completed! Delivered: ${totalSent}, Failed: ${totalFailed}`);
    setIsSending(false);
  };

  if (!isAuthenticated) {
    return (
      <div style={{
        minHeight: '100vh',
        background: '#0d1124',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'system-ui, -apple-system, sans-serif'
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

  return (
    <div style={{
      minHeight: '100vh',
      background: '#f8fafc',
      padding: '30px 40px',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      color: '#1e293b'
    }}>
      <div style={{ maxWidth: '1100px', margin: '0 auto' }}>
        
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <h1 style={{ fontSize: '20px', fontWeight: 'bold', color: '#2563eb', margin: 0 }}>Secure Mail Console</h1>
            <span style={{ fontSize: '11px', background: '#dcfce7', color: '#15803d', padding: '3px 8px', borderRadius: '12px', fontWeight: 600 }}>
              🛡️ Unique Variations Active
            </span>
          </div>
          
          <button
            onDoubleClick={handleDoubleClickLogout}
            title="Double click to logout"
            style={{ background: 'none', border: 'none', color: '#ef4444', fontSize: '13px', cursor: 'pointer', fontWeight: 600 }}
          >
            Logout (Double Click)
          </button>
        </div>

        {/* 2 Column Layout */}
        <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: '24px', alignItems: 'start' }}>
          
          {/* Left Column: Compose with exact separate inputs */}
          <div style={{ background: '#fff', borderRadius: '12px', padding: '24px', border: '1px solid #e2e8f0', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
            <div style={{ fontSize: '14px', fontWeight: 'bold', color: '#1e293b', marginBottom: '16px' }}>Compose Clean Email</div>

            {/* Row 1: Sender Name & Your Gmail */}
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

            {/* Row 2: App Password (Separate with Eye Toggle) & Subject */}
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
                  placeholder="e.g. {Quick question|Hello} regarding site"
                  value={formData.subject}
                  onChange={(e) => setFormData({ ...formData, subject: e.target.value })}
                  style={{ width: '100%', boxSizing: 'border-box', border: '1px solid #cbd5e1', borderRadius: '6px', padding: '9px 12px', fontSize: '13px' }}
                />
              </div>
            </div>

            {/* Row 3: Message Body */}
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                <label style={{ fontSize: '12px', color: '#64748b' }}>
                  Message Body <span style={{ color: '#94a3b8' }}>(Preserves 4 lines. Supports [name] & [email])</span>
                </label>
                <span style={{ fontSize: '11px', color: '#2563eb' }}>Tip: Use {'{Hi|Hello}'} for unique text</span>
              </div>
              <textarea
                rows={12}
                placeholder="Type clean message body here...&#10;&#10;Optional: Use {Hi|Hello} [name] to randomize greetings for each client."
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
              <p style={{ fontSize: '11px', color: '#94a3b8', margin: '0 0 10px 0' }}>Paste emails (comma separated or new lines)</p>
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
                {isSending ? 'Delivering Unique Variations...' : 'Send All (Unique Templates)'}
              </button>
            </div>

          </div>

        </div>

      </div>
    </div>
  );
}
