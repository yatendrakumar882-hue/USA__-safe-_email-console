const handleSendEmails = async () => {
  setIsSending(true);
  
  // Recipients textarea se array banana
  const recipientList = formData.recipients
    .split('\n')
    .map((r: string) => r.trim())
    .filter((r: string) => r.length > 0);

  let sentCount = 0;
  let failedCount = 0;
  const BATCH_SIZE = 2; // 1 batch me sirf 2 email

  for (let i = 0; i < recipientList.length; i += BATCH_SIZE) {
    const currentBatch = recipientList.slice(i, i + BATCH_SIZE);

    // 2 emails parallel bhejenge
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
        } catch (err) {
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

    // Har 2 email ke batch ke baad 4 second ka delay taaki Google trigger na ho
    if (i + BATCH_SIZE < recipientList.length) {
      setStatusText(`Sent ${sentCount}/${recipientList.length}. Cooling down 4s...`);
      await new Promise((resolve) => setTimeout(resolve, 4000));
    }
  }

  setStatusText('All batches completed!');
  setIsSending(false);
};
