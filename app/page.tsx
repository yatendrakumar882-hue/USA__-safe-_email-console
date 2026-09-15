'use client';

import React, { useState } from 'react';

const PRESET_SUBJECTS = [
  "Polished site missing prime search slot",
  "Well-made portal unseen on first listing",
  "Strong website absent from early rankings",
  "Refined platform lacking initial visibility boost",
  "Elegant webpage hidden from prime results",
  "Quality domain missing top search exposure",
  "Trusted portal absent from early placement",
  "Professional site unseen on first screen",
  "Stylish website lacking initial search traction",
  "Secure portal hidden from prime ranking"
];

const DEFAULT_BODY_TEMPLATES = `Hello,

Your website looks fantastic, but it does not appear on the front pages.

May I send you a report?

Thank you.
---
Hi, I hope you are doing well today.

An error on your site is preventing it from being displayed on Google. Can I share a report?

Thanks
---
Hello,

Your website looks sharp, but it doesn't appear on the front pages.

May I send you a report?`;

export default function SecureMailConsole() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [loginPassword, setLoginPassword] = useState('');
  const [showAppPassword, setShowAppPassword] = useState(false);

  const [formData, setFormData] = useState({
    senderName: '',
    email: '',
    appPassword: '',
    subject: 'ROTATING_ALL_PRESETS',
    recipients: '',
    body: DEFAULT_BODY_TEMPLATES,
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

  const getRotatedTemplate = (rawBody: string, recipientIndex: number) => {
    const templates = rawBody
      .split(/\n\s*---\s*\n/)
      .map((t) => t.trim())
      .filter(Boolean);

    if (templates.length === 0) return rawBody;
    return templates[recipientIndex % templates.length];
  };

  const sanitizeTextPreservingLines = (str: string) => {
    return str
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/!{2,}/g, '.')
      .replace(/^\s*!\s*/gm, '')
      .split('\n')
      .map((line) => line.trim())
      .join('\n')
      .trim();
  };

  const generateCleanBody = (rawBody: string, recipient: string, recipientIndex: number) => {
    const chosenTemplate = getRotatedTemplate(rawBody, recipientIndex);
    const name = recipient.split('@')[0].replace(/[._-]/g, ' ');
    const formattedName = name.charAt(0).toUpperCase() + name.slice(1);

    const parsed = chosenTemplate
      .replace(/\[name\]/gi, formattedName)
      .replace(/\[email\]/gi, recipient);

    return sanitizeTextPreservingLines(parsed);
  };

  const generateCleanSubject = (rawSubject: string, recipientIndex: number) => {
    if (rawSubject === 'ROTATING_ALL_PRESETS' || !rawSubject.trim()) {
      return PRESET_SUBJECTS[recipientIndex % PRESET_SUBJECTS.length];
    }
    return rawSubject.trim();
  };

  const handleSendEmails = async () => {
    if (recipientList.length === 0 || isSending) return;

    setIsSending(true);
    let sent = 0;
    let failed = 0;

    setStatus({ total: recipientList.length, sent: 0, failed: 0, remaining: recipientList.length });
    setStatusText('Inbox delivery running...');

    for (let i = 0; i < recipientList.length; i++) {
      const toEmail = recipientList[i];
      const personalizedBody = generateCleanBody(formData.body, toEmail, i);
      const personalizedSubject = generateCleanSubject(formData.subject, i);

      setStatusText(`Sending ${i + 1} of ${recipientList.length}...`);

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

      if (i + 1 < recipientList.length) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }

    setStatusText(`Completed! Total sent: ${sent}, Failed: ${failed}`);
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
        fontFamily: 'sans-serif'
      }}>
        <div style={{
          width: '360px',
          background: '#1f2642',
          borderRadius: '12px',
          padding: '30px',
          color: '#fff'
        }}>
          <h2 style={{ fontSize: '18px', marginBottom: '16px' }}>Access Protected</h2>
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
                padding: '10px',
                color: '#fff',
                marginBottom: '16px'
              }}
            />
            <button
              type="submit"
              style={{
                width: '100%',
                background: '#2563eb',
                border: 'none',
                borderRadius: '6px',
                padding: '10px',
                color: '#fff',
                fontWeight: 'bold',
                cursor: 'pointer'
              }}
            >
              Enter
            </button>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div style={{ minHeight: '100vh', background: '#f8fafc', padding: '30px', fontFamily: 'sans-serif', color: '#1e293b' }}>
      <div style={{ maxWidth: '1000px', margin: '0 auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '20px' }}>
          <h1 style={{ fontSize: '20px', fontWeight: 'bold', color: '#2563eb' }}>Secure Mail Console</h1>
          <button onClick={() => setIsAuthenticated(false)} style={{ border: 'none', background: 'none', color: '#ef4444', cursor: 'pointer' }}>Logout</button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr', gap: '20px' }}>
          <div style={{ background: '#fff', padding: '20px', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '10px' }}>
              <input
                type="text"
                placeholder="Sender Name"
                value={formData.senderName}
                onChange={(e) => setFormData({ ...formData, senderName: e.target.value })}
                style={{ padding: '8px', border: '1px solid #cbd5e1', borderRadius: '6px' }}
              />
              <input
                type="email"
                placeholder="Your Gmail"
                value={formData.email}
                onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                style={{ padding: '8px', border: '1px solid #cbd5e1', borderRadius: '6px' }}
              />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '10px' }}>
              <input
                type={showAppPassword ? 'text' : 'password'}
                placeholder="16-char App Password"
                value={formData.appPassword}
                onChange={(e) => setFormData({ ...formData, appPassword: e.target.value })}
                style={{ padding: '8px', border: '1px solid #cbd5e1', borderRadius: '6px' }}
              />
              <input
                type="text"
                placeholder="Subject Line"
                value={formData.subject}
                onChange={(e) => setFormData({ ...formData, subject: e.target.value })}
                style={{ padding: '8px', border: '1px solid #cbd5e1', borderRadius: '6px' }}
              />
            </div>

            <textarea
              rows={12}
              value={formData.body}
              onChange={(e) => setFormData({ ...formData, body: e.target.value })}
              style={{ width: '100%', boxSizing: 'border-box', padding: '10px', border: '1px solid #cbd5e1', borderRadius: '6px', whiteSpace: 'pre-wrap' }}
            />
          </div>

          <div>
            <div style={{ background: '#fff', padding: '20px', borderRadius: '8px', border: '1px solid #e2e8f0', marginBottom: '20px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                <span style={{ fontWeight: 'bold' }}>Recipients</span>
                <span>{recipientList.length} Found</span>
              </div>
              <textarea
                rows={6}
                placeholder="recipient1@example.com&#10;recipient2@example.com"
                value={formData.recipients}
                onChange={(e) => setFormData({ ...formData, recipients: e.target.value })}
                style={{ width: '100%', boxSizing: 'border-box', padding: '8px', border: '1px solid #cbd5e1', borderRadius: '6px' }}
              />
            </div>

            <div style={{ background: '#fff', padding: '20px', borderRadius: '8px', border: '1px solid #e2e8f0' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', textAlign: 'center', marginBottom: '15px' }}>
                <div style={{ background: '#f8fafc', padding: '10px', borderRadius: '6px' }}>TOTAL: {status.total}</div>
                <div style={{ background: '#f8fafc', padding: '10px', borderRadius: '6px', color: '#10b981' }}>SENT: {status.sent}</div>
              </div>
              <div style={{ textAlign: 'center', marginBottom: '15px', fontSize: '13px', color: '#64748b' }}>{statusText}</div>
              <button
                onClick={handleSendEmails}
                disabled={isSending}
                style={{
                  width: '100%',
                  padding: '12px',
                  background: isSending ? '#94a3b8' : '#10b981',
                  color: '#fff',
                  border: 'none',
                  borderRadius: '6px',
                  fontWeight: 'bold',
                  cursor: isSending ? 'not-allowed' : 'pointer'
                }}
              >
                {isSending ? 'Sending...' : 'Send All'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
