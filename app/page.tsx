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

  // Recipients auto parser & counter
  const getRecipientList = (text: string) => {
    return text
      .split(/[\n,]+/)
      .map((e) => e.trim())
      .filter((e) => e.length > 0 && e.includes('@'));
  };

  const recipientList = getRecipientList(formData.recipients);
  const recipientCount = recipientList.length;

  // Double-Click Logout logic
  const handleDoubleClickLogout = () => {
    if (confirm('Are you sure you want to logout and clear console?')) {
      setFormData({
        senderName: '',
        email: '',
        appPassword: '',
        subject: '',
        body: '',
        recipients: '',
      });
      setStatus({ total: 0, sent: 0, failed: 0, remaining: 0 });
      setStatusText('Session terminated');
    }
  };

  const handleSingleClickLogout = () => {
    setStatusText('Double click logout button to exit');
  };

  // Simple Spintax parser: {Hi|Hello} -> Hi or Hello
  const parseSpintax = (text: string) => {
    return text.replace(/\{([^{}]+)\}/g, (_, choices) => {
      const parts = choices.split('|');
      return parts[Math.floor(Math.random() * parts.length)].trim();
    });
  };

  // Auto-Fill and Dispatch Handler
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

    // Auto-fill formatted list back into textarea
    setFormData((prev) => ({
      ...prev,
      recipients: list.join('\n'),
    }));

    setIsSending(true);
    setStatusText('Sending queue active...');
    setStatus({
      total: list.length,
      sent: 0,
      failed: 0,
      remaining: list.length,
    });

    let sentCount = 0;
    let failedCount = 0;

    // Send 2 at a time (Concurrency)
    const BATCH_SIZE = 2;
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
    setStatusText('All tasks completed');
    alert('Campaign Execution Completed!');
  };

  return (
    <div className="min-h-screen bg-[#f7f9fd] text-[#333] font-sans p-6 sm:p-10 flex flex-col justify-center">
      <div className="max-w-6xl mx-auto w-full">
        {/* Header Section */}
        <div className="flex justify-between items-center mb-6">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-full bg-blue-50 flex items-center justify-center">
              <svg className="w-6 h-6 text-[#2563eb]" fill="currentColor" viewBox="0 0 24 24">
                <path d="M12 2L4 5v6.09c0 5.05 3.41 9.76 8 10.91 4.59-1.15 8-5.86 8-10.91V5l-8-3z" />
              </svg>
            </div>
            <h1 className="text-2xl font-bold text-[#4338ca] tracking-tight">Secure Mail Console</h1>
          </div>

          {/* Double Click Logout Button */}
          <button
            onClick={handleSingleClickLogout}
            onDoubleClick={handleDoubleClickLogout}
            title="Double click to logout"
            className="px-3.5 py-1.5 text-xs font-semibold text-[#ef4444] bg-white border border-[#fca5a5] rounded-md hover:bg-red-50 transition select-none shadow-sm cursor-pointer"
          >
            [➔ Logout (Double Click)]
          </button>
        </div>

        {/* Sub-header */}
        <div className="flex items-center gap-2 mb-6">
          <svg className="w-5 h-5 text-gray-800 -rotate-45 -mt-1" fill="currentColor" viewBox="0 0 20 20">
            <path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z" />
          </svg>
          <h2 className="text-base font-bold text-gray-900 tracking-wide">Bulk Email Sender</h2>
        </div>

        {/* 2-Column Exact Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
          {/* LEFT COLUMN: Compose Message */}
          <div className="lg:col-span-6 bg-white rounded-2xl border border-gray-200/70 p-6 shadow-sm">
            {/* Title */}
            <div className="flex items-center gap-2 mb-5">
              <svg className="w-4 h-4 text-gray-700" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
              <h3 className="font-bold text-sm text-gray-800">Compose Message</h3>
            </div>

            {/* Inputs 2x2 Grid */}
            <div className="grid grid-cols-2 gap-4 mb-4">
              <div>
                <label className="block text-[11px] font-semibold text-gray-600 mb-1">Sender Name</label>
                <input
                  type="text"
                  placeholder="E.g., John Doe"
                  value={formData.senderName}
                  onChange={(e) => setFormData({ ...formData, senderName: e.target.value })}
                  className="w-full text-xs px-3 py-2.5 border border-gray-200 rounded-lg outline-none focus:border-indigo-500 placeholder-gray-400 bg-white"
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-gray-600 mb-1">Your Gmail</label>
                <input
                  type="email"
                  placeholder="you@gmail.com"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  className="w-full text-xs px-3 py-2.5 border border-gray-200 rounded-lg outline-none focus:border-indigo-500 placeholder-gray-400 bg-white"
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-gray-600 mb-1">App Password</label>
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    placeholder="16-char app password"
                    value={formData.appPassword}
                    onChange={(e) => setFormData({ ...formData, appPassword: e.target.value })}
                    className="w-full text-xs px-3 py-2.5 border border-gray-200 rounded-lg outline-none focus:border-indigo-500 pr-8 placeholder-gray-400 bg-white"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                      <path strokeLinecap="round" strokeLinejoin="round" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                    </svg>
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-gray-600 mb-1">Email Subject</label>
                <input
                  type="text"
                  placeholder="Enter subject line..."
                  value={formData.subject}
                  onChange={(e) => setFormData({ ...formData, subject: e.target.value })}
                  className="w-full text-xs px-3 py-2.5 border border-gray-200 rounded-lg outline-none focus:border-indigo-500 placeholder-gray-400 bg-white"
                />
              </div>
            </div>

            {/* Message Body */}
            <div className="mb-6">
              <label className="block text-[11px] font-semibold text-gray-600 mb-1">
                Message Body (Plain Text / HTML)
              </label>
              <textarea
                rows={7}
                placeholder="Write your email here... Spintax supported: {Hi|Hello} {name}"
                value={formData.body}
                onChange={(e) => setFormData({ ...formData, body: e.target.value })}
                className="w-full text-xs p-3 border border-gray-200 rounded-lg outline-none focus:border-indigo-500 resize-none font-mono placeholder-gray-400 bg-white"
              />
            </div>

            {/* Exact Cloudflare Spam Protection Box */}
            <div>
              <div className="flex items-center gap-1.5 mb-2">
                <svg className="w-3.5 h-3.5 text-gray-700" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M2.166 4.999A11.954 11.954 0 0010 1.944 11.954 11.954 0 0017.834 5c.11.65.166 1.32.166 2.001 0 5.225-3.34 9.67-8 11.317C5.34 16.67 2 12.225 2 7c0-.682.057-1.35.166-2.001zm11.541 3.708a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                </svg>
                <span className="text-xs font-bold text-gray-800">Spam Protection</span>
              </div>

              <div className="border border-gray-200 bg-[#fbfbfb] rounded-lg p-2.5 max-w-[280px]">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="w-5 h-5 rounded bg-emerald-500 text-white flex items-center justify-center text-xs">
                      ✓
                    </div>
                    <div>
                      <div className="text-xs font-bold text-gray-800 leading-none">Success!</div>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-[10px] font-black text-gray-600 tracking-wider">CLOUDFLARE</div>
                    <div className="text-[8px] text-gray-400 leading-none">Privacy • Terms</div>
                  </div>
                </div>
                {/* Visual red warning banner from screenshot */}
                <div className="mt-2 text-[9px] text-[#dc2626] border-t border-red-200 pt-1 font-mono">
                  For testing only. If seen, report to site owner
                </div>
              </div>
            </div>
          </div>

          {/* RIGHT COLUMN: Recipients & Progress Monitor */}
          <div className="lg:col-span-6 space-y-6">
            {/* Recipients Box */}
            <div className="bg-white rounded-2xl border border-gray-200/70 p-6 shadow-sm">
              <div className="flex justify-between items-center mb-1">
                <div className="flex items-center gap-2">
                  <svg className="w-4 h-4 text-gray-700" fill="currentColor" viewBox="0 0 20 20">
                    <path d="M9 6a3 3 0 11-6 0 3 3 0 016 0zM17 6a3 3 0 11-6 0 3 3 0 016 0zM12.93 17c.046-.327.07-.66.07-1a6.97 6.97 0 00-1.5-4.33A5 5 0 0119 16v1h-6.07zM6 11a5 5 0 015 5v1H1v-1a5 5 0 015-5z" />
                  </svg>
                  <h3 className="font-bold text-sm text-gray-800">Recipients</h3>
                </div>
                <span className="text-[11px] text-[#3b82f6] bg-[#eff6ff] px-2.5 py-0.5 rounded-full font-medium">
                  {recipientCount} found
                </span>
              </div>
              <p className="text-[11px] text-gray-400 mb-3 font-normal">
                Paste emails (comma separated, new lines, or Excel copy)
              </p>
              <textarea
                rows={5}
                placeholder={"recipient1@example.com\nrecipient2@example.com"}
                value={formData.recipients}
                onChange={(e) => setFormData({ ...formData, recipients: e.target.value })}
                className="w-full text-xs p-3 border border-gray-200 rounded-lg outline-none focus:border-indigo-500 resize-none font-mono placeholder-gray-400 bg-white"
              />
            </div>

            {/* Progress Monitor */}
            <div className="bg-white rounded-2xl border border-gray-200/70 p-6 shadow-sm">
              <div className="flex items-center gap-2 mb-4">
                <svg className="w-4 h-4 text-gray-700" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM7 9a1 1 0 000 2h6a1 1 0 100-2H7z" clipRule="evenodd" />
                </svg>
                <h3 className="font-bold text-sm text-gray-800">Progress Monitor</h3>
              </div>

              {/* 2x2 Clean Counters */}
              <div className="grid grid-cols-2 gap-3 mb-5">
                <div className="border border-gray-100 rounded-xl p-3.5 text-center bg-[#fafbfc]">
                  <div className="text-[10px] tracking-wider font-bold text-gray-500 uppercase">TOTAL</div>
                  <div className="text-xl font-extrabold text-[#3b82f6] mt-1">{status.total}</div>
                </div>
                <div className="border border-gray-100 rounded-xl p-3.5 text-center bg-[#fafbfc]">
                  <div className="text-[10px] tracking-wider font-bold text-gray-500 uppercase">SENT</div>
                  <div className="text-xl font-extrabold text-[#10b981] mt-1">{status.sent}</div>
                </div>
                <div className="border border-gray-100 rounded-xl p-3.5 text-center bg-[#fafbfc]">
                  <div className="text-[10px] tracking-wider font-bold text-gray-500 uppercase">FAILED</div>
                  <div className="text-xl font-extrabold text-[#ef4444] mt-1">{status.failed}</div>
                </div>
                <div className="border border-gray-100 rounded-xl p-3.5 text-center bg-[#fafbfc]">
                  <div className="text-[10px] tracking-wider font-bold text-gray-500 uppercase">REMAINING</div>
                  <div className="text-xl font-extrabold text-[#f59e0b] mt-1">{status.remaining}</div>
                </div>
              </div>

              {/* Status Indicator */}
              <div className="flex items-center justify-center gap-2 text-xs text-gray-600 mb-4 font-medium">
                <svg className="w-3.5 h-3.5 text-gray-500" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                  <circle cx="12" cy="12" r="10" />
                  <polyline points="12 6 12 12 16 14" />
                </svg>
                <span>{statusText}</span>
              </div>

              {/* Send All Button */}
              <button
                onClick={handleSendAll}
                disabled={isSending}
                className={`w-full py-3 px-4 rounded-lg font-semibold text-white text-xs flex items-center justify-center gap-2 transition cursor-pointer shadow-sm ${
                  isSending
                    ? 'bg-gray-400 cursor-not-allowed'
                    : 'bg-[#059669] hover:bg-[#047857] active:scale-[0.99]'
                }`}
              >
                <svg className="w-4 h-4 text-white -rotate-45" fill="currentColor" viewBox="0 0 20 20">
                  <path d="M10.894 2.553a1 1 0 00-1.788 0l-7 14a1 1 0 001.169 1.409l5-1.429A1 1 0 009 15.571V11a1 1 0 112 0v4.571a1 1 0 00.725.962l5 1.428a1 1 0 001.17-1.408l-7-14z" />
                </svg>
                <span>{isSending ? 'Dispatching...' : 'Send All'}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
