'use client';

import { useState, useTransition } from 'react';

export default function BulkEmailSender() {
  const [formData, setFormData] = useState({
    senderName: '',
    email: '',
    appPassword: '',
    subject: '',
    body: '',
    recipients: '',
  });

  const [status, setStatus] = useState({ total: 0, sent: 0, failed: 0, remaining: 0 });
  const [isSending, setIsSending] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [statusText, setStatusText] = useState('Ready to send');
  const [captchaVerified, setCaptchaVerified] = useState(true);

  // Parse recipients list
  const getRecipientList = (text: string) => {
    return text
      .split(/[\n,]+/)
      .map((e) => e.trim())
      .filter((e) => e.length > 0 && e.includes('@'));
  };

  const recipientCount = getRecipientList(formData.recipients).length;

  // Double Click Logout Handler
  const handleDoubleClickLogout = () => {
    if (confirm('Are you sure you want to logout and clear session?')) {
      setFormData({
        senderName: '',
        email: '',
        appPassword: '',
        subject: '',
        body: '',
        recipients: '',
      });
      setStatus({ total: 0, sent: 0, failed: 0, remaining: 0 });
      setStatusText('Logged out successfully');
    }
  };

  const handleSingleClickLogout = () => {
    setStatusText('Tip: Double-click logout button to exit');
  };

  const handleSend = async () => {
    // 1. Auto-clean & Auto-fill Recipients format
    const cleanedRecipients = getRecipientList(formData.recipients);
    
    if (cleanedRecipients.length === 0) {
      alert('Please enter at least one valid recipient email.');
      return;
    }

    if (!formData.email || !formData.appPassword) {
      alert('Your Gmail address and 16-character App Password are required.');
      return;
    }

    // Auto-fill standardized list back into state before sending
    setFormData((prev) => ({
      ...prev,
      recipients: cleanedRecipients.join('\n'),
    }));

    setIsSending(true);
    setStatusText('Processing campaign queue...');
    setStatus({
      total: cleanedRecipients.length,
      sent: 0,
      failed: 0,
      remaining: cleanedRecipients.length,
    });

    let sentCount = 0;
    let failedCount = 0;

    // Concurrency: 2 emails at once
    const BATCH_SIZE = 2;
    const BATCH_DELAY = 1500;

    for (let i = 0; i < cleanedRecipients.length; i += BATCH_SIZE) {
      const currentBatch = cleanedRecipients.slice(i, i + BATCH_SIZE);

      const batchRequests = currentBatch.map(async (recipient) => {
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
              recipient: recipient,
            }),
          });
          const data = await res.json();
          return data.success;
        } catch {
          return false;
        }
      });

      const responses = await Promise.allSettled(batchRequests);

      responses.forEach((res) => {
        if (res.status === 'fulfilled' && res.value === true) {
          sentCount++;
        } else {
          failedCount++;
        }
      });

      setStatus({
        total: cleanedRecipients.length,
        sent: sentCount,
        failed: failedCount,
        remaining: cleanedRecipients.length - (sentCount + failedCount),
      });

      if (i + BATCH_SIZE < cleanedRecipients.length) {
        await new Promise((resolve) => setTimeout(resolve, BATCH_DELAY));
      }
    }

    setIsSending(false);
    setStatusText('Campaign finished successfully');
    alert('Campaign Execution Completed!');
  };

  return (
    <div className="min-h-screen bg-[#f4f7fc] text-[#333] font-sans py-8 px-4 sm:px-8">
      <div className="max-w-6xl mx-auto">
        {/* Top Header */}
        <div className="flex justify-between items-center mb-6">
          <div className="flex items-center gap-2">
            <span className="text-[#3b82f6] text-2xl">🛡️</span>
            <h1 className="text-2xl font-bold text-[#4f46e5]">Secure Mail Console</h1>
          </div>

          {/* Double Click Logout Button */}
          <button
            onClick={handleSingleClickLogout}
            onDoubleClick={handleDoubleClickLogout}
            title="Double-click to logout"
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-[#ef4444] bg-white border border-[#fca5a5] rounded-md hover:bg-red-50 transition select-none cursor-pointer"
          >
            <span>🚪</span> [➔ Logout (Double Click)]
          </button>
        </div>

        {/* Sub Header */}
        <div className="flex items-center gap-2 mb-6">
          <span className="text-xl">✈️</span>
          <h2 className="text-lg font-bold text-gray-800">Bulk Email Sender</h2>
        </div>

        {/* Main 2-Column Grid */}
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Left Column: Compose Message Form */}
          <div className="lg:col-span-7 bg-white rounded-xl shadow-sm border border-gray-100 p-6">
            <div className="flex items-center gap-2 mb-4">
              <span className="text-gray-700">📝</span>
              <h3 className="font-semibold text-gray-800 text-sm">Compose Message</h3>
            </div>

            {/* 2x2 Input Fields */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Sender Name</label>
                <input
                  type="text"
                  placeholder="E.g., John Doe"
                  value={formData.senderName}
                  onChange={(e) => setFormData({ ...formData, senderName: e.target.value })}
                  className="w-full text-xs p-2.5 border border-gray-200 rounded-lg outline-none focus:border-indigo-500 bg-white"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Your Gmail</label>
                <input
                  type="email"
                  placeholder="you@gmail.com"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  className="w-full text-xs p-2.5 border border-gray-200 rounded-lg outline-none focus:border-indigo-500 bg-white"
                />
              </div>

              <div className="relative">
                <label className="block text-xs font-medium text-gray-700 mb-1">App Password</label>
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    placeholder="16-char app password"
                    value={formData.appPassword}
                    onChange={(e) => setFormData({ ...formData, appPassword: e.target.value })}
                    className="w-full text-xs p-2.5 border border-gray-200 rounded-lg outline-none focus:border-indigo-500 pr-8 bg-white"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-xs"
                  >
                    👁️
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">Email Subject</label>
                <input
                  type="text"
                  placeholder="Enter subject line..."
                  value={formData.subject}
                  onChange={(e) => setFormData({ ...formData, subject: e.target.value })}
                  className="w-full text-xs p-2.5 border border-gray-200 rounded-lg outline-none focus:border-indigo-500 bg-white"
                />
              </div>
            </div>

            {/* Message Body */}
            <div className="mb-6">
              <label className="block text-xs font-medium text-gray-700 mb-1">
                Message Body (Plain Text / HTML)
              </label>
              <textarea
                rows={6}
                placeholder="Write your email here... Spintax supported: {Hi|Hello} {name}"
                value={formData.body}
                onChange={(e) => setFormData({ ...formData, body: e.target.value })}
                className="w-full text-xs p-2.5 border border-gray-200 rounded-lg outline-none focus:border-indigo-500 resize-none bg-white font-mono"
              />
            </div>

            {/* Spam Protection Turnstile Banner */}
            <div>
              <div className="flex items-center gap-1.5 mb-2">
                <span className="text-gray-700 text-xs">🛡️</span>
                <span className="text-xs font-semibold text-gray-700">Spam Protection</span>
              </div>
              <div className="border border-gray-200 rounded-lg p-2.5 bg-gray-50 flex items-center justify-between max-w-xs shadow-inner">
                <div className="flex items-center gap-2">
                  <span className="text-emerald-500 text-lg">✅</span>
                  <div>
                    <div className="text-xs font-bold text-gray-800 leading-tight">Success!</div>
                    <div className="text-[10px] text-gray-400">Verified by Protection Layer</div>
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-[11px] font-bold text-gray-600 tracking-wider">CLOUDFLARE</div>
                  <div className="text-[9px] text-gray-400">Turnstile • Privacy</div>
                </div>
              </div>
            </div>
          </div>

          {/* Right Column: Recipients & Progress Monitor */}
          <div className="lg:col-span-5 space-y-6">
            {/* Recipients Box */}
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
              <div className="flex justify-between items-center mb-2">
                <div className="flex items-center gap-2">
                  <span className="text-gray-700">👥</span>
                  <h3 className="font-semibold text-gray-800 text-sm">Recipients</h3>
                </div>
                <span className="text-[11px] text-indigo-600 bg-indigo-50 px-2.5 py-0.5 rounded-full font-medium border border-indigo-100">
                  {recipientCount} found
                </span>
              </div>
              <p className="text-[11px] text-gray-400 mb-2">
                Paste emails (comma separated, new lines, or Excel copy)
              </p>
              <textarea
                rows={5}
                placeholder={"recipient1@example.com\nrecipient2@example.com"}
                value={formData.recipients}
                onChange={(e) => setFormData({ ...formData, recipients: e.target.value })}
                className="w-full text-xs p-2.5 border border-gray-200 rounded-lg outline-none focus:border-indigo-500 resize-none font-mono bg-white"
              />
            </div>

            {/* Progress Monitor Box */}
            <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
              <div className="flex items-center gap-2 mb-4">
                <span className="text-gray-700">📊</span>
                <h3 className="font-semibold text-gray-800 text-sm">Progress Monitor</h3>
              </div>

              {/* 2x2 Stats Grid */}
              <div className="grid grid-cols-2 gap-3 mb-5">
                <div className="border border-gray-100 rounded-lg p-3 text-center bg-[#fafbfc]">
                  <div className="text-[10px] tracking-wider font-bold text-gray-500 uppercase">TOTAL</div>
                  <div className="text-lg font-bold text-blue-600 mt-1">{status.total}</div>
                </div>
                <div className="border border-gray-100 rounded-lg p-3 text-center bg-[#fafbfc]">
                  <div className="text-[10px] tracking-wider font-bold text-gray-500 uppercase">SENT</div>
                  <div className="text-lg font-bold text-emerald-500 mt-1">{status.sent}</div>
                </div>
                <div className="border border-gray-100 rounded-lg p-3 text-center bg-[#fafbfc]">
                  <div className="text-[10px] tracking-wider font-bold text-gray-500 uppercase">FAILED</div>
                  <div className="text-lg font-bold text-rose-500 mt-1">{status.failed}</div>
                </div>
                <div className="border border-gray-100 rounded-lg p-3 text-center bg-[#fafbfc]">
                  <div className="text-[10px] tracking-wider font-bold text-gray-500 uppercase">REMAINING</div>
                  <div className="text-lg font-bold text-amber-500 mt-1">{status.remaining}</div>
                </div>
              </div>

              {/* Status indicator line */}
              <div className="flex items-center justify-center gap-1.5 text-xs text-gray-600 mb-4 font-medium">
                <span className="text-gray-400">⏱️</span>
                <span>{statusText}</span>
              </div>

              {/* Send All Action Button */}
              <button
                onClick={handleSend}
                disabled={isSending}
                className={`w-full py-3 px-4 rounded-lg font-semibold text-white text-xs flex items-center justify-center gap-2 transition ${
                  isSending
                    ? 'bg-gray-400 cursor-not-allowed'
                    : 'bg-[#059669] hover:bg-[#047857] shadow-md shadow-emerald-100 cursor-pointer active:scale-[0.99]'
                }`}
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
