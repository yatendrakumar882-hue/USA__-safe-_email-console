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

    // Auto-fill formatted list
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
    setStatusText('Ready to send');
    alert('Campaign Execution Completed!');
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#eff3f8] via-[#e9eff6] to-[#e4edf7] text-[#333] font-sans py-8 px-6">
      <div className="max-w-[1080px] mx-auto">
        
        {/* Top Header Bar */}
        <div className="flex justify-between items-center mb-6">
          <div className="flex items-center gap-2">
            <svg className="w-7 h-7 text-[#3b82f6]" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z" />
            </svg>
            <h1 className="text-[26px] font-bold text-[#5c68e2] tracking-tight">Secure Mail Console</h1>
          </div>

          <button
            onClick={handleSingleClickLogout}
            onDoubleClick={handleDoubleClickLogout}
            className="text-[11px] font-semibold text-[#ef4444] bg-white border border-[#fca5a5] px-2.5 py-1 rounded shadow-sm hover:bg-red-50 select-none cursor-pointer"
          >
            [➔ Logout (Double Click)]
          </button>
        </div>

        {/* Section Sub-Title */}
        <div className="flex items-center gap-2 mb-6">
          <svg className="w-5 h-5 text-gray-900 -rotate-45" viewBox="0 0 24 24" fill="currentColor">
            <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
          </svg>
          <h2 className="text-base font-bold text-gray-900">Bulk Email Sender</h2>
        </div>

        {/* Main 2-Column Exact Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-start">
          
          {/* LEFT COLUMN: Compose Message */}
          <div className="bg-white rounded-xl border border-gray-100 p-6 shadow-sm">
            <div className="flex items-center gap-1.5 mb-4">
              <svg className="w-4 h-4 text-gray-800" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
              <h3 className="text-xs font-bold text-gray-800">Compose Message</h3>
            </div>

            {/* Inputs 2x2 Grid */}
            <div className="grid grid-cols-2 gap-3 mb-3">
              <div>
                <label className="block text-[11px] text-gray-700 font-medium mb-1">Sender Name</label>
                <input
                  type="text"
                  placeholder="E.g., John Doe"
                  value={formData.senderName}
                  onChange={(e) => setFormData({ ...formData, senderName: e.target.value })}
                  className="w-full text-xs p-2 border border-gray-200 rounded focus:border-[#5c68e2] outline-none text-gray-700 placeholder-gray-300"
                />
              </div>

              <div>
                <label className="block text-[11px] text-gray-700 font-medium mb-1">Your Gmail</label>
                <input
                  type="email"
                  placeholder="you@gmail.com"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  className="w-full text-xs p-2 border border-gray-200 rounded focus:border-[#5c68e2] outline-none text-gray-700 placeholder-gray-300"
                />
              </div>

              <div>
                <label className="block text-[11px] text-gray-700 font-medium mb-1">App Password</label>
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    placeholder="16-char app password"
                    value={formData.appPassword}
                    onChange={(e) => setFormData({ ...formData, appPassword: e.target.value })}
                    className="w-full text-xs p-2 border border-gray-200 rounded focus:border-[#5c68e2] outline-none text-gray-700 placeholder-gray-300 pr-7"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-xs"
                  >
                    👁
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-[11px] text-gray-700 font-medium mb-1">Email Subject</label>
                <input
                  type="text"
                  placeholder="Enter subject line..."
                  value={formData.subject}
                  onChange={(e) => setFormData({ ...formData, subject: e.target.value })}
                  className="w-full text-xs p-2 border border-gray-200 rounded focus:border-[#5c68e2] outline-none text-gray-700 placeholder-gray-300"
                />
              </div>
            </div>

            {/* Message Body Textarea */}
            <div className="mb-6">
              <label className="block text-[11px] text-gray-700 font-medium mb-1">
                Message Body (Plain Text / HTML)
              </label>
              <textarea
                rows={7}
                placeholder="Write your email here... Spintax supported: {Hi|Hello} {name}"
                value={formData.body}
                onChange={(e) => setFormData({ ...formData, body: e.target.value })}
                className="w-full text-xs p-2 border border-gray-200 rounded focus:border-[#5c68e2] outline-none resize-none text-gray-700 placeholder-gray-300 font-sans"
              />
            </div>

            {/* Cloudflare Turnstile Spam Protection Exact Match */}
            <div>
              <div className="flex items-center gap-1 mb-1.5">
                <span className="text-xs">🛡️</span>
                <span className="text-[11px] font-bold text-gray-800">Spam Protection</span>
              </div>
              <div className="border border-gray-200 rounded bg-[#fafafa] p-2 max-w-[210px] shadow-sm">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-1.5">
                    <div className="w-4 h-4 rounded bg-[#10b981] text-white flex items-center justify-center text-[10px] font-bold">
                      ✓
                    </div>
                    <span className="text-xs font-semibold text-gray-800">Success!</span>
                  </div>
                  <div className="text-right leading-none">
                    <div className="text-[9px] font-extrabold text-[#f97316] tracking-wider">CLOUDFLARE</div>
                    <span className="text-[7px] text-gray-400 underline">Privacy • Terms</span>
                  </div>
                </div>
                <div className="mt-1.5 text-[8px] text-red-500 border-t border-red-200 pt-0.5 tracking-tight font-sans">
                  For testing only. If seen, report to site owner
                </div>
              </div>
            </div>
          </div>

          {/* RIGHT COLUMN: Recipients & Progress Monitor */}
          <div className="space-y-6">
            
            {/* Recipients Card */}
            <div className="bg-white rounded-xl border border-gray-100 p-6 shadow-sm">
              <div className="flex justify-between items-center mb-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-xs">👥</span>
                  <h3 className="text-xs font-bold text-gray-800">Recipients</h3>
                </div>
                <span className="text-[10px] text-[#3b82f6] border border-[#bfdbfe] bg-[#eff6ff] px-2 py-0.5 rounded-full font-medium">
                  {recipientCount} found
                </span>
              </div>
              <p className="text-[10px] text-gray-400 mb-2">
                Paste emails (comma separated, new lines, or Excel copy)
              </p>
              <textarea
                rows={5}
                placeholder={"recipient1@example.com\nrecipient2@example.com"}
                value={formData.recipients}
                onChange={(e) => setFormData({ ...formData, recipients: e.target.value })}
                className="w-full text-xs p-2 border border-gray-200 rounded focus:border-[#5c68e2] outline-none resize-none font-mono text-gray-700 placeholder-gray-300"
              />
            </div>

            {/* Progress Monitor Card */}
            <div className="bg-white rounded-xl border border-gray-100 p-6 shadow-sm">
              <div className="flex items-center gap-1.5 mb-3">
                <span className="text-xs">📊</span>
                <h3 className="text-xs font-bold text-gray-800">Progress Monitor</h3>
              </div>

              {/* 2x2 Stats Grid */}
              <div className="grid grid-cols-2 gap-2 mb-4">
                <div className="border border-gray-100 rounded-lg py-2.5 text-center bg-[#fcfdfe]">
                  <div className="text-[9px] font-bold text-gray-500 uppercase tracking-wider">TOTAL</div>
                  <div className="text-base font-bold text-[#3b82f6] mt-0.5">{status.total}</div>
                </div>
                <div className="border border-gray-100 rounded-lg py-2.5 text-center bg-[#fcfdfe]">
                  <div className="text-[9px] font-bold text-gray-500 uppercase tracking-wider">SENT</div>
                  <div className="text-base font-bold text-[#10b981] mt-0.5">{status.sent}</div>
                </div>
                <div className="border border-gray-100 rounded-lg py-2.5 text-center bg-[#fcfdfe]">
                  <div className="text-[9px] font-bold text-gray-500 uppercase tracking-wider">FAILED</div>
                  <div className="text-base font-bold text-[#ef4444] mt-0.5">{status.failed}</div>
                </div>
                <div className="border border-gray-100 rounded-lg py-2.5 text-center bg-[#fcfdfe]">
                  <div className="text-[9px] font-bold text-gray-500 uppercase tracking-wider">REMAINING</div>
                  <div className="text-base font-bold text-[#f59e0b] mt-0.5">{status.remaining}</div>
                </div>
              </div>

              {/* Status Indicator */}
              <div className="flex items-center justify-center gap-1.5 text-[11px] text-gray-600 mb-3 font-medium">
                <span className="text-gray-400 text-xs">⏱</span>
                <span>{statusText}</span>
              </div>

              {/* Send All Green Button */}
              <button
                onClick={handleSendAll}
                disabled={isSending}
                className={`w-full py-2.5 px-4 rounded-lg font-bold text-white text-xs flex items-center justify-center gap-1.5 transition ${
                  isSending
                    ? 'bg-gray-400 cursor-not-allowed'
                    : 'bg-[#009b62] hover:bg-[#008755] cursor-pointer active:scale-[0.99]'
                }`}
              >
                <svg className="w-3.5 h-3.5 text-white -rotate-45" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z" />
                </svg>
                <span>{isSending ? 'Sending Batches...' : 'Send All'}</span>
              </button>
            </div>

          </div>
        </div>
      </div>
    </div>
  );
}
