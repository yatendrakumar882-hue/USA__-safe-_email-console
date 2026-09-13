'use client';

import React, { useState } from 'react';

export default function SecureMailConsole() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [loginPassword, setLoginPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

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

  // Login handler
  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (loginPassword === 'admin' || loginPassword.length > 0) {
      setIsAuthenticated(true);
    }
  };

  // Recipients count
  const recipientCount = formData.recipients
    .split(/[\n,]+/)
    .map((r) => r.trim())
    .filter(Boolean).length;

  // Spintax parser: {Hello|Hi|Hey} -> Random pick
  const parseSpintax = (text: string) => {
    return text.replace(/{([^{}]+)}/g, (_, match) => {
      const choices = match.split('|');
      return choices[Math.floor(Math.random() * choices.length)];
    });
  };

  // Safe Batch Sender (2 per batch + delay)
  const handleSendEmails = async () => {
    const list = formData.recipients
      .split(/[\n,]+/)
      .map((r) => r.trim())
      .filter(Boolean);

    if (list.length === 0) return;

    setIsSending(true);
    let sent = 0;
    let failed = 0;
    const BATCH_SIZE = 2;

    setStatus({ total: list.length, sent: 0, failed: 0, remaining: list.length });

    for (let i = 0; i < list.length; i += BATCH_SIZE) {
      const batch = list.slice(i, i + BATCH_SIZE);

      await Promise.all(
        batch.map(async (toEmail) => {
          const personalizedBody = parseSpintax(formData.body).replace(/\[name\]/gi, toEmail.split('@')[0]);
          const personalizedSubject = parseSpintax(formData.subject);

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
            if (data.success) sent++;
            else failed++;
          } catch {
            failed++;
          }
        })
      );

      setStatus({
        total: list.length,
        sent,
        failed,
        remaining: list.length - (sent + failed),
      });

      if (i + BATCH_SIZE < list.length) {
        setStatusText(`Batch sent (${sent}/${list.length}). Waiting 3.5s...`);
        await new Promise((resolve) => setTimeout(resolve, 3500));
      }
    }

    setStatusText('Completed');
    setIsSending(false);
  };

  // SCREENSHOT 1: ACCESS PROTECTED SCREEN
  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-gradient-to-b from-[#1c223a] via-[#161a2e] to-[#0c0f1d] flex items-center justify-center p-4">
        <div className="w-full max-w-sm bg-[#222842]/70 backdrop-blur-md border border-[#2e375b] rounded-2xl p-8 flex flex-col items-center shadow-2xl">
          <div className="w-14 h-14 bg-gradient-to-tr from-blue-600 to-blue-400 rounded-full flex items-center justify-center shadow-lg mb-5">
            <svg className="w-7 h-7 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <rect x="5" y="11" width="14" height="10" rx="2" strokeWidth="2" />
              <path d="M8 11V7a4 4 0 018 0v4" strokeWidth="2" />
            </svg>
          </div>

          <h1 className="text-xl font-semibold text-white tracking-wide">Access Protected</h1>
          <p className="text-xs text-slate-400 mt-1 mb-6">Enter the password to continue</p>

          <form onSubmit={handleLogin} className="w-full space-y-4">
            <div className="relative">
              <input
                type={showPassword ? 'text' : 'password'}
                placeholder="Enter password..."
                value={loginPassword}
                onChange={(e) => setLoginPassword(e.target.value)}
                className="w-full bg-[#181d33] border border-[#2b3558] rounded-lg px-4 py-2.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-3 top-2.5 text-slate-400 hover:text-white"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                </svg>
              </button>
            </div>

            <button
              type="submit"
              className="w-full bg-[#2563eb] hover:bg-blue-600 text-white font-medium py-2.5 rounded-lg text-xs flex items-center justify-center gap-1.5 shadow-md shadow-blue-500/20 transition-all"
            >
              <span>➔]</span> Enter
            </button>
          </form>
        </div>
      </div>
    );
  }

  // SCREENSHOT 2: SECURE MAIL CONSOLE INTERFACE
  return (
    <div className="min-h-screen bg-[#f3f7fd] text-[#334155] p-6 md:p-12 font-sans flex flex-col items-center">
      <div className="w-full max-w-5xl space-y-6">
        
        {/* Top bar */}
        <div className="flex justify-between items-center">
          <div className="flex items-center gap-2">
            <svg className="w-6 h-6 text-blue-500" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M10 1.944A11.954 11.954 0 012.166 5C2.056 5.649 2 6.319 2 7c0 5.225 3.34 9.67 8 11.317C14.66 16.67 18 12.225 18 7c0-.682-.057-1.35-.166-2.001A11.954 11.954 0 0110 1.944z" clipRule="evenodd" />
            </svg>
            <h1 className="text-xl font-bold text-blue-600 tracking-tight">Secure Mail Console</h1>
          </div>
          <button
            onDoubleClick={() => setIsAuthenticated(false)}
            className="text-xs text-red-500 hover:text-red-600 font-medium"
            title="Double click to exit"
          >
            [➔ Logout (Double Click)
          </button>
        </div>

        {/* Section title */}
        <div className="flex items-center gap-2 pt-2">
          <span className="text-sm">▲</span>
          <h2 className="text-sm font-bold text-slate-800">Bulk Email Sender</h2>
        </div>

        {/* 2-Column Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-start">
          
          {/* Left Column: Compose Message */}
          <div className="bg-white rounded-xl p-6 border border-slate-200/80 shadow-sm space-y-4">
            <div className="flex items-center gap-1.5 pb-2">
              <svg className="w-4 h-4 text-slate-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
              <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider">Compose Message</h3>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-[11px] font-medium text-slate-500 mb-1">Sender Name</label>
                <input
                  type="text"
                  placeholder="E.g., John Doe"
                  value={formData.senderName}
                  onChange={(e) => setFormData({ ...formData, senderName: e.target.value })}
                  className="w-full bg-white border border-slate-200 rounded-md px-3 py-2 text-xs text-slate-800 focus:outline-none focus:border-blue-400 placeholder-slate-400"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-500 mb-1">Your Gmail</label>
                <input
                  type="email"
                  placeholder="you@gmail.com"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  className="w-full bg-white border border-slate-200 rounded-md px-3 py-2 text-xs text-slate-800 focus:outline-none focus:border-blue-400 placeholder-slate-400"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-[11px] font-medium text-slate-500 mb-1">App Password</label>
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    placeholder="16-char app password"
                    value={formData.appPassword}
                    onChange={(e) => setFormData({ ...formData, appPassword: e.target.value })}
                    className="w-full bg-white border border-slate-200 rounded-md px-3 py-2 text-xs text-slate-800 focus:outline-none focus:border-blue-400 placeholder-slate-400 font-mono pr-8"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-2.5 top-2 text-slate-400 hover:text-slate-600"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                  </button>
                </div>
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-500 mb-1">Email Subject</label>
                <input
                  type="text"
                  placeholder="Enter subject line..."
                  value={formData.subject}
                  onChange={(e) => setFormData({ ...formData, subject: e.target.value })}
                  className="w-full bg-white border border-slate-200 rounded-md px-3 py-2 text-xs text-slate-800 focus:outline-none focus:border-blue-400 placeholder-slate-400"
                />
              </div>
            </div>

            <div>
              <label className="block text-[11px] font-medium text-slate-500 mb-1">Message Body (Plain Text / HTML)</label>
              <textarea
                rows={10}
                placeholder="Write your email here... Spintax supported: {Hi|Hello} [name]"
                value={formData.body}
                onChange={(e) => setFormData({ ...formData, body: e.target.value })}
                className="w-full bg-white border border-slate-200 rounded-md p-3 text-xs text-slate-800 focus:outline-none focus:border-blue-400 placeholder-slate-400 resize-none font-sans"
              />
            </div>

            {/* Cloudflare Turnstile Mock Widget */}
            <div className="pt-2">
              <span className="block text-[10px] text-slate-400 mb-1">🛡 Spam Protection</span>
              <div className="w-48 bg-[#fafafa] border border-slate-200 rounded p-2 flex items-center justify-between shadow-xs">
                <div className="flex items-center gap-1.5">
                  <div className="w-4 h-4 rounded-full bg-emerald-500 flex items-center justify-center text-white text-[10px]">✓</div>
                  <span className="text-[11px] font-medium text-slate-700">Success!</span>
                </div>
                <div className="text-[9px] text-right text-slate-400 leading-tight">
                  <span className="font-bold text-[#f38020] block">CLOUDFLARE</span>
                  Privacy • Terms
                </div>
              </div>
            </div>
          </div>

          {/* Right Column: Recipients & Progress Monitor */}
          <div className="space-y-6">
            
            {/* Recipients Card */}
            <div className="bg-white rounded-xl p-6 border border-slate-200/80 shadow-sm space-y-2">
              <div className="flex justify-between items-center">
                <div className="flex items-center gap-1.5">
                  <svg className="w-4 h-4 text-slate-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
                  </svg>
                  <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider">Recipients</h3>
                </div>
                <span className="text-[11px] text-blue-500 font-medium">{recipientCount} Found</span>
              </div>
              <p className="text-[11px] text-slate-400">Paste emails (comma separated, new lines, or Excel copy)</p>
              <textarea
                rows={5}
                placeholder="recipient1@example.com&#10;recipient2@example.com"
                value={formData.recipients}
                onChange={(e) => setFormData({ ...formData, recipients: e.target.value })}
                className="w-full bg-white border border-slate-200 rounded-md p-3 text-xs text-slate-800 focus:outline-none focus:border-blue-400 placeholder-slate-400 resize-none font-mono"
              />
            </div>

            {/* Progress Monitor Card */}
            <div className="bg-white rounded-xl p-6 border border-slate-200/80 shadow-sm space-y-4">
              <div className="flex items-center gap-1.5">
                <svg className="w-4 h-4 text-slate-700" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M16 8v8m-4-5v5m-4-2v2m-2 4h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                <h3 className="text-xs font-bold text-slate-800 uppercase tracking-wider">Progress Monitor</h3>
              </div>

              <div className="grid grid-cols-2 gap-4 border border-slate-100 rounded-lg p-4 bg-slate-50/50">
                <div className="text-center">
                  <span className="text-[10px] uppercase font-bold text-slate-400">TOTAL</span>
                  <div className="text-xl font-bold text-blue-500 mt-1">{status.total}</div>
                </div>
                <div className="text-center">
                  <span className="text-[10px] uppercase font-bold text-slate-400">SENT</span>
                  <div className="text-xl font-bold text-emerald-500 mt-1">{status.sent}</div>
                </div>
                <div className="text-center pt-2">
                  <span className="text-[10px] uppercase font-bold text-slate-400">FAILED</span>
                  <div className="text-xl font-bold text-rose-500 mt-1">{status.failed}</div>
                </div>
                <div className="text-center pt-2">
                  <span className="text-[10px] uppercase font-bold text-slate-400">REMAINING</span>
                  <div className="text-xl font-bold text-amber-500 mt-1">{status.remaining}</div>
                </div>
              </div>

              {/* Status bar */}
              <div className="flex items-center justify-center gap-2 pt-2 text-xs font-medium text-slate-600">
                <span className="inline-block w-2 h-2 rounded-full bg-slate-400"></span>
                <span>{statusText}</span>
              </div>

              {/* Send All Button */}
              <button
                type="button"
                onClick={handleSendEmails}
                disabled={isSending}
                className="w-full bg-[#10b981] hover:bg-emerald-600 text-white font-semibold py-3 rounded-lg text-xs flex items-center justify-center gap-2 shadow-sm transition disabled:opacity-50"
              >
                <span>{isSending ? 'Sending Safe Batches...' : '▲ Send All'}</span>
              </button>
            </div>

          </div>

        </div>

      </div>
    </div>
  );
}
