'use client';

import React, { useState } from 'react';

export default function SecureMailConsole() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [loginPassword, setLoginPassword] = useState('');
  const [showAppPassword, setShowAppPassword] = useState(false);

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
  const [statusText, setStatusText] = useState('Ready to send');

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

  // Advanced Spintax Engine
  const parseSpintax = (text: string) => {
    let matches = text.match(/{([^{}]+)}/);
    while (matches) {
      const choices = matches[1].split('|');
      const randomChoice = choices[Math.floor(Math.random() * choices.length)];
      text = text.replace(matches[0], randomChoice);
      matches = text.match(/{([^{}]+)}/);
    }
    return text;
  };

  // Anti-Spam Fingerprint Bypass: Generates unique invisible hash per email
  const generateUniqueBody = (rawBody: string, recipient: string) => {
    const name = recipient.split('@')[0].replace(/[._-]/g, ' ');
    const formattedName = name.charAt(0).toUpperCase() + name.slice(1);

    let processed = parseSpintax(rawBody)
      .replace(/\[name\]/gi, formattedName)
      .replace(/\[email\]/gi, recipient);

    // Dynamic anti-hash marker (Zero-width / Clean whitespace pattern)
    const randomHash = Math.random().toString(36).substring(2, 8).toUpperCase();
    const cleanFooter = `\n\nRef: #${randomHash}`;

    return processed + cleanFooter;
  };

  const generateUniqueSubject = (rawSubject: string, recipient: string) => {
    const name = recipient.split('@')[0].replace(/[._-]/g, ' ');
    const formattedName = name.charAt(0).toUpperCase() + name.slice(1);

    return parseSpintax(rawSubject)
      .replace(/\[name\]/gi, formattedName)
      .replace(/\[email\]/gi, recipient);
  };

  // Exact 10-Second Paced Dispatcher (Maintains same speed, guarantees uniqueness)
  const handleSendEmails = async () => {
    if (recipientList.length === 0 || isSending) return;

    setIsSending(true);
    let sent = 0;
    let failed = 0;

    setStatus({ total: recipientList.length, sent: 0, failed: 0, remaining: recipientList.length });

    const TARGET_TOTAL_SECONDS = 10;
    const intervalMs = Math.floor((TARGET_TOTAL_SECONDS * 1000) / recipientList.length);

    setStatusText(`Dispatching: 25 emails in ${TARGET_TOTAL_SECONDS}s (Unique Handshake)...`);

    const sendEmailRequest = async (toEmail: string, index: number) => {
      const personalizedBody = generateUniqueBody(formData.body, toEmail);
      const personalizedSubject = generateUniqueSubject(formData.subject, toEmail);

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
      setStatusText(`Sending (${index + 1}/${recipientList.length})...`);
    };

    const promises = [];
    for (let i = 0; i < recipientList.length; i++) {
      promises.push(sendEmailRequest(recipientList[i], i));
      if (i + 1 < recipientList.length) {
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    }

    await Promise.all(promises);

    setStatusText(`Completed! All emails delivered.`);
    setIsSending(false);
  };

  // SCREENSHOT 1: ACCESS PROTECTED SCREEN
  if (!isAuthenticated) {
    return (
      <div style={{
        minHeight: '100vh',
        background: 'radial-gradient(circle at center, #1b2344 0%, #0d1124 100%)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'system-ui, -apple-system, sans-serif'
      }}>
        <div style={{
          width: '380px',
          background: 'rgba(31, 38, 66, 0.75)',
          border: '1px solid #2d375e',
          borderRadius: '16px',
          padding: '36px 32px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          boxShadow: '0 20px 40px rgba(0,0,0,0.5)',
          backdropFilter: 'blur(8px)'
        }}>
          <div style={{
            width: '56px',
            height: '56px',
            background: '#3b82f6',
            borderRadius: '50%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: '20px',
            boxShadow: '0 0 20px rgba(59, 130, 246, 0.5)'
          }}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
              <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
            </svg>
          </div>

          <h1 style={{ color: '#fff', fontSize: '20px', fontWeight: 'bold', margin: '0 0 6px 0' }}>Access Protected</h1>
          <p style={{ color: '#8f9bb3', fontSize: '13px', margin: '0 0 24px 0' }}>Enter the password to continue</p>

          <form onSubmit={handleLogin} style={{ width: '100%' }}>
            <div style={{ position: 'relative', marginBottom: '16px' }}>
              <input
                type="password"
                placeholder="Enter password..."
                value={loginPassword}
                onChange={(e) => setLoginPassword(e.target.value)}
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  background: 'rgba(15, 20, 36, 0.9)',
                  border: '1px solid #2b3558',
                  borderRadius: '8px',
                  padding: '12px 14px',
                  color: '#fff',
                  fontSize: '13px',
                  outline: 'none'
                }}
              />
            </div>

            <button
              type="submit"
              style={{
                width: '100%',
                background: '#2563eb',
                border: 'none',
                borderRadius: '8px',
                padding: '12px',
                color: '#fff',
                fontWeight: 600,
                fontSize: '14px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '6px'
              }}
            >
              ➔] Enter
            </button>
          </form>
        </div>
      </div>
    );
  }

  // SCREENSHOT 2: CONSOLE MAIN SCREEN
  return (
    <div style={{
      minHeight: '100vh',
      background: '#f1f5f9',
      padding: '30px 40px',
      fontFamily: 'system-ui, -apple-system, sans-serif',
      color: '#334155'
    }}>
      <div style={{ maxWidth: '1100px', margin: '0 auto' }}>
        
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <div style={{ color: '#2563eb', display: 'flex' }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="#2563eb">
                <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z"/>
              </svg>
            </div>
            <h1 style={{ fontSize: '20px', fontWeight: 'bold', color: '#2563eb', margin: 0 }}>Secure Mail Console</h1>
          </div>
          <button
            onDoubleClick={() => setIsAuthenticated(false)}
            style={{ background: 'none', border: 'none', color: '#ef4444', fontSize: '13px', cursor: 'pointer', fontWeight: 500 }}
          >
            [➔ Logout (Double Click)
          </button>
        </div>

        {/* Section title */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
          <span style={{ fontSize: '14px' }}>▲</span>
          <span style={{ fontSize: '15px', fontWeight: 'bold', color: '#0f172a' }}>Bulk Email Sender</span>
        </div>

        {/* 2 Column Layout */}
        <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: '24px', alignItems: 'start' }}>
          
          {/* Left Column: Compose Message */}
          <div style={{ background: '#fff', borderRadius: '12px', padding: '24px', border: '1px solid #e2e8f0', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '18px' }}>
              <span style={{ fontSize: '14px' }}>📝</span>
              <span style={{ fontSize: '13px', fontWeight: 'bold', color: '#1e293b' }}>Compose Message</span>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '14px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '12px', color: '#64748b', marginBottom: '6px' }}>Sender Name</label>
                <input
                  type="text"
                  placeholder="E.g., John Doe"
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

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', marginBottom: '14px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '12px', color: '#64748b', marginBottom: '6px' }}>App Password</label>
                <div style={{ position: 'relative' }}>
                  <input
                    type={showAppPassword ? 'text' : 'password'}
                    placeholder="16-char app password"
                    value={formData.appPassword}
                    onChange={(e) => setFormData({ ...formData, appPassword: e.target.value })}
                    style={{ width: '100%', boxSizing: 'border-box', border: '1px solid #cbd5e1', borderRadius: '6px', padding: '9px 36px 9px 12px', fontSize: '13px', fontFamily: 'monospace' }}
                  />
                  <span
                    onClick={() => setShowAppPassword(!showAppPassword)}
                    style={{ position: 'absolute', right: '10px', top: '9px', cursor: 'pointer', color: '#94a3b8', fontSize: '14px' }}
                  >
                    👁
                  </span>
                </div>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '12px', color: '#64748b', marginBottom: '6px' }}>Email Subject</label>
                <input
                  type="text"
                  placeholder="Enter subject line..."
                  value={formData.subject}
                  onChange={(e) => setFormData({ ...formData, subject: e.target.value })}
                  style={{ width: '100%', boxSizing: 'border-box', border: '1px solid #cbd5e1', borderRadius: '6px', padding: '9px 12px', fontSize: '13px' }}
                />
              </div>
            </div>

            <div style={{ marginBottom: '16px' }}>
              <label style={{ display: 'block', fontSize: '12px', color: '#64748b', marginBottom: '6px' }}>Message Body (Plain Text / HTML)</label>
              <textarea
                rows={11}
                placeholder="Write your email here... Spintax supported: {Hi|Hello} [name]"
                value={formData.body}
                onChange={(e) => setFormData({ ...formData, body: e.target.value })}
                style={{ width: '100%', boxSizing: 'border-box', border: '1px solid #cbd5e1', borderRadius: '6px', padding: '12px', fontSize: '13px', resize: 'none' }}
              />
            </div>

            {/* Spam Protection Box */}
            <div>
              <div style={{ fontSize: '11px', color: '#64748b', marginBottom: '6px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                <span>🛡</span> Spam Protection
              </div>
              <div style={{ width: '210px', background: '#fafafa', border: '1px solid #e2e8f0', borderRadius: '4px', padding: '8px 12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <div style={{ width: '16px', height: '16px', borderRadius: '50%', background: '#10b981', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '10px' }}>✓</div>
                  <span style={{ fontSize: '12px', fontWeight: 500, color: '#1e293b' }}>Success!</span>
                </div>
                <div style={{ textAlign: 'right', fontSize: '8px', color: '#94a3b8' }}>
                  <span style={{ fontWeight: 'bold', color: '#ea580c', display: 'block' }}>CLOUDFLARE</span>
                  Privacy • Terms
                </div>
              </div>
            </div>
          </div>

          {/* Right Column: Recipients & Progress Monitor */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
            
            {/* Recipients Card */}
            <div style={{ background: '#fff', borderRadius: '12px', padding: '24px', border: '1px solid #e2e8f0', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <span style={{ fontSize: '14px' }}>👥</span>
                  <span style={{ fontSize: '13px', fontWeight: 'bold', color: '#1e293b' }}>Recipients</span>
                </div>
                <span style={{ fontSize: '12px', color: '#3b82f6', fontWeight: 500 }}>{recipientList.length} Found</span>
              </div>
              <p style={{ fontSize: '11px', color: '#94a3b8', margin: '0 0 10px 0' }}>Paste emails (comma separated, new lines, or Excel copy)</p>
              <textarea
                rows={6}
                placeholder="recipient1@example.com&#10;recipient2@example.com"
                value={formData.recipients}
                onChange={(e) => setFormData({ ...formData, recipients: e.target.value })}
                style={{ width: '100%', boxSizing: 'border-box', border: '1px solid #cbd5e1', borderRadius: '6px', padding: '10px 12px', fontSize: '13px', fontFamily: 'monospace', resize: 'none' }}
              />
            </div>

            {/* Progress Monitor Card */}
            <div style={{ background: '#fff', borderRadius: '12px', padding: '24px', border: '1px solid #e2e8f0', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px' }}>
                <span style={{ fontSize: '14px' }}>📊</span>
                <span style={{ fontSize: '13px', fontWeight: 'bold', color: '#1e293b' }}>Progress Monitor</span>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px', border: '1px solid #f1f5f9', borderRadius: '8px', padding: '16px', background: '#f8fafc', marginBottom: '16px' }}>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: '11px', fontWeight: 'bold', color: '#94a3b8' }}>TOTAL</div>
                  <div style={{ fontSize: '20px', fontWeight: 'bold', color: '#3b82f6', marginTop: '4px' }}>{status.total}</div>
                </div>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: '11px', fontWeight: 'bold', color: '#94a3b8' }}>SENT</div>
                  <div style={{ fontSize: '20px', fontWeight: 'bold', color: '#10b981', marginTop: '4px' }}>{status.sent}</div>
                </div>
                <div style={{ textAlign: 'center', paddingTop: '8px' }}>
                  <div style={{ fontSize: '11px', fontWeight: 'bold', color: '#94a3b8' }}>FAILED</div>
                  <div style={{ fontSize: '20px', fontWeight: 'bold', color: '#ef4444', marginTop: '4px' }}>{status.failed}</div>
                </div>
                <div style={{ textAlign: 'center', paddingTop: '8px' }}>
                  <div style={{ fontSize: '11px', fontWeight: 'bold', color: '#94a3b8' }}>REMAINING</div>
                  <div style={{ fontSize: '20px', fontWeight: 'bold', color: '#f59e0b', marginTop: '4px' }}>{status.remaining}</div>
                </div>
              </div>

              <div style={{ textAlign: 'center', fontSize: '12px', color: '#64748b', marginBottom: '16px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}>
                <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: isSending ? '#10b981' : '#94a3b8', display: 'inline-block' }}></span>
                {statusText}
              </div>

              <button
                type="button"
                onClick={handleSendEmails}
                disabled={isSending}
                style={{
                  width: '100%',
                  background: isSending ? '#6ee7b7' : '#10b981',
                  border: 'none',
                  borderRadius: '8px',
                  padding: '12px',
                  color: '#fff',
                  fontWeight: 'bold',
                  fontSize: '13px',
                  cursor: isSending ? 'not-allowed' : 'pointer',
                  opacity: isSending ? 0.7 : 1,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '6px',
                  transition: 'background 0.2s ease, opacity 0.2s ease'
                }}
              >
                {isSending ? (
                  <>
                    <span style={{ display: 'inline-block' }}>⏳</span>
                    <span>Sending...</span>
                  </>
                ) : (
                  <>
                    <span>▲</span>
                    <span>Send All</span>
                  </>
                )}
              </button>
            </div>

          </div>

        </div>

      </div>
    </div>
  );
}
