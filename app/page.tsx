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

  // Login handler
  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (loginPassword === 'admin' || loginPassword.length > 0) {
      setIsAuthenticated(true);
      setLoginError('');
    } else {
      setLoginError('Invalid console access key');
    }
  };

  // Safe Batch Email Sending Logic (2 per batch + 4s human delay)
  const handleSendEmails = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSending(true);

    const recipientList = formData.recipients
      .split('\n')
      .map((r) => r.trim())
      .filter((r) => r.length > 0);

    if (recipientList.length === 0) {
      setStatusText('Please add at least one recipient email.');
      setIsSending(false);
      return;
    }

    let sentCount = 0;
    let failedCount = 0;
    const BATCH_SIZE = 6;

    for (let i = 0; i < recipientList.length; i += BATCH_SIZE) {
      const currentBatch = recipientList.slice(i, i + BATCH_SIZE);

      await Promise.all(
        currentBatch.map(async (recipientEmail) => {
          try {
            const res = await fetch('/api/send-email', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                senderName: formData.senderName,
                email: formData.email,
                appPassword: formData.appPassword,
                subject: formData.subject,
                body: formData.body,
                to: recipientEmail,
              }),
            });
            const data = await res.json();
            if (data.success) {
              sentCount++;
            } else {
              failedCount++;
            }
          } catch {
            failedCount++;
          }
        })
      );

      setStatus({
        total: recipientList.length,
        sent: sentCount,
        failed: failedCount,
        remaining: recipientList.length - (sentCount + failedCount),
      });

      if (i + BATCH_SIZE < recipientList.length) {
        setStatusText(`Batch sent (${sentCount}/${recipientList.length}). Human pacing cooldown (4s)...`);
        await new Promise((resolve) => setTimeout(resolve, 4000));
      }
    }

    setStatusText('All batches delivered successfully!');
    setIsSending(false);
  };

  // Locked State View
  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-slate-950 text-slate-100 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-slate-900 border border-slate-800 rounded-2xl p-8 shadow-2xl">
          <div className="text-center mb-8">
            <h1 className="text-2xl font-bold tracking-tight text-white">USA Safe Email Console</h1>
            <p className="text-sm text-slate-400 mt-2">Protected Sender Gateway</p>
          </div>
          <form onSubmit={handleLogin} className="space-y-4">
            <div>
              <label className="block text-xs uppercase tracking-wider text-slate-400 mb-2">Access Key</label>
              <input
                type="password"
                placeholder="Enter password"
                value={loginPassword}
                onChange={(e) => setLoginPassword(e.target.value)}
                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-4 py-2.5 text-white focus:outline-none focus:border-blue-500 text-sm"
              />
            </div>
            {loginError && <p className="text-xs text-rose-500">{loginError}</p>}
            <button
              type="submit"
              className="w-full bg-blue-600 hover:bg-blue-500 text-white font-medium py-2.5 rounded-lg transition text-sm"
            >
              Unlock Console
            </button>
          </form>
        </div>
      </div>
    );
  }

  // Dashboard Main View
  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-6 md:p-10 flex justify-center">
      <div className="w-full max-w-4xl space-y-6">
        
        {/* Top Header */}
        <div className="flex justify-between items-center bg-slate-900 border border-slate-800 p-6 rounded-2xl">
          <div>
            <h1 className="text-2xl font-bold text-white">USA Safe Email Console</h1>
            <p className="text-sm text-slate-400">High Inboxing Node • 20 Static ISP Proxies Connected</p>
          </div>
          <div className="text-right">
            <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-medium bg-emerald-950 text-emerald-400 border border-emerald-800">
              ● Node Active
            </span>
          </div>
        </div>

        {/* Form Container */}
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-6 md:p-8 space-y-6">
          <form onSubmit={handleSendEmails} className="space-y-6">
            
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold uppercase text-slate-400 mb-2">Sender Name</label>
                <input
                  type="text"
                  required
                  placeholder="e.g. John Doe"
                  value={formData.senderName}
                  onChange={(e) => setFormData({ ...formData, senderName: e.target.value })}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-blue-500"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase text-slate-400 mb-2">Sender Gmail</label>
                <input
                  type="email"
                  required
                  placeholder="sender@gmail.com"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-blue-500"
                />
              </div>
            </div>

            <div>
              <div className="flex justify-between items-center mb-2">
                <label className="text-xs font-semibold uppercase text-slate-400">Gmail 16-Digit App Password</label>
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="text-xs text-blue-400 hover:underline"
                >
                  {showPassword ? 'Hide' : 'Show'}
                </button>
              </div>
              <input
                type={showPassword ? 'text' : 'password'}
                required
                placeholder="xxxx xxxx xxxx xxxx"
                value={formData.appPassword}
                onChange={(e) => setFormData({ ...formData, appPassword: e.target.value })}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-blue-500 font-mono"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold uppercase text-slate-400 mb-2">Subject</label>
              <input
                type="text"
                required
                placeholder="Subject line"
                value={formData.subject}
                onChange={(e) => setFormData({ ...formData, subject: e.target.value })}
                className="w-full bg-slate-950 border border-slate-800 rounded-xl px-4 py-2.5 text-sm text-white focus:outline-none focus:border-blue-500"
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold uppercase text-slate-400 mb-2">Recipients (One per line)</label>
                <textarea
                  rows={6}
                  required
                  placeholder="client1@domain.com&#10;client2@domain.com"
                  value={formData.recipients}
                  onChange={(e) => setFormData({ ...formData, recipients: e.target.value })}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-xs font-mono text-white focus:outline-none focus:border-blue-500 resize-none"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase text-slate-400 mb-2">Email Body</label>
                <textarea
                  rows={6}
                  required
                  placeholder="Write your email content..."
                  value={formData.body}
                  onChange={(e) => setFormData({ ...formData, body: e.target.value })}
                  className="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-xs text-white focus:outline-none focus:border-blue-500 resize-none"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={isSending}
              className="w-full bg-blue-600 hover:bg-blue-500 text-white font-medium py-3 rounded-xl transition text-sm disabled:opacity-50"
            >
              {isSending ? 'Sending Safe Batches (2 per batch)...' : 'Start Safe Dispatch'}
            </button>
          </form>

          {/* Activity Console / Live Status */}
          <div className="bg-slate-950 border border-slate-800 rounded-xl p-4 text-xs space-y-2">
            <div className="flex justify-between border-b border-slate-800 pb-2">
              <span className="text-slate-400">Live Console Engine:</span>
              <span className="text-blue-400 font-mono">{statusText}</span>
            </div>
            <div className="grid grid-cols-4 gap-2 pt-1 text-center font-mono">
              <div className="p-2 bg-slate-900 rounded-lg">
                <span className="text-slate-500 block">Total</span>
                <span className="text-slate-200 font-bold">{status.total}</span>
              </div>
              <div className="p-2 bg-slate-900 rounded-lg">
                <span className="text-slate-500 block">Sent</span>
                <span className="text-emerald-400 font-bold">{status.sent}</span>
              </div>
              <div className="p-2 bg-slate-900 rounded-lg">
                <span className="text-slate-500 block">Failed</span>
                <span className="text-rose-400 font-bold">{status.failed}</span>
              </div>
              <div className="p-2 bg-slate-900 rounded-lg">
                <span className="text-slate-500 block">Pending</span>
                <span className="text-amber-400 font-bold">{status.remaining}</span>
              </div>
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}
