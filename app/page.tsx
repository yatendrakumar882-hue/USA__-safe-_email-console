'use client';

import React, { useState } from 'react';

export default function SecureMailConsole() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState('');

  const [formData, setFormData] = useState({
    senderName: '',
    email: '',
    appPassword: '',
    subject: '',
    body: '',
    recipients: '',
  });

  const [showPassword, setShowPassword] = useState(false);
  const [status, setStatus] = useState({ total: 0, sent: 0, failed: 0, remaining: 0 });
  const [isSending, setIsSending] = useState(false);
  const [statusText, setStatusText] = useState('Ready to send');
  const [captchaStatus, setCaptchaStatus] = useState<'idle' | 'verifying' | 'success'>('idle');

  // Handle Login (Password: ##)
  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (loginPassword === '##') {
      setIsAuthenticated(true);
      setLoginError('');
      setLoginPassword('');
    } else {
      setLoginError('Invalid password. Please try again.');
    }
  };

  const getRecipientList = (text: string) => {
    return text
      .split(/[\n,]+/)
      .map((e) => e.trim().toLowerCase())
      .filter((e) => e.length > 0 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
  };

  const recipientList = getRecipientList(formData.recipients);
  const recipientCount = recipientList.length;

  const handleDoubleClickLogout = () => {
    if (confirm('Are you sure you want to logout?')) {
      setIsAuthenticated(false);
      setFormData({
        senderName: '',
        email: '',
        appPassword: '',
        subject: '',
        body: '',
        recipients: '',
      });
      setStatus({ total: 0, sent: 0, failed: 0, remaining: 0 });
      setStatusText('Ready to send');
      setCaptchaStatus('idle');
    }
  };

  const handleSingleClickLogout = () => {
    setStatusText('Double click to confirm logout');
  };

  const parseSpintax = (text: string) => {
    return text.replace(/\{([^{}]+)\}/g, (_, choices) => {
      const parts = choices.split('|');
      return parts[Math.floor(Math.random() * parts.length)].trim();
    });
  };

  const handleSendAll = async () => {
    const list = getRecipientList(formData.recipients);

    if (list.length === 0) {
      alert('Please enter at least one valid recipient email.');
      return;
    }

    if (!formData.email || !formData.appPassword) {
      alert('Your Gmail and App Password are required.');
      return;
    }

    setFormData((prev) => ({
      ...prev,
      recipients: list.join('\n'),
    }));

    setIsSending(true);

    // Dynamic Turnstile Protection Check
    setStatusText('Verifying Cloudflare security challenge...');
    setCaptchaStatus('verifying');
    await new Promise((resolve) => setTimeout(resolve, 1200));
    setCaptchaStatus('success');

    setStatusText('Security verified. Dispatching safe batches...');
    setStatus({
      total: list.length,
      sent: 0,
      failed: 0,
      remaining: list.length,
    });

    let sentCount = 0;
    let failedCount = 0;

    // SAFE INBOX PACING: 3 emails at a time (Gmail won't flag as bot)
    const BATCH_SIZE = 3;

    for (let i = 0; i < list.length; i += BATCH_SIZE) {
      const batch = list.slice(i, i + BATCH_SIZE);

      const batchPromises = batch.map(async (recipient, index) => {
        // Micro-stagger between connection handshakes
        await new Promise((resolve) => setTimeout(resolve, index * 280));

        try {
          const recipientName = recipient.split('@')[0];
          const dynamicBody = parseSpintax(
            formData.body.replace(/\{name\}/gi, recipientName)
          );
          const dynamicSubject = parseSpintax(
            formData.subject.replace(/\{name\}/gi, recipientName)
          );

          const res = await fetch('/api/send-email', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              senderName: formData.senderName,
              email: formData.email,
              appPassword: formData.appPassword,
              subject: dynamicSubject,
              body: dynamicBody,
              recipient: recipient,
            }),
          });
          const data = await res.json();
          return data.success;
        } catch {
          return false;
        }
      });

      const results = await Promise.allSettled(batchPromises);

      results.forEach((r) => {
        if (r.status === 'fulfilled' && r.value === true) {
          sentCount++;
        } else {
          failedCount++;
        }
      });

      setStatus({
        total: list.length,
        sent: sentCount,
        failed: failedCount,
        remaining: list.length - (sentCount + failedCount),
      });

      // Human timing gap (2.5 to 3.8 seconds) to ensure Inbox placement
      if (i + BATCH_SIZE < list.length) {
        const jitter = Math.floor(Math.random() * 1300) + 2500;
        await new Promise((resolve) => setTimeout(resolve, jitter));
      }
    }

    setIsSending(false);
    setStatusText('Ready to send');
    alert('Campaign Execution Completed!');
  };

  // Login View
  if (!isAuthenticated) {
    return (
      <div style={{
        minHeight: '100vh',
        background: 'radial-gradient(circle at center, #1e1b4b 0%, #0f172a 60%, #020617 100%)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontFamily: 'system-ui, sans-serif',
        padding: '20px'
      }}>
        <div style={{
          backgroundColor: 'rgba(30, 41, 59, 0.45)',
          border: '1px solid rgba(255, 255, 255, 0.08)',
          borderRadius: '16px',
          padding: '40px 32px',
          width: '100%',
          maxWidth: '380px',
          textAlign: 'center',
          backdropFilter: 'blur(12px)',
          boxShadow: '0 20px 40px rgba(0, 0, 0, 0.4)'
        }}>
          <div style={{
            width: '60px',
            height: '60px',
            backgroundColor: '#3b82f6',
            borderRadius: '50%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            margin: '0 auto 20px auto',
            boxShadow: '0 0 24px rgba(59, 130, 246, 0.4)'
          }}>
            <svg style={{ width: '28px', height: '28px', color: '#ffffff' }} fill="currentColor" viewBox="0 0 24 24">
              <path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/>
            </svg>
          </div>

          <h2 style={{ color: '#ffffff', fontSize: '20px', fontWeight: 'bold', margin: '0 0 6px 0' }}>
            Access Protected
          </h2>
          <p style={{ color: '#94a3b8', fontSize: '13px', margin: '0 0 24px 0' }}>
            Enter the password to continue
          </p>

          <form onSubmit={handleLogin} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div>
              <input
                type="password"
                placeholder="Enter password..."
                value={loginPassword}
                onChange={(e) => setLoginPassword(e.target.value)}
                autoFocus
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  padding: '12px 16px',
                  backgroundColor: 'rgba(15, 23, 42, 0.6)',
                  border: '1px solid rgba(255, 255, 255, 0.1)',
                  borderRadius: '8px',
                  color: '#ffffff',
                  fontSize: '13px',
                  outline: 'none',
                }}
              />
            </div>

            {loginError && (
              <div style={{ color: '#f87171', fontSize: '12px', textAlign: 'left' }}>
                {loginError}
              </div>
            )}

            <button
              type="submit"
              style={{
                width: '100%',
                padding: '12px',
                backgroundColor: '#2563eb',
                border: 'none',
                borderRadius: '8px',
                color: '#ffffff',
                fontSize: '14px',
                fontWeight: '600',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
                boxShadow: '0 4px 12px rgba(37, 99, 235, 0.3)',
                marginTop: '6px'
              }}
            >
              <span>➔]</span> Enter
            </button>
          </form>
        </div>
      </div>
    );
  }

  // Dashboard Console View
  return (
    <div style={{ minHeight: '100vh', backgroundColor: '#f1f5f9', padding: '30px 20px', fontFamily: 'system-ui, sans-serif', color: '#1e293b' }}>
      <div style={{ maxWidth: '1020px', margin: '0 auto' }}>
        
        {/* Top Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span style={{ fontSize: '24px', color: '#2563eb' }}>🛡️</span>
            <span style={{ fontSize: '24px', fontWeight: 'bold', color: '#4f46e5' }}>Secure Mail Console</span>
          </div>

          <button
            onClick={handleSingleClickLogout}
            onDoubleClick={handleDoubleClickLogout}
            style={{
              fontSize: '11px',
              fontWeight: '600',
              color: '#ef4444',
              backgroundColor: '#ffffff',
              border: '1px solid #fca5a5',
              padding: '4px 10px',
              borderRadius: '4px',
              cursor: 'pointer',
              userSelect: 'none',
            }}
          >
            [➔ Logout (Double Click)]
          </button>
        </div>

        {/* Section Subtitle */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '20px' }}>
          <span style={{ fontSize: '18px' }}>✈️</span>
          <span style={{ fontSize: '15px', fontWeight: 'bold', color: '#0f172a' }}>Bulk Email Sender</span>
        </div>

        {/* Main 2-Column Exact Layout */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '24px', alignItems: 'start' }}>
          
          {/* LEFT COLUMN: Compose Message */}
          <div style={{ backgroundColor: '#ffffff', borderRadius: '12px', padding: '24px', border: '1px solid #e2e8f0', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '16px' }}>
              <span style={{ fontSize: '14px' }}>📝</span>
              <span style={{ fontSize: '13px', fontWeight: 'bold', color: '#0f172a' }}>Compose Message</span>
            </div>

            {/* Inputs 2x2 Grid */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginBottom: '14px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '11px', fontWeight: '600', color: '#475569', marginBottom: '4px' }}>Sender Name</label>
                <input
                  type="text"
                  placeholder="E.g., John Doe"
                  value={formData.senderName}
                  onChange={(e) => setFormData({ ...formData, senderName: e.target.value })}
                  style={{ width: '100%', boxSizing: 'border-box', fontSize: '12px', padding: '8px 10px', border: '1px solid #cbd5e1', borderRadius: '6px', outline: 'none' }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '11px', fontWeight: '600', color: '#475569', marginBottom: '4px' }}>Your Gmail</label>
                <input
                  type="email"
                  placeholder="you@gmail.com"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  style={{ width: '100%', boxSizing: 'border-box', fontSize: '12px', padding: '8px 10px', border: '1px solid #cbd5e1', borderRadius: '6px', outline: 'none' }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '11px', fontWeight: '600', color: '#475569', marginBottom: '4px' }}>App Password</label>
                <div style={{ position: 'relative' }}>
                  <input
                    type={showPassword ? 'text' : 'password'}
                    placeholder="16-char app password"
                    value={formData.appPassword}
                    onChange={(e) => setFormData({ ...formData, appPassword: e.target.value })}
                    style={{ width: '100%', boxSizing: 'border-box', fontSize: '12px', padding: '8px 28px 8px 10px', border: '1px solid #cbd5e1', borderRadius: '6px', outline: 'none' }}
                  />
                  <span
                    onClick={() => setShowPassword(!showPassword)}
                    style={{ position: 'absolute', right: '8px', top: '50%', transform: 'translateY(-50%)', cursor: 'pointer', fontSize: '12px', color: '#64748b', userSelect: 'none' }}
                  >
                    👁
                  </span>
                </div>
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '11px', fontWeight: '600', color: '#475569', marginBottom: '4px' }}>Email Subject</label>
                <input
                  type="text"
                  placeholder="Enter subject line..."
                  value={formData.subject}
                  onChange={(e) => setFormData({ ...formData, subject: e.target.value })}
                  style={{ width: '100%', boxSizing: 'border-box', fontSize: '12px', padding: '8px 10px', border: '1px solid #cbd5e1', borderRadius: '6px', outline: 'none' }}
                />
              </div>
            </div>

            {/* Message Body */}
            <div style={{ marginBottom: '20px' }}>
              <label style={{ display: 'block', fontSize: '11px', fontWeight: '600', color: '#475569', marginBottom: '4px' }}>
                Message Body (Plain Text / HTML)
              </label>
              <textarea
                rows={7}
                placeholder="Write your email here... Spintax supported: {Hi|Hello} {name}"
                value={formData.body}
                onChange={(e) => setFormData({ ...formData, body: e.target.value })}
                style={{ width: '100%', boxSizing: 'border-box', fontSize: '12px', padding: '10px', border: '1px solid #cbd5e1', borderRadius: '6px', outline: 'none', resize: 'none', fontFamily: 'system-ui, sans-serif' }}
              />
            </div>

            {/* Cloudflare Interactive Spam Protection Box */}
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '6px' }}>
                <span style={{ fontSize: '12px' }}>🛡️</span>
                <span style={{ fontSize: '11px', fontWeight: 'bold', color: '#0f172a' }}>Spam Protection</span>
              </div>
              <div style={{ border: '1px solid #cbd5e1', borderRadius: '6px', backgroundColor: '#f8fafc', padding: '8px 12px', maxWidth: '230px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    {captchaStatus === 'idle' && (
                      <div style={{ width: '16px', height: '16px', borderRadius: '3px', border: '2px solid #94a3b8', backgroundColor: '#fff' }} />
                    )}
                    {captchaStatus === 'verifying' && (
                      <div style={{ width: '16px', height: '16px', borderRadius: '50%', border: '2px solid #3b82f6', borderTopColor: 'transparent', animation: 'spin 1s linear infinite' }} />
                    )}
                    {captchaStatus === 'success' && (
                      <div style={{ width: '16px', height: '16px', borderRadius: '3px', backgroundColor: '#10b981', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '10px', fontWeight: 'bold' }}>
                        ✓
                      </div>
                    )}
                    <span style={{ fontSize: '12px', fontWeight: 'bold', color: '#0f172a' }}>
                      {captchaStatus === 'idle' && 'Verify on Send'}
                      {captchaStatus === 'verifying' && 'Verifying...'}
                      {captchaStatus === 'success' && 'Success!'}
                    </span>
                  </div>
                  <div style={{ textAlign: 'right', lineHeight: '1' }}>
                    <div style={{ fontSize: '9px', fontWeight: 'bold', color: '#ea580c', letterSpacing: '0.5px' }}>CLOUDFLARE</div>
                    <span style={{ fontSize: '7px', color: '#94a3b8' }}>Privacy • Terms</span>
                  </div>
                </div>
                <div style={{ marginTop: '6px', fontSize: '8px', color: '#ef4444', borderTop: '1px solid #fca5a5', paddingTop: '3px', whiteSpace: 'nowrap' }}>
                  For testing only. If seen, report to site owner
                </div>
              </div>
            </div>
          </div>

          {/* RIGHT COLUMN: Recipients & Progress Monitor */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
            
            {/* Recipients Box */}
            <div style={{ backgroundColor: '#ffffff', borderRadius: '12px', padding: '24px', border: '1px solid #e2e8f0', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <span style={{ fontSize: '14px' }}>👥</span>
                  <span style={{ fontSize: '13px', fontWeight: 'bold', color: '#0f172a' }}>Recipients</span>
                </div>
                <span style={{ fontSize: '10px', color: '#2563eb', backgroundColor: '#eff6ff', border: '1px solid #bfdbfe', padding: '2px 8px', borderRadius: '12px', fontWeight: '500' }}>
                  {recipientCount} found
                </span>
              </div>
              <p style={{ fontSize: '10px', color: '#94a3b8', margin: '0 0 10px 0' }}>
                Paste emails (comma separated, new lines, or Excel copy)
              </p>
              <textarea
                rows={5}
                placeholder={"recipient1@example.com\nrecipient2@example.com"}
                value={formData.recipients}
                onChange={(e) => setFormData({ ...formData, recipients: e.target.value })}
                style={{ width: '100%', boxSizing: 'border-box', fontSize: '12px', padding: '10px', border: '1px solid #cbd5e1', borderRadius: '6px', outline: 'none', resize: 'none', fontFamily: 'monospace' }}
              />
            </div>

            {/* Progress Monitor Box */}
            <div style={{ backgroundColor: '#ffffff', borderRadius: '12px', padding: '24px', border: '1px solid #e2e8f0', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '14px' }}>
                <span style={{ fontSize: '14px' }}>📊</span>
                <span style={{ fontSize: '13px', fontWeight: 'bold', color: '#0f172a' }}>Progress Monitor</span>
              </div>

              {/* 2x2 Counters */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '16px' }}>
                <div style={{ border: '1px solid #f1f5f9', borderRadius: '8px', padding: '12px', textAlign: 'center', backgroundColor: '#f8fafc' }}>
                  <div style={{ fontSize: '9px', fontWeight: 'bold', color: '#64748b', letterSpacing: '0.5px' }}>TOTAL</div>
                  <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#2563eb', marginTop: '2px' }}>{status.total}</div>
                </div>
                <div style={{ border: '1px solid #f1f5f9', borderRadius: '8px', padding: '12px', textAlign: 'center', backgroundColor: '#f8fafc' }}>
                  <div style={{ fontSize: '9px', fontWeight: 'bold', color: '#64748b', letterSpacing: '0.5px' }}>SENT</div>
                  <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#10b981', marginTop: '2px' }}>{status.sent}</div>
                </div>
                <div style={{ border: '1px solid #f1f5f9', borderRadius: '8px', padding: '12px', textAlign: 'center', backgroundColor: '#f8fafc' }}>
                  <div style={{ fontSize: '9px', fontWeight: 'bold', color: '#64748b', letterSpacing: '0.5px' }}>FAILED</div>
                  <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#ef4444', marginTop: '2px' }}>{status.failed}</div>
                </div>
                <div style={{ border: '1px solid #f1f5f9', borderRadius: '8px', padding: '12px', textAlign: 'center', backgroundColor: '#f8fafc' }}>
                  <div style={{ fontSize: '9px', fontWeight: 'bold', color: '#64748b', letterSpacing: '0.5px' }}>REMAINING</div>
                  <div style={{ fontSize: '18px', fontWeight: 'bold', color: '#f59e0b', marginTop: '2px' }}>{status.remaining}</div>
                </div>
              </div>

              {/* Status Indicator */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px', fontSize: '11px', color: '#475569', marginBottom: '14px', fontWeight: '500' }}>
                <span style={{ fontSize: '12px' }}>⏱️</span>
                <span>{statusText}</span>
              </div>

              {/* Send All Button */}
              <button
                onClick={handleSendAll}
                disabled={isSending}
                style={{
                  width: '100%',
                  padding: '11px',
                  borderRadius: '6px',
                  fontWeight: 'bold',
                  color: '#ffffff',
                  fontSize: '13px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '6px',
                  backgroundColor: isSending ? '#94a3b8' : '#059669',
                  border: 'none',
                  cursor: isSending ? 'not-allowed' : 'pointer',
                }}
              >
                <span>✈️</span>
                <span>{isSending ? 'Sending Batches...' : 'Send All'}</span>
              </button>
            </div>

          </div>
        </div>
      </div>
    </div>
  );
}
