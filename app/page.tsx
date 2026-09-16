'use client';

import React, { useState, useEffect } from 'react';

export default function SecureMailConsole() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [loginPassword, setLoginPassword] = useState('');

  // Senders Pool: Support multiple sender accounts format: email:app_password
  const [senderName, setSenderName] = useState('');
  const [senderPoolText, setSenderPoolText] = useState('');
  const [subject, setSubject] = useState('');
  const [recipients, setRecipients] = useState('');
  const [body, setBody] = useState('');

  const [status, setStatus] = useState({ total: 0, sent: 0, failed: 0, remaining: 0 });
  const [activeAccountInfo, setActiveAccountInfo] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [statusText, setStatusText] = useState('Ready for scale (Auto-Rotates after safe limit)');

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

  // Parse Multi-Account Pool (Format: user@gmail.com:apppassword)
  const parseSenderPool = () => {
    return senderPoolText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [email, appPassword] = line.split(':');
        return {
          email: email?.trim(),
          appPassword: appPassword?.trim()?.replace(/\s+/g, ''),
        };
      })
      .filter((acc) => acc.email && acc.appPassword);
  };

  const recipientList = recipients
    .split(/[\n,]+/)
    .map((r) => r.trim())
    .filter(Boolean);

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

  // 4000+ INBOX ROTATION ENGINE (Safe 35 Mails Per Account)
  const handleSendEmails = async () => {
    const accounts = parseSenderPool();
    if (accounts.length === 0) {
      alert('Kripya kam se kam ek Sender Account (email:apppassword) dalein!');
      return;
    }
    if (recipientList.length === 0 || isSending) return;
    if (!subject.trim() || !body.trim()) {
      alert('Subject aur Message Body enter karein!');
      return;
    }

    setIsSending(true);
    let totalSent = 0;
    let totalFailed = 0;

    setStatus({ total: recipientList.length, sent: 0, failed: 0, remaining: recipientList.length });

    const ROTATE_AFTER_MAILS = 35; // 35 mails ke baad agla account pick karega taaki 40-50 limit cross na ho
    const BATCH_SIZE = 5;
    const INTER_BATCH_PAUSE = 800;

    for (let i = 0; i < recipientList.length; i += BATCH_SIZE) {
      // Pick rotating account
      const accountIndex = Math.floor(i / ROTATE_AFTER_MAILS) % accounts.length;
      const currentSender = accounts[accountIndex];

      setActiveAccountInfo(`Using: ${currentSender.email} (Account #${accountIndex + 1})`);

      const batch = recipientList.slice(i, i + BATCH_SIZE);
      setStatusText(`Delivering batch ${Math.floor(i / BATCH_SIZE) + 1} with ${currentSender.email}...`);

      const batchResults = await Promise.all(
        batch.map(async (toEmail) => {
          const personalizedBody = generateCleanBody(body, toEmail);
          const personalizedSubject = generateCleanSubject(subject, toEmail);

          try {
            const res = await fetch('/api/send-email', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                senderName,
                email: currentSender.email,
                appPassword: currentSender.appPassword,
                subject: personalizedSubject,
                body: personalizedBody,
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

    setStatusText(`Campaign Finished! Total Delivered: ${totalSent}, Failed: ${totalFailed}`);
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
      <div style={{ maxWidth: '1150px', margin: '0 auto' }}>
        
        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <h1 style={{ fontSize: '20px', fontWeight: 'bold', color: '#2563eb', margin: 0 }}>Secure Mail Console</h1>
            <span style={{ fontSize: '11px', background: '#dcfce7', color: '#15803d', padding: '3px 8px', borderRadius: '12px', fontWeight: 600 }}>
              🛡️ 4,000+ Multi-Account Rotation Engine Active
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
          
          {/* Left Column: Accounts Pool & Content */}
          <div style={{ background: '#fff', borderRadius: '12px', padding: '24px', border: '1px solid #e2e8f0', boxShadow: '0 1px 3px rgba(0,0,0,0.05)' }}>
            
            <div style={{ marginBottom: '16px' }}>
              <label style={{ display: 'block', fontSize: '12px', fontWeight: 'bold', color: '#1e293b', marginBottom: '4px' }}>
                Sender Name
              </label>
              <input
                type="text"
                placeholder="e.g. Brenda"
                value={senderName}
                onChange={(e) => setSenderName(e.target.value)}
                style={{ width: '100%', boxSizing: 'border-box', border: '1px solid #cbd5e1', borderRadius: '6px', padding: '9px 12px', fontSize: '13px' }}
              />
            </div>

            <div style={{ marginBottom: '16px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                <label style={{ fontSize: '12px', fontWeight: 'bold', color: '#1e293b' }}>
                  Sender Accounts Pool (Auto-Rotates every 35 emails)
                </label>
                <span style={{ fontSize: '11px', color: '#2563eb', fontWeight: 600 }}>
                  {parseSenderPool().length} Accounts Loaded
                </span>
              </div>
              <p style={{ fontSize: '11px', color: '#94a3b8', margin: '0 0 6px 0' }}>
                Paste 1 per line format: <code>email:apppassword</code> (ex: user1@gmail.com:abcdabcdabcdabcd)
              </p>
              <textarea
                rows={4}
                placeholder="sender1@gmail.com:xxxx yyyy zzzz aaaa&#10;sender2@gmail.com:bbbb cccc dddd eeee"
                value={senderPoolText}
                onChange={(e) => setSenderPoolText(e.target.value)}
                style={{ width: '100%', boxSizing: 'border-box', border: '1px solid #cbd5e1', borderRadius: '6px', padding: '9px 12px', fontSize: '12px', fontFamily: 'monospace' }}
              />
            </div>

            <div style={{ marginBottom: '16px' }}>
              <label style={{ display: 'block', fontSize: '12px', fontWeight: 'bold', color: '#1e293b', marginBottom: '4px' }}>
                Subject
              </label>
              <input
                type="text"
                placeholder="Enter custom subject..."
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                style={{ width: '100%', boxSizing: 'border-box', border: '1px solid #cbd5e1', borderRadius: '6px', padding: '9px 12px', fontSize: '13px' }}
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: '12px', fontWeight: 'bold', color: '#1e293b', marginBottom: '4px' }}>
                Message Body <span style={{ color: '#94a3b8', fontWeight: 'normal' }}>(Exact lines preserved. Use [name])</span>
              </label>
              <textarea
                rows={10}
                placeholder="Type your clean email content here..."
                value={body}
                onChange={(e) => setBody(e.target.value)}
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
                <span style={{ fontSize: '13px', fontWeight: 'bold' }}>Target Recipients</span>
                <span style={{ fontSize: '12px', color: '#2563eb', fontWeight: 600 }}>{recipientList.length} Found</span>
              </div>
              <p style={{ fontSize: '11px', color: '#94a3b8', margin: '0 0 10px 0' }}>Paste up to 4,000+ emails (comma separated or new lines)</p>
              <textarea
                rows={7}
                placeholder="client1@domain.com&#10;client2@domain.com"
                value={recipients}
                onChange={(e) => setRecipients(e.target.value)}
                style={{ width: '100%', boxSizing: 'border-box', border: '1px solid #cbd5e1', borderRadius: '6px', padding: '10px', fontSize: '12px', fontFamily: 'monospace', resize: 'none' }}
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

              {activeAccountInfo && (
                <div style={{ fontSize: '11px', color: '#2563eb', fontWeight: 600, textAlign: 'center', marginBottom: '8px' }}>
                  {activeAccountInfo}
                </div>
              )}

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
                {isSending ? 'Rotating & Sending Campaign...' : 'Launch Scaled Campaign'}
              </button>
            </div>

          </div>

        </div>

      </div>
    </div>
  );
}
