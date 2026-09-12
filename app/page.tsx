'use client';

import React, { useState } from 'react';

export default function SecureMailConsole() {
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

  const getRecipientList = (text: string) => {
    return text
      .split(/[\n,]+/)
      .map((e) => e.trim())
      .filter((e) => e.length > 0 && e.includes('@'));
  };

  const recipientList = getRecipientList(formData.recipients);
  const recipientCount = recipientList.length;

  const handleDoubleClickLogout = () => {
    if (confirm('Are you sure you want to logout?')) {
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
      alert('Please enter at least one recipient email.');
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
    setStatusText('Sending emails...');
    setStatus({
      total: list.length,
      sent: 0,
      failed: 0,
      remaining: list.length,
    });

    let sentCount = 0;
    let failedCount = 0;

    const BATCH_SIZE = 6;
    const BATCH_DELAY = 1500;

    for (let i = 0; i < list.length; i += BATCH_SIZE) {
      const batch = list.slice(i, i + BATCH_SIZE);

      const batchPromises = batch.map(async (recipient) => {
        try {
          const personalizedBody = parseSpintax(
            formData.body.replace(/\{name\}/gi, recipient.split('@')[0])
          );
          const personalizedSubject = parseSpintax(formData.subject);

          const res = await fetch('/api/send-email', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              senderName: formData.senderName,
              email: formData.email,
              appPassword: formData.appPassword,
              subject: personalizedSubject,
              body: personalizedBody,
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

      if (i + BATCH_SIZE < list.length) {
        await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY));
      }
    }

    setIsSending(false);
    setStatusText('Ready to send');
    alert('Campaign Execution Completed!');
  };

  return (
    <div style={{ minHeight: '100vh', backgroundColor: '#f1f5f9', padding: '30px 20px', fontFamily: 'system-ui, sans-serif', color: '#1e293b' }}>
      <div style={{ maxWidth: '1020px', margin: '0 auto' }}>
        
        {/* Top Header Bar */}
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

        {/* Section Sub-Title */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '20px' }}>
          <span style={{ fontSize: '18px' }}>✈️</span>
          <span style={{ fontSize: '15px', fontWeight: 'bold', color: '#0f172a' }}>Bulk Email Sender</span>
        </div>

        {/* 2-Column Exact Layout */}
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

            {/* Spam Protection Turnstile Box */}
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '6px' }}>
                <span style={{ fontSize: '12px' }}>🛡️</span>
                <span style={{ fontSize: '11px', fontWeight: 'bold', color: '#0f172a' }}>Spam Protection</span>
              </div>
              <div style={{ border: '1px solid #cbd5e1', borderRadius: '6px', backgroundColor: '#f8fafc', padding: '8px 12px', maxWidth: '220px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                    <div style={{ width: '16px', height: '16px', borderRadius: '3px', backgroundColor: '#10b981', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '10px', fontWeight: 'bold' }}>
                      ✓
                    </div>
                    <span style={{ fontSize: '12px', fontWeight: 'bold', color: '#0f172a' }}>Success!</span>
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

              {/* 2x2 Clean Counters */}
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

              {/* Send All Green Button */}
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
